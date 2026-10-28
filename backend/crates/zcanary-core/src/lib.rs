use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MEMO_LEN: usize = 512;
const BODY_LEN: usize = 448;
const SIG_START: usize = 448;
const MEMO_DOMAIN: &[u8] = b"ZCANARY-MEMO-SIG-V1";
const MANIFEST_PROTOCOL: &str = "Z-CANARY-V1";
const KEEPER_IDS: [&str; 5] = [
    "keeper-01",
    "keeper-02",
    "keeper-03",
    "keeper-04",
    "keeper-05",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Register,
    Postpone,
    Cancel,
}

impl Operation {
    fn byte(self) -> u8 {
        match self {
            Self::Register => 1,
            Self::Postpone => 2,
            Self::Cancel => 3,
        }
    }
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Register),
            2 => Some(Self::Postpone),
            3 => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub network: u8,
    pub operation: Operation,
    pub switch_id: [u8; 32],
    pub sequence: u64,
    pub requested_expiry_height: u32,
    pub manifest_digest: [u8; 32],
    pub source_pubkey: [u8; 32],
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CoreError {
    #[error("memo must be exactly 512 bytes")]
    MemoLength,
    #[error("invalid memo prefix or magic")]
    MemoHeader,
    #[error("unsupported memo version")]
    MemoVersion,
    #[error("unsupported network")]
    UnsupportedNetwork,
    #[error("memo network does not match expected network")]
    WrongNetwork,
    #[error("unknown operation")]
    UnknownOperation,
    #[error("invalid command sequence or cancellation expiry")]
    CommandFields,
    #[error("memo padding is nonzero")]
    NonzeroPadding,
    #[error("invalid Ed25519 key or signature")]
    Signature,
    #[error("source seed does not match command public key")]
    SignerMismatch,
    #[error("manifest policy is invalid")]
    ManifestPolicy,
    #[error("manifest signature or digest is invalid")]
    ManifestVerification,
}

fn validate_command(command: &Command) -> Result<(), CoreError> {
    if command.network > 1 {
        return Err(CoreError::UnsupportedNetwork);
    }
    match command.operation {
        Operation::Register if command.sequence != 0 => Err(CoreError::CommandFields),
        Operation::Postpone if command.sequence == 0 => Err(CoreError::CommandFields),
        Operation::Cancel if command.sequence == 0 || command.requested_expiry_height != 0 => {
            Err(CoreError::CommandFields)
        }
        _ => Ok(()),
    }
}

pub fn decode_and_verify_memo(bytes: &[u8], expected_network: u8) -> Result<Command, CoreError> {
    if bytes.len() != MEMO_LEN {
        return Err(CoreError::MemoLength);
    }
    if expected_network > 1 {
        return Err(CoreError::UnsupportedNetwork);
    }
    if bytes[0] != 0xff || &bytes[1..5] != b"ZCAN" {
        return Err(CoreError::MemoHeader);
    }
    if bytes[5] != 1 {
        return Err(CoreError::MemoVersion);
    }
    if bytes[6] > 1 {
        return Err(CoreError::UnsupportedNetwork);
    }
    if bytes[6] != expected_network {
        return Err(CoreError::WrongNetwork);
    }
    let operation = Operation::from_byte(bytes[7]).ok_or(CoreError::UnknownOperation)?;
    if bytes[116..BODY_LEN].iter().any(|&b| b != 0) {
        return Err(CoreError::NonzeroPadding);
    }

    let command = Command {
        network: bytes[6],
        operation,
        switch_id: bytes[8..40].try_into().expect("fixed memo range"),
        sequence: u64::from_le_bytes(bytes[40..48].try_into().expect("fixed memo range")),
        requested_expiry_height: u32::from_le_bytes(
            bytes[48..52].try_into().expect("fixed memo range"),
        ),
        manifest_digest: bytes[52..84].try_into().expect("fixed memo range"),
        source_pubkey: bytes[84..116].try_into().expect("fixed memo range"),
    };
    validate_command(&command)?;

    let verifying_key =
        VerifyingKey::from_bytes(&command.source_pubkey).map_err(|_| CoreError::Signature)?;
    let signature = Signature::from_slice(&bytes[SIG_START..]).map_err(|_| CoreError::Signature)?;
    let mut message = Vec::with_capacity(MEMO_DOMAIN.len() + BODY_LEN);
    message.extend_from_slice(MEMO_DOMAIN);
    message.extend_from_slice(&bytes[..BODY_LEN]);
    verifying_key
        .verify_strict(&message, &signature)
        .map_err(|_| CoreError::Signature)?;
    Ok(command)
}

