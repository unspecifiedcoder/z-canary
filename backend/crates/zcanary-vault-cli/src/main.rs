//! Local vault key and crypto operations. Wallet submission remains a separate adapter.
use age::x25519;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::SigningKey;
use rand::{RngExt, make_rng, rngs::StdRng};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, Stdio},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
};
use subtle::ConstantTimeEq;
use zcanary_core::{
    Command, ImmutableManifest, ManifestFields, Operation, canonical_manifest_bytes,
    decode_and_verify_memo, encode_memo, sign_manifest, verify_manifest,
};
use zcanary_crypto::{
    DeliveryContext, EncryptedPackage, PackageContext, RecipientShareEnvelope, ShareCommitment,
    ShareSetContext, create_vault, decrypt_package, open_recipient_share, recipient_fingerprint,
    reconstruct_release_key,
};
use zcanary_storage::{
    IdentityContext, IdentityRole, SecretBundle, export_encrypted, import_encrypted,
};
use zeroize::{Zeroize, Zeroizing};

const MAX_INPUT: usize = 16 * 1024 * 1024;
const MAX_DOCUMENT: usize = 10 * 1024 * 1024;
const FILE_MAGIC: &[u8; 5] = b"ZCDP\x01";
const INNER_MAGIC: &[u8; 5] = b"ZCVK\x01";
const LOCK_NAME: &str = ".vault-cli.lock";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
enum Role {
    Source,
    Recipient,
}

struct StateLock {
    _file: File,
}

fn main() {
    if let Err(err) = run() {
        // Keep stdout machine-readable and keep internal paths/secret data out of diagnostics.
        eprintln!(
            "{{\"error\":\"vault_operation_failed\",\"message\":{}}}",
            serde_json::to_string(&err.to_string())
                .unwrap_or_else(|_| "\"operation failed\"".into())
        );
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    ensure!(
        cfg!(target_os = "windows"),
        "DPAPI-backed vault state is currently available on Windows only"
    );
    let mut args = env::args().skip(1);
    ensure!(
        args.next().as_deref() == Some("--state-dir"),
        "usage: zcanary-vault-cli --state-dir PATH <init-recipient|create|command|accept-share|decrypt|export-identity|import-identity>"
    );
    let state_dir = PathBuf::from(args.next().context("state directory is required")?);
    let action = args.next().context("operation is required")?;
    ensure!(args.next().is_none(), "unexpected trailing arguments");
    fs::create_dir_all(&state_dir).context("create state directory")?;
    let mut input = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take((MAX_INPUT + 1) as u64)
        .read_to_end(&mut input)
        .context("read request")?;
    ensure!(input.len() <= MAX_INPUT, "request exceeds 16 MiB limit");
    let mut request: Value = serde_json::from_slice(&input).context("request must be JSON")?;
    input.zeroize();
    let mut response = match action.as_str() {
        "init-recipient" => init_recipient(&state_dir)?,
        "create" => {
            let result = create(&state_dir, &request);
            clear_string(&mut request, "contentsBase64");
            clear_string(&mut request, "fileName");
            result?
        }
        "command" => command(&state_dir, &request)?,
        "accept-share" => accept_share(&state_dir, &request)?,
        "decrypt" => decrypt(&state_dir, &request)?,
        "export-identity" | "import-identity" => {
            let result = if action == "export-identity" {
                export_identity(&state_dir, &request)
            } else {
                import_identity(&state_dir, &request)
            };
            clear_string(&mut request, "passphrase");
            result?
        }
        _ => bail!("unsupported operation"),
    };
    println!("{}", response);
    if action == "decrypt" {
        clear_string(&mut response, "contentsBase64");
    }
    Ok(())
}

fn init_recipient(state: &Path) -> Result<Value> {
    let _lock = state_lock(state)?;
    ensure_role(state, Role::Recipient)?;
    let path = state.join("recipient.identity.dpapi");
    let identity = if path.exists() {
        load_recipient_identity(&path)?
    } else {
        let generated = x25519::Identity::generate();
        let serialized = generated.to_string();
        let bytes = Zeroizing::new(serialized.expose_secret().as_bytes().to_vec());
        match save_protected_new(&path, "recipient-identity", &bytes) {
            Ok(()) => generated,
            Err(_) if path.exists() => load_recipient_identity(&path)?,
            Err(error) => return Err(error),
        }
    };
    let recipient = identity.to_public().to_string();
    let fingerprint = manifest_fingerprint(&recipient_fingerprint(&recipient)?);
    Ok(json!({"recipient":recipient,"fingerprint":fingerprint}))
}

fn create(state: &Path, req: &Value) -> Result<Value> {
    let _lock = state_lock(state)?;
    ensure_role(state, Role::Source)?;
    let filename = string(req, "fileName")?;
    ensure!(
        !filename.is_empty() && filename.len() <= 1024 && !filename.chars().any(char::is_control),
        "invalid file name"
    );
    let content_b64 = string(req, "contentsBase64")?;
    ensure!(
        content_b64.len() <= MAX_DOCUMENT * 4 / 3 + 8,
        "document exceeds 10 MiB limit"
    );
    let plaintext = Zeroizing::new(
        STANDARD
            .decode(content_b64)
            .context("invalid base64 document")?,
    );
    ensure!(
        plaintext.len() <= MAX_DOCUMENT,
        "document exceeds 10 MiB limit"
    );
    let recipient = string(req, "recipient")?;
    let recipients = string_array::<5>(req, "keeperRecipients")?;
    let interval = number_u32(req, "intervalBlocks")?;
    let grace = number_u32(req, "graceBlocks")?;
    let confirmations = number_u32(req, "confirmationTarget")?;
    let extension = number_u32(req, "maxExtensionBlocks")?;
    ensure!(
        interval > 0 && confirmations > 0 && extension > 0,
        "invalid release policy"
    );
    let recipient_fp = recipient_fingerprint(recipient)?;
    let (_, recipient_raw) = bech32::decode(recipient).context("invalid recipient age key")?;
    ensure!(
        recipient_raw.len() == 32,
        "recipient age key must be X25519"
    );
    let keeper_ids = keeper_fingerprints(&recipients)?;
    let source_seed = load_or_create_source_seed(state)?;
    let source_key = SigningKey::from_bytes(&source_seed);
    let source_pubkey = source_key.verifying_key().to_bytes();

    let mut rng: StdRng = make_rng();
    let mut switch_id = [0u8; 32];
    rng.fill(&mut switch_id);
    let epoch = 1u32;
    let package_context = PackageContext {
        switch_id,
        epoch,
        recipient_fingerprint: recipient_fp,
    };
    let share_context = ShareSetContext {
        switch_id,
        epoch,
        keeper_ids,
    };
    let material = create_vault(
        &plaintext,
        recipient,
        package_context,
        share_context,
        recipients.each_ref().map(String::as_str),
    )
    .context("create encrypted vault")?;
    let package = material
        .package
        .to_bytes()
        .context("encode encrypted package")?;
    let fields = ManifestFields {
        network: 1,
        switch_id_hex: hex::encode(switch_id),
        source_pubkey_hex: hex::encode(source_pubkey),
        recipient_pubkey_hex: hex::encode(recipient_raw),
        package_digest_hex: hex::encode(material.package_digest),
        package_size: package.len() as u64,
        initial_interval_blocks: interval,
        grace_blocks: grace,
        confirmation_target: confirmations,
        max_extension_blocks: extension,
        threshold: 3,
        configuration_epoch: epoch,
        share_commitments: std::array::from_fn(|i| hex::encode(material.commitments[i].digest)),
    };
    let manifest = sign_manifest(fields, &source_seed).context("sign immutable manifest")?;
    let manifest_json = manifest_json(&manifest)?;
    ensure!(
        verify_manifest(&manifest),
        "generated manifest failed self-verification"
    );

    let id = manifest.fields.switch_id_hex.clone();
    let vault_dir = state.join("vaults").join(&id);
    fs::create_dir_all(&vault_dir).context("create vault state directory")?;
    let filename_payload = Zeroizing::new(filename.as_bytes().to_vec());
    save_protected_new(
        &vault_dir.join("metadata.dpapi"),
        &format!("filename:{id}"),
        &filename_payload,
    )?;
    write_new(
        &vault_dir.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest_json)?,
    )?;
    let package_path = vault_dir.join("package.zcan");
    write_new(&package_path, &package)?;

    let provisions: Vec<Value> = material.keeper_envelopes.iter().enumerate().map(|(i, env)| json!({
        "manifest":manifest_json,
        "keeper_index":i+1,
        "keeper_recipients":recipients,
        "envelope":{"version":env.version,"keeper_id_hex":hex::encode(env.keeper_id),"index":env.index,"ciphertext_hex":hex::encode(&env.ciphertext)}
    })).collect();
    let package_path = package_path
        .canonicalize()
        .context("resolve encrypted package path")?;
    Ok(
        json!({"id":id,"manifest":manifest_json,"provisions":provisions,"packageDigestHex":manifest.fields.package_digest_hex,"packagePath":package_path.to_string_lossy().into_owned()}),
    )
}

