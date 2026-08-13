import { supabase } from './supabase';

export interface SavedTrail {
  id: string;
  name: string;
  source_url: string | null;
  source_content: string | null;
  total_distance: number | null;
  created_at: string;
}

export interface TourHistoryEntry {
  id: string;
  trail_name: string;
  distance_km: number | null;
  completed_pct: number | null;
  mode: string;
  created_at: string;
}

export interface TrailNote {
  trail_name: string;
  rating: number | null;
  note: string | null;
}

function client() {
  if (!supabase) throw new PersonalAreaError('unavailable', 'Supabase is not configured');
  return supabase;
}

// ── סיווג שגיאות ─────────────────────────────────────────────────────────────
// "לא זמין" ו"הסכמה לא הורצה" הן תקלות שונות לגמרי מבחינת המשתמש, ופרויקט
// מושהה ב-Supabase מייצר את הראשונה. PostgREST מדווח על כשל תקשורת עם
// status 0, על פרויקט מושהה/שירות למטה עם 5xx, ועל טבלה חסרה עם 42P01/PGRST205.
export type SupabaseFailureKind = 'unavailable' | 'schema-missing' | 'auth' | 'unknown';

export class PersonalAreaError extends Error {
  readonly kind: SupabaseFailureKind;
  constructor(kind: SupabaseFailureKind, message: string) {
    super(message);
    this.name = 'PersonalAreaError';
    this.kind = kind;
  }
}

interface PostgrestFailure {
  message?: string;
  code?: string | null;
}

function toError(error: PostgrestFailure | null, status: number): PersonalAreaError {
  const code = error?.code || '';
  const message = error?.message || `Supabase request failed (HTTP ${status})`;
  if (status === 0 || status >= 500) return new PersonalAreaError('unavailable', message);
  if (code === '42P01' || code === 'PGRST205') return new PersonalAreaError('schema-missing', message);
  if (code === 'PGRST301' || status === 401 || status === 403) return new PersonalAreaError('auth', message);
  return new PersonalAreaError('unknown', message);
}

// Every query goes through here so the thrown error always carries a kind.
async function run<T>(
  query: PromiseLike<{ data: T | null; error: PostgrestFailure | null; status: number }>
): Promise<T | null> {
  const { data, error, status } = await query;
  if (error) throw toError(error, status);
  return data;
}

export function isServiceUnavailable(e: unknown): boolean {
  return e instanceof PersonalAreaError && e.kind === 'unavailable';
}

export function describeSupabaseError(e: unknown): string {
  const kind = e instanceof PersonalAreaError ? e.kind : 'unknown';
  switch (kind) {
    case 'unavailable':
      return 'השירות אינו זמין כרגע — ייתכן שבסיס הנתונים מושהה. נסה שוב מאוחר יותר.';
    case 'schema-missing':
      return 'טבלאות האזור האישי חסרות. הרץ את supabase/schema.sql ב-Supabase.';
    case 'auth':
      return 'החיבור פג תוקף. התנתק והתחבר מחדש.';
    default:
      return 'שגיאה בטעינת הנתונים. נסה שוב בעוד רגע.';
  }
}

// ── מסלולים שמורים ────────────────────────────────────────────────────────────
export async function saveTrail(input: {
  name: string;
  sourceUrl?: string | null;
  sourceContent?: string | null;
  totalDistance?: number | null;
}): Promise<void> {
  await run(
    client().from('saved_trails').insert({
      name: input.name,
      source_url: input.sourceUrl ?? null,
      source_content: input.sourceContent ?? null,
      total_distance: input.totalDistance ?? null,
    })
  );
}

export async function listSavedTrails(): Promise<SavedTrail[]> {
  const data = await run<SavedTrail[]>(
    client()
      .from('saved_trails')
      .select('id, name, source_url, source_content, total_distance, created_at')
      .order('created_at', { ascending: false })
  );
  return data ?? [];
}

