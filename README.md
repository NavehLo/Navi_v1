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

`SUPABASE_SERVICE_ROLE_KEY` הוא **סוד אמיתי**: הוא עוקף RLS ומאפשר גישה מלאה
לבסיס הנתונים. לעולם אל תיתן לו קידומת `NEXT_PUBLIC_` — כל משתנה עם הקידומת
הזו נארז לתוך ה-JavaScript שרץ בדפדפן של כל מבקר.

הטוקן של Mapbox הוא היוצא מן הכלל: הוא מוזן דרך מסך הפתיחה של האפליקציה
ונשמר ב-localStorage של הדפדפן, לא כמשתנה סביבה.

### בחירת קול — בלי deploy

`ELEVENLABS_VOICE_ID` הוא רק ברירת המחדל של השרת. כדי לנסות קולות, פתח
באפליקציה **הגדרות → הקול של המדריכה**: בחר מהרשימה, כוונן את המחוונים,
ולחץ "השמע משפט לדוגמה".

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

עברית נכתבת בלי ניקוד, ומודל הקראה מנחש את התנועות. על שמות מסלולים הוא טועה
באותם מקומות: "עין" נקרא כ-"עַיִן" ולא "עֵין", "נחל" כ-"נֶחֶל" ולא "נַחַל".
`src/lib/niqqud.ts` מנקד את אוצר המילים הגיאוגרפי (נַחַל, עֵין, חֻרְבַּת,
מַעֲלֵה…) רגע לפני שהטקסט נשלח ל-TTS.

הוא **לא** נוגע בשם הפרטי שאחרי (כזיב, צאלים, עתרי) — ניקוד נכון של שם עברי
שרירותי דורש מודל ייעודי ולא טבלה, וניחוש שגוי שם יזיק יותר מאשר לא לנקד.
הניקוד מופעל בזמן הסינתזה ולא בזמן כתיבת הטקסט, כך שהטקסט השמור נשאר עברית
קריאה והטבלה יכולה להשתפר בלי לייצר מחדש אף קריינות. `NIQQUD_VERSION` הוא חלק
מחתימת הקול, ולכן שיפור הטבלה מייצר אודיו חדש במקום להגיש את ההקראה הישנה.

אפשר לכבות את זה מההגדרות ולהשוות עם כפתור משפט הדוגמה.

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