fn command(state: &Path, req: &Value) -> Result<Value> {
    let _lock = state_lock(state)?;
    ensure_role(state, Role::Source)?;
    let id = checked_id(string(req, "id")?)?;
    let vault_dir = state.join("vaults").join(&id);
    let manifest_value = read_json(&vault_dir.join("manifest.json"), 64 * 1024)?;
    let manifest = parse_manifest(&manifest_value)?;
    ensure!(
        manifest.fields.switch_id_hex == id,
        "vault identifier does not match manifest"
    );
    let seed = load_source_seed(state)?;
    let signing = SigningKey::from_bytes(&seed);
    ensure!(
        hex::encode(signing.verifying_key().to_bytes()) == manifest.fields.source_pubkey_hex,
        "source identity does not match manifest"
    );
    let operation = match string(req, "operation")? {
        "register" => Operation::Register,
        "postpone" => Operation::Postpone,
        "cancel" => Operation::Cancel,
        _ => bail!("unsupported command operation"),
    };
    let expiry = if operation == Operation::Cancel {
        let value = req.get("expiryHeight").and_then(Value::as_u64).unwrap_or(0);
        ensure!(value == 0, "cancel expiryHeight must be zero or omitted");
        0
    } else {
        number_u32(req, "expiryHeight")?
    };
    let operation_id = checked_operation_id(string(req, "operationId")?)?;
    if operation == Operation::Register {
        ensure!(expiry > 0, "registration expiryHeight must be positive");
    }
    let journal_dir = vault_dir.join("commands");
    fs::create_dir_all(&journal_dir).context("create command journal")?;
    let prior = read_journal(&journal_dir)?;
    verify_journal(&prior, &manifest)?;
    let operation_name = operation_name(operation);
    if let Some(existing) = retry_command(&prior, &operation_id, operation_name, expiry)? {
        return Ok(
            json!({"id":id,"operationId":operation_id,"memoHex":existing.memo_hex,"sequence":existing.sequence.to_string()}),
        );
    }
    let sequence = reserve_sequence(operation, expiry, &prior)?;
    let memo = signed_memo(&manifest, &seed, operation, sequence, expiry)?;
    let memo_hex = hex::encode(memo);
    let journal = json!({"id":id,"operationId":operation_id,"operation":operation_name,"sequence":sequence.to_string(),"expiryHeight":expiry,"memoHex":memo_hex});
    let name = format!("command-{sequence:020}.json");
    write_new(
        &journal_dir.join(name),
        &serde_json::to_vec_pretty(&journal)?,
    )?;
    Ok(
        json!({"id":id,"operationId":operation_id,"memoHex":memo_hex,"sequence":sequence.to_string()}),
    )
}

