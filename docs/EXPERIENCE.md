# Canary experience rebuild

## Product model

Canary encrypts a dossier for one recipient, then wraps it in a separately controlled release layer. A signed check-in extends the deadline. Keepers evaluate confirmed commands through an inclusive grace boundary; healthy scanning and three valid distinct shares are required for recipient recovery. The recipient still needs their private key. There is no smart contract. Three colluding keepers can release early, and delivered shares cannot be recalled.

The browser harness uses actual Ed25519/X25519/AES-GCM with synthetic chain and keeper records in one browser. Native testnet uses the authenticated Rust agent, age/XChaCha encryption, shielded memo commands, and five local keeper processes sharing one operator and scanner. These modes are visibly separated throughout the UI.

## Art direction

The illuminated archive: graphite surfaces, mineral green light, restrained amber status accents, fine rules, generous negative space, and deliberate editorial typography. Segoe UI/Arial, Georgia, and Consolas are intentional system fonts; there are no external font requests. The wordmark and all geometry are original code-built assets.

Research references:

- [Codrops: Atelier UI, WebGL and DOM](https://tympanus.net/codrops/2026/10/21/atelier-ui-webgl-dom/) informed the separation between an immersive scene and accessible DOM controls, and the importance of a coordinated rendering lifecycle.
- [Rejouice](https://www.rejouice.com/) informed the use of strong editorial hierarchy, concise copy, generous spacing, and a focused opening action.
- Requested Awwwards, FWA, CSS Design Awards, Active Theory, and Resn references were consulted through available web retrieval; some could not be fetched. No claim is made that their full animated experiences were browser-inspected. No external assets or template code were copied.

The real Three.js archive responds to pointer position, opens its layers, changes with actual projected lifecycle state, and shows five keeper stations. Only a public presentation projection enters the scene: no filenames, keys, share bytes, identifiers, or plaintext. A separate SVG keeper topology also omits secret data. Pause/reduced-motion/hidden-page/offscreen states stop the continuous WebGL loop. Render resolution is bounded, resources are disposed, and unavailable WebGL falls back to an explicitly labeled expandable 2D schematic.

## Implemented journeys

- Overview, Vault Sentinel, Recipient Inbox, Shielded Support, Evidence & Keepers, creation wizard, and authenticated Native Testnet share the new design language.
- A six-chapter guided story exercises the existing browser protocol, with signed check-in, grace, delayed-scan suspension, three-share recovery with two offline keepers, and authenticated decryption. It supports manual progression, autoplay, pause, reset, and verified synthetic-file download. It never calls a wallet or generates explorer links.
- Native controls preserve explicit registration, five verified provisioning acknowledgements, separate operation and lifecycle state, cancellation confirmation, same-operation retry, resumed provisioning, recipient decryption/digest verification, ciphertext package export, wallet-derived fee estimates, separate testnet support payment request, and passphrase-encrypted identity export/restore.
- Identity backups are explicitly limited to identity keys; they do not include wallet funds, ciphertext packages, manifests, command journals, or keeper databases.

## Verification

32 frontend tests pass, including the complete guided protocol path, fail-closed scan state, repeated reset, secret-free scene projection, existing cryptographic vectors, and authenticated API contracts. TypeScript and production Vite build pass. Main application JavaScript is approximately 435kB minified; the lazy Three.js scene is approximately 545kB and retains Vite's >500kB chunk warning. No FPS benchmark or formal accessibility certification is claimed.

Real in-app-browser QA used the policy-aware owned loopback preview at http://127.0.0.1:4174. Viewports 1440x1000,768x1024,390x844 were inspected. Screenshots are included in [the evidence directory](evidence/experience/) and in the local outputs/experience-qa directory. Desktop/tablet/mobile overview fits without horizontal document overflow. The mobile navigation scrollbar defect discovered during QA was fixed.

Verified interactions include archive layer inspection, all six manual guided chapters, exact 1598-byte synthetic download, Sentinel check-in, cancellation Escape dismissal, premature-decryption rejection, permitted recipient recovery, simulated support accounting, keeper availability toggling, and missing-bearer native rejection. Native mobile layout was checked with no document overflow. Reduced-motion/context-loss paths were reviewed in code; they were not forced through OS settings or browser injection.

The final production preview completed autoplay through all six chapters without intervention; pause/reset controls and a second clean reset were verified. An earlier development-server reload interrupted a preliminary run, so that run is not counted.

## Connected native browser verification

The final interface connected to the real authenticated agent and reported five healthy keepers. It displayed the existing RELEASED vault with five shares and CANCELLED vault with zero shares, both with five verified provisioning acknowledgements.

- Actual recipient recovery downloaded 136 bytes and independently matched SHA-256 `e05e833a180c72954315c0165cf79dc921221065f65263b408bcf99ba362d2d2`.
- Encrypted package/manifest export succeeded through the UI.
- A recipient identity was exported with a strong ephemeral test passphrase, downloaded encrypted, then restored idempotently to the same identity. The disposable encrypted backup was removed afterward and its test passphrase discarded. This is test evidence, not a user recovery backup.
- Wallet proposal reported 10,000zat fee +10,000zat note =20,000zat total, with 99,860,000zat spendable at the time. This is a testnet estimate, not a promised fixed fee.
- The real support request used the separate funded testnet receive address, 0.001 TAZ, and no memo. No support transaction was submitted.
- A new native draft `d341236a3360cb227804e4c5deed4fe5e9a2c843f984bd9307617bde26eba9f0` was created from the public 136-byte fixture after comparing the recipient fingerprint with the previously exported signed manifest. All five acknowledgements were verified and registration became available. Register was deliberately not pressed; no new testnet transaction was sent by these browser tests.
- The final draft view does not offer unsupported cancellation. Actual cancellation and release proofs are covered by the native backend evidence.

Final screenshots include Overview at1440/768/390 widths; guided chapters and completed autoplay; Sentinel, locked/recovered recipient, support, keeper topology, native authentication error, connected native desktop/tablet, and the five-ack draft. Each important workflow was visually inspected in the in-app browser. Browser errors/warnings were empty in the final inspection. Screenshots contain only public fixtures and masked bearer fields. The agent token was cleared from the UI afterward. Root packaging copies the sanitized screenshots into `docs/evidence/experience/`.

Final test/build logs: `docs/evidence/frontend-tests.tap` and `docs/evidence/frontend-build.txt`. The preview remains at http://127.0.0.1:4174 on Overview. No claim is made of broad cross-browser testing, an FPS benchmark, OS reduced-motion emulation, or formal WCAG certification.
