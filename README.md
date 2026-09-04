# Navi

תלת-ממד למסלולי טיול בישראל, עם מדריכה קולית בעברית.

## הגדרה — איפה שמים את המפתחות

**המפתחות לא נשמרים ב-GitHub, לעולם.** `.gitignore` חוסם כל קובץ `.env*`
(מלבד `.env.local.example`, שהוא תבנית עם ערכים ריקים). מפתח שנדחף ל-repo
ציבורי נסרק ונגנב תוך דקות, ולכן יש בדיוק שני מקומות נכונים:

### 1. פיתוח מקומי — קובץ `.env.local`

בשורש הפרויקט, ליד `package.json`:

```bash
cp .env.local.example .env.local
```

פתח את `.env.local` בעורך ומלא את הערכים. הקובץ נשאר רק על המחשב שלך.
אחרי כל שינוי בו צריך להפעיל מחדש את `npm run dev` — Next.js קורא את משתני
הסביבה פעם אחת בעלייה.

### 2. הפרודקשן ב-Vercel — לא קובץ, אלא ממשק

Vercel לא רואה את `.env.local` שלך. שם המשתנים מוגדרים בדשבורד:

**Vercel Dashboard → הפרויקט → Settings → Environment Variables**

לכל משתנה: Key, Value, ולסמן את שלוש הסביבות (Production / Preview /
Development). משתנה חדש נכנס לתוקף רק ב-deploy הבא — אחרי ההוספה צריך
**Deployments → הפריסה האחרונה → ⋯ → Redeploy**.

### מה למלא

| משתנה | חובה? | מאיפה משיגים |
|---|---|---|
| `ELEVENLABS_API_KEY` | לקול טוב בעברית | elevenlabs.io → Profile → API Keys |
| `ELEVENLABS_VOICE_ID` | יחד עם המפתח | elevenlabs.io → Voices → הקול → Copy Voice ID |
| `GEMINI_API_KEY` | לפחות ספק אחד | aistudio.google.com → Get API key |
| `OPENAI_API_KEY` | חלופה ל-Gemini | platform.openai.com → API keys |
| `NEXT_PUBLIC_SUPABASE_URL` | להתחברות ול-cache | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | " | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | ל-cache הקבוע | Supabase → Settings → API → service_role |
| `NIQQUD_PROVIDER` | לא | `dicta` (ברירת מחדל) או `lexicon` — ראה "ניקוד לפני ההקראה" |
| `DICTA_NAKDAN_URL` | לא | כתובת ה-API של Nakdan, אם DICTA העבירו אותה לגרסה חדשה |

`SUPABASE_SERVICE_ROLE_KEY` הוא **סוד אמיתי**: הוא עוקף RLS ומאפשר גישה מלאה
לבסיס הנתונים. לעולם אל תיתן לו קידומת `NEXT_PUBLIC_` — כל משתנה עם הקידומת
הזו נארז לתוך ה-JavaScript שרץ בדפדפן של כל מבקר.

הטוקן של Mapbox הוא היוצא מן הכלל: הוא מוזן דרך מסך הפתיחה של האפליקציה
ונשמר ב-localStorage של הדפדפן, לא כמשתנה סביבה.

### בחירת קול — בלי deploy

`ELEVENLABS_VOICE_ID` הוא רק ברירת המחדל של השרת. כדי לנסות קולות, פתח
באפליקציה **הגדרות → הקול של המדריכה**: בחר מהרשימה, כוונן את המחוונים,
ולחץ "השמע משפט לדוגמה".

**הרשאות המפתח.** מפתחות ה-API של ElevenLabs מוגבלים בהרשאות: מפתח יכול להיות
מורשה לייצר דיבור ועדיין חסום מלקרוא את רשימת הקולות. במקרה כזה הקריינות
עובדת אבל הרשימה בהגדרות חוזרת ריקה עם 401 `missing_permissions`. התיקון הוא
ElevenLabs → Profile → API Keys → עריכת המפתח → סימון ההרשאה החסרה (`voices_read`).
לא צריך מפתח חדש ולא צריך Redeploy.