#[derive(Clone)]
struct JournalCommand {
    operation_id: String,
    operation: String,
    sequence: u64,
    expiry_height: u32,
    memo_hex: String,
}
fn read_journal(path: &Path) -> Result<Vec<JournalCommand>> {
    let mut entries = fs::read_dir(path)
        .context("read command journal")?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    let mut commands = Vec::new();
    for entry in entries {
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("command-") || !name.ends_with(".json") {
            continue;
        }
        let value = read_json(&entry.path(), 64 * 1024)?;
        let operation_id = checked_operation_id(string(&value, "operationId")?)?;
        let sequence = string(&value, "sequence")?
            .parse::<u64>()
            .context("invalid journal sequence")?;
        let operation = string(&value, "operation")?.to_owned();
        let expiry_height = number_u32(&value, "expiryHeight")?;
        let memo_hex = string(&value, "memoHex")?.to_owned();
        commands.push(JournalCommand {
            operation_id,
            operation,
            sequence,
            expiry_height,
            memo_hex,
        });
    }
    commands.sort_by_key(|c| c.sequence);
    if let Some(first) = commands.first() {
        ensure!(
            first.operation == "register" && first.sequence == 0,
            "command journal must begin with registration sequence zero"
        );
    }
    for pair in commands.windows(2) {
        ensure!(
            pair[1].sequence
                == pair[0]
                    .sequence
                    .checked_add(1)
                    .context("sequence overflow")?,
            "command journal sequence gap or duplicate"
        );
    }
    for (i, command) in commands.iter().enumerate() {
        ensure!(
            !commands[..i]
                .iter()
                .any(|prior| prior.operation_id == command.operation_id),
            "duplicate operationId in command journal"
        );
    }
    Ok(commands)
}
fn verify_journal(commands: &[JournalCommand], manifest: &ImmutableManifest) -> Result<()> {
    for entry in commands {
        let memo_bytes = hex::decode(&entry.memo_hex).context("invalid memo in command journal")?;
        let command = decode_and_verify_memo(&memo_bytes, manifest.fields.network)
            .context("command journal memo failed signature validation")?;
        let expected_operation = match entry.operation.as_str() {
            "register" => Operation::Register,
            "postpone" => Operation::Postpone,
            "cancel" => Operation::Cancel,
            _ => bail!("unknown command journal operation"),
        };
        ensure!(
            command.switch_id == hex32(&manifest.fields.switch_id_hex)?
                && command.manifest_digest == hex32(&manifest.manifest_digest_hex)?
                && command.source_pubkey == hex32(&manifest.fields.source_pubkey_hex)?
                && command.operation == expected_operation
                && command.sequence == entry.sequence
                && command.requested_expiry_height == entry.expiry_height,
            "command journal metadata does not match its signed memo"
        );
    }
    Ok(())
}
fn reserve_sequence(operation: Operation, expiry: u32, prior: &[JournalCommand]) -> Result<u64> {
    match operation {
        Operation::Register => {
            ensure!(prior.is_empty(), "registration command already reserved");
            ensure!(expiry > 0, "registration expiryHeight must be positive");
            Ok(0)
        }
        _ => {
            ensure!(
                prior.iter().any(|c| c.operation == "register"),
                "register before mutating a vault"
            );
            ensure!(
                !prior.iter().any(|c| c.operation == "cancel"),
                "cancelled vault cannot be reactivated"
            );
            if operation == Operation::Postpone {
                let previous_expiry = prior.last().map(|c| c.expiry_height).unwrap_or(0);
                ensure!(
                    expiry > previous_expiry,
                    "postponement must increase expiry"
                );
            }
            prior
                .last()
                .map(|c| c.sequence.checked_add(1))
                .unwrap_or(Some(1))
                .context("command sequence exhausted")
        }
    }
}
fn retry_command<'a>(
    prior: &'a [JournalCommand],
    operation_id: &str,
    operation: &str,
    expiry: u32,
) -> Result<Option<&'a JournalCommand>> {
    if let Some(existing) = prior.iter().find(|c| c.operation_id == operation_id) {
        ensure!(
            existing.operation == operation && existing.expiry_height == expiry,
            "operationId was already used with different command data"
        );
        Ok(Some(existing))
    } else {
        Ok(None)
    }
}
fn signed_memo(
    manifest: &ImmutableManifest,
    seed: &[u8; 32],
    operation: Operation,
    sequence: u64,
    expiry: u32,
) -> Result<[u8; 512]> {
    let signing = SigningKey::from_bytes(seed);
    let source_pubkey = hex32(&manifest.fields.source_pubkey_hex)?;
    ensure!(
        signing.verifying_key().to_bytes() == source_pubkey,
        "source identity does not match manifest"
    );
    let memo = encode_memo(
        &Command {
            network: manifest.fields.network,
            operation,
            switch_id: hex32(&manifest.fields.switch_id_hex)?,
            sequence,
            requested_expiry_height: expiry,
            manifest_digest: hex32(&manifest.manifest_digest_hex)?,
            source_pubkey,
        },
        seed,
    )
    .context("sign command")?;
    ensure!(
        decode_and_verify_memo(&memo, manifest.fields.network).is_ok(),
        "generated command failed self-verification"
    );
    Ok(memo)
}

/// Validate a single recipient delivery before the controller persists or
/// acknowledges it. The share is only held in this function and is zeroized by
/// its `Drop` implementation as it leaves scope.
fn accept_share(state: &Path, req: &Value) -> Result<Value> {
    let _lock = state_lock(state)?;
    require_role(state, Role::Recipient)?;
    let manifest = parse_manifest(req.get("manifest").context("manifest required")?)?;
    let delivery_hex = string(req, "deliveryHex")?;
    ensure!(delivery_hex.len() <= 8192, "delivery envelope too large");
    let envelope = RecipientShareEnvelope::from_bytes(
        &hex::decode(delivery_hex).context("invalid delivery hex")?,
    )
    .context("invalid recipient envelope")?;
    let keeper_recipients = string_array::<5>(req, "keeperRecipients")?;
    let keeper_ids = keeper_fingerprints(&keeper_recipients)?;
    let recipient = load_recipient_identity(&state.join("recipient.identity.dpapi"))?;
    let recipient_public = recipient.to_public().to_string();
    let recipient_fp = recipient_fingerprint(&recipient_public)?;
    let (_, recipient_raw) =
        bech32::decode(&recipient_public).context("invalid local recipient")?;
    ensure!(
        hex::encode(recipient_raw) == manifest.fields.recipient_pubkey_hex,
        "recipient identity does not match manifest"
    );
    ensure!(
        manifest_fingerprint(&recipient_fp) == manifest.recipient_fingerprint,
        "recipient fingerprint does not match manifest"
    );
    let share_context = ShareSetContext {
        switch_id: hex32(&manifest.fields.switch_id_hex)?,
        epoch: manifest.fields.configuration_epoch,
        keeper_ids,
    };
    let commitments = commitments_for(&manifest, keeper_ids)?;
    let delivery_context = DeliveryContext {
        switch_id: share_context.switch_id,
        epoch: share_context.epoch,
        manifest_digest: hex32(&manifest.manifest_digest_hex)?,
        expected_recipient_fingerprint: recipient_fp,
    };
    let share = open_recipient_share(
        &envelope,
        &share_context,
        &commitments,
        delivery_context,
        &recipient,
    )
    .context("recipient share validation failed")?;
    Ok(json!({
        "keeperIndex": share.index,
        "keeperIdHex": hex::encode(share.keeper_id),
    }))
}

