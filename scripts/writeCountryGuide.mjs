// Writes "אזורי טיול" from this Mac: a model searches the web and writes a
// country's hiking regions and their best-known trails; the sources are
// checked and the regions put on the map (src/lib/countryGuide/build.ts).
//
// Through the owner's subscriptions — no per-call cost, only the plans'
// usage allowance (src/lib/countryGuide/subscription.ts):
//
//   node scripts/writeCountryGuide.mjs IT                       Claude Code, Sonnet
//   node scripts/writeCountryGuide.mjs IT --via codex           Codex, gpt-5.6-terra
//   node scripts/writeCountryGuide.mjs --queue                  every country not yet written,
//   node scripts/writeCountryGuide.mjs --queue --via codex      in the owner's order (countryGroups.mjs)
//
// Two --queue runs (one per --via) can work side by side: each takes the
// next country nobody has taken. A run stops at the first failure that looks
// like the plan's limit; run it again later and it carries on from there.
//
// After a change to how regions are drawn (place.ts) or the text is cleaned,
// without asking a model again:  node scripts/writeCountryGuide.mjs --reshape
// Each trail is tied to its marked route as the guide is written; to tie the
// trails of guides already written again (link.ts):  … --link [<CC>…]
//
// Or through the paid APIs (--via api --model claude-opus-5-5 | gpt-5.6-sol…),
// about $0.5–1 a country, logged in ai_usage under "אזורי טיול".
//
// The guide goes to public/country-guides/<CC>.json (listed in index.json),
// which ships with the next deploy. --try writes docs/country-guides/<CC>.<model>.json
// with a report instead, for comparing models.

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, rmSync, appendFileSync } from 'node:fs';
import { GROUPS } from './countryGroups.mjs';

const MODELS = { 'claude-code': 'sonnet', codex: 'gpt-5.6-terra', api: 'claude-opus-5-5' };

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const via = flag('--via') ?? 'claude-code';
const model = flag('--model') ?? MODELS[via];
const effort = flag('--effort') ?? 'medium';
const tryOnly = args.includes('--try');
const queue = args.includes('--queue');
const reshape = args.includes('--reshape');
const relink = args.includes('--link');
const named = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
if (!MODELS[via] || (!queue && !reshape && !relink && !named.length) || named.some((c) => !/^[A-Z]{2}$/.test(c))) {
  console.error('usage: node scripts/writeCountryGuide.mjs <CC>… | --queue  [--via claude-code|codex|api] [--model <id>] [--effort low|medium|high] [--try]');
  process.exit(1);
}

const { withAiArea } = await import('../src/lib/aiUsage.ts');
const { buildCountryGuide } = await import('../src/lib/countryGuide/build.ts');
const { GUIDE_VERSION } = await import('../src/lib/countryGuide/types.ts');

const APP_DIR = 'public/country-guides';

if (relink) {
  const { linkRegions } = await import('../src/lib/countryGuide/build.ts');
  const { countries } = JSON.parse(readFileSync(`${APP_DIR}/index.json`, 'utf8'));
  for (const c of named.length ? named : countries) {
    const file = `${APP_DIR}/${c}.json`;
    const guide = JSON.parse(readFileSync(file, 'utf8'));
    const links = await linkRegions(guide.regions);
    for (const l of links) console.log(`${c} ${l.trail} → ${l.route ?? '—'}`);
    writeFileSync(file, JSON.stringify(guide));
  }
  process.exit(0);
}

if (reshape) {
  const { chooseShape } = await import('../src/lib/countryGuide/place.ts');
  const { stripRefs } = await import('../src/lib/countryGuide/sources.ts');
  const { countries } = JSON.parse(readFileSync(`${APP_DIR}/index.json`, 'utf8'));
  for (const c of named.length ? named : countries) {
    const file = `${APP_DIR}/${c}.json`;
    const guide = JSON.parse(readFileSync(file, 'utf8'));
    guide.intro = stripRefs(guide.intro);
    guide.closing = stripRefs(guide.closing);
    for (const r of guide.regions) {
      r.body = stripRefs(r.body);
      for (const t of r.trails) t.body = stripRefs(t.body);
      const before = r.shape?.kind ?? 'none';
      r.shape = chooseShape(r.shape?.kind === 'units' ? r.shape : null, r.places);
      if ((r.shape?.kind ?? 'none') !== before) console.log(`${c} ${r.name}: ${before} → ${r.shape?.kind ?? 'none'}`);
    }
    writeFileSync(file, JSON.stringify(guide));
  }
  process.exit(0);
}
const TRY_DIR = 'docs/country-guides';
// Which run is writing which country, so two runs never take the same one.
const CLAIMS = `${TRY_DIR}/.claims`;
const LOG = `${TRY_DIR}/runs.log`;
mkdirSync(CLAIMS, { recursive: true });

