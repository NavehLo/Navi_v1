// Checks the rules of "מה אומרים מטיילים" (src/lib/trailCrowd/score.ts) on a
// made-up country: the five traffic tiers and their shares, "no information"
// never becoming "few", the minimum for comparing at all, and the weighted
// rating; and the world ranking's popularity score.
//
//   node scripts/checkCrowd.mjs

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const { trafficTiers, ratingOf, crowdSummaries, leadersOf, MIN_SIGNALS, komootOf, popularityScore, byRank } = await import('../src/lib/trailCrowd/score.ts');

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

// The leaders: busiest first, day walks and long paths apart, and only
// trails with hikers counted (not Wikipedia alone).
const lrows = [...rows.slice(0, 100), row(700, 50_000), row(701, 0, [src(4.5, 40)])];
const ls = crowdSummaries(lrows);
const ltrails = lrows.map((r) => ({ id: r.id, multiDay: r.id >= 700, crowd: ls.get(r.id) }));
const { day, long } = leadersOf(ltrails);
check('ten day walks, busiest first', day.length === 10 && day[0].id === 100 && day[9].id === 91, day.map((t) => t.id).join(','));
check('long paths only with hikers counted', long.map((t) => t.id).join(',') === '701', long.map((t) => t.id).join(','));

const s = crowdSummaries(rows).get(1000);
check('summary of a trail with nothing', s.traffic === 'unknown' && s.rating === null && s.ratingCount === 0);

// The world ranking: Komoot only, one score from hikers, ratings and rating.
const kmt = (hikers, count, rating) => ({ site: 'Komoot', url: 'https://www.komoot.com', rating, count, hikers });
const score = (hikers, count, rating) => popularityScore(komootOf([kmt(hikers, count, rating)]));
check('not on Komoot: not ranked', komootOf([src(4.5, 40)]) === null && komootOf([]) === null);
check('Komoot without numbers: not ranked', komootOf([kmt(0, 0, null)]) === null);
check('under 5 ratings: no rating, as on the card', komootOf([kmt(40, 3, 5)]).rating === null && komootOf([kmt(40, 5, 5)]).rating === 5);
check('more hikers, all else equal, score higher', score(5000, 100, 4.7) > score(500, 100, 4.7));
check('more ratings, all else equal, score higher', score(1000, 300, 4.7) > score(1000, 30, 4.7));
check('a better rating, all else equal, scores higher', score(1000, 200, 4.9) > score(1000, 200, 4.5));
check('5.0 from two does not beat 4.8 from 500', score(500, 500, 4.8) > score(500, 2, 5), `${score(500, 2, 5)} vs ${score(500, 500, 4.8)}`);
check('a 5.0 from two counts little more than the usual 4.6', score(500, 2, 5) - score(500, 2, 4.6) <= 1, `${score(500, 2, 5)} vs ${score(500, 2, 4.6)}`);
const extremes = [score(1, 0, null), score(10_000_000, 1_000_000, 5), score(3, 3, 1)];
check('always 0–100', extremes.every((v) => Number.isInteger(v) && v >= 0 && v <= 100), extremes.join(','));
check("Spain's leader scores about 87", Math.abs(score(13587, 1038, 4.9) - 87) <= 1, String(score(13587, 1038, 4.9)));
check('a median trail scores about 49', Math.abs(score(128, 26, 4.7) - 49) <= 1, String(score(128, 26, 4.7)));
const ranked = [[1, 9000, 50, 4.3], [2, 300, 900, 4.6], [3, 50, 40, 5]].map(([id, h, c, r]) => {
  const komoot = komootOf([kmt(h, c, r)]);
  return { id, komoot, score: popularityScore(komoot) };
});
const order = (sort) => [...ranked].sort(byRank(sort)).map((t) => t.id).join(',');
check('by hikers', order('hikers') === '1,2,3', order('hikers'));
check('by ratings', order('ratings') === '2,1,3', order('ratings'));
check('by rating', order('rating') === '3,2,1', order('rating'));

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
