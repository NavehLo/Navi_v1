// Checks the rules that turn a forecast into water, clothing and warnings.
//
// These are the numbers somebody packs their bag by, so they are pinned here
// rather than trusted to look right on the phone. Two halves:
//
//   1. Made-up days — a hot Judean Desert day, a cold wet day on Meron, snow
//      on the Hermon, rain upstream of a dry Negev wadi — each checked for the
//      litres, layers and warnings it has to produce. Run with no arguments.
//   2. The real forecast for a few trails, printed for a person to read.
//      Run with --live (needs network).
//
//   node scripts/checkHikeAdvice.mjs
//   node scripts/checkHikeAdvice.mjs --live

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const { heatLoad, waterFor, adviseDay, adviseWeek, findTodayIndex } = await import('../src/lib/hikeAdvice.ts');
const { estimateHike } = await import('../src/lib/hikeEffort.ts');
const { weatherPointsFor, isDesertArea, parsePointForecast, parseRingRain, parseDust, PAST_DAYS, PICKABLE_DAYS } = await import('../src/lib/weather.ts');

let failed = 0;
function check(what, ok, got) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `   (got ${JSON.stringify(got)})`}`);
}

// ── Building a fake forecast ─────────────────────────────────────────────────
const DATES = ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14'];
const TODAY = 3; // index of the trip day in DATES

function point(role, ele, fn, dates = DATES, daily = {}) {
  const hourly = { time: [], temp: [], feels: [], rh: [], pop: [], precip: [], code: [], cloud: [], wind: [], gust: [], uv: [], vis: [], cape: [] };
  dates.forEach((date, d) => {
    for (let h = 0; h < 24; h++) {
      const v = { temp: 20, feels: 20, rh: 50, pop: 0, precip: 0, code: 0, cloud: 10, wind: 10, gust: 15, uv: h >= 8 && h <= 16 ? 7 : 1, vis: 20000, cape: 0, ...fn(d, h) };
      hourly.time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      for (const k of Object.keys(v)) hourly[k].push(v[k]);
    }
  });
  return {
    role, lat: 31.5, lon: 35.3, ele,
    hourly,
    daily: {
      date: dates,
      sunrise: dates.map((d) => `${d}T05:45`),
      sunset: dates.map((d) => `${d}T19:45`),
      tmax: dates.map(() => 30), tmin: dates.map(() => 20),
      precipSum: daily.precipSum ?? dates.map(() => 0),
      code: dates.map(() => 0),
    },
  };
}

const bundle = (points, extra = {}) => ({ fetchedAt: Date.now(), points, ring: [], dust: null, todayIndex: TODAY, ...extra });
const ids = (day) => day.warnings.map((w) => `${w.id}:${w.level}`);
const has = (day, id, level) => day.warnings.some((w) => w.id === id && (!level || w.level === level));
const wear = (day) => day.clothing.map((c) => c.id);

// ── Heat load against the IMS / IDF table ────────────────────────────────────
console.log('heat load');
check('25°C, 40% → none', heatLoad(25, 40).level === 0, heatLoad(25, 40));
check('32°C, 40% → moderate or worse', heatLoad(32, 40).level >= 2, heatLoad(32, 40));
check('38°C, 25% (dry desert) → heavy or worse', heatLoad(38, 25).level >= 4, heatLoad(38, 25));
check('33°C, 70% (humid coast) → heavy or worse', heatLoad(33, 70).level >= 4, heatLoad(33, 70));
check('10°C, 90% → none', heatLoad(10, 90).level === 0, heatLoad(10, 90));

// ── Hiking time and effort ───────────────────────────────────────────────────
console.log('effort');
const flat = estimateHike(8, 0, 0);
check('8 km flat → about 2¼ hours with breaks', flat.totalHours >= 2 && flat.totalHours <= 2.5, flat);
check('8 km flat → easy', flat.level === 'easy', flat.level);
const steep = estimateHike(12, 900, 900);
check('12 km + 900 m → 5–6 hours', steep.totalHours >= 5 && steep.totalHours <= 6.25, steep);
check('12 km + 900 m → hard (21 equivalent km)', steep.level === 'hard', steep.level);

// ── Water ────────────────────────────────────────────────────────────────────
console.log('water');
check('2 h cool winter day → 1.5 L (the floor)', waterFor(2, 0, false).liters === 1.5, waterFor(2, 0, false));
check('winter reserve is half a litre', waterFor(2, 0, false).reserve === 0.5, waterFor(2, 0, false));
check('summer reserve is a full litre', waterFor(2, 0, true).reserve === 1, waterFor(2, 0, true));
check('4 h mild summer day → 4×0.5 + 1 = 3 L', waterFor(4, 1, true).liters === 3, waterFor(4, 1, true));
check('5 h heavy heat → 5 + 1 = 6 L', waterFor(5, 4, true).liters === 6, waterFor(5, 4, true));
check('real heat in winter still gets the full litre', waterFor(5, 4, false).reserve === 1, waterFor(5, 4, false));
check('3 h moderate heat → at least 3 L', waterFor(3, 2, false).liters >= 3, waterFor(3, 2, false));
check('5 h heavy heat → electrolytes', waterFor(5, 4, true).electrolytes, waterFor(5, 4, true));
check('2 h cool day → no electrolytes', !waterFor(2, 0, false).electrolytes, waterFor(2, 0, false));

// ── A hot Judean Desert day ──────────────────────────────────────────────────
console.log('hot day, Judean Desert, 5 hours');
{
  const hot = bundle([point('start', 0, (d, h) => ({ temp: 29 + Math.max(0, h - 6) * 1.8, feels: 31 + Math.max(0, h - 6) * 1.8, rh: 20, uv: h >= 8 && h <= 16 ? 10 : 1 }))]);
  const day = adviseDay(hot, TODAY, TODAY, { kind: 'hike', hours: 5, isDesert: true });
  check('starts at 07:00 in July', day.startHour === 7, day.startHour);
  check('heat warning is a danger', has(day, 'heat', 'danger'), ids(day));
  check('at least 1 L an hour', day.water.liters >= 5.5, day.water);
  check('electrolytes', day.water.electrolytes, day.water);
  check('hat, sunscreen, sun sleeves', ['hat', 'sunscreen', 'sleeves'].every((c) => wear(day).includes(c)), wear(day));
  check('no rain gear', !wear(day).includes('rain'), wear(day));
  check('no flood warning on a dry day', !has(day, 'flood'), ids(day));
  check('offers an earlier start', day.suggestedStart != null && day.suggestedStart < 7, day.suggestedStart);
  check('rated a bad day', day.rating === 'bad', day.rating);
  check('whole day in four blocks, 07–20', day.blocks.length === 4 && day.blocks[0].from === 7 && day.blocks[3].to === 20, day.blocks.map((b) => `${b.from}-${b.to}`));
  check('07:00–12:00 walk covers the first two blocks', day.blocks.filter((b) => b.inWalk).length === 2, day.blocks.map((b) => b.inWalk));

  const late = adviseDay(hot, TODAY, TODAY, { kind: 'hike', hours: 5, isDesert: true, startHour: 11 });
  check('start chosen at 11:00 is used', late.startHour === 11 && late.startChosen && late.defaultStart === 7, late);
  check('leaving at 11 is hotter than at 7', late.summary.tMax > day.summary.tMax, [late.summary.tMax, day.summary.tMax]);
  check('leaving at 11 needs at least as much water', late.water.liters >= day.water.liters, [late.water, day.water]);
  const sunny = adviseDay(bundle([point('start', 800, () => ({ temp: 24, feels: 25, rh: 30, uv: 8 }))]), TODAY, TODAY, { kind: 'hike', hours: 7, isDesert: true });
  check('strong sun, no heat load: one step more water (0.5 L/h, not 0.4)', sunny.summary.heat.level === 0 && sunny.water.perHour === 0.5, sunny.water);
  check('leaving at 11 still suggests an earlier start', late.suggestedStart != null && late.suggestedStart < 11, late.suggestedStart);
}

// ── A cold, wet, windy day on Meron ──────────────────────────────────────────
console.log('cold wet day, Meron, 4 hours, after a rainy week');
{
  const wet = bundle([
    point('start', 700, () => ({ temp: 9, feels: 5, rh: 90, pop: 80, precip: 1.2, code: 63, cloud: 100, wind: 30, gust: 50, uv: 1 }), DATES, { precipSum: [8, 12, 9, 20, 5] }),
    point('high', 1150, () => ({ temp: 6, feels: 1, rh: 95, pop: 85, precip: 1.5, code: 63, cloud: 100, wind: 40, gust: 55, uv: 1 })),
  ]);
  const day = adviseDay(wet, TODAY, TODAY, { kind: 'hike', hours: 4, isDesert: false });
  check('rain warning', has(day, 'rain'), ids(day));
  check('mud warning', has(day, 'mud'), ids(day));
  check('gust warning', has(day, 'wind'), ids(day));
  check('reads the cold at the top (feels 1°)', day.summary.feelsMin === 1, day.summary);
  check('reports the top separately', day.summary.high?.ele === 1150, day.summary.high);
  check('warm layer, rain coat, boots, windbreaker', ['warm', 'rain', 'boots', 'windbreaker'].every((c) => wear(day).includes(c)), wear(day));
  check('no heat warning', !has(day, 'heat'), ids(day));
  check('water stays low (4×0.4 + 1 → 3 L)', day.water.liters <= 3, day.water);
  check('no hat when there is no sun', !wear(day).includes('hat'), wear(day));
}

// ── Snow on the Hermon ───────────────────────────────────────────────────────
console.log('snow, Hermon');
{
  const snow = bundle([point('start', 2000, () => ({ temp: -3, feels: -9, rh: 90, code: 73, pop: 90, precip: 0.8, gust: 40, uv: 2 }))]);
  const day = adviseDay(snow, TODAY, TODAY, { kind: 'hike', hours: 3, isDesert: false });
  check('snow is a danger', has(day, 'snow', 'danger'), ids(day));
  check('warm layer', wear(day).includes('warm'), wear(day));
}

// ── Rain upstream of a dry Negev wadi ────────────────────────────────────────
console.log('dry at the trail, rain upstream, Negev');
{
  const dry = point('start', 300, () => ({ temp: 22, feels: 22, rh: 40 }));
  const ring = [{ lat: 30.8, lon: 34.9, date: DATES, precipSum: [0, 0, 18, 6, 0] }];
  const day = adviseDay(bundle([dry], { ring }), TODAY, TODAY, { kind: 'hike', hours: 4, isDesert: true });
  check('flood is a danger although the trail is dry', has(day, 'flood', 'danger'), ids(day));
  const next = adviseDay(bundle([dry], { ring }), TODAY + 1, TODAY, { kind: 'hike', hours: 4, isDesert: true });
  check('the day after is still flagged (yesterday\'s rain)', has(next, 'flood'), ids(next));
  const north = adviseDay(bundle([dry], { ring }), TODAY, TODAY, { kind: 'hike', hours: 4, isDesert: false });
  check('outside the desert, no flood warning', !has(north, 'flood'), ids(north));
}

// ── Finishing in the dark, dust, thunderstorm ────────────────────────────────
console.log('dark, dust, storm');
{
  const b = bundle([point('start', 300, () => ({ temp: 20, feels: 20 }))]);
  const long = adviseDay(b, TODAY, TODAY, { kind: 'hike', hours: 13, isDesert: false });
  check('13 hours from 07:00 ends after a 19:45 sunset', has(long, 'dark', 'danger'), ids(long));
  check('headlamp', wear(long).includes('headlamp'), wear(long));

  const dusty = bundle([point('start', 300, () => ({}))], {
    dust: { time: DATES.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`)), pm10: Array(120).fill(400), dust: Array(120).fill(300) },
  });
  check('heavy dust is a danger', has(adviseDay(dusty, TODAY, TODAY, { kind: 'hike', hours: 3, isDesert: false }), 'dust', 'danger'), null);

  const storm = bundle([point('start', 300, (d, h) => ({ code: h === 12 ? 95 : 2, pop: 50, cape: 1200 }))]);
  check('thunderstorm is a danger', has(adviseDay(storm, TODAY, TODAY, { kind: 'hike', hours: 6, isDesert: false }), 'storm', 'danger'), null);

  const drive = adviseDay(b, TODAY, TODAY, { kind: 'drive', hours: 2, isDesert: false });
  check('a drive gets no water or clothing', drive.water === null && drive.clothing.length === 0, drive);
}

