# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(The product itself is a macOS Electron app, Apple Silicon, macOS 14+. The surfaces
Impeccable designs here — the landing page at `site/` — are web.)

## Users

Documentary and reality-TV editors and assistant editors, on Apple Silicon Macs,
working in Avid Media Composer against large volumes of raw camera media ("dailies").
Their job: find the moment — a line someone said, a beat a producer remembers — inside
tens of hours of footage, fast, and get it back into Avid as markers or a selects
sequence. Secondary: story producers and post supervisors who triage footage.

Professional audience. They know Avid, MXF, EDLs, timecode, and drop-frame; they are
allergic to marketing fluff and to anything that uploads their footage.

## Product Purpose

Dailies is "chat with your footage": a local-first macOS app that transcribes footage
on-device (whisper.cpp, Metal), indexes it semantically, and answers plain-language
questions with clip cards — thumbnail, real Avid clip name, source timecode, what was
said — that click through to the exact moment. Answers export as Avid locator lists
(markers) and CMX3600 EDLs. Success: a shoot day dropped in a watched folder in the
evening is searchable by morning, and a producer question becomes a marked-up sequence
in minutes.

## Positioning

Reads Avid MediaFiles in place — OP-Atom MXF atoms are grouped back into clips under
their real Avid clip names, no exports, nothing moved or copied. Media never leaves the
machine; transcription is fully local. Only text excerpts and embedding inputs go to
OpenRouter (one API key, stored in the macOS Keychain). Neighboring tools either demand
cloud upload of media or don't speak Avid natively.

## Operating Context

- One project per show; episodes (e.g. `201`, `202`) scope both the library and chat.
- Footage folders are watched; new files index automatically. Audio-first pipeline:
  probe (frame-accurate source TC, drop-frame aware) → proxy + scene detection →
  local Whisper transcription → keyword + semantic index.
- Producer notes, scripts, stringouts (PDF/Word/Markdown/Excel) import into the same index.
- Chat answers carry SAID tags, confidence dots, FINAL tags for exported cuts.
- Exports land in `~/Documents/Dailies Exports/`; markers import into Media Composer
  as colored locators, EDLs as selects sequences.

## Capabilities and Constraints

- Apple Silicon only, macOS 14+. Electron app, signed with Digital Lane LLC Developer ID
  (team 7Z82LSPAPP); notarization is being added in this effort.
- Speed claim (confirmed, use this and not the raw benchmark numbers): an hour of
  footage indexes in roughly 10 minutes on an M-series Mac, mostly transcription.
- Whisper speech model is a one-time ~1.6 GB download inside the app.
- Requires an OpenRouter API key for chat + embeddings (user-supplied).
- Free public download; distribution is a notarized DMG on GitHub releases
  (github.com/ovsh/dailies). Version at time of writing: 0.2.1 (first notarized build).
- Terminology: dailies, clips, atoms, markers/locators, EDL, selects, stringout,
  source TC, timeline TC. Use the audience's words.

## Brand Commitments

- Name: **Dailies**. Tagline in use: "Chat with your footage."
- Personal project by Miki (first-person voice on the page; footer links to the
  personal site at ovsh.github.io). Digital Lane LLC appears only as the code-signing
  identity, not as a brand.
- The app's own UI is "The Bin" (since 2026-07-24): pre-dark-era Media Composer
  steel chrome — desktop #9ea4a9, panel chrome #c7cbce with platinum bevels, paper
  #f4f5f6, Archivo + Fragment Mono, red #c94038 as the locator. One world for app
  and landing page; see root DESIGN.md (app) and site/DESIGN.md (marketing). The
  earlier dark "screening room" (slate/brass/Cormorant) is retired.

## Evidence on Hand

- The real app builds and runs (`npm run dev`); real screenshots must come from it,
  with authored demo data, labeled where mistakable for real footage.
- Validation run (2026-07-13, GOAL.md): all gates green — grouping, transcription,
  grounded chat answers, valid marker/EDL exports. Usable as narrative fact
  ("validated end-to-end"), but per user decision the page quotes only the soft
  speed claim.
- No testimonials, no named customers, no press. Do not fabricate any.
- Test footage exists at `landscaping test/` (7 real OP-Atom MXF atoms).

## Product Principles

1. Local-first is the product: footage never leaves the machine, and every claim about
   privacy must stay literally true (text excerpts DO go to OpenRouter — say so).
2. Speak Avid natively: real clip names, source timecode, markers and EDLs — the
   audience's tools, not generic "video AI" language.
3. Grounded answers over impressive ones: the agent says "found nothing" rather than
   inventing hits; surfaces show real product output only.
4. Overnight rhythm: drop footage in the evening, search it in the morning — the
   workflow promise the product is built around.
