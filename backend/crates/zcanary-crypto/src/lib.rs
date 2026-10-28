//! Versioned encryption, share provisioning, and recipient delivery primitives.
//!
//! This crate deliberately exposes byte-oriented independent types. Callers must
//! keep `ReleaseKey`, `Share`, and decrypted plaintext in trusted process memory.
//! Create the package and commitments first, then place their digests in and sign
//! the manifest. Only after that should `DeliveryContext` be used for recipient
//! share delivery; this order avoids a circular manifest hash dependency.

use std::{
    collections::BTreeSet,
    io::{Read, Write},
    iter,
    str::FromStr,
};

use age::{Decryptor, Encryptor, x25519};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use rand::{RngExt, make_rng, rngs::StdRng};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_PLAINTEXT_BYTES: usize = 10 * 1024 * 1024;
pub const SHARE_COUNT: usize = 5;
pub const SHARE_THRESHOLD: usize = 3;
pub const PACKAGE_VERSION: u8 = 1;
pub const SHARE_ENVELOPE_VERSION: u8 = 2;
const PACKAGE_MAGIC: &[u8; 4] = b"ZCAN";
const RECIPIENT_SHARE_MAGIC: &[u8; 4] = b"ZSHR";
const PACKAGE_DOMAIN: &[u8] = b"z-canary/release-package/v1\0";
const SHARE_DOMAIN: &[u8] = b"z-canary/share-envelope/v2\0";
const INNER_DOMAIN: &[u8] = b"z-canary/age-payload/v1\0";
const SHARE_LEN: usize = 33; // one GF(256) participant identifier + 32 key bytes
const AAD_LEN: usize = 32 + 4 + 32;
const MAX_AGE_CIPHERTEXT_BYTES: usize = MAX_PLAINTEXT_BYTES + 64 * 1024;
const INNER_HEADER_LEN: usize = INNER_DOMAIN.len() + 32 + 8;
const MAX_INNER_PLAINTEXT_BYTES: usize = INNER_HEADER_LEN + MAX_PLAINTEXT_BYTES;
const MAX_SHARE_ENVELOPE_PLAINTEXT_BYTES: usize =
    SHARE_DOMAIN.len() + 32 + 4 + 32 + 1 + SHARE_LEN + 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    TooLarge,
    InvalidPackage,
    UnsupportedVersion,
    AuthenticationFailed,
    InvalidRecipient,
    InvalidShareSet,
    InvalidShare,
    ShareCommitmentMismatch,
    InsufficientShares,
    SharingFailure,
    AgeFailure,
    IoFailure,
    InvalidEnvelope,
    PackageDigestMismatch,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "plaintext exceeds the 10 MiB limit",
            Self::InvalidPackage => "invalid encrypted package",
            Self::UnsupportedVersion => "unsupported encrypted package version",
            Self::AuthenticationFailed => "encrypted package authentication failed",
            Self::InvalidRecipient => "invalid age X25519 recipient identity",
            Self::InvalidShareSet => "invalid or duplicate share set",
            Self::InvalidShare => "share has invalid metadata or length",
            Self::ShareCommitmentMismatch => "share does not match its manifest commitment",
            Self::InsufficientShares => "at least three valid distinct shares are required",
            Self::SharingFailure => "secret sharing operation failed",
            Self::AgeFailure => "age encryption or decryption failed",
            Self::IoFailure => "encrypted stream could not be read or written",
            Self::InvalidEnvelope => "invalid encrypted share envelope",
            Self::PackageDigestMismatch => {
                "encrypted package does not match the signed manifest digest"
            }
        })
    }
}

impl std::error::Error for CryptoError {}

/// Public binding metadata authenticated as outer AEAD associated data.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct PackageContext {
    pub switch_id: [u8; 32],
    pub epoch: u32,
    /// SHA-256 of the canonical age recipient string; fixed before package creation.
    pub recipient_fingerprint: [u8; 32],
}

/// Public, versioned ciphertext. Does not contain a plaintext digest.
#[derive(Clone, PartialEq, Eq)]
pub struct EncryptedPackage {
    pub version: u8,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}

