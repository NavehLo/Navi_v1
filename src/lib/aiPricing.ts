// What each AI call costs, roughly — for the admin's usage page, not for
// billing. Prices are list prices in USD, checked on 2026-10-01 against each
// provider's pricing page. The cost is computed when the call is recorded and
// stored with it, so a later price change affects later calls only.
//
// Units: tokens are per 1M, characters per 1K, searches per search.

export type AiProvider = 'openai' | 'gemini' | 'gemini-free' | 'claude' | 'elevenlabs' | 'tavily';

interface TokenPrice {
  input: number;  // USD per 1M input tokens
  output: number; // USD per 1M output tokens (thinking and audio tokens included)
}

// Gemini 3.x Flash doubles on 2027-01-01 (Google's announced price).
const GEMINI_FLASH_2026: TokenPrice = { input: 0.75, output: 3.75 };
const GEMINI_FLASH_2027: TokenPrice = { input: 1.5, output: 7.5 };
const FLASH_PRICE_RISE = Date.UTC(2027, 0, 1);

function tokenPrice(provider: AiProvider, model: string, at: number): TokenPrice | null {
  const m = model.toLowerCase();
  if (provider === 'openai') {
    // Checked 2026-10-06 (developers.openai.com/api/docs/pricing, standard tier).
    if (m.startsWith('gpt-5.6-sol')) return { input: 4, output: 20 };
    if (m.startsWith('gpt-5.6-terra')) return { input: 2, output: 12 };
    if (m.startsWith('gpt-5.6-luna')) return { input: 0.2, output: 1.2 };
    if (m.startsWith('gpt-5.5')) return { input: 5, output: 30 };
    if (m.startsWith('gpt-4.1-mini')) return { input: 0.4, output: 1.6 };
    if (m.startsWith('gpt-4.1-nano')) return { input: 0.1, output: 0.4 };
    if (m.startsWith('gpt-4o-mini-tts')) return { input: 0.6, output: 12 };
    if (m.startsWith('gpt-4o-mini')) return { input: 0.15, output: 0.6 };
    if (m.startsWith('gpt-4.1')) return { input: 2, output: 8 };
    if (m.startsWith('gpt-4o')) return { input: 2.5, output: 10 };
    return null;
  }
  if (provider === 'gemini') {
    if (m.includes('tts')) return { input: 1, output: 20 };
    if (m.includes('flash-lite')) return { input: 0.3, output: 2.5 };
    if (m.includes('flash')) return at >= FLASH_PRICE_RISE ? GEMINI_FLASH_2027 : GEMINI_FLASH_2026;
    return null;
  }
  if (provider === 'claude') {
    // Checked 2026-10-06. The 5.x generation is cheaper than the 4.x one.
    if (m.includes('opus-5-5')) return { input: 4, output: 20 };
    if (m.includes('sonnet-5')) return { input: 2, output: 10 };
    if (m.includes('haiku')) return { input: 1, output: 5 };
    if (m.includes('sonnet')) return { input: 3, output: 15 };
    if (m.includes('opus')) return { input: 5, output: 25 };
    return null;
  }
  return null;
}

// ElevenLabs v3 through the API, any plan.
const ELEVENLABS_PER_1K_CHARS = 0.08;
// OpenAI's speech endpoint reports no usage. gpt-4o-mini-tts comes to about
// $0.015 a minute, and spoken Hebrew runs at roughly 850 characters a minute.
const OPENAI_TTS_PER_1K_CHARS = 0.015 / 0.85;
// Tavily pay-as-you-go; a basic search is one credit. The first 1,000 a month
// are free, so this is the cost once past that allowance.
const TAVILY_PER_SEARCH = 0.008;
// A model's own web search (Claude's web_search tool, OpenAI's web_search
// call): $10 per 1,000 at both, on top of the tokens the results add.
const MODEL_SEARCH = 0.01;

export interface UsageUnits {
  inputTokens?: number;
  outputTokens?: number;
  chars?: number;
  searches?: number;
}

export function estimateCost(provider: AiProvider, model: string, units: UsageUnits, at = Date.now()): number {
  // The free key belongs to a Google project with no billing: nothing is charged.
  if (provider === 'gemini-free') return 0;
  if (provider === 'elevenlabs') return ((units.chars ?? 0) / 1000) * ELEVENLABS_PER_1K_CHARS;
  if (provider === 'tavily') return (units.searches ?? 0) * TAVILY_PER_SEARCH;
  if (provider === 'openai' && model.toLowerCase().includes('tts') && !units.outputTokens) {
    return ((units.chars ?? 0) / 1000) * OPENAI_TTS_PER_1K_CHARS;
  }
  const price = tokenPrice(provider, model, at);
  const searches = (units.searches ?? 0) * MODEL_SEARCH;
  if (!price) return searches;
  return ((units.inputTokens ?? 0) * price.input + (units.outputTokens ?? 0) * price.output) / 1_000_000 + searches;
}
