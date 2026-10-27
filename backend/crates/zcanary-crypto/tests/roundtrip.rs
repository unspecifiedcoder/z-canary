use age::x25519::Identity;
use zcanary_crypto::{
    CryptoError, DeliveryContext, PackageContext, Share, ShareSetContext, create_vault,
    decrypt_package, open_keeper_share, open_recipient_share, package_recipient_share,
    public_package_digest, recipient_fingerprint, reconstruct_release_key,
};

fn fixtures() -> (
    Vec<u8>,
    Identity,
    [Identity; 5],
    PackageContext,
    ShareSetContext,
) {
    let recipient = Identity::generate();
    let keepers = std::array::from_fn(|_| Identity::generate());
    let ids = std::array::from_fn(|i| {
        recipient_fingerprint(&keepers[i].to_public().to_string()).unwrap()
    });
    let recipient_key = recipient.to_public().to_string();
    let context = PackageContext {
        switch_id: [7; 32],
        epoch: 9,
        recipient_fingerprint: recipient_fingerprint(&recipient_key).unwrap(),
    };
    let shares = ShareSetContext {
        switch_id: context.switch_id,
        epoch: context.epoch,
        keeper_ids: ids,
    };
    (
        vec![0, 255, 1, 2, 0, 128, 13],
        recipient,
        keepers,
        context,
        shares,
    )
}

fn create() -> (
    Vec<u8>,
    Identity,
    [Identity; 5],
    PackageContext,
    ShareSetContext,
    zcanary_crypto::CreatedVaultMaterial,
) {
    let (plain, recipient, keepers, context, shares) = fixtures();
    let keeper_recipients = std::array::from_fn(|i| keepers[i].to_public().to_string());
    let recipients = keeper_recipients.each_ref().map(String::as_str);
    let result = create_vault(
        &plain,
        &recipient.to_public().to_string(),
        context,
        shares,
        recipients,
    )
    .expect("in-memory fixture creation");
    (plain, recipient, keepers, context, shares, result)
}

fn shares_from_all(
    keepers: &[Identity; 5],
    context: &ShareSetContext,
    material: &zcanary_crypto::CreatedVaultMaterial,
) -> Vec<Share> {
    let all: [Share; 5] = std::array::from_fn(|i| {
        open_keeper_share(
            &material.keeper_envelopes[i],
            context,
            &material.commitments,
            &keepers[i],
        )
        .expect("share envelope opens to matching keeper")
    });
    all.into_iter().collect()
}

#[test]
fn binary_roundtrip_and_every_three_of_five_subset() {
    let (plain, recipient, keepers, package_context, share_context, material) = create();
    let encoded_package = material
        .package
        .to_bytes()
        .expect("versioned package encoding");
    let parsed_package = zcanary_crypto::EncryptedPackage::from_bytes(&encoded_package)
        .expect("versioned package decoding");
    assert!(parsed_package == material.package);
    let shares = shares_from_all(&keepers, &share_context, &material);

    for a in 0..3 {
        for b in a + 1..4 {
            for c in b + 1..5 {
                let subset = [&shares[a], &shares[b], &shares[c]];
                let selected = subset
                    .iter()
                    .map(|s| Share {
                        switch_id: s.switch_id,
                        epoch: s.epoch,
                        keeper_id: s.keeper_id,
                        index: s.index,
                        value: s.value.clone(),
                    })
                    .collect::<Vec<_>>();
                let key = reconstruct_release_key(&selected, &share_context, &material.commitments)
                    .expect("valid threshold subset");
                let opened = decrypt_package(
                    &material.package,
                    &key,
                    package_context,
                    material.package_digest,
                    &recipient,
                )
                .expect("recipient can decrypt after release key reconstruction");
                assert_eq!(opened.as_slice(), plain.as_slice());
            }
        }
    }
}

#[test]
fn two_shares_are_insufficient() {
    let (_, _, keepers, _, share_context, material) = create();
    let shares = shares_from_all(&keepers, &share_context, &material);
    assert!(matches!(
        reconstruct_release_key(&shares[..2], &share_context, &material.commitments),
        Err(CryptoError::InsufficientShares)
    ));
}

#[test]
fn duplicate_index_is_rejected() {
    let (_, _, keepers, _, share_context, material) = create();
    let shares = shares_from_all(&keepers, &share_context, &material);
    let duplicate = [&shares[0], &shares[1], &shares[1]]
        .iter()
        .map(|s| Share {
            switch_id: s.switch_id,
            epoch: s.epoch,
            keeper_id: s.keeper_id,
            index: s.index,
            value: s.value.clone(),
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        reconstruct_release_key(&duplicate, &share_context, &material.commitments),
        Err(CryptoError::InvalidShareSet)
    ));
}

#[test]
fn ciphertext_tampering_and_wrong_recipient_fail() {
    let (_, recipient, keepers, package_context, share_context, material) = create();
    let shares = shares_from_all(&keepers, &share_context, &material);
    let key = reconstruct_release_key(&shares[..3], &share_context, &material.commitments).unwrap();

    let mut tampered = material.package.clone();
    tampered.ciphertext[0] ^= 0x80;
    assert!(matches!(
        decrypt_package(
            &tampered,
            &key,
            package_context,
            material.package_digest,
            &recipient
        ),
        Err(CryptoError::PackageDigestMismatch)
    ));
    let tampered_digest = public_package_digest(&tampered, package_context);
    assert!(matches!(
        decrypt_package(
            &tampered,
            &key,
            package_context,
            tampered_digest,
            &recipient
        ),
        Err(CryptoError::AuthenticationFailed)
    ));

    let wrong = Identity::generate();
    assert!(
        decrypt_package(
            &material.package,
            &key,
            package_context,
            material.package_digest,
            &wrong
        )
        .is_err()
    );
}

