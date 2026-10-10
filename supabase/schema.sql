-- ─────────────────────────────────────────────────────────────────────────────
-- סכמת בסיס הנתונים של Navi_v1
-- הרץ קובץ זה ב-Supabase Dashboard → SQL Editor → New query → Run
--
-- אפשר להריץ את הקובץ **כולו** שוב ושוב בבטחה. כל פקודה כאן היא idempotent:
-- הטבלאות נוצרות עם if not exists, ה-policies נמחקות ונוצרות מחדש, והפונקציה
-- היא create or replace. אין צורך לבחור חלקים מהקובץ ואין סכנה לנתונים קיימים.
-- (ל-create policy אין תחביר "if not exists" ב-Postgres, ולכן כל אחת מהן
-- מקבלת drop policy if exists לפניה — בלי זה הרצה שנייה נכשלת ב-42710.)
-- ─────────────────────────────────────────────────────────────────────────────

-- מסלולים שמורים
create table if not exists public.saved_trails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  source_url text,          -- כשהמסלול נטען מהמאגר (קליל — רק קישור)
  source_content text,      -- כשהמסלול הועלה כקובץ GPX/KML (הקובץ עצמו)
  total_distance real,
  created_at timestamptz not null default now()
);

-- היסטוריית סיורים
create table if not exists public.tour_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trail_name text not null,
  distance_km real,
  completed_pct int,
  mode text not null default 'virtual',  -- virtual | field
  created_at timestamptz not null default now()
);

-- הערות ודירוג למסלולים (רשומה אחת לכל משתמש+מסלול)
create table if not exists public.trail_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trail_name text not null,
  rating int check (rating between 1 and 5),
  note text,
  updated_at timestamptz not null default now(),
  unique (user_id, trail_name)
);

-- ── Row Level Security: כל משתמש רואה ועורך רק את הנתונים שלו ────────────────
alter table public.saved_trails enable row level security;
alter table public.tour_history enable row level security;
alter table public.trail_notes enable row level security;

drop policy if exists "own rows" on public.saved_trails;
create policy "own rows" on public.saved_trails
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.tour_history;
create policy "own rows" on public.tour_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.trail_notes;
create policy "own rows" on public.trail_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── הרשאות ברמת הטבלה ────────────────────────────────────────────────────────
-- RLS מסנן שורות, אבל לפני שהוא בכלל מופעל PostgREST צריך הרשאת גישה לטבלה
-- ברמת Postgres עבור ה-role של הבקשה (authenticated למשתמש מחובר). בפרויקטים
-- שנוצרו דרך ה-Dashboard זה בדרך כלל מגיע מ-default privileges — אבל לא כאן:
-- כל בקשה של משתמש מחובר ל-saved_trails נפלה ב-42501 "permission denied for
-- table", ש-PostgREST מחזיר כ-401, ובאפליקציה זה נראה כמו "החיבור פג תוקף".
-- ה-grant מפורש, ולכן לא תלוי בברירות מחדל; ה-RLS למעלה עדיין מבטיח שכל
-- משתמש רואה ועורך רק את השורות שלו.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.saved_trails to authenticated;
grant select, insert, update, delete on public.tour_history to authenticated;
grant select, insert, update, delete on public.trail_notes to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- מכסה יומית אמיתית לשימוש במדריך הקולי, לפי משתמש מחובר.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.guide_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);

alter table public.guide_usage enable row level security;

-- המשתמש יכול לראות את המכסה שלו, אבל רק הפונקציה (SECURITY DEFINER) למטה
-- יכולה לעדכן — כך לא ניתן "לאפס" את המכסה בכתיבה ישירה לטבלה.
drop policy if exists "read own usage" on public.guide_usage;
create policy "read own usage" on public.guide_usage
  for select using (auth.uid() = user_id);

-- בלי ה-grant הזה, PostgREST דוחה כל קריאת anon בשגיאת הרשאות (42501, שקוף
-- כ-401) עוד לפני שה-RLS למעלה בכלל מופעל. ה-RLS ממילא חוסם את השורות
-- (auth.uid() הוא NULL עבור anon, לעולם לא שווה ל-user_id) — ה-grant רק
-- מאפשר ל-PostgREST להריץ את השאילתה ולקבל מערך ריק, 200, במקום להיכשל
-- על הרשאות לפני שהיא בכלל מגיעה ל-RLS. זה גם מה ש-/api/keepalive
-- (pingSupabase ב-src/lib/supabaseServer.ts) מסתמך עליו: הוא צריך שהבקשה
-- האנונימית באמת תגיע ל-Postgres, לא תיפסל בשער לפני כן.
grant select on public.guide_usage to anon, authenticated;

