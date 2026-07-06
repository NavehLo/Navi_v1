-- ─────────────────────────────────────────────────────────────────────────────
-- סכמת בסיס הנתונים של Navi_v1 — אזור אישי
-- הרץ קובץ זה פעם אחת ב-Supabase Dashboard → SQL Editor → New query → Run
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

create policy "own rows" on public.saved_trails
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.tour_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.trail_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- הוספה: מכסה יומית אמיתית לשימוש במדריך הקולי, לפי משתמש מחובר.
-- אם כבר הרצת את הקובץ פעם קודמת — הרץ רק מהשורה הזו והלאה (create policy
-- לא תומך ב-"if not exists" ותיכשל אם תריץ את כל הקובץ שוב מההתחלה).
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
