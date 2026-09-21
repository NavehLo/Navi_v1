# נסיעה בכביש + שכבת מסלולים עולמית — מחקר ותכנון

## Context

היום האפליקציה עושה דבר אחד: מסלול טיול (ארוז, מ־URL או מקובץ) → מפה בתלת
מימד → סיור וירטואלי עם מדריכה. שתי בקשות מרחיבות את זה:

1. **אזור נפרד לנסיעה בכביש.** מוצא ויעד — בחיפוש טקסט עם השלמה אוטומטית, או
   בנעץ על המפה כשלמקום אין שם — ואז לראות איך נראית הדרך לפני הנסיעה. בכל
   העולם, ועם מהירויות גבוהות (x10, x20, x50) כי נסיעות ארוכות.
2. **toggle שמראה מסלולי טיול על המפה, בכל העולם,** במקום לחפש קבצי KML/GPX.
   לחיצה על מסלול → שם, מרחק, עלייה/ירידה, וכל מידע אחר שיש.

המסמך הזה הוא מחקר + תכנון. הוא לא מממש. כל endpoint, פרמטר ומבנה תשובה שמופיע
כאן נבדק מול השירות החי או מול הדוקומנטציה הרשמית ביום כתיבתו (21.9.2026).

**החלטות שכבר התקבלו עם המשתמש:** מקור המסלולים העולמי הוא **Waymarked Trails**
(מסלולים מסומנים/בעלי שם מ־OSM), לא "כל שביל עפר".

---

## 1. מצב הקוד הקיים ונקודות שילוב

הקוד כבר מחזיק את רוב אבני הבניין. מה שחסר הוא בעיקר **מקורות** חדשים למסלול,
לא מנוע חדש.

| רכיב | קובץ | מה זה נותן לנו |
|---|---|---|
| מנוע הסיור: time‑based, rAF, `virtualElapsed += dt * speed` | `src/hooks/useTour.ts:86` | כל מכפיל מהירות עובד בלי שינוי. **`SEC_PER_KM = 45` = 80 קמ"ש ב־x1** — כבר מהירות נסיעה סבירה |
| זום לפי מהירות (`zoomForSpeed`, נוסף עם x5) | `src/hooks/useTour.ts` | מרחיבים את הטבלה ל־x10/x20/x50 |
| `processCoordinates(coords, name)` → `TrailData` | `src/hooks/useTrailData.ts:188` | **כל מסלול חיצוני** (Directions, Waymarked) נכנס דרך הפונקציה הזו ומקבל מרחקים מצטברים, פרופיל גובה, POI סינתטיים |
| `TrailSource` = `url` \| `file` | `src/hooks/useTrailData.ts:35` | צריך kind חדש כדי לשמור/לשתף |
| מצבי מסך = state ב־`TrailApp`, בלי URL routes | `src/app/page.tsx:96` | "אזור נפרד" = state נוסף, לא route |
| popover "תצוגת מפה" (סגנון + toggle תלת מימד) | `src/components/Controls.tsx:259-272` | הבית הטבעי ל־toggle "מסלולים בעולם" |
| שכבות מפה עם `styleRev` + `style.load` | `src/app/page.tsx:568-621` | תבנית לכל שכבה חדשה (חובה, אחרת החלפת סגנון מוחקת אותה) |
| חיפוש עם dropdown הצעות, Escape/blur | `src/components/TrailDiscovery.tsx:296-335` | תבנית ויזואלית מוכנה ל־autocomplete |
| `rateLimit`, `clientIp`, `status: ok/unavailable/rate-limited` | `src/lib/rateLimit.ts`, `src/app/api/pois/route.ts` | תבנית ל־proxy של Waymarked |
| טוקן Mapbox: `NEXT_PUBLIC_MAPBOX_TOKEN` או אישי ב־localStorage, `mapboxgl.accessToken` | `src/components/Map.tsx:21,24,144` | Search/Directions של Mapbox נקראים עם אותו טוקן |
| `AttributionControl` ידני (OSM + ESA) | `src/components/Map.tsx:69-82` | לכאן נכנס הייחוס ל־Waymarked |
| `mapboxgl.Popup` + עיצוב `.mapboxgl-popup` | `src/app/globals.css`, `TrailDiscovery.tsx` | פופאפ לחיצה על מסלול |

