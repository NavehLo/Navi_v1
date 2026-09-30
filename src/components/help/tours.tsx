import type { CoachStep } from "./Coachmark";

// The words of the tours and tips, in one place so they can be read — and
// corrected — together. Each points at a data-tour="…" in the components.

// The first visit, on the home screen.
export const WELCOME_STEPS: CoachStep[] = [
  {
    title: "ברוכים הבאים ל־Navi",
    body: "מסלולי טיול בתלת מימד, עם מדריכה קולית שמספרת על המקומות שבדרך. סיור קצר של חצי דקה, ואפשר לדלג.",
  },
  {
    target: "mode-toggle",
    body: "כאן עוברים בין מסלולי טיול לבין תכנון נסיעה בכביש.",
  },
  {
    target: "discovery",
    body: "בוחרים מסלול מהסימנים על המפה או מהרשימה ב״חפש מסלולים״. אפשר לסנן לפי אזור, צל ומים, או להעלות קובץ GPX משלכם.",
  },
  {
    target: "rail",
    body: "כפתורי המפה: סוג המפה והתלת מימד, המיקום שלכם ומדידת מרחק. אם השמות תופסים מקום, כפתור התווית למטה מסתיר אותם.",
  },
  {
    target: "settings",
    body: "בהגדרות: התחברות, שמירה ושיתוף של מסלול, התראה כשסוטים מהמסלול, והסבר על כל האפשרויות. משם אפשר גם לראות את הסיור הזה שוב.",
  },
];

// The first trail opened.
export const TRAIL_STEPS: CoachStep[] = [
  {
    target: "stats",
    body: "כרטיס המסלול. לחיצה על ״נתונים״ פותחת את פרופיל הגובה, מזג האוויר ליום הטיול, מקורות מים וצל.",
  },
  {
    target: "tour-button",
    body: "סיור וירטואלי: טיסה לאורך המסלול, כדי לראות אותו לפני שיוצאים. במהלך הסיור משנים מהירות בכפתורי x1 / x2 / x5, והזמן שנותר לסיור מתעדכן מיד.",
  },
  {
    target: "trail-rail",
    body: "המדריכה כבויה עד שמפעילים אותה. כשהיא פעילה היא מקריינת כשמגיעים לכל נקודה מעניינת, בסיור או בהליכה אמיתית. ב״נקודות״ רואים את כולן ומורידים את המסלול לשטח בלי קליטה.",
  },
];

// The live location switched on with a trail open, for the first time.
export function trackingSteps(nativeApp: boolean): CoachStep[] {
  return [{
    target: "locate",
    body: nativeApp
      ? "המיקום החי דלוק. אם תסטו מהמסלול תשמעו התראה, גם כשהמסך כבוי. את המרחק והצליל משנים בהגדרות."
      : "המיקום החי דלוק. אם תסטו מהמסלול תשמעו התראה; את המרחק והצליל משנים בהגדרות. בדפדפן המיקום נעצר כשהמסך כבה, ולכן כדאי להשאיר אותו דלוק.",
  }];
}

// The drive planner, the first time it is opened.
export const DRIVE_STEPS: CoachStep[] = [
  {
    target: "drive-panel",
    body: "מקלידים מוצא ויעד, או מסמנים אותם על המפה בכפתור הנעץ. אפשר להוסיף עצירות בדרך, ולבחור בין עד שלוש דרכים בלחיצה על הקו שלהן במפה.",
  },
];
