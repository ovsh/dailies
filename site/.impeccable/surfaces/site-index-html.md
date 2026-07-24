---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: []
---

# Surface brief — Dailies landing page (site/index.html)

Mode: Persuade. Confirmed by user 2026-07-23.

## Job and audience
Documentary and reality-TV editors and assistant editors (Avid users, Apple Silicon
Macs) arrive skeptical of "video AI" and protective of their footage. They must
understand what Dailies is, see it doing its real job, and download it.

## Outcome and proof
Primary action: Download the notarized DMG (GitHub release). Proof is the real
product: actual app screenshots (authored demo data, labeled), the local-first truth
told plainly, Avid-native specifics (OP-Atom in place, real clip names, source TC,
markers + CMX3600 EDL).

## Content spine (contractual, user-confirmed)
1. WHAT IT IS — Dailies / "Chat with your footage", one sentence for doc & reality
   editors, Download + GitHub.
2. SEE IT — full-width real screenshot: chat answering a real question with clip cards.
3. HOW IT WORKS — overnight rhythm: point at Avid MediaFiles → local pipeline
   (source TC → proxies/scenes → on-device Whisper → index) → ask → click through
   to the moment. Library + clip/transcript screenshots.
4. PROOF — honesty section: media never leaves the machine (text excerpts to
   OpenRouter, said plainly); reads OP-Atom MXF in place under real Avid clip names;
   ~10 min per hour of footage on an M-series Mac; markers + EDL back into Avid;
   the agent says "found nothing" over inventing hits. Plus a short first-person
   origin note: built for an editor friend — finding moments in hours of footage
   was taking him hours; hope it helps you too. Signed Miki.
5. ACTION — Download (notarized DMG), requirements (Apple Silicon, macOS 14+,
   OpenRouter key, one-time ~1.6 GB speech model), footer: personal project by Miki.

## Boundaries
- Real screenshots of the real app only; no CSS depictions of the product.
- No fabricated testimonials, customers, benchmarks; soft speed claim only.
- No em dashes in surface copy; unslop everything including <title>.
- Distinct world from PowerWatch Daylight (pixel sky) and the Loadout site.
- Download button: real asset URL once the release exists; honest marked
  placeholder until.

## States and ranges
Static page; responsive to mobile. Screenshot lightbox optional. Reduced-motion safe.

## Constraints
Deploys via personal-website repo (ovsh.github.io/dailies/), synced by
scripts/sync-site.sh. Single self-contained page preferred (index.html + assets/).

## Resolved deviations (2026-07-24, user-confirmed)
- Beat 2 (SEE IT) ships without a real chat-answer screenshot: no OpenRouter
  key was available in the capture profile and the user chose "Skip real chat
  answer." The hero's page-native sift (verbatim real transcript rows) plus
  the real clip-view and library captures carry the beat. When a key is next
  available, capture a real chat answer and give SEE IT its chat shot.
- Chosen direction: The Bin (grounded 4 of 7, seed ea177cc2), user-picked over
  the Emulsion fused alternate. Black-inverse selection is the hit-row idiom.
- Sift hit quotes are verbatim transcript prefixes; TCs computed at the app's
  documented 30 fps audio-only fallback from real start TCs.
