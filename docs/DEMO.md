# Maya and Noor: the public demo

The example follows a fictional journalist who wants her editor to recover a reporting file if she stops checking in. It uses a harmless, public 500-byte text fixture.

- [Watch the narrated example](https://unspecifiedcoder.github.io/z-canary/)
- [Run the interactive example](https://unspecifiedcoder.github.io/z-canary/app/#maya-noor)
- [Download the 88-second submission video](assets/canary-demo-v6.mp4)
- [Inspect the verification record](evidence/VERIFICATION.md)

## What the video shows

The 1:28 film is an edited walkthrough of actual browser actions and their results. It uses captured app states and editorial action highlights; it is not a continuous screen recording. The fictional scenario sends no blockchain transactions. Encryption, signatures, threshold reconstruction, recipient-key rejection and decryption execute in the browser using the existing demonstration engine.

The story covers the whistleblower use case, local protection, early recovery rejection, a check-in, controlled recovery, recipient-only decryption and the matching Zcash testnet receipts. Detailed trust boundaries stay in the landing-page and application footers so the film can remain focused on the core story.

The native 136-byte fixture and browser 500-byte fixture are different. Five native keeper processes share one operator and scanner. Three colluding keepers could release early; cancellation cannot recall delivered shares. This remains a prototype rather than an audited tool for sensitive reporting.

## Rebuild the public site

The repository's GitHub Pages source is `main:/docs`. The watch page is `docs/index.html`; the generated browser application is in `docs/app`. `.nojekyll` preserves the static asset layout.

With Node 22.12 or newer and dependencies installed:

```sh
npm test
npm run typecheck
node node_modules/vite/bin/vite.js build --base ./
node scripts/build-public-demo.mjs
```

The explicit Vite command also works in PowerShell environments that strip npm's forwarded `--base` argument. The copy helper refuses absolute asset paths and unmarked output folders. Only the browser build is copied; wallet databases, identities, bearer tokens and local native configuration are not deployment inputs.

The film, English captions and poster are repository assets published by GitHub Pages. Chapter buttons seek the actual video; an MP4 link remains available when embedded playback fails.

## Encoded video verification

The published MP4 is 88 seconds, 1280×720 H.264 at 30 fps with stereo AAC. It ends before the source film's technical-boundary chapter and fades cleanly after the testnet verification scene. A complete decode passed without errors and fast-start metadata is present. [Machine-readable media report](evidence/demo-video-v6.json).

The signed-out public GitHub README link, hosted video playback and chapter seeking were verified in a real browser. The complete Maya/Noor scenario was repeated on GitHub Pages and downloaded the matching 500-byte file. [Hosted smoke record](evidence/public-demo-smoke.json) · [Recovered file screenshot](evidence/experience/case-public-recovered.jpg).