fn decrypt(state: &Path, req: &Value) -> Result<Value> {
    require_role(state, Role::Recipient)?;
    let manifest = parse_manifest(req.get("manifest").context("manifest required")?)?;
    ensure!(
        verify_manifest(&manifest),
        "manifest signature/digest verification failed"
    );
    let package_b64 = string(req, "packageBase64")?;
    ensure!(
        package_b64.len() <= MAX_INPUT,
        "encrypted package input too large"
    );
    let package_bytes = Zeroizing::new(
        STANDARD
            .decode(package_b64)
            .context("invalid package base64")?,
    );
    ensure!(
        package_bytes.len() as u64 == manifest.fields.package_size,
        "encrypted package size mismatch"
    );
    let package =
        EncryptedPackage::from_bytes(&package_bytes).context("invalid encrypted package")?;
    let recipient = load_recipient_identity(&state.join("recipient.identity.dpapi"))?;
    let recipient_public = recipient.to_public().to_string();
    let recipient_fingerprint_value = recipient_fingerprint(&recipient_public)?;
    let (_, recipient_raw) =
        bech32::decode(&recipient_public).context("invalid local recipient")?;
    ensure!(
        hex::encode(recipient_raw) == manifest.fields.recipient_pubkey_hex,
        "recipient identity does not match manifest"
    );
    ensure!(
        manifest_fingerprint(&recipient_fingerprint_value) == manifest.recipient_fingerprint,
        "recipient fingerprint does not match manifest"
    );
    let keeper_recipients = string_array::<5>(req, "keeperRecipients")?;
    let keeper_ids = keeper_fingerprints(&keeper_recipients)?;
    let share_context = ShareSetContext {
        switch_id: hex32(&manifest.fields.switch_id_hex)?,
        epoch: manifest.fields.configuration_epoch,
        keeper_ids,
    };
    let commitments = commitments_for(&manifest, keeper_ids)?;
    let package_context = PackageContext {
        switch_id: share_context.switch_id,
        epoch: share_context.epoch,
        recipient_fingerprint: recipient_fingerprint_value,
    };
    let delivery_context = DeliveryContext {
        switch_id: share_context.switch_id,
        epoch: share_context.epoch,
        manifest_digest: hex32(&manifest.manifest_digest_hex)?,
        expected_recipient_fingerprint: recipient_fingerprint_value,
    };
    let delivery_values = req
        .get("deliveriesHex")
        .and_then(Value::as_array)
        .context("deliveriesHex array required")?;
    ensure!(
        (3..=5).contains(&delivery_values.len()),
        "three to five delivery envelopes required"
    );
    let mut shares = Vec::with_capacity(delivery_values.len());
    for value in delivery_values {
        let envelope_hex = value.as_str().context("delivery envelope must be hex")?;
        ensure!(envelope_hex.len() <= 8192, "delivery envelope too large");
        let envelope = RecipientShareEnvelope::from_bytes(
            &hex::decode(envelope_hex).context("invalid delivery hex")?,
        )
        .context("invalid recipient envelope")?;
        shares.push(
            open_recipient_share(
                &envelope,
                &share_context,
                &commitments,
                delivery_context,
                &recipient,
            )
            .context("recipient share validation failed")?,
        );
    }
    let key = reconstruct_release_key(&shares, &share_context, &commitments)
        .context("share set validation failed")?;
    let expected_package_digest = hex32(&manifest.fields.package_digest_hex)?;
    let plaintext = decrypt_package(
        &package,
        &key,
        package_context,
        expected_package_digest,
        &recipient,
    )
    .context("package authentication or decryption failed")?;
    let digest = Sha256::digest(plaintext.as_slice());
    Ok(
        json!({"contentsBase64":STANDARD.encode(plaintext.as_slice()),"digestHex":hex::encode(digest)}),
    )
}

fn backup_role(request: &Value) -> Result<Role> {
    match string(request, "role")? {
        "source" => Ok(Role::Source),
        "recipient" => Ok(Role::Recipient),
        _ => bail!("identity role must be source or recipient"),
    }
}

fn backup_passphrase(request: &Value) -> Result<SecretString> {
    let value = string(request, "passphrase")?;
    ensure!(
        (12..=1024).contains(&value.len()) && !value.trim().is_empty(),
        "backup passphrase must contain 12 to 1024 bytes"
    );
    Ok(value.to_owned().into())
}

fn identity_slot(role: Role) -> (&'static str, &'static str) {
    match role {
        Role::Source => ("source.identity.dpapi", "source-seed"),
        Role::Recipient => ("recipient.identity.dpapi", "recipient-identity"),
    }
}

fn backup_fingerprint(role: Role, secret: &[u8]) -> Result<String> {
    match role {
        Role::Source => {
            let seed = Zeroizing::new(
                <[u8; 32]>::try_from(secret).context("invalid source identity length")?,
            );
            let public = SigningKey::from_bytes(&seed).verifying_key();
            Ok(hex::encode(Sha256::digest(public.as_bytes())))
        }
        Role::Recipient => {
            let identity = x25519::Identity::from_str(std::str::from_utf8(secret)?)
                .map_err(|_| anyhow::anyhow!("invalid recipient identity"))?;
            Ok(hex::encode(recipient_fingerprint(
                &identity.to_public().to_string(),
            )?))
        }
    }
}

fn backup_context(role: Role, fingerprint: &str) -> Result<IdentityContext> {
    ensure!(
        fingerprint.len() == 64
            && fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "backup fingerprint must be canonical 32-byte hex"
    );
    Ok(IdentityContext::new(
        match role {
            Role::Source => IdentityRole::Source,
            Role::Recipient => IdentityRole::Recipient,
        },
        format!("zcanary-{}:{fingerprint}", role_name(role)),
    )?)
}

fn export_identity(state: &Path, request: &Value) -> Result<Value> {
    let _lock = state_lock(state)?;
    let role = backup_role(request)?;
    let passphrase = backup_passphrase(request)?;
    require_role(state, role)?;
    let (file, purpose) = identity_slot(role);
    let secret = load_protected(&state.join(file), purpose)?;
    let fingerprint = backup_fingerprint(role, &secret)?;
    let bundle = SecretBundle::new(backup_context(role, &fingerprint)?, &secret)?;
    let encrypted = export_encrypted(&bundle, &passphrase)?;
    Ok(
        json!({"version":1,"role":role_name(role),"fingerprint":fingerprint,"encryptedBase64":STANDARD.encode(encrypted.as_bytes())}),
    )
}

