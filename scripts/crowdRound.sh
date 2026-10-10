#!/bin/bash
# One round of "מה אומרים מטיילים" for a few countries, start to finish, run
# by the owner from the terminal:
#
#   scripts/crowdRound.sh BG RO PL CZ                 # Codex finds the pages, then the free crawl
#   scripts/crowdRound.sh --find crawl BG RO PL CZ    # the crawl alone (when Codex's allowance is out)
#   scripts/crowdRound.sh --find tavily BG RO         # Tavily (from the 1st of the month)
#
#   1. collects the countries (scripts/collectCrowd.mjs) — saved straight to
#      the database, on the site at once
#   2. their trails' landscape (scripts/collectLandscape.mjs) — a file
#   3. commits that file alone and pushes it, so the next deploy has it
#
# Everything it prints also goes to logs/crowd-<date-time>.log, and
# logs/crowd-latest.log always points at the newest; follow a round from
# another terminal tab with
#   tail -f logs/crowd-latest.log
# and see what is collected so far with
#   node scripts/crowdStatus.mjs

set -o pipefail
cd "$(dirname "$0")/.."

FIND=codex
if [ "$1" = "--find" ]; then FIND="$2"; shift 2; fi
if [ $# -eq 0 ]; then
  echo "usage: scripts/crowdRound.sh [--find codex|crawl|tavily] <country codes…>"
  exit 1
fi

mkdir -p logs
LOG="logs/crowd-$(date +%Y-%m-%d-%H%M).log"
ln -sf "$(basename "$LOG")" logs/crowd-latest.log
# Node's notice about loading TypeScript, once per script — noise here.
quiet() { grep -v -e MODULE_TYPELESS -e Reparsing -e 'To eliminate' -e trace-warnings; }

echo "── $(date '+%H:%M') collecting $* (--find $FIND)" | tee -a "$LOG"
node scripts/collectCrowd.mjs "$@" --find "$FIND" 2>&1 | quiet | tee -a "$LOG"

echo "── $(date '+%H:%M') landscape for $*" | tee -a "$LOG"
node scripts/collectLandscape.mjs "$@" 2>&1 | quiet | tee -a "$LOG" || { echo "landscape failed — nothing committed" | tee -a "$LOG"; exit 1; }

echo "── $(date '+%H:%M') commit and push" | tee -a "$LOG"
if git diff --quiet -- src/data/trail-landscape.json.gz; then
  echo "the landscape file did not change — nothing to commit" | tee -a "$LOG"
else
  # Only this file: whatever else is changed in the folder stays as it is.
  git commit -q -m "מה אומרים מטיילים: $* — נוף למסלולים שנוספו" -- src/data/trail-landscape.json.gz \
    && git pull -q --rebase --autostash \
    && git push -q \
    && echo "pushed: $(git log --oneline -1)" | tee -a "$LOG" \
    || echo "commit or push failed — see git status" | tee -a "$LOG"
fi
echo "── $(date '+%H:%M') done. node scripts/crowdStatus.mjs shows every country collected." | tee -a "$LOG"
