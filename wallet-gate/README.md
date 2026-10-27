# Restart-safe testnet memo gate

This standalone harness uses the official Zingolib repository pinned at commit `4d85349f3cab5f7e4e5273c7f01c34044f17b1a9`. Run `backend/scripts/setup-wallet.ps1` from this repository root to create `.wallet-upstream/zingolib`; the script refuses to replace an existing checkout with a different remote or revision. The harness always uses `ChainType::Testnet` with `https://testnet.zec.rocks:443` and checks `GetLightdInfo.chain_name == test` before creating wallet keys.

Run `prepare` first. It creates sender and receiver mnemonics in memory, derives addresses, and persists recovery data only after Windows CurrentUser DPAPI encryption. The harness is Windows-only because it uses DPAPI; secret material is piped to a PowerShell helper on stdin, never passed as an argument, printed, or written in plaintext. Wallet and send modes reconstruct the sender and receiver, verify both derived addresses against encrypted recovery, and verify the sender before exposing its address. `prepare` exits after reporting `restore_verified=true`. The viewer exporter restores and verifies only the receiver; the batch scanner reads only a separately encrypted viewing key. Review the sender address before sending any funds. Before sending, live modes wait for shielded notes to be spendable at the wallet's confirmation, witness, anchor, and spend-horizon rules, then successfully create a send proposal. Only after this preflight do they durably mark `broadcast-unknown`, transmit the stored proposal, and persist its public txid before scanning. If a crash/error leaves the broadcast outcome unknown, they fail closed rather than risking a duplicate send. A later run with a saved txid skips sending and resumes the independent receiver UFVK scan.

`live-command MEMO_HEX_FILE` accepts one signed 512-byte testnet Z-CANARY memo encoded as hex. It validates the memo with `zcanary-core::decode_and_verify_memo(..., 1)`, journals the immutable wire memo under its SHA-256, and uses a per-memo fail-closed send state. After the independent UFVK scan confirms the exact memo, it writes `event.json` containing the raw memo, testnet network, UFVK-only scanner label, operation, string-encoded sequence, txid, block height/hash, output index, and confirmation count. Re-running the same memo resumes its scan and cannot send a second copy. This mode only carries the command through the wallet; it does not call or update the keeper service or vault.

`recover-proof` is a broadcast-free recovery mode for the fixed `live-proof` memo. If `send-state.txt` is `broadcast-unknown`, it scans with the receiver UFVK for a confirmed transaction containing the exact fixture. It replaces the marker with a txid only when exactly one match is found, and writes `recovered-proof-event.json`; zero or multiple matches leave the marker untouched. The Windows binary reserves 64 MiB stack for the process and Tokio worker threads for Zcash transaction proving.

## Independent batch adapter

The machine-facing modes `status`, `checkpoint`, `export-viewer`, and `scan-batch` write one JSON result to stdout. They expose no mnemonic or UFVK. `status` restores the sender from encrypted recovery, syncs it, and reports its address and shielded spendable balance. `checkpoint CONFIRMATIONS` reports a public chain checkpoint at the requested confirmation depth. `export-viewer OUTPUT_PATH` restores the receiver, verifies its derived address, then writes a separate CurrentUser DPAPI file holding only the receiver UFVK, birthday, and public address. Keep that viewer file local to the same Windows account; it has no spending capability.

`estimate-command` restores and syncs the existing sender, then proposes the same 10,000-zatoshi shielded payment to the registry with an arbitrary 512-byte binary memo. It obtains `feeZatoshi` from the proposal's actual ZIP-317 fee calculation and returns `{network:"testnet",feeZatoshi,noteAmountZatoshi:10000,totalZatoshi,spendableZatoshi}`. It clears the in-memory proposal without proving, broadcasting, or writing any command journal. The operation times out after 90 seconds, and unavailable spendable funds produce an error rather than an assumed fee. This is a snapshot estimate; the actual send recalculates its proposal against current wallet state.

`scan-batch VIEWER_DPAPI START_HEIGHT EXPECTED_PREV_HASH CONFIRMATIONS` reads only the explicitly supplied viewer file and ignores `ZCANARY_WALLET_STATE_DIR`. It checks the preceding block hash, scans at most 128 confirmed blocks with a UFVK-only wallet, requests Sapling, Orchard, and Ironwood compact transactions, and emits every block including empty ones. The result includes canonical displayed block and transaction hashes, transaction indices, and exact 512-byte arbitrary memo wire encodings recovered by the viewer. A gap, fork, malformed header, missing decrypted transaction, or incomplete stream fails without emitting a batch. When the tip has no new confirmed range, it returns `complete:false` with `status:no-new-blocks`.