**חשוב — לא כל קול שמתנגן באתר עובד ב-API.** בתוכנית החינמית קולות מה-Voice
Library חסומים ל-API ומחזירים 402 `paid_plan_required`, גם כשנשארו קרדיטים.
זו מגבלה על *סוג* הקול ולא על הכמות. לכן הרשימה בהגדרות נטענת מהחשבון עצמו
דרך `/api/tour-guide/voices` — היא בדיוק מה שהחשבון רשאי להשמיע ב-API, במקום
רשימה מנוחשת בקוד. הבחירה נשמרת במכשיר בלבד ונשלחת עם כל בקשה, כך
שאפשר להשוות קולות בתוך שניות. כפתור האיפוס מחזיר להגדרת השרת.

מזהה הקול וכל ההגדרות הם חלק ממפתח ה-cache של האודיו, ולכן מעבר בין קולות
לא דורס כלום — וחזרה לקול שכבר השתמשת בו היא בחינם.

בראש אותו פרק מוצג **מאיזה ספק הקול מגיע בפועל**. זה חשוב: ElevenLabs נבחר רק
אם *גם* `ELEVENLABS_API_KEY` *וגם* `ELEVENLABS_VOICE_ID` מוגדרים בשרת; אם אחד
מהם חסר, הקוד נופל בשקט ל-OpenAI או ל-Gemini. מבחוץ זה נראה זהה — המחוונים
פשוט מפסיקים להשפיע. החיווי אומר את זה במפורש.

### ניקוד לפני ההקראה

עברית נכתבת בלי ניקוד, ומודל הקראה מנחש את התנועות. לפעמים הניחוש מחליף מילה
שלמה: "מהר מירון" (מ + הר מירון) נקרא כ-"מַהֵר", כלומר *fast*. הניקוד מתבצע
רגע לפני שהטקסט נשלח ל-TTS, ולא בזמן כתיבת הקריינות — כך הטקסט השמור נשאר
עברית קריאה, וכל שיפור כאן חל בלי לייצר מחדש אף קריינות.

יש שני מנקדים, ו-`NIQQUD_PROVIDER` בוחר ביניהם:

