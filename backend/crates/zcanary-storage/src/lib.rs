//! Bounded, passphrase-encrypted local identity bundles.
//!
//! This is a prototype persistence primitive, not wallet integration or an
//! audited production storage system. The file format contains only a public
//! magic/version prefix and an age scrypt-encrypted payload. Role and identity
//! ID are encoded in that payload and checked after decryption.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use age::{Decryptor, Encryptor, scrypt};
use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

const FILE_MAGIC: &[u8; 4] = b"ZCID";
const FORMAT_VERSION: u8 = 1;
const INNER_MAGIC: &[u8; 4] = b"ZCIB";
const MAX_ID_BYTES: usize = 128;
const INNER_HEADER_BYTES: usize = 4 + 1 + 1 + 2 + 4 + MAX_ID_BYTES;
// age 0.12.1 uses scrypt r=8 and p=1, so log2(N)=19 needs about 512 MiB
// per stanza. This is a bounded budget for an 8 GiB host while leaving the
// normal age encryption work factor untouched. Faster hosts may emit larger
// factors; export verifies its result against this import policy.
const MAX_SCRYPT_WORK_FACTOR: u8 = 19;
static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);
/// Maximum opaque secret bundle accepted by this crate.
pub const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
/// Upper bound includes age framing and scrypt metadata with ample headroom.
pub const MAX_CIPHERTEXT_BYTES: usize = MAX_PLAINTEXT_BYTES + INNER_HEADER_BYTES + 128 * 1024;

/// Purpose of the local identity represented by a bundle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityRole {
    Source,
    Recipient,
}

impl IdentityRole {
    fn wire(self) -> u8 {
        match self {
            Self::Source => 1,
            Self::Recipient => 2,
        }
    }

    fn from_wire(value: u8) -> Result<Self, StorageError> {
        match value {
            1 => Ok(Self::Source),
            2 => Ok(Self::Recipient),
            _ => Err(StorageError::InvalidFormat),
        }
    }
}

/// Public routing context for a stored identity. It is also embedded inside
/// the encrypted payload so a ciphertext cannot be restored into another slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityContext {
    pub role: IdentityRole,
    pub identity_id: String,
}

impl IdentityContext {
    pub fn new(role: IdentityRole, identity_id: impl Into<String>) -> Result<Self, StorageError> {
        let identity_id = identity_id.into();
        validate_identity_id(&identity_id)?;
        Ok(Self { role, identity_id })
    }
}

/// Secret bytes held in a zeroizing allocation. Deliberately has no `Debug`
/// implementation and is not serializable.
pub struct SecretBundle {
    context: IdentityContext,
    secret_bytes: Zeroizing<Vec<u8>>,
}

impl SecretBundle {
    pub fn new(context: IdentityContext, secret_bytes: &[u8]) -> Result<Self, StorageError> {
        validate_identity_id(&context.identity_id)?;
        if secret_bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err(StorageError::TooLarge);
        }
        Ok(Self {
            context,
            secret_bytes: Zeroizing::new(secret_bytes.to_vec()),
        })
    }

    pub fn context(&self) -> &IdentityContext {
        &self.context
    }

    /// Borrow the secret bytes for immediate use. Callers remain responsible
    /// for avoiding copies and clearing any buffers they create.
    pub fn expose_secret_bytes(&self) -> &[u8] {
        &self.secret_bytes
    }
}

/// An encrypted file-format payload. Ciphertext is not treated as secret, but
/// this type intentionally omits `Debug` to keep accidental diagnostics small.
pub struct EncryptedIdentity {
    bytes: Vec<u8>,
}

