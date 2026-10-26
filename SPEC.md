# Z-Canary Protocol Specification (`SPEC.md`)

## 1. System Overview & Threat Model

**Z-Canary** is a Zcash-powered continuity vault ("dead-man's switch"). A **Source** encrypts a confidential dossier to a single designated **Recipient**, wraps that package in an ephemeral outer **Release Key**, splits the Release Key into $n=5$ shares with threshold $k=3$ via Shamir's Secret Sharing over $GF(2^8)$, and provisions five independent **Keepers**.

To keep the vault locked, the Source periodically broadcasts signed 512-byte commands carried inside Zcash shielded transaction memos (ZIP-302 format). Keepers hold only an incoming viewing key (IVK) for the registry address, scanning confirmed blocks. If the confirmed scan cursor crosses the vault's `expiry_height + grace_blocks` without a valid signed check-in or cancellation command, at least 3 honest Keepers release their shares to the Recipient.

### Core Security Guarantees
1. **Before Release (Active/Grace)**: Neither the Keepers (who lack the Recipient's private X25519 key) nor the Recipient (who lacks the outer Release Key held in 3-of-5 shares) can decrypt the dossier.
2. **After Release**: Only the designated Recipient holding the matching X25519 private key can unwrap the inner envelope after reconstructing the outer Release Key from $\ge 3$ verified Keeper shares.
3. **Command Integrity**: Only commands signed by the Source's registered Ed25519 command-verification key with a strictly increasing `sequence` number and matching `manifest_digest` are accepted by Keepers.
4. **Unlinked Support**: Public funding requests use a separate Orchard unified address (`u1...`) via ZIP-321 with zero vault or document identifiers.

### Explicit Trust & Privacy Limitations
- **3-of-5 Collusion**: Three colluding Keepers can prematurely reconstruct the outer Release Key and deliver it to the Recipient before the deadline. However, colluding Keepers still cannot read the plaintext without the Recipient's private key.
- **Network Metadata**: `zingolib` communicates with `lightwalletd` servers, exposing IP-level metadata and transaction timing unless routed through Tor/mixnets. Z-Canary does not claim network-layer anonymity.
- **No Revocation After Release**: Once shares are dispatched to the Recipient after grace expiry, subsequent cancellation commands cannot recall delivered key material.

---

## 2. Cryptographic Composition

1. **Recipient Identity**: X25519 keypair $(sk_R, pk_R)$. Fingerprint is the first 16 bytes of $\text{SHA-256}(pk_R)$ formatted in colon-separated hex groups.
2. **Inner Layer (Recipient-Bound)**: Document plaintext $M$ is encrypted to $pk_R$ using an ephemeral X25519 keypair + HKDF-SHA256 + AES-256-GCM (or `age` v1 X25519 stanza), yielding inner ciphertext $C_{\text{inner}}$.
3. **Outer Layer (Release-Key-Bound)**: A random 256-bit `ReleaseKey` $K_{\text{rel}}$ and 96-bit nonce encrypt $C_{\text{inner}}$ with AES-256-GCM, yielding outer package $C_{\text{outer}}$ with digest $D_{\text{pkg}} = \text{SHA-256}(C_{\text{outer}})$.
4. **Threshold Splitting**: $K_{\text{rel}}$ is split into 5 shares $(x_i, y_i)$ for $i \in \{1..5\}$ over $GF(2^8)$ using irreducible polynomial $x^8 + x^4 + x^3 + x + 1$ (`0x11B`) with degree $k-1 = 2$.
5. **Share Commitments**: Each share $S_i$ is bound to commitment $H_i = \text{SHA-256}(\text{"ZCAN-SHARE-V1"} \parallel \text{switch\_id} \parallel i \parallel S_i)$ and recorded in the immutable Manifest.

---

## 3. Keeper State Machine & Invariants

```text
DRAFT ──► REGISTERING ──► ACTIVE ──► GRACE ──► RELEASED
                            │          │
                            └──────────┴─────► CANCELLED
```

### State Transition Rules
- **`DRAFT` $\rightarrow$ `REGISTERING`**: Triggered when the Keeper verifies its provisioned share against $H_i$ in the signed Manifest and persists the share to SQLite.
- **`REGISTERING` $\rightarrow$ `ACTIVE`**: Triggered when a confirmed `REGISTER` (`op = 0x01`, `seq = 0`) memo matching `switch_id`, `manifest_digest`, and `source_pubkey` reaches the required confirmation depth (6 blocks normal, 2 blocks testnet demo).
- **`ACTIVE` $\rightarrow$ `ACTIVE`**: Triggered by a valid `POSTPONE / CHECK_IN` (`op = 0x02`, `seq > last_seq`, `new_expiry > current_expiry`, `new_expiry <= scan_height + max_extension`).
- **`ACTIVE` $\rightarrow$ `GRACE`**: Triggered when `confirmed_scan_height >= expiry_height` and no valid postponement or cancellation has been processed.
- **`GRACE` $\rightarrow$ `ACTIVE`**: Triggered if a valid `POSTPONE / CHECK_IN` command is mined and confirmed at or before `expiry_height + grace_blocks`.
- **`ACTIVE` | `GRACE` $\rightarrow$ `CANCELLED`**: Triggered immediately upon confirming a valid `CANCEL` (`op = 0x03`, `seq > last_seq`) memo. Terminal state.
- **`GRACE` $\rightarrow$ `RELEASED`**: Triggered only when `confirmed_scan_height >= expiry_height + grace_blocks`, scanner health is `HEALTHY`, chain continuity is verified, and state revalidation passes. Terminal state.
