// @ts-check
/**
 * npm run db:setup
 * Creates Hecho's D1 database in the EU, adds it to wrangler.jsonc as DB and creates the tables in migrations/.
 * Run it once. If wrangler.jsonc already has a database, it stops and changes nothing.
 */
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blankComments, parseJsonc } from './jsonc.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Finds the new database's id in what `wrangler d1 create` prints.
 * Wrangler prints the id in a config snippet: JSON ("database_id": "…") for wrangler.jsonc,
 * and TOML (database_id = "…") in older versions. Colour codes are ignored.
 * @param {string} output
 * @returns {string | null}
 */
export function findDatabaseId(output) {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  const named = /database_id["']?\s*[:=]\s*["']([^"']+)["']/.exec(text);
  if (named && IS_UUID.test(named[1])) return named[1];
  // No database_id line: accept the only id in the output, if there is exactly one.
  const ids = [...new Set((text.match(ANY_UUID) ?? []).map((id) => id.toLowerCase()))];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * True when the config has d1_databases anywhere, comments aside.
 * @param {string} text the contents of wrangler.jsonc
 */
export function hasDatabase(text) {
  return /"d1_databases"\s*:/.test(blankComments(text));
}

/**
 * Adds the DB binding as the last setting in wrangler.jsonc. It inserts text, so comments and layout stay.
 * @param {string} text the contents of wrangler.jsonc
 * @param {string} id the database id
 * @returns {string} the new contents
 */
export function addDatabase(text, id) {
  if (!IS_UUID.test(id)) throw new Error(`"${id}" is not a database id.`);
  if (hasDatabase(text)) throw new Error('wrangler.jsonc already has d1_databases.');
  const code = blankComments(text);
  const close = code.lastIndexOf('}');
  if (close === -1) throw new Error('wrangler.jsonc has no closing brace.');
  let end = close - 1;
  while (end >= 0 && /\s/.test(code[end])) end -= 1;
  const comma = code[end] === ',' || code[end] === '{' ? '' : ',';
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const block = [
    `${indent}// Accounts and other personal data: one D1 database, created in the EU (see migrations/).`,
    `${indent}"d1_databases": [`,
    `${indent}${indent}{ "binding": "DB", "database_name": "hecho", "database_id": "${id}", "migrations_dir": "migrations" }`,
    `${indent}]`,
  ].join('\n');
  const out = `${text.slice(0, end + 1)}${comma}${text.slice(end + 1, close).trimEnd()}\n${block}\n${text.slice(close)}`;
  const added = parseJsonc(out).d1_databases;
  if (added?.length !== 1 || added[0].database_id !== id) throw new Error('Could not add the database to wrangler.jsonc.');
  return out;
}

/**
 * Runs `npx wrangler@4 …` in the repo. With `capture`, it also keeps what Wrangler prints.
 * A captured run isn't a terminal, so Wrangler asks nothing and leaves wrangler.jsonc to this script.
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function wrangler(args, { capture = false } = {}) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return new Promise((resolve, reject) => {
    const child = spawn(npx, ['--yes', 'wrangler@4', ...args], {
      cwd: ROOT,
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** @param {string} message @returns {never} */
function stop(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

async function main() {
  if (hasDatabase(readFileSync(CONFIG, 'utf8'))) {
    stop('wrangler.jsonc already has a database (d1_databases), so nothing changed.\n'
      + 'To create any missing tables, run: npx wrangler@4 d1 migrations apply hecho --remote');
  }

  console.log('1/2 Creating the hecho database in the EU.\n');
  const created = await wrangler(['d1', 'create', 'hecho', '--jurisdiction=eu'], { capture: true });
  if (created.code !== 0) {
    stop('Wrangler could not create the database. Its message is above.\n'
      + 'If it mentions logging in or CLOUDFLARE_API_TOKEN, run npx wrangler@4 login, then npm run db:setup again.');
  }
  const id = findDatabaseId(created.output);
  if (!id) stop('Wrangler created the database, but its id is not in the output above. wrangler.jsonc did not change.');

  writeFileSync(CONFIG, addDatabase(readFileSync(CONFIG, 'utf8'), id));
  console.log(`\nAdded the database to wrangler.jsonc as DB (id ${id}).`);

  console.log('\n2/2 Creating the tables. Wrangler asks you to confirm.\n');
  const applied = await wrangler(['d1', 'migrations', 'apply', 'hecho', '--remote']);
  if (applied.code !== 0) {
    stop('The tables were not created. To try again, run: npx wrangler@4 d1 migrations apply hecho --remote');
  }
  console.log('\nDone. Commit the change to wrangler.jsonc.');
}

// Runs only when called as a script, so tests can import the functions above.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
