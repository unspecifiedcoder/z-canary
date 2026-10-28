# Reproduce recipient delivery locally

The rehearsal exercises real Rust encryption, signed commands, five keeper services, a network mailbox, and recipient decryption. It feeds **synthetic confirmed blocks** and sends no Zcash transaction. It needs no cloud account, funds, or paid service.

## Docker Compose

With Docker Engine and Compose installed, run from the repository root:

```sh
docker compose -f docker-compose.judge.yml up --build --abort-on-container-exit --exit-code-from judge-rehearsal
```

The five keepers, delivery relay, and controller use an internal network. No host ports are published. Each keeper holds a different encryption key and SQLite database. This is one local operator running five services.

The controller prepares two encrypted vaults, cancels one, expires the other, sends three recipient-encrypted share envelopes through the relay, retries delivery, rejects recovery with two shares, and verifies exact recovery with three. It prints the recovered file's SHA-256 and the path of `judge-rehearsal.json`.

Each start uses fresh in-memory keeper/relay storage and a fresh artifact directory. Demo credentials in Compose are public and must never protect real evidence. To copy the generated public results and encrypted fixture artifacts out of the stopped controller:

```sh
docker compose -f docker-compose.judge.yml cp judge-rehearsal:/workspace/artifacts ./rehearsal-artifacts
```

Keep generated artifacts outside version control. The synthetic PDF is public test content. This container rehearsal does not include the Windows DPAPI wallet or a live lightwalletd scanner.

## Without Docker

Build the Rust services with Rust 1.99.0, then run the same controller against local processes:

```sh
cargo +1.99.0 build --locked --manifest-path backend/Cargo.toml -p zcanary-keeper-service -p zcanary-demo
node backend/scripts/local-relay-rehearsal.mjs backend/target/debug/zcanary-keeper-service backend/target/debug/zcanary-demo
```

On Windows append `.exe` to both executable paths. The launcher generates temporary credentials, starts five keeper processes and the relay on loopback, and stops them after completion. It prints a temporary directory holding the report. Credentials remain in process memory/environment; the encrypted identity files cannot be reopened after the launcher exits unless a separate identity recovery workflow is used.

## Delivery relay boundary

`backend/scripts/delivery-relay.mjs` is an optional Node 22 service. Configure `ZCANARY_RELAY_ADMIN_TOKEN` with a random secret of at least 32 characters before starting it. Defaults are loopback port 8790 and `./state/delivery-relay.json`. One process must own a state file.

| Endpoint | Required capability | Behavior |
|---|---|---|
| `POST /v1/mailboxes` | Admin bearer token | Creates a mailbox and returns separate random read/write capabilities once |
| `POST /v1/mailboxes/{id}/deliveries` | Mailbox write bearer token | Stores one encrypted share per keeper; identical retry is idempotent |
| `GET /v1/mailboxes/{id}/deliveries` | Mailbox read bearer token | Retrieves opaque encrypted envelopes |

Capabilities are stored as domain-separated SHA-256 hashes. A mailbox accepts one switch/manifest context and at most five keeper indices. Storage is capped at 128 mailboxes and 8 MiB; each envelope is bounded to the Rust envelope format's 4,105-byte maximum. HTTP bodies/headers are bounded, browser Origin requests are rejected, and responses use `Cache-Control: no-store`.

The relay sees identifiers and delivery metadata. It cannot decrypt the envelopes. The recipient must still verify envelope context, share commitments, the signed manifest, and package digest. A compromised relay can withhold data; a write capability can inject invalid envelopes, which recipient validation must reject. The encrypted evidence package and recipient identity are still provisioned separately. This is not automatic email delivery or a complete browser-to-remote-recipient product flow.

The local JSON store serializes writes, flushes the temporary file before atomic replacement, and publishes state to readers only after persistence succeeds. It is a bounded single-process rehearsal store, not a distributed database. Keep the default loopback/private-network deployment; public hosting requires authenticated TLS transport and operational hardening.

## Verification performed

On 29 October 2026, the local launcher completed the same controller flow over real HTTP and five existing Rust keeper executables on Windows. It recovered the 612-byte synthetic PDF with SHA-256:

```text
f456bc10921252dd2d2536eabf9a7375183f44bf92539bdb874413612216d6da
```

`node --import tsx --test tests/delivery-relay.test.ts` passes four tests covering capability separation, persistence/restart, duplicate conflicts, a failed disk write followed by retry, actual HTTP authorization/isolation, context mismatch, browser-origin rejection, and payload limits.

Docker is unavailable on the verification machine, so the Compose build and Linux container execution remain unverified here. The proven Windows native Zcash testnet run is separately recorded in `docs/evidence/native-live-acceptance.json`; it must not be confused with this synthetic-chain relay rehearsal.