function written(country) {
  return existsSync(`${APP_DIR}/${country}.json`);
}

function claim(country) {
  try {
    closeSync(openSync(`${CLAIMS}/${country}`, 'wx'));
    return true;
  } catch {
    return false;
  }
}

function release(country) {
  rmSync(`${CLAIMS}/${country}`, { force: true });
}

// A country that failed for another reason is not tried again in this run.
const failed = new Set();

function nextCountry() {
  for (const c of Object.values(GROUPS).flat()) if (!written(c) && !failed.has(c) && claim(c)) return c;
  return null;
}

// "Usage limit", "rate limit", "quota", "try again at…": the plan's allowance
// is spent — no point asking for the next country.
const LIMIT = /usage limit|rate.?limit|quota|limit reached|try again (at|in)|out of (credits|usage)|429/i;

function save(country, guide, report, raw) {
  if (tryOnly) {
    const base = `${TRY_DIR}/${country}.${model}`;
    writeFileSync(`${base}.json`, JSON.stringify(guide, null, 1));
    writeFileSync(`${base}.report.json`, JSON.stringify(report, null, 1));
    writeFileSync(`${base}.raw.txt`, raw);
    return `${base}.json`;
  }
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(`${APP_DIR}/${country}.json`, JSON.stringify(guide));
  // Re-read just before writing: the other run may have added a country.
  const indexFile = `${APP_DIR}/index.json`;
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { version: GUIDE_VERSION, countries: [] };
  index.version = GUIDE_VERSION;
  index.countries = [...new Set([...index.countries, country])].sort();
  writeFileSync(indexFile, JSON.stringify(index));
  return `${APP_DIR}/${country}.json`;
}

async function one(country) {
  const started = new Date();
  console.log(`${country}: writing via ${via} (${model}, effort ${effort})…`);
  const { guide, report, raw } = await withAiArea('country_guide', () => buildCountryGuide(country, { via, model, effort }));
  const w = report.writer;
  const s = report.sources;
  const lines = [
    `${w.seconds}s, ${w.searches} searches, ${w.inputTokens} in / ${w.outputTokens} out tokens` +
      (w.costUsd != null ? `, ~$${w.costUsd.toFixed(2)}` : '') +
      (w.apiEquivalentUsd != null ? `, API equivalent ~$${w.apiEquivalentUsd.toFixed(2)}` : ''),
    `${guide.regions.length} regions, ${guide.regions.reduce((n, r) => n + r.trails.length, 0)} trails, ${report.words} words, ` +
      `${guide.sources.length} sources kept of ${s.cited}` +
      (s.notSearched.length ? `, ${s.notSearched.length} not from the search` : '') +
      (s.dead.length ? `, ${s.dead.length} dead` : '') +
      (s.mismatched.length ? `, ${s.mismatched.length} about something else` : ''),
    `linked to a marked route: ${report.links.filter((l) => l.route).length} of ${report.links.length} trails`,
    ...report.map.filter((m) => m.shape === 'none' || m.missing.length || m.strays.length).map((m) =>
      `map ${m.region}: ${m.shape}${m.missing.length ? `, not found: ${m.missing.join(', ')}` : ''}${m.strays.length ? `, too far: ${m.strays.join(', ')}` : ''}`),
    `→ ${save(country, guide, report, raw)}`,
  ];
  for (const l of lines) console.log(`  ${l}`);
  appendFileSync(LOG, `${started.toISOString()} ${country} ${via} ${model} ok ${w.seconds}s ${w.inputTokens}/${w.outputTokens}` +
    `${w.apiEquivalentUsd != null ? ` api$${w.apiEquivalentUsd.toFixed(2)}` : ''}\n`);
}

const list = queue ? null : [...named];
for (;;) {
  const country = list ? list.shift() : nextCountry();
  if (!country) break;
  if (list && !claim(country) && !tryOnly) {
    console.log(`${country}: another run is writing it — skipped`);
    continue;
  }
  try {
    await one(country);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ${country} failed: ${msg.slice(0, 600)}`);
    appendFileSync(LOG, `${new Date().toISOString()} ${country} ${via} ${model} FAILED ${msg.slice(0, 200).replace(/\n/g, ' ')}\n`);
    process.exitCode = 1;
    failed.add(country);
    if (LIMIT.test(msg)) {
      console.error('  The plan\'s usage limit looks reached. Run again later; it carries on from here.');
      break;
    }
  } finally {
    release(country);
  }
}
