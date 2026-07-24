# Design — Dailies landing page

Scope: `site/` only. The app's own renderer keeps its incumbent "screening room"
world (slate + brass, `src/renderer/theme/tokens.css`); this file governs the
marketing page, a deliberately different world. Chosen 2026-07-23 via the
Impeccable direction roll (seed key ea177cc2, assigned index 4 of the grounded
list), user-confirmed over the Emulsion (16mm strip) alternate.

World: **The Bin** — the page is built as a Media Composer bin. Not the modern
dark MC: the pre-dark-era steel-gray chrome veteran editors remember (Meridien /
Adrenaline age), which also keeps the page out of the dark-neon "video AI" rut.
The real app screenshots (dark slate) sit inside this light chrome like source
monitors on a gray desktop.

## Palette

- `--desktop: #9ea4a9` — the MC application desktop the windows sit on
  (subtle diagonal texture allowed, drawn, no blur filters).
- `--chrome: #c7cbce` — window/panel chrome. `--chrome-hi: #eceeef` /
  `--chrome-lo: #74797d` — the platinum bevel pair (1px light top+left,
  1px dark bottom+right). Bevels are the corner language; radii near zero
  (2px max).
- `--paper: #f4f5f6` — bin row area (text view ground). Alternating row tint
  `#e9ebec`.
- `--ink: #17191b`; secondary `#4d5257`. Ink on paper and chrome passes AA.
- Selection: black-inverse rows (`#17191b` row, `#f4f5f6` text) — period-true.
- Clip colors (the only saturated color, used as small chips and section keys):
  red `#c94038`, orange `#d07a2e`, yellow `#c9a52a`, green `#4e8a4a`,
  blue `#3a6ea8`, purple `#7458a0`.
- CTA: the red locator. Download button = red marker pill (`#c94038`,
  white text, oval — an Avid locator scaled up). Red is otherwise reserved.

## Type

- Display: **Archivo** (Black / Expanded weights) — broadcast-utilitarian
  headlines, tight leading, sentence case for claims, ALL-CAPS only for
  window titles and column headers.
- Body/UI: **Archivo** (400/500/600).
- Mono: **Fragment Mono** — timecode, clip names, column data, labels.
  Timecode always tabular: `01:02:14:08`.

## Composition

- The page is a column of bin windows on the desktop ground, max width ~1100px.
- Every window: title bar (caps, close box drawn, non-functional decoration
  kept honest — no fake OS), then the bin tab row: Brief | Text | Frame | Script.
  Each section "is" one view: Text view = columnar how-it-works, Frame view =
  real screenshots, Script view = transcript-style origin note.
- One loud plain-language headline per window (Archivo Black) so the offer
  always outweighs the chrome — this is the direction's recorded risk counter.
- Screenshots are REAL app captures (real landscaping project). Labeled
  "real project, real footage" where a visitor could wonder.

## Motion

- Signature: **the sift** — in the hero bin, a query types into the sift field
  and clip rows filter live down to the hits (starts on load when the bin is
  in the first viewport, IntersectionObserver otherwise; respects
  prefers-reduced-motion; misses fade in steps(3) then collapse). Hit rows
  take the black-inverse selection; the matched keyword renders as #f0d269
  text on the selected row, yellow-wash highlight only on unselected paper.
- Chrome snaps (no easing or steps(2)); content reveals use short opacity
  rises only. No blur filters on ambient layers, transform/opacity only.
- No pixelated media, no VHS noise — this world is crisp utilitarian chrome.

## Boundaries

- Distinct from siblings: PowerWatch Daylight (pixel sky, rounded, blue) and
  the Loadout site. No pill buttons except the marker oval; no sky, no cream.
- No dark-ground hero; the only dark regions are the real app screenshots.
- No em dashes anywhere in surface copy, including <title>.