pub fn encode_memo(command: &Command, source_seed: &[u8; 32]) -> Result<[u8; 512], CoreError> {
    validate_command(command)?;
    let signing_key = SigningKey::from_bytes(source_seed);
    if signing_key.verifying_key().to_bytes() != command.source_pubkey {
        return Err(CoreError::SignerMismatch);
    }
    let mut bytes = [0u8; MEMO_LEN];
    bytes[0] = 0xff;
    bytes[1..5].copy_from_slice(b"ZCAN");
    bytes[5] = 1;
    bytes[6] = command.network;
    bytes[7] = command.operation.byte();
    bytes[8..40].copy_from_slice(&command.switch_id);
    bytes[40..48].copy_from_slice(&command.sequence.to_le_bytes());
    bytes[48..52].copy_from_slice(&command.requested_expiry_height.to_le_bytes());
    bytes[52..84].copy_from_slice(&command.manifest_digest);
    bytes[84..116].copy_from_slice(&command.source_pubkey);
    let mut message = Vec::with_capacity(MEMO_DOMAIN.len() + BODY_LEN);
    message.extend_from_slice(MEMO_DOMAIN);
    message.extend_from_slice(&bytes[..BODY_LEN]);
    bytes[SIG_START..].copy_from_slice(&signing_key.sign(&message).to_bytes());
    Ok(bytes)
}

/// Hex-string manifest inputs mirror the TypeScript application's wire model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestFields {
    pub network: u8,
    pub switch_id_hex: String,
    pub source_pubkey_hex: String,
    pub recipient_pubkey_hex: String,
    pub package_digest_hex: String,
    pub package_size: u64,
    pub initial_interval_blocks: u32,
    pub grace_blocks: u32,
    pub confirmation_target: u32,
    pub max_extension_blocks: u32,
    pub threshold: u8,
    pub configuration_epoch: u32,
    /// Commitments in keeper index order 1 through 5.
    pub share_commitments: [String; 5],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImmutableManifest {
    pub fields: ManifestFields,
    pub protocol_id: String,
    pub recipient_fingerprint: String,
    pub keeper_ids: [String; 5],
    pub source_signature_hex: String,
    pub manifest_digest_hex: String,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .chunks_exact(2)
            .all(|pair| pair.iter().all(u8::is_ascii_hexdigit))
}

fn normalize_hash(value: &str) -> Result<String, CoreError> {
    if !valid_hash(value) {
        return Err(CoreError::ManifestPolicy);
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_manifest_fields(f: &ManifestFields) -> Result<[String; 5], CoreError> {
    if f.network > 1
        || f.package_size < 32
        || f.package_size > 10 * 1024 * 1024 + 65_536
        || f.initial_interval_blocks == 0
        || f.confirmation_target == 0
        || f.max_extension_blocks == 0
        || f.configuration_epoch == 0
        || f.threshold != 3
    {
        return Err(CoreError::ManifestPolicy);
    }
    normalize_hash(&f.switch_id_hex)?;
    normalize_hash(&f.source_pubkey_hex)?;
    normalize_hash(&f.recipient_pubkey_hex)?;
    normalize_hash(&f.package_digest_hex)?;
    let commitments: [String; 5] = f
        .share_commitments
        .iter()
        .map(|s| normalize_hash(s))
        .collect::<Result<Vec<_>, _>>()?
        .try_into()
        .map_err(|_| CoreError::ManifestPolicy)?;
    Ok(commitments)
}

/// Return the byte-for-byte ordered JSON representation signed by TypeScript.
pub fn canonical_manifest_bytes(fields: &ManifestFields) -> Result<Vec<u8>, CoreError> {
    let commitments = validate_manifest_fields(fields)?;
    let switch_id = normalize_hash(&fields.switch_id_hex)?;
    let source = normalize_hash(&fields.source_pubkey_hex)?;
    let recipient = normalize_hash(&fields.recipient_pubkey_hex)?;
    let package_digest = normalize_hash(&fields.package_digest_hex)?;
    let canonical = format!(
        "{{\"protocolId\":\"Z-CANARY-V1\",\"network\":{},\"switchIdHex\":\"{}\",\"sourcePubKeyHex\":\"{}\",\"recipientPubKeyHex\":\"{}\",\"packageDigestHex\":\"{}\",\"packageSize\":{},\"initialIntervalBlocks\":{},\"graceBlocks\":{},\"confirmationTarget\":{},\"maxExtensionBlocks\":{},\"keeperIds\":[\"keeper-01\",\"keeper-02\",\"keeper-03\",\"keeper-04\",\"keeper-05\"],\"threshold\":{},\"configurationEpoch\":{},\"shareCommitments\":[\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"]}}",
        fields.network,
        switch_id,
        source,
        recipient,
        package_digest,
        fields.package_size,
        fields.initial_interval_blocks,
        fields.grace_blocks,
        fields.confirmation_target,
        fields.max_extension_blocks,
        fields.threshold,
        fields.configuration_epoch,
        commitments[0],
        commitments[1],
        commitments[2],
        commitments[3],
        commitments[4],
    );
    Ok(canonical.into_bytes())
}

