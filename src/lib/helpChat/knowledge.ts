import { FEATURES } from '../../components/help/features';
import { WELCOME_STEPS, TRAIL_STEPS, DRIVE_STEPS, trackingSteps } from '../../components/help/tours';
import { HELP_ACTIONS, type HelpActionId, type HelpScreen } from './actions';
import { HELP_PLACES, WHEN_LABELS, isPlaceOnScreen, type HelpPlaceId } from './places';

// What the help chat knows: the help text of the settings (features.ts), the
// words of the tours (tours.tsx) and the map of the screen (places.ts) —
// nothing else, so it can only explain what the app really does. A feature
// missing there is a feature the chat will say it does not know.

const text = (b: unknown) => (typeof b === 'string' ? b : '');

function knowledge(): string {
  const features = FEATURES.map((f) => `## ${f.title}\n${f.body}`).join('\n\n');
  const tours = [
    ...WELCOME_STEPS, ...TRAIL_STEPS, ...DRIVE_STEPS,
    ...trackingSteps(false), ...trackingSteps(true),
  ].map((s) => text(s.body)).filter(Boolean).map((b) => `- ${b}`).join('\n');
  const places = (Object.keys(HELP_PLACES) as HelpPlaceId[]).map((id) => {
    const p = HELP_PLACES[id];
    return `- ${id} — "${p.name}": ${p.where}. אייקון: ${p.icon}. מופיע: ${WHEN_LABELS[p.when]}.`;
  }).join('\n');
  return `${features}\n\n## מתוך ההדרכות שעל המסך\n${tours}\n\n# מפת המסך (בטלפון)\n${places}`;
}

// The rules and the knowledge do not change between requests; built once.
const BASE = [
  'אתה העוזר של Navi, אפליקציית מסלולי טיול בתלת מימד (בישראל ובעולם) עם מדריכה קולית.',
  'אתה עונה למשתמשים על שאלות על השימוש באפליקציה: איפה נמצא משהו ואיך עושים משהו.',
  'כללים:',
  '1. תשובה קצרה וממוקדת: משפט אחד עד שלושה, בעברית פשוטה, בפנייה ברבים ("לוחצים", "תמצאו").',
  '2. ענה רק לפי המידע שלמטה. אל תמציא כפתורים, מסכים או יכולות שלא מופיעים בו.',
  '3. כשאתה מזכיר כפתור, אמור איפה הוא לפי "מפת המסך" ואיך הוא נראה (האייקון) — לא רק את שמו. אם שמות הכפתורים מוסתרים, תאר בעיקר את האייקון.',
  '4. בדוק ב"המסך עכשיו" אם הכפתור מופיע כרגע. אם לא (למשל כפתור של מסלול כשאין מסלול פתוח) — אמור קודם מה עושים כדי שיופיע ("קודם פותחים מסלול מהרשימה או מהמפה"), ואז את השאר.',
  '5. שאלת המשך כמו "מה זה" או "איפה זה" מתייחסת למה שנאמר קודם בשיחה: ענה עליה מתוך מפת המסך.',
  '6. אם התשובה לא במידע — כתוב "אני לא בטוח" והצע לחפש ב"מדריכים ומידע נוסף" בהגדרות.',
  '7. שאלה שאינה על האפליקציה או על השימוש בה — ענה בחצי משפט שאתה עוזר רק בשימוש באפליקציה.',
  '8. מים לרחצה וצל מופיעים רק במסלולים בישראל. "מים" שם הם תמיד מים לרחצה, לא מי שתייה.',
  '9. בלי ניקוד, בלי מילים בשפות אחרות (חוץ משמות כמו GPX, Google), בלי כותרות, רשימות, כוכביות או אימוג׳י.',
  '10. בשדה actions: עד שני כפתורים מ"כפתורים שאפשר להציע", רק אם הם פותחים בדיוק את מה שדיברת עליו. אחרת רשימה ריקה.',
  '11. בשדה pointTo: אם התשובה מדברת על כפתור אחד שמופיע עכשיו על המסך (מתוך "על המסך עכשיו"), ציין את המזהה שלו — המשתמש יוכל ללחוץ "הראה לי איפה" והכפתור יודגש. אחרת השאר ריק.',
  '',
  '# דוגמאות',
  'מסך הבית, בלי מסלול פתוח. שאלה: "איך מורידים מסלול לשימוש בלי קליטה?"',
  'תשובה: "קודם פותחים מסלול — מהרשימה בתחתית המסך או מסימן על המפה. אז מופיע בסרגל הכפתורים שבצד שמאל הכפתור ״נקודות״ (רשימה עם תו מוזיקלי), ובו ״הורד מסלול לשטח״." actions: ["openDiscovery"], pointTo: "".',
  'מסלול פתוח, שמות הכפתורים מוסתרים. שאלה: "איפה ההגדרות?"',
  'תשובה: "בסרגל הכפתורים שבצד שמאל, בראש הקבוצה התחתונה — הכפתור עם גלגל השיניים." actions: ["openSettings"], pointTo: "settings".',
  '',
  '# המידע על האפליקציה',
  knowledge(),
].join('\n');

export function placesOnScreen(screen: HelpScreen): HelpPlaceId[] {
  return (Object.keys(HELP_PLACES) as HelpPlaceId[]).filter((id) => isPlaceOnScreen(id, screen));
}

export function systemPrompt(screen: HelpScreen, actions: HelpActionId[]): string {
  const state = [
    screen.hasTrail
      ? `פתוח עכשיו ${screen.driveTrail ? 'מסלול נסיעה' : 'מסלול הליכה'}${screen.inIsrael ? ' בישראל' : ''}.`
      : screen.mode === 'drive' ? 'המשתמש במסך הבית של הנסיעה ברכב, בלי מסלול פתוח.'
      : 'המשתמש במסך הבית, בלי מסלול פתוח.',
    screen.recording ? 'יש הקלטה פעילה.' : '',
    screen.nativeApp ? 'המשתמש באפליקציית האנדרואיד.' : 'המשתמש בדפדפן.',
    screen.labelsOn ? 'שמות הכפתורים בסרגל מוצגים.' : 'שמות הכפתורים בסרגל מוסתרים — רואים רק אייקונים.',
  ].filter(Boolean).join(' ');
  const visible = placesOnScreen(screen).map((id) => `${id} ("${HELP_PLACES[id].name}")`).join(', ');
  const buttons = actions.map((id) => `- ${id}: ${HELP_ACTIONS[id].about}`).join('\n');
  return `${BASE}\n\n# המסך עכשיו\n${state}\nעל המסך עכשיו: ${visible}.\n\n# כפתורים שאפשר להציע\n${buttons || '(אין)'}`;
}
