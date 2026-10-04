// Checks the rules of "מה אומרים מטיילים" (src/lib/trailCrowd/score.ts) on a
// made-up country: the five traffic tiers and their shares, "no information"
// never becoming "few", the minimum for comparing at all, and the weighted
// rating.
//
//   node scripts/checkCrowd.mjs

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const { trafficTiers, ratingOf, crowdSummaries, MIN_SIGNALS } = await import('../src/lib/trailCrowd/score.ts');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const src = (rating, count, site = 'AllTrails') => ({ site, url: 'https://example.com', rating, count });
const row = (id, pageviews, sources = []) => ({ id, pageviews, sources, fetchedAt: '2026-10-01T00:00:00Z' });

// 100 trails with reviews 1..100, and 10 with nothing at all.
const rows = [
  ...Array.from({ length: 100 }, (_, i) => row(i + 1, 0, [src(4, i + 1)])),
  ...Array.from({ length: 10 }, (_, i) => row(1000 + i, 0)),
];
const tiers = trafficTiers(rows);
const count = (t) => [...tiers.values()].filter((x) => x === t).length;
check('10% very many', count('very_high') === 10, String(count('very_high')));
check('20% many', count('high') === 20, String(count('high')));
check('40% average', count('medium') === 40, String(count('medium')));
check('20% few', count('low') === 20, String(count('low')));
check('10% very few', count('very_low') === 10, String(count('very_low')));
check('no signal is unknown, not few', count('unknown') === 10);
check('the most reviewed is very many', tiers.get(100) === 'very_high');
check('the least reviewed is very few', tiers.get(1) === 'very_low');

// Wikipedia alone can lift a trail: few reviews, much read.
const lifted = trafficTiers([...rows.slice(0, 100), row(500, 900_000, [src(4, 1)]), ...rows.slice(100)]);
check('much-read article lifts a trail', ['very_high', 'high'].includes(lifted.get(500)), lifted.get(500));

// Too few trails with any signal to compare.
const few = trafficTiers(Array.from({ length: MIN_SIGNALS - 1 }, (_, i) => row(i + 1, 100 * (i + 1))));
check(`under ${MIN_SIGNALS} trails with a signal: all unknown`, [...few.values()].every((t) => t === 'unknown'));

// Ties share a tier.
const tied = trafficTiers(Array.from({ length: 40 }, (_, i) => row(i + 1, 500)));
check('equal signals share one tier, average', new Set(tied.values()).size === 1 && tied.get(1) === 'medium', [...new Set(tied.values())].join(','));

// Ratings.
const r1 = ratingOf([src(4.8, 300), src(4.0, 100, 'Wikiloc')]);
check('weighted by reviews', r1.rating === 4.6 && r1.count === 400, JSON.stringify(r1));
const r2 = ratingOf([src(5, 3)]);
check('under 5 reviews: no rating', r2.rating === null && r2.count === 3, JSON.stringify(r2));
const r3 = ratingOf([src(null, 500, 'Komoot'), src(4.5, 10)]);
check('a count without a score does not dilute the rating', r3.rating === 4.5 && r3.count === 10, JSON.stringify(r3));

// Komoot's hikers count for traffic, its ratings for the rating.
const k = { site: 'Komoot', url: 'https://www.komoot.com', rating: 4.9, count: 300, hikers: 5000 };
const hik = trafficTiers([...rows.slice(0, 100), row(600, 0, [k])]);
check('hikers count as traffic', hik.get(600) === 'very_high', hik.get(600));
const rk = ratingOf([k]);
check('the rating weighs by ratings, not hikers', rk.rating === 4.9 && rk.count === 300, JSON.stringify(rk));

const s = crowdSummaries(rows).get(1000);
check('summary of a trail with nothing', s.traffic === 'unknown' && s.rating === null && s.ratingCount === 0);

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
