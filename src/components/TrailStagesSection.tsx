import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, ListOrdered, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import Collapsible from "./Collapsible";
import InfoButton from "./help/InfoButton";
import type { WmtStage } from "../lib/waymarked";
import { latinName, needsEnglish, usefulEnglish } from "../lib/trailNames";
import { knownEnglish, translateWorldTrails } from "../lib/worldTrailSearch";

// "מקטעי המסלול": a long world trail mapped in OSM as a chain of stages (the
// Menalon Trail, a GR, a national trail), listed in the order they are walked.
// A tap on a stage opens that stage; the stage's card then has a button back
// to the long trail (ParentTrailButton below) and to the stages on either
// side of it (StageNav).
//
// Used by both cards a world trail has: the one a tapped route opens
// (WorldTrailCard), where a stage opens in the same card, and the open trail's
// (StatsPanel), where it opens as the trail.
//
// Read outdoors on a phone — white or bright text, nothing under text-xs (see
// CLAUDE.md).

export default function TrailStagesSection({
  stages, onPick, pendingId = null,
}: {
  stages: WmtStage[];
  onPick: (stage: WmtStage) => void;
  // The stage being fetched after a tap, if any.
  pendingId?: number | null;
}) {
  const lengths = stages.map((s) => s.lengthKm).filter((km) => km > 0);
  const shortest = lengths.length ? Math.min(...lengths) : null;
  const longest = lengths.length ? Math.max(...lengths) : null;

  const summary = (
    <>
      <span className="text-orange-300">{stages.length} מקטעים</span>
      {shortest != null && longest != null && (
        <span>· {shortest === longest ? `${shortest.toFixed(1)} ק״מ כל אחד` : `בין ${shortest.toFixed(1)} ל־${longest.toFixed(1)} ק״מ`}</span>
      )}
    </>
  );

  return (
    <Collapsible
      variant="section"
      title="מקטעי המסלול"
      icon={<ListOrdered className="w-4 h-4 text-orange-300" />}
      summary={summary}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs text-white">לפי סדר ההליכה. לחיצה על מקטע מציגה אותו על המפה.</span>
        <InfoButton label="מקטעי המסלול">
          <p>
            המסלול הזה ממופה ב־OpenStreetMap כשרשרת של מקטעים — בדרך כלל יום הליכה כל אחד. לחיצה על מקטע פותחת אותו
            לבד: על המפה, עם האורך, העלייה והירידה שלו, ואפשר לטעון רק אותו.
          </p>
          <p className="mt-2">כפתור &quot;חזרה למסלול הראשי&quot; בכרטיס של המקטע מחזיר למסלול כולו.</p>
        </InfoButton>
      </div>
      <StageList stages={stages} onPick={onPick} pendingId={pendingId} />
    </Collapsible>
  );
}

