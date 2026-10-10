#!/bin/bash
# Commits the trails' landscape file (src/data/trail-landscape.json.gz) and
# pushes it — after collectLandscape.mjs ran by hand, or a round that stopped
# before its end. Only that file: whatever else is changed in the folder stays
# as it is. scripts/crowdRound.sh runs it at the end of every round.
#
#   scripts/pushLandscape.sh BA XK MK RS      # the codes only name the commit

cd "$(dirname "$0")/.."
FILE=src/data/trail-landscape.json.gz

if git diff --quiet -- "$FILE" && git diff --cached --quiet -- "$FILE"; then
  echo "the landscape file has not changed since the last commit — nothing to push"
  exit 0
fi
WHAT=${*:-"מדינות שנאספו"}
git commit -q -m "מה אומרים מטיילים: $WHAT — נוף למסלולים שנוספו" -- "$FILE" \
  && git pull -q --rebase --autostash \
  && git push -q \
  && echo "pushed: $(git log --oneline -1)" \
  || { echo "commit or push failed — run: git status"; exit 1; }
