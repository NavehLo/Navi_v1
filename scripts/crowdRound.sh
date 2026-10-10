#!/bin/bash
# One round of "מה אומרים מטיילים" for a few countries, start to finish, run
# by the owner from the terminal:
#
#   scripts/crowdRound.sh BG RO PL CZ                 # Codex finds the pages, then the free crawl
#   scripts/crowdRound.sh --find crawl BG RO PL CZ    # the crawl alone (when Codex's allowance is out)
#   scripts/crowdRound.sh --find tavily BG RO         # Tavily (from the 1st of the month)
#   scripts/crowdRound.sh --pages 400 US              # a big country: the crawl reads up to 400 pages (default 200)
#   scripts/crowdRound.sh --again IT                  # collect a country that was collected already
#
# A country already collected is skipped unless --again is given, so a code
# typed twice, or a round run again after it stopped, costs nothing.
#
#   1. collects the countries one by one (scripts/collectCrowd.mjs) — saved
#      straight to the database, on the site at once; the Komoot pages read
#      are kept on this Mac (~/.cache/navi-komoot/dumps/crowd-<CC>.json), so
#      the matching can be run again later without reading Komoot again
#   2. their trails' landscape (scripts/collectLandscape.mjs) — a file
#   3. commits that file alone and pushes it (scripts/pushLandscape.sh)
#
# Everything it prints also goes to logs/crowd-<date-time>.log, and
# logs/crowd-latest.log always points at the newest; follow a round from
# another terminal tab with
#   tail -f logs/crowd-latest.log
# and see what is collected so far (and what is running now) with
#   node scripts/crowdStatus.mjs
#
# Never edit this file while a round runs — bash reads it as it goes. Write a
# new copy and move it over this one.

set -o pipefail
cd "$(dirname "$0")/.."

FIND=codex
PAGES=200
AGAIN=
while [ $# -gt 0 ]; do
  case "$1" in
    --find) FIND="$2"; shift 2 ;;
    --pages) PAGES="$2"; shift 2 ;;
    --again) AGAIN=1; shift ;;
    --*) echo "unknown option $1"; exit 1 ;;
    *) break ;;
  esac
done
if [ $# -eq 0 ]; then
  echo "usage: scripts/crowdRound.sh [--find codex|crawl|tavily] [--pages 200] [--again] <country codes…>"
  exit 1
fi
CODES=$(echo "$@" | tr a-z A-Z)

mkdir -p logs
LOG="logs/crowd-$(date +%Y-%m-%d-%H%M).log"
ln -sf "$(basename "$LOG")" logs/crowd-latest.log
# Node's notice about loading TypeScript, once per script — noise here.
quiet() { grep -v -e MODULE_TYPELESS -e Reparsing -e 'To eliminate' -e trace-warnings; }

# Skip what is collected already.
if [ -z "$AGAIN" ]; then
  DONE=" $(node scripts/crowdStatus.mjs --collected 2>/dev/null) "
  TODO=
  for CC in $CODES; do
    if [[ "$DONE" == *" $CC "* ]]; then echo "$CC is collected already — skipped (--again to collect it anew)" | tee -a "$LOG"
    else TODO="$TODO $CC"; fi
  done
  CODES=$(echo $TODO)
fi
if [ -z "$CODES" ]; then echo "nothing to collect" | tee -a "$LOG"; exit 0; fi

# What is running now, for crowdStatus.mjs; gone when the round ends.
RUNNING="logs/running-$$.txt"
echo "$CODES" > "$RUNNING"
trap 'rm -f "$RUNNING"' EXIT

DUMPS="$HOME/.cache/navi-komoot/dumps"
mkdir -p "$DUMPS"
for CC in $CODES; do
  echo "── $(date '+%H:%M') collecting $CC (--find $FIND, up to $PAGES pages)" | tee -a "$LOG"
  CROWD_DUMP="$DUMPS/crowd-$CC.json" node scripts/collectCrowd.mjs "$CC" --find "$FIND" --pages "$PAGES" 2>&1 | quiet | tee -a "$LOG"
done

echo "── $(date '+%H:%M') landscape for $CODES" | tee -a "$LOG"
node scripts/collectLandscape.mjs $CODES 2>&1 | quiet | tee -a "$LOG" || { echo "landscape failed — nothing committed" | tee -a "$LOG"; exit 1; }

echo "── $(date '+%H:%M') commit and push" | tee -a "$LOG"
scripts/pushLandscape.sh $CODES 2>&1 | tee -a "$LOG"
echo "── $(date '+%H:%M') done. node scripts/crowdStatus.mjs shows every country collected." | tee -a "$LOG"
