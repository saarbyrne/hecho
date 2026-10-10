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
