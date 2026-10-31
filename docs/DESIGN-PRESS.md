# Canary "press room" redesign — 1 November 2026

A from-scratch presentation rebuild of the hosted app and the public landing page. Protocol, crypto, keeper, wallet and test code are unchanged; all 62 tests pass.

## Direction

Light and calm, like a premium security product: white cards on a cool grey studio gradient, black ink and one canary yellow. Condensed capitals with a yellow highlighter carry the key phrases. Redaction tape that reads "Sealed until silence" is the one recurring motif.

| Token | Value |
|---|---|
| Page / card / sunken | `#eceef2` / `#ffffff` / `#f4f5f8` |
| Ink / muted | `#111214` / `#646a74` |
| Canary yellow | `#ffe135` (hover `#ffd60a`) |
| Radii | cards 28px, inner panels 18px, controls are pills |

- **Type:**
  - Sofia Sans Extra Condensed 800 for display.
  - Geist for text.
  - Geist Mono for data and labels.
  - All three are SIL OFL; the landing page self-hosts them in `docs/assets/fonts/` with their licences.
  - Nothing is set under 12px.
- **Layout:**
  - The overview hero has the copy on the left, the product object in the centre and floating status widgets on the right. The widgets show the browser-lab vault's real state.
  - A bento follows: the problem, the sealed file, three steps, why Zcash, and the honest limits.
  - Each challenge is a card beside one large result card.
  - Judge Proof is a hero with a yellow verdict card, then stat tiles and evidence sections.
  - Every page shares a dark footer card.
- **Motion:** cards lift on hover and the hero widgets float in once. All of it is disabled under `prefers-reduced-motion`.
- **Phones:** the navigation becomes a menu sheet, and cards and buttons stack. No route scrolls horizontally at 390px.

## Files

- **App styles:** `src/styles/press.css` (tokens, shell, buttons, cards), `overview.css`, `challenge.css`, `proof.css` and `screens.css`.
- **Removed:** the old `src/index.css`, `src/ledger.css` and the per-component CSS files.
- **Rewritten markup:** the app shell, Overview, Break the vault and Judge Proof. The other screens keep their markup: the example, vault, inbox, support, tour, keepers and native. Their dark utility colours are mapped to the new tokens and styled in `screens.css`.
- **Landing page:** `docs/index.html` is rewritten and keeps the original video, captions, chapter script and anchors. `docs/assets/press.css` is generated from the app styles by `node scripts/build-landing-css.mjs`, so the two never drift.

## Original artwork

Twelve images were generated for this pass with the ChatGPT image tool. They live in `public/assets/press/` and are mirrored to `docs/assets/press/`.

- The yellow ceramic canary on a sealed folder, used as the hero and the social card.
- Five keeper pillars.
- A cracked vault whose core holds.
- A sealed envelope.
- Seven transparent icons.

The exact prompts are in [assets/press/PROMPTS.md](assets/press/PROMPTS.md). The images contain no text, logos or people, and they are illustrations, not protocol state.

## Validation

- `npm run lint` passes, and `npm test` passes 62 of 62.
- `npm run build -- --base=./` passes.
- `node scripts/verify-public-site.mjs` passes after regenerating `docs/app`.
- All 11 app routes and the landing page were captured at 1440 and 390 pixels wide, with no horizontal overflow.
