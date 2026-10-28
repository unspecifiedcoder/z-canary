# `zcanary-keeper-service`

Standalone keeper process for synthetic rehearsals and the native testnet runtime. Each process owns one SQLite database, one age identity encrypted at rest using `zcanary-storage`, and an authenticated HTTP listener. The executable supports `synthetic-chain` and `testnet-chain` modes. Its confirmed-batch endpoint is an authenticated adapter boundary; the keeper itself does not scan Zcash or independently prove that supplied blocks are canonical.

## Start one keeper

Builds are coordinated by the repository owner. After building the workspace binary, run five instances with distinct IDs, databases, and ports:

```powershell
$env:ZCANARY_KEEPER_TOKEN = 'a different random token for each process, at least 32 characters'
$env:ZCANARY_IDENTITY_PASSPHRASE = 'a locally supplied passphrase of at least 32 characters'
zcanary-keeper-service --db .\state\keeper-01.sqlite --keeper-id keeper-01 --network 1 --listen 127.0.0.1:9411 --mode synthetic-chain
```

The same passphrase must be supplied after restart. Database and encrypted identity files must either both exist or both be absent; this prevents silent key replacement or empty-state startup after one file is lost. The service does not print tokens, passphrases, identities, shares, or request bodies. This executable requires testnet (`--network 1`) and an explicit mode. Requests with an `Origin` header are rejected. Every endpoint requires `Authorization: Bearer <token>` and bodies are capped at 256 KiB. Tokens and identity passphrases must each contain at least 32 characters.

For live operation, use `--mode testnet-chain` with `--checkpoint-height` and `--checkpoint-hash` from a verified checkpoint. The native runtime supplies complete confirmed batches from its viewing-only scanner. After startup or restart, a complete accepted batch is required before dispatch. In live mode, the most recent accepted scan must also be no older than 120 seconds; stale scans suspend delivery.

Listeners bind to loopback by default. The Docker rehearsal can opt into an unspecified interface (`0.0.0.0` or `::`) by setting `ZCANARY_ALLOW_PRIVATE_BIND=1`, **only in `synthetic-chain` mode**. Live mode rejects non-loopback addresses even with that setting. The opt-in does not itself enforce network isolation; the supplied Compose file provides a private network without published ports.

## API

### `GET /v1/status`

Returns the mode, fixed network, keeper ID, age recipient, Ed25519 acknowledgement public key, confirmed cursor, and health. Pin `signing_pubkey_hex` out of band for the rehearsal; status is bearer-authenticated but not signed itself.

### `POST /v1/provision`

Body:

```json
{
  "manifest": { "protocolId":"Z-CANARY-V1", "network":1, "switchIdHex":"…", "sourcePubKeyHex":"…", "recipientPubKeyHex":"…", "recipientFingerprint":"…", "packageDigestHex":"…", "packageSize":1234, "initialIntervalBlocks":10, "graceBlocks":2, "confirmationTarget":2, "maxExtensionBlocks":20, "keeperIds":["keeper-01","keeper-02","keeper-03","keeper-04","keeper-05"], "threshold":3, "configurationEpoch":1, "shareCommitments":{"1":"…","2":"…","3":"…","4":"…","5":"…"}, "sourceSignatureHex":"…", "manifestDigestHex":"…" },
  "keeper_index": 1,
  "keeper_recipients": ["age1…", "age1…", "age1…", "age1…", "age1…"],
  "envelope": { "version": 2, "keeper_id_hex": "…", "index": 1, "ciphertext_hex": "…" }
}
```

The service verifies the source-signed canonical manifest and its digest, checks network and keeper slot, checks that all five configured age recipient fingerprints are distinct and that this process owns the recipient for its slot, derives the designated recipient's age key from the signed 32-byte recipient key, decrypts the submitted envelope, and validates the share commitment. It then encrypts the validated share to the designated recipient and stores only that opaque recipient envelope. Repeating provisioning with the same switch and all the same signed metadata returns a fresh signed acknowledgement while retaining the first stored recipient envelope; changing any metadata for an existing switch is rejected. The core manifest currently signs fixed keeper names and share commitments, but does not itself encode the keeper age recipients; the client must supply and consistently pin that recipient list.

On success, HTTP 201 returns a durable signed acknowledgement. Its Ed25519 signature is over:

```text
"z-canary/keeper-provision-ack/v1\0" || keeper_id UTF-8 || keeper_index byte || switch_id[32] || epoch little-endian u32 || manifest_digest[32] || envelope_digest[32]
```

`envelope_digest` is SHA-256 of compact UTF-8 JSON in this exact key order and spelling: `{"version":N,"keeper_id_hex":"…","index":N,"ciphertext_hex":"…"}`. The response carries all signed fields and `signing_pubkey_hex`. Identical provisioning retries are accepted; conflicting provisioning is rejected. The acknowledgement signing key is generated independently from the age keeper identity and both secrets are stored in the encrypted identity bundle.

### `POST /v1/confirmed-batch`

Body has `adapter` matching the configured mode (`synthetic-chain` or `testnet-chain`), `network`, `complete:true`, `confirmed_through`, `observed_tip_height`, and a `blocks` array. Each block contains `height`, 32-byte `hash_hex`, 32-byte `previous_hash_hex`, and transactions; transactions contain 32-byte `txid_hex`, `tx_index`, and outputs; outputs contain matching `tx_index`, `output_index`, and exactly 512 memo bytes as `memo_hex`. Empty blocks are represented with `transactions:[]`. Authenticated requests suspend dispatch before parsing. A malformed or rejected batch leaves the keeper unhealthy until a later complete valid scan is accepted. The keeper library validates contiguous blocks, linkage, order, complete confirmed range, confirmation depth, and every raw command signature. An adapter label or bearer authentication alone does not prove canonical chain evidence; live batches must come from the trusted scanner.

### Delivery

- `GET /v1/next-delivery` claims at most one pending release using the current healthy cursor. It returns `{ "delivery": null }` or a delivery object containing ID, idempotency key, encrypted recipient payload hex, and cursor.
- `POST /v1/ack-delivery` body: `{"delivery_id":1,"delivered":true,"cursor":{"height":23,"hash_hex":"…"}}`. Set `delivered:false` to retain a retryable pending delivery.
- `GET /v1/vaults/{switch_id_hex}` returns the local lifecycle for demo evidence.

The recipient payload remains encrypted. This process does not reconstruct a release key or emit a plaintext share. Three compatible recipient envelopes are still required by the recipient-side threshold flow.

## Limits

The demonstrated deployment runs five locally operated processes on one machine, not independent organizations. A keeper configured for live mode rejects batches labelled `synthetic-chain`. The native runtime's authenticated viewing-only scanner supplies live batches; the keeper trusts that adapter for chain provenance and completeness while separately checking signatures, ordering, confirmation coverage, checkpoint linkage, and release policy. The Compose rehearsal uses synthetic blocks and is distinct from the recorded native testnet run.
