# מפה בשטח בלי קליטה — מחקר, החלטה ומימוש

## Context

האפליקציה כבר יודעת לעבוד בלי קליטה כמעט לגמרי: הקריינות נשמרת ב-IndexedDB
(`lib/offlineAudio`), נקודות העניין והמים נשמרים ב-localStorage (`lib/poiCache`,
`lib/waterCache`), קובצי ה-GPX הארוזים נכנסים ל-cache של ה-Service Worker אחרי
צפייה, ומצב שטח משתמש ב-GPS של המכשיר. מה שחסר היה **אריחי המפה**: ה-Service Worker
דילג במכוון על כל בקשה ל-Mapbox, ובלי קליטה המסלול צויר על מסך שחור.

הסיבה שזה לא נעשה עד עכשיו הייתה טענה שהתקבלה כעובדה: *"ל-Mapbox GL JS אין offline
API, ה-cache של הדפדפן מוגבל ל-12 שעות, ו-Service Worker ששומר אריחים יהיה נגד תנאי
השימוש; offline קיים רק ב-SDK הנייטיב."* המסמך הזה בדק את הטענה מול המקורות
(22.9.2026), מצא שהיא לא מדויקת, השווה חלופות, ומתעד את מה שמומש.

**ההחלטה:** להשאיר את Mapbox ואת המנוע הקיים, ולשמור את אריחי המסלול על המכשיר
דרך ה-Service Worker, בתוקף 30 יום — כפי שתנאי המוצר של Mapbox מרשים.

---

## 1. מה Mapbox באמת מרשה

