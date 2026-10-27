# Maya and Noor: the public demo

The example follows a fictional journalist who wants her editor to recover a reporting file if she stops checking in. It uses a harmless, public 500-byte text fixture.

- [Watch the narrated example](https://unspecifiedcoder.github.io/z-canary/)
- [Run the interactive example](https://unspecifiedcoder.github.io/z-canary/app/#maya-noor)
- [Download the video and editable film source](https://github.com/unspecifiedcoder/z-canary/releases/tag/demo-v2)
- [Inspect the verification record](evidence/VERIFICATION.md)

## What the video shows

The 3:12 film is an edited walkthrough of actual browser actions and their results. It uses captured app states and editorial action highlights; it is not a continuous screen recording. The fictional scenario sends no blockchain transactions. Encryption, signatures, threshold reconstruction, recipient-key rejection and decryption execute in the browser using the existing demonstration engine.

The story covers protection, early recovery rejection, check-in, cancellation, a fresh missed-check-in branch, grace-period check-in, stale scanner suspension, insufficient shares, recovery with two keepers offline, the wrong recipient key and verified download. A final chapter presents previously recorded native Zcash testnet evidence separately.

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

The film is hosted as a GitHub release asset. English captions and the poster are ordinary repository assets. Chapter buttons seek the actual video; an MP4 link remains available when embedded playback fails.

## Edit the film

The release's source ZIP contains the deterministic HTML/GSAP scenes, captured public example states, narration timeline, captions and mixed audio. Install its pinned Node dependencies and use its documented HyperFrames check, preview and render commands. The included audio is ready to use; voice model weights are not required to re-render the film. Credits and reproduction notes are included in that archive.