impl EncryptedPackage {
    /// Encode as `magic || version || nonce || ciphertext_len_le || ciphertext`.
    pub fn to_bytes(&self) -> Result<Vec<u8>, CryptoError> {
        if self.version != PACKAGE_VERSION {
            return Err(CryptoError::UnsupportedVersion);
        }
        if self.ciphertext.len() > MAX_AGE_CIPHERTEXT_BYTES + 16 {
            return Err(CryptoError::TooLarge);
        }
        let length: u64 = self
            .ciphertext
            .len()
            .try_into()
            .map_err(|_| CryptoError::InvalidPackage)?;
        let mut output = Vec::with_capacity(4 + 1 + 24 + 8 + self.ciphertext.len());
        output.extend_from_slice(PACKAGE_MAGIC);
        output.push(self.version);
        output.extend_from_slice(&self.nonce);
        output.extend_from_slice(&length.to_le_bytes());
        output.extend_from_slice(&self.ciphertext);
        Ok(output)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        const HEADER_LEN: usize = 4 + 1 + 24 + 8;
        if bytes.len() < HEADER_LEN || &bytes[..4] != PACKAGE_MAGIC {
            return Err(CryptoError::InvalidPackage);
        }
        let version = bytes[4];
        if version != PACKAGE_VERSION {
            return Err(CryptoError::UnsupportedVersion);
        }
        let mut nonce = [0u8; 24];
        nonce.copy_from_slice(&bytes[5..29]);
        let length = u64::from_le_bytes(
            bytes[29..37]
                .try_into()
                .map_err(|_| CryptoError::InvalidPackage)?,
        );
        let length: usize = length.try_into().map_err(|_| CryptoError::InvalidPackage)?;
        if length > MAX_AGE_CIPHERTEXT_BYTES + 16 || length != bytes.len() - HEADER_LEN {
            return Err(CryptoError::InvalidPackage);
        }
        Ok(Self {
            version,
            nonce,
            ciphertext: bytes[HEADER_LEN..].to_vec(),
        })
    }
}

/// A fresh release key. Its bytes are not exposed through formatting or serialization.
pub struct ReleaseKey(Zeroizing<[u8; 32]>);

impl ReleaseKey {
    fn generate() -> Self {
        let mut bytes = Zeroizing::new([0u8; 32]);
        let mut rng: StdRng = make_rng();
        rng.fill(&mut *bytes);
        Self(bytes)
    }

    fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
}

/// A keeper-bound share accepted by the reconstruction API.
///
/// `value` carries the GF(256) participant identifier followed by the 32-byte
/// key share. It is intentionally not `Debug` or serializable.
pub struct Share {
    pub switch_id: [u8; 32],
    pub epoch: u32,
    pub keeper_id: [u8; 32],
    pub index: u8,
    pub value: Vec<u8>,
}

