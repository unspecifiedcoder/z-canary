# Z-Canary Implementation Contracts (`CONTRACTS.md`)

## 1. Frozen 512-Byte Shielded Memo Format (ZIP-302)

All on-chain registry commands use a fixed 512-byte binary layout carried in a shielded Orchard/Sapling output memo field.

| Byte Offset | Length (Bytes) | Field Name | Encoding / Constraint |
|---:|---:|---|---|
| `0` | `1` | `zip302_prefix` | Must be `0xFF` (arbitrary binary memo indicator per ZIP-302) |
| `1..5` | `4` | `app_magic` | ASCII `"ZCAN"` (`0x5A, 0x43, 0x41, 0x4E`) |
| `5` | `1` | `version` | `0x01` (v1 protocol) |
| `6` | `1` | `network` | `0x01` = Zcash Testnet, `0x00` = Zcash Mainnet |
| `7` | `1` | `operation` | `0x01` = Register, `0x02` = Check-In/Postpone, `0x03` = Cancel |
| `8..40` | `32` | `switch_id` | 32-byte unique vault identifier |
| `40..48` | `8` | `sequence` | `u64` Little-Endian (`0` for Register, `> prev` for subsequent) |
| `48..52` | `4` | `requested_expiry` | `u32` Little-Endian block height (`0` for Cancel) |
| `52..84` | `32` | `manifest_digest` | SHA-256 digest of deterministic canonical Manifest bytes |
| `84..116` | `32` | `source_pubkey` | 32-byte Ed25519 public key of the Source |
| `116..448` | `332` | `zero_padding` | Must be 332 bytes of `0x00` (non-zero bytes rejected) |
| `448..512` | `64` | `signature` | Ed25519 signature over `SHA-256("ZCANARY-MEMO-SIG-V1" || bytes[0..448])` |
| **Total** | **512** | | |

---

## 2. Local Agent HTTP API Contract (`/v1/*`)

### `GET /v1/status`
Returns current wallet sync status, network identifier, confirmed block height, and 5-keeper health summary.

### `POST /v1/vaults`
Creates a `DRAFT` vault, performs dual-layer encryption, splits the release key into 5 shares, and provisions Keepers.
- **Request**: `{ fileName, fileSize, plainBytesBase64, recipientPubKey, intervalBlocks, graceBlocks }`
- **Response**: `{ vaultId, manifest, keeperAcks: [1..5], status: "REGISTERING" }`

### `POST /v1/vaults/{id}/register`
Signs and broadcasts the sequence `0` registration memo (`op = 0x01`).
- **Response**: `{ operationId, txid, memoHex, status: "BROADCAST" }`

### `POST /v1/vaults/{id}/postpone`
Signs and broadcasts sequence `N+1` check-in/postponement memo (`op = 0x02`).
- **Request**: `{ additionalBlocks: number }`
- **Response**: `{ operationId, txid, sequence, newExpiryHeight, memoHex }`

### `POST /v1/vaults/{id}/cancel`
Signs and broadcasts sequence `N+1` cancellation memo (`op = 0x03`).
- **Response**: `{ operationId, txid, sequence, status: "CANCELLED" }`

### `POST /v1/recipient/vaults/{id}/decrypt`
Verifies $\ge 3$ distinct Keeper shares against manifest commitments, interpolates the outer Release Key over $GF(2^8)$, unwraps the inner X25519 package, and verifies SHA-256 integrity.

---

## 3. Error Codes

| Code | HTTP | Meaning |
|---|---:|---|
| `ERR_MEMO_INVALID_MAGIC` | 400 | Bytes `1..5` do not match `ZCAN` (`0x5A43414E`) |
| `ERR_MEMO_NONZERO_PADDING` | 400 | Reserved padding bytes `116..448` contain non-zero values |
| `ERR_MEMO_STALE_SEQUENCE` | 409 | Command sequence number is $\le$ highest processed sequence |
| `ERR_MEMO_BAD_SIGNATURE` | 401 | Ed25519 signature verification failed against `source_pubkey` |
| `ERR_SHARE_COMMITMENT_MISMATCH` | 422 | Reconstructed share does not match manifest commitment $H_i$ |
| `ERR_THRESHOLD_INSUFFICIENT` | 422 | Fewer than 3 valid distinct shares provided |
| `ERR_SCANNER_UNHEALTHY` | 503 | Keeper scan cursor is lagging or reorg incident is active |
