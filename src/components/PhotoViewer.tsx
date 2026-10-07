import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, MapPin, X } from 'lucide-react';
import type { TrailPhoto } from '../lib/trailPhotos/types';
import { photoLabel } from './TrailPhotosSection';

// A trail photo on the whole screen, with who took it, its licence and a
// link to its page — the CC licences require the credit beside the picture.
// Swipe or the arrows for the next photo along the trail; "הצג במפה" closes
// the viewer and flies the map to where it was taken.

const SOURCE_NAME: Record<TrailPhoto['source'], string> = {
  commons: 'ויקישיתוף',
  panoramax: 'Panoramax',
};

export default function PhotoViewer({ photos, index, onIndex, onClose, onShowOnMap }: {
  photos: TrailPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onShowOnMap: (photo: TrailPhoto) => void;
}) {
  const p = photos[index];
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const count = photos.length;
  // Along the trail is right to left, as the text reads.
  const next = () => onIndex((index + 1) % count);
  const prev = () => onIndex((index - 1 + count) % count);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onIndex((index + 1) % count);
      else if (e.key === 'ArrowRight') onIndex((index - 1 + count) % count);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onIndex, onClose]);

  if (!p) return null;
  const src = failed === p.id ? p.thumb : p.full;

  return (
    <div
      className="fixed inset-0 z-[200] bg-black flex flex-col"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="תמונה מהמסלול"
      onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => {
        const t = touch.current;
        touch.current = null;
        if (!t || count < 2) return;
        const dx = e.changedTouches[0].clientX - t.x;
        const dy = e.changedTouches[0].clientY - t.y;
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
        if (dx > 0) next(); else prev();
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2">
        <div className="text-white font-bold text-sm">
          {photoLabel(p)}
          {count > 1 && <span className="font-normal"> · {index + 1} מתוך {count}</span>}
        </div>
        <button type="button" onClick={onClose} aria-label="סגירה" className="rounded-full bg-white/15 hover:bg-white/25 p-2 text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        {loaded !== src && (
          <span className="absolute w-8 h-8 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={src}
          src={src}
          alt={photoLabel(p)}
          className="max-w-full max-h-full object-contain"
          onLoad={() => setLoaded(src)}
          onError={() => { if (src !== p.thumb) setFailed(p.id); }}
        />
        {count > 1 && (
          <>
            <button type="button" onClick={prev} aria-label="התמונה הקודמת" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/80 p-2 text-white">
              <ChevronRight className="w-6 h-6" />
            </button>
            <button type="button" onClick={next} aria-label="התמונה הבאה" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/80 p-2 text-white">
              <ChevronLeft className="w-6 h-6" />
            </button>
          </>
        )}
      </div>

      <div className="px-4 pt-3 pb-[max(env(safe-area-inset-bottom),14px)] flex flex-col gap-2 text-white">
        <div className="text-sm">
          צילום: <bdi className="font-bold">{p.author}</bdi>
          {' · '}<bdi>{p.license}</bdi>
          {p.takenAt && <> · {p.takenAt.slice(0, 4)}</>}
        </div>
        <div className="flex flex-wrap gap-2">
          {p.lat != null && p.lon != null && (
            <button
              type="button"
              onClick={() => onShowOnMap(p)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 px-3 py-2 text-sm font-bold"
            >
              <MapPin className="w-4 h-4" /> הצג במפה
            </button>
          )}
          <a
            href={p.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 hover:bg-white/25 px-3 py-2 text-sm font-bold"
          >
            <ExternalLink className="w-4 h-4" /> התמונה ב{SOURCE_NAME[p.source]}
          </a>
        </div>
      </div>
    </div>
  );
}
