# Implementation status

Updated 27 October 2026. Evidence is separated by execution environment.

| Area | Implemented | Limits / remaining work |
|---|---|---|
| Protocol | Strict 512-byte Ed25519 commands; canonical signed manifests; Rust/TypeScript fixtures | Independent security review |
| Native crypto | age recipient encryption, XChaCha outer layer, library-based 3-of-5 sharing, identity-bound commitments and delivery | Whole-file limit 10 MiB |
| Wallet | Pinned Zingolib; encrypted restart-safe recovery; real shielded REGISTER, POSTPONE, CANCEL; exact UFVK-only recovery | Windows DPAPI; one pinned lightwallet endpoint; uncertain sends remain fail-closed |
| Keepers | Five authenticated services/SQLite databases; signed provisioning; live complete batches; grace/cancel; durable outbox; freshness suspension | One operator/scanner; deep reorg recovery requires intervention |
| Native agent | Authenticated loopback; create/provision/register/check-in/cancel/recovery; immutable operation journals | Local source/recipient orchestration, not remote recipient hosting |
| Identity backup | Passphrase-encrypted role-bound source/recipient export/import; replacement prohibited | Identity-only; preserve runtime and wallet directories separately |
| Support | Separate source-wallet testnet payment URI, no evidence memo; faucet-funded wallet used for actual sends | No mainnet funding or payment-provider integration |
| Experience | Custom archive identity; real interactive 3D; resettable simulation; redesigned pages; native workspace | Browser QA evidence recorded separately in experience notes |
| Reproduction | Locked dependencies, wallet setup, native launcher, synthetic process runner, resumable live runner | Native toolchain and valueless testnet funding required for a new machine |

The live acceptance run passed 15 checks with four confirmed shielded commands. Check-in advanced expiry in all five databases; cancellation prevented release. Expiry delivered five validated shares and recovered the exact 136-byte fixture with SHA-256 `e05e833a180c72954315c0165cf79dc921221065f65263b408bcf99ba362d2d2`. Restart preserved both terminal states and delivery counts. Five additional native checks verified fee estimation, ciphertext export, identity backup/restore and separate support requests. See [verification evidence](docs/evidence/VERIFICATION.md).

The clean synthetic five-process rehearsal passed all 12 checks, including boundary cancellation, restart suspension, two-share rejection, and exact PDF recovery with two keepers offline. Synthetic-chain success is not substituted for live-chain evidence.
