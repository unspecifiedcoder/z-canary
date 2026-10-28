use age::x25519;
use ed25519_dalek::{Signer, SigningKey};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    str::FromStr,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use zcanary_core::{ImmutableManifest, ManifestFields, verify_manifest};
use zcanary_crypto::{
    DeliveryContext, KeeperShareEnvelope, ShareCommitment, ShareSetContext, open_keeper_share,
    package_recipient_share, recipient_fingerprint,
};
use zcanary_keeper::{
    ConfirmedBatch, Cursor, Keeper, Policy, ProvisioningRecord, ScannedBlock, ScannedOutput,
    ScannedTransaction,
};
use zcanary_storage::{IdentityContext, IdentityRole, SecretBundle, load_file, save_new};
use zeroize::Zeroize;

const MAX_BODY: usize = 256 * 1024;
const MAX_HEADER: usize = 8 * 1024;
const MODE: &str = "synthetic-chain";
const LIVE_MODE: &str = "testnet-chain";
const LIVE_SCAN_TTL: Duration = Duration::from_secs(120);

struct Config {
    db: PathBuf,
    keeper_id: String,
    network: u8,
    listen: SocketAddr,
    mode: &'static str,
    checkpoint: Option<Cursor>,
}
struct App {
    keeper: Keeper,
    identity: x25519::Identity,
    signing: SigningKey,
    id: String,
    network: u8,
    token: String,
    mode: &'static str,
    last_validated_scan: Cell<Option<Instant>>,
}