impl Drop for Share {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ShareCommitment {
    pub keeper_id: [u8; 32],
    pub index: u8,
    pub digest: [u8; 32],
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ShareSetContext {
    pub switch_id: [u8; 32],
    pub epoch: u32,
    /// SHA-256 fingerprints of keeper age X25519 recipients, ordered as indices 1–5.
    pub keeper_ids: [[u8; 32]; SHARE_COUNT],
}

/// Available after the immutable manifest is signed; deliberately excluded from
/// creation-time package and share commitments to avoid a manifest hash cycle.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct DeliveryContext {
    pub switch_id: [u8; 32],
    pub epoch: u32,
    pub manifest_digest: [u8; 32],
    /// SHA-256 of the registered recipient's raw 32-byte X25519 public key.
    pub expected_recipient_fingerprint: [u8; 32],
}

/// Share encrypted to a keeper during provisioning.
#[derive(Clone, PartialEq, Eq)]
pub struct KeeperShareEnvelope {
    pub version: u8,
    pub keeper_id: [u8; 32],
    pub index: u8,
    pub ciphertext: Vec<u8>,
}

/// Recipient-encrypted share delivery package. Recipient private keys never enter it.
#[derive(Clone, PartialEq, Eq)]
pub struct RecipientShareEnvelope {
    pub version: u8,
    pub ciphertext: Vec<u8>,
}

impl RecipientShareEnvelope {
    /// Encode the opaque recipient delivery record stored by each keeper.
    pub fn to_bytes(&self) -> Result<Vec<u8>, CryptoError> {
        if self.version != SHARE_ENVELOPE_VERSION {
            return Err(CryptoError::UnsupportedVersion);
        }
        if self.ciphertext.len() > 4096 {
            return Err(CryptoError::TooLarge);
        }
        let length: u32 = self
            .ciphertext
            .len()
            .try_into()
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        let mut bytes = Vec::with_capacity(9 + self.ciphertext.len());
        bytes.extend_from_slice(RECIPIENT_SHARE_MAGIC);
        bytes.push(self.version);
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(&self.ciphertext);
        Ok(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        const HEADER_LEN: usize = 4 + 1 + 4;
        if bytes.len() < HEADER_LEN || &bytes[..4] != RECIPIENT_SHARE_MAGIC {
            return Err(CryptoError::InvalidEnvelope);
        }
        let version = bytes[4];
        if version != SHARE_ENVELOPE_VERSION {
            return Err(CryptoError::UnsupportedVersion);
        }
        let length = u32::from_le_bytes(
            bytes[5..9]
                .try_into()
                .map_err(|_| CryptoError::InvalidEnvelope)?,
        ) as usize;
        if length > 4096 || length != bytes.len() - HEADER_LEN {
            return Err(CryptoError::InvalidEnvelope);
        }
        Ok(Self {
            version,
            ciphertext: bytes[HEADER_LEN..].to_vec(),
        })
    }
}

/// Result of creation: public ciphertext, share commitments, and encrypted-only
/// keeper provisioning envelopes. The release key is not returned.
pub struct CreatedVaultMaterial {
    pub package: EncryptedPackage,
    pub package_digest: [u8; 32],
    pub commitments: [ShareCommitment; SHARE_COUNT],
    pub keeper_envelopes: [KeeperShareEnvelope; SHARE_COUNT],
}

/// Make a recipient-encrypted payload containing the plaintext digest and file,
/// then wrap the resulting age file under a fresh release key.
pub fn create_vault(
    plaintext: &[u8],
    recipient: &str,
    context: PackageContext,
    share_context: ShareSetContext,
    keeper_recipients: [&str; SHARE_COUNT],
) -> Result<CreatedVaultMaterial, CryptoError> {
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(CryptoError::TooLarge);
    }
    if context.switch_id != share_context.switch_id
        || context.epoch != share_context.epoch
        || share_context
            .keeper_ids
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .len()
            != SHARE_COUNT
    {
        return Err(CryptoError::InvalidShareSet);
    }
    let recipient =
        x25519::Recipient::from_str(recipient).map_err(|_| CryptoError::InvalidRecipient)?;
    if recipient_fingerprint(&recipient.to_string())? != context.recipient_fingerprint {
        return Err(CryptoError::InvalidRecipient);
    }
    let digest: [u8; 32] = Sha256::digest(plaintext).into();
    let inner = Zeroizing::new(encode_inner(&digest, plaintext)?);
    let age_ciphertext = age_encrypt(&recipient, &inner)?;

    let release_key = ReleaseKey::generate();
    let package = encrypt_outer(&age_ciphertext, &release_key, context)?;
    let package_digest = public_package_digest(&package, context);
    let mut rng: StdRng = make_rng();
    let split = Zeroizing::new(
        vsss_rs::Gf256::split_bytes(SHARE_THRESHOLD, SHARE_COUNT, &release_key.0[..], &mut rng)
            .map_err(|_| CryptoError::SharingFailure)?,
    );
    if split.len() != SHARE_COUNT || split.iter().any(|part| part.len() != SHARE_LEN) {
        return Err(CryptoError::SharingFailure);
    }

