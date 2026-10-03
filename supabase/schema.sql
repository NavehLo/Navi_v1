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

-- סיכום לפי אזור, סוג, מודל ומשתמש מאז p_since (null = הכול). עמוד המנהל
-- מקבץ מזה את הסיכומים לפי שימוש, לפי מודל ולפי משתמש.
create or replace function public.ai_usage_summary(p_since timestamptz)
returns table(
  area text, kind text, provider text, model text,
  user_id uuid, user_email text,
  calls bigint, input_tokens bigint, output_tokens bigint,
  chars bigint, searches bigint, cost_usd numeric, last_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select area, kind, provider, model, user_id, user_email,
         count(*), sum(input_tokens), sum(output_tokens),
         sum(chars), sum(searches), sum(cost_usd), max(created_at)
  from public.ai_usage
  where p_since is null or created_at >= p_since
  group by area, kind, provider, model, user_id, user_email;
$$;

revoke execute on function public.ai_usage_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.ai_usage_summary(timestamptz) to service_role;

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

-- PostgREST מכיר פונקציה חדשה רק אחרי רענון של מטמון הסכמה.
notify pgrst, 'reload schema';
