# `zcanary-vault-cli`

Native Windows vault cryptography and identity operations for the local controller. This executable does not submit wallet transactions or scan chain data. It communicates through JSON on stdin/stdout; stdout contains exactly one JSON response, and errors go to stderr. Input is capped at 16 MiB. Document plaintext is capped at 10 MiB.

The CLI uses the repository's `wallet-gate/dpapi.ps1` helper through stdin only. Source signing seed, recipient age identity, filename metadata, and role marker are protected with Windows CurrentUser DPAPI before disk writes. No identity or filename is passed in process arguments or written in plaintext. `ZCANARY_DPAPI_HELPER` may point to the helper; otherwise the workspace-relative helper path is used.

Pass a distinct `--state-dir` to recipient and source operations. A DPAPI-protected role marker prevents using the same directory for both roles. Source operations load only `source.identity.dpapi`; they never load recipient identity. `create` writes the signed manifest, encrypted package, protected filename metadata, and immutable command directory under `state-dir/vaults/<switch-id>/`.

## Interface

```text
zcanary-vault-cli --state-dir PATH init-recipient
zcanary-vault-cli --state-dir PATH create
zcanary-vault-cli --state-dir PATH command
zcanary-vault-cli --state-dir PATH accept-share
zcanary-vault-cli --state-dir PATH decrypt
```

All operations read one JSON object from stdin.

### `init-recipient`

Input `{}`. Returns `{ "recipient": "age1…", "fingerprint": "AA:…" }`. Repeated calls return the same CurrentUser-protected identity.

### `create`

Input:

```json
{
  "fileName": "sensitive.pdf",
  "contentsBase64": "…",
  "recipient": "age1…",
  "keeperRecipients": ["age1…", "age1…", "age1…", "age1…", "age1…"],
  "intervalBlocks": 100,
  "graceBlocks": 12,
  "confirmationTarget": 2,
  "maxExtensionBlocks": 1000
}
```

Returns `{id,manifest,provisions,packageDigestHex,packagePath}`. The manifest is the flat camelCase wire form, with `shareCommitments` keyed by `"1"` through `"5"` and signature/digest fields added. Each provision is ready for `/v1/provision`: `{manifest,keeper_index,keeper_recipients,envelope:{version,keeper_id_hex,index,ciphertext_hex}}`. `packagePath` points to the local ciphertext package; it must stay inside the trusted controller and must not be returned to a browser. The filename is stored only in a DPAPI-protected offchain metadata file.

The source seed is generated once in `source.identity.dpapi` and reused for later vaults. The manifest uses testnet network 1 and configuration epoch 1. `create` does not read or need the recipient private identity.

### `command`

Input `{ "id": "<64 hex switch ID>", "operationId": "<32 hex operation ID>", "operation": "register|postpone|cancel", "expiryHeight": 123 }`. Cancel accepts zero or an omitted expiry. Returns `{id,operationId,memoHex,sequence}`; sequence is decimal text. `operationId` is a 16-byte random idempotency key. A retry with the same ID and exact operation/expiry returns the same journaled memo. Reusing it with different command data fails. Sequence zero is reserved for one registration, later commands increment monotonically, and the immutable journal is durably committed before the response is emitted. The keeper validates deadlines against confirmed block height and policy.

### `accept-share`

Input `{ "manifest":{…}, "deliveryHex":"…", "keeperRecipients":["age1…",…] }`. The CLI verifies the signed manifest, local recipient identity, keeper recipient set, delivery context, and that keeper's share commitment before returning `{ "keeperIndex": 1, "keeperIdHex": "…" }`. It never returns the share bytes or reconstructed key. The trusted controller can persist the opaque delivery and acknowledge it only after this validation succeeds.

### `decrypt`

Input `{ "manifest":{…}, "packageBase64":"…", "deliveriesHex":["…","…","…"], "keeperRecipients":["age1…",…] }`. The CLI verifies the signed manifest first, then package size/format and recipient identity, validates every supplied recipient envelope and commitment, reconstructs from at least three distinct valid shares, and authenticates/decrypts the package. Returns `{contentsBase64,digestHex}` through the trusted local pipe. The recipient identity must already exist in this state directory through `init-recipient`.

The service integration remains local: DPAPI binds identities to the current Windows user and device context. This CLI is not a cross-device backup format, a security audit, a wallet adapter, or chain evidence.
