# Z-Canary: Shielded Continuity Vault Implementation Plan

A private dead-man's switch and continuity vault: a source encrypts a sensitive dossier, periodically renews its release deadline through genuine 512-byte Zcash shielded memo commands, receives unlinked shielded support, and authorizes release to a designated recipient through a 3-of-5 keeper committee.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and user experience decisions have been locked following Phase 1 review:

- **Demo Initialization**: Pre-loaded with a synthetic investigative whistleblower dossier (`Project-Canary-Dossier-v4.pdf` & manifest) ready for immediate demonstration, while still supporting custom document upload (up to 10 MiB) with drag-and-drop validation.
- **Chain Progression & Testing Harness**: Interactive mining bar with granular block advancement controls (+1 block, +6 blocks for confirmation, +12 blocks for grace period, and instant expiry simulation) alongside a chain reorganization simulator to prove keeper state resilience.
- **5-Keeper Committee Inspection**: Fully isolated 5-process inspection panel with tabbed individual views showing independent keeper state databases, share commitments, scan cursors, and delivery outboxes.
- **Visual Design & Atmosphere**: Restrained editorial dark-charcoal visual architecture (`#0B0D11` background, `#141820` card surfaces, warm ivory typography, crisp hairline dividers, amber status accents, tabular figures, and zero-pill typography).

---

## 1. Overview & Core Concept

### What It Does
Z-Canary provides a secure digital continuity guarantee for whistleblowers, journalists, and human rights defenders. A source binds an encrypted document package to an immutable cryptographic manifest and distributes threshold key shares to five independent keepers. The source keeps the vault locked by periodically sending Ed25519-signed commands inside 512-byte ZIP-302 shielded transaction memos. If the source goes silent and the grace period expires, the 3-of-5 keeper committee authorizes release and delivers their shares to the recipient, who reconstructs the release key and decrypts the dossier.

### Target Personas
1. **The Source (Whistleblower/Investigative Journalist)**: Requires absolute secrecy for document contents, off-chain metadata privacy, effortless periodic check-ins, unlinked donation receipts for funding gas fees, and a deliberate cancellation fail-safe.
2. **The Recipient (Legal Counsel/Trusted Editor)**: Holds an X25519 identity key, verifies keeper delivery signatures, reconstructs the outer release key from $\ge 3$ shares, and decrypts the document with guaranteed integrity.
3. **The Keeper Node / Auditor**: Monitors the Zcash blockchain scan cursor, verifies source signatures against the manifest, strictly follows the grace period rules, resists unconfirmed chain reorganizations, and releases shares only upon verified timeout.

---

## 2. User Experience & Visual Design

### The 6 Core Views
The application provides a unified workspace with six dedicated views:

1. **Welcome & Threat Model Overview**:
   - Executive briefing on the continuity problem, dual-layer encryption model, and trust assumptions.
   - Role switcher to explore the app as **Source**, **Recipient**, or **Auditor / Keeper Node**.

2. **Create Vault (Source Wizard)**:
   - **Step 1: Document Package**: Drag-and-drop upload with client-side SHA-256 digest computation, file size validation ($\le 10$ MiB), and one-click synthetic sample load.
   - **Step 2: Recipient Verification**: X25519 recipient public key input with hex fingerprint and checksum preview.
   - **Step 3: Cadence & Policy**: Block interval selection (e.g. 8,064 blocks / ~14 days normal, or accelerated 20-block demo mode) and grace threshold (12 blocks).
   - **Step 4: Cryptographic Key Splitting**: Real client-side Shamir polynomial generation ($k=3, n=5$), share commitment hashing, and simulated individual keeper provisioning handshakes with live acknowledgment tracking.
   - **Step 5: Registration Transaction**: Fee calculation, Ed25519 signature of the 512-byte ZIP-302 registration memo, broadcast, and confirmation status.

3. **Vault Detail & Sentinel Console (Source View)**:
   - **Viewport Anchor**: Massive countdown timer and block height gauge (`Current Height` vs `Expiry Height` vs `Grace Boundary`).
   - **Primary Action**: Single high-intent **"Check In"** button that signs sequence $N+1$ and generates a 512-byte shielded memo.
   - **Deliberate Actions**: **"Postpone Deadline"** (with maximum extension boundary) and **"Cancel Vault"** (two-step confirmation with irrevocable warning).
   - **Auditable Event Timeline**: Verified chronological progression (`Package Encrypted` $\rightarrow$ `Keepers Provisioned` $\rightarrow$ `Registration Confirmed` $\rightarrow$ `Check-ins` $\rightarrow$ `Grace` $\rightarrow$ `Authorized / Cancelled`).

