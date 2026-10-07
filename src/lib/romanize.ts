// Trail names in Latin letters, by rule — free, instant and the same on every
// device. "войвода - х.Марица" reads "voyvoda - h.Maritsa": the original stays
// the trail's name and this is shown beside it, so the reader can say it, find
// it on a sign and look it up.
//
// Only alphabets with a standard letter-by-letter romanization: Cyrillic (each
// country's own official system), Greek (ELOT 743), Georgian (the national
// system) and Armenian. Scripts that do not spell their sounds letter by
// letter (Chinese, Japanese, Arabic, Thai…) return null and keep relying on
// OSM's English name or the model's translation (trailTranslate.ts).
//
// A rule cannot translate: "х." stays "h." and does not become "hut". Where
// OSM or the model gave an English name, that one is shown instead
// (latinName in trailNames.ts).

type Table = Record<string, string>;

// ── Cyrillic ─────────────────────────────────────────────────────────────────

const CYR_BASE: Table = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya', ё: 'yo',
  // Kazakh, Kyrgyz, Mongolian, Tajik
  ә: 'a', ғ: 'gh', қ: 'q', ң: 'ng', ө: 'o', ү: 'u', ұ: 'u', һ: 'h', і: 'i', ӣ: 'i', ӯ: 'u', ҷ: 'j', ҳ: 'h', ӊ: 'ng',
};

// Bulgaria's official system (the 2009 transliteration law): what its road and
// mountain-hut signs use.
const CYR_BG: Table = { ...CYR_BASE, х: 'h', щ: 'sht', ъ: 'a', ь: 'y', ѝ: 'i' };
// Ukraine's official system (2010).
const CYR_UK: Table = { ...CYR_BASE, г: 'h', ґ: 'g', и: 'y', і: 'i', ї: 'yi', є: 'ye', ь: '', "'": '', 'ʼ': '' };
const CYR_BE: Table = { ...CYR_BASE, г: 'h', і: 'i', ў: 'w', ь: '' };
// Serbia, Montenegro and Bosnia have their own Latin alphabet (Gaj's), used on
// signs beside the Cyrillic.
const CYR_SR: Table = {
  ...CYR_BASE, ђ: 'đ', ж: 'ž', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'ć', х: 'h', ц: 'c', ч: 'č', џ: 'dž', ш: 'š',
};
const CYR_MK: Table = {
  ...CYR_BASE, ѓ: 'gj', ѕ: 'dz', ј: 'j', љ: 'lj', њ: 'nj', ќ: 'kj', х: 'h', ц: 'c', џ: 'dzh',
};

const CYR_BY_COUNTRY: Record<string, Table> = {
  BG: CYR_BG, UA: CYR_UK, BY: CYR_BE, RS: CYR_SR, ME: CYR_SR, BA: CYR_SR, XK: CYR_SR, MK: CYR_MK,
};

// Without the country, the letters only one language has decide; Bulgarian
// is told by a ъ inside a word (in Russian it is rare and only before a
// vowel). Otherwise Russian, the most widespread.
function cyrillicTable(text: string, country?: string | null): Table {
  const byCountry = country ? CYR_BY_COUNTRY[country.toUpperCase()] : undefined;
  if (byCountry) return byCountry;
  const t = text.toLowerCase();
  if (/[ѓќѕ]/.test(t)) return CYR_MK;
  if (/[ђћџљњј]/.test(t)) return CYR_SR;
  if (/[ґєї]/.test(t)) return CYR_UK;
  if (/ў/.test(t)) return CYR_BE;
  if (/[ыэё]/.test(t)) return CYR_BASE;
  if (/ѝ|ъ[^аеёиоуыэюя\s]|[^\s]ъ\b/.test(t)) return CYR_BG;
  return CYR_BASE;
}

// ── Greek (ELOT 743) ─────────────────────────────────────────────────────────

const GREEK: Table = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};
const GREEK_PAIRS: Table = { αι: 'ai', ει: 'ei', οι: 'oi', ου: 'ou', γγ: 'ng', γξ: 'nx', γχ: 'nch' };
const GREEK_VOICELESS = /[θκξπστφχψ]/;
const GREEK_LETTER = /[α-ωϊϋ]/;

function greek(text: string): string {
  // Accents off; a diaeresis stays, since it parts a pair ("Μαΐου": ma-i-ou).
  const s = text.normalize('NFD').replace(/[́̀͂]/g, '').normalize('NFC');
  let out = '';
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    const lo = ch.toLowerCase();
    const next = (s[i + 1] ?? '').toLowerCase();
    const prev = (s[i - 1] ?? '').toLowerCase();
    const atStart = !GREEK_LETTER.test(prev);
    const pair = lo + next;
    let latin: string | null = null;
    let used = 1;
    if (GREEK_PAIRS[pair]) {
      latin = GREEK_PAIRS[pair]; used = 2;
    } else if (pair === 'αυ' || pair === 'ευ' || pair === 'ηυ') {
      const after = (s[i + 2] ?? '').toLowerCase();
      const f = !after || !GREEK_LETTER.test(after) || GREEK_VOICELESS.test(after);
      latin = GREEK[lo] + (f ? 'f' : 'v'); used = 2;
    } else if (pair === 'μπ' && atStart) {
      latin = 'b'; used = 2;
    } else if (pair === 'ντ' && atStart) {
      latin = 'd'; used = 2;
    } else if (lo === 'ϊ' || lo === 'ΐ') {
      latin = 'i';
    } else if (lo === 'ϋ' || lo === 'ΰ') {
      latin = 'y';
    } else if (GREEK[lo]) {
      latin = GREEK[lo];
    }
    if (latin == null) { out += ch; i++; continue; }
    out += cased(latin, s.slice(i, i + used), s[i - 1], s[i + used]);
    i += used;
  }
  return out;
}