-- מגדיל את המונה היומי של המשתמש המחובר (auth.uid()) ומחזיר האם הוא עדיין
-- מתחת למכסה. p_daily_limit מגיע מהשרת (Next.js), לא מהלקוח.
create or replace function public.increment_guide_usage(p_daily_limit int)
returns table(allowed boolean, current_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.guide_usage (user_id, usage_date, count)
  values (v_uid, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date)
  do update set count = guide_usage.count + 1
  returning guide_usage.count into v_count;

  return query select (v_count <= p_daily_limit), v_count;
end;
$$;

grant execute on function public.increment_guide_usage(int) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- cache קבוע לקריינות המדריכה.
--
-- הטבלאות האלה גלובליות ולא שייכות למשתמש: הקריינות על מעיין מסוים היא אותה
-- קריינות לכל מי שעומד לידו. לכן אין כאן RLS למשתמשים — הכתיבה נעשית רק
-- מהשרת, עם SUPABASE_SERVICE_ROLE_KEY, ורק דרך src/lib/narrationCache.ts.
-- בלי המפתח הזה האפליקציה עובדת רגיל, פשוט משלמת שוב על כל השמעה.
-- ─────────────────────────────────────────────────────────────────────────────

-- טקסט הקריינות. poi_key מזהה את *הנקודה*, לא את המסלול, כדי שנקודה שמופיעה
-- בשני מסלולים תשולם פעם אחת. prompt_version מאפשר לפסול את כל ה-cache
-- בכוונה כשמשפרים את הפרומפט, בלי למחוק שורות ידנית.
create table if not exists public.poi_narration (
  poi_key text primary key,
  text text not null,
  prompt_version int not null,
  sources jsonb,            -- כותרות ויקיפדיה / תגיות OSM ששימשו לכתיבה
  created_at timestamptz not null default now()
);

-- האודיו שנוצר מהטקסט. מופרד ממנו כדי שהחלפת קול לא תחייב ייצור טקסט מחדש.
-- audio_key = sha1(text + ספק + מודל + voice_id + פורמט).
-- storage_path הוא הנתיב *בתוך* ה-bucket narrations (למשל "a1b2c3.mp3").
create table if not exists public.narration_audio (
  audio_key text primary key,
  poi_key text references public.poi_narration(poi_key) on delete cascade,
  storage_path text not null,
  format text not null,
  chars int not null,
  created_at timestamptz not null default now()
);

create index if not exists narration_audio_poi_key_idx
  on public.narration_audio (poi_key);

alter table public.poi_narration enable row level security;
alter table public.narration_audio enable row level security;
-- אין policy בכוונה: service_role עוקף RLS, ולקוחות לא ניגשים לטבלאות האלה
-- ישירות — הם מקבלים טקסט ו-URL מ-/api/tour-guide.
-- RLS לא מספיק: בפרויקט אין הרשאות ברירת מחדל, ובלי grant גם service_role נדחה (42501).
grant select, insert, update on public.poi_narration to service_role;
grant select, insert, update on public.narration_audio to service_role;

-- ── cache קבוע לנקודות שהתגלו במסלול ────────────────────────────────────────
-- הגילוי פונה ל-Overpass, שירות ציבורי חינמי שעונה תוך שנייה או נכשל בשגיאת
-- שער אחרי שמונה שניות, פחות או יותר באקראי. הגילוי המוצלח הראשון של מסלול
-- נשמר כאן, וכל מי שיפתח את אותו מסלול אחר כך — מכל מכשיר — יקבל את התשובה
-- בלי ש-Overpass מעורב בכלל. תלות הפכפכה הופכת לעלות חד-פעמית.
--
-- trail_key = sha1 של נקודות המסלול לאחר דילול (אותו חישוב שב-/api/pois).
-- discovery_version מאפשר לפסול את כל ה-cache כששינוי בסינון אמור לחול גם
-- על מסלולים שכבר התגלו.
create table if not exists public.trail_pois (
  trail_key text not null,
  discovery_version int not null,
  pois jsonb not null,
  discovered_at timestamptz not null default now(),
  primary key (trail_key, discovery_version)
);

alter table public.trail_pois enable row level security;
-- אין policy, מאותה סיבה: הכתיבה והקריאה נעשות רק מהשרת עם service_role,
-- והלקוח מקבל את הרשימה מ-/api/pois.
grant select, insert, update on public.trail_pois to service_role;

-- ── שמות באנגלית למסלולי עולם ──────────────────────────────────────────────
-- מסלולים מ-Waymarked Trails ששמם בכתב לא-לטיני (יוונית, קירילית, יפנית…)
-- מקבלים שם באנגלית לצד המקורי: מתגיות OSM (name:en / int_name) כשיש,
-- ואחרת תרגום של מודל שפה. כל שם נשמר כאן פעם אחת ומשמש את כולם — וגם
-- משמש אינדקס לחיפוש לפי השם האנגלי, ש-Waymarked Trails עצמו לא מחפש בו.
-- source: 'osm' גובר על 'ai' ולא נדרס על ידו.
create extension if not exists pg_trgm;

create table if not exists public.trail_name_en (
  relation_id bigint primary key,
  name text not null,
  name_en text not null,
  source text not null check (source in ('osm', 'ai')),
  created_at timestamptz not null default now()
);

create index if not exists trail_name_en_trgm
  on public.trail_name_en using gin (name_en gin_trgm_ops);

alter table public.trail_name_en enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.trail_name_en to service_role;

-- ── המדינה של כל מסלול עולם ────────────────────────────────────────────────
-- תוצאות החיפוש של Waymarked Trails מגיעות בלי מיקום. השרת מושך קו מפושט של
-- המסלול, ממקם נקודות לאורכו במדינות (country-coder, בלי רשת) ושומר כאן את
-- התוצאה — פעם אחת לכל מסלול. countries = קודי ISO, המדינה העיקרית ראשונה.
create table if not exists public.trail_country (
  relation_id bigint primary key,
  countries text[] not null,
  created_at timestamptz not null default now()
);

alter table public.trail_country enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.trail_country to service_role;

-- ── "על המסלול": תיאור מילולי של מסלול ─────────────────────────────────────
-- תיאור בעברית שנכתב ממקורות (אתר רשמי, נאקב, ויקיפדיה, חיפוש ברשת) על ידי
-- מודל שפה. נכתב פעם אחת לכל מסלול ומשמש את כולם; מתחדש אחרי 90 יום.
-- trail_key = 'wmt:<relation id>' או 'nakeb:<מזהה נאקב>'.
-- info_version מאפשר לפסול את כל התיאורים כשההנחיות למודל משתנות.
create table if not exists public.trail_info (
  trail_key text not null,
  info_version int not null,
  info jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trail_key, info_version)
);