// Only drawn while the section is open, so the English names below are asked
// for only by someone who opened it.
function StageList({ stages, onPick, pendingId }: { stages: WmtStage[]; onPick: (s: WmtStage) => void; pendingId: number | null }) {
  const english = useStageEnglish(stages);
  return (
    <ol className="flex flex-col gap-1.5">
      {stages.map((s, i) => {
        const name = s.name ?? `מקטע ${i + 1}`;
        const sub = english.get(s.id) ?? null;
        const pending = pendingId === s.id;
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s)}
              disabled={pendingId != null}
              className="w-full flex items-center gap-2.5 text-right rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 border border-white/10 px-2.5 py-2 transition-colors disabled:opacity-70"
            >
              <span className="shrink-0 w-6 h-6 rounded-full bg-orange-500 text-white text-xs font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-sm font-bold text-white leading-snug break-words">{name}</span>
                {sub && (
                  <span className="text-xs font-semibold text-sky-200 leading-snug break-words" dir="ltr" style={{ textAlign: "right" }}>
                    {sub}
                  </span>
                )}
                <span className="flex items-center gap-2.5 text-xs font-bold">
                  <span className="text-sky-300">{s.lengthKm.toFixed(1)} ק״מ</span>
                  {s.gain != null && s.loss != null && (
                    <>
                      <span className="text-emerald-300 flex items-center gap-0.5"><TrendingUp className="w-3 h-3" />{s.gain} מ׳</span>
                      <span className="text-red-300 flex items-center gap-0.5"><TrendingDown className="w-3 h-3" />{s.loss} מ׳</span>
                    </>
                  )}
                </span>
              </span>
              {pending
                ? <Loader2 className="w-4 h-4 text-white animate-spin shrink-0" />
                : <ChevronLeft className="w-4 h-4 text-white shrink-0" />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// A line in Latin letters under a stage whose name the reader may not read:
// its start and end as OSM has them when those are in Latin letters,
// otherwise the name translated (the same shared table and model as the
// trail's own English name, ten at a time), or until then spelled in Latin
// letters.
function useStageEnglish(stages: WmtStage[]): Map<number, string> {
  const [translated, setTranslated] = useState<Map<number, string>>(() => new Map());

  const latinItinerary = (s: WmtStage) => {
    const text = s.itinerary.filter(Boolean).join(" – ");
    return text && !needsEnglish(text) ? text : null;
  };
  const toAsk = stages
    .filter((s) => needsEnglish(s.name) && !latinItinerary(s) && knownEnglish(s.id) === undefined)
    .map((s) => s.id);
  const askKey = toAsk.join(",");

  useEffect(() => {
    if (!askKey) return;
    let live = true;
    const ids = askKey.split(",").map(Number);
    (async () => {
      for (let i = 0; i < ids.length && live; i += 10) {
        const names = await translateWorldTrails(ids.slice(i, i + 10));
        if (!live) return;
        setTranslated((prev) => new Map([...prev, ...names]));
      }
    })();
    return () => { live = false; };
  }, [askKey]);

  const out = new Map<number, string>();
  for (const s of stages) {
    const candidate = latinItinerary(s) ?? translated.get(s.id) ?? knownEnglish(s.id) ?? null;
    const shown = usefulEnglish(s.name, candidate) ?? latinName(s.name, null);
    if (shown) out.set(s.id, shown);
  }
  return out;
}

// On a stage's card: the way back to the long trail it is part of.
export function ParentTrailButton({
  name, onBack, pending = false, compact = false,
}: {
  name: string | null;
  onBack: () => void;
  pending?: boolean;
  // One short line, for a folded card.
  compact?: boolean;
}) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onBack(); }}
        disabled={pending}
        className="flex items-center gap-1 text-xs font-bold text-orange-200 hover:text-white min-w-0"
      >
        {pending ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <ArrowRight className="w-3 h-3 shrink-0" />}
        {/* The name stays off this line: on a phone it is cut mid-word. */}
        <span className="truncate" title={name ?? undefined}>חזרה למסלול הראשי</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onBack}
      disabled={pending}
      className="w-full flex items-center gap-2.5 text-right rounded-xl bg-orange-500/20 hover:bg-orange-500/30 active:bg-orange-500/40 border border-orange-400/60 px-3 py-2 transition-colors disabled:opacity-70"
    >
      {pending
        ? <Loader2 className="w-4 h-4 text-white animate-spin shrink-0" />
        : <ArrowRight className="w-4 h-4 text-white shrink-0" />}
      <span className="min-w-0 flex flex-col">
        <span className="text-sm font-bold text-white leading-tight">חזרה למסלול הראשי</span>
        {name && <span className="text-xs font-semibold text-orange-100 leading-snug break-words">מקטע של {name}</span>}
      </span>
    </button>
  );
}

// On a stage's card: the stages on either side of it, in walking order. The
// earlier one is on the right, where an RTL reader starts.
export function StageNav({
  stages, currentId, onGo, pendingId = null,
}: {
  // The long trail's stages.
  stages: WmtStage[];
  currentId: number;
  onGo: (stage: WmtStage) => void;
  pendingId?: number | null;
}) {
  const i = stages.findIndex((s) => s.id === currentId);
  if (i < 0) return null;
  const prev = i > 0 ? stages[i - 1] : null;
  const next = i < stages.length - 1 ? stages[i + 1] : null;

  // The line above says which stage this is; each button says only how long
  // the next step is — a narrow card has room for no more.
  const step = (stage: WmtStage | null, n: number, label: string, side: "prev" | "next") => (
    <button
      type="button"
      onClick={() => stage && onGo(stage)}
      disabled={!stage || pendingId != null}
      className={`flex-1 min-w-0 flex items-center gap-1.5 rounded-xl border px-2.5 py-2 transition-colors
        ${stage ? "bg-white/10 hover:bg-white/15 active:bg-white/20 border-white/15" : "bg-white/5 border-white/5 opacity-40"}
        ${side === "next" ? "flex-row-reverse text-left" : "text-right"}`}
      aria-label={stage ? `${label}: ${stage.name ?? `מקטע ${n}`}` : label}
    >
      {pendingId != null && pendingId === stage?.id
        ? <Loader2 className="w-4 h-4 text-white animate-spin shrink-0" />
        : side === "prev"
          ? <ArrowRight className="w-4 h-4 text-white shrink-0" />
          : <ArrowLeft className="w-4 h-4 text-white shrink-0" />}
      <span className="min-w-0 flex flex-col">
        <span className="text-sm font-bold text-white leading-tight">{label}</span>
        {stage && (
          <span className="text-xs text-orange-100 leading-snug truncate">
            {stage.lengthKm.toFixed(1)} ק״מ
          </span>
        )}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-bold text-white text-center">מקטע {i + 1} מתוך {stages.length}</div>
      <div className="flex items-stretch gap-2">
        {step(prev, i, "המקטע הקודם", "prev")}
        {step(next, i + 2, "המקטע הבא", "next")}
      </div>
    </div>
  );
}