impl EncryptedIdentity {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageError {
    InvalidContext,
    TooLarge,
    InvalidFormat,
    UnsupportedVersion,
    WorkFactorTooHigh,
    AuthenticationFailed,
    EmptyPassphrase,
    ContextMismatch,
    AlreadyExists,
    IoFailure,
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidContext => "invalid identity context",
            Self::TooLarge => "identity bundle exceeds the size limit",
            Self::InvalidFormat => "invalid encrypted identity format",
            Self::UnsupportedVersion => "unsupported encrypted identity version",
            Self::WorkFactorTooHigh => "encrypted identity exceeds the scrypt work limit",
            Self::AuthenticationFailed => "encrypted identity authentication failed",
            Self::EmptyPassphrase => "passphrase must not be empty",
            Self::ContextMismatch => "encrypted identity does not match the expected identity",
            Self::AlreadyExists => "destination already exists",
            Self::IoFailure => "encrypted identity file operation failed",
        })
    }
}

impl std::error::Error for StorageError {}

/// Encrypt a small opaque secret bundle for encrypted backup or later import.
pub fn export_encrypted(
    bundle: &SecretBundle,
    passphrase: &SecretString,
) -> Result<EncryptedIdentity, StorageError> {
    validate_passphrase(passphrase)?;
    let plaintext = Zeroizing::new(encode_inner(bundle)?);
    let encryptor = Encryptor::with_user_passphrase(passphrase.clone());
    let mut encrypted = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut encrypted)
        .map_err(|_| StorageError::AuthenticationFailed)?;
    writer
        .write_all(&plaintext)
        .map_err(|_| StorageError::IoFailure)?;
    writer
        .finish()
        .map_err(|_| StorageError::AuthenticationFailed)?;

    if encrypted.len() + 5 > MAX_CIPHERTEXT_BYTES {
        return Err(StorageError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(5 + encrypted.len());
    bytes.extend_from_slice(FILE_MAGIC);
    bytes.push(FORMAT_VERSION);
    bytes.extend_from_slice(&encrypted);
    let exported = EncryptedIdentity { bytes };
    // The age writer chooses its work factor adaptively. Fail closed if this
    // host would create a file this crate's bounded importer must reject.
    import_encrypted(exported.as_bytes(), passphrase, &bundle.context)?;
    Ok(exported)
}

/// Decrypt and validate an imported/exported identity against its expected
/// role and identity ID before returning any secret bytes to the caller.
pub fn import_encrypted(
    ciphertext: &[u8],
    passphrase: &SecretString,
    expected: &IdentityContext,
) -> Result<SecretBundle, StorageError> {
    validate_passphrase(passphrase)?;
    if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        return Err(StorageError::TooLarge);
    }
    if ciphertext.len() < 6 || &ciphertext[..4] != FILE_MAGIC {
        return Err(StorageError::InvalidFormat);
    }
    if ciphertext[4] != FORMAT_VERSION {
        return Err(StorageError::UnsupportedVersion);
    }
    validate_identity_id(&expected.identity_id)?;

    let decryptor = Decryptor::new(&ciphertext[5..]).map_err(|_| StorageError::InvalidFormat)?;
    let mut identity = scrypt::Identity::new(passphrase.clone());
    identity.set_max_work_factor(MAX_SCRYPT_WORK_FACTOR);
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(map_decrypt_error)?;
    let mut plaintext = Zeroizing::new(Vec::new());
    reader
        .take((MAX_PLAINTEXT_BYTES + INNER_HEADER_BYTES + 1) as u64)
        .read_to_end(&mut plaintext)
        .map_err(|_| StorageError::AuthenticationFailed)?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES + INNER_HEADER_BYTES {
        return Err(StorageError::TooLarge);
    }

    let bundle = decode_inner(&plaintext)?;
    if bundle.context != *expected {
        return Err(StorageError::ContextMismatch);
    }
    Ok(bundle)
}

/// Encrypt and atomically create a new identity file without replacing an
/// existing destination.
pub fn save_new(
    path: impl AsRef<Path>,
    bundle: &SecretBundle,
    passphrase: &SecretString,
) -> Result<(), StorageError> {
    let encrypted = export_encrypted(bundle, passphrase)?;
    write_new(path.as_ref(), encrypted.as_bytes())
}