    let mut commitments = Vec::with_capacity(SHARE_COUNT);
    let mut envelopes = Vec::with_capacity(SHARE_COUNT);
    for index in 1..=SHARE_COUNT as u8 {
        let value = &split[(index - 1) as usize];
        if value[0] != index {
            return Err(CryptoError::SharingFailure);
        }
        let keeper_id = share_context.keeper_ids[(index - 1) as usize];
        let commitment = share_commitment(&share_context, keeper_id, index, value);
        commitments.push(ShareCommitment {
            keeper_id,
            index,
            digest: commitment,
        });
        envelopes.push(encrypt_keeper_share(
            &share_context,
            keeper_id,
            index,
            value,
            keeper_recipients[(index - 1) as usize],
        )?);
    }
    let commitments: [ShareCommitment; SHARE_COUNT] = commitments
        .try_into()
        .map_err(|_| CryptoError::SharingFailure)?;
    let keeper_envelopes: [KeeperShareEnvelope; SHARE_COUNT] = envelopes
        .try_into()
        .map_err(|_| CryptoError::SharingFailure)?;
    Ok(CreatedVaultMaterial {
        package,
        package_digest,
        commitments,
        keeper_envelopes,
    })
}

/// Reconstructs only after validating every supplied share, including shares
/// beyond the three used for interpolation.
pub fn reconstruct_release_key(
    shares: &[Share],
    context: &ShareSetContext,
    commitments: &[ShareCommitment; SHARE_COUNT],
) -> Result<ReleaseKey, CryptoError> {
    if shares.len() < SHARE_THRESHOLD {
        return Err(CryptoError::InsufficientShares);
    }
    let mut seen_indices = BTreeSet::new();
    let mut seen_keepers = BTreeSet::new();
    for share in shares {
        if share.switch_id != context.switch_id
            || share.epoch != context.epoch
            || !(1..=SHARE_COUNT as u8).contains(&share.index)
            || share.value.len() != SHARE_LEN
            || share.value.first().copied() != Some(share.index)
        {
            return Err(CryptoError::InvalidShare);
        }
        let idx = (share.index - 1) as usize;
        if share.keeper_id != context.keeper_ids[idx]
            || !seen_indices.insert(share.index)
            || !seen_keepers.insert(share.keeper_id)
        {
            return Err(CryptoError::InvalidShareSet);
        }
        let expected = commitments[idx];
        if expected.index != share.index || expected.keeper_id != share.keeper_id {
            return Err(CryptoError::InvalidShareSet);
        }
        let actual = share_commitment(context, share.keeper_id, share.index, &share.value);
        if actual != expected.digest {
            return Err(CryptoError::ShareCommitmentMismatch);
        }
    }
    let raw = Zeroizing::new(
        shares
            .iter()
            .take(SHARE_THRESHOLD)
            .map(|s| s.value.clone())
            .collect::<Vec<_>>(),
    );
    let key = Zeroizing::new(
        vsss_rs::Gf256::combine_bytes(&raw[..]).map_err(|_| CryptoError::SharingFailure)?,
    );
    let key: [u8; 32] = key
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::SharingFailure)?;
    Ok(ReleaseKey::from_bytes(key))
}

/// Requires the versioned ciphertext digest from an already verified signed
/// manifest. Checks that digest before opening either encryption layer, then
/// checks the plaintext digest carried inside the age encryption.
pub fn decrypt_package(
    package: &EncryptedPackage,
    key: &ReleaseKey,
    context: PackageContext,
    expected_package_digest: [u8; 32],
    recipient_identity: &x25519::Identity,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if package.version != PACKAGE_VERSION {
        return Err(CryptoError::UnsupportedVersion);
    }
    if package.ciphertext.len() > MAX_AGE_CIPHERTEXT_BYTES + 16 {
        return Err(CryptoError::TooLarge);
    }
    if public_package_digest(package, context) != expected_package_digest {
        return Err(CryptoError::PackageDigestMismatch);
    }
    let age_ciphertext = decrypt_outer(package, key, context)?;
    let inner = age_decrypt(
        recipient_identity,
        &age_ciphertext,
        MAX_INNER_PLAINTEXT_BYTES,
    )?;
    let (expected_digest, contents) = decode_inner(&inner)?;
    if contents.len() > MAX_PLAINTEXT_BYTES {
        return Err(CryptoError::TooLarge);
    }
    let digest: [u8; 32] = Sha256::digest(contents).into();
    if digest != expected_digest {
        return Err(CryptoError::AuthenticationFailed);
    }
    Ok(Zeroizing::new(contents.to_vec()))
}

/// Decrypt keeper provisioning data into an in-memory validated share.
pub fn open_keeper_share(
    envelope: &KeeperShareEnvelope,
    context: &ShareSetContext,
    commitments: &[ShareCommitment; SHARE_COUNT],
    keeper_identity: &x25519::Identity,
) -> Result<Share, CryptoError> {
    if envelope.version != SHARE_ENVELOPE_VERSION
        || envelope.ciphertext.len() > 4096
        || !(1..=SHARE_COUNT as u8).contains(&envelope.index)
    {
        return Err(CryptoError::InvalidEnvelope);
    }
    let index = envelope.index;
    let keeper_id = envelope.keeper_id;
    if context.keeper_ids[(index - 1) as usize] != keeper_id {
        return Err(CryptoError::InvalidEnvelope);
    }
    let decoded = age_decrypt(
        keeper_identity,
        &envelope.ciphertext,
        MAX_SHARE_ENVELOPE_PLAINTEXT_BYTES,
    )?;
    let share = decode_share_payload(&decoded, context, keeper_id, index)?;
    validate_single_share(&share, context, commitments)?;
    Ok(share)
}

