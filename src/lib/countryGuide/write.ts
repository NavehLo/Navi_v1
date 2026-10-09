// Asking a strong model, with its provider's own web search, to write a
// country's overview. Two providers, so the owner can compare them on the
// same country (scripts/writeCountryGuide.mjs --model …):
//
//   claude-…   Anthropic's Messages API, web_search tool (dynamic filtering)
//   gpt-…      OpenAI's Responses API, web_search tool, run in the background
//              and polled — an overview takes minutes, longer than a request
//              may stay open
//
// Both report the URLs the search actually returned, which is what a source in
// the overview is checked against (sources.ts).

import Anthropic from '@anthropic-ai/sdk';
import { recordAiUsage } from '../aiUsage';
import { ensureAllowed } from '../aiLimits';
import type { AiProvider } from '../aiPricing';

export interface WriterResult {
  text: string;
  // null when the provider did not list them (the sources are then read).
  searchedUrls: string[] | null;
  model: string;
  provider: AiProvider;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  seconds: number;
}

export interface WriterOptions {
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSearches?: number;
}

export function providerOf(model: string): AiProvider {
  return model.startsWith('claude') ? 'claude' : 'openai';
}

export async function writeOverview(system: string, user: string, opts: WriterOptions): Promise<WriterResult> {
  const started = Date.now();
  // Run from the admin's machine, so exempt — but the same gate as every call.
  await ensureAllowed(providerOf(opts.model));
  const result = providerOf(opts.model) === 'claude'
    ? await writeWithClaude(system, user, opts)
    : await writeWithOpenAI(system, user, opts);
  const done = { ...result, seconds: Math.round((Date.now() - started) / 1000) };
  await recordAiUsage({
    kind: 'text', provider: done.provider, model: done.model,
    inputTokens: done.inputTokens, outputTokens: done.outputTokens, searches: done.searches,
  });
  return done;
}

async function writeWithClaude(system: string, user: string, opts: WriterOptions): Promise<Omit<WriterResult, 'seconds'>> {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: user }];
  const urls = new Set<string>();
  let inputTokens = 0, outputTokens = 0, searches = 0;
  let model = opts.model;

  // A long search turn may come back paused; it is sent back as it is and
  // carries on where it stopped.
  for (let round = 0; round < 6; round++) {
    const response = await client.beta.messages
      .stream({
        model: opts.model,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: opts.effort ?? 'high' },
        // A refusal is retried on the model the API picks for its category.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: opts.maxSearches ?? 25 }],
      })
      .finalMessage();

    model = response.model;
    const u = response.usage;
    inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    outputTokens += u.output_tokens ?? 0;
    searches += u.server_tool_use?.web_search_requests ?? 0;
    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === 'web_search_result') urls.add(r.url);
      }
    }

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    if (response.stop_reason === 'refusal') throw new Error(`refused (${response.stop_details?.category ?? 'no category'})`);
    if (response.stop_reason === 'max_tokens') throw new Error('the overview was cut off at max_tokens');

    // The answer is the text after the last search; anything before it is
    // the model saying what it will look for.
    let lastTool = -1;
    response.content.forEach((b, i) => { if (b.type !== 'text' && b.type !== 'thinking') lastTool = i; });
    const text = response.content
      .slice(lastTool + 1)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    return { text, searchedUrls: [...urls], model, provider: 'claude', inputTokens, outputTokens, searches };
  }
  throw new Error('still paused after six rounds');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Responses API's JSON, read defensively
type Json = any;

async function openai(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI ${res.status}`);
  return data;
}

async function writeWithOpenAI(system: string, user: string, opts: WriterOptions): Promise<Omit<WriterResult, 'seconds'>> {
  let r: Json = await openai('responses', {
    method: 'POST',
    body: JSON.stringify({
      model: opts.model,
      instructions: system,
      input: user,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      reasoning: { effort: opts.effort === 'max' || opts.effort === 'xhigh' ? 'high' : opts.effort ?? 'high' },
      max_output_tokens: 64000,
      background: true,
      store: true,
    }),
  });
  const deadline = Date.now() + 30 * 60_000;
  while (r.status === 'queued' || r.status === 'in_progress') {
    if (Date.now() > deadline) throw new Error('OpenAI did not finish in 30 minutes');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    r = await openai(`responses/${r.id}`);
  }
  if (r.status !== 'completed') throw new Error(`OpenAI ${r.status}: ${r.error?.message ?? r.incomplete_details?.reason ?? ''}`);

  const urls = new Set<string>();
  let searches = 0;
  let text = '';
  for (const item of r.output ?? []) {
    if (item.type === 'web_search_call') {
      searches++;
      for (const s of item.action?.sources ?? []) if (s?.url) urls.add(s.url);
    }
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type !== 'output_text') continue;
        text += c.text;
        for (const a of c.annotations ?? []) if (a.type === 'url_citation' && a.url) urls.add(a.url);
      }
    }
  }
  return {
    text, searchedUrls: urls.size ? [...urls] : null, model: r.model ?? opts.model, provider: 'openai',
    inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0, searches,
  };
}
