# Canary "sealed dossier" design pass — 1 November 2026

A presentation-only pass over the hosted app and the public landing page. No protocol, crypto, keeper, wallet or test code changed.

## Direction

An investigative case file on obsidian: warm ivory ink, Zcash gold as the only colour, paper case-file cards with a folder tab, registration marks on the hero frame, and a redaction bar as the one decorative motif (it lifts once off the hero's gold line; static under `prefers-reduced-motion`).

| Token | Value |
|---|---|
| Ground / surface / raised | `#0c0c0b` / `#141412` / `#1c1b18` |
| Ink / muted | `#f4f0e6` / `#b0aa9b` |
| Gold (the only accent) | `#f4b728` |
| Paper / paper ink | `#f1ecdf` / `#1b1914` |
| Radii | panels 18px, cards 14px, controls 10px, pills 999px |

- **Type:** Schibsted Grotesk (a typeface built for news publishing) for everything you read, Sometype Mono only for data and short labels. Both are SIL OFL; the landing page self-hosts the woff2 files in `docs/assets/fonts/` with their licences, and the app loads them through `@fontsource`. The serif italic accents are retired; emphasis is the same face in gold.
- **Scale:** display up to 80px, page titles 44px, section titles 24px, body 16px; nothing under 12px.
- **Components:** segmented pill navigation, split call-to-action buttons (label plus an arrow block), a mode pill in the "what is real" strip, folder-tab cards for the case file, the challenge list and the acceptance record.
- **Phones:** the hero art moves above the copy, the nav scrolls horizontally with an edge fade, challenge cards stack in one column, and the footer button goes full width. No horizontal overflow at 390px on any route.

## Where it lives

- `src/dossier.css` is loaded last and only restyles existing class names, so it can be removed in one line in `src/main.tsx`.
- `docs/assets/dossier.css` does the same for `docs/index.html` on top of `landing.css`.
- Markup changes are limited to image tags for the new art and one hatched divider on the overview.

## Original artwork

Twelve images in `public/assets/dossier/` (mirrored to `docs/assets/dossier/`) were generated for this pass with the ChatGPT image tool: the obsidian canary on a sealed dossier (hero and social card), five keeper monoliths, the cracked vault that holds, a sealed envelope for the inbox, and seven transparent icons (seal, check-in pulse, split key, open dossier, wrong key, stale hourglass, cancelled seal). The exact prompts are in [assets/dossier/PROMPTS.md](assets/dossier/PROMPTS.md). Wide images are WebP at quality 82; icons are 512px WebP with real alpha. None show text, logos, people or protocol state; they are illustrations, not evidence.

## Validation

- `npm run lint` and `npm test` (62 tests) pass; production build passes.
- `node scripts/verify-public-site.mjs` passes after regenerating `docs/app`.
- Every app route and the landing page were captured at 1440 and 390 pixels wide with no horizontal overflow.
