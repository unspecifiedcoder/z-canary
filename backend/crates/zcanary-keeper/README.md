# zcanary-keeper

SQLite-backed keeper state for a single fixed network. This crate stores internal trusted provisioning inputs, applies confirmed raw memo outputs through `zcanary-core`, tracks lifecycle and a contiguous confirmed block cursor, and stages opaque recipient-encrypted envelopes in a transactional outbox.

## Trust boundary and integration limits

`ProvisioningRecord` is a trusted library input. It does not verify a remote provisioning signature or manifest; the authenticated provisioning service must do that before calling `provision`. The encrypted share envelope is treated as opaque bytes and is never decrypted here. A live wallet scanner, canonical-chain proof, scanner-freshness policy, and network delivery transport are not included.

The keeper validates epoch as a positive u32, matching the core manifest and crypto context types. Command sequence is a losslessly stored u64. The deterministic delivery idempotency key is only an identifier and is not a cryptographic release key.

Provisioned records start in `DRAFT`. Only a valid confirmed sequence-zero `REGISTER` memo activates a record. The signed requested expiry must be later than its inclusion height and no later than inclusion plus the configured initial interval. This is a deliberately stricter bound than accepting arbitrary signed expiries. A postponement must increase the expiry and may not exceed its inclusion height plus `max_extension`.

Production initialization uses `Keeper::open_at_checkpoint` with a checkpoint obtained from the wallet adapter after its chain verification. Schema, network/keeper identity, cursor height/hash, health, and incident flags initialize in one SQLite transaction. The first supplied block must be exactly checkpoint height plus one and link to the checkpoint hash. Initialization refuses a checkpoint when durable cursor or block/switch history already exists. Reopen an initialized database with `open_existing`, which preserves its cursor but suspends delivery until a fresh complete scan validates the next contiguous block. `Keeper::open` is a test-only convenience for an implicit height-zero start. These APIs trust their supplied anchor; they do not verify chain identity themselves.

The caller supplies every block after the anchor, including empty blocks, with hashes and previous hashes, plus an observed tip height. The confirmed cursor advances only if observed tip covers `confirmed_through + max_configured_confirmation_count - 1`; the wallet adapter remains responsible for truthful tip/canonicality evidence. This library verifies contiguous heights and hash linkage, but cannot independently prove a supplied block hash is canonical. Incomplete scans and any processing error suspend dispatch, roll back the entire batch, and preserve the prior cursor, lifecycle, outbox, and block history. A later complete batch can recover from a normal outage or incomplete scan. A hash conflict latches a `REORG_INCIDENT`; later contiguous batches cannot clear it without a future verified recovery API. `mark_unhealthy` lets the scanner integration suspend dispatch on offline/freshness failures.

Release occurs when the confirmed cursor reaches expiry plus the inclusive grace period, after processing commands in that boundary block. The observed-tip check ensures the cursor's configured confirmations are already met, so release does not add that count a second time. A command in the final grace block can cancel or postpone. Invalid, unrelated, stale, and late commands have no effect and do not hold the scanner cursor back. The outbox key is deterministic over switch, epoch, keeper identity, and manifest digest. Retries preserve that key and envelope. A cancellation before release prevents an outbox item; a delivered envelope cannot be recalled.

`claim_delivery` requires the caller's expected cursor to match the durable confirmed cursor. The caller-provided cursor is only an optimistic concurrency check; it does not create scanner coverage. Dispatch integrations must call `mark_unhealthy` whenever their independent scanner freshness or canonicality check fails.

The crate has unit tests in source, but no build or test command was run while the root task owns the single Rust build slot.