pub fn manifest_digest(fields: &ManifestFields) -> Result<[u8; 32], CoreError> {
    Ok(Sha256::digest(canonical_manifest_bytes(fields)?).into())
}

pub fn sign_manifest(
    fields: ManifestFields,
    source_seed: &[u8; 32],
) -> Result<ImmutableManifest, CoreError> {
    let source_pubkey = hex::decode(normalize_hash(&fields.source_pubkey_hex)?)
        .map_err(|_| CoreError::ManifestPolicy)?;
    let signing_key = SigningKey::from_bytes(source_seed);
    if signing_key.verifying_key().to_bytes().as_slice() != source_pubkey {
        return Err(CoreError::SignerMismatch);
    }
    let bytes = canonical_manifest_bytes(&fields)?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let signature = signing_key.sign(&bytes);
    let recipient = hex::decode(normalize_hash(&fields.recipient_pubkey_hex)?)
        .map_err(|_| CoreError::ManifestPolicy)?;
    let fp_digest = Sha256::digest(recipient);
    let fingerprint = fp_digest[..16]
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");
    Ok(ImmutableManifest {
        fields,
        protocol_id: MANIFEST_PROTOCOL.to_owned(),
        recipient_fingerprint: fingerprint,
        keeper_ids: KEEPER_IDS.map(str::to_owned),
        source_signature_hex: hex::encode(signature.to_bytes()),
        manifest_digest_hex: hex::encode(digest),
    })
}