For wallet recovery and journal modes, `ZCANARY_WALLET_STATE_DIR` can point to an existing absolute state directory. This is intended for an operator deliberately reusing an encrypted recovery outside this checkout. The default is `wallet-gate/state`. Do not copy the active recovery file or wallet state into this repository; repository ignores cover wallet state, upstream checkout, logs, and build output.

The candidate's testnet harness pins this endpoint in [`networked.rs`](https://github.com/zingolabs/zingolib/blob/4d85349f3cab5f7e4e5273c7f01c34044f17b1a9/zingolib/src/testutils/chain_generics/networked.rs) and [`testnet.md`](https://github.com/zingolabs/zingolib/blob/4d85349f3cab5f7e4e5273c7f01c34044f17b1a9/docs/testing/testnet.md). Zingolib has no default testnet indexer, so the harness names the endpoint directly and checks the chain name before generating keys. Zingolib has `default = []`; `nym` is opt-in and it is the only feature that re-enables `zingo-price/socks5-fetch`. The workspace's `zingo-price` dependency explicitly sets `default-features = false`. The standalone manifest carries the upstream TLS shim patch because Cargo applies `[patch.crates-io]` only from the root manifest currently being built. Cargo reports that patch as unused in this build; that is expected because the optional `nym` dependency path, which uses the shim, is disabled.

## Run after review

Build with the locked manifest. The recovery record is bound to the current Windows user account and machine DPAPI context; keep the `state` directory private and backed up if restart recovery is needed.

From the repository root, first set up the pinned upstream checkout:

```powershell
.\backend\scripts\setup-wallet.ps1
```

Then build and prepare the persistent identity. Review and fund only the printed testnet address:

```powershell
cargo +1.99.0 build --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- prepare
```

Run the live proof after funding and confirming the sender has shielded spendable balance:

```powershell
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- live-proof
```

For a signed operation, pass a text file containing exactly 1024 hex characters for the 512-byte wire memo:

```powershell
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- live-command path\to\signed-memo.hex
```

For a broadcast-free recovery scan of an ambiguous fixed-memo send:

```powershell
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- recover-proof
```

To expose a view-only scanner capability and fetch batches, first create a viewer DPAPI file under the current Windows account, then use `checkpoint` to establish the starting block's predecessor hash. Pass the exact checkpoint hash as displayed by the tool:

```powershell
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- status
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- checkpoint 3
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- export-viewer wallet-gate/state/receiver-viewer.dpapi
cargo +1.99.0 run --locked --manifest-path wallet-gate/Cargo.toml --bin wallet-gate -j1 -- scan-batch wallet-gate/state/receiver-viewer.dpapi START_HEIGHT EXPECTED_PREV_HASH 3
```

The Zcash Testnet Guide says TAZ has no monetary value and links community support or faucets: <https://zcash.readthedocs.io/en/latest/rtd_pages/testnet_guide.html>. The faucet referenced by the Zcash guide timed out during this task's read-only lookup. The JinoLabs operator repo describes its public testnet-only faucet as a browser proof-of-work flow without a captcha vendor: <https://github.com/jinolabs-xyz/zcash-faucet>. If the faucet is used, a person must submit the public address manually; the harness never opens or submits to a faucet.

The selected TLS indexer is the endpoint used by this pinned Zingolib checkout's testnet network harness and test instructions. Zec.rocks publishes its stack configuration and Hosh monitoring source: <https://github.com/zecrocks/zcash-stack>, <https://github.com/zecrocks/hosh>. The operator's Hosh page lists the testnet host: <https://hosh.zec.rocks/zec/testnet.zec.rocks%3A443>. The Zec.rocks service sees sync traffic and wallet scan queries. This gate makes no network-anonymity claim.

## Secret and persistence limits

The seed phrases and UFVK are never printed or logged. The viewer receives only the receiver's UFVK and the code verifies its key store is viewing-only. Wallet-file persistence remains unused: `LightClient::new` stays in memory because this harness calls neither `save_task` nor `flush`. `recovery.dpapi` is the encrypted recovery source; command journal memos and transaction evidence are public data. This repository export contains harness source only: it does not include the active wallet state, encrypted recovery file, logs, or build target from the original workspace wallet, so existing balances and secrets are not transferred into the repository.
