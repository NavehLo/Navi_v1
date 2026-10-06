import { FEATURES } from '../../components/help/features';
import { WELCOME_STEPS, TRAIL_STEPS, DRIVE_STEPS, trackingSteps } from '../../components/help/tours';
import { HELP_ACTIONS, type HelpActionId, type HelpScreen } from './actions';

// What the help chat knows: the help text of the settings (features.ts) and
// the words of the tours (tours.tsx) — nothing else, so it can only explain
// what the app really does. A feature missing there is a feature the chat
// will say it does not know.

const text = (b: unknown) => (typeof b === 'string' ? b : '');

function knowledge(): string {
  const features = FEATURES.map((f) => `## ${f.title}\n${f.body}`).join('\n\n');
  const tours = [
    ...WELCOME_STEPS, ...TRAIL_STEPS, ...DRIVE_STEPS,
    ...trackingSteps(false), ...trackingSteps(true),
  ].map((s) => text(s.body)).filter(Boolean).map((b) => `- ${b}`).join('\n');
  return `${features}\n\n## מתוך ההדרכות שעל המסך\n${tours}`;
}

// The rules and the knowledge do not change between requests; built once.
const BASE = [
  'אתה העוזר של Navi, אפליקציית מסלולי טיול בתלת מימד (בישראל ובעולם) עם מדריכה קולית.',
  'אתה עונה למשתמשים על שאלות על השימוש באפליקציה: איפה נמצא משהו ואיך עושים משהו.',
  'כללים:',
  '1. תשובה קצרה וממוקדת: משפט אחד עד שלושה, בעברית פשוטה, בפנייה ברבים ("לוחצים", "תמצאו").',
  '2. ענה רק לפי המידע שלמטה. אל תמציא כפתורים, מסכים או יכולות שלא מופיעים בו.',
  '3. אם התשובה לא במידע — כתוב "אני לא בטוח" והצע לחפש ב"מדריכים ומידע נוסף" בהגדרות.',
  '4. שאלה שאינה על האפליקציה או על השימוש בה — ענה בחצי משפט שאתה עוזר רק בשימוש באפליקציה.',
  '5. מים לרחצה וצל מופיעים רק במסלולים בישראל. "מים" שם הם תמיד מים לרחצה, לא מי שתייה.',
  '6. בלי ניקוד, בלי מילים בשפות אחרות (חוץ משמות כמו GPX, Google), בלי כותרות, רשימות, כוכביות או אימוג׳י.',
  '7. בשדה actions: עד שני כפתורים מהרשימה, רק אם הם פותחים בדיוק את מה שדיברת עליו. אחרת רשימה ריקה.',
  '',
  '# המידע על האפליקציה',
  knowledge(),
].join('\n');

export function systemPrompt(screen: HelpScreen, actions: HelpActionId[]): string {
  const state = [
    screen.hasTrail
      ? `פתוח עכשיו ${screen.driveTrail ? 'מסלול נסיעה' : 'מסלול הליכה'}${screen.inIsrael ? ' בישראל' : ''}.`
      : screen.mode === 'drive' ? 'המשתמש במסך הבית של הנסיעה ברכב, בלי מסלול פתוח.'
      : 'המשתמש במסך הבית, בלי מסלול פתוח.',
    screen.recording ? 'יש הקלטה פעילה.' : '',
    screen.nativeApp ? 'המשתמש באפליקציית האנדרואיד.' : 'המשתמש בדפדפן.',
  ].filter(Boolean).join(' ');
  const buttons = actions.map((id) => `- ${id}: ${HELP_ACTIONS[id].about}`).join('\n');
  return `${BASE}\n\n# המסך עכשיו\n${state}\n\n# כפתורים שאפשר להציע\n${buttons || '(אין)'}`;
}