/// Encrypt a validated share to the registered recipient for threshold delivery.
pub fn package_recipient_share(
    share: &Share,
    context: &ShareSetContext,
    commitments: &[ShareCommitment; SHARE_COUNT],
    delivery: DeliveryContext,
    recipient: &str,
) -> Result<RecipientShareEnvelope, CryptoError> {
    validate_single_share(share, context, commitments)?;
    if delivery.switch_id != context.switch_id || delivery.epoch != context.epoch {
        return Err(CryptoError::InvalidEnvelope);
    }
    let recipient =
        x25519::Recipient::from_str(recipient).map_err(|_| CryptoError::InvalidRecipient)?;
    if recipient_fingerprint(&recipient.to_string())? != delivery.expected_recipient_fingerprint {
        return Err(CryptoError::InvalidRecipient);
    }
    let payload = Zeroizing::new(encode_delivery_payload(share, delivery)?);
    let ciphertext = age_encrypt(&recipient, &payload)?;
    Ok(RecipientShareEnvelope {
        version: SHARE_ENVELOPE_VERSION,
        ciphertext,
    })
}

/// Open a recipient delivery envelope. Caller must validate this share together
/// with the full supplied set before reconstruction.
pub fn open_recipient_share(
    envelope: &RecipientShareEnvelope,
    context: &ShareSetContext,
    commitments: &[ShareCommitment; SHARE_COUNT],
    delivery: DeliveryContext,
    recipient_identity: &x25519::Identity,
) -> Result<Share, CryptoError> {
    if envelope.version != SHARE_ENVELOPE_VERSION {
        return Err(CryptoError::UnsupportedVersion);
    }
    if envelope.ciphertext.len() > 4096 {
        return Err(CryptoError::InvalidEnvelope);
    }
    if recipient_fingerprint(&recipient_identity.to_public().to_string())?
        != delivery.expected_recipient_fingerprint
    {
        return Err(CryptoError::InvalidRecipient);
    }
    let decoded = age_decrypt(
        recipient_identity,
        &envelope.ciphertext,
        MAX_SHARE_ENVELOPE_PLAINTEXT_BYTES,
    )?;
    let share = decode_delivery_payload(&decoded, context, delivery)?;
    validate_single_share(&share, context, commitments)?;
    Ok(share)
}

pub fn public_package_digest(package: &EncryptedPackage, context: PackageContext) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(PACKAGE_DOMAIN);
    hash.update(context.switch_id);
    hash.update(context.epoch.to_le_bytes());
    hash.update(context.recipient_fingerprint);
    hash.update(PACKAGE_MAGIC);
    hash.update([package.version]);
    hash.update(package.nonce);
    hash.update((package.ciphertext.len() as u64).to_le_bytes());
    hash.update(&package.ciphertext);
    hash.finalize().into()
}

/// SHA-256 fingerprint of the raw 32-byte X25519 public key encoded by an age
/// recipient. This matches the core manifest fingerprint input, which is the
/// lowercase hex encoding of those same 32 public-key bytes.
pub fn recipient_fingerprint(recipient: &str) -> Result<[u8; 32], CryptoError> {
    let (hrp, public_key) = bech32::decode(recipient).map_err(|_| CryptoError::InvalidRecipient)?;
    if hrp.to_string() != "age" || public_key.len() != 32 {
        return Err(CryptoError::InvalidRecipient);
    }
    Ok(Sha256::digest(public_key).into())
}

