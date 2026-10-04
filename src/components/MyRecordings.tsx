import { useCallback, useEffect, useState } from "react";
import { Loader2, MapPin, Share2, Link2, FileDown, Pencil, Trash2, Link2Off, CloudOff, Circle } from "lucide-react";
import { RecStatsGrid } from "./RecordPanel";
import { describeSupabaseError } from "../lib/personalArea";
import { formatClock } from "../lib/recording/stats";
import { deleteRecording, listForUser, renameRecording, setShared, syncRecordings, upsertRecording } from "../lib/recording/sync";
import { shareGpxFile, shareWalkLink } from "../lib/recording/share";
import type { Recording } from "../lib/recording/types";

// "ההקלטות שלי": the walks recorded on this phone, and — signed in — the ones
// in the account from any phone. Each opens on the map, is renamed, deleted,
// or shared: by link (needs the account) or as a GPX file (does not).

export default function MyRecordings({
  userId, canReachAccount, onOpen, onSignIn,
}: {
  userId: string | null;
  // Signed in, with a live session and reception.
  canReachAccount: boolean;
  onOpen: (rec: Recording) => void;
  onSignIn?: () => void;
}) {
  const [list, setList] = useState<Recording[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList(await listForUser(userId).catch(() => []));
    if (!userId || !canReachAccount) return;
    try {
      setList(await syncRecordings(userId));
      setSyncError(null);
    } catch (e) {
      console.error("Recordings sync failed:", e);
      setSyncError(describeSupabaseError(e));
    }
  }, [userId, canReachAccount]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const replace = (rec: Recording) => setList((l) => (l ?? []).map((r) => (r.id === rec.id ? rec : r)));

  const shareLink = async (rec: Recording) => {
    setShareFor(null);
    if (!userId) {
      alert("לשיתוף בקישור צריך להתחבר עם Google — הקישור מצביע על עותק בחשבון. בלי התחברות אפשר לשתף קובץ GPX.");
      return;
    }
    if (!canReachAccount) {
      alert("אין כרגע חיבור לחשבון. אפשר לשתף בקישור כשיחזור החיבור, או לשתף עכשיו קובץ GPX.");
      return;
    }
    setBusy(rec.id);
    try {
      const shared = rec.shared ? rec : await setShared(rec, true, userId);
      replace(shared);
      const how = await shareWalkLink(shared);
      if (how === "copied") setNotice("הקישור הועתק — אפשר להדביק אותו בהודעה.");
    } catch (e) {
      console.error(e);
      alert(describeSupabaseError(e));
    } finally {
      setBusy(null);
    }
  };

  const unshare = async (rec: Recording) => {
    if (!userId || !canReachAccount) { alert("ביטול השיתוף צריך חיבור לחשבון."); return; }
    setBusy(rec.id);
    try { replace(await setShared(rec, false, userId)); setNotice("השיתוף בוטל — הקישור כבר לא נפתח."); }
    catch (e) { alert(describeSupabaseError(e)); }
    finally { setBusy(null); }
  };

  const shareFile = async (rec: Recording) => {
    setShareFor(null);
    try {
      const how = await shareGpxFile(rec);
      if (how === "downloaded") setNotice("קובץ ה-GPX ירד למכשיר.");
      if (how === "unsupported") alert("כדי לשתף קובץ מתוך האפליקציה צריך לעדכן את אפליקציית Navi לגרסה החדשה.");
    } catch (e) {
      console.error(e);
      alert("השיתוף לא הצליח.");
    }
  };

  const rename = async (rec: Recording) => {
    const name = window.prompt("שם ההקלטה", rec.name)?.trim();
    if (!name || name === rec.name) return;
    let next = await renameRecording(rec, name);
    replace(next);
    if (userId && canReachAccount) {
      try { next = await upsertRecording(next, userId); replace(next); } catch {}
    }
  };

  const remove = async (rec: Recording) => {
    if (!window.confirm(`למחוק את "${rec.name}"? ההקלטה תימחק מהמכשיר${rec.ownerId ? " ומהחשבון" : ""}.`)) return;
    await deleteRecording(rec, canReachAccount);
    setList((l) => (l ?? []).filter((r) => r.id !== rec.id));
  };

  if (list === null) return <Loader2 className="w-6 h-6 animate-spin text-red-400 mx-auto mt-8" />;

  return (
    <div className="flex flex-col gap-3">
      {!userId && onSignIn && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white flex flex-col gap-2">
          <span>ההקלטות שמורות במכשיר הזה. התחברות עם Google שומרת אותן גם בחשבון, ומאפשרת לשתף אותן בקישור.</span>
          <button onClick={onSignIn} className="self-start bg-white text-zinc-900 font-bold text-sm px-4 py-2 rounded-xl hover:bg-zinc-200">
            התחבר עם Google
          </button>
        </div>
      )}
      {syncError && <p className="text-sm text-amber-300">{syncError} ההקלטות שבמכשיר מוצגות.</p>}
      {notice && (
        <button onClick={() => setNotice(null)} className="text-right bg-emerald-950/70 border border-emerald-500/40 rounded-xl p-3 text-sm text-emerald-100">
          {notice}
        </button>
      )}

      {list.length === 0 ? (
        <p className="text-white text-sm text-center mt-6 leading-relaxed">
          אין עדיין הקלטות.<br />לחצו על <Circle className="inline w-3.5 h-3.5 text-red-400 fill-red-400" /> ״הקלטה״ בסרגל הצד כשאתם יוצאים להליכה.
        </p>
      ) : list.map((rec) => {
        const s = rec.stats;
        const isOpen = open === rec.id;
        return (
          <div key={rec.id} className="bg-white/5 border border-white/5 rounded-2xl p-4 flex flex-col gap-2">
            <button onClick={() => setOpen(isOpen ? null : rec.id)} className="text-right flex flex-col gap-1">
              <span className="text-white font-bold text-sm flex items-center gap-1.5">
                <Circle className="w-3 h-3 shrink-0 text-red-400 fill-red-400" />
                <span className="truncate">{rec.name}</span>
              </span>
              <span className="text-white text-xs">
                {new Date(rec.startedAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}
                {" · "}<span className="text-yellow-300 font-bold">{s.distanceKm.toFixed(1)} ק״מ</span>
                {s.gainM != null && <> · ↑{s.gainM} ↓{s.lossM} מ׳</>}
                {" · "}<span dir="ltr">{formatClock(s.movingSec)}</span> הליכה
              </span>
              <span className="flex gap-2 text-xs">
                {rec.shared && <span className="text-emerald-300 font-bold">משותף בקישור</span>}
                {userId && !rec.syncedAt && <span className="text-amber-300 flex items-center gap-1"><CloudOff className="w-3 h-3" /> עדיין רק במכשיר</span>}
              </span>
            </button>

            {isOpen && <RecStatsGrid stats={s} />}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
              <button onClick={() => onOpen(rec)} className="flex items-center gap-1 text-xs font-bold text-white bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg">
                <MapPin className="w-3.5 h-3.5 text-red-400" /> פתח על המפה
              </button>
              <button
                onClick={() => setShareFor(shareFor === rec.id ? null : rec.id)}
                disabled={busy === rec.id}
                className="flex items-center gap-1 text-xs font-bold text-emerald-300 bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg disabled:opacity-60"
              >
                {busy === rec.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />} שתף
              </button>
              <button onClick={() => rename(rec)} className="flex items-center gap-1 text-xs font-bold text-sky-300 bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg">
                <Pencil className="w-3.5 h-3.5" /> שנה שם
              </button>
              <button onClick={() => remove(rec)} className="mr-auto p-1.5 text-red-300 hover:text-red-200" aria-label="מחק הקלטה" title="מחק">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {shareFor === rec.id && (
              <div className="flex flex-col gap-2 bg-black/30 rounded-xl p-2">
                <button onClick={() => shareLink(rec)} className="flex items-center gap-2 text-sm font-bold text-white hover:bg-white/10 p-2 rounded-lg text-right">
                  <Link2 className="w-4 h-4 text-emerald-300 shrink-0" />
                  <span>קישור שפותח את המסלול ב-Navi{!userId && <span className="block text-xs font-normal text-amber-300">דורש התחברות</span>}</span>
                </button>
                <button onClick={() => shareFile(rec)} className="flex items-center gap-2 text-sm font-bold text-white hover:bg-white/10 p-2 rounded-lg text-right">
                  <FileDown className="w-4 h-4 text-sky-300 shrink-0" />
                  <span>קובץ GPX — לכל אפליקציית ניווט</span>
                </button>
                {rec.shared && (
                  <button onClick={() => { setShareFor(null); void unshare(rec); }} className="flex items-center gap-2 text-sm font-bold text-white hover:bg-white/10 p-2 rounded-lg text-right">
                    <Link2Off className="w-4 h-4 text-red-300 shrink-0" />
                    <span>בטל את השיתוף — הקישור יפסיק לעבוד</span>
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
