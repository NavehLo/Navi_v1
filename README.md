This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

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