fn import_identity(state: &Path, request: &Value) -> Result<Value> {
    let _lock = state_lock(state)?;
    let role = backup_role(request)?;
    let passphrase = backup_passphrase(request)?;
    let fingerprint = string(request, "expectedFingerprint")?;
    let context = backup_context(role, fingerprint)?;
    let backup = &request["backup"];
    ensure!(
        backup.as_object().is_some_and(|o| o.len() == 4)
            && backup["version"] == 1
            && backup["role"] == role_name(role)
            && backup["fingerprint"] == fingerprint,
        "backup public context does not match the requested identity"
    );
    let encoded = string(backup, "encryptedBase64")?;
    ensure!(
        encoded.len() <= zcanary_storage::MAX_CIPHERTEXT_BYTES.div_ceil(3) * 4,
        "identity backup is too large"
    );
    let encrypted = STANDARD
        .decode(encoded)
        .context("invalid backup encoding")?;
    let bundle = import_encrypted(&encrypted, &passphrase, &context)?;
    let secret = bundle.expose_secret_bytes();
    ensure!(
        backup_fingerprint(role, secret)? == fingerprint,
        "decrypted key does not match the expected public fingerprint"
    );
    let (file, purpose) = identity_slot(role);
    let identity_path = state.join(file);
    let already_present = identity_path.exists();
    if already_present {
        require_role(state, role)?;
        let existing = load_protected(&identity_path, purpose)?;
        ensure!(
            bool::from(existing.as_slice().ct_eq(secret)),
            "a different identity already exists; replacement is prohibited"
        );
    } else {
        // A key-only backup cannot repair command journals or other existing vault state.
        for entry in fs::read_dir(state)? {
            let name = entry?.file_name();
            ensure!(
                name == LOCK_NAME || name == "state-role.dpapi",
                "identity restore requires an empty role directory"
            );
        }
        ensure_role(state, role)?;
        save_protected_new(&identity_path, purpose, secret)?;
    }
    Ok(
        json!({"role":role_name(role),"fingerprint":fingerprint,"restored":true,"alreadyPresent":already_present}),
    )
}