// ── Weather points and the week ──────────────────────────────────────────────
console.log('points and week');
{
  const judean = [[31.46, 35.38, -300], [31.47, 35.37, 150], [31.48, 35.36, -200]];
  const pts = weatherPointsFor(judean, true);
  check('Judean Desert: start + high + 6 ring points', pts.length === 8 && pts[1].role === 'high', pts.map((p) => p.role));
  const meron = [[32.99, 35.41, 700], [33.0, 35.41, 1000], [32.99, 35.40, 750]];
  check('Meron: start only (300 m rise, no ring)', weatherPointsFor(meron, true).length === 1, weatherPointsFor(meron, true));
  check('Tel Aviv is not desert', !isDesertArea(32.08, 34.78), null);
  check('Mitzpe Ramon is desert', isDesertArea(30.61, 34.8), null);
  check('Ein Gedi is desert', isDesertArea(31.46, 35.39), null);
  const wk = adviseWeek(bundle([point('start', 0, () => ({}))]), TODAY, { kind: 'hike', hours: 3, isDesert: false });
  check('week stops where the forecast stops', wk.length === DATES.length - TODAY, wk.length);
  check('today is day 0, reliable', wk[0].daysAhead === 0 && wk[0].reliability === 'high', wk[0]);
}

// ── Live ─────────────────────────────────────────────────────────────────────
if (process.argv.includes('--live')) {
  const HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,uv_index,visibility,cape';
  const DAILY = 'sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code';
  const trails = [
    { name: 'נחל דוד (עין גדי)', coords: [[31.466, 35.389, -330], [31.47, 35.38, -100], [31.468, 35.385, -250]], km: 4, gain: 300, loss: 300 },
    { name: 'הר מירון', coords: [[32.996, 35.407, 750], [33.0, 35.41, 1150], [32.995, 35.405, 780]], km: 9, gain: 450, loss: 450 },
    { name: 'מכתש רמון', coords: [[30.61, 34.8, 850], [30.58, 34.83, 500], [30.55, 34.86, 450]], km: 14, gain: 250, loss: 650 },
  ];
  for (const t of trails) {
    const pts = weatherPointsFor(t.coords, true);
    const main = pts.filter((p) => p.role !== 'ring');
    const ring = pts.filter((p) => p.role === 'ring');
    const q = (ps, extra) => new URLSearchParams({
      latitude: ps.map((p) => p.lat.toFixed(4)).join(','),
      longitude: ps.map((p) => p.lon.toFixed(4)).join(','),
      timezone: 'auto', past_days: String(PAST_DAYS), forecast_days: String(PICKABLE_DAYS + 1), ...extra,
    });
    const mainRaw = await (await fetch(`https://api.open-meteo.com/v1/forecast?${q(main, { elevation: main.map((p) => p.ele ?? 'nan').join(','), hourly: HOURLY, daily: DAILY })}`)).json();
    const ringRaw = ring.length ? await (await fetch(`https://api.open-meteo.com/v1/forecast?${q(ring, { daily: 'precipitation_sum' })}`)).json() : [];
    const dustRaw = await (await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${main[0].lat}&longitude=${main[0].lon}&hourly=pm10,dust&timezone=auto&forecast_days=7`)).json();
    const b = {
      fetchedAt: Date.now(),
      points: (Array.isArray(mainRaw) ? mainRaw : [mainRaw]).map((r, i) => parsePointForecast(r, main[i].role)),
      ring: (Array.isArray(ringRaw) ? ringRaw : [ringRaw]).filter(Boolean).map(parseRingRain),
      dust: parseDust(dustRaw),
      todayIndex: PAST_DAYS,
    };
    const e = estimateHike(t.km, t.gain, t.loss);
    const week = adviseWeek(b, findTodayIndex(b), { kind: 'hike', hours: e.totalHours, isDesert: isDesertArea(t.coords[1][0], t.coords[1][1]) });
    console.log(`\n${t.name} — ${e.totalHours} h, ${e.levelLabel}`);
    for (const d of week) {
      const s = d.summary;
      console.log(`  ${d.date} ${d.rating.padEnd(4)} ${s.tMin}–${s.tMax}° feels ${s.feelsMin}–${s.feelsMax}° rain ${s.popMax}% gust ${s.gustMax} ${s.heat.label} pm10 ${s.pm10Max}` +
        ` | ${d.water.liters} L | ${d.clothing.map((c) => c.label).join(', ')}`);
      for (const w of d.warnings) console.log(`      ${w.level}: ${w.text}`);
    }
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
