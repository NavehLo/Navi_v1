// The owner's countries abroad, by order of priority — used by every script
// that works through them country by country (collectLandscape.mjs,
// writeCountryGuide.mjs). A new country goes into its group here.
//
// Left out: Russia, Belarus and Ukraine (war), the Arab countries, and Muslim
// countries that Israelis cannot easily visit (Iran, Turkey, Indonesia,
// Malaysia, Pakistan, Central Asia…). Albania, Bosnia and Kosovo are in:
// Israelis walk there freely.
export const GROUPS = {
  europe: [
    'GR', 'ES', 'IT', 'PT', 'MT', 'CH', 'AT', 'FR', 'SI', 'NO', 'GB', 'DE', 'IE', 'IS', 'HR', 'ME',
    'AL', 'BA', 'XK', 'MK', 'RS', 'BG', 'RO', 'PL', 'CZ', 'SK', 'HU', 'SE', 'FI', 'DK', 'NL',
    'BE', 'LU', 'EE', 'LV', 'LT', 'MD', 'CY', 'AD', 'LI', 'SM', 'GE', 'AM',
  ],
  latam: [
    'MX', 'GT', 'BZ', 'SV', 'HN', 'NI', 'CR', 'PA', 'CU', 'DO', 'PR', 'JM',
    'CO', 'EC', 'PE', 'BO', 'CL', 'AR', 'UY', 'PY', 'BR', 'GY', 'SR',
  ],
  asia: ['NP', 'IN', 'BT', 'LK', 'CN', 'MN', 'JP', 'KR', 'TW', 'TH', 'VN', 'LA', 'KH', 'MM', 'PH', 'SG', 'HK'],
  'north-america': ['US', 'CA'],
  africa: [
    'ZA', 'NA', 'BW', 'ZW', 'ZM', 'MW', 'MZ', 'TZ', 'KE', 'UG', 'RW', 'ET', 'MG', 'LS', 'SZ',
    'GH', 'CV', 'MU', 'SC',
  ],
  oceania: ['NZ', 'AU'],
};
