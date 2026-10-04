@AGENTS.md

# UI text must be readable

The app is used outdoors, on a phone, often in sunlight, on dark translucent panels.
Every piece of text — explanations, notes, numbers, hints — must be clearly readable:

- Default to white (`text-white`) on the dark panels. Do not use light grey on black
  (`text-zinc-400`, `text-zinc-500`, `text-zinc-600`) for anything the user is meant to read.
  Colour is fine for emphasis (amber for warnings, yellow/sky for key numbers) as long as it is bright.
- Minimum size for readable text is `text-xs` (12px); body text in panels is `text-sm`.
  `text-[10px]` / `text-[11px]` only for tiny labels that are not essential.
- When touching an existing panel, fix any low-contrast text in the part you changed.

# Local testing with the real map

`.env.local` (gitignored) holds the owner's public Mapbox token as
`NEXT_PUBLIC_MAPBOX_TOKEN`, so the local dev server renders the real map and
map features can be clicked through in the preview browser. Use it for testing;
never commit the token or copy it into tracked files.

# Keep the documentation current

Every feature, setting, table or paid service added to the app is documented in
the same change:

- `README.md` — the feature table ("מה יש באפליקציה"), the env-var tables, the
  cost table ("עלויות"), the database table list, and a section of its own for
  anything non-obvious. The README is in Hebrew, for the owner.
- `CLAUDE.md` — any new rule a future change must follow (the list below).

# Project map

The README's "מה יש באפליקציה" table says where each feature lives. In short:
API routes in `src/app/api/*`, server logic in `src/lib/*`, UI in
`src/components/*`, the database in `supabase/schema.sql`, the Android shell in
`android-app/`, planning notes in `docs/`.

# Rules learned the hard way

- **Database changes are run by the owner.** The Supabase project is not
  reachable from the tools here. Add every change to `supabase/schema.sql`
  (idempotent: `if not exists`, `drop policy if exists`, `create or replace`)
  and tell the owner to re-run the whole file. This project has **no default
  table privileges**: every new table needs explicit `grant`s — to
  `authenticated` for per-user tables, to `service_role` (and its identity
  sequence) for server-only tables — or PostgREST answers 42501.
- **Every paid AI or search call is logged.** Call `recordAiUsage` (from
  `src/lib/aiUsage.ts`) after a successful call, wrap the route's handler in
  `withAiUsage(request, area, …)`, give a new area/kind a Hebrew label in
  `FEATURE_LABELS` (`src/components/AiUsagePanel.tsx`), and a new model a
  price in `src/lib/aiPricing.ts`. Client requests to such routes send
  `authHeaders()` (`src/lib/authHeaders.ts`) so usage is attributed to the user.
- **Admin-only means server-side.** Gate with `isAdminRequest`
  (`ADMIN_EMAILS`); hiding a button is not enough. The admin's tools live in
  settings under "מתקדם" and "שימוש ועלויות AI".
- **Free-only features never fall back to a paid key.** The trip-day weather
  explanation uses `GEMINI_FREE_API_KEY` only.
- **ElevenLabs is on the free plan**: only `premade` voices work over the API
  (Voice Library voices → 402 `paid_plan_required`), and Hebrew only on
  `eleven_v3`. Credits (10,000/month) are shown to the admin, who gets an alert
  when they run low or out.
- **Caches have versions.** Bump `DISCOVERY_VERSION` (`poiDiscoveryCache.ts`)
  and `PREFIX` (`poiCache.ts`) when the guide-point filter changes, and
  `INFO_VERSION` (`trailInfo/cache.ts`) when "על המסלול" changes. Bumping
  `PROMPT_VERSION` (`poiKey.ts`) regenerates every narration and costs money —
  only when the narration wording rules change.
- **The month ratings are pinned.** "מתי כדאי ללכת" is decided only in
  `src/lib/climate.ts`; after changing a rule or threshold there, run
  `node scripts/checkClimate.mjs` and bump `CLIMATE_VERSION` (it is in every
  cache key: on the device, and in `country_trails` on the server). The trail
  card and the world-trail lists must keep rating through the same functions
  (`rateMonths`, `rateLongWalk`) so they never disagree. The grid
  (`src/data/climate-grid.bin.gz`) is rebuilt only with
  `scripts/buildClimateGrid.mjs` (the regions file likewise, with
  `scripts/buildRegions.mjs`), and any route that reads either must be listed
  in `outputFileTracingIncludes` in `next.config.ts`. A change to the shape of a
  stored country list bumps `LIST_FORMAT` in `countryTrails.ts`.
  Rebuilding the grid (e.g. moving the recent decade, `RECENT_FROM`/`RECENT_TO`)
  also bumps `CLIMATE_VERSION`, and README's "מתי כדאי ללכת" says which decade.
