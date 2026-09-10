#!/bin/sh
# Builds public/data/canopy-il-100m.png — the tree-cover grid the shade estimate
# reads. Run by hand, NOT as part of `npm run build`: the output is committed,
# and rebuilding it means downloading ~110MB from ESA and takes minutes.
#
# Re-run this only to move to a newer land-cover year (see NOTE at the bottom).
#
# Requires GDAL on PATH (`brew install gdal`, or Postgres.app's bundled copy at
# /Applications/Postgres.app/Contents/Versions/latest/bin).
#
# Source: ESA WorldCover 10m v200 (2021), CC BY 4.0. Class 10 is "Tree cover".
# Three 3°x3° tiles cover Israel. They are read over HTTP with range requests —
# /vsicurl pulls only the windows we ask for, so nothing is downloaded whole.
set -eu

OUT_DIR="$(dirname "$0")/../public/data"
WORK="${TMPDIR:-/tmp}/canopy-build.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

BASE="https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200"
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
export CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif
export GDAL_HTTP_TIMEOUT=300

# Israel + a small margin. Deliberately generous on the coast so a trail that
# hugs the shoreline still samples inside the grid rather than falling off it.
WEST=34.2 NORTH=33.4 EAST=35.95 SOUTH=29.4

# 1. Virtual mosaic of the three tiles (no data is fetched by this step).
gdalbuildvrt -q "$WORK/src.vrt" \
  "/vsicurl/${BASE}_N27E033_Map.tif" \
  "/vsicurl/${BASE}_N30E033_Map.tif" \
  "/vsicurl/${BASE}_N33E033_Map.tif"

# 2. Cut out Israel at the native 10 m.
gdal_translate -q -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
  -co COMPRESS=LZW -co BIGTIFF=YES "$WORK/src.vrt" "$WORK/il10.tif"

# 3. Reduce the 11-class map to a tree/not-tree mask. color-relief with
#    -nearest_color_entry is an exact lookup, not a gradient, so only class 10
#    survives. (GDAL ships no gdal_calc in every distribution; this does the
#    same job with the core tools.)
cat > "$WORK/tree.txt" <<'COLORS'
10 255 255 255
0 0 0 0
20 0 0 0
30 0 0 0
40 0 0 0
50 0 0 0
60 0 0 0
70 0 0 0
80 0 0 0
90 0 0 0
95 0 0 0
100 0 0 0
COLORS
gdaldem color-relief -q -nearest_color_entry -co COMPRESS=LZW \
  "$WORK/il10.tif" "$WORK/tree.txt" "$WORK/mask.tif"

# 4. Average the mask down to ~100 m cells. Averaging a 0/255 mask is what
#    turns "is this pixel a tree" into "what fraction of this cell is canopy",
#    which is the number the app actually wants.
gdalwarp -q -b 1 -r average -tr 0.0009 0.0009 -ot Byte \
  -co COMPRESS=LZW "$WORK/mask.tif" "$WORK/il100.tif"

# 5. PNG, because the browser can decode it without a library.
gdal_translate -q -of PNG "$WORK/il100.tif" "$OUT_DIR/canopy-il-100m.png"
rm -f "$OUT_DIR/canopy-il-100m.png.aux.xml"

echo "wrote $OUT_DIR/canopy-il-100m.png"
gdalinfo "$OUT_DIR/canopy-il-100m.png" | grep "Size is"
echo "If the size is not 1944x4444, update public/data/canopy-il-100m.json to match."

# NOTE — moving to a newer year. WorldCover stops at 2021, which means fire
# scars since then are still shown as forest. Esri/Impact Observatory publish a
# 10 m annual map (CC BY 4.0) on AWS that goes to 2025. Swapping to it changes
# only steps 1-3 here: its tiles are per-year MGRS rather than 3°x3°, and its
# tree class is 2, not 10. Nothing in src/ knows the difference.
