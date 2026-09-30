import {
  Sun, CloudSun, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
  Droplets, Wind, Mountain, TriangleAlert, Info, RefreshCw, Clock, Sparkles,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTripAdvice } from "../hooks/useTripAdvice";
import { adviceInput } from "../lib/tripAdvice";
import type { HikeEffort } from "../lib/hikeEffort";
import type { TripWeather } from "../hooks/useTripWeather";
import { weatherCodeInfo, type CodeInfo } from "../lib/weather";
import { formatHour, type DayAdvice, type Warning } from "../lib/hikeAdvice";
import { formatHours } from "../lib/hikeEffort";

// The forecast for the day of the trip, and what to take for it.
//
// Read outdoors, on a phone, often in sunlight — so everything here that
// somebody is meant to read is white or a bright colour, and nothing is
// smaller than text-xs (see CLAUDE.md).

const ICONS: Record<CodeInfo["icon"], typeof Sun> = {
  sun: Sun,
  "cloud-sun": CloudSun,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
};

export function WeatherIcon({ code, className }: { code: number; className?: string }) {
  const Icon = ICONS[weatherCodeInfo(code).icon];
  return <Icon className={className} />;
}

const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

function dayLabel(d: DayAdvice): string {
  if (d.daysAhead === 0) return "היום";
  if (d.daysAhead === 1) return "מחר";
  return WEEKDAYS[new Date(`${d.date}T12:00`).getDay()];
}

const RATING_DOT: Record<DayAdvice["rating"], string> = {
  good: "bg-emerald-400",
  fair: "bg-amber-400",
  bad: "bg-red-500",
};

const WARNING_STYLE: Record<Warning["level"], string> = {
  danger: "bg-red-500/15 border-red-400/40 text-red-100",
  warn: "bg-amber-500/10 border-amber-400/35 text-amber-100",
  info: "bg-sky-500/10 border-sky-400/30 text-sky-100",
};

function agoLabel(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 60) return `לפני ${Math.max(1, mins)} דק׳`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? "לפני שעה" : `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? "אתמול" : `לפני ${days} ימים`;
}

interface TrailBrief {
  name: string;
  kind: "hike" | "drive";
  totalDistance: number;
}

export default function TripWeatherSection({ weather, isDrive, trail }: { weather: TripWeather; isDrive: boolean; trail: TrailBrief }) {
  const { status, days, selected: day, effort, hours, fetchedAt } = weather;

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <div className="text-xs text-white uppercase tracking-widest mb-1 font-bold">מזג אוויר ליום הטיול</div>

      {effort && (
        <div className="text-xs text-zinc-100 mb-2">
          הליכה משוערת <span className="text-white font-bold">{formatHours(hours)}</span> עם הפסקות
          {" · "}רמת מאמץ <span className="text-white font-bold">{effort.levelLabel}</span>
        </div>
      )}

      {status === "loading" && days.length === 0 && (
        <div className="text-sm text-white">טוען תחזית…</div>
      )}

      {/* Not being able to ask has to look different from a fine day — an
          empty panel here reads as "nothing to worry about". */}
      {(status === "unavailable" || status === "rate-limited") && days.length === 0 && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-400/35 p-2 text-sm text-amber-100 flex items-center justify-between gap-2">
          <span>
            {status === "rate-limited" ? "יותר מדי בקשות כרגע" : "לא הצלחנו לקבל תחזית כרגע"} — אין מידע על מזג האוויר.
          </span>
          <button onClick={weather.retry} className="shrink-0 p-1.5 bg-white/10 hover:bg-white/20 rounded-full" title="נסה שוב">
            <RefreshCw className="w-4 h-4 text-white" />
          </button>
        </div>
      )}

      {days.length > 0 && (
        <>
          {/* The week, to choose the day by: each one coloured by how the rules
              below judge it, so a stormy Saturday shows before it is tapped. */}
          <div className="flex gap-1 mb-3" role="radiogroup" aria-label="בחירת יום הטיול">
            {days.map((d) => {
              const active = d.date === day?.date;
              return (
                <button
                  key={d.date}
                  role="radio"
                  aria-checked={active}
                  onClick={() => weather.selectDate(d.date)}
                  className={`flex-1 min-w-0 flex flex-col items-center gap-0.5 rounded-xl py-1.5 border transition-colors ${active ? "bg-white/15 border-white/40" : "bg-white/5 border-transparent hover:bg-white/10"}`}
                >
                  <span className="text-xs text-white font-bold">{dayLabel(d)}</span>
                  <span className="text-[11px] text-zinc-200">{Number(d.date.slice(8, 10))}/{Number(d.date.slice(5, 7))}</span>
                  <WeatherIcon code={d.summary.code} className="w-4 h-4 text-white" />
                  <span className="text-xs text-white font-bold">{Math.round(d.summary.tMax)}°</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${RATING_DOT[d.rating]}`} />
                </button>
              );
            })}
          </div>

          {day && <DayDetails day={day} isDrive={isDrive} />}

          {day && <AdviceText trail={trail} day={day} effort={effort} hours={hours} />}

          <div className="text-xs text-zinc-200 mt-2 leading-relaxed">
            {status === "cached" && fetchedAt != null && (
              <span className="text-amber-200">תחזית שמורה במכשיר, עודכנה {agoLabel(fetchedAt)}. </span>
            )}
            {day && day.reliability === "low" && (
              <span>תחזית לעוד {day.daysAhead} ימים עלולה להשתנות — כדאי לבדוק שוב ערב הטיול. </span>
            )}
            {day && day.reliability === "medium" && <span>כדאי לבדוק שוב ערב הטיול. </span>}
            תחזית: Open-Meteo. שעות ההליכה, המים והביגוד הם הערכה לתכנון לפי קצב ממוצע.
          </div>
        </>
      )}
    </div>
  );
}

