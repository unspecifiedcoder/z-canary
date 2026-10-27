# Zcash wallet gate

Status: **shielded transport, separate viewing-only recovery and the complete native document lifecycle passed**. The original transport fixtures and later document acceptance run are separate evidence sets.

## Reproducible implementation

The harness in [wallet-gate](../wallet-gate/README.md) pins official Zingolib commit `4d85349f3cab5f7e4e5273c7f01c34044f17b1a9`, Rust 1.99.0, testnet, and TLS endpoint `https://testnet.zec.rocks:443`. It checks the server chain name before wallet operations. The approved Windows installation supplies Visual Studio Build Tools 2022, MSVC 14.44 and Windows SDK 10.0.26100.0. The pinned library's native check passed with exit code 0; the packaged harness subsequently built and executed real sends.

`backend/scripts/setup-wallet.ps1` recreates the pinned checkout under ignored `.wallet-upstream/zingolib`. Build with `cargo +1.99.0 build --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1`. Use the harness README for supported machine modes and state configuration.

Sender and receiver recovery is encrypted with Windows CurrentUser DPAPI before their public addresses are exposed. Repeated independent `prepare` processes restored the same addresses. No mnemonic is printed or stored in plaintext. The user funded an earlier ephemeral wallet; that harness failed to preserve its keys. A replacement durable wallet was independently funded through Fauzec without requiring another user payment. The obsolete address must not be funded again.

The durable wallet's 1 TAZ funding transaction is [f0701ee…243a3](https://zexplorer.app/testnet/tx/f0701ee36548c63c9729838766db72f39b50925ad55f995b544832b8b76243a3), confirmed at height **4,546,067**. This same durable sender subsequently paid the three command transactions below. TAZ is testnet currency; these are not mainnet payments.

## Confirmed transport evidence

Each row represents an actual shielded send and a distinct UFVK-only receiver scan that recovered the exact signed 512-byte wire memo. Evidence records include the network, operation, string-encoded sequence, txid, block height/hash, output index and original memo. Initial observation was at one confirmation; keeper processing applies its separately configured confirmation target.

| Command | Sequence | Confirmed block | Transaction |
| --- | ---: | ---: | --- |
| REGISTER | 0 | 4,546,108 | [4c8d932…5dbcd](https://zexplorer.app/testnet/tx/4c8d93227d41f826a0f2e6b01961fe5789df6b86241f7da08feea54fce05dbcd) |
| POSTPONE | 1 | 4,546,115 | [eb88105…34ef8](https://zexplorer.app/testnet/tx/eb88105b26d0a33bcf51ca4ecff29b2d608e20231ca6ce357578401481c34ef8) |
| CANCEL | 2 | 4,546,123 | [07e4e41…1299e](https://zexplorer.app/testnet/tx/07e4e41413971119d85f282f698e52b963152d26d40224aec022df151ad1299e) |

The full machine-readable proof is [testnet-transport.json](evidence/testnet-transport.json). These commands use a deliberately public signing fixture and demonstrate transport only. They are not a protected dossier, keeper activation proof or completed recipient delivery.

## Scanner and failure behavior

`live-command` validates the signed memo, waits for shielded spendability and successfully proposes a send before writing a durable broadcast-unknown marker. It persists a txid after submission, then scans independently. A retry with a saved txid resumes scanning; an ambiguous broadcast is never automatically resent. An earlier fixed-fixture attempt crashed during native construction and retains its ambiguous marker. The successful commands used separate immutable command journals; they did not clear or bypass that marker. The Windows binary now reserves a 64 MiB process and worker stack for proving.

`export-viewer` writes a separate DPAPI capability holding only the receiver UFVK, birthday and address. `scan-batch` reads that capability, checks the preceding anchor hash, and returns complete contiguous batches of up to 128 confirmed blocks, including empty blocks and transaction/output positions. It fails on gaps, malformed headers, discontinuities or incomplete memo recovery. No-new-block output is explicitly incomplete and cannot advance a keeper. A read-only batch validation recovered all three transport events in their contiguous block context.

The source wallet's recovery, view capability, runtime state and build artifacts are ignored and excluded from source exports. DPAPI files are tied to the current Windows account; repository source alone cannot restore its funded wallet. Verified passphrase-encrypted export/import covers the source signing and recipient decryption identities. It does not export the spending wallet, runtime command journals, dossiers or keeper databases.

## Completed native acceptance

The native agent connected document encryption, five signed provisioning acknowledgements, live memo submission, viewing-only batches, five SQLite keeper processes, validated recipient deliveries and decryption. The [15-check live acceptance run](evidence/native-live-acceptance.json) submitted four additional real transactions: release-vault REGISTER and cancellation-vault REGISTER, POSTPONE and CANCEL. The released vault delivered five shares and recovered the original 136-byte public fixture with SHA-256 `e05e833a180c72954315c0165cf79dc921221065f65263b408bcf99ba362d2d2`; cancellation delivered none.

[All five databases](evidence/live-postpone-databases.json) applied POSTPONE sequence 1 and extended expiry from 4,546,757 to 4,546,761. A subsequent read-only restart audit found the same cancelled sequence 2/zero-share state and released sequence 0/five-share state. The exact two-share live timing window was not observed; the zero-share gate, library threshold tests and synthetic two-share failure remain distinct evidence.

[Native extension evidence](evidence/native-extensions.json) records actual proposal-derived fee estimation without submission: 10,000 zatoshi fee plus a 10,000-zatoshi note, total 20,000, against then-spendable balance 99,860,000. It also verifies ciphertext/event export, both identity-role backups and wrong-passphrase rejection, and a separate support URI without evidence identifiers or memo. Estimates and balances are snapshots, not fixed future costs.

The resumable runner is `backend/scripts/native-live-smoke.mjs`; `ZCANARY_REQUIRE_KEEPER_STATE=1` also checks applied keeper expiry/sequence and can audit completed runs after restart without creating new transactions. Five local processes still share one machine and scanner infrastructure; this is testnet integration evidence, not proof of independent operators or production security.

The Zec.rocks server can observe sync requests and network metadata. This wallet gate makes no anonymity guarantee. Relevant primary sources: [pinned Zingolib source](https://github.com/zingolabs/zingolib/tree/4d85349f3cab5f7e4e5273c7f01c34044f17b1a9), [ZIP 302](https://zips.z.cash/zip-0302), and [Zcash testnet guide](https://zcash.readthedocs.io/en/latest/rtd_pages/testnet_guide.html).