alter table public.trail_info enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.trail_info to service_role;

-- bucket ציבורי לקריאה. קבצי ה-mp3 מוגשים ישירות ממנו, כך שה-Service Worker
-- והדפדפן יכולים לשמור אותם, ואפשר להוריד מסלול שלם לשימוש בלי קליטה.
insert into storage.buckets (id, name, public)
values ('narrations', 'narrations', true)
on conflict (id) do update set public = true;

-- ── מכסה לפי תווים ──────────────────────────────────────────────────────────
-- פגיעה ב-cache לא עולה כלום ולכן לא צורכת מכסה. מה שנספר הוא התווים
-- שסונתזו בפועל — כך המכסה משקפת הוצאה אמיתית ולא מספר לחיצות.
alter table public.guide_usage add column if not exists chars int not null default 0;

-- החתימה משתנה (נוסף p_chars), ולכן צריך למחוק את הגרסה הישנה כדי לא ליצור
-- עומס יתר (overload) עם שני פרמטרים אפשריים.
drop function if exists public.increment_guide_usage(int);

-- מוסיפה p_chars לצריכה של היום ומחזירה האם המשתמש היה *מתחת* למכסה לפני
-- ההוספה. קריאה עם p_chars = 0 היא בדיקה בלבד ולא משנה כלום — כך אפשר לבדוק
-- לפני שמייצרים, ולרשום את העלות האמיתית רק אחרי שהיא ידועה.
create or replace function public.increment_guide_usage(p_daily_limit int, p_chars int)
returns table(allowed boolean, current_count int, current_chars int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_chars int;
  v_prev_chars int;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.guide_usage (user_id, usage_date, count, chars)
  values (v_uid, (now() at time zone 'utc')::date, 0, 0)
  on conflict (user_id, usage_date) do nothing;

  select guide_usage.chars into v_prev_chars
  from public.guide_usage
  where guide_usage.user_id = v_uid
    and guide_usage.usage_date = (now() at time zone 'utc')::date;

  if p_chars > 0 then
    update public.guide_usage
    set count = guide_usage.count + 1,
        chars = guide_usage.chars + p_chars
    where guide_usage.user_id = v_uid
      and guide_usage.usage_date = (now() at time zone 'utc')::date
    returning guide_usage.count, guide_usage.chars into v_count, v_chars;
  else
    select guide_usage.count, guide_usage.chars into v_count, v_chars
    from public.guide_usage
    where guide_usage.user_id = v_uid
      and guide_usage.usage_date = (now() at time zone 'utc')::date;
  end if;

  return query select (v_prev_chars < p_daily_limit), v_count, v_chars;
end;
$$;

grant execute on function public.increment_guide_usage(int, int) to authenticated;

-- ── יומן שימוש ב-AI ─────────────────────────────────────────────────────────
-- שורה לכל קריאה בתשלום לשירות AI (כתיבת טקסט, הקראה, חיפוש ברשת), עבור
-- עמוד "שימוש ועלויות AI" של המנהל. נכתב רק מהשרת (src/lib/aiUsage.ts),
-- רק על קריאות שהצליחו. העלות היא הערכה לפי מחירון בזמן הקריאה
-- (src/lib/aiPricing.ts), ונשמרת עם השורה.
-- area = מאיפה באפליקציה (guide, guide_offline, trail_info…), kind = text | voice | search.
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  area text not null,
  kind text not null,
  provider text not null,
  model text not null,
  user_id uuid references auth.users (id) on delete set null,
  user_email text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  chars int not null default 0,
  searches int not null default 0,
  cost_usd numeric(12, 6) not null default 0
);

