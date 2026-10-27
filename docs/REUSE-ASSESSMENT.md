# Reuse assessment

Inspected source: `unspecifiedcoder/z-canary`, main revision `2272e734622e210673d2334dd132917f8dad90ff`, October 26, 2026. This report distinguishes the original checkout from the implemented rebuild and verified native testnet integration.

## Keep and adapt

| Existing component | Reuse decision |
|---|---|
| Welcome, create wizard, vault detail, recipient, support, evidence screens | Reused the product journeys while rebuilding the visual shell and adding the authenticated native workspace. |
| Vault timeline and keeper-state cards | Reused lifecycle concepts; native views now read durable events, verified acknowledgements and applied keeper state. |
| D3 keeper graph and 3D envelope visualizer | Retained useful protocol explanation and added a distinct Three.js living-vault journey with six explicitly simulated stages. |
| 512-byte memo layout | Preserve the byte offsets and strict framing. The prefix matches ZIP 302. Freeze domain-plus-body Ed25519 fixtures for Rust interoperability. |
| Lifecycle scenarios | Adapted into Rust keeper tests, a synthetic five-process rehearsal and a live native acceptance runner. The browser demonstration remains separate. |
| Synthetic dossier | Reusable demonstration content. Its original `.pdf` label contained text, so this increment labels the default `.txt`. |

## Original findings that prevent direct backend reuse

1. `signMemoBody` derived its output entirely from the public key and public body. Anyone with those fields could forge a command. The local change now requires the Ed25519 secret seed.
2. `deriveX25519PublicKey` was a hash, and the inner encryption key depended on public recipient data and a public nonce. The recipient-private-key check was an application guard, not a cryptographic barrier. The local change uses actual X25519 agreement and HKDF.
3. The function called AEAD used a handwritten hash-based stream/tag construction rather than AES-GCM. The local change uses library AES-256-GCM.
4. Keeper endpoints and database paths were labels on JavaScript objects. There was no Rust workspace, HTTP agent, SQLite persistence, viewing-only scanner, or wallet adapter.
5. The reducer released against the tip while accepting only confirmed commands. An on-time command at the grace boundary could lose its confirmation window. Late commands could also rescue a stale keeper. Both model errors now have regression tests and fixes.
6. File uploads used `readAsText`, corrupting binary PDFs. Upload/download now preserves bytes.
7. The support address was an invented string. The native API now returns a separate real testnet shielded funding address and ZIP-321 request with no evidence identifier or memo. [Extension checks](evidence/native-extensions.json) verify this boundary.
8. `TASKS.md` marked all tasks VERIFIED, while the browser suite contained eight checks rather than twelve, and one failed. Status documents now distinguish simulated flows, verified native integration and remaining deployment limits.
9. External Google Fonts requests contradicted the local-asset direction. They have been removed in favor of system fonts.

## Differentiation and competitor lessons

The demonstrated product pitch is **shielded Zcash control messages plus recipient-bound delivery and tested release recovery**. The [completed native acceptance run](evidence/native-live-acceptance.json) connects the wallet, scanner, persistent keepers and recipient decryption; [database evidence](evidence/live-postpone-databases.json) verifies applied check-in extension. The cinematic demonstration explains that model without presenting its simulated timeline as live activity. Local integration does not establish network anonymity, independent operators or production durability.

Primary-source comparisons (checked October 26, 2026):

- **Sarcophagus is the closest direct cryptographic dead-man-switch comparator.** Its [V2 contract repository](https://github.com/sarcophagus-org/sarcophagus-v2-contracts) contains contract and deployment code; its [operator runbook](https://github.com/sarcophagus-org/quickstart-archaeologist) documents server setup, bonds, service logs and troubleshooting. Learn from its explicit operator prerequisites, economic commitments and health workflow. Canary now has a verified shielded send/scan and five-process path, while independent operator deployment and incentives remain a separate gap. Published competitor artifacts do not establish current service reliability; no live competitor transaction was tested.

- [SecureDrop source documentation](https://docs.securedrop.org/en/stable/source/source.html) describes encrypted source/journalist communication, follow-up correspondence, and uploads up to 500 MB. Learn from its source guidance and cautious disclosure language. Z-Canary's proposed delayed continuity workflow has a different purpose; this prototype is not evidence of stronger anonymity or safety.
- [Dead Man's Switch help](https://www.deadmansswitch.net/help/) describes timed check-ins and eventual email delivery. Its simpler onboarding is an advantage over requiring a local wallet, test funds and recipient keys. Learn from its clear interval/check-in explanation. Canary's guided simulation now explains the same user problem quickly, while its working threshold custody and shielded commands still carry greater operational complexity.

These are product/UX comparisons, not code imports. No competitor code was copied. An earlier narrow Grid keyword lookup returned no products; the subsequent agent lookup failed at DNS resolution. Grid coverage remains unknown, not evidence that there are no competitors. No authenticated Colosseum project-history claims are made.

## Delivered scope and remaining operational work

The rebuild preserves the fixed memo framing, product journeys and useful demonstration scenarios, replaces the insecure primitives, and adds the eight-crate native backend, pinned wallet harness, five persistent keeper services, authenticated API, encrypted identity backups, proposal-based fee estimates and live recipient recovery. It retains React/Vite instead of introducing a framework migration. [SPEC.md](../SPEC.md) and [verification](evidence/VERIFICATION.md) separate live acceptance, synthetic failure scenarios and browser QA.

Further deployment work includes independent keeper operators, automatic common-ancestor reorg recovery, portable preservation of the whole runtime beyond identity backups, and external security review. These are not presented as capabilities proved by the local hackathon build.

## Reuse terms

The original repository has an Apache-2.0 SPDX comment in `src/App.tsx` but no root LICENSE file was found. Confirm the intended repository license before public redistribution. New Noble dependencies are MIT licensed; their installed package license texts are the attribution source. No upstream wallet code has been copied into this application.
