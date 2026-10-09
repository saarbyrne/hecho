# Hecho

Site for hecho.fyi. It links Verbos, Charla and Traduce, takes donations through a Stripe Payment Link and collects emails for Hecho+.

It is one Cloudflare Worker. The Worker serves `public/` and handles `POST /api/interes`, which saves the email in KV and sends an alert email.

Project notes live in Obsidian under `Projects/Hecho`.

## Commands

```sh
npm test          # worker tests, no install needed
npm run dev       # local preview at http://localhost:8787
npm run deploy    # publish to hecho.fyi
npm run signups   # list the Hecho+ sign-ups
```

`npx wrangler@4` runs Cloudflare's tool without installing it. The first run asks you to log in with `npx wrangler@4 login`.

## Design

The pages follow the Type led brand (Obsidian `Projects/Hecho/Brand/Type led.md`). The design file is `designs/landingpage.pen`. Fonts load from Bunny Fonts. `public/styles.css` is the old stylesheet and is no longer used.

## Structure

```
public/          static pages (home, charla, traduce, verbos, plus, privacidad), site.css and icons
src/worker.js    sign-up endpoint, then static files
wrangler.jsonc   Worker, domain, KV and email settings
tests/
```

## Leer

The Leer section of `/traduce/` lists real Spanish news from free feeds, with a level (Fácil, Medio, Difícil) and topics.

- The feeds are in `src/leer/feeds.js`. Every 15 minutes the Worker refreshes one feed, in turn, and saves the list in KV under `leer:articles` (in the SIGNUPS namespace).
- The level comes from the INFLESZ readability score of the headline and summary (`src/leer/level.js`). Topics come from the feed and a word list (`src/leer/topics.js`). No AI and no keys.
- The page reads `/api/leer`. The old `/traduce/leer/` address redirects to `/traduce/#leer`. Only the headline, link, source, date, level and topics are stored. Articles leave the list after three days.