4. **Recipient Inbox (Designated Recipient View)**:
   - Three distinct operational states:
     - `Locked`: Vault is active on-chain; keepers are guarding shares; 0/5 shares released.
     - `Grace Period Warning`: Chain has passed expiry height; countdown active; postponement still permitted.
     - `Threshold Reached (3/5 Delivered)`: Keepers have delivered authenticated shares to the recipient inbox.
   - **Interactive Decryption Console**: Recipient provides or generates private X25519 key, polynomial interpolation reconstructs outer key over $GF(256)$, inner AES-GCM layer decrypts plaintext, SHA-256 digest verified against manifest, and document preview / download action is unlocked.

5. **Shielded Support & Funding**:
   - Orchard-compatible payment address (`u1...`) and ZIP-321 payment request link with QR representation.
   - Strict unlinked funding guarantee: Payment requests contain **zero** document identifiers or trackable memos.
   - Gas ledger proving incoming testnet donation can fund subsequent check-in transactions without on-chain linkage.

6. **Evidence, Keeper Committee & Reorg Simulator (Auditor View)**:
   - **5 Independent Keepers**: Tabbed inspection showing Keeper 1 through 5, each with isolated state machine (`DRAFT`, `REGISTERING`, `ACTIVE`, `GRACE`, `RELEASED`, `CANCELLED`), local DB record, stored share commitment, and scan cursor.
   - **Interactive Mining Bar**: Buttons to advance blocks (+1 block, +6 mined blocks for confirmation, +12 blocks into grace, jump to expiry).
   - **Reorg Simulator**: Simulate a 2-block or 8-block chain rollback and verify that keepers rewind scan cursors safely without premature share dispatch.
   - **Raw 512-byte Memo Inspector**: Interactive hex/binary decoder breaking down the exact ZIP-302 layout.
   - **Automated Acceptance Suite**: In-browser test runner testing encryption roundtrip, 2-of-5 share failure vs 3-of-5 success, corrupted signature rejection, and replay protection.

### Visual Identity & Theme Tokens
- **Canvas Base**: `#0B0D11` (rich obsidian charcoal)
- **Surface Elevation**: `#141820` (subtle midnight slate)
- **Hairline Borders**: `#222938` (1px solid crisp border)
- **Typography**: Display sans (`Plus Jakarta Sans`) paired with body (`DM Sans`) and tabular figures (`JetBrains Mono` / `tabular-nums`)
- **Accent Budget**:
  - Warm Gold/Amber (`#F59E0B`): Chain blocks, grace warnings, shielded privacy indicator
  - Emerald Green (`#10B981`): Active vault status, cryptographic match, verified signatures
  - Slate/Muted (`#64748B` / `#94A3B8`): Structural text, metadata separators (`·`)
  - Crimson Alert (`#EF4444`): Cancellation and integrity mismatch warnings

---

## 3. Key Product Decisions & Trade-Offs

| Decision | Chosen Approach | Rationale | Alternatives Considered |
|---|---|---|---|
| **Threshold Scheme** | Shamir's Secret Sharing over $GF(2^8)$ ($k=3, n=5$) | Mathematically provable information-theoretic security; 2 shares reveal zero bits of key; 3 shares restore exact 256-bit AES key | Trusted custodian (single point of failure) or simple multisig (reveals threshold structure publicly) |
| **Memo Specification** | ZIP-302 compliant binary format (fixed 512 bytes, `0xFF` prefix) | Real Zcash protocol standard for shielded binary data; fits seamlessly into Orchard/Sapling memo fields | Custom JSON string (leaks variable-length metadata, violates fixed 512-byte privacy property) |
| **Off-chain Manifest** | Encrypted package & keeper shares stored off-chain; only 32-byte SHA-256 digest posted in memo | Zcash memo limit is 512 bytes; keeps document metadata and large ciphertext off the ledger | Storing document chunks in multiple blockchain memos (prohibitively expensive, bloats chain) |
| **Dual-Layer Envelope** | Recipient public key encryption (Inner) + Ephemeral Keeper-split key (Outer) | Even if all 5 keepers collude before or after expiry, they cannot decrypt the document without the recipient's private key | Single-layer encryption (keeper committee could read document without recipient) |
| **Deterministic Simulation Mode** | High-fidelity local state machines with controllable block miner & reorg engine | Allows judges and developers to test the full lifecycle, grace boundaries, and reorg safety in seconds without waiting 3 hours for testnet block confirmations | Testnet-only (makes judging demo fragile and slow due to variable testnet block times) |

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Z-CANARY WEB CONSOLE                             │
│  ┌───────────────┐ ┌────────────────┐ ┌─────────────────┐ ┌──────────────┐  │
│  │ Source Portal │ │ Recipient Box  │ │ Shielded Support│ │ Auditor/Demo │  │
│  └───────┬───────┘ └───────▲────────┘ └────────┬────────┘ └──────┬───────┘  │
└──────────┼─────────────────┼───────────────────┼─────────────────┼──────────┘
           │                 │                   │                 │
           ▼                 │                   ▼                 ▼
