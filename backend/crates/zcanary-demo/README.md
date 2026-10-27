# Five-process rehearsal

From the repository root, run `npm run demo:keepers` with Node 22.12+ and Rust 1.99.0 installed. Windows also requires MSVC and the Windows SDK. The wrapper builds two pinned Rust binaries with one Cargo job and launches five keeper processes, each with its own key, port, token and SQLite database. No Docker is required.

The Node runner generates random bearer tokens and a random test passphrase in memory. Rust prepares two synthetic vaults, encrypts a PDF using age and XChaCha20-Poly1305, stores source/recipient identities encrypted, and verifies that those exports restore. It validates all five signed durable provisioning acknowledgements before submitting registration.

The rehearsal verifies postponement during grace, cancellation in the final grace block, restart suspension, malformed scan suspension, two insufficient shares, successful recovery with three shares while two keepers are offline, and delivery acknowledgement. The recovered PDF must match the original bytes. The evidence JSON explicitly identifies the block feed as synthetic.

This demonstrates real encryption, HTTP authentication, signed acknowledgements, databases and process boundaries. It does not connect those keepers to a live Zcash scanner. All keepers run on one operator's computer. The test passphrase is intentionally discarded when the runner exits, so its encrypted synthetic artifacts are not a reusable personal backup. The separate wallet harness uses persistent Windows DPAPI recovery for actual testnet funds.

For manual invocation after building, use `node backend/scripts/demo-five-keepers.mjs PATH_TO_KEEPER_BINARY PATH_TO_DEMO_BINARY NEW_OUTPUT_DIRECTORY`. The directory must not exist. The runner stops only the children it created and never prints their tokens or passphrase.
