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
