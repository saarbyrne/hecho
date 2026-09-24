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

## Structure

```
public/          static pages, styles and icons
src/worker.js    sign-up endpoint, then static files
wrangler.jsonc   Worker, domain, KV and email settings
tests/
```