function DayDetails({ day, isDrive }: { day: DayAdvice; isDrive: boolean }) {
  const s = day.summary;
  const info = weatherCodeInfo(s.code);

  return (
    <div>
      {/* The day in one glance */}
      <div className="flex items-center gap-3 mb-2">
        <WeatherIcon code={s.code} className="w-9 h-9 text-yellow-300 shrink-0" />
        <div className="min-w-0">
          <div className="text-base text-white font-bold leading-tight">
            {info.label} · <Deg from={s.tMin} to={s.tMax} />
          </div>
          <div className="text-xs text-zinc-100">
            מרגיש כמו <Deg from={s.feelsMin} to={s.feelsMax} /> · {s.heat.label}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5 mb-2 text-center">
        <Stat icon={<Droplets className="w-3.5 h-3.5" />} label="סיכוי לגשם" value={`${Math.round(s.popMax)}%`} tone="text-sky-300" />
        <Stat icon={<Wind className="w-3.5 h-3.5" />} label="משבי רוח" value={`${s.gustMax} קמ״ש`} tone="text-white" />
        <Stat icon={<Sun className="w-3.5 h-3.5" />} label="קרינת UV" value={String(Math.round(s.uvMax))} tone="text-yellow-300" />
      </div>

      <div className="text-xs text-zinc-100 mb-2 flex items-center gap-1 flex-wrap">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        יציאה {formatHour(day.startHour)} · סיום משוער {formatHour(Math.min(23.99, day.endHour))} · שקיעה {day.sunset}
      </div>

      {s.high && (
        <div className="text-xs text-zinc-100 mb-2 flex items-center gap-1">
          <Mountain className="w-3.5 h-3.5 shrink-0" />
          בנקודה הגבוהה ({s.high.ele} מ׳): <span className="text-white font-bold"><Deg from={s.high.tMin} to={s.high.tMax} /></span>, מרגיש כמו <Deg from={s.high.feelsMin} />
        </div>
      )}

      {/* Hour by hour through the walk */}
      <div className="flex gap-1 overflow-x-auto pb-1 mb-2 overscroll-x-contain">
        {day.hours.map((h) => (
          <div key={h.hour} className="shrink-0 w-11 flex flex-col items-center rounded-lg bg-white/5 py-1">
            <span className="text-[11px] text-zinc-200">{String(h.hour).padStart(2, "0")}:00</span>
            <WeatherIcon code={h.code} className="w-4 h-4 text-white my-0.5" />
            <span className={`text-xs font-bold ${h.heatLevel >= 4 ? "text-red-300" : h.heatLevel >= 3 ? "text-amber-300" : "text-white"}`}>{Math.round(h.temp)}°</span>
            {h.pop >= 20 && <span className="text-[11px] text-sky-300">{Math.round(h.pop)}%</span>}
          </div>
        ))}
      </div>

      {day.suggestedStart != null && (
        <div className="text-xs text-sky-200 mb-2">
          כדאי לצאת כבר ב־<span className="font-bold text-white">{formatHour(day.suggestedStart)}</span> — פחות שעות בחום.
        </div>
      )}

      {day.warnings.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-2">
          {day.warnings.map((w) => (
            <div key={w.id} className={`rounded-lg border p-2 text-xs leading-relaxed flex gap-1.5 ${WARNING_STYLE[w.level]}`}>
              {w.level === "info" ? <Info className="w-4 h-4 shrink-0" /> : <TriangleAlert className="w-4 h-4 shrink-0" />}
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* What to take */}
      {!isDrive && day.water && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
          <div className="text-xs text-white font-bold mb-1.5">מה לקחת</div>
          <div className="flex items-baseline gap-2 mb-1">
            <Droplets className="w-4 h-4 text-sky-300 self-center" />
            <span className="text-xl font-bold text-sky-300 leading-none">{day.water.liters}</span>
            <span className="text-sm text-white">ליטר מים לאדם</span>
          </div>
          <div className="text-xs text-zinc-100 mb-2">
            בערך {day.water.perHour} ליטר לשעת הליכה, ועוד חצי ליטר רזרבה.
            {day.water.electrolytes && <span className="text-amber-200"> לקחת גם חטיפים מלוחים או אבקת מלחים.</span>}
          </div>
          {day.clothing.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {day.clothing.map((c) => (
                <span key={c.id} className="text-xs text-white bg-white/10 rounded-full px-2 py-0.5">{c.label}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The day in words. The facts above it stay the authority; this says them
// the way a guide would, and falls back to plain sentences with no signal.
function AdviceText({ trail, day, effort, hours }: { trail: TrailBrief; day: DayAdvice; effort: HikeEffort | null; hours: number }) {
  const input = useMemo(
    () => adviceInput({ name: trail.name, kind: trail.kind, totalDistance: trail.totalDistance }, day, effort, hours),
    [trail.name, trail.kind, trail.totalDistance, day, effort, hours],
  );
  const advice = useTripAdvice(input);

  return (
    <div className="mt-2 rounded-xl bg-sky-500/10 border border-sky-400/25 p-2.5">
      <div className="text-xs text-sky-200 font-bold mb-1 flex items-center gap-1">
        <Sparkles className="w-3.5 h-3.5" />
        {advice.source === "plain" ? "בקצרה" : "מה צפוי ביום הזה"}
      </div>
      {advice.loading && <div className="text-sm text-white">מכין הסבר…</div>}
      {advice.text && <p className="text-sm text-white leading-relaxed">{isolateNumbers(advice.text)}</p>}
      {advice.source === "plain" && (
        <div className="text-xs text-zinc-200 mt-1">סיכום אוטומטי — אין כרגע חיבור לשירות ההסבר.</div>
      )}
    </div>
  );
}

// The same problem in running text, where the numbers arrive inside the
// model's sentence: each number, range or time ("17–18°", "-3°", "07:00") is
// wrapped in a left-to-right isolate so it reads the way it was written, and
// a range is glued together so a line break cannot split "24–" from "26°".
function isolateNumbers(text: string): string {
  return text.replace(/\d{1,2}:\d{2}|-?\d+(?:\.\d+)?(?:\s*[–-]\s*-?\d+(?:\.\d+)?)?°?/g, (m) =>
    `\u2066${m.replace(/\s+/g, "\u00a0").replace(/(?<=.)([–-])/g, "\u2060$1\u2060")}\u2069`,
  );
}

// Temperatures kept left-to-right: inside a Hebrew line "27–28°" otherwise
// comes out as "°28–27".
function Deg({ from, to }: { from: number; to?: number }) {
  const a = Math.round(from);
  const b = to == null ? null : Math.round(to);
  return <span dir="ltr" className="inline-block">{b == null || b === a ? `${a}°` : `${a}–${b}°`}</span>;
}

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg bg-white/5 py-1.5">
      <div className="text-[11px] text-zinc-200 flex items-center justify-center gap-1">{icon}{label}</div>
      <div className={`text-sm font-bold ${tone}`}>{value}</div>
    </div>
  );
}
