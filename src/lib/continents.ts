// Which continent a country is on, for the continent filter in "בעולם לפי
// חודש". Central America and the Caribbean go with North America. The Middle
// East is a group of its own (not part of Asia): Israel's neighbours, the
// Gulf, Iran, Egypt and Turkey. A country that straddles two is listed in
// both, so it is found from either side: Russia and the Caucasus in Europe and
// Asia, Turkey in Europe and the Middle East, Egypt in the Middle East and Africa.

export type Continent = 'europe' | 'middle-east' | 'asia' | 'africa' | 'north-america' | 'south-america' | 'oceania';

export const CONTINENTS: { id: Continent; label: string }[] = [
  { id: 'europe', label: 'אירופה' },
  { id: 'middle-east', label: 'המזרח התיכון' },
  { id: 'asia', label: 'אסיה' },
  { id: 'africa', label: 'אפריקה' },
  { id: 'north-america', label: 'צפון ומרכז אמריקה' },
  { id: 'south-america', label: 'דרום אמריקה' },
  { id: 'oceania', label: 'אוקיאניה' },
];

const CODES: Record<Continent, string> = {
  europe:
    'AD AL AM AT AX AZ BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GE GG GI GR HR HU IE IM IS IT JE LI LT LU LV ' +
    'MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA XK',
  'middle-east': 'AE BH EG IL IQ IR JO KW LB OM PS QA SA SY TR YE',
  asia:
    'AF AM AZ BD BN BT CN GE HK ID IN IO JP KG KH KP KR KZ LA LK MM MN MO MV MY NP ' +
    'PH PK RU SG TH TJ TL TM TW UZ VN',
  africa:
    'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ ' +
    'NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW',
  'north-america':
    'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX ' +
    'TC TT US VC VG VI',
  'south-america': 'AR BO BR CL CO EC FK GF GY PE PY SR UY VE',
  oceania: 'AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
};

const byCountry = new Map<string, Continent[]>();
for (const [continent, codes] of Object.entries(CODES) as [Continent, string][]) {
  for (const code of codes.split(' ')) byCountry.set(code, [...(byCountry.get(code) ?? []), continent]);
}

export function continentsOf(code: string): Continent[] {
  return byCountry.get(code.toUpperCase()) ?? [];
}

export function inContinent(code: string, continent: Continent | null): boolean {
  return !continent || continentsOf(code).includes(continent);
}
