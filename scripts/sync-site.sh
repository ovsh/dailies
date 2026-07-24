#!/bin/bash
# Sync the Dailies landing page into the personal website repo, which is the
# single deploy for ovsh.github.io/dailies/. Run after editing site/.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../site" && pwd)"
DEST="$HOME/Documents/code/personal-website/dailies"
mkdir -p "$DEST/assets"
cp "$SRC/index.html" "$DEST/"
cp "$SRC/assets/clip-view.png" "$SRC/assets/library.png" "$DEST/assets/"
echo "Synced site/ -> $DEST (commit and push personal-website to deploy)"