pub fn verify_manifest(manifest: &ImmutableManifest) -> bool {
    let Ok(bytes) = canonical_manifest_bytes(&manifest.fields) else {
        return false;
    };
    if manifest.protocol_id != MANIFEST_PROTOCOL
        || manifest
            .keeper_ids
            .iter()
            .map(String::as_str)
            .ne(KEEPER_IDS)
    {
        return false;
    }
    let Ok(expected_digest) = normalize_hash(&manifest.manifest_digest_hex) else {
        return false;
    };
    if hex::encode(Sha256::digest(&bytes)) != expected_digest {
        return false;
    }
    let Ok(expected_fp) = (|| {
        let raw = hex::decode(normalize_hash(&manifest.fields.recipient_pubkey_hex)?)
            .map_err(|_| CoreError::ManifestPolicy)?;
        let hash = Sha256::digest(raw);
        Ok::<String, CoreError>(
            hash[..16]
                .iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(":"),
        )
    })() else {
        return false;
    };
    if manifest.recipient_fingerprint != expected_fp {
        return false;
    }
    let (Ok(pk), Ok(sig)) = (
        hex::decode(normalize_hash(&manifest.fields.source_pubkey_hex).unwrap_or_default()),
        hex::decode(&manifest.source_signature_hex),
    ) else {
        return false;
    };
    let (Ok(pk), Ok(sig)) = (
        <[u8; 32]>::try_from(pk.as_slice()),
        Signature::from_slice(&sig),
    ) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    verifying_key.verify_strict(&bytes, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn seed() -> [u8; 32] {
        std::array::from_fn(|i| (i as u8).wrapping_mul(29).wrapping_add(7))
    }
    fn command(seed: &[u8; 32]) -> Command {
        Command {
            network: 1,
            operation: Operation::Postpone,
            switch_id: [0x11; 32],
            sequence: u64::MAX,
            requested_expiry_height: u32::MAX,
            manifest_digest: [0x22; 32],
            source_pubkey: SigningKey::from_bytes(seed).verifying_key().to_bytes(),
        }
    }

    #[test]
    fn memo_roundtrip_preserves_u64_max_and_exact_little_endian_bytes() {
        let seed = seed();
        let cmd = command(&seed);
        let bytes = encode_memo(&cmd, &seed).unwrap();
        assert_eq!(bytes.len(), 512);
        assert_eq!(&bytes[40..48], &[0xff; 8]);
        assert_eq!(&bytes[48..52], &[0xff; 4]);
        assert_eq!(&bytes[116..448], &[0; 332]);
        assert_eq!(decode_and_verify_memo(&bytes, 1).unwrap(), cmd);
    }

    #[test]
    fn memo_rejects_bad_framing_network_padding_fields_signature_and_signer() {
        let seed = seed();
        let cmd = command(&seed);
        let valid = encode_memo(&cmd, &seed).unwrap();
        assert_eq!(
            decode_and_verify_memo(&valid[..511], 1),
            Err(CoreError::MemoLength)
        );
        for (at, expected) in [
            (0, CoreError::MemoHeader),
            (5, CoreError::MemoVersion),
            (116, CoreError::NonzeroPadding),
        ] {
            let mut bad = valid;
            bad[at] ^= 1;
            assert_eq!(decode_and_verify_memo(&bad, 1), Err(expected));
        }
        let mut bad_operation = valid;
        bad_operation[7] = 0xff;
        assert_eq!(
            decode_and_verify_memo(&bad_operation, 1),
            Err(CoreError::UnknownOperation)
        );
        assert_eq!(
            decode_and_verify_memo(&valid, 0),
            Err(CoreError::WrongNetwork)
        );
        let mut bad = valid;
        bad[6] = 2;
        assert_eq!(
            decode_and_verify_memo(&bad, 1),
            Err(CoreError::UnsupportedNetwork)
        );
        let mut bad = valid;
        bad[448] ^= 1;
        assert_eq!(decode_and_verify_memo(&bad, 1), Err(CoreError::Signature));
        let mut other_seed = seed;
        other_seed[0] ^= 1;
        assert_eq!(
            encode_memo(&cmd, &other_seed),
            Err(CoreError::SignerMismatch)
        );
    }

    fn fields(seed: &[u8; 32]) -> ManifestFields {
        ManifestFields {
            network: 1,
            switch_id_hex: "11".repeat(32),
            source_pubkey_hex: hex::encode(SigningKey::from_bytes(seed).verifying_key().to_bytes()),
            recipient_pubkey_hex: "22".repeat(32),
            package_digest_hex: "33".repeat(32),
            package_size: 32,
            initial_interval_blocks: 100,
            grace_blocks: 0,
            confirmation_target: 2,
            max_extension_blocks: 100,
            threshold: 3,
            configuration_epoch: 1,
            share_commitments: std::array::from_fn(|i| format!("{:02x}", i + 1).repeat(32)),
        }
    }

    #[test]
    fn manifest_is_ordered_signed_digest_bound_and_tamper_evident() {
        let seed = seed();
        let f = fields(&seed);
        let bytes = canonical_manifest_bytes(&f).unwrap();
        assert!(
            std::str::from_utf8(&bytes)
                .unwrap()
                .starts_with("{\"protocolId\":\"Z-CANARY-V1\",\"network\":1,\"switchIdHex\":")
        );
        let manifest = sign_manifest(f, &seed).unwrap();
        assert!(verify_manifest(&manifest));
        let mut bad = manifest.clone();
        bad.fields.grace_blocks = 1;
        assert!(!verify_manifest(&bad));
        let mut bad = manifest.clone();
        bad.recipient_fingerprint.push('0');
        assert!(!verify_manifest(&bad));
        let mut bad = manifest.clone();
        bad.source_signature_hex.replace_range(..2, "00");
        assert!(!verify_manifest(&bad));
    }

    #[test]
    fn manifest_policy_and_signer_mismatch_are_rejected() {
        let seed = seed();
        let mut f = fields(&seed);
        f.threshold = 2;
        assert_eq!(canonical_manifest_bytes(&f), Err(CoreError::ManifestPolicy));
        let mut f = fields(&seed);
        f.package_size = 10 * 1024 * 1024 + 65_537;
        assert_eq!(canonical_manifest_bytes(&f), Err(CoreError::ManifestPolicy));
        let mut f = fields(&seed);
        f.share_commitments[4] = "xx".repeat(32);
        assert_eq!(canonical_manifest_bytes(&f), Err(CoreError::ManifestPolicy));
        let mut f = fields(&seed);
        f.source_pubkey_hex = "44".repeat(32);
        assert_eq!(sign_manifest(f, &seed), Err(CoreError::SignerMismatch));
    }

    #[test]
    fn typescript_public_fixture_interoperates_byte_for_byte() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/typescript-v1.json")).unwrap();
        let m = &fixture["manifest"];
        let commitments: [String; 5] = std::array::from_fn(|i| {
            m["shareCommitments"]
                .get(&(i + 1).to_string())
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        });
        let fields = ManifestFields {
            network: m["network"].as_u64().unwrap() as u8,
            switch_id_hex: m["switchIdHex"].as_str().unwrap().to_owned(),
            source_pubkey_hex: m["sourcePubKeyHex"].as_str().unwrap().to_owned(),
            recipient_pubkey_hex: m["recipientPubKeyHex"].as_str().unwrap().to_owned(),
            package_digest_hex: m["packageDigestHex"].as_str().unwrap().to_owned(),
            package_size: m["packageSize"].as_u64().unwrap(),
            initial_interval_blocks: m["initialIntervalBlocks"].as_u64().unwrap() as u32,
            grace_blocks: m["graceBlocks"].as_u64().unwrap() as u32,
            confirmation_target: m["confirmationTarget"].as_u64().unwrap() as u32,
            max_extension_blocks: m["maxExtensionBlocks"].as_u64().unwrap() as u32,
            threshold: m["threshold"].as_u64().unwrap() as u8,
            configuration_epoch: m["configurationEpoch"].as_u64().unwrap() as u32,
            share_commitments: commitments,
        };
        let canonical = canonical_manifest_bytes(&fields).unwrap();
        assert_eq!(
            hex::encode(&canonical),
            fixture["canonicalManifestHex"].as_str().unwrap()
        );
        let fixture_manifest = ImmutableManifest {
            fields: fields.clone(),
            protocol_id: m["protocolId"].as_str().unwrap().to_owned(),
            recipient_fingerprint: m["recipientFingerprint"].as_str().unwrap().to_owned(),
            keeper_ids: std::array::from_fn(|i| m["keeperIds"][i].as_str().unwrap().to_owned()),
            source_signature_hex: m["sourceSignatureHex"].as_str().unwrap().to_owned(),
            manifest_digest_hex: m["manifestDigestHex"].as_str().unwrap().to_owned(),
        };
        assert_eq!(
            hex::encode(manifest_digest(&fields).unwrap()),
            fixture_manifest.manifest_digest_hex
        );
        assert!(verify_manifest(&fixture_manifest));

        for entry in fixture["commands"].as_array().unwrap() {
            let c = &entry["command"];
            let parse32 = |s: &str| -> [u8; 32] { hex::decode(s).unwrap().try_into().unwrap() };
            let operation = match c["operation"].as_u64().unwrap() {
                1 => Operation::Register,
                2 => Operation::Postpone,
                3 => Operation::Cancel,
                _ => panic!("fixture operation"),
            };
            let expected = Command {
                network: c["network"].as_u64().unwrap() as u8,
                operation,
                switch_id: parse32(c["switchIdHex"].as_str().unwrap()),
                sequence: c["sequence"].as_str().unwrap().parse().unwrap(),
                requested_expiry_height: c["requestedExpiryHeight"].as_u64().unwrap() as u32,
                manifest_digest: parse32(c["manifestDigestHex"].as_str().unwrap()),
                source_pubkey: parse32(c["sourcePubKeyHex"].as_str().unwrap()),
            };
            let bytes = hex::decode(entry["memoHex"].as_str().unwrap()).unwrap();
            assert_eq!(
                decode_and_verify_memo(&bytes, 1).unwrap(),
                expected,
                "{}",
                entry["name"]
            );
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_048))]

        #[test]
        fn arbitrary_memo_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..=768), network in any::<u8>()) {
            let result = std::panic::catch_unwind(|| decode_and_verify_memo(&bytes, network));
            prop_assert!(result.is_ok());
        }

        #[test]
        fn sampled_single_bit_mutations_of_a_signed_memo_are_rejected(bit in 0usize..4096) {
            let seed = seed();
            let command = command(&seed);
            let mut encoded = encode_memo(&command, &seed).unwrap();
            encoded[bit / 8] ^= 1 << (bit % 8);
            prop_assert!(decode_and_verify_memo(&encoded, 1).is_err());
        }

        #[test]
        fn valid_postpone_sequences_roundtrip(sequence in 1u64..=u64::MAX, expiry in any::<u32>()) {
            let seed = seed();
            let mut command = command(&seed);
            command.sequence = sequence;
            command.requested_expiry_height = expiry;
            let encoded = encode_memo(&command, &seed).unwrap();
            prop_assert_eq!(decode_and_verify_memo(&encoded, 1).unwrap(), command);
        }
    }
}
