//! Synthetic five-process rehearsal utility. Never connects to a blockchain.
use age::x25519::Identity;
use anyhow::{Context, Result, ensure};
use ed25519_dalek::SigningKey;
use rand::{RngExt, make_rng, rngs::StdRng};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, str::FromStr};
use zcanary_core::{
    Command, ImmutableManifest, ManifestFields, Operation, canonical_manifest_bytes, encode_memo,
    sign_manifest, verify_manifest,
};
use zcanary_crypto::*;
use zcanary_storage::{IdentityContext, IdentityRole, SecretBundle, load_file, save_new};
use zeroize::Zeroizing;

fn synthetic_document() -> Vec<u8> {
    let content = "BT /F1 18 Tf 60 720 Td (Z-Canary synthetic continuity dossier) Tj ET\n";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_owned(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}endstream", content.len()),
    ];
    let mut pdf = "%PDF-1.4\n".to_owned();
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", i + 1));
    }
    let xref = pdf.len();
    pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ));
    pdf.into_bytes()
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 3,
        "usage: zcanary-demo prepare STATUS_JSON OUTPUT_DIR | decrypt OUTPUT_DIR DELIVERIES_JSON"
    );
    let pass = SecretString::from(
        std::env::var("ZCANARY_DEMO_PASSPHRASE")
            .context("demo passphrase environment is required")?,
    );
    ensure!(
        pass.expose_secret().len() >= 32,
        "demo passphrase must have at least 32 characters"
    );
    match args[0].as_str() {
        "prepare" => prepare(Path::new(&args[1]), Path::new(&args[2]), &pass),
        "decrypt" => decrypt(Path::new(&args[1]), Path::new(&args[2]), &pass),
        _ => anyhow::bail!("unsupported demo operation"),
    }
}