┌──────────────────────┐     │          ┌─────────────────────────────────────┐
│ Cryptographic Engine │     │          │ Chain & Keeper Simulation Engine    │
│ • Ed25519 Sign/Verify│     │          │ • Height & Block Ticker             │
│ • Shamir GF(256) 3/5 │     │          │ • 5x Isolated Keeper State Machines │
│ • Dual-Layer AES-GCM │     │          │ • ZIP-302 512-Byte Memo Codec       │
│ • SHA-256 Manifest   │     │          │ • Outbox & Reorg Event Handler      │
└──────────┬───────────┘     │          └──────────────────┬──────────────────┘
           │                 │                             │
           ▼                 │                             ▼
┌────────────────────────────┴────────────────────────────────────────────────┐
│                          LOCAL PERSISTENT STORE                             │
│ • Vault Manifests & Ciphertexts (Encrypted Local Storage)                   │
│ • 5x Keeper Share DBs & Commitments (Isolated partitions)                   │
│ • Blockchain Event Log & Transaction Ledger                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Binary Memo Codec Layout (Exact 512 Bytes)
```
Offset  Length  Field                   Description
0       1       ZIP-302 Prefix          0xFF (binary payload indicator)
1       4       Application Magic       0x5A43414E ("ZCAN")
5       1       Version                 0x01
6       1       Network                 0x01 (Testnet) / 0x00 (Mainnet)
7       1       Operation               0x01 (Register), 0x02 (Check-in), 0x03 (Cancel)
8       32      Switch Identifier       Unique random 32-byte UUID/hash
40      8       Sequence Number         uint64 Little-Endian (strictly increasing)
48      4       Expiry Block Height     uint32 Little-Endian
52      32      Manifest Digest         SHA-256 hash of immutable manifest
84      32      Source Public Key       Ed25519 verification key
116     332     Reserved Zero Padding   Must be all zeros (0x00)
448     64      Ed25519 Signature       Signature over bytes [0..447] with domain sep
Total: 512 Bytes
```

### State Transition Machine (Per Keeper)
```
[DRAFT]
   │ (Provisioning verified against commitment)
   ▼
[REGISTERING]
   │ (Sequence 0 memo mined + 2 confirmations)
   ▼
[ACTIVE] ◄──┐ (Check-in memo with seq > current)
   │ │      │
   │ └──────┘
   │ (Current Block >= Expiry Height)
   ▼
[GRACE] ────► [ACTIVE] (Postponement memo received during grace)
   │
   ├────────► [CANCELLED] (Cancellation memo received)
   │
   │ (Current Block >= Expiry Height + Grace Blocks && No valid memo)
   ▼
[RELEASED] ──► (Dispatches encrypted share to Recipient Outbox)
```

---

## 5. Implementation Sequence & Deliverables

1. **Core Cryptographic Suite (`src/crypto/`)**:
   - `shamir.ts`: Finite field arithmetic over $GF(2^8)$, polynomial evaluation, Lagrange interpolation for $(3, 5)$ threshold.
   - `memoCodec.ts`: Binary 512-byte serializer/deserializer with Ed25519 sign & verify and golden test fixtures.
   - `envelope.ts`: Inner X25519 recipient encryption + outer AES-256-GCM release wrapper.
2. **Keeper & Chain Engine (`src/engine/`)**:
   - `chainSimulator.ts`: Block generator, mempool, mining controls, reorg engine.
   - `keeperNode.ts`: 5 independent keeper instances with isolated DB state, commitment validation, and release outbox.
3. **UI Components & Screens (`src/components/`)**:
   - Header & navigation with Top Bar contract, network indicators, and view switcher.
   - `CreateVaultModal` / Wizard with drag-and-drop, sample document loader, and share generator.
   - `VaultConsole` with live countdown, Check-In button, Postpone modal, and event audit log.
   - `RecipientInbox` with share counter, threshold unlocker, and verified decrypted document preview.
   - `SupportPortal` with Orchard address, ZIP-321 link, and unlinked funding demonstration.
   - `EvidencePanel` with 5-keeper status cards, raw memo hex viewer, and automated test runner.
4. **Documentation & Handoff Artifacts**:
   - `SPEC.md`, `CONTRACTS.md`, and sample synthetic whistleblower dossier.
5. **Verification**:
   - Automated test suite verification, build check (`compile_applet`), and responsive layout testing across 390px, 768px, and 1440px.
