# Z-Canary Task Matrix & Acceptance Verification (`TASKS.md`)

| ID | Component | Owner | Status | Verification Proof |
|---|---|---|---|---|
| `T-01` | 512-Byte ZIP-302 Memo Encoder/Decoder | Builder A | **VERIFIED** | Golden vectors, non-zero padding rejection, signature tamper rejection |
| `T-02` | GF(256) 3-of-5 Shamir Secret Sharing | Builder A | **VERIFIED** | Any 3 shares reconstruct exact 32-byte key; 2 shares fail; duplicate index rejected |
| `T-03` | Dual-Layer Authenticated Encryption | Builder A | **VERIFIED** | Inner X25519 + Outer AES-256-GCM roundtrip & ciphertext tamper detection |
| `T-04` | Keeper Lifecycle State Reducer | Builder A | **VERIFIED** | `DRAFT -> REGISTERING -> ACTIVE -> GRACE -> RELEASED / CANCELLED` |
| `T-05` | Chain & Reorg Simulation Harness | Builder B | **VERIFIED** | Shallow reorg rollback (2 blocks) & deep reorg incident suspension (8 blocks) |
| `T-06` | Source Console & Vault Creation Wizard | Builder C | **VERIFIED** | Drag-and-drop, 5-keeper acks, live countdown, Check-In & Cancel flows |
| `T-07` | Recipient Inbox & Threshold Decryption | Builder C | **VERIFIED** | Share collection tracker (0/5 to 3/5), key reconstruction, digest verification |
| `T-08` | Unlinked Shielded Support Portal | Builder C | **VERIFIED** | Orchard `u1...` address, ZIP-321 URI without document IDs, gas funding credit |
| `T-09` | Evidence Panel & Automated Test Suite | All | **VERIFIED** | 12 live browser acceptance tests with cryptographic execution logs |
