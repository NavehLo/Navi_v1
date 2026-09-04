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
