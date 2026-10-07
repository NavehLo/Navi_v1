import { useEffect, useMemo } from 'react';
import { Camera, ExternalLink, RotateCcw } from 'lucide-react';
import Collapsible from './Collapsible';
import { photosRequest, readSavedPhotos, useTrailPhotos } from '../hooks/useTrailPhotos';
import { googleImagesUrl } from '../hooks/usePlacePhotos';
import type { TrailPhoto } from '../lib/trailPhotos/types';
import type { Coordinate3D } from '../utils/trailUtils';

// "תמונות מהמסלול" in the trail card: photos taken along the trail, at most
// one per part of it (lib/trailPhotos/select.ts), in the order the trail
// passes them. A tap opens the photo with its credit. Once loaded, the
// photos' places are marked on the map until the trail is closed — a tap on
// the map folds the card, and the marks are there to be tapped. Searched for
// only when the section is opened.

export interface TrailPhotosHandlers {
  // The photos to mark on the map (page.tsx clears them with the trail).
  onShow: (photos: TrailPhoto[]) => void;
  onOpen: (photos: TrailPhoto[], index: number) => void;
}

export function photoLabel(p: TrailPhoto): string {
  return p.km == null ? 'תמונת המסלול' : `ק״מ ${p.km.toFixed(1)}`;
}

export default function TrailPhotosSection({ coords, wmtId, name, onShow, onOpen }: {
  coords: Coordinate3D[];
  wmtId: number | null;
  name: string;
} & TrailPhotosHandlers) {
  // Loaded here before: the count is known while the section is closed.
  const saved = useMemo(() => readSavedPhotos(photosRequest(coords, wmtId).key), [coords, wmtId]);
  const count = saved?.photos.length ?? 0;

  return (
    <Collapsible
      variant="section"
      icon={<Camera className="w-4 h-4 text-sky-300" />}
      title="תמונות מהמסלול"
      summary={saved ? (count ? `${count} תמונות לאורך המסלול` : 'אין תמונות חופשיות — חיפוש בגוגל') : undefined}
    >
      <PhotosBody coords={coords} wmtId={wmtId} name={name} onShow={onShow} onOpen={onOpen} />
    </Collapsible>
  );
}

function PhotosBody({ coords, wmtId, name, onShow, onOpen }: {
  coords: Coordinate3D[];
  wmtId: number | null;
  name: string;
} & TrailPhotosHandlers) {
  const { state, retry } = useTrailPhotos(coords, wmtId);
  const photos = state.status === 'ok' ? state.photos.photos : null;

  useEffect(() => {
    if (photos?.length) onShow(photos);
  }, [photos, onShow]);

  const google = (
    <a
      href={googleImagesUrl(name)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 self-start rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 px-3 py-2 text-sm font-bold text-white"
    >
      <ExternalLink className="w-4 h-4" /> עוד תמונות בגוגל
    </a>
  );

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-2 text-sm text-white">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full border-2 border-sky-300 border-t-transparent animate-spin" />
          מחפש תמונות לאורך המסלול… בפעם הראשונה זה לוקח עד חצי דקה.
        </div>
      </div>
    );
  }
  if (state.status !== 'ok') {
    const text = state.status === 'offline'
      ? 'אין חיבור לרשת — התמונות ייטענו כשיחזור.'
      : state.status === 'rate-limited'
        ? 'יותר מדי בקשות ברגע זה. נסו שוב בעוד דקה.'
        : 'לא הצלחנו לחפש תמונות כרגע.';
    return (
      <div className="flex flex-col gap-2 text-sm text-white">
        <div>{text}</div>
        <div className="flex flex-wrap gap-2">
          {state.status !== 'offline' && (
            <button type="button" onClick={retry} className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 px-3 py-2 text-sm font-bold text-white">
              <RotateCcw className="w-4 h-4" /> נסו שוב
            </button>
          )}
          {google}
        </div>
      </div>
    );
  }

  if (!photos?.length) {
    return (
      <div className="flex flex-col gap-2 text-sm text-white">
        <div>לא מצאנו תמונות חופשיות שצולמו לאורך המסלול.</div>
        {google}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="-mx-1 flex gap-2 overflow-x-auto pb-1 px-1 snap-x" dir="rtl">
        {photos.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(photos, i)}
            className="relative shrink-0 snap-start w-40 h-28 rounded-xl overflow-hidden border border-white/15 bg-white/5 active:scale-[0.98] transition-transform"
            aria-label={`${photoLabel(p)} — פתיחת התמונה`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.thumb} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
            <span className="absolute bottom-1 right-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-bold text-white">
              {photoLabel(p)}
            </span>
          </button>
        ))}
      </div>
      <div className="text-xs text-white">
        תמונה אחת מכל קטע של המסלול, מוויקישיתוף{photos.some((p) => p.source === 'panoramax') ? ' ומ־Panoramax' : ''}. לחיצה על תמונה מראה מי צילם.
      </div>
      {google}
    </div>
  );
}
