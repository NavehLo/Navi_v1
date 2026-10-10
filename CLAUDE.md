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
- **Every AI or search call is limited and logged.** Call `ensureAllowed(provider)`
  (`src/lib/aiLimits.ts`) right before the call and `recordAiUsage` (from
  `src/lib/aiUsage.ts`) after a successful one; wrap the route's handler in
  `withAiUsage(request, area, …)` (an admin script: `withAiArea`, which is
  exempt). A text engine refused by a limit is skipped, not paused
  (`isAiLimitError`) — reaching a paid limit must leave the free engine
  working. Give a new area/kind a Hebrew label in `FEATURE_LABELS`
  (`src/components/AiUsagePanel.tsx`), a new model a price in
  `src/lib/aiPricing.ts`, and a row in README's "איפה האפליקציה משתמשת ב-AI".
  Paid keys are exactly `PAID_PROVIDERS` (OpenAI, paid Gemini, Claude); only
  they count in dollars, toward the daily caps and the email alerts.
  ElevenLabs and Tavily are on free plans with no billing — their cost is 0
  (`ELEVENLABS_TAVILY_BILLED` in aiPricing.ts) and their allowance is shown as
  credits. The limits' values live in `ai_settings`, set from the admin's
  screen — never hard-code a quota in a route or an env var. The admin
  (`ADMIN_EMAILS`) is exempt from every limit and alert. Client requests to
  these routes send `authHeaders()` (`src/lib/authHeaders.ts`) so usage is
  charged to the user, not to a guest. Code the admin's scripts load through
  Node's type stripping (anything `scripts/*.mjs` imports) must not use
  TypeScript parameter properties.
- **Sign-in is PKCE only.** The browser client is created with
  `flowType: 'pkce'` (`src/lib/supabase.ts`), and a sign-in that returns to
  the app is finished only by `exchangeCodeForSession`. Never call
  `setSession` with tokens read from a URL or a deep link — anyone can make
  such a link, and it would sign the reader into the link author's account.
- **Admin-only means server-side.** Gate with `isAdminRequest`
  (`ADMIN_EMAILS`); hiding a button is not enough. The admin's tools live in
  settings under "מתקדם" and "שימוש ועלויות AI".
- **Free-only features never fall back to a paid key.** The trip-day weather
  explanation uses `GEMINI_FREE_API_KEY` only.
- **ElevenLabs is on the free plan**: only `premade` voices work over the API
  (Voice Library voices → 402 `paid_plan_required`), and Hebrew only on
  `eleven_v3`. Credits (10,000/month, renewed on the 14th) and Tavily's
  (1,000/month, renewed on the 1st, pay-as-you-go off) are shown to the admin,
  who gets an alert on the map screen when either runs low or out
  (`CreditsAlert`).
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
  (`android-app/README.md`) only when the native side changes, on this Mac:
  `assembleRelease`, signed with this Mac's debug key so it updates the
  installed copy. Never ship `assembleDebug` — it is debuggable.