fn outer_aad(context: PackageContext, version: u8) -> [u8; AAD_LEN + PACKAGE_DOMAIN.len() + 1] {
    let mut aad = [0u8; AAD_LEN + PACKAGE_DOMAIN.len() + 1];
    let mut offset = 0;
    aad[offset..offset + PACKAGE_DOMAIN.len()].copy_from_slice(PACKAGE_DOMAIN);
    offset += PACKAGE_DOMAIN.len();
    aad[offset] = version;
    offset += 1;
    aad[offset..offset + 32].copy_from_slice(&context.switch_id);
    offset += 32;
    aad[offset..offset + 4].copy_from_slice(&context.epoch.to_le_bytes());
    offset += 4;
    aad[offset..offset + 32].copy_from_slice(&context.recipient_fingerprint);
    aad
}

fn encrypt_outer(
    inner: &[u8],
    key: &ReleaseKey,
    context: PackageContext,
) -> Result<EncryptedPackage, CryptoError> {
    let mut nonce_bytes = [0u8; 24];
    let mut rng: StdRng = make_rng();
    rng.fill(&mut nonce_bytes);
    let nonce = XNonce::from(nonce_bytes);
    let cipher = XChaCha20Poly1305::new_from_slice(key.0.as_ref())
        .map_err(|_| CryptoError::InvalidPackage)?;
    let aad = outer_aad(context, PACKAGE_VERSION);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            chacha20poly1305::aead::Payload {
                msg: inner,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    Ok(EncryptedPackage {
        version: PACKAGE_VERSION,
        nonce: nonce.into(),
        ciphertext,
    })
}

fn decrypt_outer(
    package: &EncryptedPackage,
    key: &ReleaseKey,
    context: PackageContext,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.0.as_ref())
        .map_err(|_| CryptoError::InvalidPackage)?;
    let aad = outer_aad(context, package.version);
    let plaintext = cipher
        .decrypt(
            &XNonce::from(package.nonce),
            chacha20poly1305::aead::Payload {
                msg: package.ciphertext.as_ref(),
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    Ok(Zeroizing::new(plaintext))
}

fn encode_inner(digest: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let len: u64 = plaintext
        .len()
        .try_into()
        .map_err(|_| CryptoError::InvalidPackage)?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(CryptoError::TooLarge);
    }
    let mut out = Vec::with_capacity(INNER_HEADER_LEN + plaintext.len());
    out.extend_from_slice(INNER_DOMAIN);
    out.extend_from_slice(digest);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(plaintext);
    Ok(out)
}

fn decode_inner(bytes: &[u8]) -> Result<([u8; 32], &[u8]), CryptoError> {
    if bytes.len() < INNER_HEADER_LEN
        || bytes.len() > MAX_INNER_PLAINTEXT_BYTES
        || &bytes[..INNER_DOMAIN.len()] != INNER_DOMAIN
    {
        return Err(CryptoError::InvalidPackage);
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&bytes[INNER_DOMAIN.len()..INNER_DOMAIN.len() + 32]);
    let start = INNER_DOMAIN.len() + 32;
    let len = u64::from_le_bytes(
        bytes[start..start + 8]
            .try_into()
            .map_err(|_| CryptoError::InvalidPackage)?,
    );
    let len: usize = len.try_into().map_err(|_| CryptoError::InvalidPackage)?;
    if len > MAX_PLAINTEXT_BYTES || len != bytes.len() - INNER_HEADER_LEN {
        return Err(CryptoError::InvalidPackage);
    }
    Ok((digest, &bytes[INNER_HEADER_LEN..]))
}

fn share_commitment(
    context: &ShareSetContext,
    keeper_id: [u8; 32],
    index: u8,
    value: &[u8],
) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(SHARE_DOMAIN);
    hash.update(context.switch_id);
    hash.update(context.epoch.to_le_bytes());
    hash.update(keeper_id);
    hash.update([index]);
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value);
    hash.finalize().into()
}

fn validate_single_share(
    share: &Share,
    context: &ShareSetContext,
    commitments: &[ShareCommitment; SHARE_COUNT],
) -> Result<(), CryptoError> {
    if share.switch_id != context.switch_id
        || share.epoch != context.epoch
        || !(1..=SHARE_COUNT as u8).contains(&share.index)
        || share.value.len() != SHARE_LEN
        || share.value.first().copied() != Some(share.index)
    {
        return Err(CryptoError::InvalidShare);
    }
    let i = (share.index - 1) as usize;
    let commitment = commitments[i];
    if share.keeper_id != context.keeper_ids[i]
        || commitment.index != share.index
        || commitment.keeper_id != share.keeper_id
    {
        return Err(CryptoError::InvalidShareSet);
    }
    if share_commitment(context, share.keeper_id, share.index, &share.value) != commitment.digest {
        return Err(CryptoError::ShareCommitmentMismatch);
    }
    Ok(())
}