**מה אין בקוד היום:** geocoding, directions, חישוב עלייה/ירידה (`StatsPanel` מציג רק
אורך, מינימום ומקסימום גובה), שכבות raster חיצוניות, toggle לשכבה בודדת.

---

## 2. מצב נסיעה בכביש

### 2.1 מקורות נתונים — מה נבדק

**המלצה: Mapbox, עם הטוקן שכבר יש.** האפליקציה כבר תלויה ב־Mapbox, הטוקן כבר
בדפדפן, והשירותים האלה נמצאים בתוך ה־free tier (100k בקשות/חודש לכל אחד).

| צורך | שירות | endpoint (אומת מול הדוקומנטציה) | הערות |
|---|---|---|---|
| השלמה אוטומטית | **Search Box API** | `GET https://api.mapbox.com/search/searchbox/v1/suggest?q=…&session_token=…&language=he&proximity=lon,lat&limit=6` → `suggestions[]{name, place_formatted, mapbox_id, feature_type}` | תומך POI (שדה תעופה, אתר), כתובות, ערים. `session_token` = UUID חדש לכל focus של שדה |
| קואורדינטות של הצעה | Search Box API | `GET …/searchbox/v1/retrieve/{mapbox_id}?session_token=…` → `features[0].geometry.coordinates` (`[lon, lat]`) | **suggest+retrieve באותו session = חיוב אחד** |
| שם לנעץ | Search Box API | `GET …/searchbox/v1/reverse?longitude=&latitude=&language=he` | חיוב per‑request |
| מסלול נסיעה | **Directions API** | `GET https://api.mapbox.com/directions/v5/mapbox/driving/{lon},{lat};{lon},{lat}?geometries=geojson&overview=full&language=he` → `routes[0].{distance (מ'), duration (שנ'), geometry.coordinates}` | עד 25 נקודות; `overview=full` = הגיאומטריה המלאה; **אין גובה בתשובה** |

**למה Search Box ולא Geocoding v6:** v6 לא מחזיר POI. "נמל התעופה בן גוריון" או
"מצדה" צריכים Search Box.

**חלופות שנבדקו ונדחו:**
- **OSRM demo** (`router.project-osrm.org`) — חינם, עולמי, אבל שרת הדגמה בלי SLA
  ובלי הרשאה לייצור. טוב לפיתוח בלבד.
- **Photon (komoot)** ל־geocoding — חינם, אבל תוצאות POI בעברית חלשות ואין
  session billing (כל הקשה = בקשה).
- **Mapbox Search JS (`@mapbox/search-js-react`)** — רכיב מוכן, אבל מביא CSS
  ו־UI משלו שלא מתאים לעיצוב הכהה/RTL. הקריאות עצמן הן שני `fetch`, לא שווה תלות.

**מי קורא:** ישירות מהדפדפן, כמו המפה עצמה. הטוקן ממילא ציבורי
(`NEXT_PUBLIC_…`). המלצה תפעולית: להגדיר **URL restriction** על הטוקן המשותף
בחשבון Mapbox, כך שרק הדומיין של האפליקציה יכול להשתמש בו. טוקן אישי
(משתמש שהזין בעצמו) חייב לכלול את ה־scopes של Search ו־Directions — אם לא,
הודעת שגיאה ברורה: "הטוקן שלך לא מאפשר חיפוש/ניווט".

### 2.2 מסך התכנון (`DrivePlanner.tsx`, חדש)

