# Rust backend

The eight-crate workspace provides the signed command protocol, native encryption, SQLite keepers, authenticated local API, and testnet wallet orchestration. The browser also contains a separately labelled simulation. A simulation does not submit transactions or establish on-chain evidence.

## Build and verify

Install Rust 1.99.0. Windows builds require the Visual C++ x64 build tools and Windows SDK. From this directory:

```sh
cargo +1.99.0 test --locked --workspace -j 1
cargo +1.99.0 build --locked -p zcanary-agent -p zcanary-keeper-service -p zcanary-vault-cli -j 1
```

Use one Cargo invocation and one build job at a time on memory-constrained machines. The lockfile is included. The separate wallet harness also pins its upstream Zingolib revision.

## Components

| Crate | Responsibility |
|---|---|
| `zcanary-core` | Strict signed 512-byte commands, canonical signed manifests, policy validation, TypeScript interoperability |
| `zcanary-crypto` | age X25519 inner encryption, XChaCha20-Poly1305 outer encryption, 3-of-5 sharing, committed keeper provisioning, recipient-bound delivery |
| `zcanary-keeper` | SQLite lifecycle, confirmation coverage, inclusive grace boundary, durable outbox, restart/reorg suspension |
| `zcanary-agent` | Authenticated loopback API, native orchestration, signature-checked keeper acknowledgements, durable operations and recipient inbox |
| `zcanary-storage` | Bounded age scrypt-encrypted identity bundles and atomic export/import primitives |
| `zcanary-keeper-service` | Separate keeper process with encrypted identity, signed provisioning acknowledgement, confirmed-block processing and encrypted share delivery |
| `zcanary-demo` | Synthetic-chain five-process rehearsal and recipient-side threshold verification |
| `zcanary-vault-cli` | Separate source/recipient identities, native file encryption, signed command journals, share validation and threshold decryption |

The native crypto package differs from the browser simulation format. Recipient fingerprints hash the raw 32-byte X25519 public key; the displayed manifest fingerprint contains the first 16 hash bytes. Package encryption and share commitments precede manifest signing. Recipient delivery envelopes bind to the signed manifest digest.

## Run the native testnet workflow on Windows

Use PowerShell 7.2 or later. Pass the existing wallet state directory explicitly: it must contain the current Windows user's `recovery.dpapi`. The launcher does not create another wallet, claim faucet funds, or move wallet state.

From the repository root:

```powershell
# Optional: reuse an existing build cache by setting CARGO_TARGET_DIR first.
./backend/scripts/run-native.ps1 -WalletStateDir 'C:\absolute\path\to\existing-wallet-state' -AllowedOrigin 'http://127.0.0.1:3000'
```

The launcher verifies the pinned upstream checkout, builds the wallet and native services sequentially with Rust 1.99.0, and starts an agent on `127.0.0.1:8787`. `-RuntimeStateDir` selects the runtime directory; its default is `backend/state/native`. `-Port` changes the loopback port. `-SkipBuild` uses already built binaries in the same target directory. An explicitly configured `CARGO_TARGET_DIR` is honored; otherwise binaries use `backend/target`.

The runtime restores the wallet, exports a DPAPI-protected viewing capability, and starts five isolated keeper processes with separate databases and encrypted identities. Startup and testnet synchronization can take several minutes. Start the frontend in another terminal with `npm run dev`. In Native Testnet, enter the loopback agent URL and the bearer token from the private file whose path the launcher prints. The token itself is never printed by the launcher and must not be saved in browser localStorage, URLs, logs or screenshots.

Create a recipient identity, verify its fingerprint, select evidence and a block-based policy, then create the native vault. All five provisioning acknowledgements must verify before REGISTER. Registration, check-in (POSTPONE), and cancellation are signed testnet memo transactions. A transaction observed by the wallet does not by itself mean all keepers have processed it: the interface polls keeper lifecycle separately. Recipient decryption requires three distinct, validated recipient-bound shares and verifies the recovered file digest.

Press Ctrl+C in the launcher to request local runtime shutdown. Preserve all state if shutdown or a transaction fails. In particular, never delete or clear a `broadcast-unknown` wallet journal to force a retry. An operation retry uses the same signed memo and durable wallet journal; an ambiguous send remains blocked against duplication. DPAPI recovery is bound to the Windows account, so copying those files alone is not a portable identity backup. Use the passphrase-encrypted identity export described below for source or recipient keys.

### Local architecture and limitations

This is a local testnet deployment: five keeper **processes on one machine**, controlled by one local runtime. They independently validate/apply the same complete block batch, while a serialized UFVK-only scanner retrieves testnet data from the pinned lightwallet server. This does not demonstrate independently operated or geographically decentralized keepers, independently sourced chain consensus, mainnet readiness, or a security audit. Zcash is used for shielded command memos; there is no deployed smart contract enforcing release.

Native source and recipient keys occupy separate DPAPI-protected role directories. The browser sends file contents only to the authenticated loopback agent; private keys and release shares do not enter presentation state. The local runtime can operate both roles for the demonstration. A production deployment needs separate recipient custody and a delivery transport across independent operators. Source and recipient identity export/import use bounded age scrypt encryption through the storage crate. These are key-only backups, not a complete runtime archive.

Keepers start suspended after restart. A verified complete confirmed batch is required before delivery; malformed input, a checkpoint mismatch or stale scanning suspends release. Live mode requires a verified checkpoint and uses the `testnet-chain` adapter label. The synthetic rehearsal explicitly uses `synthetic-chain`; those batches are not accepted by a keeper running in live mode.