export async function deleteSavedTrail(id: string): Promise<void> {
  await run(client().from('saved_trails').delete().eq('id', id));
}

// ── היסטוריית סיורים ──────────────────────────────────────────────────────────
export async function recordTour(input: {
  trailName: string;
  distanceKm: number;
  completedPct: number;
  mode?: 'virtual' | 'field';
}): Promise<void> {
  await run(
    client().from('tour_history').insert({
      trail_name: input.trailName,
      distance_km: input.distanceKm,
      completed_pct: Math.round(input.completedPct),
      mode: input.mode ?? 'virtual',
    })
  );
}

export async function listTourHistory(): Promise<TourHistoryEntry[]> {
  const data = await run<TourHistoryEntry[]>(
    client()
      .from('tour_history')
      .select('id, trail_name, distance_km, completed_pct, mode, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
  );
  return data ?? [];
}

// ── הערות ודירוג ─────────────────────────────────────────────────────────────
export async function getTrailNote(trailName: string): Promise<TrailNote | null> {
  return run<TrailNote>(
    client()
      .from('trail_notes')
      .select('trail_name, rating, note')
      .eq('trail_name', trailName)
      .maybeSingle()
  );
}

export async function listTrailNotes(): Promise<TrailNote[]> {
  const data = await run<TrailNote[]>(
    client().from('trail_notes').select('trail_name, rating, note')
  );
  return data ?? [];
}

export async function upsertTrailNote(input: {
  trailName: string;
  rating: number | null;
  note: string | null;
}): Promise<void> {
  // getSession reads the locally stored session — no round-trip, so a Supabase
  // outage surfaces as a real service error below instead of a bogus "not signed in".
  const { data: sessionData } = await client().auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) throw new PersonalAreaError('auth', 'Not signed in');
  await run(
    client().from('trail_notes').upsert(
      {
        user_id: userId,
        trail_name: input.trailName,
        rating: input.rating,
        note: input.note,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,trail_name' }
    )
  );
}

// ── מטמון מקומי לקריאה בלבד ───────────────────────────────────────────────────
// תמונת מצב של האזור האישי נשמרת ב-localStorage אחרי כל טעינה מוצלחת, כדי
// שהמסלולים השמורים יישארו נגישים (וניתנים לטעינה) גם כשה-Supabase לא זמין.
// קריאה בלבד — שמירות אמיתיות תמיד הולכות לשרת.
const CACHE_KEY = 'navi.personalArea.v1';
const MAX_CACHE_BYTES = 2_000_000; // מתחת למגבלת ה-localStorage הטיפוסית (~5MB)

export interface PersonalSnapshot {
  trails: SavedTrail[];
  history: TourHistoryEntry[];
  notes: TrailNote[];
}

interface CacheEntry extends PersonalSnapshot {
  userId: string;
  cachedAt: string;
}

export function cachePersonalData(userId: string, snapshot: PersonalSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: CacheEntry = { userId, cachedAt: new Date().toISOString(), ...snapshot };
    const json = JSON.stringify(entry);
    // מסלול שהועלה כקובץ GPX נשמר במלואו ב-source_content, ולכן התמונה עלולה
    // לתפוח. עדיף לוותר על המטמון מאשר להיתקל ב-QuotaExceededError.
    if (json.length > MAX_CACHE_BYTES) return;
    window.localStorage.setItem(CACHE_KEY, json);
  } catch {
    // מצב פרטי / מכסה מלאה — המטמון הוא נחמד-שיהיה, לא קריטי
  }
}

export function readCachedPersonalData(userId: string): (PersonalSnapshot & { cachedAt: string }) | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.userId !== userId || !Array.isArray(entry.trails)) return null;
    return {
      trails: entry.trails,
      history: entry.history ?? [],
      notes: entry.notes ?? [],
      cachedAt: entry.cachedAt,
    };
  } catch {
    return null;
  }
}

export function clearPersonalCache(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
