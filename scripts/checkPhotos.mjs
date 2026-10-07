// Checks the rules of "תמונות מהמסלול" (src/lib/trailPhotos/select.ts).
//
//   node scripts/checkPhotos.mjs          the rules, on made-up photos
//   node scripts/checkPhotos.mjs --live   also on real trails, against Commons
//                                         and Panoramax (slow on purpose: a
//                                         few seconds between trails, so
//                                         Commons does not answer 429)
//
// On every trail: at most one photo per part of the trail, never two from one
// shoot, none farther from the line than its source allows, no photographer
// over a third when another's photo of that part was there, and never more
// than 12. Live, it also prints how many parts got a photo.

import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./tsResolve.mjs', import.meta.url);

const sel = await import('../src/lib/trailPhotos/select.ts');
const { segmentCount, thinForPhotos, MAX_PHOTOS } = await import('../src/lib/trailPhotos/types.ts');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Made-up trail: 12 km due east along latitude 32 ──────────────────────────
const KM_LON = 1 / (111.32 * Math.cos(32 * Math.PI / 180));
const coords = Array.from({ length: 121 }, (_, i) => [32, 35 + i * 0.1 * KM_LON]);
const line = sel.makeLine(coords);
check('line length ≈ 12 km', Math.abs(line.lengthKm - 12) < 0.05, line.lengthKm.toFixed(3));
const segments = segmentCount(line.lengthKm);
check('12 km → 8 parts', segments === 8, String(segments));
check('3 km → 4 parts, 40 km → 12', segmentCount(3) === 4 && segmentCount(40) === 12);

const p = sel.project(line, 32 + 0.3 / 110.57, 35 + 5.05 * KM_LON);
check('projection: 300 m off, 5.05 km along', Math.abs(p.offM - 300) < 5 && Math.abs(p.km - 5.05) < 0.01, `${p.offM.toFixed(0)} m, ${p.km.toFixed(2)} km`);

let n = 0;
const photo = (km, offM, extra = {}) => ({
  id: `commons:File:p${n++}.jpg`, source: 'commons',
  lat: 32 + offM / 1000 / 110.57, lon: 35 + km * KM_LON,
  title: `File:Photo ${n}.jpg`, author: `author${n}`, takenAt: null,
  width: 2000, height: 1500, license: 'CC BY-SA 4.0', pageUrl: 'https://commons.wikimedia.org/', thumb: 't', full: 'f',
  mime: 'image/jpeg', categories: [], ...extra,
});

// 40 frames of one shoot at km 1 (one photographer, five minutes), five
// files named alike at km 4, a map, a far-off photo, and one photo at km 10.
const shoot = Array.from({ length: 40 }, (_, i) => photo(1 + i * 0.002, 20, { author: 'Slav4', takenAt: `2014-04-20 16:${String(10 + (i % 5)).padStart(2, '0')}:00` }));
const named = Array.from({ length: 5 }, (_, i) => photo(4 + i * 0.01, 50, { title: `File:Akbara ap 00${i + 1}.JPG` }));
const map = photo(7, 10, { title: 'File:Map of the area.png', mime: 'image/png' });
const far = photo(8.5, 900);
const lone = photo(10, 100);
const all = [...shoot, ...named, map, far, lone];

const placed = sel.placeAll(line, all, segments);
check('photo 900 m off the line is left out', !placed.some((q) => q.c.id === far.id));
const chosen = sel.choose(placed, segments);
const segs = chosen.map((q) => q.seg);
check('one photo per part', new Set(segs).size === segs.length, segs.join(','));
check('the 40-frame shoot gives one photo', chosen.filter((q) => q.c.author === 'Slav4').length === 1);
check('files named alike give one photo', chosen.filter((q) => named.some((x) => x.id === q.c.id)).length === 1);
check('the map is not chosen', !chosen.some((q) => q.c.id === map.id));
check('empty parts stay empty', chosen.length === 3, `${chosen.length} chosen`);
check('in order along the trail', chosen.every((q, i) => i === 0 || chosen[i - 1].km <= q.km));

// One photographer everywhere, another only in part 2: the cap gives part 2
// to the other one.
const everywhere = Array.from({ length: 8 }, (_, s) => photo(s * 1.5 + 0.7, 10, { author: 'Busy', takenAt: `2020-0${(s % 9) + 1}-01 10:00:00` }));
const other = photo(2 * 1.5 + 0.9, 400, { author: 'Other' });
const capped = sel.choose(sel.placeAll(line, [...everywhere, other], segments), segments);
check('no photographer over a third when another is there', capped.some((q) => q.c.author === 'Other'));

// The model's verdicts: a dropped photo is not shown; "same view" across two
// parts keeps one.
const a = photo(1, 30), b = photo(2.5, 30), c = photo(5, 30);
const pl = sel.placeAll(line, [a, b, c], segments);
const verdicts = new Map([
  [a.id, { keep: true, quality: 4 }],
  [b.id, { keep: true, quality: 3, sameAs: a.id }],
  [c.id, { keep: false, quality: 5 }],
]);
const judged = sel.choose(pl, segments, verdicts);
check('a photo the model drops is not shown', !judged.some((q) => q.c.id === c.id));
check('the same view in two parts is shown once', judged.length === 1 && judged[0].c.id === a.id, judged.map((q) => q.c.id).join(','));

