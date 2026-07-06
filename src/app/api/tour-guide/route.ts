import { NextResponse } from 'next/server';

// ── POI type → Hebrew description (unknown types pass through for future use) ──
const POI_TYPE_HE: Record<string, string> = {
  start: "נקודת הפתיחה של המסלול",
  midway: "אמצע המסלול",
  end: "נקודת הסיום של המסלול",
};

const SYSTEM_PROMPT =
  "אתה מדריך טיולים ישראלי מנוסה בארץ ישראל. השתמש בוויב חם ומזמין, תהיה קצר וקולע (מקסימום 2-3 משפטים). התייחס לעונת השנה, לפריחה אפשרית, משקעים או היסטוריה הקשורה לקואורדינטות המדויקות המסופקות. התאם את הטון לסוג הנקודה: בנקודת פתיחה — ברכת פתיחה נלהבת; באמצע המסלול — עידוד והפניית תשומת לב לסביבה; בנקודת סיום — סיכום חם ופרידה. הטקסט יוקרא בקול, אז כתוב אותו כדיבור טבעי בלי כותרות או סימנים מיוחדים.";

const TTS_INSTRUCTIONS =
  "דבר בעברית טבעית ורהוטה, בטון חם ומזמין של מדריך טיולים ישראלי מנוסה.";

type Provider = 'openai' | 'gemini' | 'claude';

function availableProviders(): Record<Provider, boolean> {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    claude: !!process.env.ANTHROPIC_API_KEY,
  };
}

// Priority: user's in-app choice → AI_PROVIDER env → first available key.
function pickTextProvider(requested?: string): Provider | null {
  const has = availableProviders();
  const req = requested?.toLowerCase() as Provider | undefined;
  if (req && has[req]) return req;
  const explicit = process.env.AI_PROVIDER?.toLowerCase() as Provider | undefined;
  if (explicit && has[explicit]) return explicit;
  if (has.openai) return 'openai';
  if (has.gemini) return 'gemini';
  if (has.claude) return 'claude';
  return null;
}

// Lets the settings UI show only providers that actually have a key configured.
// Booleans only — no secrets leave the server.
export async function GET() {
  return NextResponse.json({ providers: availableProviders() });
}

// ── Text generation, one function per provider ────────────────────────────────
async function generateTextOpenAI(system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI text error');
  return data.choices[0].message.content;
}

async function generateTextGemini(system: string, user: string): Promise<string> {
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.7 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini text error');
  return data.candidates[0].content.parts.map((p: any) => p.text).join('');
}

async function generateTextClaude(system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude text error');
  return data.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
}

async function generateText(provider: Provider, system: string, user: string): Promise<string> {
  if (provider === 'gemini') return generateTextGemini(system, user);
  if (provider === 'claude') return generateTextClaude(system, user);
  return generateTextOpenAI(system, user);
}

// ── Text-to-speech. Claude has no TTS, so audio always comes from OpenAI or
//    Gemini when their key is present; otherwise null → browser speechSynthesis.
//    When the user picked a provider that has TTS, prefer that provider's voice.
async function generateSpeech(text: string, preferred: Provider): Promise<{ audio: string; format: string } | null> {
  const geminiFirst = preferred === 'gemini' && !!process.env.GEMINI_API_KEY;
  if (geminiFirst) {
    const g = await generateSpeechGemini(text);
    if (g) return g;
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
          voice: process.env.OPENAI_TTS_VOICE || 'nova',
          input: text,
          response_format: 'mp3',
          instructions: TTS_INSTRUCTIONS,
        }),
      });
      if (!res.ok) {
        console.error('OpenAI TTS error:', res.status, await res.text());
        return null;
      }
      return { audio: Buffer.from(await res.arrayBuffer()).toString('base64'), format: 'mp3' };
    } catch (e) {
      console.error('OpenAI TTS failed:', e);
      return null;
    }
  }

  if (!geminiFirst && process.env.GEMINI_API_KEY) {
    return generateSpeechGemini(text);
  }

  return null;
}

async function generateSpeechGemini(text: string): Promise<{ audio: string; format: string } | null> {
  try {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
    const voice = process.env.GEMINI_TTS_VOICE || 'Kore';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
      }
    );
    if (!res.ok) {
      console.error('Gemini TTS error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part) return null;
    // Gemini returns raw PCM (e.g. audio/L16;rate=24000) — wrap in a WAV header
    const rate = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || '24000', 10);
    return { audio: pcmToWav(part.inlineData.data, rate), format: 'wav' };
  } catch (e) {
    console.error('Gemini TTS failed:', e);
    return null;
  }
}

// Wrap 16-bit mono PCM (base64) in a minimal WAV header so browsers can play it.
function pcmToWav(pcmBase64: string, sampleRate: number): string {
  const pcm = Buffer.from(pcmBase64, 'base64');
  const channels = 1, bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

export async function POST(request: Request) {
  try {
    const { lat, lon, month, type, name, provider: requestedProvider } = await request.json();
    const typeDesc = POI_TYPE_HE[type] ?? type ?? 'נקודת עניין';
    const place = name ? `${typeDesc} "${name}"` : typeDesc;
    const provider = pickTextProvider(requestedProvider);

    // No provider key configured → mocked text, no audio (dev/demo mode)
    if (!provider) {
      console.warn('No AI provider key found. Returning mocked response.');
      return NextResponse.json({
        text: `ברוכים הבאים ל${place} בנ"צ ${lat.toFixed(3)}, ${lon.toFixed(3)}. בחודש ${month} הפריחה כאן בשיאה, אפשר לראות כאן כלניות ונוריות. תהנו מהסיור!`,
        audio: null,
        audioFormat: 'mp3',
      });
    }

    const userPrompt = `המטייל נמצא עכשיו ב${place}, בנ.צ: קו רוחב ${lat}, קו אורך ${lon}. חודש נוכחי: ${month}. הקרא מדריך קצר לנקודה זו — אם יש שם למקום, התייחס אליו ולמה שמייחד אותו.`;
    const text = await generateText(provider, SYSTEM_PROMPT, userPrompt);

    // Chain to TTS; audio stays null on failure — text alone is a valid response
    const speech = await generateSpeech(text, provider);

    return NextResponse.json({
      text,
      audio: speech?.audio ?? null,
      audioFormat: speech?.format ?? 'mp3',
    });
  } catch (error: any) {
    console.error('AI Guide Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
