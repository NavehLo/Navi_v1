import { useState } from "react";
import { HelpCircle, PlayCircle, RotateCcw, Check, ChevronDown } from "lucide-react";
import Collapsible from "../Collapsible";

// "מדריכים ומידע נוסף", at the top of the settings: the one place where everything
// the app can do is explained, and nothing jumps out at anybody by itself.
// Also the way back to the tour, and to the one-off tips once they were seen.

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: "בחירת מסלול",
    body: "במסך הבית: לחיצה על סימן במפה, או ״חפש/העלה מסלולים״ לרשימה עם חיפוש וסינון לפי אזור, סוג, צל ומים. אפשר גם להעלות קובץ GPX או KML משלכם.",
  },
  {
    title: "מסלולים בעולם",
    body: "ב״תצוגת מפה״ ← ״מסלולים בעולם״ מופיעים על המפה מסלולים מסומנים מכל העולם. לחיצה על קו פותחת את הפרטים שלו.",
  },
  {
    title: "סיור וירטואלי",
    body: "טיסה לאורך המסלול, כדי להכיר אותו לפני שיוצאים. במהלך הסיור בוחרים מהירות בכפתורי x1 / x2 / x5, בלי לעצור, ולחיצה על פס ההתקדמות קופצת לנקודה אחרת במסלול.",
  },
  {
    title: "המדריכה הקולית",
    body: "כבויה עד שמפעילים אותה, בכל מסלול מחדש. כשהיא פעילה היא מקריינת בהגעה לכל נקודה מעניינת: בסיור הווירטואלי, או בהליכה אמיתית לפי המיקום שלכם. לחיצה על נקודה תכולה במפה משמיעה אותה מיד.",
  },
  {
    title: "נקודות והורדה לשטח",
    body: "בכפתור ״נקודות״ רואים את כל נקודות המדריכה. שם גם מורידים את המסלול: המפה והקריינות נשמרות במכשיר ל־30 יום ועובדות בלי קליטה.",
  },
  {
    title: "כרטיס המסלול",
    body: "לחיצה על הכרטיס פותחת אורך, גבהים ועליות, מזג אוויר לפי יום ושעת יציאה וכמה מים לשתייה לקחת, ובמסלולים בישראל גם איפה יש מים לרחצה וצל לאורך הדרך.",
  },
  {
    title: "מיקום חי והתראת סטייה",
    body: "״המיקום שלי״ מציג אתכם על המפה ועוקב. עם מסלול פתוח, סטייה ממנו מפעילה התראה קולית. המרחק, הצליל והעוצמה נקבעים בהגדרות למטה. בדפדפן המיקום נעצר כשהמסך כבה.",
  },
  {
    title: "תכנון מסלול וניווט",
    body: "״תכנון מסלול״ בונה מסלול הליכה בין כמה נקודות ומראה את המרחק: מזיזים את המפה כך שהנעץ יעמוד על כל נקודה. עם מסלול פתוח הבנייה היא לאורכו. ״התחל ניווט״ הופך את מה שנבנה למסלול שהולכים בו.",
  },
  {
    title: "הקלטת מסלול",
    body: "״הקלטה״ בסרגל הצד שומרת את הדרך שאתם הולכים, עם המרחק, העלייה והירידה, זמן ההליכה והקצב. ״השהה״ עוצר את הספירה בהפסקה, ״סיים״ פותח סיכום עם שם ושמירה. ההקלטות נשמרות במכשיר, וכשמחוברים גם בחשבון — בלשונית ״הקלטות״ באזור האישי, משם פותחים אותן על המפה ומשתפים בקישור או כקובץ GPX. רק מי שמקבל קישור רואה הקלטה. בדפדפן ההקלטה נעצרת כשהמסך כבוי; באפליקציית האנדרואיד היא ממשיכה.",
  },
  {
    title: "נסיעה בכביש",
    body: "מוצא, יעד ועצירות בדרך, ועד שלוש דרכים לבחירה. אפשר לצאת מהמיקום שלכם ולסמן מקומות על המפה.",
  },
  {
    title: "שמירה ושיתוף",
    body: "אחרי התחברות עם Google אפשר לשמור מסלולים ולכתוב עליהם הערות באזור האישי. ״שתף מסלול״ שולח קישור שפותח אותו ישר.",
  },
  {
    title: "הסתר הכל",
    body: "משאיר על המסך רק את המפה והמסלול. הכפתור הצהוב בפינה מחזיר הכל.",
  },
];

export default function HelpSection({
  onReplay, onReset,
}: {
  // Absent when the screen has no tour to replay (an open drive).
  onReplay?: () => void;
  onReset: () => void;
}) {
  const [resetDone, setResetDone] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const row = "flex items-center gap-2.5 text-sm font-bold p-3 rounded-xl transition-colors";
  // Inside the folded section the buttons sit one shade lighter than it.

  return (
    // One line until tapped: the explanations are there for whoever looks
    // for them, not a list everybody has to scroll past to reach the rest.
    <Collapsible
      className="mb-3"
      icon={<HelpCircle size={16} className="text-sky-300 shrink-0" />}
      title="מדריכים ומידע נוסף"
    >
      <div className="flex flex-col gap-2">
        {onReplay && (
          <button onClick={onReplay} className={`${row} bg-white/10 text-white hover:bg-white/15`}>
            <PlayCircle size={16} className="text-sky-300" /> הצג שוב את ההדרכה של המסך הזה
          </button>
        )}
        <button
          onClick={() => { onReset(); setResetDone(true); }}
          disabled={resetDone}
          className={`${row} bg-white/10 text-white hover:bg-white/15 disabled:hover:bg-white/10`}
        >
          {resetDone
            ? <><Check size={16} className="text-emerald-300" /> הטיפים יופיעו שוב כשתגיעו אליהם</>
            : <><RotateCcw size={16} className="text-sky-300" /> הצג שוב את כל הטיפים</>}
        </button>

        <div className="rounded-xl bg-white/10 divide-y divide-white/10">
          {FEATURES.map((f, i) => (
            <div key={f.title}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="w-full flex items-center justify-between gap-2 text-right text-sm text-white font-bold px-3 py-2.5"
              >
                {f.title}
                <ChevronDown size={16} className={`shrink-0 transition-transform ${open === i ? "rotate-180" : ""}`} />
              </button>
              {open === i && <p className="text-white text-sm leading-relaxed px-3 pb-3">{f.body}</p>}
            </div>
          ))}
        </div>
      </div>
    </Collapsible>
  );
}