create index if not exists ai_usage_created_at_idx on public.ai_usage (created_at);

alter table public.ai_usage enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
-- service_role עוקף RLS, אבל לא את ההרשאות ברמת הטבלה — ובפרויקט הזה אין
-- הרשאות ברירת מחדל (ראו ההערה ליד ה-grant של saved_trails). בלי השורות
-- האלה כל כתיבה לטבלה נכשלת ב-42501, והשימוש פשוט לא נרשם.
grant select, insert on public.ai_usage to service_role;
grant usage, select on sequence public.ai_usage_id_seq to service_role;

-- הסיכום לעמוד המנהל (ai_usage_summary) מוגדר בסעיף "מגבלות שימוש ב-AI" למטה,
-- אחרי שנוספות העמודות client_hash ו-exempt.

-- ── מסלולי עולם לפי מדינה, עם 12 החודשים ───────────────────────────────────
-- "מסלולים בעולם לפי חודש": לכל מדינה רשימת המסלולים המסומנים שלה מ-Waymarked
-- Trails, ולכל מסלול דירוג של 12 החודשים לפי האקלים (src/lib/countryTrails.ts).
-- בניית מדינה לוקחת עשרות שניות, ולכן היא נשמרת כאן לכולם ל-30 יום, או עד
-- שכללי הדירוג משתנים (climate_version). good_by_month = כמה מסלולים בעונה
-- מומלצת בכל חודש, לרשימת המדינות בלי למשוך את כל הרשימה.
create table if not exists public.country_trails (
  country text primary key,
  climate_version int not null,
  built_at timestamptz not null default now(),
  partial boolean not null default false,
  good_by_month int[] not null default '{}',
  trails jsonb not null
);

alter table public.country_trails enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.country_trails to service_role;