- **כניסה:** מתג עליון במסך הבית — "מסלולי טיול | נסיעה בכביש". state
  `appMode: 'trails' | 'drive'` ב־`page.tsx`, נשמר ב־localStorage. במצב drive
  מוצג `DrivePlanner` במקום `TrailDiscovery`, באותו פאנל צף (אותן מחלקות
  Tailwind, `dir="rtl"`).
- **שני שדות** (מוצא, יעד), כל אחד עם dropdown הצעות: debounce 300ms, לא
  שולחים מתחת ל־2 תווים, Escape/blur סוגרים (העתקה 1:1 מ־`TrailDiscovery.tsx:296-335`).
  ההצעה מציגה `name` בבולד ו־`place_formatted` מתחת. `proximity` = מרכז המפה
  הנוכחי, כך שבישראל "תל" מציע תל אביב לפני Tel Aviv, Texas.
- **"בחר על המפה"** ליד כל שדה → **נעץ מרחף:** אייקון נעץ קבוע במרכז המסך
  (`position:absolute; left:50%; top:50%`, `pointer-events:none`), המשתמש מזיז
  את המפה מתחתיו, וכפתור "נעץ כאן" לוקח `map.getCenter()`, מציב marker רגיל,
  ומבקש `reverse` לשם (אם אין שם — "נקודה 32.08, 34.78"). זה הדפוס של Uber/Google
  Maps ועובד טוב במגע; לחיצה על המפה כדי להניח נעץ מתנגשת עם גרירה/סיבוב.
- **"חשב מסלול"** → Directions → `coords = geometry.coordinates.map(([lon,lat]) => [lat, lon, 0])`
  → `processCoordinates(coords, "מוצא → יעד")` → `setTrailSource({ kind: 'drive', from, to })`
  → `map.fitBounds`. מעבר למסך המסלול הרגיל.

### 2.3 מסך המסלול במצב נסיעה

אותו מסך, עם התאמות לפי `trail.kind === 'drive'` (שדה חדש ב־`TrailData`,
ברירת מחדל `'hike'`):

| רכיב | hike | drive |
|---|---|---|
| `StatsPanel` | אורך, גבהים, צל, מים | אורך, **זמן נסיעה** (`driveDurationSec` חדש, מ־`duration`), בלי צל/מים/פרופיל גובה (אין גובה) |
| `useTrailPOIs`, `useSummerConditions`, geofence, מדריכה | פעילים | **כבויים** (`enabled: false`) — Overpass על 500 ק"מ הוא לא דבר שעושים, ומדריכת טבע לא רלוונטית לכביש |
| קו המסלול | כתום | כחול (`route-line` עם `paint` תלוי kind) |
| כפתור "שמור" / "שתף" | קיים | שלב 2 (ראה 2.5) |
| "גובה נוכחי" בפס ההתקדמות | מהקובץ | `map.queryTerrainElevation(center)` בזמן הסיור (הטריין כבר טעון) או להסתיר |

### 2.4 מהירויות ומצלמה

`TOUR_SPEEDS` (נוסף ב־`Controls.tsx` עם x5) הופך לפונקציה של kind:

```ts
hike:  [1, 2, 5]
drive: [1, 2, 5, 10, 20, 50]
```

`zoomForSpeed` מורחב, ופיץ' יורד במהירויות הגבוהות (הטריין בזום נמוך עם פיץ' 60
נראה שטוח ומוזר):

| מהירות | מ'/שנ' וירטואלי | zoom | pitch | הערה |
|---|---|---|---|---|
| x1 | 22 | 17 | 60 | כמו היום |
| x5 | 111 | 15.5 | 60 | כמו היום |
| x10 | 222 | 14.5 | 55 | |
| x20 | 444 | 13.5 | 50 | |
| x50 | 1,111 | 12.5 | 45 | אריח z12 ≈ 10 ק"מ → אריח חדש כל ~9 שנ', נטען בזמן |