## Authenticated HTTP API

Without `--runtime-config PATH`, the agent still supports status, evidence and signed memo verification; native wallet routes return HTTP 503 with `ERR_WALLET_UNAVAILABLE`. With a valid runtime configuration, the same routes perform native operations. The server only binds loopback, requires a bearer token for every `/v1` route, and permits only exact explicitly allowlisted loopback browser origins. Responses disable caching.

| Route | Meaning |
|---|---|
| `GET /v1/status`, `GET /v1/runtime` | Actual configured capabilities and keeper availability |
| `GET /v1/fees` | Build an actual wallet command proposal to report its fee, note amount, total and spendable funds; never broadcasts |
| `GET /v1/evidence` | Optional bounded, schema-validated evidence report loaded at startup |
| `POST /v1/memos/verify` | Verify a signed testnet command; sequence numbers remain decimal strings |
| `POST /v1/recipient/identity` | Create or restore the local recipient identity and public fingerprint |
| `GET /v1/vaults`, `POST /v1/vaults` | List vaults or encrypt/provision a new vault |
| `GET /v1/vaults/{id}` | Keeper lifecycle, verified acknowledgements and delivery count |
| `GET /v1/vaults/{id}/events` | Recorded local lifecycle and delivery events |
| `GET /v1/vaults/{id}/package` | Download the ciphertext package and its signed manifest after digest validation |
| `POST /v1/vaults/{id}/provision` | Retry incomplete provisioning with the same signed manifest |
| `POST /v1/vaults/{id}/{register,postpone,cancel}` | Persist and submit a signed shielded command |
| `GET /v1/operations/{id}` | Submitted, broadcast, confirmed or failed operation state |
| `POST /v1/operations/{id}/retry` | Resume the same failed operation without changing its signed command |
| `GET /v1/recipient/inbox` | Native recipient delivery state |
| `POST /v1/recipient/vaults/{id}/decrypt` | Validate threshold shares and return the recovered file and digest |
| `POST /v1/identity/{source,recipient}/export` | Export a passphrase-encrypted identity backup with its public fingerprint |
| `POST /v1/identity/{source,recipient}/import` | Restore into an empty role directory, or verify an identical existing identity |
| `GET /v1/support-request` | Testnet funding URI for the wallet, separate from the command registry address |
| `POST /v1/runtime/stop` | Stop the local keeper runtime |

Mutating requests require `application/json`. Vault creation has a 16 MiB encoded request limit and a 10 MiB evidence file limit; identity backup routes have a 512 KiB encoded limit; other routes retain a 16 KiB body limit. The browser cannot override keeper recipients or the maximum extension policy. Native create fields are `fileName`, `contentsBase64`, `recipient`, `recipientFingerprint`, `intervalBlocks`, `graceBlocks`, and `confirmationTarget`. Identity export uses `{passphrase}`. Identity import uses `{passphrase, expectedFingerprint, backup}`. Other POST requests above use `{}`. Never interpret an HTTP error or wallet broadcast as successful keeper activation.

For a minimal status/memo-only server, provide a private base64url token file of at least 43 characters:

```sh
cargo +1.99.0 run --locked -p zcanary-agent -- --token-file state/agent-token --allowed-origin http://127.0.0.1:3000
```

From the repository root, run the real-process API smoke test with the built binary path (append `.exe` on Windows):

```sh
node backend/scripts/smoke-agent.mjs backend/target/debug/zcanary-agent
npm run demo:keepers
```

The five-process rehearsal uses real cryptography, authenticated HTTP and independent SQLite files with synthetic blocks. Testnet command transport has separately demonstrated REGISTER, POSTPONE and CANCEL with exact memo recovery by a viewing-only scanner. The final integrated native runtime acceptance record and current test counts are tracked in `../docs/evidence/VERIFICATION.md`; source implementation alone is not proof of a completed live end-to-end workflow.
## Encrypted identity backups

Export returns a JSON container containing only `version: 1`, `role`, the full 64-character lowercase public `fingerprint`, and `encryptedBase64`. Save that complete object as a `.zcanary-identity.json` file. Use a unique passphrase of 12–1024 UTF-8 bytes, keep it separately, and verify the fingerprint before import. Passphrases travel only in the authenticated loopback request and subprocess stdin; they are not command-line arguments or saved in runtime state. Encryption and import use the storage crate's bounded scrypt work policy.

Export requires an existing identity: create a native vault for a source identity or initialize a recipient identity first. Import checks both the encrypted role/context and the public key derived from the decrypted secret before writing any identity. It never replaces a different key. Importing the same existing key is idempotent. Restoring a missing key is restricted to an otherwise empty role directory and is rejected when the runtime already has vaults; source command journals are never reset or replaced.

An identity backup does **not** contain wallet funds/seeds, file packages, signed manifests, command journals, keeper databases, or delivery receipts. Keep the complete runtime state separately. This feature must not be presented as full disaster recovery or as recovery of an already lost wallet.

Encrypted package download returns a "ZCANARY-ENCRYPTED-PACKAGE-V1" JSON container with the signed manifest, ciphertext base64 and the manifest-bound package digest. The digest includes protocol domain and context; it is not the raw SHA-256 of the downloaded JSON or binary. The response omits the original filename and all secret key material. It supplies a ciphertext artifact, not a full state restore bundle.
