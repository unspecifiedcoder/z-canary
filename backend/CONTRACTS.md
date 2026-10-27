# Backend implementation contracts

The eight-crate workspace supplies the native protocol, cryptography, storage, keeper state, keeper HTTP service, local agent, vault CLI and synthetic rehearsal utility. The agent connects the frontend to the separately pinned wallet harness. The full live testnet journey is recorded in [acceptance evidence](../docs/evidence/native-live-acceptance.json); the synthetic rehearsal remains a separate failure-scenario test. The public HTTP routes are documented in [the root contract](../CONTRACTS.md).

## zcanary-core public API

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation { Register, Postpone, Cancel }

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

pub fn decode_and_verify_memo(bytes: &[u8], expected_network: u8) -> Result<Command, CoreError>;
pub fn encode_memo(command: &Command, source_seed: &[u8; 32]) -> Result<[u8; 512], CoreError>;
```

Memo framing/signature matches the repository CONTRACTS.md exactly. Public Command is data, not proof of verification; trust boundaries decode and verify raw bytes. Core also owns canonical manifest bytes, signing, digest computation and validation. The pinned TypeScript fixture verifies cross-language wire agreement.

Document plaintext remains capped at 10 MiB. Manifest encrypted package size permits 10 MiB + 64 KiB for age framing and authenticated-encryption overhead; it is not a larger document allowance. Both TypeScript and Rust validate this envelope cap.

## zcanary-keeper boundary

Keeper depends on zcanary-core by path and verifies every raw memo before applying it. Keeper owns policy/registration, scanned block/event and durable state types. Network is fixed per keeper. A scanned batch includes every contiguous block, including empty blocks, with height/hash/previous hash, ordered transactions/outputs and a confirmed-through height. Reject gaps, hash discontinuities, out-of-order/duplicate positions and unsupported networks. Suspend on reorg; do not claim canonical replay unless implemented and tested.

Registration binds switch ID, manifest digest, source public key, positive initial interval/max extension/confirmation count, nonnegative grace, epoch, keeper identity/index and an opaque already-encrypted recipient share envelope. The library stores no release key or plaintext share. Its provisioning records are trusted internal inputs: the authenticated keeper service first verifies the source manifest, opens its keeper-specific envelope, validates context and commitment, then encrypts the delivery to the designated recipient before storage. Signed durable acknowledgements bind keeper identity/index, switch, epoch, manifest and envelope digest; the controller verifies all five before REGISTER.

Process commands through the inclusive grace boundary before release. Release state and outbox insertion share one SQLite transaction. Stable idempotency key binds switch, epoch, keeper, manifest. Outbox dispatch requires fresh healthy state/cursor checks; retries preserve key and encrypted payload. Durable cancellation suppresses pending dispatch and cannot recall a previously delivered share. Offline/incomplete scans cannot advance confirmed cursor or release. Persist full u64 sequences losslessly (SQLite INTEGER is signed).

`Keeper::vault_state` reads lifecycle, optional expiry and optional last sequence atomically from applied database state. The service exposes expiry and sequence as decimal strings, avoiding JavaScript precision loss. Native UI consensus reports these applied values separately from requested expiry. Live service scan freshness expires after 120 seconds; restart, scanner failure or invalid batches suspend delivery until a newly verified complete batch succeeds. Reorg detection latches an incident; automatic common-ancestor replay is not implemented.

## zcanary-crypto boundary

Independent package API for age recipient encryption inside authenticated release-key encryption, maximum 10 MiB plaintext. Use cryptographic libraries and OS randomness. Use a maintained secret-sharing library for exact 3-of-5 rather than implementing finite-field operations. Validate every supplied share, including extras, against switch/epoch/keeper/index/commitment. Encrypt individual share envelopes to keeper identities, and provide recipient-bound share delivery packaging. Keep plaintext digest inside encryption. Expose explicit versioned types and test tampering, wrong identities, binary roundtrips and every 3-of-5 subset. Rust age packages intentionally differ from the browser demonstration format.

No real source seed, recipient private key, raw share or release key belongs in logs, checked-in fixtures or API responses. Tests use ephemeral synthetic material or explicitly public test vectors. Dependency versions are explicit, and APIs are checked against official crate sources/docs. Passing library tests alone does not establish wallet integration, independent operators or production security.

## Native identity and wallet boundary

The Windows vault CLI isolates source and recipient roles and stores keys under CurrentUser DPAPI. It signs immutable memo journals before returning a command, validates recipient envelopes before acknowledgement, and performs final decryption only after validating every supplied share. Export/import wraps identities in passphrase-encrypted age backups with role and public fingerprint binding. Existing different identities cannot be overwritten; identity-only import cannot reconstruct command journals or other missing runtime state.

The wallet process owns spending recovery; keeper scanning receives only an encrypted UFVK capability. `estimate-command` reads the actual ZIP-317 proposal fee without broadcasting. Live sends persist an uncertain-broadcast marker before submission and retain it on ambiguity. Runtime operations, filenames and provisioning records are encrypted in local control state; public evidence exports omit their secrets. No production anonymity or independently operated keeper network is claimed.