#[test]
fn every_supplied_share_is_checked_including_extras() {
    let (_, _, keepers, _, share_context, material) = create();
    let mut shares = shares_from_all(&keepers, &share_context, &material);
    let mut corrupt = Share {
        switch_id: shares[4].switch_id,
        epoch: shares[4].epoch,
        keeper_id: shares[4].keeper_id,
        index: shares[4].index,
        value: shares[4].value.clone(),
    };
    corrupt.value[5] ^= 1;
    shares[4] = corrupt;
    assert!(matches!(
        reconstruct_release_key(&shares, &share_context, &material.commitments),
        Err(CryptoError::ShareCommitmentMismatch)
    ));

    let mut short = Share {
        switch_id: shares[4].switch_id,
        epoch: shares[4].epoch,
        keeper_id: shares[4].keeper_id,
        index: shares[4].index,
        value: vec![1, 2],
    };
    std::mem::swap(&mut shares[4], &mut short);
    assert!(matches!(
        reconstruct_release_key(&shares, &share_context, &material.commitments),
        Err(CryptoError::InvalidShare)
    ));
}

#[test]
fn context_metadata_is_authenticated() {
    let (_, recipient, keepers, package_context, share_context, material) = create();
    let shares = shares_from_all(&keepers, &share_context, &material);
    let key = reconstruct_release_key(&shares[..3], &share_context, &material.commitments).unwrap();
    let mut wrong_context = package_context;
    wrong_context.epoch += 1;
    assert!(matches!(
        decrypt_package(
            &material.package,
            &key,
            wrong_context,
            material.package_digest,
            &recipient
        ),
        Err(CryptoError::PackageDigestMismatch)
    ));
    let wrong_context_digest = public_package_digest(&material.package, wrong_context);
    assert!(matches!(
        decrypt_package(
            &material.package,
            &key,
            wrong_context,
            wrong_context_digest,
            &recipient
        ),
        Err(CryptoError::AuthenticationFailed)
    ));
}

#[test]
fn keeper_can_encrypt_delivery_share_to_recipient_after_manifest() {
    let (_, recipient, keepers, _, share_context, material) = create();
    let share = open_keeper_share(
        &material.keeper_envelopes[0],
        &share_context,
        &material.commitments,
        &keepers[0],
    )
    .unwrap();
    let delivery = DeliveryContext {
        switch_id: share_context.switch_id,
        epoch: share_context.epoch,
        manifest_digest: [55; 32],
        expected_recipient_fingerprint: recipient_fingerprint(&recipient.to_public().to_string())
            .unwrap(),
    };
    let envelope = package_recipient_share(
        &share,
        &share_context,
        &material.commitments,
        delivery,
        &recipient.to_public().to_string(),
    )
    .unwrap();
    let encoded_envelope = envelope.to_bytes().unwrap();
    let decoded_envelope =
        zcanary_crypto::RecipientShareEnvelope::from_bytes(&encoded_envelope).unwrap();
    assert!(decoded_envelope == envelope);
    let mut wrong_version = encoded_envelope.clone();
    wrong_version[4] = 1;
    assert!(matches!(
        zcanary_crypto::RecipientShareEnvelope::from_bytes(&wrong_version),
        Err(CryptoError::UnsupportedVersion)
    ));
    let delivered = open_recipient_share(
        &decoded_envelope,
        &share_context,
        &material.commitments,
        delivery,
        &recipient,
    )
    .unwrap();
    assert_eq!(delivered.index, share.index);
    assert_eq!(delivered.keeper_id, share.keeper_id);
    assert_eq!(delivered.value, share.value);

    let wrong_recipient = Identity::generate();
    assert!(
        open_recipient_share(
            &envelope,
            &share_context,
            &material.commitments,
            delivery,
            &wrong_recipient
        )
        .is_err()
    );
    assert!(matches!(
        package_recipient_share(
            &share,
            &share_context,
            &material.commitments,
            delivery,
            &wrong_recipient.to_public().to_string(),
        ),
        Err(CryptoError::InvalidRecipient)
    ));
    let wrong_manifest = DeliveryContext {
        manifest_digest: [56; 32],
        ..delivery
    };
    assert!(
        open_recipient_share(
            &envelope,
            &share_context,
            &material.commitments,
            wrong_manifest,
            &recipient
        )
        .is_err()
    );
}

#[test]
fn plaintext_limit_is_enforced_before_encryption() {
    let over_limit = vec![0u8; zcanary_crypto::MAX_PLAINTEXT_BYTES + 1];
    let context = PackageContext {
        switch_id: [1; 32],
        epoch: 1,
        recipient_fingerprint: [2; 32],
    };
    let shares = ShareSetContext {
        switch_id: context.switch_id,
        epoch: context.epoch,
        keeper_ids: std::array::from_fn(|i| [i as u8 + 1; 32]),
    };
    assert!(matches!(
        create_vault(&over_limit, "invalid", context, shares, ["invalid"; 5]),
        Err(CryptoError::TooLarge)
    ));
}
