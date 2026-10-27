# Verification record

Updated 27 October 2026. The automated summary below is reconciled with the current public release; machine-readable native evidence retains the exact revision and timestamp of each recorded run. All evidence distinguishes simulated chain input from actual testnet transactions.

## Automated checks

- A historical clean extraction of the source archive passed offline npm installation, the 32 frontend tests present at that revision, TypeScript, production build, and locked metadata resolution for all eight Rust workspace members. [Clean extraction log](clean-source-check.txt).

- **66 distinct Rust tests passed.** Final suites: agent 14, core 5, crypto 11, keeper 17, keeper service 4, storage 8, vault CLI 7. The final agent-only rerun replaces the earlier agent suite; it is not counted twice. [Raw evidence](backend-tests.txt).
- **43 frontend tests passed**, with TypeScript no-emit and Vite production build passing. Tests include signed codecs, cryptographic failures, guided and judge-created lifecycles, direct-route safety, configurable 2-of-5 through 5-of-5 reconstruction, wrong-recipient rejection, exact-byte recovery, secret-free scene projections, binary file bounds and native API contracts.
- The repository verification workflow reruns frontend tests, TypeScript, the production build, public-site integrity and committed Pages-bundle drift checks, plus the locked Rust workspace tests, on `main`, `codex/**` branches and pull requests.
- The actual loopback process smoke test passes bearer/origin checks, three signed memo fixtures including `u64::MAX`, structured method errors and truthful unavailable behavior without a runtime configuration. [Log](agent-http-smoke.txt).
- The pinned Windows wallet harness builds with Rust 1.99.0. Its optional TLS-shim patch produces an unused-patch warning. The lazy Three.js chunk exceeds Vite's 500kB warning threshold; the main app and scene are split. No FPS benchmark or formal accessibility certification is claimed.

## Live native acceptance: passed

[The completed acceptance run](native-live-acceptance.json) passed **15 checks** and exited 0. It used the actual authenticated API, persistent source/recipient identities, five signed provisioning acknowledgements per vault, genuine shielded commands, UFVK-only scan batches, five keeper databases, encrypted share delivery and recipient decryption.

| Command | Block | Transaction |
|---|---:|---|
| Expiry vault REGISTER |4546656|[1d479796…19cf90ecb](https://zexplorer.app/testnet/tx/1d4797966b97aac313b4ce7db58a4e546593c1e5efacfa992b3c73519cf90ecb)|
| Cancellation vault REGISTER |4546660|[35bfb606…ecd56be0](https://zexplorer.app/testnet/tx/35bfb606f1e822215e5827dafc6f788319d798cb96fa14f368dedcdfecd56be0)|
| POSTPONE |4546671|[60d30eb1…9a002f66](https://zexplorer.app/testnet/tx/60d30eb17342311926d39c94164393d0ce9042bb3fe5e1bb3c3311d19a002f66)|
| CANCEL |4546677|[32e76a24…fbe1d865](https://zexplorer.app/testnet/tx/32e76a242961415eee02df615778d8ab0f26427256c47bcdf258e661fbe1d865)|

A read-only database check separately proved that **all five keepers applied POSTPONE**, stored sequence 1 and advanced expiry to 4546761. [Database evidence](live-postpone-databases.json). The cancelled vault delivered zero shares. The expired vault delivered five valid shares and recovered the exact 136-byte public fixture, SHA-256 `e05e833a180c72954315c0165cf79dc921221065f65263b408bcf99ba362d2d2`.

After a real process shutdown and restart, the [terminal-state audit](native-restart-audit.json) preserved CANCELLED/sequence 2/postponed expiry/zero shares and RELEASED/sequence 0/original expiry/five shares. That snapshot contains the original 15 checks plus two restart checks; no new transaction was sent for the audit.

[Five native extension checks](native-extensions.json) also passed: actual proposal fee estimation; integrity-checked ciphertext/event export; both identity roles' encrypted export, same-key restore and wrong-passphrase rejection; and an evidence-free shielded support request. The fee snapshot was 10000zatoshi plus a 10000zatoshi note, total 20000, against 99860000 spendable zatoshi. Estimation did not broadcast.

## Separate evidence

- [Three earlier transport transactions](testnet-transport.json) recovered exact 512-byte REGISTER/POSTPONE/CANCEL memos with a separate viewing-only scanner. They use a public signing fixture and are not the protected-document acceptance above.
- [The five-process synthetic rehearsal](five-process-rehearsal.json) passed 12 checks and exited 0. It verifies inclusive-boundary cancellation, postponement during grace, restart suspension, incomplete scan rejection, two-share failure, and exact PDF recovery with three shares while two keepers are offline. Its block feed is explicitly synthetic.
- The funded persistent sender received 1 TAZ at block4546067, then paid the real command sends. This proves receipt and later spendability, not a public same-coin link. Wallet secrets and DPAPI state are excluded from exported evidence.

## Maya and Noor example (27 October 2026)

The new example uses the existing browser encryption, signed command validation, keeper state machine and recipient decryption. Four additional tests cover the full recovery flow, cancellation beyond its old boundary, check-in during grace and fresh-key reset. TypeScript and the production build pass. The historical clean-extraction result above predates these four tests. [Current test log](frontend-tests.tap).

Real browser actions exercised protection, early rejection, check-in (1,024 → 1,048), cancellation with zero shares, a fresh missed-check-in branch, check-in during grace (1,048 → 1,072), stale scans, two-share rejection, three-share recovery with two keepers offline, wrong-recipient rejection and download. The downloaded 500-byte public text file has SHA-256 `cf2f6149b05ac93ed0e5116c506ea1791641c0606f6a7fe10a040a395bc9e20f`, matching the source. This is separate from the native 136-byte test fixture.

Desktop captures use the default 1280×720 viewport; tablet 768×1024 and mobile390×844 verify the new component, reset and mobile protection. No console errors were captured. Full-page screenshots: [intro](experience/case-intro.jpg), [check-in](experience/case-checked-in.jpg), [two shares](experience/case-insufficient.jpg), [recovery](experience/case-recovered.jpg), [mobile](experience/case-qa-mobile-recovered.jpg), [tablet reset](experience/case-qa-tablet-reset.jpg). The narrated film edits these actual app states for time; it is not a continuous screen recording.

## Browser verification

Real in-app-browser QA inspected desktop 1440x1000, tablet 768x1024 and mobile 390x844. It covered the 3D scene, layer inspection, all six guided states, production autoplay/reset, verified synthetic download, Sentinel/check-in, cancellation dismissal, locked/recovered recipient states, support accounting and keeper controls. Native connected UI displayed actual released/cancelled records and downloaded the genuine recovered fixture with its matching digest.

Screenshots, detailed interaction results and qualifications are in [experience notes](../EXPERIENCE.md). Reduced-motion and context-loss code paths were reviewed; OS preference changes and GPU failure injection were not performed. The earlier native-browser URL-confidence block was resolved by using the documented in-app browser surface with an explicit owned loopback URL; no alternate driver bypass was used.

## Limits

Five locally operated keeper processes share a scanner and one lightwallet endpoint. They do not establish independent infrastructure or independent chain consensus. Three colluding keepers can deliver early to the recipient; cancellation cannot revoke delivered shares. No smart contract is deployed. Detected confirmed-chain discontinuities suspend release; automatic deep-reorg recovery is not implemented.

The native runtime is Windows-specific. Identity backups are portable encrypted keys only: they do not replace backups of wallet recovery, encrypted packages, manifests, command journals or keeper databases. Browser simulation uses a separate demonstration format. This is a tested local testnet prototype, not an audited production system or a network-anonymity guarantee.
