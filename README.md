# Hecho

Site for hecho.fyi. It links Verbos, Charla and Traduce, takes donations through a Stripe Payment Link and collects emails for Hecho+.

It is one Cloudflare Worker. The Worker serves `public/` and handles `POST /api/interes`, which saves the email in KV and sends an alert email.

Project notes live in Obsidian under `Projects/Hecho`.

## Commands

```sh
npm test              # worker tests, no install needed
npm run dev           # local preview at http://localhost:8787
npm run deploy        # publish to hecho.fyi
npm run signups       # list the Hecho+ sign-ups
npm run db:setup      # create the database, once (see Database)
npm run check:gemini  # try the Gemini key in .dev.vars (see Gemini key)
npm run voice-test    # compare voice models for charla (see Voice test)
```

`npx wrangler@4` runs Cloudflare's tool without installing it. The first run asks you to log in with `npx wrangler@4 login`.

## Design

The pages follow the Type led brand (Obsidian `Projects/Hecho/Brand/Type led.md`). The design file is `designs/landingpage.pen`. Fonts load from Bunny Fonts. `public/styles.css` is the old stylesheet and is no longer used.

## Structure

```
public/          static pages (home, charla, traduce, verbos, plus, privacidad), site.css and icons
src/worker.js    sign-up endpoint, then static files
migrations/      database tables, one numbered .sql file per change
scripts/         scripts that npm runs (db:setup, check:gemini)
wrangler.jsonc   Worker, domain, KV and email settings
tests/
```

## Leer

The Leer section of `/traduce/` lists real Spanish news from free feeds, with a level (Fácil, Medio, Difícil) and topics.

- The feeds are in `src/leer/feeds.js`. Every 15 minutes the Worker refreshes one feed, in turn, and saves the list in KV under `leer:articles` (in the SIGNUPS namespace).
- The level comes from the INFLESZ readability score of the headline and summary (`src/leer/level.js`). Topics come from the feed and a word list (`src/leer/topics.js`). No AI and no keys.
- The page reads `/api/leer`. The old `/traduce/leer/` address redirects to `/traduce/#leer`. Only the headline, link, source, date, level and topics are stored. Articles leave the list after three days.

## Database

Accounts and other personal data go in a Cloudflare D1 database called `hecho`, created in the EU. The tables are in `migrations/`, one numbered `.sql` file per change.

`npm run db:setup` sets it up. It does three things:

- creates the database in the EU with `npx wrangler@4 d1 create hecho --jurisdiction=eu`
- adds it to `wrangler.jsonc` as `DB`
- creates the tables with `npx wrangler@4 d1 migrations apply hecho --remote`, after you confirm

Run it once, before the first deploy that uses the database. If `wrangler.jsonc` already has a database, it stops and changes nothing.

When a batch adds a file to `migrations/`:

1. Run `npx wrangler@4 d1 migrations apply hecho --remote` to update the live tables.
2. Run `npm run deploy`.

For the local copy that `npm run dev` uses, run the same command with `--local` in place of `--remote`.

`npm test` runs the same SQL on Node's built-in SQLite, so it needs Node 22.13 or later.

## Gemini key

Hecho's server keeps one Gemini key for everyone, as the secret `GEMINI_API_KEY`. The key comes from a Google Cloud project with billing on, so the paid tier's terms apply to every user.

The models are `GEMINI_LIVE_MODEL` and `GEMINI_TEXT_MODEL` under `vars` in `wrangler.jsonc`. To change model, change the name there and run `npm run deploy`.

To set up the key:

1. Open aistudio.google.com/apikey and click **Create API key**. Choose a Google Cloud project for Hecho, or create one.
2. In the project's **Billing Tier** column, click **Set up billing** and link a billing account. If it asks, choose Postpay, so the key keeps working when prepaid credit runs out.
3. In the Google Cloud console, open **Billing**, then **Budgets & alerts**, and click **Create budget**. Choose **Alerts only**, the Hecho project, a **Monthly** time range and a **Target amount** of €50, then click **Finish**.
4. New keys only work with the Gemini API (the Generative Language API). If the key says **Unrestricted**, hover over that label, click **Add restrictions**, choose **Restrict to Gemini API only** and click **Restrict key**.
5. In Terminal, in the hecho folder, run `npx wrangler@4 secret put GEMINI_API_KEY`. Paste the key when it asks.
6. Run `cp .dev.vars.example .dev.vars` and `open -e .dev.vars`, then paste the key after `GEMINI_API_KEY=` and save. Git ignores this file.
7. Run `npm run check:gemini`. It prints a short reply from Gemini and the token counts.

## Voice test

`npm run voice-test` compares voice models for charla on cost and replies. The plan is in Obsidian, `Projects/Hecho/Voice test.md`.

- A Mac voice plays the learner. It reads Saar's answers from a real "5 preguntas" session, with pauses of 1.2 to 1.8 seconds, to every option in `scripts/voice-bench/script.mjs`.
- It needs a Mac, a Spanish voice (System Settings → Accessibility → Spoken Content) and the Gemini key in `.dev.vars`.
- It runs each option twice, at the same time, in about 8 minutes. `--only today,tuned` picks options and `--runs 1` changes the number of runs: `npm run voice-test -- --only tuned --runs 1`.
- The report and each reply's audio go in `scripts/voice-bench/out/`, which git ignores, because it holds recordings and transcripts.
- The report scores interruptions, the wait before each reply, how much Google's transcript got right, the question order, and each session's cost. Google bills every turn for the whole session so far, and the report also shows the cost if each token were billed once.
- Besides the models, it tests three ways to lower that cost: a short context (Google drops the oldest part of the conversation), and two speech only options, where the app sends sound only while the learner speaks and marks the start and end of each line itself.
- The `pipeline` option skips the Live API. Gemini 3.1 Flash-Lite gets each answer as audio and writes the reply, and Gemini 3.8 Flash-Lite TTS says it with a Spain Spanish voice from Google's voice library (`BENCH_TTS_VOICE` picks another). Each call bills only what it gets. `npm run voice-test -- --only pipeline` runs it on its own for about $0.05 (estimate).
- `npm run voice-samples` says the same sentences in every Spain Spanish voice in Google's library and saves them in `scripts/voice-bench/out/voices-es/`, so the voice can be chosen by ear. It costs about $0.03 for all 22 (estimate).
- On Tier 1, Google allows 10 voice requests a minute and 100 a day for the whole project, and the pipeline uses one for each reply. So `voice-samples` makes one every 7 seconds, and it skips voices that already have a file, so a second run fills in the ones that failed. `npm run voice-samples -- --again` makes them all again.
- With all eight options it costs about $2.50 of API use (estimate), and on 10 October two runs went over a €5 spend cap. Check the cap in AI Studio first.