**`dicta` (ברירת המחדל).** [Nakdan](https://nakdan.dicta.org.il/) של DICTA —
מודל ניקוד לעברית מודרנית. מנקד את כל המשפט, כולל שמות פרטיים ואוצר מילים
רגיל: "חקלאות", "שלווה" ושמות מסלולים שאף טבלה לא תכיל. השירות ציבורי, חינמי
ולא דורש מפתח. כל קריאה היא לשירות של גורם אחר, ולכן היא אופציונלית לגמרי:
פסק זמן של 6 שניות, ניסיון אחד, ונפילה חזרה לטבלה בכל כשל.

> **בדיקת בטיחות.** התשובה של Nakdan מתקבלת רק אם הסרת הניקוד ממנה מחזירה בדיוק
> את הטקסט שנשלח. מותר לה להוסיף סימני ניקוד ותו לא. אם האותיות חזרו שונות —
> מכל סיבה — התוצאה נפסלת והטבלה עונה במקומה. זה מה שמונע משירות חיצוני לשים
> מילים בפי המדריכה.

**`lexicon`.** `src/lib/niqqud.ts` — טבלה של אוצר המילים הגיאוגרפי (נַחַל, עֵין,
חֻרְבַּת, מַעֲלֵה…), בלי רשת ובלי עלות. היא מכסה גם תחיליות של אות אחת ששתי
האפשרויות שלהן נקבעות מהמילה עצמה: מ (מֵהַר, מִנַּחַל), ה מיודעת לפני אות
שאינה גרונית (הַנַּחַל), ו-ו לפניהן (וּמֵהַר). ב, כ ו-ל **לא** נכללות בכוונה:
"בנחל" הוא או בְּנַחַל או בַּנַּחַל תלוי אם ה"א הידיעה נבלעה, והטקסט הלא-מנוקד
לא אומר מה מהם. היא גם לא נוגעת בשם הפרטי שאחרי (כזיב, צאלים, עתרי).

`NIQQUD_VERSION` וזהות המנקד הם חלק מחתימת הקול, ולכן שינוי כאן מייצר אודיו
חדש במקום להגיש את ההקראה הישנה מה-cache.

**בדיקה.** בהגדרות → **בדיקת ניקוד** אפשר להזין כל משפט ולראות מה כל אחד משני
המנקדים עושה לו, בלי לייצר קול ובלי לצרוך קרדיטים. זו גם הדרך היחידה לוודא
ש*השרת* מצליח להגיע ל-Nakdan: התשובה כוללת את הכתובת שאליה פנה ואת השגיאה
המדויקת אם נכשל. אם Nakdan חסום מהפרודקשן, הקריינות תמשיך לעבוד — היא פשוט
תישמע כמו הטבלה בלבד. אפשר גם לכבות ניקוד לגמרי מאותו מסך.

### איזה קול דיבר בפועל

`ELEVENLABS_VOICE_ID` נשמר ב-cache יחד עם האודיו, ולכן החלפת קול לא דורסת
הקלטות קודמות — וזה בדיוק מה שמקשה לדעת מה נשמע כרגע. שלוש שכבות עונות על זה:

- **בזמן ההשמעה** מוצג מתחת לטקסט של המדריכה שם הקול והמזהה שהפיקו את הקטע
  הזה — לא מה שמוגדר בשרת עכשיו, אלא מה ששימש בפועל. קטע שהושמע מהמכשיר מסומן
  "מהמכשיר".
- **בהגדרות** החיווי הירוק מדווח על הקול שהשרת יבחר עבור ההעדפות של המכשיר
  הזה, כולל המנקד הפעיל.
- **משפט הדוגמה** מחזיר גם את הטקסט המנוקד שנשלח בפועל לקול.

ההורדה לאופליין נשמרת לפי (נקודה + חתימת קול). קריינות שהורדה בקול ישן לא
תושמע יותר: הנקודה תסומן שוב "להורדה", וההורדה הבאה תחליף אותה ותמחק את
העותקים בקולות שכבר לא בשימוש. עד לגרסה הזו העותק במכשיר נבדק לפי הנקודה בלבד,
כך שמסלול שהורד פעם המשיך להשמיע את הקול הישן לנצח — וזה נראה בדיוק כמו
"שינוי הקול לא עבד".

### בסיס הנתונים

הרץ את `supabase/schema.sql` ב-**Supabase → SQL Editor → New query**.
אפשר להריץ את הקובץ כולו שוב ושוב בבטחה — כל פקודה בו idempotent.

## הרצה

```bash
npm install
npm run dev
```

ואז [http://localhost:3000](http://localhost:3000).

## Keeping Supabase awake

Supabase pauses free-tier projects after **7 days without activity**. When that
happens Google login, the personal area and the per-user guide quota all stop
working (the rest of the app keeps running — see `src/lib/personalArea.ts` for
how the UI degrades).

`vercel.json` registers a daily cron that calls `/api/keepalive`, which performs
one anonymous read against the database. That single request is enough to keep
the project counted as active.

- Set a `CRON_SECRET` env var in Vercel to lock the route down — Vercel Cron
  sends it automatically as `Authorization: Bearer $CRON_SECRET`. Without the
  var the route stays open.
- The route answers `503` when Supabase is unreachable, so a failed ping shows
  up in Vercel's logs instead of passing silently.
- Not on Vercel? Any daily scheduler works, e.g. a GitHub Actions job running
  `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/keepalive`.

Once a project is already paused, the cron can't revive it — unpause it from the
Supabase dashboard (possible for 90 days after the pause; the project ref, URL
and anon key stay the same, so no redeploy is needed).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