**זמנים:** מסלול 500 ק"מ: x1 = 6.25 שעות, x10 = 37 דק', x20 = 19 דק', x50 = 7.5 דק'.
מסלול 100 ק"מ: x10 = 7.5 דק', x50 = 1.5 דק'.

שני שיפורים קטנים במנוע שנדרשים לזה:
- `lastGeoJsonUpdateRef` קיים ב־`useTour.ts:21` ולא בשימוש — להשתמש בו כדי לעדכן
  את `fly-pos` רק כל 50ms (ב־x50 `setData` כל frame מיותר).
- דילול גיאומטריה: `overview=full` על 500 ק"מ יכול להחזיר 50k+ נקודות. לפני
  `processCoordinates` להריץ דילול פשוט (להשמיט נקודה שמרחקה מהקודמת < 5 מ').
  `lerpByDist` הוא binary search, אז זה לא קריטי לביצועים אבל כן לזיכרון ול־GeoJSON.

### 2.5 שמירה ושיתוף (שלב 2)

- `saved_trails.source_url` יכול להחזיק `drive:lon,lat;lon,lat|שם מוצא|שם יעד`
  — `handleLoadSavedTrail` מזהה את הקידומת ומריץ Directions מחדש. אין צורך
  בעמודה חדשה ב־Supabase.
- שיתוף: `/?drive=lon,lat;lon,lat` לצד `?trail=` הקיים (`page.tsx:375-401`).

### 2.6 סיכונים

| סיכון | טיפול |
|---|---|
| עלות Mapbox — autocomplete מחויב per‑session, אבל session נסגר גם אחרי 180 שנ' | debounce, מינימום 2 תווים, UUID חדש רק ב־focus |
| טוקן אישי בלי scopes | לתפוס 401/403 מ־Search/Directions ולהציג הסבר, לא להפיל את המפה |
| `SEC_PER_KM` קבוע — אוטוסטרדה ועיר באותה מהירות | מקובל; זו הדמיה, לא ניווט. אפשר בעתיד להשתמש ב־`legs[].annotation.speed` |
| מסלולים בין יבשות / מעבורות | Directions מחזיר `NoRoute` → הודעה "לא נמצא מסלול נסיעה" |
| המשתמש עובר בין מצבים באמצע סיור | `setTrail(null)` כבר מאפס את הסיור (`useTour.ts:173`) |

---

## 3. שכבת מסלולי טיול עולמית — Waymarked Trails

### 3.1 מה זה ומה נבדק

[Waymarked Trails](https://hiking.waymarkedtrails.org) מרנדר את כל ה־`relation`
מסוג `route=hiking` ב־OSM, בכל העולם, ומחזיק API פתוח מעל אותו מסד נתונים. זה
לא "כל שביל עפר" — זה **מסלולים מסומנים/בעלי שם**: שביל ישראל, שביל גולני,
שביל הים, שבילי סימון אזוריים; ובעולם GR, E‑paths, Appalachian Trail וכו'.
בדיוק מה שמישהו מחפש כשהוא "לא רוצה לחפש קבצי GPX".

רישוי: נתונים ODbL (OSM), אריחים CC‑BY‑SA. **חובה ייחוס** "© Waymarked Trails"
לצד "© OpenStreetMap". אין מדיניות שימוש כתובה; הנורמה (leaflet‑trails, OsmAnd,
Locus) היא שימוש מתון עם ייחוס ו־User‑Agent מזהה. לא לשימוש מסחרי כבד.

**כל מה שלמטה נבדק מול השרת החי:**

#### אריחים
`https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png` — PNG שקוף, 256px,
מכיל רק את קווי המסלולים. מתאים בדיוק ל־overlay מעל הלוויין.

#### API — base `https://hiking.waymarkedtrails.org/api/v1`

> **חשוב:** `bbox` הוא ב־**EPSG:3857 (Web Mercator, מטרים)**, לא lon/lat.
> בדיקה עם lon/lat החזירה `results: []` בשקט. המרה:
> `x = lon · 20037508.34 / 180`, `y = ln(tan((90+lat)·π/360)) · 20037508.34 / π`.

| endpoint | פרמטרים | תשובה (נבדק) |
|---|---|---|
| `GET /list/by_area` | `bbox=minx,miny,maxx,maxy`, `limit` (1–100, ברירת מחדל 20), `locale=he` | `{ bbox, results: [{ type:'relation', id, name, group: 'NAT'\|'REG'\|'LOC', linear: 'yes'\|'no'\|'sorted', symbol_id, symbol_description? }] }`. bbox סביב הכרמל החזיר: שביל גולני, שביל ישראל, שביל הים |
| `GET /details/relation/{id}` | `locale=he` | `name, group, linear, symbol_id, operator, description, url, wikipedia, bbox (3857), tags, route`. **`route.length` = אורך במטרים** (שביל הים: 65,744). `route.main[]` = קטעים; כל קטע `{ route_type, start, length, ways: [{ id, direction, length, role, geometry: { type:'LineString', coordinates (3857) } }] }`. `route.appendices[]` = ענפים צדדיים |
| `GET /details/relation/{id}/way-elevation` | `simplify=<מטרים>` (למשל 50) | `{ min_elevation, max_elevation, segments: { [wayId]: { elevation: [{ x, y, ele, pos }] } } }` — גובה מ־DEM לכל way, `pos` = מרחק לאורך ה־way במטרים. **אין עלייה/ירידה** — מחשבים אצלנו |
| `GET /list/search` | `query=`, `limit`, `page` | חיפוש לפי שם/ref — שלב 2 |
| `GET /details/relation/{id}/wikilink` | `locale` | redirect לוויקיפדיה |

**מה שאין:** endpoint ל־GPX/GeoJSON מוכן (ה־API הישן הוסר). הגיאומטריה
מגיעה בתוך `details.route`, מפוצלת ל־ways, ב־3857.

### 3.2 מגיאומטריה של Waymarked ל־`TrailData`

פונקציה חדשה `src/lib/waymarked.ts` → `wmtRouteToCoords(details, elevation?)`:

1. לעבור על `route.main[]` לפי הסדר, ובכל קטע על `ways[]` לפי הסדר.
2. לכל way: `geometry.coordinates`, להפוך אם `direction === -1`.
3. להמיר 3857 → WGS84: `lon = x / 6378137 · 180/π`, `lat = atan(exp(y / 6378137)) · 360/π − 90`.
4. גובה: אם יש `way-elevation`, לקחת את `segments[wayId].elevation[].ele` ולמפות
   לפי `pos` על אורך ה־way (אינטרפולציה ליניארית); אחרת 0.
5. להסיר כפילויות בחיבורי ways (נקודה אחרונה = ראשונה של הבא).
6. `processCoordinates(coords, details.name)`.

**`linear: 'no'`** (רשת, לא רציף — שביל גולני מסומן כך כי הוא מפוצל לקטעים
ב־OSM) — להציג את הכרטיס והמידע, אבל **לא להציע סיור** (השרשור ייתן קפיצות).
`'sorted'`/`'yes'` — הכל.

### 3.3 עלייה/ירידה — helper חדש

`computeElevationGain(elevations: number[], threshold = 5)` ב־`src/utils/trailUtils.ts`:
היסטרזיס — סוכמים שינוי רק כשהוא חוצה סף מצטבר של 5 מ', כדי לא לספור רעש DEM
(בלי סף, שביל של 10 ק"מ על DEM של 30 מ' מקבל "עלייה" של מאות מטרים מדומים).
מחזיר `{ gain, loss }`. **בונוס:** אותו helper נכנס ל־`StatsPanel` גם למסלולים
הרגילים — היום המסך לא מציג עלייה/ירידה בכלל.

### 3.4 ממשק

- **Toggle:** ב־popover "תצוגת מפה" (`Controls.tsx:259-272`), אחרי כפתור התלת
  מימד: "מסלולי טיול בעולם — הצג/הסתר". state `showWorldTrails` ב־`page.tsx`,
  localStorage `navi:worldTrails`, מימוש דרך `map.setLayoutProperty('wmt-hiking', 'visibility', …)`.
  זמין גם במסך הבית וגם במסך מסלול; נשאר דלוק גם בזמן סיור.
- **שכבה:** effect לפי התבנית של `page.tsx:568-621`: `addSource('wmt-hiking', { type:'raster', tiles:[…], tileSize:256, maxzoom:18, attribution })`,
  `addLayer({ id:'wmt-hiking', type:'raster', paint:{ 'raster-opacity': 0.9 } }, 'route-line')`
  — מעל הלוויין, מתחת לקו המסלול הנוכחי. Raster נדרס על הטריין אוטומטית.
  להוסיף "© Waymarked Trails" ל־`AttributionControl` ב־`Map.tsx:69-82`.
- **לחיצה:** אריחים לא ניתנים ללחיצה, אז: `map.on('click')` כשהשכבה דלוקה →
  bbox של ±12px סביב הנקודה (`map.unproject` לשני הפינות → 3857) →
  `by_area?limit=10` → אם ריק, כלום; אם יש → `mapboxgl.Popup` עם רשימת
  המסלולים (שם + קבוצה). בחירה → `details` → **כרטיס מסלול** (רכיב חדש
  `WorldTrailCard.tsx`, באותו פאנל צף של `StatsPanel`):
  - שם, סוג (לאומי / אזורי / מקומי לפי `group`), אורך (`route.length / 1000` ק"מ)
  - מפעיל, תיאור, קישור לאתר, קישור ויקיפדיה — כשקיימים
  - אחרי `way-elevation` (בקשה שנייה, עם spinner): מינ' / מקס' / עלייה / ירידה
  - כפתור **"טען מסלול"** → `wmtRouteToCoords` → `processCoordinates` →
    `setTrailSource({ kind:'wmt', id })` → מסך המסלול הרגיל, כולל סיור, צל ומים
  - "טען מסלול" מוסתר כש־`linear === 'no'`, עם הסבר "המסלול מפוצל ב־OSM"
- **בזום נמוך** (< 8) האריחים מציגים רק מסלולים לאומיים — זה בסדר, אבל לחיצה
  שם תחזיר עשרות תוצאות; להגביל לחיצה ל־zoom ≥ 9 עם הודעה "התקרב כדי לבחור מסלול".

### 3.5 Proxy בשרת

`src/app/api/world-trails/route.ts` (GET) עם שלושה מצבים:
`?bbox=…` → by_area, `?id=…` → details, `?id=…&elevation=1` → way‑elevation.

למה לא ישירות מהדפדפן: (א) `User-Agent` מזהה — הנורמה מול שירותים קהילתיים
(כמו ב־`api/pois/route.ts:89`); (ב) `rateLimit('wmt:'+ip, 10, 60_000)` מגן על
השירות מפני משתמש שלוחץ על המפה בטירוף; (ג) cache ב־`Map` לפי URL, כי `details`
של שביל ישראל (1,079 ק"מ) הוא כמה מגה; (ד) CORS מהשרת שלהם לא מובטח.
אותו חוזה `status: 'ok' | 'unavailable' | 'rate-limited'` — כשהשירות למטה
המשתמש רואה "שכבת המסלולים לא זמינה כרגע", לא שגיאה.

### 3.6 סיכונים

| סיכון | טיפול |
|---|---|
| רק מסלולים עם `relation` ב־OSM — שביל עפר בלי שם לא יופיע | זו הגדרת הפיצ'ר (הוסכם). בישראל הכיסוי טוב מאוד |
| שירות קהילתי בלי SLA | `unavailable` שקט; האריחים נטענים ישירות ואם הם נופלים — המפה פשוט בלי הקווים |
| `details` של מסלול ענק (שביל ישראל: כמה MB) | לבקש רק בלחיצה על מסלול ספציפי; `way-elevation` רק אחרי הכרטיס נפתח; `simplify=50` |
| "טען מסלול" של 1,000 ק"מ מפעיל Overpass ב־`useTrailPOIs`/`useSummerConditions` | סף `MAX_KM_FOR_OSM_QUERIES = 60` ב־hooks; מעליו `unavailable` מיידי בלי בקשה |
| כפילות עם 83 המסלולים הארוזים (שביל ישראל מופיע פעמיים) | מקובל; הארוז נשאר המקור המועדף כי יש לו צל/מים מחושבים מראש |
| ייחוס | שורה ב־`AttributionControl` כשהשכבה דלוקה — תיקון גם של חוב קיים |

---

## 4. סדר שלבים מוצע

| # | מה | קבצים | הערכה |
|---|---|---|---|
| 1 | שכבת האריחים + toggle + ייחוס | `page.tsx`, `Controls.tsx`, `Map.tsx` | יום |
| 2 | proxy + לחיצה → פופאפ → כרטיס (שם/אורך/מפעיל) | `api/world-trails/route.ts`, `WorldTrailCard.tsx`, `lib/waymarked.ts` | יום |
| 3 | `way-elevation` + `computeElevationGain` + "טען מסלול" (+ עלייה/ירידה ב־`StatsPanel`) | `trailUtils.ts`, `StatsPanel.tsx`, `useTrailData.ts` | יום |
| 4 | מצב נסיעה: מתג, `DrivePlanner`, Search Box autocomplete, Directions → `TrailData` | `page.tsx`, `DrivePlanner.tsx`, `lib/mapboxSearch.ts`, `lib/mapboxDirections.ts` | 2 ימים |
| 5 | סיור במצב נסיעה: `kind`, מהירויות x10–x50, zoom/pitch, כיבוי POI/צל/מים, זמן נסיעה | `useTour.ts`, `Controls.tsx`, `StatsPanel.tsx`, hooks | יום |
| 6 | נעץ מרחף + reverse geocode | `DrivePlanner.tsx` | חצי יום |
| 7 | שלב 2: שמירה/שיתוף למצב נסיעה, חיפוש מסלולים עולמי בטקסט (`/list/search`) | | לפי צורך |

שלבים 1–3 ו־4–6 בלתי תלויים; אפשר להתחיל מכל אחד.

## אימות מקצה לקצה

- **שכבה:** להדליק את ה־toggle בכרמל → קווים כתומים/אדומים על הלוויין; להחליף
  סגנון מפה → הקווים נשארים; לכבות ולרענן → נשאר כבוי.
- **לחיצה:** על שביל הים ליד עתלית → פופאפ עם "שביל הים" → כרטיס עם 65.7 ק"מ →
  "טען מסלול" → סיור עובד, פרופיל גובה לא שטוח.
- **linear=no:** שביל גולני → כרטיס בלי "טען מסלול" ועם ההסבר.
- **נסיעה:** "תל אביב" → "אילת": הצעות בעברית, מסלול כחול ~330 ק"מ, זמן נסיעה
  ~3.5 שעות, x50 מסיים בכ־5 דקות בלי אריחים אפורים, בלי בקשות Overpass
  (לבדוק ב־Network).
- **עולמי:** "Paris" → "Berlin": אותו דבר, מוכיח שאין תלות בישראל.
- **נעץ:** "בחר על המפה" באמצע הנגב → "נעץ כאן" → השדה מתמלא בשם או בקואורדינטות.
- **שגיאות:** לכבות רשת → toggle מציג "לא זמין", לא שגיאה; טוקן בלי scope →
  הודעה מוסברת.
