// What "מה אומרים מטיילים" has collected so far, country by country: how many
// trails, how many with Komoot's numbers, with a rating, and when. Reads only.
//
//   node scripts/crowdStatus.mjs
//
// Needs in .env.local: SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL.

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

const { serviceClient } = await import('../src/lib/supabaseService.ts');
const { CROWD_VERSION, komootOf } = await import('../src/lib/trailCrowd/score.ts');
const { countryEnglish } = await import('../src/lib/trailInfo/sources.ts');
const { GROUPS } = await import('./countryGroups.mjs');

const db = serviceClient();
if (!db) { console.error('no database key in .env.local'); process.exit(1); }

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('trail_crowd').select('country, sources, fetched_at')
    .eq('crowd_version', CROWD_VERSION).order('country').order('trail_id').range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...data);
  if (data.length < 1000) break;
}

const by = new Map();
for (const r of rows) {
  const c = by.get(r.country) ?? { trails: 0, komoot: 0, rated: 0, at: '' };
  c.trails++;
  const k = komootOf(r.sources ?? []);
  if (k) c.komoot++;
  if (k?.rating != null) c.rated++;
  if (r.fetched_at > c.at) c.at = r.fetched_at;
  by.set(r.country, c);
}

const order = Object.values(GROUPS).flat();
const done = [...by.keys()].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
console.log('country              trails  Komoot  rated  collected');
for (const cc of done) {
  const c = by.get(cc);
  console.log(`${cc} ${countryEnglish(cc).slice(0, 16).padEnd(16)} ${String(c.trails).padStart(7)} ${String(c.komoot).padStart(7)} ${String(c.rated).padStart(6)}  ${c.at.slice(0, 10)}`);
}
const total = (k) => [...by.values()].reduce((n, c) => n + c[k], 0);
console.log(`\n${done.length} countries, ${total('komoot')} trails with Komoot's numbers (${total('rated')} rated)`);
const next = order.filter((cc) => !by.has(cc));
console.log(`not yet, in order: ${next.slice(0, 24).join(' ')}${next.length > 24 ? ` … (${next.length} in all)` : ''}`);
process.exit(0);
