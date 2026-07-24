# Design — The Bin (product-wide world)

One world, two expressions, since 2026-07-24 (user decision: "make the app
itself in this theme," full light chrome chosen over a dark hybrid):

- **App renderer** (`src/renderer/`) — this file governs it.
- **Landing page** (`site/`) — `site/DESIGN.md`, same world, marketing staging.

Lineage: pre-dark-era Avid Media Composer chrome. The app earlier wore a dark
"screening room" (slate + brass, Cormorant Garamond); that world is retired.

## Palette (tokens in `src/renderer/theme/tokens.css`)

- Desktop (window ground): `#9ea4a9`. Panel chrome: `#c7cbce`.
- Platinum bevel pair: light `#eceeef` top+left, dark `#74797d` bottom+right,
  1px inset shadows. Bevels replace ALL soft hairlines and glows.
- Work paper (bins, lists, panes): `#f4f5f6`, alternating row tint `#e9ebec`.
- Ink `#17191b`, secondary `#4d5257`, disabled `#8a9096`.
- Selection: black-inverse (`#17191b` ground, `#f4f5f6` text). Matched
  keywords on a selected row: `#f0d269`.
- Clip colors (chips only): red `#c94038`, orange `#d07a2e`, yellow `#c9a52a`,
  green `#4e8a4a`, blue `#3a6ea8`, purple `#7458a0`.
- Red `#c94038` is the locator: primary actions and record-weight moments
  only. Blue `#3a6ea8` is links, focus, and general interactive accent.
- Status: error `#a83329`, ok `#3f7140`, warn `#8a6d16` (AA on paper).
- The media player pane keeps a dark bezel (`#17191b` surround) so footage
  reads; it is the ONLY dark region in the app.

## Type

- UI + display: **Archivo** (Google Fonts; 400/500/600/800; Black for the
  rare display moment). ALL-CAPS with letterspacing for labels and column
  headers only.
- Data: **Fragment Mono** for timecode, clip names, counts, paths. Timecode
  always tabular.
- The serif display (Cormorant Garamond) is retired everywhere.

## Composition

- Radii <= 2px. No drop-shadow glows; elevation is bevel + 1px border
  (`#5c6165` on chrome) and, sparingly, hard offset shadows.
- Panels read as MC windows: flat chrome bars with stripe fills where a
  title row exists; content areas are inset paper with `--bevel-in`.
- No grain overlay, no vignette. The desktop may carry the faint diagonal
  hatch from the site.
- Scrollbars: thin, dark-alpha on paper.

## Motion

- Chrome snaps: `steps(2)` or none. Content may fade in <=200ms.
- Selection changes are instant (inverse flip), never eased.
- Respect prefers-reduced-motion.

## Boundaries

- No brass `#d0ad5f` anywhere.
- Red never decorates; if everything is red, nothing is recording.
- Footage thumbnails/keyframes and the player stay on dark bezels.
