import { UserCircle2, BookmarkPlus, Check, Share2, LocateOff, Circle } from 'lucide-react';

// The first things in the settings window: the account, and what can be done
// with the trail on screen. (They used to be a separate "עוד" sheet.)
export default function SettingsActions({
  authAvailable, isSignedIn, onAuthClick, onOpenRecordings,
  hasTrail, onSaveTrail, saveTrailState, canShare, onShare,
  isTracking, onStopTracking,
}: {
  authAvailable?: boolean;
  isSignedIn?: boolean;
  onAuthClick?: () => void;
  // The recordings on this device. Signed in, they are a tab of the personal area.
  onOpenRecordings?: () => void;
  hasTrail?: boolean;
  onSaveTrail?: () => void;
  saveTrailState?: 'idle' | 'saving' | 'saved';
  canShare?: boolean;
  onShare?: () => void;
  isTracking?: boolean;
  onStopTracking?: () => void;
}) {
  const row = 'flex items-center gap-2.5 text-sm font-bold p-3 rounded-xl transition-colors';
  return (
    <>
      {authAvailable && onAuthClick && (
        <button
          onClick={onAuthClick}
          className={`${row} ${isSignedIn ? 'bg-orange-500/15 text-orange-300 hover:bg-orange-500/25' : 'bg-white/5 text-white hover:bg-white/10'}`}
        >
          <UserCircle2 size={16} /> {isSignedIn ? 'אזור אישי' : 'התחבר עם Google'}
        </button>
      )}
      {!isSignedIn && onOpenRecordings && (
        <button onClick={onOpenRecordings} className={`${row} bg-white/5 text-white hover:bg-white/10`}>
          <Circle size={14} className="text-red-400 fill-red-400" /> ההקלטות שלי
        </button>
      )}
      {hasTrail && isSignedIn && onSaveTrail && (
        <button
          onClick={onSaveTrail}
          disabled={saveTrailState !== 'idle'}
          className={`${row} disabled:opacity-70 ${saveTrailState === 'saved' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-sky-300 hover:bg-white/10'}`}
        >
          {saveTrailState === 'saved' ? <><Check size={16} /> נשמר באזור האישי</>
            : saveTrailState === 'saving' ? <><BookmarkPlus size={16} /> שומר...</>
            : <><BookmarkPlus size={16} /> שמור מסלול</>}
        </button>
      )}
      {hasTrail && canShare && onShare && (
        <button onClick={onShare} className={`${row} bg-white/5 text-emerald-300 hover:bg-white/10`}>
          <Share2 size={16} /> שתף מסלול
        </button>
      )}
      {isTracking && onStopTracking && (
        <button onClick={onStopTracking} className={`${row} bg-white/5 text-sky-300 hover:bg-white/10`}>
          <LocateOff size={16} /> כבה מיקום חי
        </button>
      )}
    </>
  );
}
