# Z-Canary specification

## Product model

Canary encrypts a document for a designated recipient and wraps that ciphertext in a second encryption layer controlled by a release key. Five keepers receive separately encrypted shares of that key. The source signs lifecycle commands; a timely confirmed check-in postpones release. After expiry and the inclusive grace boundary, three valid keeper shares plus the recipient's private identity permit recovery.

Three colluding keepers can deliver early to the recipient. Cancellation cannot recall delivered key material. Zcash lightwallet servers can observe network metadata. Five processes on one machine are not five independent operators. There is no deployed smart contract: the implemented coordination channel is signed Zcash shielded transaction memos and off-chain keeper state machines.

## Current implementation and evidence

The React/Vite application separates its browser demonstration from an authenticated Windows native testnet workspace. The browser demo uses actual Ed25519, X25519, HKDF-SHA256, and AES-256-GCM from pinned Noble libraries, but its lifecycle and chain are simulated. Its package format is `ZCAN-DEMO-X25519-AES256GCM-V2`, not age. Its handcrafted Shamir implementation is demonstration code. Demo actor records are in memory and reset on reload; do not use it for sensitive evidence.

The eight-crate Rust workspace implements signed protocol contracts, age recipient encryption, XChaCha20-Poly1305 release encryption, `vsss-rs` sharing, encrypted identity storage, SQLite keeper state and outboxes, an authenticated loopback agent, keeper service processes, a rehearsal utility, and a Windows DPAPI vault CLI. The native agent connects these components to the separately pinned Zingolib wallet harness. Native unavailable states do not fall back to simulated success.

Verification snapshot on October 27, 2026:

- **66 unique Rust tests passed**: agent 14, core 5, crypto 11, keeper 17, keeper service 4, storage 8, vault CLI 7. The final agent rerun is included after the workspace run in [test evidence](docs/evidence/backend-tests.txt). Windows integration covers DPAPI restoration, identity-role separation, exact command retries, encrypted identity backup/import, three-share decryption and two-share rejection. **32 frontend tests, TypeScript checking and the Vite build passed.**
- The five-process rehearsal completed **12 checks and exited successfully**. It used five actual processes, identities, ports and databases, real encryption and authenticated delivery, but **synthetic chain input**. It includes cancellation at the inclusive boundary, restart suspension, exact three-share recovery with two keepers offline, and failed recovery with two shares. See [rehearsal evidence](docs/evidence/five-process-rehearsal.json).
- Three genuine shielded testnet commands—REGISTER, POSTPONE and CANCEL—were sent and their exact 512-byte memos recovered by a separate UFVK-only scanner. They are public transport fixtures, not evidence that a protected document's full live lifecycle completed. See [transport evidence](docs/evidence/testnet-transport.json) and [wallet gate](docs/WALLET-SPIKE.md).
- The complete native API → shielded testnet → keeper → recipient journey passed **15 checks with four live transactions**. The released vault delivered five validated shares and recovered the original 136 bytes with SHA-256 `e05e833a180c72954315c0165cf79dc921221065f65263b408bcf99ba362d2d2`; the cancelled vault delivered none. [Live acceptance evidence](docs/evidence/native-live-acceptance.json).
- [Direct inspection of all five keeper databases](docs/evidence/live-postpone-databases.json) verified applied POSTPONE sequence 1 and expiry extension from 4,546,757 to 4,546,761. A later read-only restart audit preserved cancellation at sequence 2 with zero shares, and release at sequence 0 with five shares. The live run did not catch an exact two-share window; that threshold rejection is covered by the crypto tests and synthetic rehearsal.
- [Five extension checks](docs/evidence/native-extensions.json) passed: actual wallet fee estimation, integrity-checked ciphertext/event export, source and recipient encrypted identity export/same-key import with wrong-passphrase rejection, and a separate support request without evidence identifiers or a memo.

The custom Three.js experience and six-stage guided journey are explicitly simulated and resettable. Real browser checks covered desktop, tablet and mobile layouts, all six stages, autoplay/reset, and the connected native recipient decryption flow. See the final [verification record](docs/evidence/VERIFICATION.md) for visual QA scope and remaining limits; these checks are not a production security or performance audit.

## Native flow and security boundaries

The source creates a recipient-encrypted package, wraps it under a random release key, signs the immutable manifest, and provisions five keeper-specific envelopes. It verifies five signed durable acknowledgements before submitting REGISTER. Separate source and recipient identity directories enforce role separation. Windows DPAPI protects native local identities and control state. The API and UI export passphrase-encrypted age identity backups and restore the same identity with fingerprint/role checks; replacement of a different existing key is refused. These are identity-only backups: wallet recovery, packages, command journals and keeper databases require their own preservation.

The wallet harness persists encrypted recovery before exposing a funding address, checks shielded spendability before marking a send as potentially broadcast, journals commands by memo digest, and refuses an ambiguous resend. Its batch adapter uses a separate UFVK capability without spending authority. The five keeper processes independently validate and apply a complete ordered batch supplied by the local scanner; they do not each independently establish chain consensus against different servers.

The authenticated loopback agent accepts bounded requests and exact allowed browser origins. Native file encryption and recovery run in subprocesses; animation state and browser demonstration fixtures never receive native private keys. Recipient deliveries are cryptographically validated before persistence and acknowledgement. A persisted delivery retry must match its prior encrypted payload.

## Lifecycle rules

`DRAFT → REGISTERING → ACTIVE → GRACE → RELEASED`, with `ACTIVE/GRACE → CANCELLED`. REGISTERING is the application operation state; keeper state remains DRAFT until it applies a valid confirmed registration.

- Process events in block, transaction and output order. Accept only confirmed events matching the signed manifest, switch, network and source key.
- Registration sequence is zero. Mutations require a strictly larger sequence. Cancelled and released states are terminal.
- A confirmed scan endpoint is `tip - confirmations + 1`. Enter grace at expiry. Process every command included through the inclusive grace boundary before release.
- Postponement must increase expiry and remain within the maximum extension measured from its inclusion height.
- A command included after the grace boundary cannot revive a delayed keeper's expired switch.
- Incomplete, malformed, unavailable or stale scanning prevents delivery. Live services expire scan freshness after 120 seconds without a newly verified complete batch. A long block gap can conservatively suspend service until the next batch.
- Keeper lifecycle and outbox intent persist atomically. Restart suspends dispatch until a fresh complete scan succeeds. A detected discontinuity/reorg latches an incident; automatic common-ancestor replay remains unfinished. Already delivered shares cannot be recalled.

## Cryptographic contracts

See [CONTRACTS.md](CONTRACTS.md) for the fixed memo layout and signature. A canonical signed manifest binds switch, network, source and recipient keys, package digest and size, interval/grace/confirmation policy, maximum extension, keeper IDs, threshold, epoch and share commitments. It contains no filename or dossier description.

The browser demonstration package digest covers its format, nonces, ephemeral public key, ciphertext, plaintext digest and sizes. Rust instead keeps the plaintext digest inside the age-encrypted recipient package and authenticates the outer ciphertext against the signed package digest. Recipient delivery binds the manifest digest and recipient public-key fingerprint.

Every supplied share must match keeper identity, index, switch, epoch, length and manifest commitment, including extra shares beyond the required three. Sharing uses uniformly random polynomial coefficients, including zero. Private keys and plaintext evidence are not written to logs or public evidence reports.

React/Vite is retained instead of migrating to Next.js. This build verifies a locally operated Windows testnet prototype; independent keeper deployment, automatic reorg recovery and a full-machine disaster-recovery workflow remain outside the demonstrated result.
