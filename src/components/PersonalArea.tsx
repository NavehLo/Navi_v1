import { useState, useEffect, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import { X, MapPin, History, Star, Trash2, Loader2, LogOut, Route, WifiOff, RefreshCw } from "lucide-react";
import {
  SavedTrail,
  TourHistoryEntry,
  TrailNote,
  listSavedTrails,
  deleteSavedTrail,
  listTourHistory,
  listTrailNotes,
  upsertTrailNote,
  cachePersonalData,
  readCachedPersonalData,
  describeSupabaseError,
} from "../lib/personalArea";

interface PersonalAreaProps {
  user: User;
  onClose: () => void;
  onSignOut: () => void;
  onLoadSavedTrail: (t: SavedTrail) => void;
}

type Tab = "trails" | "history";

export default function PersonalArea({ user, onClose, onSignOut, onLoadSavedTrail }: PersonalAreaProps) {
  const [tab, setTab] = useState<Tab>("trails");
  const [trails, setTrails] = useState<SavedTrail[] | null>(null);
  const [history, setHistory] = useState<TourHistoryEntry[] | null>(null);
  const [notes, setNotes] = useState<Map<string, TrailNote>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null); // מוצג כשהנתונים מגיעים מהמטמון
  const [refreshing, setRefreshing] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [ratingDraft, setRatingDraft] = useState<number | null>(null);

  const readOnly = cachedAt !== null; // אין חיבור — אפשר לצפות ולטעון, לא לערוך

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const [t, h, n] = await Promise.all([listSavedTrails(), listTourHistory(), listTrailNotes()]);
      setTrails(t);
      setHistory(h);
      setNotes(new Map(n.map((x) => [x.trail_name, x])));
      setCachedAt(null);
      cachePersonalData(user.id, { trails: t, history: h, notes: n });
    } catch (e) {
      console.error("Personal area load failed:", e);
      setError(describeSupabaseError(e));
      // נפילה חזרה לתמונת המצב האחרונה, כדי שהמסלולים השמורים יישארו זמינים
      const cached = readCachedPersonalData(user.id);
      setTrails(cached?.trails ?? []);
      setHistory(cached?.history ?? []);
      setNotes(new Map((cached?.notes ?? []).map((x) => [x.trail_name, x])));
      setCachedAt(cached?.cachedAt ?? null);
    } finally {
      setRefreshing(false);
    }
  }, [user.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (id: string) => {
    if (!window.confirm("למחוק את המסלול השמור?")) return;
    try {
      await deleteSavedTrail(id);
      const next = (trails ?? []).filter((t) => t.id !== id);
      setTrails(next);
      cachePersonalData(user.id, { trails: next, history: history ?? [], notes: [...notes.values()] });
    } catch (e) {
      console.error(e);
      setError(describeSupabaseError(e));
    }
  };

  const openNoteEditor = (trailName: string) => {
    const existing = notes.get(trailName);
    setNoteDraft(existing?.note ?? "");
    setRatingDraft(existing?.rating ?? null);
    setEditingNote(trailName);
  };

  const saveNote = async () => {
    if (!editingNote) return;
    try {
      await upsertTrailNote({ trailName: editingNote, rating: ratingDraft, note: noteDraft || null });
      const next = new Map(notes);
      next.set(editingNote, { trail_name: editingNote, rating: ratingDraft, note: noteDraft || null });
      setNotes(next);
      cachePersonalData(user.id, { trails: trails ?? [], history: history ?? [], notes: [...next.values()] });
      setEditingNote(null);
    } catch (e) {
      console.error(e);
      setError(describeSupabaseError(e));
      setEditingNote(null);
    }
  };

  const Stars = ({ trailName, size = 14 }: { trailName: string; size?: number }) => {
    const rating = notes.get(trailName)?.rating ?? 0;
    return (
      <span className="flex gap-0.5" dir="ltr">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            size={size}
            className={i <= rating ? "text-amber-400 fill-amber-400" : "text-zinc-700"}
          />
        ))}
      </span>
    );
  };

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-3xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center p-5 pb-3 border-b border-white/5">
          <div className="flex items-center gap-3">
            {user.user_metadata?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.user_metadata.avatar_url} alt="" className="w-9 h-9 rounded-full border border-white/20" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-orange-500/30 flex items-center justify-center text-orange-300 font-bold">
                {(user.user_metadata?.full_name || user.email || "?")[0]}
              </div>
            )}
            <div>
              <h2 className="text-white font-extrabold text-base leading-tight">
                {user.user_metadata?.full_name || "האזור האישי"}
              </h2>
              <span className="text-zinc-500 text-xs">{user.email}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onSignOut} title="התנתק" className="text-zinc-500 hover:text-red-400 transition-colors p-2">
              <LogOut size={18} />
            </button>
            <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors p-2">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 px-5 pt-3">
          <button
            onClick={() => setTab("trails")}
            className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-bold py-2.5 rounded-xl transition-colors ${
              tab === "trails" ? "bg-orange-500 text-white" : "bg-white/5 text-zinc-400 hover:bg-white/10"
            }`}
          >
            <Route size={14} /> מסלולים שמורים
          </button>
          <button
            onClick={() => setTab("history")}
            className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-bold py-2.5 rounded-xl transition-colors ${
              tab === "history" ? "bg-orange-500 text-white" : "bg-white/5 text-zinc-400 hover:bg-white/10"
            }`}
          >
            <History size={14} /> היסטוריית סיורים
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-5 flex flex-col gap-3 min-h-[200px]">
          {error && (
            <div className="bg-red-950/60 border border-red-500/40 rounded-xl p-3 text-red-300 text-xs flex items-start justify-between gap-3">
              <span>{error}</span>
              <button
                onClick={refresh}
                disabled={refreshing}
                className="shrink-0 flex items-center gap-1 font-bold text-red-200 hover:text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> נסה שוב
              </button>
            </div>
          )}

          {readOnly && (
            <div className="bg-amber-950/50 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-xs flex items-center gap-2">
              <WifiOff size={14} className="shrink-0" />
              <span>
                מוצגים נתונים שמורים מהמכשיר (עודכנו {new Date(cachedAt!).toLocaleDateString("he-IL")}).
                אפשר לטעון מסלולים, אבל שמירה ועריכה לא זמינות כרגע.
              </span>
            </div>
          )}

          {tab === "trails" && (
            trails === null ? (
              <Loader2 className="w-6 h-6 animate-spin text-orange-500 mx-auto mt-8" />
            ) : trails.length === 0 ? (
              // בלי התניה ב-error, כישלון טעינה היה נראה כמו "אין מסלולים"
              error ? null : (
                <p className="text-zinc-500 text-sm text-center mt-8">
                  אין עדיין מסלולים שמורים.<br />טען מסלול ולחץ על "שמור מסלול".
                </p>
              )
            ) : (
              trails.map((t) => (
                <div key={t.id} className="bg-white/5 border border-white/5 rounded-2xl p-4">
                  <div className="flex justify-between items-start gap-2">
                    <button onClick={() => onLoadSavedTrail(t)} className="text-right flex-1 group">
                      <span className="text-white font-bold text-sm group-hover:text-orange-400 transition-colors flex items-center gap-1.5">
                        <MapPin size={14} className="text-orange-500 shrink-0" />
                        {t.name}
                      </span>
                      <span className="text-zinc-500 text-[11px] block mt-1">
                        {t.total_distance ? `${t.total_distance.toFixed(1)} ק"מ • ` : ""}
                        נשמר {new Date(t.created_at).toLocaleDateString("he-IL")}
                      </span>
                    </button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={readOnly}
                      className="text-zinc-600 hover:text-red-400 transition-colors p-1 disabled:opacity-30 disabled:hover:text-zinc-600"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="flex justify-between items-center mt-3 pt-2 border-t border-white/5">
                    <Stars trailName={t.name} />
                    <button
                      onClick={() => openNoteEditor(t.name)}
                      disabled={readOnly}
                      className="text-[11px] font-bold text-sky-400 hover:text-sky-300 transition-colors disabled:opacity-40 disabled:hover:text-sky-400"
                    >
                      {notes.get(t.name)?.note ? "ערוך הערה" : "הוסף הערה ודירוג"}
                    </button>
                  </div>
                  {notes.get(t.name)?.note && (
                    <p className="text-zinc-400 text-xs mt-2 bg-black/20 rounded-lg p-2">{notes.get(t.name)!.note}</p>
                  )}
                </div>
              ))
            )
          )}

          {tab === "history" && (
            history === null ? (
              <Loader2 className="w-6 h-6 animate-spin text-orange-500 mx-auto mt-8" />
            ) : history.length === 0 ? (
              error ? null : (
                <p className="text-zinc-500 text-sm text-center mt-8">
                  אין עדיין סיורים בהיסטוריה.<br />צא לסיור וירטואלי והוא יתועד כאן אוטומטית.
                </p>
              )
            ) : (
              history.map((h) => (
                <div key={h.id} className="bg-white/5 border border-white/5 rounded-2xl p-4 flex justify-between items-center">
                  <div>
                    <span className="text-white font-bold text-sm">{h.trail_name}</span>
                    <span className="text-zinc-500 text-[11px] block mt-1">
                      {new Date(h.created_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}
                      {" • "}
                      {h.mode === "field" ? "מצב שטח" : "סיור וירטואלי"}
                    </span>
                  </div>
                  <div className="text-left">
                    <span className="text-emerald-400 font-bold text-sm block">{h.completed_pct ?? 0}%</span>
                    {h.distance_km != null && (
                      <span className="text-zinc-500 text-[11px]">{h.distance_km.toFixed(1)} ק"מ</span>
                    )}
                  </div>
                </div>
              ))
            )
          )}
        </div>

        {/* Note editor */}
        {editingNote && (
          <div className="border-t border-white/10 p-5 bg-black/30 rounded-b-3xl">
            <h3 className="text-white font-bold text-sm mb-2">הערה ודירוג — {editingNote}</h3>
            <div className="flex gap-1 mb-3" dir="ltr">
              {[1, 2, 3, 4, 5].map((i) => (
                <button key={i} onClick={() => setRatingDraft(ratingDraft === i ? null : i)}>
                  <Star
                    size={22}
                    className={i <= (ratingDraft ?? 0) ? "text-amber-400 fill-amber-400" : "text-zinc-600 hover:text-zinc-400"}
                  />
                </button>
              ))}
            </div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="איך היה המסלול? נקודות ציון, טיפים, דברים לזכור..."
              className="w-full bg-zinc-800 border border-white/10 rounded-xl p-3 text-white text-sm placeholder:text-zinc-600 focus:outline-none focus:border-orange-500 resize-none h-20"
            />
            <div className="flex gap-2 mt-3">
              <button onClick={saveNote} className="flex-1 bg-orange-500 hover:bg-orange-400 text-white font-bold py-2 rounded-xl text-sm transition-colors">
                שמור
              </button>
              <button onClick={() => setEditingNote(null)} className="px-4 bg-white/5 hover:bg-white/10 text-zinc-300 font-bold py-2 rounded-xl text-sm transition-colors">
                ביטול
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