/// Save an already-encrypted backup without replacing an existing destination.
pub fn save_export_new(
    path: impl AsRef<Path>,
    encrypted: &EncryptedIdentity,
) -> Result<(), StorageError> {
    write_new(path.as_ref(), encrypted.as_bytes())
}

/// Load, bound, decrypt, and context-validate a local identity file.
pub fn load_file(
    path: impl AsRef<Path>,
    passphrase: &SecretString,
    expected: &IdentityContext,
) -> Result<SecretBundle, StorageError> {
    let file = File::open(path).map_err(|_| StorageError::IoFailure)?;
    let mut bytes = Vec::new();
    file.take((MAX_CIPHERTEXT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| StorageError::IoFailure)?;
    if bytes.len() > MAX_CIPHERTEXT_BYTES {
        return Err(StorageError::TooLarge);
    }
    import_encrypted(&bytes, passphrase, expected)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    if bytes.len() > MAX_CIPHERTEXT_BYTES {
        return Err(StorageError::TooLarge);
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or(StorageError::IoFailure)?;
    let mut temporary = None;
    for _ in 0..32 {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = file_name.to_os_string();
        temporary_name.push(format!(".tmp-{}-{stamp}-{sequence}", std::process::id()));
        let candidate = parent.join(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(StorageError::IoFailure),
        }
    }
    let (temporary_path, mut file) = temporary.ok_or(StorageError::IoFailure)?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(StorageError::IoFailure);
    }
    let link_result = fs::hard_link(&temporary_path, path);
    let _ = fs::remove_file(&temporary_path);
    match link_result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Err(StorageError::AlreadyExists)
        }
        Err(_) => Err(StorageError::IoFailure),
    }
}

