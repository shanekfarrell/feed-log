# Feed Log

A breast-feed timer and baby log for two parents, built as a personal project. Time left and right feeds, log bottles, sleeps and weigh-ins, see weight on the WHO centile curves, and read week-by-week notes on what's typical. Both parents' phones stay in sync.

It's plain static files with no build step: `index.html`, `app.js`, `logic.js`, `sync.js`, `milestones.js`, `history.js`, `sw.js`, `manifest.json` and `icons/`.

> **Not medical advice.** This is a hobby project, not a medical device. The targets, centiles and "is she getting enough?" verdicts are rough guides worked out from public NHS and WHO information. Always follow your midwife, health visitor or GP.

## Try it on one phone (no setup)
Put the files on any static host, or run `python3 -m http.server` in this folder and open http://localhost:8000. With `SUPABASE_URL` blank in `app.js`, everything is saved in that phone's browser only. Nothing is shared, and clearing the browser's data deletes it.

## Sync two phones (your own free database)
You need a free [Supabase](https://supabase.com) project. It holds your data, under your account; nobody else's copy of this app can see it.

1. Create a new project at supabase.com.
2. **Authentication → Sign In / Providers:** turn on **Allow anonymous sign-ins**.
3. **SQL Editor:** paste in all of `supabase.sql` and click **Run**. It's safe to run again; the "destructive operation" warning is expected.
4. **Project Settings → API:** copy the **Project URL** and the **anon / publishable** key. Never use the secret or service_role key.
5. Paste them into `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of `app.js`. The publishable key is meant to be public: on its own it can't read or change anything.
6. Deploy the folder to any static host (Vercel, Netlify, GitHub Pages, Cloudflare Pages). For example, with the Vercel CLI: `npx vercel deploy --prod`.
7. **Authentication → URL Configuration:** set **Site URL** to your deployed address.

### Set up both phones
1. Open your address on the first phone. It signs in silently (no password) and creates a private log.
2. Tap ⚙︎ to add your name and the baby's birth date. Tap the name at the top to rename, and the picture to add a photo.
3. In ⚙︎, tap **Send this log's link to partner**. The link carries a secret join code: whoever has it can join the log, so only send it to your partner.
4. Add the app to each home screen: on iPhone, Safari → Share → **Add to Home Screen**; on Android, Chrome → ⋮ → **Add to Home screen**.

Tip: to have every phone open straight into one log without sharing a link, set `FAMILY: { room, code }` in `app.js` (a room of 8–32 lowercase letters and digits, and a code of 20+ letters and digits). Only do this if your deployed address is private, because anyone who can read the page source can then join.

## Using it
- **Feed Timer:** Left / Right starts the timer (✓ marks the side to start on). While it runs: Stop, Pause, Switch side, Discard. Stop opens a review where you can fix the times, then Save or go back to the timer.
- **Logs:** every feed, bottle and sleep. Tap one to edit or delete it.
- **Growth:** weight on the WHO girls' weight-for-age centiles, and what she'd need to gain to stay on her line.
- **Analysis:** feeds in the last 24 hours, milk today against a target, and the last 7 days.
- **Milestones:** swipeable week-by-week cards with sources.

Feeds of the same kind that start within an hour of each other are combined into one. All the rules (feed interval, ml per kg, the breast ml-per-minute estimate, when the day starts) are in the `CONFIG` block at the top of `app.js`.

## Sample data
`demo/history-demo.js` makes up two weeks of feeds, sleeps and weigh-ins for showing the app off. To use it, copy it over `history.js` and set `BABY: { name: 'Baby', birth: DEMO.birth }`, `REDBOOK_WEIGHTS: DEMO.book` and `DEFAULT_WEIGHT_KG: DEMO.birthKg` in `app.js`. It adds a bar with **Start fresh** so visitors can clear the samples and use it themselves.

## Tests
`node --test` (Node 20 or later).

## Licence
MIT. See `LICENSE`.