check('title stem: counters dropped', sel.titleStem('File:Akbara ap 002.JPG') === 'akbara ap' && sel.titleStem('File:Tre Cimes (145137477).jpeg') === 'tre cimes');
check('title stem: camera names join nothing', sel.titleStem('File:DSC_1234.JPG') === null && sel.titleStem('File:IMG 0042.jpg') === null);

// What the file's name and categories say, when the model is not asked.
const why = (extra) => sel.excludedWhy(photo(1, 0, extra));
check('a species is not a view', why({ title: 'File:Capoeta damascina.jpg' }) === 'a species' && why({ categories: ['Pseudoturritis turrita'] }) === 'a species');
check('…but "Large images" and "Ground moraines" are not species', why({ categories: ['Large images', 'Ground moraines', 'Self-published work'] }) === null);
check('Israel Hiking Map uploads are views, not maps', why({ title: 'File:IHM viewpoint 22.jpeg', categories: ['Israel Hiking Map', 'On OSM'] }) === null);
check('a map, a signpost and an svg are left out', why({ title: 'File:Map of Nahal Amud.jpg' }) && why({ title: 'File:CAI 735 Segnavia.jpg' }) && why({ mime: 'image/svg+xml' }));

const many = Array.from({ length: 5000 }, (_, i) => [32, 35 + i * 0.0001]);
const thin = thinForPhotos(many);
check('the device sends at most 401 points', thin.length <= 401, String(thin.length));
check('…and the same ones every time', JSON.stringify(thin) === JSON.stringify(thinForPhotos(many)));

// ── Real trails ──────────────────────────────────────────────────────────────
if (process.argv.includes('--live')) {
  const { collectTrailPhotos } = await import('../src/lib/trailPhotos/collect.ts');
  const { wmtRouteToCoords } = await import('../src/lib/waymarked.ts');
  const gpx = (file) => [...readFileSync(new URL(`../public/trails/circular/${file}`, import.meta.url), 'utf8')
    .matchAll(/lat="([\d.\-]+)"\s+lon="([\d.\-]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const wmt = async (id) => {
    const res = await fetch(`https://hiking.waymarkedtrails.org/api/v1/details/relation/${id}`, { headers: { 'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)' } });
    return wmtRouteToCoords(await res.json()).coords.map((c) => [c[0], c[1]]);
  };
  const trails = [
    ['נחל כזיב', () => gpx('נחל כזיב_168.gpx'), null],
    ['תל עדולם', () => gpx('חרבת עתרי תל עדולם וחרבת בורגין_226.gpx'), null],
    ['נחל עזגד', () => gpx('נחל עזגד_193.gpx'), null],
    ['גב זרחן', () => gpx('גב זרחן_475.gpx'), null],
    ['Tre Cime', () => wmt(8548051), 8548051],
    ['Laugavegur', () => wmt(1225037), 1225037],
    ['Kazbegi', () => wmt(10534819), 10534819],
    ['Le chemin de Carcès', () => wmt(18094198), 18094198],
  ];
  for (const [name, load, wmtId] of trails) {
    const pts = thinForPhotos(await load());
    const debug = {};
    const t0 = Date.now();
    const result = await collectTrailPhotos(pts, wmtId, debug);
    if (!result) { check(`${name}: searched`, false, 'no answer'); continue; }
    const placedPhotos = result.photos.filter((x) => x.km != null);
    const parts = placedPhotos.map((x) => sel.segmentOf(x.km, result.lengthKm, result.segments));
    const authors = new Map();
    for (const x of placedPhotos) authors.set(x.author, (authors.get(x.author) ?? 0) + 1);
    const top = Math.max(0, ...authors.values());
    check(`${name}: one per part, at most ${MAX_PHOTOS}`, new Set(parts).size === parts.length && result.photos.length <= MAX_PHOTOS);
    check(`${name}: every photo near the line`, placedPhotos.every((x) => {
      const pr = sel.project(sel.makeLine(pts), x.lat, x.lon);
      return pr.offM <= sel.CORRIDOR_M[x.source] + 1;
    }));
    console.log(`      ${result.lengthKm} km · ${new Set(parts).size}/${result.segments} parts with a photo · ` +
      `${result.photos.filter((x) => x.hero).length ? 'with the trail\'s own photo · ' : ''}` +
      `top photographer ${top}/${placedPhotos.length} · ${debug.spots} on Commons, ${debug.inCorridor} near, ` +
      `${debug.asked} asked, ${debug.panoramax} street frames · ${result.checked ? 'model looked' : 'no model'} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    for (const x of result.photos) console.log(`        ${x.km == null ? '  —  ' : String(x.km).padStart(5)} km  ${x.source.padEnd(9)} ${x.author.slice(0, 24).padEnd(24)} ${x.pageUrl.split('/').pop().slice(0, 60)}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
