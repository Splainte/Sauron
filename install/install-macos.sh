#!/bin/bash
# Sauron — installation dev sur macOS (MacBook Air)
# 1. Active PlayerDebugMode (panneaux CEP non signés)
# 2. Symlink du panneau dans le dossier extensions CEP utilisateur
set -e

for V in 9 10 11 12; do
  defaults write com.adobe.CSXS.$V PlayerDebugMode 1
done

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.splainte.sauron"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"

echo "Sauron lié dans : $DEST"
echo "Redémarre Premiere Pro puis : Fenêtre > Extensions > Sauron"
