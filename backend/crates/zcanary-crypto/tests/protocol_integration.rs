use age::x25519::Identity;
use ed25519_dalek::SigningKey;
use rand::{RngExt, make_rng, rngs::StdRng};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use zcanary_core::{
    Command, ManifestFields, Operation, encode_memo, sign_manifest, verify_manifest,
};
use zcanary_crypto::{
    DeliveryContext, PackageContext, Share, ShareSetContext, create_vault, decrypt_package,
    open_keeper_share, open_recipient_share, package_recipient_share, recipient_fingerprint,
    reconstruct_release_key,
};
use zcanary_keeper::{
    ConfirmedBatch, Keeper, Lifecycle, Policy, ProvisioningRecord, ScannedBlock, ScannedOutput,
    ScannedTransaction,
};

const SWITCH_ID: [u8; 32] = [0x42; 32];
const EPOCH: u32 = 17;
const SEED: [u8; 32] = [0x5a; 32];

struct TempKeeperDbDir(PathBuf);

impl TempKeeperDbDir {
    fn new() -> Self {
        for _ in 0..16 {
            let mut random = [0u8; 16];
            let mut rng: StdRng = make_rng();
            rng.fill(&mut random);
            let candidate = std::env::temp_dir().join(format!(
                "zcanary-protocol-{}-{}",
                std::process::id(),
                hex::encode(random)
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => {
                    return Self(fs::canonicalize(candidate).expect("canonical temp directory"));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create temp keeper DB directory: {error}"),
            }
        }
        panic!("could not allocate a unique temp keeper DB directory")
    }
}

impl Drop for TempKeeperDbDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn keeper_names() -> [String; 5] {
    std::array::from_fn(|i| format!("keeper-{:02}", i + 1))
}

fn age_public_bytes(recipient: &str) -> [u8; 32] {
    let (hrp, data) = bech32::decode(recipient).expect("age recipient bech32");
    assert_eq!(hrp.to_string(), "age");
    data.try_into().expect("age X25519 public key is 32 bytes")
}

fn bytes_from_hex(value: &str) -> [u8; 32] {
    hex::decode(value)
        .expect("hex value")
        .try_into()
        .expect("32-byte value")
}

fn manifest_recipient_fingerprint(raw_public_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(raw_public_key);
    digest[..16]
        .iter()
        .map(|byte| format!("{:02X}", byte))
        .collect::<Vec<_>>()
        .join(":")
}

fn chain_block(height: u32, previous_hash: [u8; 32], memo: Option<Vec<u8>>) -> ScannedBlock {
    let hash = [(height as u8).wrapping_add(1); 32];
    let transactions = memo
        .map(|memo| {
            vec![ScannedTransaction {
                txid: [(height as u8).wrapping_add(99); 32],
                tx_index: 0,
                outputs: vec![ScannedOutput {
                    tx_index: 0,
                    output_index: 0,
                    memo,
                }],
            }]
        })
        .unwrap_or_default();
    ScannedBlock {
        height,
        hash,
        previous_hash,
        transactions,
    }
}

fn contiguous_blocks(
    start: u32,
    end: u32,
    previous_hash: [u8; 32],
    memo_at: Option<(u32, Vec<u8>)>,
) -> Vec<ScannedBlock> {
    let mut previous = previous_hash;
    (start..=end)
        .map(|height| {
            let memo = memo_at
                .as_ref()
                .filter(|(memo_height, _)| *memo_height == height)
                .map(|(_, memo)| memo.clone());
            let block = chain_block(height, previous, memo);
            previous = block.hash;
            block
        })
        .collect()
}

fn process_all(keepers: &[Keeper], batch: ConfirmedBatch) -> Vec<zcanary_keeper::Cursor> {
    keepers
        .iter()
        .map(|keeper| keeper.process_confirmed_batch(batch.clone()).unwrap())
        .collect()
}

fn setup_vault(
    plaintext: &[u8],
) -> (
    Identity,
    [Identity; 5],
    PackageContext,
    ShareSetContext,
    zcanary_crypto::CreatedVaultMaterial,
    zcanary_core::ImmutableManifest,
    [u8; 32],
    [u8; 32],
    [String; 5],
) {
    let recipient = Identity::generate();
    let recipient_string = recipient.to_public().to_string();
    let recipient_bytes = age_public_bytes(&recipient_string);
    let recipient_fp = recipient_fingerprint(&recipient_string).unwrap();
    let sha_of_raw_public_key: [u8; 32] = Sha256::digest(recipient_bytes).into();
    assert_eq!(recipient_fp, sha_of_raw_public_key);
    let keeper_identities = std::array::from_fn(|_| Identity::generate());
    let keeper_recipients: [String; 5] =
        std::array::from_fn(|i| keeper_identities[i].to_public().to_string());
    let keeper_fingerprints = std::array::from_fn(|i| {
        recipient_fingerprint(&keeper_recipients[i]).expect("valid keeper age recipient")
    });
    let context = PackageContext {
        switch_id: SWITCH_ID,
        epoch: EPOCH,
        recipient_fingerprint: recipient_fp,
    };
    let share_context = ShareSetContext {
        switch_id: SWITCH_ID,
        epoch: EPOCH,
        keeper_ids: keeper_fingerprints,
    };
    let keeper_recipient_refs = keeper_recipients.each_ref().map(String::as_str);
    let material = create_vault(
        plaintext,
        &recipient_string,
        context,
        share_context,
        keeper_recipient_refs,
    )
    .expect("encrypt package and provision shares");

    let source_pubkey = SigningKey::from_bytes(&SEED).verifying_key().to_bytes();
    let commitments = std::array::from_fn(|i| hex::encode(material.commitments[i].digest));
    let package_size = material.package.to_bytes().unwrap().len() as u64;
    let fields = ManifestFields {
        network: 1,
        switch_id_hex: hex::encode(SWITCH_ID),
        source_pubkey_hex: hex::encode(source_pubkey),
        recipient_pubkey_hex: hex::encode(recipient_bytes),
        package_digest_hex: hex::encode(material.package_digest),
        package_size,
        initial_interval_blocks: 10,
        grace_blocks: 3,
        confirmation_target: 2,
        max_extension_blocks: 100,
        threshold: 3,
        configuration_epoch: EPOCH,
        share_commitments: commitments,
    };
    let manifest = sign_manifest(fields, &SEED).expect("sign canonical manifest");
    assert!(verify_manifest(&manifest));
    assert_eq!(
        manifest.recipient_fingerprint,
        manifest_recipient_fingerprint(&recipient_bytes),
        "core hashes the raw X25519 bytes, matching crypto's Bech32 decoding"
    );
    let manifest_digest = bytes_from_hex(&manifest.manifest_digest_hex);
    (
        recipient,
        keeper_identities,
        context,
        share_context,
        material,
        manifest,
        manifest_digest,
        source_pubkey,
        keeper_names(),
    )
}

fn register_memo(manifest: &zcanary_core::ImmutableManifest, source_pubkey: [u8; 32]) -> Vec<u8> {
    encode_memo(
        &Command {
            network: 1,
            operation: Operation::Register,
            switch_id: SWITCH_ID,
            sequence: 0,
            requested_expiry_height: 11,
            manifest_digest: bytes_from_hex(&manifest.manifest_digest_hex),
            source_pubkey,
        },
        &SEED,
    )
    .unwrap()
    .to_vec()
}

fn provisioned_keepers(
    db_dir: &TempKeeperDbDir,
    keeper_identities: &[Identity; 5],
    names: &[String; 5],
    share_context: &ShareSetContext,
    material: &zcanary_crypto::CreatedVaultMaterial,
    delivery: DeliveryContext,
    recipient: &Identity,
    manifest_digest: [u8; 32],
    source_pubkey: [u8; 32],
) -> (Vec<Keeper>, [Vec<u8>; 5]) {
    let recipient_string = recipient.to_public().to_string();
    let envelopes: [zcanary_crypto::RecipientShareEnvelope; 5] = std::array::from_fn(|i| {
        let share = open_keeper_share(
            &material.keeper_envelopes[i],
            share_context,
            &material.commitments,
            &keeper_identities[i],
        )
        .expect("only its keeper can open its provisioning envelope");
        package_recipient_share(
            &share,
            share_context,
            &material.commitments,
            delivery,
            &recipient_string,
        )
        .expect("manifest-bound recipient delivery envelope")
    });
    let encoded_envelopes: [Vec<u8>; 5] = std::array::from_fn(|i| {
        envelopes[i]
            .to_bytes()
            .expect("versioned delivery envelope")
    });
    let keeper_array: [Keeper; 5] = std::array::from_fn(|i| {
        let path = db_dir.0.join(format!("keeper-{}.sqlite", i + 1));
        let keeper = Keeper::open(path, 1, names[i].clone()).unwrap();
        keeper
            .provision(ProvisioningRecord {
                switch_id: SWITCH_ID,
                manifest_digest,
                source_pubkey,
                epoch: EPOCH,
                keeper_index: (i + 1) as u8,
                policy: Policy {
                    initial_interval: 10,
                    max_extension: 100,
                    confirmation_count: 2,
                    grace_period: 3,
                },
                encrypted_share_envelope: encoded_envelopes[i].clone(),
            })
            .expect("store opaque recipient-encrypted share");
        keeper
    });
    let keepers = keeper_array.into_iter().collect();
    (keepers, encoded_envelopes)
}

#[test]
fn signed_register_to_five_keepers_grace_release_and_three_share_decryption() {
    let plaintext = b"\0Z-CANARY\xff test document\0";
    let (
        recipient,
        keeper_identities,
        package_context,
        share_context,
        material,
        manifest,
        manifest_digest,
        source_pubkey,
        names,
    ) = setup_vault(plaintext);
    let db_dir = TempKeeperDbDir::new();
    let delivery = DeliveryContext {
        switch_id: SWITCH_ID,
        epoch: EPOCH,
        manifest_digest,
        expected_recipient_fingerprint: package_context.recipient_fingerprint,
    };
    let (keepers, provisioned_envelopes) = provisioned_keepers(
        &db_dir,
        &keeper_identities,
        &names,
        &share_context,
        &material,
        delivery,
        &recipient,
        manifest_digest,
        source_pubkey,
    );

    let initial = process_all(
        &keepers,
        ConfirmedBatch {
            blocks: contiguous_blocks(0, 0, [0; 32], None),
            confirmed_through: 0,
            observed_tip_height: 1,
        },
    );
    for (keeper, cursor) in keepers.iter().zip(initial) {
        assert_eq!(keeper.lifecycle(SWITCH_ID).unwrap(), Lifecycle::Draft);
        assert!(keeper.claim_delivery(cursor).unwrap().is_none());
    }

    let memo = register_memo(&manifest, source_pubkey);
    let before_boundary = process_all(
        &keepers,
        ConfirmedBatch {
            blocks: contiguous_blocks(1, 13, [1; 32], Some((1, memo))),
            confirmed_through: 13,
            observed_tip_height: 14,
        },
    );
    for (keeper, cursor) in keepers.iter().zip(before_boundary) {
        assert_eq!(keeper.lifecycle(SWITCH_ID).unwrap(), Lifecycle::Grace);
        assert!(keeper.claim_delivery(cursor).unwrap().is_none());
    }

    drop(keepers);
    let keeper_array: [Keeper; 5] = std::array::from_fn(|i| {
        Keeper::open_existing(
            db_dir.0.join(format!("keeper-{}.sqlite", i + 1)),
            1,
            names[i].clone(),
        )
        .unwrap()
    });
    let keepers: Vec<Keeper> = keeper_array.into_iter().collect();
    for keeper in &keepers {
        assert!(!keeper.is_healthy().unwrap());
        assert!(matches!(
            keeper.claim_delivery(zcanary_keeper::Cursor {
                height: 13,
                hash: [14; 32],
            }),
            Err(zcanary_keeper::KeeperError::Suspended)
        ));
    }

    let released = process_all(
        &keepers,
        ConfirmedBatch {
            blocks: contiguous_blocks(14, 14, [14; 32], None),
            confirmed_through: 14,
            observed_tip_height: 15,
        },
    );
    let recipient_shares: Vec<Share> = keepers
        .iter()
        .zip(released)
        .enumerate()
        .map(|(index, (keeper, cursor))| {
            assert_eq!(keeper.lifecycle(SWITCH_ID).unwrap(), Lifecycle::Released);
            let delivery_record = keeper.claim_delivery(cursor).unwrap().unwrap();
            assert_eq!(delivery_record.manifest_digest, manifest_digest);
            assert_eq!(
                delivery_record.encrypted_share_envelope,
                provisioned_envelopes[index]
            );
            let envelope = zcanary_crypto::RecipientShareEnvelope::from_bytes(
                &delivery_record.encrypted_share_envelope,
            )
            .unwrap();
            open_recipient_share(
                &envelope,
                &share_context,
                &material.commitments,
                delivery,
                &recipient,
            )
            .unwrap()
        })
        .collect();

    let key = reconstruct_release_key(
        &recipient_shares[..3],
        &share_context,
        &material.commitments,
    )
    .unwrap();
    let opened = decrypt_package(
        &material.package,
        &key,
        package_context,
        material.package_digest,
        &recipient,
    )
    .unwrap();
    assert_eq!(opened.as_slice(), plaintext);
}

#[test]
fn signed_cancel_in_last_grace_block_prevents_all_five_keeper_releases() {
    let plaintext = b"cancelled release";
    let (
        recipient,
        keeper_identities,
        _package_context,
        share_context,
        material,
        manifest,
        manifest_digest,
        source_pubkey,
        names,
    ) = setup_vault(plaintext);
    let db_dir = TempKeeperDbDir::new();
    let delivery = DeliveryContext {
        switch_id: SWITCH_ID,
        epoch: EPOCH,
        manifest_digest,
        expected_recipient_fingerprint: recipient_fingerprint(&recipient.to_public().to_string())
            .unwrap(),
    };
    let (keepers, _) = provisioned_keepers(
        &db_dir,
        &keeper_identities,
        &names,
        &share_context,
        &material,
        delivery,
        &recipient,
        manifest_digest,
        source_pubkey,
    );
    process_all(
        &keepers,
        ConfirmedBatch {
            blocks: contiguous_blocks(0, 0, [0; 32], None),
            confirmed_through: 0,
            observed_tip_height: 1,
        },
    );
    let register = register_memo(&manifest, source_pubkey);
    let mut through_boundary = contiguous_blocks(1, 14, [1; 32], Some((1, register)));
    let cancel = encode_memo(
        &Command {
            network: 1,
            operation: Operation::Cancel,
            switch_id: SWITCH_ID,
            sequence: 1,
            requested_expiry_height: 0,
            manifest_digest,
            source_pubkey,
        },
        &SEED,
    )
    .unwrap()
    .to_vec();
    through_boundary[13] = chain_block(14, [14; 32], Some(cancel));
    let cursors = process_all(
        &keepers,
        ConfirmedBatch {
            blocks: through_boundary,
            confirmed_through: 14,
            observed_tip_height: 15,
        },
    );
    for (keeper, cursor) in keepers.iter().zip(cursors) {
        assert_eq!(keeper.lifecycle(SWITCH_ID).unwrap(), Lifecycle::Cancelled);
        assert!(keeper.claim_delivery(cursor).unwrap().is_none());
    }
}
