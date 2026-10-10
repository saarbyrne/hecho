import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDatabase, findDatabaseId, hasDatabase } from '../scripts/db-setup.mjs';
import { parseJsonc } from '../scripts/jsonc.mjs';

const CONFIG = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const ID = '5f8a2c1e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const ENTRY = `{ "binding": "DB", "database_name": "hecho", "database_id": "${ID}", "migrations_dir": "migrations" }`;
const COMMENT = '// Accounts and other personal data: one D1 database, created in the EU (see migrations/).';

// What `wrangler d1 create` prints when its output goes to a script, from Wrangler's source on 9 Oct 2026.
const WRANGLER_4 = ` ⛅️ wrangler 4.42.0
───────────────────
✅ Successfully created DB 'hecho' in region WEUR
Created your new D1 database.

To access your new D1 Database in your Worker, add the following snippet to your configuration file:
{
  "d1_databases": [
    {
      "binding": "hecho",
      "database_name": "hecho",
      "database_id": "${ID}"
    }
  ]
}
? Would you like Wrangler to add it on your behalf?
🤖 Using fallback value in non-interactive context: no
`;

// Older versions printed TOML.
const WRANGLER_3 = `✅ Successfully created DB 'hecho' in region WEUR
Created your new D1 database.

[[d1_databases]]
binding = "DB" # i.e. available in your Worker on env.DB
database_name = "hecho"
database_id = "${ID}"
`;

test('findDatabaseId reads the id from what wrangler d1 create prints', () => {
  assert.equal(findDatabaseId(WRANGLER_4), ID);
  assert.equal(findDatabaseId(WRANGLER_3), ID);
  assert.equal(findDatabaseId(`\u001b[32m✅ Created\u001b[39m\n"database_id": "\u001b[33m${ID}\u001b[39m"`), ID, 'colour codes');
  assert.equal(findDatabaseId(`Created ${ID}.`), ID, 'the only id, with no database_id label');
});

test('findDatabaseId gives null when the id is missing or unclear', () => {
  assert.equal(findDatabaseId('✘ [ERROR] A database with that name already exists.'), null);
  assert.equal(findDatabaseId(`${ID} and 0b3f1c2e-6d7a-4e59-9a8b-1c2d3e4f5a6b`), null);
});

test('addDatabase adds DB to wrangler.jsonc and keeps its comments and settings', () => {
  const out = addDatabase(CONFIG, ID);
  const after = parseJsonc(out);
  assert.deepEqual(after.d1_databases, [{ binding: 'DB', database_name: 'hecho', database_id: ID, migrations_dir: 'migrations' }]);
  delete after.d1_databases;
  assert.deepEqual(after, parseJsonc(CONFIG));
  for (const line of CONFIG.split('\n').filter((l) => l.trim().startsWith('//'))) assert.ok(out.includes(line), line);
  assert.equal(hasDatabase(out), true);
});

test('addDatabase inserts after the last setting, with a comma only when one is missing', () => {
  const tidy = '{\n  "name": "x",\n  "observability": { "enabled": true } // on\n}\n';
  assert.equal(addDatabase(tidy, ID),
    `{\n  "name": "x",\n  "observability": { "enabled": true }, // on\n  ${COMMENT}\n  "d1_databases": [\n    ${ENTRY}\n  ]\n}\n`);

  // A trailing comma, a comment after the last setting, and strings that look like comments.
  const loose = '{\n  "vars": { "URL": "https://a.es//b", "CRON": "*/15 * * * *" },\n  /* one\n     two */\n  "observability": { "enabled": true },\n  // last\n}\n';
  assert.equal(addDatabase(loose, ID),
    `{\n  "vars": { "URL": "https://a.es//b", "CRON": "*/15 * * * *" },\n  /* one\n     two */\n  "observability": { "enabled": true },\n  // last\n  ${COMMENT}\n  "d1_databases": [\n    ${ENTRY}\n  ]\n}\n`);
});

test('addDatabase stops when wrangler.jsonc already has a database, or the id is wrong', () => {
  assert.throws(() => addDatabase('{ "d1_databases": [] }', ID), /already has d1_databases/);
  assert.throws(() => addDatabase('{ "env": { "staging": { "d1_databases": [] } } }', ID), /already has d1_databases/);
  assert.equal(hasDatabase('{\n  // "d1_databases": [],\n  "name": "x"\n}'), false, 'a commented-out database does not count');
  assert.throws(() => addDatabase(CONFIG, 'not-an-id'), /is not a database id/);
});

test('parseJsonc reads wrangler.jsonc and keeps // and */ inside strings', () => {
  const config = parseJsonc(CONFIG);
  assert.equal(config.name, 'hecho');
  assert.match(config.vars.STRIPE_URL, /^https:\/\/buy\.stripe\.com\//);
  assert.deepEqual(config.triggers.crons, ['*/15 * * * *']);
});