- **Offline is tested on the production build** (`prod` launch config);
  `next dev` never hydrates without a network.
- **Android**: web changes need only a deploy. Rebuild the APK
  (`android-app/README.md`) only when the native side changes, on this Mac
  (debug-signed).
- **Panels on the map follow one layout contract.** An open panel collapses
  or closes on a tap outside it (`useOutsideTap`). An expanded panel covers
  the control rails (z-44/45, above the rails' 42) rather than sitting under
  them. Anything stacked above the bottom bar positions itself with
  `--bottom-stack-h` / `--progress-bar-h` (`useHeightVar`), never a fixed
  `bottom-[76px]`. "Hide all" (`uiHidden`) must hide every panel — hide a
  stateful one with a `hidden` wrapper rather than unmounting it. Long
  sections open as one line with a summary (`Collapsible`).
- **"מה אומרים מטיילים" is derived in one place.** The traffic tier and the
  rating are computed only in `src/lib/trailCrowd/score.ts` (list, filters,
  trail card, and the leading trails via `leadersOf` — list, country picker and
  map stars — all call it); run `node scripts/checkCrowd.mjs` after changing a
  rule. Tiers are relative to the country and computed on read — never store
  them. A trail with no signal is "אין מספיק מידע", never "few". The numbers
  come from Komoot's per-area "best hikes" pages, tied to our trails by
  geometry (`match.ts`) — no per-trail search, no model. Collecting a country
  is an admin run (settings → מתקדם, or `scripts/collectCrowd.mjs`), never
  triggered by a visitor; a run that read too few routes must not save. Bump
  `CROWD_VERSION` only when what is stored changes. Google ratings may not be
  stored, so they are not a source.
  Trails found under Komoot's routes (`discover.ts`) join the country's list
  (`addTrails`) and live on through `trail_crowd`: `build()` re-adds every
  trail with numbers there. Never delete a country's `trail_crowd` rows to
  "clean up" — its list would lose its most walked local paths.
- **"הרים, יער ונהרות" is derived in one place.** The words, levels and filters
  for mountains, forest and rivers come only from `src/lib/landscape.ts`; the
  build (`scripts/buildLandscape.mjs`) stores only numbers (a relief histogram,
  shares). A relief threshold must be one of the stored bins (`RELIEF_BINS` in
  the build); run `node scripts/checkLandscape.mjs` after changing any
  threshold. "Dramatic" is local relief (highest minus lowest within ~2.5 km),
  never absolute height. Rebuilding `src/data/landscape.json.gz` needs the
  regions file first; a change to what is stored bumps `LANDSCAPE_FORMAT` in
  the build and `LANDSCAPE_VERSION` in landscape.ts. The river model is weak in
  the Middle East — Israeli trails keep using `perennialStreams.ts`.
  Per-trail summaries (`src/data/trail-landscape.json.gz`) are collected on
  this Mac with `scripts/collectLandscape.mjs` from the 1 km layers in
  `~/.cache/navi-landscape`; they share the country shape (shares of the
  trail's length, `kind: 'trail'`), so pass `'trail'` to the water, filter and
  sort functions. After rebuilding the layers, re-collect every country.
- **Going back never loses the reader's place.** A panel that unmounts while
  a trail is open keeps its state at module level (`WorldByMonth`,
  `TrailDiscovery`: `kept`) and is reopened through `openSignal`. Close a
  trail only through `closeTrail` in `page.tsx` — it keeps the trail for
  "חזרה ל…" and returns to the list it came from; the phone's back button runs
  the same path (`backRef`).
- **Every table needs grants in schema.sql**, including service-role-only
  caches (RLS alone is not enough here; see the rule on database changes).
  `trail_pois`, `poi_narration`, `narration_audio`, `trail_info`,
  `trail_name_en` and `trail_country` were missing theirs until 2026-10.
- **Israel-only data stays in Israel.** The summer water/shade section and the
  רט״ג reminder are shown only when `isTrailInIsrael` (`src/lib/inIsrael.ts`)
  says so; anything new that relies on Israeli data (the canopy grid, the
  perennial-streams list) is gated the same way. "Water" in that section is
  always "מים לרחצה" — never let it read as drinking water.