המקור: [Mapbox Product Terms](https://www.mapbox.com/legal/product-terms), גרסת
21.7.2026 (PDF). הסעיפים הרלוונטיים, מצוטטים:

**§2.8.1 Mapping APIs** — *"For Licensed Map Content delivered through a Mapping API,
Customer may cache that Licensed Map Content on an End User's device but caching is
limited to thirty (30) days on the same device making the Mapping API request. For
clarity, the Licensed Application is required to populate any on-device cache of
Licensed Map Content delivered through Mapping APIs directly from the Mapping APIs.
… Customer shall not distribute Licensed Map Content, including from a cache, by
proxying, or by using a screenshot or other static image…"*

כלומר: cache על מכשיר הקצה **מותר, עד 30 יום**, בתנאי שהמכשיר עצמו הביא את התוכן
מ-api.mapbox.com — לא דרך שרת שלנו ולא כקובץ מוכן.

**§3.32** — "Licensed Map Content" כולל אריח, תמונה סטטית, קובץ סגנון, glyph ו-sprite.
כולם תחת אותו כלל. **אין החרגה לתמונות לוויין**; §2.8.2 אוסר רק להשתמש בהן כדי
"לשפר" תמונות אחרות.

**§1.9 Default Restrictions** — "(ii) not perform bulk or automated queries, (iii) not
scrape or systematically download Licensed Map Content" — האזור האפור. הורדת פרוזדור
של מסלול אחד בלחיצה של משתמש היא "human application interaction" (סעיף i), אבל
היא גם שיטתית. ה-SDK הנייטיב עושה בדיוק את זה, בברכת Mapbox. **הטיפול:** מייל קצר
ל-Mapbox support לאישור (נוסח בסעיף 8), ובינתיים חבילה = מסלול אחד ולא אזור.

**§2.14 Web SDK** — אסור לשנות או להפריע לנתונים שה-SDK שולח ל-Mapbox ולקוד החיוב.
לכן ה-Service Worker **לא נוגע** ב-`map-sessions` וב-`events.mapbox.com`: בלי קליטה
הם נכשלים בכנות, והמפה ממשיכה לצייר.

**"12 שעות"** — זה `Cache-Control: max-age=43200` על תשובות האריחים (נמדד) והמשפט
"the default device TTL is 12 hours" ב-[דף העזרה על caching](https://docs.mapbox.com/help/troubleshooting/api-caching/).
הגדרה טכנית של ה-cache הפנימי של ה-SDK, לא מגבלה חוזית.

**Offline "רשמי"** קיים רק ב-Mobile SDKs (עד 750 tile packs, כלול בחיוב ה-MAU —
[Offline maps](https://docs.mapbox.com/help/dive-deeper/mobile-offline/)). המפה שלנו
היא web, וזה היה דורש לכתוב מחדש את כל שכבת המפה.

**מחירים** ([Pricing](https://www.mapbox.com/pricing)): Map Loads לאתר 50,000 בחודש
חינם; Raster Tiles API 750,000 בקשות בחודש חינם; Vector Tiles API 200,000. בקשות
ישירות (בלי `sku`) נספרות כ-Tiles API; בקשות של המפה עצמה כלולות ב-Map Load.
**עלות המימוש: 0 ₪** — מסלול של 14 ק"מ הוא כ-240 בקשות לכל מקור.

---

## 2. מה המפה מבקשת בפועל

נמדד בדפדפן על GL JS 3.22 עם `satellite-streets-v12`. חשוב לשני דברים: מפתח ה-cache,
ומה בדיוק להוריד.

| מה | URL (בלי טוקן) | הערה |
|---|---|---|
| סגנון | `api.mapbox.com/styles/v1/mapbox/satellite-streets-v12?sdk=js-3.22.0` | |
| אייקונים | `…/styles/v1/mapbox/satellite-streets-v12/iconset.pbf` | v3 במקום sprite |
| TileJSON | `…/v4/mapbox.mapbox-terrain-dem-v1.json?secure` | רק ל-DEM; לשאר לא נשלח |
| לוויין | `…/v4/mapbox.satellite/{z}/{x}/{y}@2x.webp?sku=…` | ה-TileJSON מציין `a.tiles.mapbox.com/…png`, ה-SDK משכתב |
| רחובות | `…/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.vector.pbf?sku=…` | נטען מה-worker |
| גובה | `…/raster/v1/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}.webp?sku=…` | 514px, webp lossless, נטען מה-worker |
| גופנים | `…/fonts/v1/mapbox/{fontstack}/{range}.pbf` | עברית = range 1280-1535 |
| RTL | `…/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js` | |
| חיוב | `…/map-sessions/v1?sku=…`, `events.mapbox.com/events/v2` | **לא נוגעים** |

שתי מסקנות:

1. **מפתח ה-cache = ה-path בלבד.** ה-hosts שונים (`api` מול `a.tiles`), וה-`sku`
   משתנה בכל session. ה-path הוא מה שנשאר קבוע.
2. **את הגובה אי אפשר להוריד מאותו endpoint.** `/raster/v1/` עונה 401 לבקשה בלי `sku`,
   ו-Mapbox מתעדים את `mapbox-terrain-dem-v1` כ"זמין ל-SDK בלבד". מה ש-`/v4/` מחזיר
   עבורו הוא נתונים אחרים: כשמשווים לאריחים של ה-SDK, אחד מעשרה פיקסלים קופץ ביותר
   מ-30 מטר, והטריין מצטייר כשדה קוצים (נבדק, נראה). הפתרון: **Terrain-RGB**
   (`mapbox.terrain-rgb`), ה-tileset הקודם, ציבורי ב-Raster Tiles API, אותו קידוד
   (`height = -10000 + rgb·0.1`), נתונים חלקים. הוא נשמר תחת המפתחות שהמפה תבקש
   ל-DEM. חובה `.pngraw` (lossless) ו-`@2x` (512px — ה-SDK תופר גבולות בין אריחי
   טריין שכנים וזורק שגיאה על אי-התאמת גודל, והאריחים שהוא הביא בעצמו הם 512).

---

## 3. חלופות שנבדקו

| | איך | עלות | מראה | תוקף | פגיעה במבנה |
|---|---|---|---|---|---|
| **A. Mapbox דרך Service Worker** (נבחר) | ה-SW שומר את בקשות api.mapbox.com; כפתור הורדה מביא את פרוזדור המסלול | 0 ₪ | זהה — לוויין + תלת-ממד | 30 יום | מינימלית |
| **B. MapLibre + אריחים פתוחים** | מנוע שני ([MapLibre GL JS 6.10](https://github.com/maplibre/maplibre-gl-js), BSD) עם `addProtocol` + [pmtiles 4.5](https://github.com/protomaps/PMTiles) שקורא קובץ מהמכשיר. **כך בנויה אפליקציית Israel Hiking Map** (Capacitor + `maplibre-gl ^6.10` + `pmtiles ^4.5` + RevenueCat למנוי offline — `IsraelHiking.Web/package.json` ב-[IsraelHikingMap/Site](https://github.com/IsraelHikingMap/Site)) | 0 ₪ | טופוגרפי, בלי לוויין | קבוע | בינונית: מסך שטח נפרד, קוד שכבות כפול |
| **B1. מקור: Protomaps** | [planet ≈ 120 GB ל-z0–15](https://docs.protomaps.com/basemaps/downloads); `pmtiles extract --bbox` חותך אזור ב-HTTP range; "hotlinking discouraged" → להעתיק ל-[Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) (10 GB חינם, egress חינם). ODbL, סגנון CC0 | 0 ₪ | | | |
| **B2. מקור: Israel Hiking Map** | TileJSON ציבורי `israelhiking.osm.org.il/vector/data/IHM.json` (OpenMapTiles, maxzoom 14), `TerrainRGB.json` (z7–12), `Contour.json`; סגנון `Styles/IHM.json`. רישיון **CC-BY-NC-SA 3.0** — לא מסחרי, "For commercial licensing, please contact the authors". שרת מתנדבים — לתאם לפני הורדות אוטומטיות | 0 ₪ | המפה הטובה ביותר לטיולים בארץ | | |
| **B3. מקור: OpenFreeMap** | [אריחים וקטוריים חינם, בלי מפתח, "no limits"](https://openfreemap.org/), אפשר self-host | 0 ₪ | | | |
| **גובה פתוח** | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium, בלי מפתח, ייחוס חובה) | 0 ₪ | | | |
| **C. אפליקציה נייטיב + Mapbox Maps SDK** | offline packs, 25k MAU חינם | Apple 99$/שנה + Google 25$ | לוויין | | **גדולה** — כתיבה מחדש של שכבת המפה |

**לוויין ב-offline בלי Mapbox — אין חינמי.** Esri "World Imagery (for Export)" דורש
מנוי ArcGIS Online; זו הסיבה ש-AllTrails ו-Gaia מוכרים את זה ב-Pro. §2.8.1 של Mapbox
הוא הדרך היחידה ללוויין ב-0 ₪.

[map-gl-offline](https://github.com/muimsd/map-gl-offline) (MIT, 0.8.9) הוא ספרייה
קטנה שמוכיחה ש-Mapbox GL JS v3 עובד offline דרך Service Worker. לא נלקחה כתלות —
צעירה, וה-SW שלנו כבר עושה את אותו דפוס לקריינות.

---

## 4. אחסון בטלפון

- **Android/Chrome** (המכשיר של הפרויקט — Pixel; אין אייפון): המכסה לאתר מגיעה
  לעשרות אחוזים מהדיסק, ו-`navigator.storage.persist()` — שמתבקש בהורדה הראשונה —
  מוציא את האחסון מתור הפינוי. עובד מ-Chrome רגיל; "הוסף למסך הבית" הוא נוחות.
- **iOS** (רק למי שישתמש משם): Safari מוחק את האחסון של אתר אחרי 7 ימים בלי
  אינטראקציה; אפליקציות שנוספו למסך הבית פטורות
  ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/),
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
  ההודעה "הוסף את Navi למסך הבית" מוצגת רק שם.
- **נפח שנמדד:** "אל מקורות נחל סער", 13.6 ק"מ, לוויין, z5–16 + טריין z10–13:
  **20 MB** (~240 אריחי לוויין, ~240 וקטור, 15 טריין, גופנים וסגנון). ההערכה על
  הכפתור לפני ההורדה: ~27 MB (שמרנית בכוונה). מסלול ארוך פי 4 ≈ פי 4.

---

## 5. מה מומש

### עקרונות

1. **המנוע לא משתנה.** Mapbox GL JS, אותם סגנונות, אותו קוד שכבות. ה-online לא מרגיש.
2. **הדף מוריד, ה-SW מגיש.** Cache Storage נגיש גם מהדף: ההורדה כותבת ישירות
   ל-`navi-map-v1`; ה-SW רק עונה ממנו. אין הודעות ביניהם (מלבד דגל הבדיקה).
3. **מפתח cache = path.** `mapKey` זהה ב-`public/sw.js` וב-`src/lib/offlineMap.ts`.
4. **30 יום, לא יותר.** כל רשומה נושאת `x-navi-cached-at`; ה-SW לא מגיש רשומה ישנה
   יותר — הוא מוחק אותה בדרך לרשת, ובלי רשת מחזיר 504. ניקוי גם 15 שניות אחרי
   כל עלייה של האפליקציה (`trimMapCache`), עם תקרה של 3,000 רשומות "פסיביות".
5. **בלי לגעת בחיוב.** `map-sessions`, `events.mapbox.com` וכל מה שאינו GET —
   ישר לרשת.
6. **Cache-first** לכל מה שיש (מהיר בשטח עם קליטה חלשה, חוסך בקשות); מה שאין —
   רשת, ובהצלחה נשמר, כך ש"מה שטסת מעליו בסיור" זמין אחר כך.

### קבצים

| קובץ | מה |
|---|---|
| `public/sw.js` (v3) | כלל Mapbox: מפתח לפי path, 30 יום, cache-first; `navi-map-*` שורד שדרוגים; דגל "דמה אובדן קליטה" שנשמר ב-cache `navi-flags` (משתנה ב-worker לא שורד restart); `/api/` GET עובר דרך `netFetch` רק כדי שהדימוי יחתוך גם אותו |
| `src/lib/tileCorridor.ts` | חישוב אריחי הפרוזדור: דגימה כל חצי אריח, רדיוס **שברי** (במרווח 1.5 ק"מ בזום 10 זה אריח אחד, לא בלוק של תשעה); z5–9 רק האריחים שמתחת לקו, z10–12 מרווח 3 ק"מ, z13–16 מרווח 1.5 ק"מ; תקרה 3,000 אריחים למקור, מעבר לזה יורד z16 ואז z15 |
| `src/lib/offlineMap.ts` | רישום תבניות ה-URL מהבקשות האמיתיות של המפה (`transformRequest`, API ציבורי); הורדה במקביליות 6 עם backoff ל-429/5xx ו-5 ניסיונות; דילוג על מה שכבר טרי; רשומת חבילה ב-IndexedDB (`mapPacks`, כולל `coords` כדי לפתוח מסלול מ-URL/Waymarked בלי רשת); מחיקה שלא נוגעת באריחים משותפים; `precacheShell` (ה-JS של המסך, כי בביקור הראשון ה-SW משתלט רק אחרי הטעינה); `trimMapCache`; `storage.estimate/persist` |
| `src/lib/offlineAudio.ts` | DB v3 עם upgrade לפי `oldVersion` — הקריינות שורדת את השדרוג |
| `src/hooks/useOfflineTrail.ts` | הורדה אחת לשתי המחציות: קריינות ואז מפה, כל אחת מדווחת כשל משלה; `phase`, `mapPack`, `mapProgress`, `estimate`, `mapDaysLeft`, `mapExpired`, `cancel` |
| `src/hooks/useOnline.ts` | `navigator.onLine` + הדגל של הדימוי |
| `src/components/GuidePointsPanel.tsx` | הסעיף מוצג לכל מסלול (גם בלי נקודות): כפתור עם הערכת נפח, התקדמות לפי שלב, שורת תוקף ("בתוקף עד 22.10 · עוד 27 ימים"), אזהרה מתחת ל-5 ימים ו"פג תוקף", `confirm` מעל 100 MB, רמז למסך הבית ב-iOS, כפתור עצירה |
| `src/components/TrailDiscovery.tsx` | "שמורים לשטח" בראש הרשימה, תמיד; בלי קליטה זה כל מה שיש |
| `src/components/Controls.tsx` | בלי קליטה, הסגנונות שלא בחבילה מעומעמים ("לא שמור") |
| `src/components/SettingsPanel.tsx` | "בדיקת מצב שטח": מתג שמדמה אובדן קליטה ומראה כמה אחסון האפליקציה תופסת |
| `src/components/Map.tsx` | `transformRequest: recordMapboxRequest`; כתובת ה-RTL plugin מיובאת ממקום אחד |
| `src/app/page.tsx` | `styleKey` (נקבע ב-`style.load`), נעילת סגנון, מעבר אוטומטי לסגנון החבילה בלי קליטה, רשימת החבילות, `wakeLock` במצב שטח, `trimMapCache` בעלייה |
| `src/app/layout.tsx` | הוסרו שני `<link>` ל-CSS מ-api.mapbox.com: אחד כפול (ה-CSS מיובא ב-`Map.tsx`) ואחד שלא קיים (החזיר JSON 404 ושגיאת MIME בכל טעינה). ב-offline הם היו חוסמים |
| `.claude/launch.json` | תצורת `prod` (`next start`) — ראו "אימות" |

### מה נבדק

- **Spike:** GL JS 3.22 מצייר כשכל מה שהוא מקבל מגיע מה-SW, ו-`map-sessions` ו-`events`
  נכשלים. אומת על build ייצור.
- **הורדה מלאה** ומצב שטח בלי רשת: המסלול נפתח מהרשימה "שמורים לשטח", לוויין חד
  ב-z16, תוויות בעברית ובאנגלית, קו המסלול, נקודות, פרופיל, צל, ותלת-ממד חלק
  (ראו סעיף 2 על הטריין). הסגנונות האחרים נעולים.
- **ב-dev (`next dev`) האפליקציה לא עוברת hydration בלי רשת** — עניין של Turbopack
  בפיתוח, לא של ה-build. בדיקות offline עושים על `prod`.

---

## 6. אימות — איך בודקים

1. `npm run build`, ואז `preview_start prod` (או `npx next start -p 3000`).
2. לפתוח מסלול → "נקודות" → "הורד מסלול לשטח". לחכות ל-"בתוקף עד…".
3. הגדרות → "בדיקת מצב שטח" → "דמה אובדן קליטה" → לרענן את הדף.
4. המסך הראשי מציג "שמורים לשטח · אין קליטה". לפתוח משם: מפה, קו, נקודות, תלת-ממד.
5. לחזור: אותו מתג.
6. **בטלפון (Pixel):** להוריד מסלול ב-Chrome → מצב טיסה → לפתוח שוב (רצוי מהאייקון
   במסך הבית). ה-GPS זז על המפה.

---

## 7. סיכונים ומה נעשה איתם

| סיכון | טיפול |
|---|---|
| §1.9 "systematic download" | מייל ל-Mapbox (סעיף 8); חבילה = מסלול אחד; 30 יום נאכפים בקוד |
| הטריין ב-offline הוא Terrain-RGB ולא Terrain-DEM v1 | גבהים שונים בכמה מטרים, צורת השטח זהה. הוסבר בקוד |
| הרשת נקטעת באמצע | 5 ניסיונות עם backoff; מה שהצליח נשמר; "רענן הורדה" משלים רק את החסר |
| Safari מוחק אחסון (7 ימים) — רלוונטי רק לאייפון | הודעה להוסיף למסך הבית, מוצגת רק ב-iOS |
| מסלול ארוך → מאות MB | תקרה 3,000 אריחים למקור עם הורדת z16→z15; `confirm` מעל 100 MB; ההערכה על הכפתור |
| ה-cache הפסיבי תופח | LRU לפי `x-navi-cached-at`, תקרה 3,000 רשומות שאינן בחבילה |
| deploy בין ההורדה לטיול | shell network-first; `precacheShell` בזמן ההורדה |
| RTL plugin ב-worker לא נתפס ע"י ה-SW בספארי | תוויות עברית ייראו הפוכות. בכרום (אנדרואיד) עובד — נבדק |

---

## 8. נוסח מייל ל-Mapbox

לשלוח ל-support דרך החשבון. באנגלית:

> Subject: Confirming on-device caching for a web app (Product Terms §2.8.1)
>
> Hi — we run a small non-commercial hiking web app on Mapbox GL JS v3 (satellite-streets-v12,
> outdoors-v12, terrain). Hikers lose reception on the trail, so we would like the map along a
> trail to keep working without a connection.
>
> What we do: when the user taps "download this trail", the browser itself fetches the tiles
> along that trail's corridor (typically 500–2,000 requests: raster, vector, terrain-rgb, style,
> glyphs) directly from api.mapbox.com with our access token, and stores them in the browser's
> Cache Storage on that device. Every entry is stamped and nothing older than 30 days is ever
> served; expired entries are deleted. Nothing is proxied, shared between devices or exported.
> The SDK's billing endpoints (map-sessions, events) are never cached or answered locally.
>
> We read §2.8.1 of the Product Terms as permitting exactly this (on-device cache, ≤30 days,
> populated directly from the Mapping APIs by the same device). Could you confirm that a
> per-trail download of this size, triggered by the user, is fine under §1.9 as well?
>
> Thanks!

---

## 9. שלב 2 (אם יידרש): MapLibre + PMTiles

אם Mapbox יסרבו, או אם תוקף קבוע יהיה חשוב: מסך שטח נפרד על MapLibre GL JS
(נטען רק במצב שטח), עם קובץ PMTiles של ישראל (Protomaps, `pmtiles extract --bbox`,
מאוחסן ב-R2) או אריחי Israel Hiking Map (בתיאום), וטריין מ-AWS Terrain Tiles.
`tileCorridor.ts`, רשומות החבילה, ה-UI וה-precache של ה-shell משרתים גם את זה —
מה שמשתנה הוא רק המנוע ומקור האריחים של מסך השטח.

---

## 10. פתוח

- לשלוח את המייל ל-Mapbox.
- לבדוק על הפיקסל בשטח (GPS, wake lock, קליטה חלקית).
- ~~ייצור הקריינות נכשל בבדיקה מסיבה לא קשורה: Gemini הודיע ש-`gemini-2.5-flash`
  לא זמין יותר.~~ עודכן ל-`gemini-3.6-flash` ו-`gemini-3.1-flash-tts-preview` (22.9.2026).
