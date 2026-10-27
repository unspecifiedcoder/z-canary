# zcanary-agent

This crate is an authenticated loopback HTTP scaffold. It can report its current capabilities and verify raw Z-Canary v1 memos through `zcanary-core`.

It does not connect to a wallet, submit transactions, scan chain state, start keeper workers, or release shares. Wallet-dependent vault and support routes return `503 ERR_WALLET_UNAVAILABLE`. The status response reports `testnet`, `simulation: false`, wallet unavailable, and keepers not started.

Run with an existing strong token file:

```text
zcanary-agent --token-file PATH [--listen 127.0.0.1:8787] [--allowed-origin http://127.0.0.1:3000] [--evidence-file PATH]
```

The token file must contain a base64url token with at least 43 characters (256 random bits when generated from 32 random bytes). The service only binds to an explicit loopback IP address. Each browser origin must be added with a repeated `--allowed-origin` option; only exact loopback HTTP origins are accepted. Requests to `/v1` require `Authorization: Bearer ...`.

The repository's Vite development server uses `http://127.0.0.1:3000`; allow that exact origin when connecting from the web app. If the app is opened at `http://localhost:3000`, allow that origin separately. The browser's bearer token field is kept in tab memory only.

`POST /v1/memos/verify` accepts JSON `{ "memoHex": "..." }` for exactly 512 memo bytes. It returns decoded public command fields only after strict signature verification. Request bodies are capped at 16 KiB.

An optional `--evidence-file PATH` loads one local JSON report at startup. It is read once, capped at 256 KiB, and validated before the service starts. `GET /v1/evidence` returns only the versioned whitelist schema (or `{ "available": false }` when no report is configured); no path is accepted over HTTP. The schema is `{ "version": 1, "label": "...", "runs": [{ "label": "...", "mode": "testnet" | "synthetic-chain", "checks": [{ "name": "...", "passed": true }], "transactions": [{ "label": "...", "txid": "64 hex characters", "blockHeight": 123, "network": "testnet" }], "limitations": ["..."] }] }`. Synthetic-chain runs cannot contain transactions. Unknown fields, invalid transaction IDs, oversized text/arrays, and unsupported versions are rejected. Evidence content is a configured operator assertion; the API does not verify the source artifacts itself.