#[derive(Deserialize)]
struct ProvisionRequest {
    manifest: ManifestWire,
    keeper_index: u8,
    keeper_recipients: [String; 5],
    envelope: Envelope,
}
#[derive(Deserialize)]
struct ManifestWire {
    #[serde(rename = "protocolId")]
    protocol_id: String,
    network: u8,
    #[serde(rename = "switchIdHex")]
    switch_id_hex: String,
    #[serde(rename = "sourcePubKeyHex")]
    source_pubkey_hex: String,
    #[serde(rename = "recipientPubKeyHex")]
    recipient_pubkey_hex: String,
    #[serde(rename = "recipientFingerprint")]
    recipient_fingerprint: String,
    #[serde(rename = "packageDigestHex")]
    package_digest_hex: String,
    #[serde(rename = "packageSize")]
    package_size: u64,
    #[serde(rename = "initialIntervalBlocks")]
    initial_interval_blocks: u32,
    #[serde(rename = "graceBlocks")]
    grace_blocks: u32,
    #[serde(rename = "confirmationTarget")]
    confirmation_target: u32,
    #[serde(rename = "maxExtensionBlocks")]
    max_extension_blocks: u32,
    #[serde(rename = "keeperIds")]
    keeper_ids: [String; 5],
    threshold: u8,
    #[serde(rename = "configurationEpoch")]
    configuration_epoch: u32,
    #[serde(rename = "shareCommitments")]
    share_commitments: std::collections::BTreeMap<String, String>,
    #[serde(rename = "sourceSignatureHex")]
    source_signature_hex: String,
    #[serde(rename = "manifestDigestHex")]
    manifest_digest_hex: String,
}
#[derive(Deserialize, Serialize)]
struct Envelope {
    version: u8,
    keeper_id_hex: String,
    index: u8,
    ciphertext_hex: String,
}
#[derive(Deserialize)]
struct BatchRequest {
    adapter: String,
    network: u8,
    complete: bool,
    confirmed_through: u32,
    observed_tip_height: u32,
    blocks: Vec<BlockWire>,
}
#[derive(Deserialize)]
struct BlockWire {
    height: u32,
    hash_hex: String,
    previous_hash_hex: String,
    transactions: Vec<TxWire>,
}
#[derive(Deserialize)]
struct TxWire {
    txid_hex: String,
    tx_index: u32,
    outputs: Vec<OutputWire>,
}
#[derive(Deserialize)]
struct OutputWire {
    tx_index: u32,
    output_index: u32,
    memo_hex: String,
}
#[derive(Deserialize)]
struct AckRequest {
    delivery_id: i64,
    delivered: bool,
    cursor: CursorWire,
}
#[derive(Deserialize)]
struct CursorWire {
    height: u32,
    hash_hex: String,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("keeper service stopped: {e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let c = config()?;
    let docker_private_bind = env::var("ZCANARY_ALLOW_PRIVATE_BIND").as_deref() == Ok("1")
        && c.mode == MODE
        && c.listen.ip().is_unspecified();
    if !c.listen.ip().is_loopback() && !docker_private_bind {
        return Err("listener must bind to loopback (or an explicitly enabled private container interface)".into());
    }
    let token = env::var("ZCANARY_KEEPER_TOKEN").map_err(|_| "ZCANARY_KEEPER_TOKEN is required")?;
    let pass = SecretString::from(
        env::var("ZCANARY_IDENTITY_PASSPHRASE")
            .map_err(|_| "ZCANARY_IDENTITY_PASSPHRASE is required")?,
    );
    if pass.expose_secret().len() < 32 {
        return Err("identity passphrase must contain at least 32 characters".into());
    }
    if token.len() < 32 {
        return Err("keeper token must contain at least 32 characters".into());
    }
    let identity_path = c.db.with_extension("identity.age");
    let ctx = IdentityContext::new(
        IdentityRole::Recipient,
        format!("keeper-identity:{}", c.keeper_id),
    )
    .map_err(|_| "invalid identity context")?;
    if c.db.exists() != identity_path.exists() {
        return Err(
            "keeper database and encrypted identity must both exist or both be absent".into(),
        );
    }
    if !identity_path.exists() {
        let identity = x25519::Identity::generate();
        let signing_entropy = x25519::Identity::generate();
        let mut saved = format!(
            "{}\n{}",
            identity.to_string().expose_secret(),
            signing_entropy.to_string().expose_secret()
        );
        let bundle = SecretBundle::new(ctx.clone(), saved.as_bytes())
            .map_err(|_| "identity serialization failed")?;
        saved.zeroize();
        if let Some(parent) = identity_path.parent() {
            fs::create_dir_all(parent).map_err(|_| "cannot create identity directory")?;
        }
        save_new(&identity_path, &bundle, &pass).map_err(|_| "cannot encrypt keeper identity")?;
    }
    let bundle = load_file(&identity_path, &pass, &ctx)
        .map_err(|_| "cannot decrypt keeper identity; passphrase or file is invalid")?;
    let saved = std::str::from_utf8(bundle.expose_secret_bytes())
        .map_err(|_| "stored identity is invalid")?;
    let (identity_text, signing_entropy) =
        saved.split_once('\n').ok_or("stored identity is invalid")?;
    let identity =
        x25519::Identity::from_str(identity_text).map_err(|_| "stored identity is invalid")?;
    let mut hasher = Sha256::new();
    hasher.update(b"z-canary/keeper-ack-key/v1\0");
    hasher.update(signing_entropy.as_bytes());
    let mut signing_seed: [u8; 32] = hasher.finalize().into();
    let signing = SigningKey::from_bytes(&signing_seed);
    signing_seed.zeroize();
    let db = if c.db.exists() {
        Keeper::open_existing(&c.db, c.network, c.keeper_id.clone())
    } else {
        match c.checkpoint.clone() {
            Some(checkpoint) => {
                Keeper::open_at_checkpoint(&c.db, c.network, c.keeper_id.clone(), checkpoint)
            }
            None => Keeper::open(&c.db, c.network, c.keeper_id.clone()),
        }
    }
    .map_err(|_| "cannot open keeper database")?;
    let app = App {
        keeper: db,
        identity,
        signing,
        id: c.keeper_id,
        network: c.network,
        token,
        mode: c.mode,
        last_validated_scan: Cell::new(None),
    };
    let listener = TcpListener::bind(c.listen).map_err(|_| "cannot bind loopback listener")?;
    eprintln!("keeper service ready on {} ({})", c.listen, app.mode);
    for stream in listener.incoming() {
        match stream {
            Ok(s) => handle(s, &app),
            Err(_) => eprintln!("request accept failed"),
        }
    }
    Ok(())
}
fn config() -> Result<Config, String> {
    let mut db = None;
    let mut id = None;
    let mut network = None;
    let mut listen = None;
    let mut mode = None;
    let mut checkpoint_height = None;
    let mut checkpoint_hash = None;
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        let v = args.next().ok_or("missing CLI argument value")?;
        match a.as_str() {
            "--db" => db = Some(PathBuf::from(v)),
            "--keeper-id" => id = Some(v),
            "--network" => {
                network = Some(v.parse::<u8>().map_err(|_| "network must be 1 (testnet)")?)
            }
            "--listen" => {
                listen = Some(
                    v.parse::<SocketAddr>()
                        .map_err(|_| "invalid listen address")?,
                )
            }
            "--mode" if v == MODE => mode = Some(MODE),
            "--mode" if v == LIVE_MODE => mode = Some(LIVE_MODE),
            "--mode" => return Err("unsupported chain adapter mode".into()),
            "--checkpoint-height" => {
                checkpoint_height = Some(v.parse::<u32>().map_err(|_| "invalid checkpoint height")?)
            }
            "--checkpoint-hash" => {
                checkpoint_hash = Some(decode32(&v).ok_or("invalid checkpoint hash")?)
            }
            _ => return Err(format!("unknown CLI option {a}")),
        }
    }
    let network = network.ok_or("--network is required")?;
    if network != 1 {
        return Err("keeper service currently supports testnet only (network 1)".into());
    }
    let mode = mode.ok_or("explicit --mode is required")?;
    let checkpoint = match (checkpoint_height, checkpoint_hash) {
        (Some(height), Some(hash)) => Some(Cursor { height, hash }),
        (None, None) if mode == MODE => None,
        _ => return Err("live mode requires a verified checkpoint height and hash".into()),
    };
    let keeper_id = id.ok_or("--keeper-id is required")?;
    if ![
        "keeper-01",
        "keeper-02",
        "keeper-03",
        "keeper-04",
        "keeper-05",
    ]
    .contains(&keeper_id.as_str())
    {
        return Err("--keeper-id must be keeper-01 through keeper-05".into());
    }
    Ok(Config {
        db: db.ok_or("--db is required")?,
        keeper_id,
        network,
        listen: listen.ok_or("--listen is required")?,
        mode,
        checkpoint,
    })
}
fn handle(mut stream: TcpStream, app: &App) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let response = match read_request(&mut stream) {
        Ok((method, path, headers, body)) => route(app, &method, &path, &headers, &body),
        Err(_) => reply(400, json!({"error":"bad_request"})),
    };
    let (status, body) = response;
    let phrase = match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Bad Request",
    };
    let bytes = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {phrase}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        bytes.len(),
        bytes
    );
}
fn read_request(
    s: &mut TcpStream,
) -> Result<
    (
        String,
        String,
        std::collections::HashMap<String, String>,
        Vec<u8>,
    ),
    (),