fn load_or_create_source_seed(state: &Path) -> Result<Zeroizing<[u8; 32]>> {
    let path = state.join("source.identity.dpapi");
    if path.exists() {
        return load_source_seed(state);
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    let mut rng: StdRng = make_rng();
    rng.fill(&mut *seed);
    match save_protected_new(&path, "source-seed", &seed[..]) {
        Ok(()) => Ok(seed),
        Err(_) if path.exists() => load_source_seed(state),
        Err(error) => Err(error),
    }
}
fn load_source_seed(state: &Path) -> Result<Zeroizing<[u8; 32]>> {
    let bytes = load_protected(&state.join("source.identity.dpapi"), "source-seed")?;
    let seed: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .context("stored source key has invalid length")?;
    Ok(Zeroizing::new(seed))
}
fn load_recipient_identity(path: &Path) -> Result<x25519::Identity> {
    let text = load_protected(path, "recipient-identity")?;
    let secret = std::str::from_utf8(&text).context("stored recipient identity invalid")?;
    x25519::Identity::from_str(secret)
        .map_err(|_| anyhow::anyhow!("stored recipient identity invalid"))
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Source => "source",
        Role::Recipient => "recipient",
    }
}
fn ensure_role(state: &Path, role: Role) -> Result<()> {
    let path = state.join("state-role.dpapi");
    let expected = role_name(role).as_bytes();
    if path.exists() {
        let stored = load_protected(&path, "state-role")?;
        ensure!(
            stored.as_slice() == expected,
            "state directory belongs to a different identity role"
        );
        return Ok(());
    }
    match save_protected_new(&path, "state-role", expected) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            let stored = load_protected(&path, "state-role")?;
            ensure!(
                stored.as_slice() == expected,
                "state directory belongs to a different identity role"
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}
fn require_role(state: &Path, role: Role) -> Result<()> {
    let stored = load_protected(&state.join("state-role.dpapi"), "state-role")?;
    ensure!(
        stored.as_slice() == role_name(role).as_bytes(),
        "state directory belongs to a different identity role"
    );
    Ok(())
}

fn save_protected_new(path: &Path, purpose: &str, secret: &[u8]) -> Result<()> {
    ensure!(secret.len() <= 64 * 1024, "protected secret exceeds limit");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("create secret directory")?;
    }
    let mut plaintext = Zeroizing::new(Vec::with_capacity(
        INNER_MAGIC.len() + purpose.len() + secret.len() + 2,
    ));
    plaintext.extend_from_slice(INNER_MAGIC);
    plaintext.extend_from_slice(&(purpose.len() as u16).to_le_bytes());
    plaintext.extend_from_slice(purpose.as_bytes());
    plaintext.extend_from_slice(secret);
    let encrypted = dpapi("Protect", &plaintext)?;
    let mut file_bytes = Vec::with_capacity(FILE_MAGIC.len() + encrypted.len());
    file_bytes.extend_from_slice(FILE_MAGIC);
    file_bytes.extend_from_slice(&encrypted);
    write_new(path, &file_bytes).context("persist DPAPI-protected secret")
}
fn load_protected(path: &Path, expected_purpose: &str) -> Result<Zeroizing<Vec<u8>>> {
    let file = File::open(path).context("protected identity file unavailable")?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take((64 * 1024 + 8192) as u64)
        .read_to_end(&mut bytes)
        .context("read protected identity")?;
    ensure!(
        bytes.len() <= 64 * 1024 + 8192 && bytes.starts_with(FILE_MAGIC),
        "invalid protected identity file"
    );
    let plaintext = dpapi("Unprotect", &bytes[FILE_MAGIC.len()..])?;
    let plaintext = Zeroizing::new(plaintext);
    ensure!(
        plaintext.len() >= INNER_MAGIC.len() + 2 && plaintext.starts_with(INNER_MAGIC),
        "invalid protected identity payload"
    );
    let purpose_len = u16::from_le_bytes([plaintext[5], plaintext[6]]) as usize;
    ensure!(
        plaintext.len() >= INNER_MAGIC.len() + 2 + purpose_len,
        "invalid protected identity payload"
    );
    let purpose = std::str::from_utf8(&plaintext[7..7 + purpose_len])
        .context("invalid protected identity purpose")?;
    ensure!(
        bool::from(purpose.as_bytes().ct_eq(expected_purpose.as_bytes())),
        "protected identity belongs to a different role or vault"
    );
    Ok(Zeroizing::new(plaintext[7 + purpose_len..].to_vec()))
}
fn dpapi(operation: &str, secret: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        cfg!(target_os = "windows"),
        "DPAPI is available on Windows only"
    );
    let helper = env::var_os("ZCANARY_DPAPI_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../wallet-gate/dpapi.ps1")
        });
    ensure!(helper.is_file(), "DPAPI helper is unavailable");
    let mut process = ProcessCommand::new("powershell.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let mut child = process
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(helper)
        .arg(operation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("start DPAPI helper")?;
    let encoded = Zeroizing::new(STANDARD.encode(secret));
    child
        .stdin
        .take()
        .context("open DPAPI helper stdin")?
        .write_all(encoded.as_bytes())
        .context("pipe protected bytes to DPAPI")?;
    let output = child.wait_with_output().context("wait for DPAPI helper")?;
    ensure!(output.status.success(), "DPAPI operation failed");
    let output_stdout = Zeroizing::new(output.stdout);
    let output_text = std::str::from_utf8(&output_stdout)
        .context("DPAPI helper returned invalid output")?
        .trim();
    STANDARD
        .decode(output_text)
        .context("DPAPI helper returned invalid ciphertext")
}

fn state_lock(state: &Path) -> Result<StateLock> {
    let path = state.join(LOCK_NAME);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .context("open vault state lock")?;
    file.try_lock()
        .context("another vault operation is active")?;
    Ok(StateLock { _file: file })
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let file_name = path.file_name().context("destination filename missing")?;
    // A terminated process may leave a temp file behind. Advance past stale
    // candidates instead of letting a PID reuse permanently block a retry.
    let (temporary_path, mut file) = (0..1024)
        .find_map(|_| {
            let mut temporary_name = file_name.to_os_string();
            temporary_name.push(format!(
                ".tmp-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let candidate = path.with_file_name(temporary_name);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .context("unable to reserve a unique temporary file")??;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if written.is_err() {
        let _ = fs::remove_file(&temporary_path);
        written?;
    }
    let link_result = fs::hard_link(&temporary_path, path);
    let _ = fs::remove_file(&temporary_path);
    link_result.context("destination already exists or cannot be committed atomically")
}
fn read_json(path: &Path, limit: usize) -> Result<Value> {
    let file = File::open(path).context("vault record unavailable")?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "vault record exceeds size limit");
    Ok(serde_json::from_slice(&bytes).context("invalid vault JSON record")?)
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("{key} must be a string"))
}
fn clear_string(value: &mut Value, key: &str) {
    if let Some(Value::String(secret)) = value.get_mut(key) {
        secret.zeroize();
    }
    if let Some(object) = value.as_object_mut() {
        object.remove(key);
    }
}
fn number_u32(value: &Value, key: &str) -> Result<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .context("unsigned integer field required")?
        .try_into()
        .context("integer field is out of range")
}
fn string_array<const N: usize>(value: &Value, key: &str) -> Result<[String; N]> {
    let items = value
        .get(key)
        .and_then(Value::as_array)
        .with_context(|| format!("{key} array required"))?;
    ensure!(items.len() == N, "{key} must contain exactly {N} items");
    items
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .context("array entry must be a string")
        })
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("wrong number of entries"))
}
fn keeper_fingerprints(recipients: &[String; 5]) -> Result<[[u8; 32]; 5]> {
    let ids: [[u8; 32]; 5] = recipients
        .iter()
        .map(|r| recipient_fingerprint(r).context("invalid keeper age recipient"))
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five keeper recipients required"))?;
    ensure!(
        ids.iter().enumerate().all(|(i, id)| !ids[..i].contains(id)),
        "keeper recipient keys must be distinct"
    );
    Ok(ids)
}
fn manifest_fingerprint(full: &[u8; 32]) -> String {
    full[..16]
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":")
}
fn commitments_for(
    manifest: &ImmutableManifest,
    keeper_ids: [[u8; 32]; 5],
) -> Result<[ShareCommitment; 5]> {
    (0..5)
        .map(|i| {
            Ok(ShareCommitment {
                keeper_id: keeper_ids[i],
                index: (i + 1) as u8,
                digest: hex32(&manifest.fields.share_commitments[i])?,
            })
        })
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five commitments required"))
}
fn manifest_json(manifest: &ImmutableManifest) -> Result<Value> {
    let mut value: Value = serde_json::from_slice(&canonical_manifest_bytes(&manifest.fields)?)?;
    let mut commitments = Map::new();
    for (i, digest) in manifest.fields.share_commitments.iter().enumerate() {
        commitments.insert((i + 1).to_string(), json!(digest));
    }
    value["shareCommitments"] = Value::Object(commitments);
    value["recipientFingerprint"] = json!(manifest.recipient_fingerprint);
    value["sourceSignatureHex"] = json!(manifest.source_signature_hex);
    value["manifestDigestHex"] = json!(manifest.manifest_digest_hex);
    Ok(value)
}
fn parse_manifest(v: &Value) -> Result<ImmutableManifest> {
    let commitments: [String; 5] = (1..=5)
        .map(|i| string(&v["shareCommitments"], &i.to_string()).map(str::to_owned))
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five share commitments required"))?;
    let keeper_ids: [String; 5] = v
        .get("keeperIds")
        .and_then(Value::as_array)
        .context("keeperIds required")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .context("keeper ID must be a string")
        })
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five keeper IDs required"))?;
    let manifest = ImmutableManifest {
        fields: ManifestFields {
            network: number_u32(v, "network")?
                .try_into()
                .context("invalid network")?,
            switch_id_hex: string(v, "switchIdHex")?.into(),
            source_pubkey_hex: string(v, "sourcePubKeyHex")?.into(),
            recipient_pubkey_hex: string(v, "recipientPubKeyHex")?.into(),
            package_digest_hex: string(v, "packageDigestHex")?.into(),
            package_size: v
                .get("packageSize")
                .and_then(Value::as_u64)
                .context("packageSize required")?,
            initial_interval_blocks: number_u32(v, "initialIntervalBlocks")?,
            grace_blocks: number_u32(v, "graceBlocks")?,
            confirmation_target: number_u32(v, "confirmationTarget")?,
            max_extension_blocks: number_u32(v, "maxExtensionBlocks")?,
            threshold: number_u32(v, "threshold")?
                .try_into()
                .context("invalid threshold")?,
            configuration_epoch: number_u32(v, "configurationEpoch")?,
            share_commitments: commitments,
        },
        protocol_id: string(v, "protocolId")?.into(),
        recipient_fingerprint: string(v, "recipientFingerprint")?.into(),
        keeper_ids,
        source_signature_hex: string(v, "sourceSignatureHex")?.into(),
        manifest_digest_hex: string(v, "manifestDigestHex")?.into(),
    };
    ensure!(
        verify_manifest(&manifest),
        "manifest signature/digest verification failed"
    );
    Ok(manifest)
}
fn checked_id(id: &str) -> Result<String> {
    let bytes = hex::decode(id).context("vault id must be 32-byte hex")?;
    ensure!(bytes.len() == 32, "vault id must be 32-byte hex");
    Ok(hex::encode(bytes))
}
fn checked_operation_id(id: &str) -> Result<String> {
    let bytes = hex::decode(id).context("operationId must be 16-byte hex")?;
    ensure!(bytes.len() == 16, "operationId must be 16-byte hex");
    Ok(hex::encode(bytes))
}
fn hex32(s: &str) -> Result<[u8; 32]> {
    hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected 32-byte hex value"))
}
fn operation_name(op: Operation) -> &'static str {
    match op {
        Operation::Register => "register",
        Operation::Postpone => "postpone",
        Operation::Cancel => "cancel",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn identity_backups_restore_both_roles_and_refuse_wrong_context_or_replacement() {
        let root = std::env::temp_dir().join(format!(
            "zcanary-identity-backup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for role in [Role::Source, Role::Recipient] {
            let original = root.join(format!("{}-original", role_name(role)));
            let restored = root.join(format!("{}-restored", role_name(role)));
            let different = root.join(format!("{}-different", role_name(role)));
            for path in [&original, &restored, &different] {
                fs::create_dir_all(path).unwrap();
            }
            for path in [&original, &different] {
                ensure_role(path, role).unwrap();
                match role {
                    Role::Source => {
                        load_or_create_source_seed(path).unwrap();
                    }
                    Role::Recipient => {
                        init_recipient(path).unwrap();
                    }
                }
            }
            let request =
                json!({"role":role_name(role),"passphrase":"test-only long backup passphrase"});
            let backup = export_identity(&original, &request).unwrap();
            assert_eq!(backup.as_object().unwrap().len(), 4);
            assert_eq!(backup["version"], 1);
            let mut restore = json!({"role":role_name(role),"passphrase":"test-only long backup passphrase","expectedFingerprint":backup["fingerprint"],"backup":backup});
            assert_eq!(
                import_identity(&restored, &restore).unwrap()["alreadyPresent"],
                false
            );
            assert_eq!(
                import_identity(&restored, &restore).unwrap()["alreadyPresent"],
                true
            );
            let (file, purpose) = identity_slot(role);
            let before = load_protected(&different.join(file), purpose).unwrap();
            assert!(import_identity(&different, &restore).is_err());
            let after = load_protected(&different.join(file), purpose).unwrap();
            assert!(bool::from(before.as_slice().ct_eq(&after)));
            let restored_key = load_protected(&restored.join(file), purpose).unwrap();
            assert_eq!(
                backup_fingerprint(role, &restored_key).unwrap(),
                restore["expectedFingerprint"].as_str().unwrap()
            );
            restore["passphrase"] = json!("incorrect test-only passphrase");
            assert!(import_identity(&restored, &restore).is_err());
            restore["passphrase"] = request["passphrase"].clone();
            restore["expectedFingerprint"] = json!("00".repeat(32));
            restore["backup"]["fingerprint"] = restore["expectedFingerprint"].clone();
            assert!(import_identity(&restored, &restore).is_err());
            restore["role"] = json!(if matches!(role, Role::Source) {
                "recipient"
            } else {
                "source"
            });
            assert!(import_identity(&restored, &restore).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn dpapi_restore_command_retry_and_three_keeper_recipient_roundtrip() {
        use zcanary_crypto::{KeeperShareEnvelope, open_keeper_share, package_recipient_share};
        let root = std::env::temp_dir().join(format!(
            "zcanary-cli-roundtrip-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = root.join("source");
        let recipient_state = root.join("recipient");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&recipient_state).unwrap();
        let recipient = init_recipient(&recipient_state).unwrap();
        assert_eq!(init_recipient(&recipient_state).unwrap(), recipient);
        assert!(init_recipient(&source).is_ok());
        assert!(ensure_role(&source, Role::Source).is_err());
        let source = root.join("actual-source");
        fs::create_dir_all(&source).unwrap();
        let keeper_keys: [x25519::Identity; 5] =
            std::array::from_fn(|_| x25519::Identity::generate());
        let recipients = keeper_keys
            .each_ref()
            .map(|key| key.to_public().to_string());
        let clear = b"Canary DPAPI integration fixture: encrypted evidence\0\xff";
        let created = create(&source, &json!({"fileName":"evidence.bin","contentsBase64":STANDARD.encode(clear),"recipient":recipient["recipient"],"keeperRecipients":recipients,"intervalBlocks":20,"graceBlocks":2,"confirmationTarget":2,"maxExtensionBlocks":100})).unwrap();
        let manifest = parse_manifest(&created["manifest"]).unwrap();
        let mut request = json!({"id":created["id"],"operationId":"01".repeat(16),"operation":"register","expiryHeight":100});
        let registration = command(&source, &request).unwrap();
        assert_eq!(command(&source, &request).unwrap(), registration);
        request["expiryHeight"] = json!(101);
        assert!(command(&source, &request).is_err());
        assert!(init_recipient(&source).is_err());
        let ids = keeper_fingerprints(&recipients).unwrap();
        let context = ShareSetContext {
            switch_id: hex32(&manifest.fields.switch_id_hex).unwrap(),
            epoch: manifest.fields.configuration_epoch,
            keeper_ids: ids,
        };
        let commitments = commitments_for(&manifest, ids).unwrap();
        let delivery_context = DeliveryContext {
            switch_id: context.switch_id,
            epoch: context.epoch,
            manifest_digest: hex32(&manifest.manifest_digest_hex).unwrap(),
            expected_recipient_fingerprint: recipient_fingerprint(
                recipient["recipient"].as_str().unwrap(),
            )
            .unwrap(),
        };
        let mut deliveries = Vec::new();
        for i in 0..3 {
            let wire = &created["provisions"][i]["envelope"];
            let envelope = KeeperShareEnvelope {
                version: wire["version"].as_u64().unwrap() as u8,
                keeper_id: hex32(wire["keeper_id_hex"].as_str().unwrap()).unwrap(),
                index: wire["index"].as_u64().unwrap() as u8,
                ciphertext: hex::decode(wire["ciphertext_hex"].as_str().unwrap()).unwrap(),
            };
            let share =
                open_keeper_share(&envelope, &context, &commitments, &keeper_keys[i]).unwrap();
            let delivery = package_recipient_share(
                &share,
                &context,
                &commitments,
                delivery_context,
                recipient["recipient"].as_str().unwrap(),
            )
            .unwrap();
            let delivery_hex = hex::encode(delivery.to_bytes().unwrap());
            let accepted = accept_share(&recipient_state,&json!({"manifest":created["manifest"],"deliveryHex":delivery_hex,"keeperRecipients":recipients})).unwrap();
            assert_eq!(accepted["keeperIndex"], i + 1);
            deliveries.push(delivery_hex);
        }
        let package_bytes = fs::read(created["packagePath"].as_str().unwrap()).unwrap();
        assert!(
            !package_bytes
                .windows(clear.len())
                .any(|bytes| bytes == clear)
        );
        let mut recovery = json!({"manifest":created["manifest"],"packageBase64":STANDARD.encode(&package_bytes),"deliveriesHex":deliveries,"keeperRecipients":recipients});
        let result = decrypt(&recipient_state, &recovery).unwrap();
        assert_eq!(
            STANDARD
                .decode(result["contentsBase64"].as_str().unwrap())
                .unwrap(),
            clear
        );
        recovery["deliveriesHex"].as_array_mut().unwrap().pop();
        assert!(decrypt(&recipient_state, &recovery).is_err());
        // This uniquely created temporary directory contains only this test's state.
        fs::remove_dir_all(root).unwrap();
    }

    fn test_manifest(seed: &[u8; 32]) -> ImmutableManifest {
        let source = SigningKey::from_bytes(seed).verifying_key().to_bytes();
        sign_manifest(
            ManifestFields {
                network: 1,
                switch_id_hex: hex::encode([0x11; 32]),
                source_pubkey_hex: hex::encode(source),
                recipient_pubkey_hex: hex::encode([0x22; 32]),
                package_digest_hex: hex::encode([0x33; 32]),
                package_size: 64,
                initial_interval_blocks: 10,
                grace_blocks: 2,
                confirmation_target: 2,
                max_extension_blocks: 100,
                threshold: 3,
                configuration_epoch: 1,
                share_commitments: std::array::from_fn(|i| hex::encode([i as u8 + 1; 32])),
            },
            seed,
        )
        .unwrap()
    }

    #[test]
    fn reserves_monotonic_sequence_and_signs_register_postpone_cancel_memos() {
        let seed = [0x5a; 32];
        let manifest = test_manifest(&seed);
        let mut journal = Vec::new();

        let sequence = reserve_sequence(Operation::Register, 10, &journal).unwrap();
        assert_eq!(sequence, 0);
        let register = signed_memo(&manifest, &seed, Operation::Register, sequence, 10).unwrap();
        let register_command = decode_and_verify_memo(&register, 1).unwrap();
        assert_eq!(register_command.operation, Operation::Register);
        assert_eq!(register_command.sequence, 0);
        journal.push(JournalCommand {
            operation_id: "01".repeat(16),
            operation: "register".into(),
            sequence,
            expiry_height: 10,
            memo_hex: hex::encode(register),
        });

        let sequence = reserve_sequence(Operation::Postpone, 20, &journal).unwrap();
        assert_eq!(sequence, 1);
        let postpone = signed_memo(&manifest, &seed, Operation::Postpone, sequence, 20).unwrap();
        let postpone_command = decode_and_verify_memo(&postpone, 1).unwrap();
        assert_eq!(postpone_command.operation, Operation::Postpone);
        assert_eq!(postpone_command.sequence, 1);
        journal.push(JournalCommand {
            operation_id: "02".repeat(16),
            operation: "postpone".into(),
            sequence,
            expiry_height: 20,
            memo_hex: hex::encode(postpone),
        });

        let sequence = reserve_sequence(Operation::Cancel, 0, &journal).unwrap();
        assert_eq!(sequence, 2);
        let cancel = signed_memo(&manifest, &seed, Operation::Cancel, sequence, 0).unwrap();
        let cancel_command = decode_and_verify_memo(&cancel, 1).unwrap();
        assert_eq!(cancel_command.operation, Operation::Cancel);
        assert_eq!(cancel_command.sequence, 2);
        journal.push(JournalCommand {
            operation_id: "03".repeat(16),
            operation: "cancel".into(),
            sequence,
            expiry_height: 0,
            memo_hex: hex::encode(cancel),
        });

        assert!(reserve_sequence(Operation::Register, 30, &journal).is_err());
        assert!(reserve_sequence(Operation::Postpone, 21, &journal).is_err());
    }

    #[test]
    fn rejects_mutation_without_registration_nonincreasing_expiry_and_sequence_overflow() {
        assert!(reserve_sequence(Operation::Postpone, 20, &[]).is_err());
        let register = JournalCommand {
            operation_id: "11".repeat(16),
            operation: "register".into(),
            sequence: 0,
            expiry_height: 10,
            memo_hex: String::new(),
        };
        assert!(reserve_sequence(Operation::Postpone, 10, &[register.clone()]).is_err());
        let exhausted = JournalCommand {
            operation_id: "22".repeat(16),
            operation: "postpone".into(),
            sequence: u64::MAX,
            expiry_height: 20,
            memo_hex: String::new(),
        };
        assert!(reserve_sequence(Operation::Cancel, 0, &[register, exhausted]).is_err());
    }

    #[test]
    fn manifest_json_roundtrip_preserves_signature_and_rejects_tampering() {
        let manifest = test_manifest(&[0x5a; 32]);
        let value = manifest_json(&manifest).unwrap();
        let parsed = parse_manifest(&value).unwrap();
        assert_eq!(parsed, manifest);
        let mut altered = value;
        altered["packageSize"] = json!(65);
        assert!(parse_manifest(&altered).is_err());
    }

    #[test]
    fn operation_ids_are_16_bytes_while_vault_ids_are_32_bytes() {
        assert!(checked_operation_id(&"ab".repeat(16)).is_ok());
        assert!(checked_operation_id(&"ab".repeat(32)).is_err());
        assert!(checked_id(&"cd".repeat(32)).is_ok());
        assert!(checked_id(&"cd".repeat(16)).is_err());
    }

    #[test]
    fn operation_id_retry_returns_prior_record_or_rejects_conflicting_reuse() {
        let prior = vec![JournalCommand {
            operation_id: "ab".repeat(16),
            operation: "register".into(),
            sequence: 0,
            expiry_height: 55,
            memo_hex: "a512memo".into(),
        }];
        assert_eq!(
            retry_command(&prior, &prior[0].operation_id, "register", 55)
                .unwrap()
                .unwrap()
                .sequence,
            0
        );
        assert!(retry_command(&prior, &prior[0].operation_id, "register", 56).is_err());
        assert!(retry_command(&prior, &prior[0].operation_id, "cancel", 0).is_err());
        assert!(
            retry_command(&prior, &"cd".repeat(16), "register", 55)
                .unwrap()
                .is_none()
        );
    }
}