- **Panels on the map follow one layout contract.** An open panel collapses
  or closes on a tap outside it (`useOutsideTap`). An expanded panel covers
  the control rails (z-44/45, above the rails' 42) rather than sitting under
  them. Anything stacked above the bottom bar positions itself with
  `--bottom-stack-h` / `--progress-bar-h` (`useHeightVar`), never a fixed
  `bottom-[76px]`. "Hide all" (`uiHidden`) must hide every panel — hide a
  stateful one with a `hidden` wrapper rather than unmounting it. Long
  sections open as one line with a summary (`Collapsible`).
  A list's filters and its order stand in one fixed row of drop-downs above
  the list (`FilterDropdown`, or a `<select>` styled `SELECT_CLASS`) — never
  as rows of chips, and never inside the scrolling list. Opened on a phone,
  the trail list takes the screen's height down to the help chat's button.
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
  "מפת חום של מטיילים" weighs a trail only with `heatWeight`
  (`src/lib/trailHeat.ts`), from Komoot's hikers only, against the same fixed
  ceiling — the map's colours and the legend share `HEAT_STOPS` there.
  The world ranking ("מסלולים בעולם" → "לפי דירוג") scores trails only with
  `popularityScore` (`score.ts`), from Komoot's numbers only (`komootOf`),
  against fixed ceilings — never the largest value seen, or a trail's score
  would move when a country is collected or a filter changes. Run
  `checkCrowd.mjs` after changing a weight or a ceiling.
- **"רמת קושי" is decided in one place.** The three levels come only from
  `src/lib/difficulty.ts` — Komoot's grade where it covers the trail
  (`gradeCovers`, `match.ts`), else length and climb through `hikeEffort.ts`
  — and every list, filter and card calls it (the Israeli list via
  `difficulty` in `trails.json`, rebuilt with `scripts/buildDifficultyIndex.mjs`
  after `generateTrailIndex.js` or a change to the formula). A trail with no
  level is left out by a difficulty filter unless the reader keeps it. The
  grade lives inside `trail_crowd.sources` — an optional field, so adding it
  did not bump `CROWD_VERSION`; countries collected before it are filled with
  `scripts/fillKomootGrades.mjs` (free, re-reads Komoot's pages).
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
  sort functions. After rebuilding the layers, re-collect every country. The
  countries collected are the owner's list (`GROUPS` in
  `scripts/countryGroups.mjs`, by priority); a new one goes into its group there, not only on the command line.
- **A country's list covers its home land only.** `tilesFor` squares only the
  cells whose territory-level code is the country's (`homeLand`), so overseas
  territories (the Falklands, Svalbard, Greenland) never stretch the squares
  across the world — they did, and Britain's list had 2 trails. A change to
  the squares changes which trails a country lists: rebuild the lists
  (`collectLandscape.mjs --rebuild`) and re-collect their landscape.
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
- **Recorded walks are private and never lost.** A recording's numbers are
  computed only in `src/lib/recording/stats.ts` (live panel, summary, list
  and shared copy alike). The walk in progress is written to the device
  (`navi:recording.active.v1`) as it goes and comes back paused after a
  reload — never drop it on load. Saved recordings live on the device first
  (IndexedDB `navi-recordings`); the `recordings` table is the account copy.
  Others read one only through `/api/walk` (service role, `shared = true`,
  by id) — never grant `anon` on `recordings` or add a public policy, or the
  shared ones could be listed.
- **"אזורי טיול" is written by the admin, never by a visitor.** A country's
  guide is a static file (`public/country-guides/<CC>.json`, listed in
  `index.json`) written by `scripts/writeCountryGuide.mjs`, through the owner's
  subscriptions (Claude Code, Codex) by default — not the paid API. A source
  stays only if the search returned it (or, from Codex, the page exists) and
  the page mentions what it is cited for; never relax that to keep more links.
  Likewise a trail is tied to a marked route ("פתח מסלול", `link.ts`) only when
  the route's name holds most of its words and the same numbers, and it lies
  in the region — a wrong route opened is worse than no button.
  Bump `GUIDE_VERSION` (`countryGuide/types.ts`) only when the stored shape
  changes — every guide must then be rewritten. The country order is
  `scripts/countryGroups.mjs`, shared with the landscape collection.
- **Israel-only data stays in Israel.** The summer water/shade section and the
  רט״ג reminder are shown only when `isTrailInIsrael` (`src/lib/inIsrael.ts`)
  says so; anything new that relies on Israeli data (the canopy grid, the
  perennial-streams list) is gated the same way. "Water" in that section is
  always "מים לרחצה" — never let it read as drinking water.
- **"תמונות מהמסלול" are chosen in one place.** Which photos a trail shows is
  decided only in `src/lib/trailPhotos/select.ts`: at most one photo per part
  of the trail (`segmentCount`, ≤ 12), one per shoot (`groupShoots`), none
  farther than `CORRIDOR_M`, and an empty part stays empty — never fill it with
  a second photo from a richer part. Free sources only (Wikimedia Commons,
  Panoramax, the trail's own OSM/Wikidata image); never Google photos, Flickr's
  paid API or Mapillary (roads only). Every photo is shown with its author,
  licence and a link to its page, and only links are stored (`trail_photos`),
  never the pictures. The model's look (`vision.ts`) uses the free key only.
  Commons answers 429 to bursts: few searches per trail, one after another
  (`searchBoxes`). After changing a rule run `node scripts/checkPhotos.mjs`
  (`--live` for real trails) and bump `PHOTOS_VERSION` (`cache.ts`).
- **"שאלו את Navi" knows only the help text.** The help chat
  (`api/help-chat`) answers from `src/components/help/features.ts` and
  `tours.tsx` only: every new user-facing feature adds or updates its entry in
  `features.ts` (it is also the settings help), and every button that is
  added, moved or given a new icon is described in `src/lib/helpChat/places.ts`
  (where, icon, when it shows) with a matching `data-tour` on the button, for
  "הראה לי איפה". Its buttons come only from the
  whitelist in `src/lib/helpChat/actions.ts`, each wired in `runHelpAction`
  (`page.tsx`). On a phone its round button stands beside the folded panel at
  the bottom of a home screen: such a panel is `right-[72px]` when folded and
  calls `useHelpChatBeside`. Gemini rejects an empty string in a response
  schema `enum` (400, every question failed) — an optional field is left out
  instead. Free key only (`GEMINI_FREE_API_KEY`), like the weather
  explanation; questions are logged to `help_chat_log` without who asked.
- **A name in another script is shown in Latin letters too.** Wherever a
  world trail's name is shown, the line under it comes from `latinName`
  (`src/lib/trailNames.ts`): the English name (OSM or `trail_name_en`) when
  there is one, else the rule-based romanization in `src/lib/romanize.ts`
  (each country's official system; pass the country code when known — it
  picks the Cyrillic system). The original name always stays the title.
  Run `node scripts/checkRomanize.mjs` after changing a table.
- **The users report counts every feature, never the owner.** A new
  user-facing feature calls `track` (`src/lib/track.ts`) with a name added to
  `EVENT_LABELS` (`src/lib/appEvents.ts`, which is also the server's whitelist
  and the report's Hebrew label). Client requests send `authHeaders()` — it
  carries the device id (`X-Navi-Device`) as well as the token. The owner is
  left out only on the server (`src/lib/ownerExclusion.ts`: the address,
  `owner_devices`, `owner_ips` — an IP only for someone not signed in); never
  rely on the page to say who it is. Never store a raw IP (`hashClient`), and
  never write the owner's IP into a tracked file — the repository is public.