> {
    let mut buf = Vec::new();
    let mut temp = [0u8; 4096];
    let header_end = loop {
        let n = s.read(&mut temp).map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        buf.extend_from_slice(&temp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            if i + 4 > MAX_HEADER {
                return Err(());
            }
            break i + 4;
        }
        if buf.len() > MAX_HEADER {
            return Err(());
        }
    };
    let (method, path, headers, len) = parse_head(&buf[..header_end])?;
    let start = header_end;
    while buf.len() - start < len {
        let n = s.read(&mut temp).map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        buf.extend_from_slice(&temp[..n]);
    }
    if buf.len() - start != len {
        return Err(());
    }
    Ok((method, path, headers, buf[start..start + len].to_vec()))
}

fn parse_head(
    head: &[u8],
) -> Result<
    (
        String,
        String,
        std::collections::HashMap<String, String>,
        usize,
    ),
    (),
> {
    if head.len() > MAX_HEADER || !head.ends_with(b"\r\n\r\n") {
        return Err(());
    }
    let head = std::str::from_utf8(head).map_err(|_| ())?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().ok_or(())?.split_whitespace();
    let method = first.next().ok_or(())?.to_owned();
    let path = first.next().ok_or(())?.to_owned();
    if first.next() != Some("HTTP/1.1")
        || first.next().is_some()
        || method.is_empty()
        || path.is_empty()
    {
        return Err(());
    }
    let mut headers = std::collections::HashMap::new();
    for l in lines {
        if l.is_empty() {
            continue;
        }
        let Some((k, v)) = l.split_once(':') else {
            return Err(());
        };
        let name = k.trim().to_ascii_lowercase();
        if headers.insert(name, v.trim().to_owned()).is_some() {
            return Err(());
        }
    }
    if headers.contains_key("origin") || headers.contains_key("transfer-encoding") {
        return Err(());
    }
    let len = match headers.get("content-length") {
        Some(v) => v.parse::<usize>().map_err(|_| ())?,
        None => 0,
    };
    if len > MAX_BODY {
        return Err(());
    }
    Ok((method, path, headers, len))
}
fn route(
    a: &App,
    m: &str,
    p: &str,
    h: &std::collections::HashMap<String, String>,
    b: &[u8],
) -> (u16, Value) {
    let expected = format!("Bearer {}", a.token);
    let valid = h
        .get("authorization")
        .is_some_and(|v| v.as_bytes().ct_eq(expected.as_bytes()).into());
    if !valid {
        return reply(401, json!({"error":"unauthorized"}));
    }
    match (m, p) {
        ("GET", "/v1/status") => status(a),
        ("POST", "/v1/provision") => provision(a, b),
        ("POST", "/v1/confirmed-batch") => {
            a.last_validated_scan.set(None);
            if a.keeper.mark_unhealthy().is_err() {
                reply(500, json!({"error":"keeper_health_update_failed"}))
            } else {
                batch(a, b)
            }
        }
        ("GET", "/v1/next-delivery") => next_delivery(a),
        ("POST", "/v1/scan-failed") => {
            a.last_validated_scan.set(None);
            match a.keeper.mark_unhealthy() {
                Ok(()) => reply(200, json!({"healthy":false})),
                Err(_) => reply(500, json!({"error":"suspension_failed"})),
            }
        }
        ("POST", "/v1/ack-delivery") => ack_delivery(a, b),
        _ if m == "GET" && p.starts_with("/v1/vaults/") => vault_status(a, &p[11..]),
        _ => reply(404, json!({"error":"not_found"})),
    }
}
fn status(a: &App) -> (u16, Value) {
    let healthy = scan_is_fresh(a) && a.keeper.is_healthy().unwrap_or(false);
    let c = a.keeper.cursor().ok().flatten();
    reply(
        200,
        json!({"service":"zcanary-keeper-service/0.1","mode":a.mode,"keeper_id":a.id,"network":a.network,"recipient":a.identity.to_public().to_string(),"signing_pubkey_hex":hex::encode(a.signing.verifying_key().to_bytes()),"cursor":c.map(|c|json!({"height":c.height,"hash_hex":hex::encode(c.hash)})),"healthy":healthy}),
    )
}
fn provision(a: &App, b: &[u8]) -> (u16, Value) {
    let r: ProvisionRequest = match serde_json::from_slice(b) {
        Ok(v) => v,
        Err(_) => return reply(400, json!({"error":"invalid_json"})),
    };
    let manifest = r.manifest.into_manifest();
    if !verify_manifest(&manifest) {
        return reply(400, json!({"error":"manifest_invalid"}));
    }
    let f = &manifest.fields;
    if f.network != a.network
        || !(1..=5).contains(&r.keeper_index)
        || manifest.keeper_ids[(r.keeper_index - 1) as usize] != a.id
    {
        return reply(400, json!({"error":"keeper_context_mismatch"}));
    }
    let sid = hex32(&f.switch_id_hex);
    let digest = hex32(&manifest.manifest_digest_hex);
    let source = hex32(&f.source_pubkey_hex);
    let Some((switch_id, manifest_digest, source_pubkey)) =
        sid.zip(digest).zip(source).map(|((x, y), z)| (x, y, z))
    else {
        return reply(400, json!({"error":"manifest_invalid"}));
    };
    let mut ids = [[0u8; 32]; 5];
    for (i, recipient) in r.keeper_recipients.iter().enumerate() {
        let Ok(fp) = recipient_fingerprint(recipient) else {
            return reply(400, json!({"error":"recipient_invalid"}));
        };
        ids[i] = fp;
    }
    if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
        return reply(400, json!({"error":"recipient_duplicate"}));
    }
    let Ok(local_fp) = recipient_fingerprint(&a.identity.to_public().to_string()) else {
        return reply(500, json!({"error":"identity_invalid"}));
    };
    let idx = (r.keeper_index - 1) as usize;
    if ids[idx] != local_fp {
        return reply(400, json!({"error":"keeper_recipient_mismatch"}));
    }
    let Some(env_id) = decode32(&r.envelope.keeper_id_hex) else {
        return reply(400, json!({"error":"envelope_invalid"}));
    };
    let Ok(ciphertext) = hex::decode(&r.envelope.ciphertext_hex) else {
        return reply(400, json!({"error":"envelope_invalid"}));
    };
    let envelope = KeeperShareEnvelope {
        version: r.envelope.version,
        keeper_id: env_id,
        index: r.envelope.index,
        ciphertext,
    };
    if envelope.index != r.keeper_index || env_id != ids[idx] {
        return reply(400, json!({"error":"envelope_context_mismatch"}));
    }
    let commitments: [ShareCommitment; 5] = std::array::from_fn(|i| ShareCommitment {
        keeper_id: ids[i],
        index: (i + 1) as u8,
        digest: decode32(&f.share_commitments[i]).unwrap_or([0; 32]),
    });
    let context = ShareSetContext {
        switch_id,
        epoch: f.configuration_epoch,
        keeper_ids: ids,
    };
    let Ok(share) = open_keeper_share(&envelope, &context, &commitments, &a.identity) else {
        return reply(400, json!({"error":"share_validation_failed"}));
    };
    let Some(recipient_raw) = decode32(&f.recipient_pubkey_hex) else {
        return reply(400, json!({"error":"recipient_manifest_mismatch"}));
    };
    let Ok(hrp) = bech32::Hrp::parse("age") else {
        return reply(500, json!({"error":"recipient_packaging_failed"}));
    };
    let Ok(recipient) = bech32::encode::<bech32::Bech32>(hrp, &recipient_raw) else {
        return reply(400, json!({"error":"recipient_manifest_mismatch"}));
    };
    let Ok(recipient_fp) = recipient_fingerprint(&recipient) else {
        return reply(400, json!({"error":"recipient_invalid"}));
    };
    let fingerprint_short = recipient_fp[..16]
        .iter()
        .map(|v| format!("{:02X}", v))
        .collect::<Vec<_>>()
        .join(":");
    if fingerprint_short != manifest.recipient_fingerprint {
        return reply(400, json!({"error":"recipient_manifest_mismatch"}));
    }
    let delivery_context = DeliveryContext {
        switch_id,
        epoch: f.configuration_epoch,
        manifest_digest,
        expected_recipient_fingerprint: recipient_fp,
    };
    let Ok(recipient_envelope) =
        package_recipient_share(&share, &context, &commitments, delivery_context, &recipient)
    else {
        return reply(400, json!({"error":"recipient_packaging_failed"}));
    };
    let Ok(stored_payload) = recipient_envelope.to_bytes() else {
        return reply(400, json!({"error":"recipient_packaging_failed"}));
    };
    let envelope_wire = format!(
        "{{\"version\":{},\"keeper_id_hex\":\"{}\",\"index\":{},\"ciphertext_hex\":\"{}\"}}",
        r.envelope.version, r.envelope.keeper_id_hex, r.envelope.index, r.envelope.ciphertext_hex
    );
    let envelope_digest: [u8; 32] = Sha256::digest(envelope_wire.as_bytes()).into();
    if a.keeper
        .provision(ProvisioningRecord {
            switch_id,
            manifest_digest,
            source_pubkey,
            epoch: f.configuration_epoch,
            keeper_index: r.keeper_index,
            policy: Policy {
                initial_interval: f.initial_interval_blocks,
                max_extension: f.max_extension_blocks,
                confirmation_count: f.confirmation_target,
                grace_period: f.grace_blocks,
            },
            encrypted_share_envelope: stored_payload,
        })
        .is_err()
    {
        return reply(400, json!({"error":"provision_rejected"}));
    }
    let mut msg = b"z-canary/keeper-provision-ack/v1\0".to_vec();
    msg.extend_from_slice(a.id.as_bytes());
    msg.push(r.keeper_index);
    msg.extend_from_slice(&switch_id);
    msg.extend_from_slice(&f.configuration_epoch.to_le_bytes());
    msg.extend_from_slice(&manifest_digest);
    msg.extend_from_slice(&envelope_digest);
    let sig = a.signing.sign(&msg);
    reply(
        201,
        json!({"keeper_id":a.id,"keeper_index":r.keeper_index,"switch_id_hex":hex::encode(switch_id),"epoch":f.configuration_epoch,"manifest_digest_hex":hex::encode(manifest_digest),"envelope_digest_hex":hex::encode(envelope_digest),"signing_pubkey_hex":hex::encode(a.signing.verifying_key().to_bytes()),"signature_hex":hex::encode(sig.to_bytes())}),
    )
}
fn batch(a: &App, b: &[u8]) -> (u16, Value) {
    let r: BatchRequest = match serde_json::from_slice(b) {
        Ok(v) => v,
        Err(_) => return reply(400, json!({"error":"invalid_json"})),
    };
    if r.adapter != a.mode || !r.complete || r.network != a.network || r.blocks.is_empty() {
        return reply(400, json!({"error":"untrusted_or_incomplete_batch"}));
    }
    let mut blocks = Vec::with_capacity(r.blocks.len());
    for x in r.blocks {
        let (Some(hash), Some(previous_hash)) =
            (decode32(&x.hash_hex), decode32(&x.previous_hash_hex))
        else {
            return reply(400, json!({"error":"invalid_block_hash"}));
        };
        let mut txs = Vec::new();
        for t in x.transactions {
            let Some(txid) = decode32(&t.txid_hex) else {
                return reply(400, json!({"error":"invalid_txid"}));
            };
            let outputs = t
                .outputs
                .into_iter()
                .map(|o| {
                    let memo = hex::decode(o.memo_hex).map_err(|_| ())?;
                    Ok(ScannedOutput {
                        tx_index: o.tx_index,
                        output_index: o.output_index,
                        memo,
                    })
                })
                .collect::<Result<Vec<_>, ()>>();
            let Ok(outputs) = outputs else {
                return reply(400, json!({"error":"invalid_memo_hex"}));
            };
            txs.push(ScannedTransaction {
                txid,
                tx_index: t.tx_index,
                outputs,
            });
        }
        blocks.push(ScannedBlock {
            height: x.height,
            hash,
            previous_hash,
            transactions: txs,
        });
    }
    match a.keeper.process_confirmed_batch(ConfirmedBatch {
        blocks,
        confirmed_through: r.confirmed_through,
        observed_tip_height: r.observed_tip_height,
    }) {
        Ok(c) => {
            a.last_validated_scan.set(Some(Instant::now()));
            reply(
                200,
                json!({"mode":a.mode,"network":a.network,"cursor":{"height":c.height,"hash_hex":hex::encode(c.hash)},"healthy":true}),
            )
        }
        Err(_) => reply(400, json!({"error":"batch_rejected","healthy":false})),
    }
}
fn next_delivery(a: &App) -> (u16, Value) {
    if !scan_is_fresh(a) {
        return reply(400, json!({"error":"scan_stale","healthy":false}));
    }
    let Some(c) = a.keeper.cursor().ok().flatten() else {
        return reply(200, json!({"delivery":null}));
    };
    match a.keeper.claim_delivery(c.clone()) {
        Ok(Some(d)) => reply(
            200,
            json!({"delivery":{"delivery_id":d.id,"idempotency_key":d.idempotency_key,"switch_id_hex":hex::encode(d.switch_id),"epoch":d.epoch,"manifest_digest_hex":hex::encode(d.manifest_digest),"payload_hex":hex::encode(d.encrypted_share_envelope),"cursor":{"height":c.height,"hash_hex":hex::encode(c.hash)}}}),
        ),
        Ok(None) => reply(200, json!({"delivery":null})),
        Err(_) => reply(400, json!({"error":"delivery_unavailable"})),
    }
}
fn vault_status(a: &App, id: &str) -> (u16, Value) {
    let Some(switch_id) = decode32(id) else {
        return reply(400, json!({"error":"invalid_switch_id"}));
    };
    match a.keeper.vault_state(switch_id) {
        Ok(state) => reply(
            200,
            json!({"switch_id_hex":id,"lifecycle":format!("{:?}",state.lifecycle).to_ascii_uppercase(),"expiry_height":state.expiry_height.map(|height|height.to_string()),"last_sequence":state.last_sequence.map(|sequence|sequence.to_string()),"mode":a.mode}),
        ),
        Err(_) => reply(404, json!({"error":"vault_not_found"})),
    }
}
fn ack_delivery(a: &App, b: &[u8]) -> (u16, Value) {
    if !scan_is_fresh(a) {
        return reply(400, json!({"error":"scan_stale","healthy":false}));
    }
    let r: AckRequest = match serde_json::from_slice(b) {
        Ok(v) => v,
        Err(_) => return reply(400, json!({"error":"invalid_json"})),
    };
    let Some(hash) = decode32(&r.cursor.hash_hex) else {
        return reply(400, json!({"error":"invalid_cursor"}));
    };
    let c = Cursor {
        height: r.cursor.height,
        hash,
    };
    match a.keeper.acknowledge_delivery(r.delivery_id, r.delivered, c) {
        Ok(()) => reply(200, json!({"ok":true,"delivered":r.delivered})),
        Err(_) => reply(400, json!({"error":"ack_rejected"})),
    }
}
fn hex32(s: &str) -> Option<[u8; 32]> {
    decode32(s)
}
// The freshness deadline uses a monotonic process clock. A restart always
// requires another verified complete batch before any delivery can proceed.
fn scan_is_fresh(a: &App) -> bool {
    if a.mode != LIVE_MODE {
        return true;
    }
    let fresh = a
        .last_validated_scan
        .get()
        .is_some_and(|at| at.elapsed() <= LIVE_SCAN_TTL);
    if !fresh {
        a.last_validated_scan.set(None);
        let _ = a.keeper.mark_unhealthy();
    }
    fresh
}
fn decode32(s: &str) -> Option<[u8; 32]> {
    let b = hex::decode(s).ok()?;
    b.try_into().ok()
}
fn reply(status: u16, value: Value) -> (u16, Value) {
    (status, value)
}
impl ManifestWire {
    fn into_manifest(self) -> ImmutableManifest {
        let commitments = std::array::from_fn(|i| {
            self.share_commitments
                .get(&(i + 1).to_string())
                .cloned()
                .unwrap_or_default()
        });
        ImmutableManifest {
            fields: ManifestFields {
                network: self.network,
                switch_id_hex: self.switch_id_hex,
                source_pubkey_hex: self.source_pubkey_hex,
                recipient_pubkey_hex: self.recipient_pubkey_hex,
                package_digest_hex: self.package_digest_hex,
                package_size: self.package_size,
                initial_interval_blocks: self.initial_interval_blocks,
                grace_blocks: self.grace_blocks,
                confirmation_target: self.confirmation_target,
                max_extension_blocks: self.max_extension_blocks,
                threshold: self.threshold,
                configuration_epoch: self.configuration_epoch,
                share_commitments: commitments,
            },
            protocol_id: self.protocol_id,
            recipient_fingerprint: self.recipient_fingerprint,
            keeper_ids: self.keeper_ids,
            source_signature_hex: self.source_signature_hex,
            manifest_digest_hex: self.manifest_digest_hex,
        }
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;

    #[test]
    fn live_scan_freshness_expires_and_scan_failure_suspends_delivery() {
        let path = std::env::temp_dir().join(format!(
            "zcanary-service-freshness-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app = App {
            keeper: Keeper::open_at_checkpoint(
                &path,
                1,
                "keeper-01",
                Cursor {
                    height: 100,
                    hash: [1; 32],
                },
            )
            .unwrap(),
            identity: x25519::Identity::generate(),
            signing: SigningKey::from_bytes(&[7; 32]),
            id: "keeper-01".into(),
            network: 1,
            token: "test-token".into(),
            mode: LIVE_MODE,
            last_validated_scan: Cell::new(None),
        };
        assert_eq!(next_delivery(&app).1["error"], "scan_stale");
        let mut headers = std::collections::HashMap::new();
        headers.insert("authorization".into(), "Bearer test-token".into());
        let body = json!({"adapter":LIVE_MODE,"network":1,"complete":true,"confirmed_through":101,"observed_tip_height":102,"blocks":[{"height":101,"hash_hex":hex::encode([2;32]),"previous_hash_hex":hex::encode([1;32]),"transactions":[]}]}).to_string();
        assert_eq!(
            route(
                &app,
                "POST",
                "/v1/confirmed-batch",
                &headers,
                body.as_bytes()
            )
            .0,
            200
        );
        assert_eq!(status(&app).1["healthy"], true);
        app.last_validated_scan.set(Some(
            Instant::now() - LIVE_SCAN_TTL - Duration::from_secs(1),
        ));
        assert_eq!(next_delivery(&app).1["error"], "scan_stale");
        assert!(!app.keeper.is_healthy().unwrap());
        assert_eq!(status(&app).1["healthy"], false);
        app.last_validated_scan.set(Some(Instant::now()));
        assert_eq!(route(&app, "POST", "/v1/scan-failed", &headers, b"").0, 200);
        assert!(app.last_validated_scan.get().is_none());
        assert_eq!(ack_delivery(&app, b"{}").1["error"], "scan_stale");
        drop(app);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn parses_bounded_loopback_request_headers() {
        let raw = b"GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer test-token\r\n\r\n";
        let (method, path, headers, length) = parse_head(raw).unwrap();
        assert_eq!(method, "GET");
        assert_eq!(path, "/v1/status");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer test-token");
        assert_eq!(length, 0);
    }

    #[test]
    fn rejects_origin_transfer_encoding_and_duplicate_headers() {
        for raw in [
            b"GET /v1/status HTTP/1.1\r\nOrigin: https://example.test\r\n\r\n".as_slice(),
            b"POST /v1/confirmed-batch HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".as_slice(),
            b"POST /v1/confirmed-batch HTTP/1.1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n".as_slice(),
            b"GET /v1/status HTTP/1.1\r\nAuthorization: Bearer a\r\nAUTHORIZATION: Bearer b\r\n\r\n".as_slice(),
        ] {
            assert!(parse_head(raw).is_err());
        }
    }

    #[test]
    fn rejects_invalid_or_oversized_content_length_and_header_block() {
        assert!(
            parse_head(b"POST /v1/confirmed-batch HTTP/1.1\r\nContent-Length: nope\r\n\r\n")
                .is_err()
        );
        assert!(
            parse_head(b"POST /v1/confirmed-batch HTTP/1.1\r\nContent-Length: 262145\r\n\r\n")
                .is_err()
        );
        let mut oversized = b"GET /v1/status HTTP/1.1\r\nX-Large: ".to_vec();
        oversized.extend(std::iter::repeat_n(b'x', MAX_HEADER));
        oversized.extend_from_slice(b"\r\n\r\n");
        assert!(parse_head(&oversized).is_err());
    }
}
