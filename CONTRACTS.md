# Z-Canary contracts

## Memo v1

Offsets use half-open ranges. Exactly 512 bytes:

| Offset | Bytes | Field |
|---|---:|---|
| 0 | 1 | ZIP 302 prefix 0xFF |
| 1..5 | 4 | ASCII ZCAN |
| 5 | 1 | Version 1 |
| 6 | 1 | Network: 0 mainnet, 1 testnet; app uses testnet |
| 7 | 1 | Operation: 1 register, 2 postpone, 3 cancel |
| 8..40 | 32 | Switch ID |
| 40..48 | 8 | Sequence, unsigned little-endian |
| 48..52 | 4 | Requested expiry, unsigned little-endian; cancel uses zero |
| 52..84 | 32 | Manifest SHA-256 digest |
| 84..116 | 32 | Source Ed25519 public key |
| 116..448 | 332 | Zero padding |
| 448..512 | 64 | Ed25519 signature |

Signature message is UTF-8 `ZCANARY-MEMO-SIG-V1` concatenated with bytes 0..448. Sign the message directly with Ed25519, with strict RFC 8032 verification. This corrects the upstream contract's inconsistent prehash wording and publicly computable substitute signature. The Rust implementation verifies the same message against the shared TypeScript fixture.

The encoder requires a 32-byte secret seed matching the supplied public key. It rejects numeric overflow, negative values and malformed hex instead of truncating. Registration uses sequence zero; later commands use positive sequences; the reducer enforces monotonicity and manifest binding.

## Signed manifest and package formats

`canonicalManifestBytes` in `src/engine/protocolStore.ts` defines the current ordered JSON representation. The source signs those bytes; `manifestDigestHex` is their SHA-256. Signatures and the digest are excluded from the signed object. The recipient fingerprint is derived and checked. The public fixture in `backend/fixtures/typescript-v1.json` verifies byte-exact agreement with Rust. Maximum plaintext is 10 MiB; signed encrypted-package size is capped at 10 MiB + 64 KiB for format overhead.

The browser package format is `ZCAN-DEMO-X25519-AES256GCM-V2`. X25519 shared material is expanded with HKDF-SHA256, using ephemeral-public-key || recipient-public-key as salt and the format's inner domain as info. Each AES-GCM layer uses a random 12-byte nonce and its own domain as AAD. It is a demo composition, not the target age file format.

## Local API

`zcanary-agent` implements the routes below. The listener is loopback-only, browser origins are explicitly allowlisted, and actual `/v1` operations require bearer authentication. Native routes require a configured runtime; otherwise they return structured HTTP 503 `ERR_WALLET_UNAVAILABLE`, never a simulated success. Status reports actual configured availability and keeper health.

Implemented routes:

```text
GET  /v1/status
GET  /v1/evidence
POST /v1/memos/verify
GET  /v1/runtime
POST /v1/runtime/stop
GET  /v1/fees
GET  /v1/vaults
POST /v1/vaults
POST /v1/vaults/{id}/register
POST /v1/vaults/{id}/postpone
POST /v1/vaults/{id}/cancel
GET  /v1/vaults/{id}
GET  /v1/vaults/{id}/events
GET  /v1/vaults/{id}/package
POST /v1/vaults/{id}/provision
GET  /v1/operations/{id}
POST /v1/operations/{id}/retry
GET|POST /v1/support-request
POST /v1/recipient/identity
GET  /v1/recipient/inbox
POST /v1/recipient/vaults/{id}/decrypt
POST /v1/identity/{source|recipient}/export
POST /v1/identity/{source|recipient}/import
```

`POST /v1/vaults` accepts `fileName`, `contentsBase64`, `recipient`, the acknowledged `recipientFingerprint`, `intervalBlocks`, `graceBlocks` and `confirmationTarget`. Native plaintext is capped at 10 MiB. The create request body allowance is 16 MiB for base64/JSON; identity backup routes allow 512 KiB; ordinary requests allow 16 KiB. Unknown security overrides are rejected. The native controller chooses keeper keys and the maximum extension policy.

Commands return an `operationId`; polling returns `submitted`, `broadcast`, `confirmed` or `failed`, with a txid/block height when available. Confirmation requires matching UFVK-recovered memo evidence. A failed operation blocks new commands until its existing journal is explicitly resumed; an ambiguous wallet send is not blindly repeated. Cancellation submission does not imply keeper cancellation.

Vault detail exposes `lifecycle`, `expiryHeight`, `requestedExpiryHeight`, `keeperLastSequence`, `keeperAgreement`, verified acknowledgements, share count, events and last operation. Lifecycle, actual expiry and sequence require at least three responding keepers and agreement among every responding keeper; otherwise lifecycle is `SYNCING` and agreement is zero. `requestedExpiryHeight` is the controller's request, not evidence that keepers applied it. u64 sequences remain decimal strings.

`GET /v1/fees` returns integer `feeZatoshi`, `noteAmountZatoshi`, `totalZatoshi` and `spendableZatoshi` for testnet. The fee comes from an actual unsigned wallet proposal with the command's destination, amount and memo size; no transaction is broadcast. The send recalculates against current state. Support returns a separate shielded address and ZIP-321 URI with no evidence identifier or memo.

Identity export accepts `{passphrase}` and returns `{version:1,role,fingerprint,encryptedBase64}`. Import accepts `{passphrase,expectedFingerprint,backup}`. Roles and the full public fingerprint are bound inside passphrase-encrypted age ciphertext. Wrong passwords/context fail, same-key import is idempotent, and replacement of another identity is prohibited. These identity-only backups do not contain wallet seeds, dossiers, command journals or keeper databases.

Package export verifies its digest/size against the signed manifest before returning ciphertext. Recipient decryption requires at least three validated distinct shares and the recipient identity, and returns `{fileName,contentsBase64,digestHex}`. The browser verifies the resulting digest before download. Native private keys remain in local processes; public evidence reports contain no keys or plaintext.

## Wallet adapter and keeper transport

The packaged wallet harness implements `status`, `estimate-command`, `live-command`, `checkpoint`, `export-viewer` and `scan-batch`. Its encrypted recovery is persisted before addresses are exposed. Read-only fee estimation and scanning are separate from the send path; each command's immutable memo digest identifies its durable send journal.

Every scanned event must carry network, height, block hash, transaction ID, output index, memo bytes and confirmation status. Transaction order is also needed for canonical processing within a block. Do not promote generated fixtures into this adapter.

The live adapter supplies complete contiguous confirmed blocks, including empty blocks, with canonical hash linkage and ordered transaction/output positions. Separate authenticated keeper services accept explicit `testnet-chain` or `synthetic-chain` batches; modes cannot be mixed. They verify source memos and provisioning envelopes before persistence, and require fresh healthy scan state for outbox dispatch. Keeper vault state returns `expiry_height` and `last_sequence` as decimal strings or null. See [live acceptance](docs/evidence/native-live-acceptance.json) and [extension checks](docs/evidence/native-extensions.json) for exercised integration boundaries.
