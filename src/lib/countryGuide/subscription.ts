// Writing a country's overview through the owner's subscriptions instead of
// the paid APIs: Claude Code (`claude -p`) and Codex (`codex exec`), both run
// headless on this Mac, both searching the web themselves. Nothing is billed
// per call; what it costs is part of the plan's usage allowance.
//
// Only for scripts/writeCountryGuide.mjs — it starts programs on this Mac.

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Via = 'claude-code' | 'codex';

export interface SubscriptionResult {
  text: string;
  // The pages the search returned; null when the tool does not say (Codex),
  // and the sources are then checked by reading them.
  searchedUrls: string[] | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  // What the same work would have cost through the API (Claude Code reports
  // it) — a yardstick for how much of the plan's allowance it used.
  apiEquivalentUsd: number | null;
  seconds: number;
}

const CODEX_APP = '/Applications/Codex.app/Contents/Resources/codex';

function run(cmd: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${cmd} took longer than ${timeoutMs / 60000} minutes`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
    child.stdin.end(input);
  });
}

// An empty folder to run in, so neither tool reads this project's CLAUDE.md
// or AGENTS.md and takes the overview for a coding task.
function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'navi-guide-'));
}

const URL_IN_JSON = /"url"\s*:\s*"(https?:\/\/[^"\\]+)"/g;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tools' JSONL events
type Json = any;

function jsonLines(out: string): Json[] {
  return out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export async function writeWithClaudeCode(system: string, user: string, model: string, effort: string): Promise<SubscriptionResult> {
  const started = Date.now();
  const out = await run('claude', [
    '-p',
    '--model', model,
    '--effort', effort,
    '--output-format', 'stream-json', '--verbose',
    // Its own system prompt in place of Claude Code's, which is about coding
    // and would add thousands of tokens to every country.
    '--system-prompt', system,
    '--tools', 'WebSearch,WebFetch',
    '--allowedTools', 'WebSearch', 'WebFetch',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ], user, emptyDir(), 25 * 60_000);

  const events = jsonLines(out);
  const urls = new Set<string>();
  let searches = 0;
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name === 'WebSearch') searches++;
      if (c.type === 'tool_use' && c.name === 'WebFetch' && c.input?.url) urls.add(c.input.url);
      if (c.type === 'tool_result') {
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
        for (const m of body.replace(/\\"/g, '"').matchAll(URL_IN_JSON)) urls.add(m[1]);
      }
    }
  }
  const result = events.find((e) => e.type === 'result');
  if (!result || result.is_error) throw new Error(`Claude Code: ${result?.result ?? 'no result'}`);
  const u = result.usage ?? {};
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  return {
    text: result.result ?? '',
    searchedUrls: [...urls],
    model: init?.model ?? model,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    searches,
    apiEquivalentUsd: result.total_cost_usd ?? null,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

export async function writeWithCodex(system: string, user: string, model: string, effort: string): Promise<SubscriptionResult> {
  const started = Date.now();
  const cmd = existsSync(CODEX_APP) ? CODEX_APP : 'codex';
  const out = await run(cmd, [
    '--search',
    'exec', '--json',
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '-s', 'read-only',
    '-',
  ], `${system}\n\n${user}`, emptyDir(), 25 * 60_000);

  const events = jsonLines(out);
  const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
  let text = '';
  let searches = 0;
  for (const e of events) {
    const item = e.item;
    if (e.type !== 'item.completed' || !item) continue;
    if (item.type === 'agent_message') text = item.text ?? text;
    if (item.type === 'web_search') searches++;
  }
  if (!text) throw new Error(`Codex: ${failed?.message ?? failed?.error?.message ?? 'no answer'}`);
  const usage = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage ?? {});
  return {
    text,
    searchedUrls: null,
    model,
    inputTokens: usage.reduce((n, x) => n + (x.input_tokens ?? 0), 0),
    outputTokens: usage.reduce((n, x) => n + (x.output_tokens ?? 0), 0),
    searches,
    apiEquivalentUsd: null,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