fn bytes32(v: &str) -> Result<[u8; 32]> {
    hex::decode(v)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected 32 bytes"))
}
fn read_json(path: &Path) -> Result<Value> {
    ensure!(
        fs::metadata(path)?.len() <= 2 * 1024 * 1024,
        "input too large"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().context("missing public field")
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn verified_manifest(v: &Value) -> Result<ImmutableManifest> {
    let number = |key: &str| -> Result<u32> {
        v[key]
            .as_u64()
            .context("missing integer field")?
            .try_into()
            .context("integer out of bounds")
    };
    let commitments: [String; 5] = (1..=5)
        .map(|i| {
            v["shareCommitments"][i.to_string()]
                .as_str()
                .context("missing commitment")
                .map(str::to_owned)
        })
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five commitments required"))?;
    let keeper_ids: [String; 5] = v["keeperIds"]
        .as_array()
        .context("keeper identities required")?
        .iter()
        .map(|v| {
            v.as_str()
                .context("keeper identity string")
                .map(str::to_owned)
        })
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five keeper identities required"))?;
    let manifest = ImmutableManifest {
        fields: ManifestFields {
            network: number("network")?.try_into()?,
            switch_id_hex: text(v, "switchIdHex")?.into(),
            source_pubkey_hex: text(v, "sourcePubKeyHex")?.into(),
            recipient_pubkey_hex: text(v, "recipientPubKeyHex")?.into(),
            package_digest_hex: text(v, "packageDigestHex")?.into(),
            package_size: v["packageSize"].as_u64().context("package size required")?,
            initial_interval_blocks: number("initialIntervalBlocks")?,
            grace_blocks: number("graceBlocks")?,
            confirmation_target: number("confirmationTarget")?,
            max_extension_blocks: number("maxExtensionBlocks")?,
            threshold: number("threshold")?.try_into()?,
            configuration_epoch: number("configurationEpoch")?,
            share_commitments: commitments,
        },
        protocol_id: text(v, "protocolId")?.into(),
        recipient_fingerprint: text(v, "recipientFingerprint")?.into(),
        keeper_ids,
        source_signature_hex: text(v, "sourceSignatureHex")?.into(),
        manifest_digest_hex: text(v, "manifestDigestHex")?.into(),
    };
    ensure!(
        verify_manifest(&manifest),
        "manifest signature/digest verification failed"
    );
    Ok(manifest)
}

fn prepare(status_path: &Path, dir: &Path, pass: &SecretString) -> Result<()> {
    ensure!(!dir.exists(), "output directory already exists");
    let statuses = read_json(status_path)?;
    let statuses = statuses.as_array().context("statuses array required")?;
    ensure!(statuses.len() == 5, "five keeper statuses required");
    let mut recipients = Vec::new();
    for (i, status) in statuses.iter().enumerate() {
        ensure!(
            status["keeper_id"] == format!("keeper-{:02}", i + 1),
            "keeper ordering mismatch"
        );
        ensure!(
            status["mode"] == "synthetic-chain" && status["network"] == 1,
            "synthetic testnet services required"
        );
        recipients.push(text(status, "recipient")?.to_owned());
    }
    let keeper_recipients: [String; 5] = recipients
        .try_into()
        .map_err(|_| anyhow::anyhow!("five recipients"))?;
    let keeper_ids: [[u8; 32]; 5] = keeper_recipients
        .iter()
        .map(|s| recipient_fingerprint(s))
        .collect::<std::result::Result<Vec<_>, _>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five fingerprints"))?;
    ensure!(
        keeper_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == 5,
        "keeper keys must be distinct"
    );
    fs::create_dir(dir)?;
    let recipient = Identity::generate();
    let recipient_text = recipient.to_string();
    let recipient_context =
        IdentityContext::new(IdentityRole::Recipient, "synthetic-demo-recipient")?;
    save_new(
        dir.join("recipient.identity.age"),
        &SecretBundle::new(
            recipient_context.clone(),
            recipient_text.expose_secret().as_bytes(),
        )?,
        pass,
    )?;
    let restored = load_file(dir.join("recipient.identity.age"), pass, &recipient_context)?;
    ensure!(
        restored.expose_secret_bytes() == recipient_text.expose_secret().as_bytes(),
        "recipient recovery failed"
    );
    let mut seed = Zeroizing::new([0u8; 32]);
    let mut rng: StdRng = make_rng();
    rng.fill(&mut *seed);
    let source_context = IdentityContext::new(IdentityRole::Source, "synthetic-demo-source")?;
    save_new(
        dir.join("source.identity.age"),
        &SecretBundle::new(source_context.clone(), &*seed)?,
        pass,
    )?;
    let restored_source = load_file(dir.join("source.identity.age"), pass, &source_context)?;
    ensure!(
        restored_source.expose_secret_bytes() == seed.as_slice(),
        "source recovery failed"
    );
    let source_pubkey = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let recipient_public = recipient.to_public().to_string();
    let (_, raw_recipient) = bech32::decode(&recipient_public)?;
    let mut vaults = Vec::new();
    for name in ["cancel", "release"] {
        let mut switch_id = [0u8; 32];
        rng.fill(&mut switch_id);
        let package_context = PackageContext {
            switch_id,
            epoch: 1,
            recipient_fingerprint: recipient_fingerprint(&recipient_public)?,
        };
        let share_context = ShareSetContext {
            switch_id,
            epoch: 1,
            keeper_ids,
        };
        let material = create_vault(
            &synthetic_document(),
            &recipient_public,
            package_context,
            share_context,
            keeper_recipients.each_ref().map(String::as_str),
        )?;
        let package = material.package.to_bytes()?;
        let fields = ManifestFields {
            network: 1,
            switch_id_hex: hex::encode(switch_id),
            source_pubkey_hex: hex::encode(source_pubkey),
            recipient_pubkey_hex: hex::encode(&raw_recipient),
            package_digest_hex: hex::encode(material.package_digest),
            package_size: package.len() as u64,
            initial_interval_blocks: 10,
            grace_blocks: 3,
            confirmation_target: 2,
            max_extension_blocks: 100,
            threshold: 3,
            configuration_epoch: 1,
            share_commitments: std::array::from_fn(|i| hex::encode(material.commitments[i].digest)),
        };
        let manifest = sign_manifest(fields, &seed)?;
        let mut manifest_json: Value =
            serde_json::from_slice(&canonical_manifest_bytes(&manifest.fields)?)?;
        manifest_json["recipientFingerprint"] = json!(manifest.recipient_fingerprint);
        manifest_json["sourceSignatureHex"] = json!(manifest.source_signature_hex);
        manifest_json["manifestDigestHex"] = json!(manifest.manifest_digest_hex);
        // Application wire format uses an index-keyed commitment object.
        manifest_json["shareCommitments"] = json!(
            (1..=5)
                .map(|i| (
                    i.to_string(),
                    json!(manifest.fields.share_commitments[i - 1])
                ))
                .collect::<serde_json::Map<String, Value>>()
        );
        let digest = bytes32(&manifest.manifest_digest_hex)?;
        let command = |operation, sequence, expiry| -> Result<String> {
            Ok(hex::encode(encode_memo(
                &Command {
                    network: 1,
                    operation,
                    switch_id,
                    sequence,
                    requested_expiry_height: expiry,
                    manifest_digest: digest,
                    source_pubkey,
                },
                &seed,
            )?))
        };
        fs::write(dir.join(format!("{name}.zcan")), package)?;
        let provisions: Vec<Value> = material.keeper_envelopes.iter().enumerate().map(|(i,e)| json!({"manifest":manifest_json,"recipient":recipient_public,"keeper_index":i+1,"keeper_recipients":keeper_recipients,"envelope":{"version":e.version,"keeper_id_hex":hex::encode(e.keeper_id),"index":e.index,"ciphertext_hex":hex::encode(&e.ciphertext)}})).collect();
        vaults.push(json!({"name":name,"switch_id_hex":hex::encode(switch_id),"manifest":manifest_json,"provisions":provisions,"register_memo_hex":command(Operation::Register,0,11)?,"postpone_memo_hex":command(Operation::Postpone,1,21)?,"cancel_memo_hex":command(Operation::Cancel,1,0)?}));
    }
    write_json(
        &dir.join("public.json"),
        &json!({"mode":"synthetic-chain","keeper_recipients":keeper_recipients,"recipient":recipient_public,"vaults":vaults}),
    )?;
    println!("{{\"prepared\":true,\"encrypted_identity_restore_verified\":true,\"vaults\":2}}");
    Ok(())
}

fn decrypt(dir: &Path, deliveries_path: &Path, pass: &SecretString) -> Result<()> {
    let public = read_json(&dir.join("public.json"))?;
    let vault = &public["vaults"][1];
    ensure!(vault["name"] == "release", "release vault required");
    let manifest = &vault["manifest"];
    let verified = verified_manifest(manifest)?;
    let switch_id = bytes32(text(vault, "switch_id_hex")?)?;
    ensure!(
        switch_id == bytes32(&verified.fields.switch_id_hex)?
            && verified.fields.network == 1
            && verified.fields.configuration_epoch == 1,
        "unexpected manifest context"
    );
    let keeper_ids: [[u8; 32]; 5] = public["keeper_recipients"]
        .as_array()
        .context("keeper config")?
        .iter()
        .map(|v| recipient_fingerprint(v.as_str().unwrap_or("")))
        .collect::<std::result::Result<Vec<_>, _>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("five keeper keys"))?;
    let share_context = ShareSetContext {
        switch_id,
        epoch: 1,
        keeper_ids,
    };
    let commitments: Vec<ShareCommitment> = (0..5)
        .map(|i| {
            Ok(ShareCommitment {
                keeper_id: keeper_ids[i],
                index: (i + 1) as u8,
                digest: bytes32(
                    manifest["shareCommitments"][(i + 1).to_string()]
                        .as_str()
                        .context("share commitment")?,
                )?,
            })
        })
        .collect::<Result<_>>()?;
    let commitments: [ShareCommitment; 5] = commitments
        .try_into()
        .map_err(|_| anyhow::anyhow!("five commitments"))?;
    let context = IdentityContext::new(IdentityRole::Recipient, "synthetic-demo-recipient")?;
    let restored = load_file(dir.join("recipient.identity.age"), pass, &context)?;
    let identity = Identity::from_str(std::str::from_utf8(restored.expose_secret_bytes())?)
        .map_err(|_| anyhow::anyhow!("invalid restored recipient"))?;
    let (_, recipient_raw) = bech32::decode(&identity.to_public().to_string())?;
    ensure!(
        hex::encode(recipient_raw) == verified.fields.recipient_pubkey_hex,
        "restored recipient is not the signed recipient"
    );
    let package_context = PackageContext {
        switch_id,
        epoch: 1,
        recipient_fingerprint: recipient_fingerprint(&identity.to_public().to_string())?,
    };
    let delivery_context = DeliveryContext {
        switch_id,
        epoch: 1,
        manifest_digest: bytes32(text(manifest, "manifestDigestHex")?)?,
        expected_recipient_fingerprint: package_context.recipient_fingerprint,
    };
    let delivery_values = read_json(deliveries_path)?;
    let mut shares = Vec::new();
    for v in delivery_values.as_array().context("delivery array")? {
        let envelope = RecipientShareEnvelope::from_bytes(&hex::decode(
            v.as_str().context("encrypted delivery hex")?,
        )?)?;
        shares.push(open_recipient_share(
            &envelope,
            &share_context,
            &commitments,
            delivery_context,
            &identity,
        )?);
    }
    let key = reconstruct_release_key(&shares, &share_context, &commitments)?;
    let package_path = dir.join("release.zcan");
    ensure!(
        fs::metadata(&package_path)?.len() == verified.fields.package_size,
        "encrypted package size mismatch"
    );
    let package = EncryptedPackage::from_bytes(&fs::read(package_path)?)?;
    let plaintext = decrypt_package(
        &package,
        &key,
        package_context,
        bytes32(text(manifest, "packageDigestHex")?)?,
        &identity,
    )?;
    ensure!(
        plaintext.as_slice() == synthetic_document(),
        "recovered synthetic file differs"
    );
    fs::write(dir.join("recovered-synthetic-dossier.pdf"), &plaintext)?;
    println!(
        "{}",
        json!({"decrypted":true,"bytes":plaintext.len(),"sha256":hex::encode(Sha256::digest(&plaintext)),"mode":"synthetic-chain"})
    );
    Ok(())
}