// ── Georgian (national system, 2002) ─────────────────────────────────────────
// Without the apostrophes of the ejectives (k', t'…), as on Georgia's signs.
// The script has no capitals; each word gets one.

const GEORGIAN: Table = {
  ა: 'a', ბ: 'b', გ: 'g', დ: 'd', ე: 'e', ვ: 'v', ზ: 'z', თ: 't', ი: 'i', კ: 'k', ლ: 'l', მ: 'm',
  ნ: 'n', ო: 'o', პ: 'p', ჟ: 'zh', რ: 'r', ს: 's', ტ: 't', უ: 'u', ფ: 'p', ქ: 'k', ღ: 'gh', ყ: 'q',
  შ: 'sh', ჩ: 'ch', ც: 'ts', ძ: 'dz', წ: 'ts', ჭ: 'ch', ხ: 'kh', ჯ: 'j', ჰ: 'h',
};

// ── Armenian (BGN/PCGN) ──────────────────────────────────────────────────────

const ARMENIAN: Table = {
  ա: 'a', բ: 'b', գ: 'g', դ: 'd', ե: 'e', զ: 'z', է: 'e', ը: 'y', թ: 't', ժ: 'zh', ի: 'i', լ: 'l',
  խ: 'kh', ծ: 'ts', կ: 'k', հ: 'h', ձ: 'dz', ղ: 'gh', ճ: 'ch', մ: 'm', յ: 'y', ն: 'n', շ: 'sh', ո: 'o',
  չ: 'ch', պ: 'p', ջ: 'j', ռ: 'r', ս: 's', վ: 'v', տ: 't', ր: 'r', ց: 'ts', փ: 'p', ք: 'k', օ: 'o',
  ֆ: 'f', և: 'ev',
};
const ARMENIAN_LETTER = /[Ա-և]/;

function armenian(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    const lo = ch.toLowerCase();
    const next = (text[i + 1] ?? '').toLowerCase();
    const atStart = !ARMENIAN_LETTER.test(text[i - 1] ?? '');
    let latin: string | undefined;
    let used = 1;
    if (lo === 'ո' && next === 'ւ') { latin = 'u'; used = 2; }
    else if (lo === 'ե' && atStart) latin = 'ye';
    else if (lo === 'ո' && atStart) latin = 'vo';
    else latin = ARMENIAN[lo];
    if (latin == null) { out += ch; i++; continue; }
    out += cased(latin, text.slice(i, i + used), text[i - 1], text[i + used]);
    i += used;
  }
  return out;
}

// ── Shared ───────────────────────────────────────────────────────────────────

const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();

// "Щ" → "Sht", but "ЩИТ" → "SHTIT": a capital in a word of capitals stays all
// capitals.
function cased(latin: string, source: string, before: string | undefined, after: string | undefined): string {
  if (!latin || !isUpper(source[0])) return latin;
  if (isUpper(after) || isUpper(before)) return latin.toUpperCase();
  return latin[0].toUpperCase() + latin.slice(1);
}

function byTable(text: string, table: Table): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const latin = table[ch.toLowerCase()];
    out += latin == null ? ch : cased(latin, ch, text[i - 1], text[i + 1]);
  }
  return out;
}

const CYRILLIC = /\p{Script=Cyrillic}/u;
const GREEK_SCRIPT = /\p{Script=Greek}/u;
const GEORGIAN_SCRIPT = /\p{Script=Georgian}/u;
const ARMENIAN_SCRIPT = /\p{Script=Armenian}/u;
const OTHER_LETTER = /(?![\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Georgian}\p{Script=Armenian}])\p{L}/u;

// The name in Latin letters, or null when it holds a script with no rule here
// (or nothing to romanize). `country` (ISO code) picks the Cyrillic system;
// without it the letters decide.
export function romanize(name: string | null | undefined, country?: string | null): string | null {
  if (!name || OTHER_LETTER.test(name)) return null;
  let s = name;
  if (CYRILLIC.test(s)) {
    const table = cyrillicTable(s, country);
    // Bulgarian: "-ия" at a word's end is "-ia" ("София" → "Sofia").
    if (table === CYR_BG) s = s.replace(/и(я)(?![\p{L}])/gu, (_, ya: string) => (ya === 'Я' ? 'IA' : 'ia'));
    s = byTable(s, table);
  }
  if (GREEK_SCRIPT.test(s)) s = greek(s);
  if (GEORGIAN_SCRIPT.test(s)) {
    s = s.replace(/\p{Script=Georgian}+/gu, (w) => {
      const latin = byTable(w, GEORGIAN);
      return latin[0].toUpperCase() + latin.slice(1);
    });
  }
  if (ARMENIAN_SCRIPT.test(s)) s = armenian(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s && s !== name ? s : null;
}
