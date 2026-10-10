import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1Database, applyMigrations, migratedD1, skip } from './helpers/d1.js';

const NOW = '2026-10-09T18:00:00.000Z';
const LATER = '2027-01-07T18:00:00.000Z';

/** @param {D1Database} db */
const addUser = (db) => db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)');
/** @param {D1Database} db */
const addSession = (db) => db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)');

/** A folder of migration files for one test. @param {Record<string, string>} files */
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'hecho-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

/** The columns of each index made with CREATE INDEX on a table, like 'email, created_at'. @param {D1Database} db @param {string} table */
async function indexes(db, table) {
  const { results } = await db.prepare(
    "SELECT l.name AS idx, c.name AS col FROM pragma_index_list(?) AS l JOIN pragma_index_info(l.name) AS c WHERE l.origin = 'c' ORDER BY l.name, c.seqno",
  ).bind(table).all();
  /** @type {Map<unknown, unknown[]>} */
  const byIndex = new Map();
  for (const r of results) byIndex.set(r.idx, [...(byIndex.get(r.idx) ?? []), r.col]);
  return [...byIndex.values()].map((cols) => cols.join(', ')).sort();
}

test('migrations apply in name order', { skip }, () => {
  // 0002 and 0010 need the table that 0001 makes.
  const dir = folder({
    '0010_index.sql': 'CREATE INDEX t_note ON t (note);',
    '0002_note.sql': 'ALTER TABLE t ADD COLUMN note TEXT;',
    '0001_t.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);',
    'notes.txt': 'Not SQL.',
  });
  try {
    assert.deepEqual(applyMigrations(new D1Database(), dir), ['0001_t.sql', '0002_note.sql', '0010_index.sql']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a migration that fails stops and leaves nothing behind', { skip }, async () => {
  const dir = folder({ '0001_bad.sql': 'CREATE TABLE half (id TEXT);\nSELEC nothing;' });
  try {
    const db = new D1Database();
    assert.throws(() => applyMigrations(db, dir), /0001_bad\.sql failed/);
    assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").first(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the migrations in migrations/ make the account tables and indexes', { skip }, async () => {
  const db = new D1Database();
  assert.ok(applyMigrations(db).includes('0001_accounts.sql'));
  const columns = {
    users: ['id', 'email', 'created_at', 'last_login_at'],
    login_codes: ['id', 'email', 'token_hash', 'code_hash', 'expires_at', 'used_at', 'attempts', 'created_at'],
    sessions: ['token_hash', 'user_id', 'created_at', 'expires_at', 'last_seen_at'],
  };
  for (const [table, names] of Object.entries(columns)) {
    const { results } = await db.prepare('SELECT name FROM pragma_table_info(?)').bind(table).all();
    assert.deepEqual(results.map((r) => r.name), names, table);
  }
  assert.deepEqual(await indexes(db, 'login_codes'), ['email, created_at', 'token_hash']);
  assert.deepEqual(await indexes(db, 'sessions'), ['user_id']);
  await db.prepare('INSERT INTO login_codes (id, email, token_hash, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('c1', 'ana@example.com', 'th', 'ch', LATER, NOW).run();
  assert.equal(await db.prepare('SELECT attempts FROM login_codes').first('attempts'), 0, 'attempts starts at 0');
});

test('an email belongs to one user, whatever its case', { skip }, async () => {
  const db = migratedD1();
  await addUser(db).bind('u1', 'ana@example.com', NOW).run();
  await assert.rejects(addUser(db).bind('u2', 'Ana@Example.COM', NOW).run(), /^Error: D1_ERROR: UNIQUE constraint failed: users\.email/);
  assert.equal(await db.prepare('SELECT id FROM users WHERE email = ?').bind('ANA@example.com').first('id'), 'u1');
});

test('deleting a user deletes their sessions, and a session needs a user', { skip }, async () => {
  const db = migratedD1();
  await db.batch([
    addUser(db).bind('u1', 'ana@example.com', NOW),
    addUser(db).bind('u2', 'luis@example.com', NOW),
    addSession(db).bind('h1', 'u1', NOW, LATER, NOW),
    addSession(db).bind('h2', 'u1', NOW, LATER, NOW),
    addSession(db).bind('h3', 'u2', NOW, LATER, NOW),
  ]);
  await db.prepare('DELETE FROM users WHERE id = ?').bind('u1').run();
  assert.deepEqual((await db.prepare('SELECT token_hash FROM sessions').all()).results, [{ token_hash: 'h3' }]);
  await assert.rejects(addSession(db).bind('h4', 'nobody', NOW, LATER, NOW).run(), /FOREIGN KEY constraint failed/);
});

test('first gives the first row, one of its values, or null', { skip }, async () => {
  const db = migratedD1();
  await addUser(db).bind('u1', 'ana@example.com', NOW).run();
  const byEmail = db.prepare('SELECT id, email, last_login_at FROM users WHERE email = ?');
  assert.deepEqual(await byEmail.bind('ana@example.com').first(), { id: 'u1', email: 'ana@example.com', last_login_at: null });
  assert.equal(await byEmail.bind('ana@example.com').first('id'), 'u1');
  assert.equal(await byEmail.bind('ana@example.com').first('last_login_at'), null);
  assert.equal(await byEmail.bind('nadie@example.com').first(), null);
  assert.equal(await byEmail.bind('nadie@example.com').first('id'), null);
  await assert.rejects(byEmail.bind('ana@example.com').first('name'), /^Error: D1_COLUMN_NOTFOUND: Column not found \(name\)$/);
});

test('all and run give success, meta and results like D1', { skip }, async () => {
  const db = migratedD1();
  const insert = await addUser(db).bind('u1', 'ana@example.com', NOW).run();
  assert.equal(insert.success, true);
  assert.deepEqual(insert.results, []);
  assert.deepEqual(Object.keys(insert.meta).sort(),
    ['changed_db', 'changes', 'duration', 'last_row_id', 'rows_read', 'rows_written', 'served_by', 'size_after']);
  assert.equal(insert.meta.changes, 1);
  assert.equal(insert.meta.changed_db, true);
  assert.ok(insert.meta.size_after > 0);

  const read = await db.prepare('SELECT id FROM users').all();
  assert.equal(read.success, true);
  assert.deepEqual(read.results, [{ id: 'u1' }]);
  assert.equal(read.meta.changes, 0, 'a read changes nothing, even right after a write');
  assert.equal(read.meta.changed_db, false);
  assert.deepEqual((await db.prepare('SELECT id FROM users').run()).results, [{ id: 'u1' }], 'run also gives rows');

  const update = db.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2');
  assert.equal((await update.bind(NOW, 'nobody').run()).meta.changes, 0);
  assert.equal((await update.bind(NOW, 'u1').run()).meta.changes, 1);

  // Like D1, a mistake in the SQL shows when the statement runs, not when it's prepared.
  const typo = db.prepare('SELEC id FROM users');
  await assert.rejects(typo.all(), /^Error: D1_ERROR: .*syntax error/);
});

test('bind gives a new statement and stores values the way D1 does', { skip }, async () => {
  const db = new D1Database();
  const value = db.prepare('SELECT ? AS v');
  assert.notEqual(value.bind(1), value);
  assert.equal(await value.bind(true).first('v'), 1);
  assert.equal(await value.bind(false).first('v'), 0);
  assert.equal(await value.bind(null).first('v'), null);
  assert.deepEqual(await value.bind(new Uint8Array([1, 2])).first('v'), [1, 2]);
  assert.throws(() => value.bind(undefined), /^Error: D1_TYPE_ERROR: Type 'undefined' not supported/);
  assert.throws(() => value.bind(10n), /^Error: D1_TYPE_ERROR: Type 'bigint' not supported/);
});

test('batch runs in one transaction and undoes it all when a statement fails', { skip }, async () => {
  const db = migratedD1();
  const count = db.prepare('SELECT count(*) AS n FROM users');
  const results = await db.batch([addUser(db).bind('u1', 'ana@example.com', NOW), count]);
  assert.equal(results.length, 2);
  assert.equal(results[0].meta.changes, 1);
  assert.deepEqual(results[1].results, [{ n: 1 }]);
  await assert.rejects(
    db.batch([addUser(db).bind('u2', 'luis@example.com', NOW), addUser(db).bind('u3', 'ANA@example.com', NOW)]),
    /UNIQUE constraint failed/);
  assert.equal(await count.first('n'), 1, 'luis was undone with the failed batch');
});

test('exec runs each line as a statement and counts them', { skip }, async () => {
  const db = new D1Database();
  const out = await db.exec('CREATE TABLE t (n INTEGER)\nINSERT INTO t VALUES (1)\nINSERT INTO t VALUES (2)');
  assert.equal(out.count, 3);
  assert.equal(typeof out.duration, 'number');
  assert.equal(await db.prepare('SELECT sum(n) AS s FROM t').first('s'), 3);
  // Like D1, a statement over two lines fails.
  await assert.rejects(db.exec('CREATE TABLE u (\n  n INTEGER\n)'), /^Error: D1_EXEC_ERROR: Error in line 1: CREATE TABLE u \(/);
});
