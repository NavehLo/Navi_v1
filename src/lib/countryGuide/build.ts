// One country's guide, start to finish: ask the model, check its sources,
// put its regions on the map. Run by the admin's script, never by a visitor.

import { countryUnits } from '../regions';
import { SYSTEM_PROMPT, userPrompt } from './prompt';
import { writeOverview, type WriterOptions } from './write';
import { writeWithClaudeCode, writeWithCodex, type Via } from './subscription';
import { toDraft, checkSources, type SourceReport } from './sources';
import { placeRegion } from './place';
import { linkTrail } from './link';
import { GUIDE_VERSION, type CountryGuide, type GuideRegion } from './types';
import { estimateCost } from '../aiPricing';

export interface BuildOptions extends WriterOptions {
  // 'api' bills per call; the other two run on the owner's subscriptions.
  via: 'api' | Via;
}

export interface BuildReport {
  writer: {
    via: BuildOptions['via']; model: string; inputTokens: number; outputTokens: number; searches: number;
    seconds: number; searchedUrls: number | null; costUsd: number | null; apiEquivalentUsd: number | null;
  };
  sources: SourceReport;
  map: { region: string; shape: string; missing: string[]; strays: string[] }[];
  links: { trail: string; route: string | null }[];
  words: number;
}

function names(code: string, lang: string): string {
  try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

async function write(system: string, user: string, opts: BuildOptions) {
  const effort = opts.effort ?? 'medium';
  if (opts.via === 'claude-code') return { ...(await writeWithClaudeCode(system, user, opts.model, effort)), costUsd: null };
  if (opts.via === 'codex') return { ...(await writeWithCodex(system, user, opts.model, effort)), costUsd: null };
  const w = await writeOverview(system, user, opts);
  return { ...w, costUsd: estimateCost(w.provider, w.model, w), apiEquivalentUsd: null };
}

// Every trail of the guide to its marked route, where one is found.
export async function linkRegions(regions: GuideRegion[]): Promise<BuildReport['links']> {
  const out: BuildReport['links'] = [];
  for (const r of regions) {
    for (const t of r.trails) {
      const { wmt, line } = await linkTrail(t, t.aliases ?? [], r);
      t.wmt = wmt;
      t.line = line;
      out.push({ trail: `${r.name} › ${t.name}`, route: wmt ? `${wmt.name} (${wmt.id})` : null });
    }
  }
  return out;
}

export async function buildCountryGuide(country: string, opts: BuildOptions): Promise<{ guide: CountryGuide; report: BuildReport; raw: string }> {
  const units = countryUnits(country).map((u) => ({ id: u.id, name: u.latin ? `${u.name} (${u.latin})` : u.name }));
  const written = await write(SYSTEM_PROMPT, userPrompt(names(country, 'he'), names(country, 'en'), units), opts);
  const parsed = toDraft(written.text);
  if (!parsed) throw new Error(`the model's answer is not the JSON asked for:\n${written.text.slice(0, 2000)}`);

  const { draft, report: sources } = await checkSources(parsed, written.searchedUrls);
  const known = new Set(units.map((u) => u.id));
  const map: BuildReport['map'] = [];
  const regions: GuideRegion[] = [];
  for (const r of draft.regions) {
    const placed = await placeRegion(country, { ...r, provinces: r.provinces.filter((p) => known.has(p)) });
    map.push({ region: r.name, shape: placed.shape?.kind ?? 'none', missing: placed.missing, strays: placed.strays });
    regions.push({
      name: r.name, nameLatin: r.nameLatin, where: r.where, body: r.body, sources: r.sources,
      trails: r.trails.map((t, i) => ({
        name: t.name, nameLatin: t.nameLatin, aliases: t.aliases, body: t.body, sources: t.sources, start: placed.trailStarts[i],
      })),
      shape: placed.shape,
      places: placed.places,
    });
  }
  const links = await linkRegions(regions);

  const guide: CountryGuide = {
    version: GUIDE_VERSION,
    country,
    intro: draft.intro, introSources: draft.introSources,
    regions,
    closing: draft.closing, closingSources: draft.closingSources,
    sources: draft.sources,
    model: written.model,
    generatedAt: new Date().toISOString(),
  };
  const text = [guide.intro, guide.closing, ...regions.flatMap((r) => [r.body, ...r.trails.map((t) => t.body)])].join(' ');
  const w = written;
  return {
    guide,
    raw: w.text,
    report: {
      writer: {
        via: opts.via, model: w.model, inputTokens: w.inputTokens, outputTokens: w.outputTokens, searches: w.searches,
        seconds: w.seconds, searchedUrls: w.searchedUrls?.length ?? null, costUsd: w.costUsd, apiEquivalentUsd: w.apiEquivalentUsd,
      },
      sources, map, links, words: text.split(/\s+/).filter(Boolean).length,
    },
  };
}