fn encode_share_payload(share: &Share) -> Result<Vec<u8>, CryptoError> {
    if share.value.len() != SHARE_LEN {
        return Err(CryptoError::InvalidShare);
    }
    let mut out = Vec::with_capacity(SHARE_DOMAIN.len() + 32 + 4 + 32 + 1 + SHARE_LEN);
    out.extend_from_slice(SHARE_DOMAIN);
    out.extend_from_slice(&share.switch_id);
    out.extend_from_slice(&share.epoch.to_le_bytes());
    out.extend_from_slice(&share.keeper_id);
    out.push(share.index);
    out.extend_from_slice(&share.value);
    Ok(out)
}

fn encode_delivery_payload(
    share: &Share,
    delivery: DeliveryContext,
) -> Result<Vec<u8>, CryptoError> {
    let mut out = encode_share_payload(share)?;
    out.extend_from_slice(&delivery.manifest_digest);
    out.extend_from_slice(&delivery.expected_recipient_fingerprint);
    Ok(out)
}

fn decode_delivery_payload(
    bytes: &[u8],
    context: &ShareSetContext,
    delivery: DeliveryContext,
) -> Result<Share, CryptoError> {
    let share_len = SHARE_DOMAIN.len() + 32 + 4 + 32 + 1 + SHARE_LEN;
    if bytes.len() != share_len + 64
        || delivery.switch_id != context.switch_id
        || delivery.epoch != context.epoch
        || &bytes[share_len..share_len + 32] != &delivery.manifest_digest[..]
        || &bytes[share_len + 32..] != &delivery.expected_recipient_fingerprint[..]
    {
        return Err(CryptoError::InvalidEnvelope);
    }
    decode_share_payload(&bytes[..share_len], context, [0; 32], 0)
}

fn decode_share_payload(
    bytes: &[u8],
    context: &ShareSetContext,
    expected_keeper: [u8; 32],
    expected_index: u8,
) -> Result<Share, CryptoError> {
    let len = SHARE_DOMAIN.len() + 32 + 4 + 32 + 1 + SHARE_LEN;
    if bytes.len() != len || &bytes[..SHARE_DOMAIN.len()] != SHARE_DOMAIN {
        return Err(CryptoError::InvalidEnvelope);
    }
    let mut p = SHARE_DOMAIN.len();
    let mut switch_id = [0; 32];
    switch_id.copy_from_slice(&bytes[p..p + 32]);
    p += 32;
    let epoch = u32::from_le_bytes(
        bytes[p..p + 4]
            .try_into()
            .map_err(|_| CryptoError::InvalidEnvelope)?,
    );
    p += 4;
    let mut keeper_id = [0; 32];
    keeper_id.copy_from_slice(&bytes[p..p + 32]);
    p += 32;
    let index = bytes[p];
    p += 1;
    if switch_id != context.switch_id
        || epoch != context.epoch
        || !(1..=SHARE_COUNT as u8).contains(&index)
        || bytes[p] != index
        || (expected_index != 0 && index != expected_index)
        || (expected_keeper != [0; 32] && keeper_id != expected_keeper)
        || context.keeper_ids[(index - 1) as usize] != keeper_id
    {
        return Err(CryptoError::InvalidShare);
    }
    let value = bytes[p..].to_vec();
    Ok(Share {
        switch_id,
        epoch,
        keeper_id,
        index,
        value,
    })
}

fn encrypt_keeper_share(
    context: &ShareSetContext,
    keeper_id: [u8; 32],
    index: u8,
    value: &[u8],
    recipient: &str,
) -> Result<KeeperShareEnvelope, CryptoError> {
    let recipient =
        x25519::Recipient::from_str(recipient).map_err(|_| CryptoError::InvalidRecipient)?;
    if recipient_fingerprint(&recipient.to_string())? != keeper_id {
        return Err(CryptoError::InvalidRecipient);
    }
    let share = Share {
        switch_id: context.switch_id,
        epoch: context.epoch,
        keeper_id,
        index,
        value: value.to_vec(),
    };
    let payload = Zeroizing::new(encode_share_payload(&share)?);
    let ciphertext = age_encrypt(&recipient, &payload)?;
    Ok(KeeperShareEnvelope {
        version: SHARE_ENVELOPE_VERSION,
        keeper_id,
        index,
        ciphertext,
    })
}