fn encode_inner(bundle: &SecretBundle) -> Result<Vec<u8>, StorageError> {
    let id = bundle.context.identity_id.as_bytes();
    validate_identity_id(&bundle.context.identity_id)?;
    if bundle.secret_bytes.len() > MAX_PLAINTEXT_BYTES {
        return Err(StorageError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(12 + id.len() + bundle.secret_bytes.len());
    bytes.extend_from_slice(INNER_MAGIC);
    bytes.push(FORMAT_VERSION);
    bytes.push(bundle.context.role.wire());
    bytes.extend_from_slice(&(id.len() as u16).to_le_bytes());
    bytes.extend_from_slice(id);
    bytes.extend_from_slice(&(bundle.secret_bytes.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&bundle.secret_bytes);
    Ok(bytes)
}

fn decode_inner(bytes: &[u8]) -> Result<SecretBundle, StorageError> {
    if bytes.len() < 12 || &bytes[..4] != INNER_MAGIC {
        return Err(StorageError::InvalidFormat);
    }
    if bytes[4] != FORMAT_VERSION {
        return Err(StorageError::UnsupportedVersion);
    }
    let role = IdentityRole::from_wire(bytes[5])?;
    let id_len = u16::from_le_bytes([bytes[6], bytes[7]]) as usize;
    if id_len == 0 || id_len > MAX_ID_BYTES || bytes.len() < 8 + id_len + 4 {
        return Err(StorageError::InvalidFormat);
    }
    let id_end = 8 + id_len;
    let identity_id = std::str::from_utf8(&bytes[8..id_end])
        .map_err(|_| StorageError::InvalidFormat)?
        .to_owned();
    validate_identity_id(&identity_id)?;
    let secret_len = u32::from_le_bytes(bytes[id_end..id_end + 4].try_into().unwrap()) as usize;
    if secret_len > MAX_PLAINTEXT_BYTES {
        return Err(StorageError::TooLarge);
    }
    if bytes.len() != id_end + 4 + secret_len {
        return Err(StorageError::InvalidFormat);
    }
    let context = IdentityContext { role, identity_id };
    SecretBundle::new(context, &bytes[id_end + 4..])
}

fn validate_identity_id(identity_id: &str) -> Result<(), StorageError> {
    let bytes = identity_id.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_ID_BYTES
        || bytes.iter().any(|byte| byte.is_ascii_control())
    {
        return Err(StorageError::InvalidContext);
    }
    Ok(())
}

fn validate_passphrase(passphrase: &SecretString) -> Result<(), StorageError> {
    if passphrase.expose_secret().is_empty() {
        return Err(StorageError::EmptyPassphrase);
    }
    Ok(())
}

fn map_decrypt_error(error: age::DecryptError) -> StorageError {
    match error {
        age::DecryptError::ExcessiveWork { .. } => StorageError::WorkFactorTooHigh,
        _ => StorageError::AuthenticationFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn passphrase(value: &str) -> SecretString {
        SecretString::from(value.to_owned())
    }

    fn context(role: IdentityRole, id: &str) -> IdentityContext {
        IdentityContext::new(role, id).unwrap()
    }

    fn temporary_path() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "zcanary-storage-{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn sample() -> SecretBundle {
        SecretBundle::new(
            context(IdentityRole::Source, "source-local-1"),
            &[0, 255, 17, 0, 42],
        )
        .unwrap()
    }

    #[test]
    fn encrypted_export_import_roundtrips_binary_bundle() {
        let bundle = sample();
        let encrypted =
            export_encrypted(&bundle, &passphrase("synthetic test passphrase")).unwrap();
        assert!(
            !encrypted
                .as_bytes()
                .windows(5)
                .any(|window| window == [0, 255, 17, 0, 42])
        );
        let restored = import_encrypted(
            encrypted.as_bytes(),
            &passphrase("synthetic test passphrase"),
            &bundle.context,
        )
        .unwrap();
        assert_eq!(restored.context, bundle.context);
        assert_eq!(restored.expose_secret_bytes(), bundle.expose_secret_bytes());
    }

    #[test]
    fn wrong_passphrase_and_modified_or_truncated_ciphertext_fail() {
        let encrypted =
            export_encrypted(&sample(), &passphrase("right synthetic passphrase")).unwrap();
        assert!(matches!(
            import_encrypted(
                encrypted.as_bytes(),
                &passphrase("wrong synthetic passphrase"),
                &context(IdentityRole::Source, "source-local-1")
            ),
            Err(StorageError::AuthenticationFailed)
        ));
        let mut tampered = encrypted.as_bytes().to_vec();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(
            import_encrypted(
                &tampered,
                &passphrase("right synthetic passphrase"),
                &context(IdentityRole::Source, "source-local-1")
            )
            .is_err()
        );
        assert!(
            import_encrypted(
                &encrypted.as_bytes()[..encrypted.as_bytes().len() - 1],
                &passphrase("right synthetic passphrase"),
                &context(IdentityRole::Source, "source-local-1")
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_import_work_factor_above_policy_before_running_scrypt() {
        let encrypted =
            export_encrypted(&sample(), &passphrase("synthetic test passphrase")).unwrap();
        let mut over_budget = encrypted.as_bytes().to_vec();
        let stanza_marker = b"-> scrypt ";
        let marker_at = over_budget
            .windows(stanza_marker.len())
            .position(|window| window == stanza_marker)
            .expect("age scrypt stanza");
        let salt_start = marker_at + stanza_marker.len();
        let factor_start = over_budget[salt_start..]
            .iter()
            .position(|byte| *byte == b' ')
            .map(|offset| salt_start + offset + 1)
            .expect("scrypt salt separator");
        let factor_end = over_budget[factor_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| factor_start + offset)
            .expect("scrypt stanza newline");
        over_budget.splice(factor_start..factor_end, b"20".iter().copied());

        assert!(matches!(
            import_encrypted(
                &over_budget,
                &passphrase("synthetic test passphrase"),
                &context(IdentityRole::Source, "source-local-1")
            ),
            Err(StorageError::WorkFactorTooHigh)
        ));
    }

    #[test]
    fn rejects_empty_passphrases_for_export_and_import() {
        let bundle = sample();
        assert!(matches!(
            export_encrypted(&bundle, &passphrase("")),
            Err(StorageError::EmptyPassphrase)
        ));
        assert!(matches!(
            import_encrypted(b"ZCID\x01x", &passphrase(""), &bundle.context),
            Err(StorageError::EmptyPassphrase)
        ));
    }

    #[test]
    fn role_and_identity_id_are_bound_inside_ciphertext() {
        let encrypted =
            export_encrypted(&sample(), &passphrase("synthetic test passphrase")).unwrap();
        assert!(matches!(
            import_encrypted(
                encrypted.as_bytes(),
                &passphrase("synthetic test passphrase"),
                &context(IdentityRole::Recipient, "source-local-1")
            ),
            Err(StorageError::ContextMismatch)
        ));
        assert!(matches!(
            import_encrypted(
                encrypted.as_bytes(),
                &passphrase("synthetic test passphrase"),
                &context(IdentityRole::Source, "source-local-2")
            ),
            Err(StorageError::ContextMismatch)
        ));
    }

    #[test]
    fn format_and_ciphertext_size_are_bounded() {
        let encrypted =
            export_encrypted(&sample(), &passphrase("synthetic test passphrase")).unwrap();
        let mut version = encrypted.as_bytes().to_vec();
        version[4] = 99;
        assert!(matches!(
            import_encrypted(
                &version,
                &passphrase("synthetic test passphrase"),
                &context(IdentityRole::Source, "source-local-1")
            ),
            Err(StorageError::UnsupportedVersion)
        ));
        assert!(matches!(
            import_encrypted(
                &vec![0; MAX_CIPHERTEXT_BYTES + 1],
                &passphrase("synthetic test passphrase"),
                &context(IdentityRole::Source, "source-local-1")
            ),
            Err(StorageError::TooLarge)
        ));
        assert!(matches!(
            SecretBundle::new(
                context(IdentityRole::Source, "source-local-1"),
                &vec![0; MAX_PLAINTEXT_BYTES + 1]
            ),
            Err(StorageError::TooLarge)
        ));
    }

    #[test]
    fn create_new_preserves_existing_file_and_never_writes_plaintext() {
        let path = temporary_path();
        let bundle = SecretBundle::new(
            context(IdentityRole::Source, "source-local-1"),
            b"synthetic secret marker",
        )
        .unwrap();
        let pass = passphrase("synthetic test passphrase");
        save_new(&path, &bundle, &pass).unwrap();
        let first = fs::read(&path).unwrap();
        assert!(
            !first
                .windows(b"synthetic secret marker".len())
                .any(|window| window == b"synthetic secret marker")
        );
        assert_eq!(
            load_file(&path, &pass, &bundle.context)
                .unwrap()
                .expose_secret_bytes(),
            b"synthetic secret marker"
        );
        assert_eq!(
            save_new(&path, &bundle, &pass).unwrap_err(),
            StorageError::AlreadyExists
        );
        assert_eq!(fs::read(&path).unwrap(), first);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn encrypted_export_can_be_saved_and_imported_as_backup() {
        let path = temporary_path();
        let bundle = sample();
        let encrypted =
            export_encrypted(&bundle, &passphrase("synthetic test passphrase")).unwrap();
        save_export_new(&path, &encrypted).unwrap();
        let read_back = fs::read(&path).unwrap();
        assert_eq!(
            import_encrypted(
                &read_back,
                &passphrase("synthetic test passphrase"),
                &bundle.context
            )
            .unwrap()
            .expose_secret_bytes(),
            bundle.expose_secret_bytes()
        );
        let _ = fs::remove_file(path);
    }
}
