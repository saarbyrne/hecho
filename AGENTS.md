# AGENTS.md

How to work on Hecho. Read this before you pick up an issue.

## First steps

1. Read the Obsidian notes in `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Projects/Hecho/`. Start with `Hecho.md` (direction, apps, plan and status, decisions), then `Setup.md` (to-do list and commands). `Hecho+.md` covers the paid version, `Costs.md` the prices checked so far, `Brand/Type led.md` the brand, and `Reviews/` the code reviews and the grammar topic list.
2. If you can't open the vault, ask Saar to attach those files. Don't work from memory.
3. Read the issue and its epic. Check that every issue under "Depends on" is closed.
4. Follow the decisions written in the issue, in the epic and in `Hecho.md`. Saar's open product decisions are numbered in `Hecho.md` → Open decisions, and issues refer to them by number. Settled ones are dated lines under Decisions.
5. Decide technical questions yourself, and write down why in the issue or the pull request. Bring Saar only real product or UX questions.

## Repos

| Repo | What it is | Live at | Deploys by |
|---|---|---|---|
| `hecho` (this one) | Site, Worker, API, and the combined app in `public/app/` | hecho.fyi | `npm run deploy` |
| `verbos` | The first verb trainer, kept until people move | verbos.hecho.fyi | Push to `main` (GitHub Pages) |
| `charla` | The first conversation app, kept until people move | charla.hecho.fyi | Push to `main` (GitHub Pages) |
| `slugtranslate` | traduce, the Chrome extension | Chrome Web Store | Zip uploaded by Saar |

All four are in `~/Github_Personal/` and on github.com/saarbyrne. Issues for all of them live in this repo. From verbos, charla or slugtranslate, refer to an issue as `saarbyrne/hecho#12`, because a plain `#12` points at that repo's own issues.

## Layout

```
public/                  site pages, site.css and icons
public/app/              the combined app, served at hecho.fyi/app/
  lib/                   shared code: h.js, apps panel, account, sync
  verbos/  charla/  leer/  gramatica/
src/                     the Worker: routes, API and the Leer builder
src/account/tables.js    every table with personal data
migrations/              database schema, applied in order
tests/                   node --test (tests/app/ for the app)
scripts/                 precache and data scripts
designs/landingpage.pen  the design file (pen.dev)
```

The epics add some of these folders. Check the tree before you assume one exists.

## Commands

```sh
npm test                                            # all tests, nothing to install
npm run dev                                         # site, app and API at http://localhost:8787
npm run deploy                                      # publish hecho.fyi (Saar runs this)
npm run check:gemini                                # try the Gemini key in .dev.vars
npx wrangler@4 d1 migrations apply hecho --local    # local database
npx wrangler@4 d1 migrations apply hecho --remote   # live database (Saar runs this)
npx wrangler@4 secret put NAME                      # add a secret (Saar runs this)
```

You need Node 22.13 or later.

## Roles and handover

- Saar is a designer, not an engineer. Do the engineering work yourself.
- Batch the issues you take into one branch, for example `batch/accounts-login`.
- Don't commit, push or deploy unless he asks. He commits and deploys himself.
- When you finish, give him the exact Terminal commands as short numbered steps, with a few words on what each one does. For example:
  1. `cd ~/Github_Personal/hecho`
  2. `npm test` checks everything still works.
  3. `git add -A` then `git commit -m "Log in with an email link"` saves the changes.
  4. `git push -u origin batch/accounts-login` sends them to GitHub.
  5. `gh pr create --fill --body "Closes #12. Closes #13."` opens the pull request.
  6. After he merges: any migration, secret or `npm run deploy` the batch needs.
- If you couldn't create the branch yourself, start his steps with `git switch -c <branch>`.
- Assume he has only git, gh and Node installed, and say so when a step needs something else.
- Keep messages short and scannable, with a clear recommendation. Don't narrate what you did.

## Design rules

- Every UI change starts in `designs/landingpage.pen` (pen.dev). Saar signs off in the issue, then the code changes.
- Never delete or overwrite existing design work. Copy pages and change the copies.
- Make it clear which page is being redesigned. Line up its versions in a row next to the current screen: current, version 1, version 2.
- Show full screens in context, with numbered callouts and a notes panel beside them.
- In redesigns, keep every existing feature, and say clearly if anything moves or is removed.
- Reuse components across parts: the same table, filters, quiz and actions on equivalent screens.

## Brand

- Type led. Bricolage Grotesque for display (32 px and up), Instrument Sans for text, JetBrains Mono for labels, tables, counts and dates.
- One colour per app: Rojo #FF4B2B for verbos, Azul #2F4BFF for charla, Amarillo #FFD60A for traduce and Leer, Ink #141414 for hecho and hecho+. Neutrals: Paper #FFFFFF, Tiza #F2F2EF, Gris #6E6E6E, Línea #E3E3DE.
- No rounded corners, no shadows and no dark borders on cards.
- No widows: a heading or paragraph never ends with one word alone on its last line.
- No explanatory text inside the UI.
- The level scale is Fácil, Medio, Difícil everywhere. Never show A1 to C2.
- Only describe features that exist. No slogans, and no streaks, points or game language.

## Code

- Plain JavaScript modules with `// @ts-check` and JSDoc types. No framework and no build step in the app.
- The Worker has no npm dependencies. If you need one, write down why in the issue first.
- Every logic change gets a test. Run `npm test` before you hand over.
- Phone first: check every screen at 375 px wide.
- After adding or removing app files, run the precache script. The service worker never caches `/api/`.
- A new migration takes the next free number in `migrations/`. Issues don't fix the numbers, because they can be merged in any order.

## Security

- Never commit secrets. Secrets go in with `npx wrangler@4 secret put`. Local values go in `.dev.vars`, which git ignores.
- Never put a real key in the design file or in screenshots. Show key fields with dots. GitHub blocks any push that contains a key.
- The Gemini key stays on the server. The Worker makes the Gemini calls, and the browser never gets the key or a token for it.
- Store log-in tokens and session ids only as hashes.
- Every table with a `user_id` column goes in `src/account/tables.js`, so it's included in the data download and the account delete. A test checks this.
- Don't log emails, transcripts, tokens or keys.
- When Hecho starts storing a new kind of personal data, or sends it to a new service, update the privacy page (`public/privacidad/`) in the same batch. Saar reads it before it goes live.

## Issues

Every issue stands alone, fits one agent session (about half a day) and uses this body:

```md
### Context
Why it exists, in two or three sentences, with links to the epic and notes. Part of #<epic>.

### Scope
What to change, naming repos and files.

### Done when
- [ ] A testable outcome

### Out of scope
What not to touch.

### Depends on
Issue numbers, or None.

### UI change
No. Or Yes, with the design in the pen.dev file signed off by Saar as the first step.
```

- Titles are plain words that make sense at a glance, for example "Log in with an email link". No internal jargon.
- Labels: one or more `area: …` labels and one size, `size: S` (up to two hours) or `size: M` (about half a day).
- Add a new issue to its epic as a sub-issue. `sub_issue_id` is the issue's id, which is different from its number:

```sh
id=$(gh api repos/saarbyrne/hecho/issues/<issue-number> --jq .id)
gh api --method POST repos/saarbyrne/hecho/issues/<epic-number>/sub_issues -F sub_issue_id=$id
```

## Notes

The Obsidian notes are the shared context between agents, so update them in the same batch as the code:

- New decisions as dated lines in `Hecho.md` → Decisions.
- To-dos ticked or added in `Setup.md`.
- Prices you checked, with the date and the source, in `Costs.md`.