-- ── מה אומרים מטיילים: ציון וכמות מטיילים למסלולי עולם ─────────────────────
-- לכל מסלול עולם (relation ב-OSM) במדינה שהמנהל הריץ לה את האיסוף: כמה
-- קראו את ערכי הוויקיפדיה שלו ב-24 החודשים האחרונים, ומה הציון ומספר
-- הביקורות שלו באתרי ביקורות (AllTrails, Wikiloc וכו', ב-sources). רמת
-- התנועה ("הרבה", "מעט"…) לא נשמרת — היא מחושבת בקריאה מול שאר מסלולי
-- המדינה (src/lib/trailCrowd/score.ts). crowd_version עולה כשמשתנה האיסוף.
create table if not exists public.trail_crowd (
  trail_id bigint not null,
  country text not null,
  crowd_version int not null,
  fetched_at timestamptz not null default now(),
  pageviews int not null default 0,
  sources jsonb not null default '[]',
  rating numeric(3, 1),
  rating_count int not null default 0,
  primary key (trail_id, country)
);

create index if not exists trail_crowd_country_idx on public.trail_crowd (country);

alter table public.trail_crowd enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.trail_crowd to service_role;

-- ── קטעים פופולריים של שבילים ארוכים ────────────────────────────────────────
-- טיול יום מפורסם שהוא חלק משביל ארוך (מעבר ולבונה ב-Peaks of the Balkans,
-- Conic Hill ב-West Highland Way): הקטע של השביל שבין שתי נקודות, כפי שהוא
-- ב-OSM (src/lib/trailCrowd/sections.ts). נשמרים רק הקצוות, כמה נקודות לאורכו
-- והשם — הכל מ-OpenStreetMap, אף פעם לא הקו של Komoot. ה-id שלילי
-- (-(שביל × 100 + n)), והמספרים של הקטע ב-trail_crowd תחת אותו id.
create table if not exists public.trail_sections (
  id bigint primary key,
  country text not null,
  parent_id bigint not null,
  parent_name text,
  parent_group text,
  name text not null,
  start_lat double precision not null,
  start_lon double precision not null,
  end_lat double precision not null,
  end_lon double precision not null,
  km real not null,
  samples jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create index if not exists trail_sections_country_idx on public.trail_sections (country);
create index if not exists trail_sections_parent_idx on public.trail_sections (parent_id);

alter table public.trail_sections enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.trail_sections to service_role;

-- ── הקלטות מסלול ───────────────────────────────────────────────────────────
-- הליכה שהמשתמש הקליט בטלפון (src/lib/recording/). ההקלטה נשמרת קודם במכשיר;
-- כאן העותק בחשבון, כדי שתופיע בכל מכשיר ושאפשר יהיה לשתף אותה בקישור.
-- ה-id נוצר במכשיר, ולכן שליחה חוזרת (upsert) לא יוצרת כפילות.
-- פרטי: רק הבעלים קורא ועורך (own rows), ול-anon אין grant בכלל — כך שאי
-- אפשר לרשום את ההקלטות. הקלטה ששותפה (shared = true) נקראת לאחרים רק דרך
-- השרת, /api/walk, עם service_role, לפי ה-id בלבד.
create table if not exists public.recordings (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  stats jsonb not null,     -- מרחק, עלייה, ירידה, זמנים (src/lib/recording/stats.ts)
  gpx text not null,        -- הנקודות עצמן, עם גובה ושעה
  shared boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists recordings_user_idx on public.recordings (user_id, started_at desc);

alter table public.recordings enable row level security;
drop policy if exists "own rows" on public.recordings;
create policy "own rows" on public.recordings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.recordings to authenticated;
grant select on public.recordings to service_role;

-- ── שאלו את Navi ───────────────────────────────────────────────────────────
-- כל שאלה שנשאלה בצ׳אט העזרה (src/app/api/help-chat), עם התשובה והכפתורים
-- שהוצעו — בלי מי ששאל. המנהל רואה את הרשימה בהגדרות ← מתקדם, כדי לדעת מה
-- משתמשים מחפשים ולא מוצאים. screen: מה היה על המסך (מסלול פתוח, נסיעה וכו').
create table if not exists public.help_chat_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  question text not null,
  answer text,
  actions text[] not null default '{}',
  screen jsonb,
  status text not null
);

create index if not exists help_chat_log_created_at_idx on public.help_chat_log (created_at desc);

alter table public.help_chat_log enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב (ראו ai_usage).
grant select, insert, delete on public.help_chat_log to service_role;
grant usage, select on sequence public.help_chat_log_id_seq to service_role;

-- ── תמונות מהמסלול ─────────────────────────────────────────────────────────
-- התמונות שנבחרו לכל מסלול (src/lib/trailPhotos): קישורים, צלם ורישיון בלבד —
-- לא קבצי התמונות. נבחר פעם אחת לכל מסלול ומשמש את כולם; מתחדש אחרי 90 יום,
-- או אחרי שבוע כש-Gemini לא בדק את התמונות.
-- trail_key = 'pts:<sha1 של נקודות המסלול>'. photos_version (PHOTOS_VERSION
-- ב-cache.ts) מאפשר לבחור מחדש את כל התמונות כשכללי הבחירה משתנים.
create table if not exists public.trail_photos (
  trail_key text not null,
  photos_version int not null,
  photos jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trail_key, photos_version)
);

alter table public.trail_photos enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.trail_photos to service_role;

-- ── מגבלות שימוש ב-AI ───────────────────────────────────────────────────────
-- המגבלות (src/lib/aiLimits.ts) נבדקות לפני כל קריאה לשירות AI, מול מה שנרשם
-- ב-ai_usage מתחילת היום (שעון ישראל). מי ששילם על הקריאה: client_hash מזהה
-- אורח לפי IP מגובב (לא ה-IP עצמו), ו-exempt מסמן שימוש של המנהל ושל
-- הסקריפטים במחשב שלו — הוא נרשם ונראה במסך, אבל לא נספר במגבלות.
alter table public.ai_usage add column if not exists client_hash text;
alter table public.ai_usage add column if not exists exempt boolean not null default false;

-- ההגדרות שהמנהל קובע במסך "שימוש ועלויות AI". שורה אחת בלבד (id = 1).
create table if not exists public.ai_settings (
  id int primary key default 1 check (id = 1),
  limits jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ai_settings enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, update on public.ai_settings to service_role;

-- התראות שנשלחו במייל, כדי שכל התראה תישלח פעם אחת בלבד (key כולל את היום).
create table if not exists public.ai_alerts (
  key text primary key,
  subject text not null,
  created_at timestamptz not null default now()
);
alter table public.ai_alerts enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert on public.ai_alerts to service_role;

-- שימוש קודם של הסקריפטים של המנהל (אזורי טיול, איסוף מדדי מטיילים) נרשם
-- בלי משתמש, לפני שהיה exempt — הוא שלו, לא של אורחים.
update public.ai_usage set exempt = true
where not exempt and user_id is null and area in ('country_guide', 'trail_crowd');

-- סיכום לפי אזור, סוג, מודל, משתמש ופטור מאז p_since (null = הכול). עמוד
-- המנהל מקבץ מזה את הסיכומים לפי שימוש, לפי מודל ולפי משתמש. החתימה השתנתה
-- (נוסף exempt), ולכן הגרסה הקודמת נמחקת קודם.
drop function if exists public.ai_usage_summary(timestamptz);
create function public.ai_usage_summary(p_since timestamptz)
returns table(
  area text, kind text, provider text, model text,
  user_id uuid, user_email text, exempt boolean,
  calls bigint, input_tokens bigint, output_tokens bigint,
  chars bigint, searches bigint, cost_usd numeric, last_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select area, kind, provider, model, user_id, user_email, exempt,
         count(*), sum(input_tokens), sum(output_tokens),
         sum(chars), sum(searches), sum(cost_usd), max(created_at)
  from public.ai_usage
  where p_since is null or created_at >= p_since
  group by area, kind, provider, model, user_id, user_email, exempt;
$$;

revoke execute on function public.ai_usage_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.ai_usage_summary(timestamptz) to service_role;

-- השימוש מאז p_since: של אדם אחד (משתמש מחובר לפי p_user, אורח לפי
-- p_client) ושל כל האפליקציה, לפי ספק. בלי השורות הפטורות.
create or replace function public.ai_usage_today(p_since timestamptz, p_user uuid, p_client text)
returns table(scope text, provider text, calls bigint, chars bigint, searches bigint, cost_usd numeric)
language sql
stable
security definer
set search_path = public
as $$
  select 'person', provider, count(*), sum(chars), sum(searches), sum(cost_usd)
  from public.ai_usage
  where created_at >= p_since and not exempt
    and ((p_user is not null and user_id = p_user)
      or (p_user is null and p_client is not null and client_hash = p_client))
  group by provider
  union all
  select 'app', provider, count(*), sum(chars), sum(searches), sum(cost_usd)
  from public.ai_usage
  where created_at >= p_since and not exempt
  group by provider;
$$;

revoke execute on function public.ai_usage_today(timestamptz, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_usage_today(timestamptz, uuid, text) to service_role;

-- ── דו״ח משתמשים ("משתמשים ושימוש" בהגדרות של המנהל) ──────────────────────
-- app_events: פעולה אחת באפליקציה (פתיחת מסלול, סיור וירטואלי, הקלטה…), נכתב
-- רק מהשרת (src/app/api/events). מי: user_id למחוברים; device_id — מזהה אקראי
-- שהמכשיר יצר לעצמו (לא מזהה חומרה); client_hash — IP מגובב, לא ה-IP עצמו.
-- שימוש של המנהל לא נשמר בכלל.
create table if not exists public.app_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event text not null,
  user_id uuid references auth.users (id) on delete set null,
  user_email text,
  device_id text,
  client_hash text,
  native boolean not null default false,
  props jsonb
);
create index if not exists app_events_created_at_idx on public.app_events (created_at);
alter table public.app_events enable row level security;
-- אין policy: רק השרת עם service_role קורא וכותב.
grant select, insert, delete on public.app_events to service_role;
grant usage, select on sequence public.app_events_id_seq to service_role;

-- המכשיר של כל קריאת AI, כדי לחבר אותה לאורח ולהחריג את מכשירי המנהל.
alter table public.ai_usage add column if not exists device_id text;

-- המכשירים וכתובות ה-IP של המנהל: כל שימוש מהם לא נספר בדו״ח ופטור מהמגבלות.
-- מכשיר נוסף כאן מעצמו כשהמנהל מחובר בו, או בכפתור "המכשיר הזה שלי".
create table if not exists public.owner_devices (
  device_id text primary key,
  label text,
  created_at timestamptz not null default now()
);
alter table public.owner_devices enable row level security;
grant select, insert, update, delete on public.owner_devices to service_role;

create table if not exists public.owner_ips (
  ip text primary key,
  label text,
  created_at timestamptz not null default now()
);
alter table public.owner_ips enable row level security;
grant select, insert, update, delete on public.owner_ips to service_role;

-- הפעולות מאז p_since, מקובצות לפי אדם, פעולה ויום (שעון ישראל) — כדי
-- שהדו״ח יספור בכמה ימים שונים כל אחד השתמש.
create or replace function public.app_events_summary(p_since timestamptz)
returns table(
  user_id uuid, user_email text, device_id text, client_hash text, native boolean,
  event text, day date, events bigint, first_at timestamptz, last_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select user_id, user_email, device_id, client_hash, native, event,
         (created_at at time zone 'Asia/Jerusalem')::date,
         count(*), min(created_at), max(created_at)
  from public.app_events
  where p_since is null or created_at >= p_since
  group by 1, 2, 3, 4, 5, 6, 7;
$$;
revoke execute on function public.app_events_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.app_events_summary(timestamptz) to service_role;

-- קריאות ה-AI מאז p_since, לפי אדם, שירות ויום.
create or replace function public.ai_usage_by_person(p_since timestamptz)
returns table(
  user_id uuid, user_email text, device_id text, client_hash text, exempt boolean,
  provider text, day date, calls bigint, chars bigint, searches bigint, cost_usd numeric,
  first_at timestamptz, last_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select user_id, user_email, device_id, client_hash, exempt, provider,
         (created_at at time zone 'Asia/Jerusalem')::date,
         count(*), sum(chars), sum(searches), sum(cost_usd), min(created_at), max(created_at)
  from public.ai_usage
  where p_since is null or created_at >= p_since
  group by 1, 2, 3, 4, 5, 6, 7;
$$;
revoke execute on function public.ai_usage_by_person(timestamptz) from public, anon, authenticated;
grant execute on function public.ai_usage_by_person(timestamptz) to service_role;

-- PostgREST מכיר פונקציה חדשה רק אחרי רענון של מטמון הסכמה.
notify pgrst, 'reload schema';
