import type { HelpScreen } from './actions';

// Where everything is on the screen, in the words of someone looking at it:
// which corner, what the icon looks like (the button names can be hidden with
// "הסתר שמות", and then only the icon is left), and when it is there at all —
// the trail's own buttons appear only once a trail is open. The help chat is
// given this map so it can say where a button is, and offer "הראה לי איפה",
// which lights the real button up (data-tour="<id>" on it, components/help/Coachmark).
//
// A button that moves, is renamed or gets a new icon is changed here too.

type When =
  | 'any'        // always
  | 'noTrail'    // no trail open (either home screen)
  | 'trailsHome' // the trails home screen, no trail open
  | 'trail'      // a trail (or a drive) is open
  | 'hike';      // a walking trail is open (not a drive)

export const HELP_PLACES = {
  search: { name: 'תיבת החיפוש', where: 'למעלה, לרוחב המסך', icon: 'שורה עם זכוכית מגדלת והכיתוב "חפש מקום או מסלול"', when: 'any' },
  recent: { name: 'מסלולים אחרונים', where: 'בתוך תיבת החיפוש, בקצה השמאלי', icon: 'שעון עם חץ סביבו', when: 'trailsHome' },
  home: { name: 'בית', where: 'הכפתור העליון בסרגל הכפתורים שבצד שמאל', icon: 'בית כתום', when: 'trail' },
  layers: { name: 'תצוגת מפה', where: 'בראש הקבוצה הראשונה בסרגל הכפתורים שבצד שמאל', icon: 'שכבות — כמה דפים מונחים זה על זה', when: 'any' },
  locate: { name: 'המיקום שלי', where: 'בסרגל הכפתורים שבצד שמאל, אחרי כפתורי ההתקרבות והמצפן', icon: 'כוונת — עיגול עם נקודה וקווים לארבעה כיוונים', when: 'any' },
  plan: { name: 'תכנון מסלול', where: 'בסרגל הכפתורים שבצד שמאל, מתחת ל"המיקום שלי"', icon: 'קו מתפתל בין שתי נקודות, בכתום', when: 'any' },
  record: { name: 'הקלטה', where: 'בסרגל הכפתורים שבצד שמאל, מתחת ל"תכנון מסלול"', icon: 'עיגול אדום מלא', when: 'any' },
  drive: { name: 'נסיעה ברכב', where: 'בסרגל הכפתורים שבצד שמאל, מתחת ל"הקלטה"', icon: 'מכונית', when: 'noTrail' },
  fit: { name: 'כל המסלול', where: 'בקבוצת הכפתורים של המסלול בסרגל שבצד שמאל (מופיעה רק כשמסלול פתוח)', icon: 'שני חצים אלכסוניים לפינות, בצהוב', when: 'trail' },
  guide: { name: 'מדריכה (פעילה / כבויה)', where: 'בקבוצת הכפתורים של המסלול בסרגל שבצד שמאל (מופיעה רק כשמסלול פתוח)', icon: 'אוזניות; מחוקות כשהמדריכה כבויה', when: 'hike' },
  points: { name: 'נקודות', where: 'בקבוצת הכפתורים של המסלול בסרגל שבצד שמאל, מתחת למדריכה (מופיעה רק כשמסלול פתוח)', icon: 'רשימה עם תו מוזיקלי, ולידה מספר הנקודות', when: 'hike' },
  settings: { name: 'הגדרות', where: 'בראש הקבוצה התחתונה בסרגל הכפתורים שבצד שמאל', icon: 'גלגל שיניים', when: 'any' },
  'hide-all': { name: 'הסתר הכל', where: 'בסרגל שבצד שמאל, מתחת ל"הגדרות"', icon: 'עין, בכתום־צהוב', when: 'any' },
  labels: { name: 'הסתר שמות / הצג שמות', where: 'הכפתור התחתון בסרגל שבצד שמאל', icon: 'תווית מחיר', when: 'any' },
  discovery: { name: 'מסלולים לפי מדינות, עונות ומאפיינים נוספים', where: 'החלונית בתחתית מסך הבית', icon: 'סמן מיקום כתום, וחץ למעלה שפותח את הרשימה', when: 'trailsHome' },
  stats: { name: 'כרטיס המסלול', where: 'בתחתית המסך, מעל כפתור הסיור הווירטואלי; "נתונים" פותח אותו', icon: 'שם המסלול, אורך ועליות; כפתור "נתונים"', when: 'trail' },
  'trail-info': { name: 'על המסלול', where: 'בכרטיס המסלול, ליד "נתונים"', icon: 'ספר פתוח על עיגול כחול', when: 'trail' },
  'tour-button': { name: 'סיור וירטואלי', where: 'הכפתור הכתום בתחתית המסך, במרכז', icon: 'משולש "נגן"', when: 'trail' },
  'help-chat': { name: 'שאלו את Navi', where: 'הכפתור העגול הכחול בפינה הימנית התחתונה', icon: 'בועת דיבור', when: 'any' },
} as const satisfies Record<string, { name: string; where: string; icon: string; when: When }>;

export type HelpPlaceId = keyof typeof HELP_PLACES;

export function isPlaceOnScreen(id: HelpPlaceId, screen: HelpScreen): boolean {
  const when: When = HELP_PLACES[id].when;
  switch (when) {
    case 'any': return true;
    case 'noTrail': return !screen.hasTrail;
    case 'trailsHome': return !screen.hasTrail && screen.mode === 'trails';
    case 'trail': return screen.hasTrail;
    case 'hike': return screen.hasTrail && !screen.driveTrail;
  }
}

export const WHEN_LABELS: Record<When, string> = {
  any: 'תמיד',
  noTrail: 'רק כשאין מסלול פתוח',
  trailsHome: 'רק במסך הבית, כשאין מסלול פתוח',
  trail: 'רק כשמסלול פתוח',
  hike: 'רק כשמסלול הליכה פתוח',
};