fn age_encrypt(recipient: &x25519::Recipient, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let encryptor = Encryptor::with_recipients(iter::once(recipient as &dyn age::Recipient))
        .map_err(|_| CryptoError::AgeFailure)?;
    let mut output = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut output)
        .map_err(|_| CryptoError::AgeFailure)?;
    writer
        .write_all(plaintext)
        .map_err(|_| CryptoError::IoFailure)?;
    writer.finish().map_err(|_| CryptoError::AgeFailure)?;
    Ok(output)
}

fn age_decrypt(
    identity: &dyn age::Identity,
    ciphertext: &[u8],
    max_plaintext: usize,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let decryptor = Decryptor::new(ciphertext).map_err(|_| CryptoError::AgeFailure)?;
    let reader = decryptor
        .decrypt(iter::once(identity))
        .map_err(|_| CryptoError::AgeFailure)?;
    let mut output = Zeroizing::new(Vec::new());
    let mut bounded = reader.take((max_plaintext + 1) as u64);
    bounded
        .read_to_end(&mut output)
        .map_err(|_| CryptoError::IoFailure)?;
    if output.len() > max_plaintext {
        return Err(CryptoError::TooLarge);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn signed_manifest_package_digest_rejects_same_key_context_substitution() {
        let recipient = x25519::Identity::generate();
        let context = PackageContext {
            switch_id: [17; 32],
            epoch: 4,
            recipient_fingerprint: recipient_fingerprint(&recipient.to_public().to_string())
                .unwrap(),
        };
        let key = ReleaseKey::generate();
        let build_package = |contents: &[u8]| {
            let digest: [u8; 32] = Sha256::digest(contents).into();
            let inner = Zeroizing::new(encode_inner(&digest, contents).unwrap());
            let age_ciphertext = age_encrypt(&recipient.to_public(), &inner).unwrap();
            encrypt_outer(&age_ciphertext, &key, context).unwrap()
        };

        let original = build_package(b"original document bytes");
        let replacement = build_package(b"substituted document bytes");
        let signed_manifest_digest = public_package_digest(&original, context);
        assert_ne!(
            signed_manifest_digest,
            public_package_digest(&replacement, context)
        );
        assert!(matches!(
            decrypt_package(
                &replacement,
                &key,
                context,
                signed_manifest_digest,
                &recipient
            ),
            Err(CryptoError::PackageDigestMismatch)
        ));

        let original_digest = public_package_digest(&original, context);
        let plaintext =
            decrypt_package(&original, &key, context, original_digest, &recipient).unwrap();
        assert_eq!(plaintext.as_slice(), b"original document bytes");
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_048))]

        #[test]
        fn arbitrary_package_and_envelope_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..=8_192)) {
            let package = std::panic::catch_unwind(|| EncryptedPackage::from_bytes(&bytes));
            let envelope = std::panic::catch_unwind(|| RecipientShareEnvelope::from_bytes(&bytes));
            prop_assert!(package.is_ok());
            prop_assert!(envelope.is_ok());
        }

        #[test]
        fn bounded_recipient_envelopes_roundtrip(ciphertext in proptest::collection::vec(any::<u8>(), 0..=4_096)) {
            let envelope = RecipientShareEnvelope { version: SHARE_ENVELOPE_VERSION, ciphertext };
            let encoded = envelope.to_bytes().unwrap();
            prop_assert!(encoded.len() <= 4_105);
            prop_assert!(RecipientShareEnvelope::from_bytes(&encoded).unwrap() == envelope);
        }

        #[test]
        fn declared_lengths_cannot_smuggle_trailing_envelope_bytes(ciphertext in proptest::collection::vec(any::<u8>(), 0..4_096), trailing in any::<u8>()) {
            let envelope = RecipientShareEnvelope { version: SHARE_ENVELOPE_VERSION, ciphertext };
            let mut encoded = envelope.to_bytes().unwrap();
            encoded.push(trailing);
            prop_assert!(matches!(RecipientShareEnvelope::from_bytes(&encoded), Err(CryptoError::InvalidEnvelope)));
        }
    }
}
