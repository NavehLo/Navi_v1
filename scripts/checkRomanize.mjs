// Checks the Latin spelling of trail names (src/lib/romanize.ts) against
// names written by hand. Run after changing a table: node scripts/checkRomanize.mjs
import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const { romanize } = await import('../src/lib/romanize.ts');

const CASES = [
  ['войвода - х.Марица - х.Заврачиц', 'BG', 'voyvoda - h.Maritsa - h.Zavrachits'],
  ['войвода - х.Марица - х.Заврачиц', null, 'voyvoda - kh.Maritsa - kh.Zavrachits'],
  ['Път към връх Мусала', 'BG', 'Pat kam vrah Musala'],
  ['Път към връх Мусала', null, 'Pat kam vrah Musala'],
  ['Еко пътека Щъркелово гнездо', 'BG', 'Eko pateka Shtarkelovo gnezdo'],
  ['София', 'BG', 'Sofia'],
  ['ЩИТ', 'BG', 'SHTIT'],
  ['Тропа здоровья', 'RU', 'Tropa zdorovya'],
  ['Эльбрус', null, 'Elbrus'],
  ['Кругова стежка Говерла', 'UA', 'Kruhova stezhka Hoverla'],
  ['Пешачка стаза Ђердап', null, 'Pešačka staza Đerdap'],
  ['Патека Шар Планина Ќафа', null, 'Pateka Shar Planina Kjafa'],
  ['2A - Αγία Μαρίνα – Δανακός', 'GR', '2A - Agia Marina – Danakos'],
  ['Ευρωπαϊκό Μονοπάτι Ε4 – Αυλώνας', 'GR', 'Evropaiko Monopati E4 – Avlonas'],
  ['Φαράγγι Σαμαριάς', 'GR', 'Farangi Samarias'],
  ['Μπάλος', 'GR', 'Balos'],
  ['ყაზბეგი - გერგეტი', 'GE', 'Qazbegi - Gergeti'],
  ['Երևան - Գառնի', 'AM', 'Yerevan - Garni'],
  ['Ոսկեվազ', 'AM', 'Voskevaz'],
  ['熊野古道', 'JP', null],
  ['Rundweg', 'DE', null],
];

let failed = 0;
for (const [name, country, want] of CASES) {
  const got = romanize(name, country);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${country ?? '?'}) → ${got}${ok ? '' : `   expected: ${want}`}`);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
