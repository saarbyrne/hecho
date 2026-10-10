// @ts-check
/**
 * Cloudflare D1 for tests, on Node's built-in SQLite (node:sqlite, Node 22.13 or later). No dependency.
 * Code under test can take a D1Database as env.DB. It copies the parts of D1's Worker API that Hecho uses:
 * prepare, bind, first, all, run, batch and exec. raw, dump and withSession are left out.
 *
 * Checked on 9 Oct 2026 against developers.cloudflare.com/d1/worker-api/ and workerd's d1-api.ts.
 * Differences from D1:
 * - meta has the fields that Wrangler's local D1 returns. The live D1 adds served_by_region,
 *   served_by_primary, timings and total_attempts.
 * - meta.rows_read is the number of rows returned and meta.rows_written is meta.changes.
 *   D1 counts the rows it scans and writes, so its numbers can be higher.
 * - meta.changed_db is true only when rows changed. D1 also sets it for CREATE and DROP.
 * - Errors start with D1_ERROR, then SQLite's own message. The live D1 can add more after it,
 *   for example ": SQLITE_CONSTRAINT". Match on SQLite's words, for example /UNIQUE constraint failed/.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {typeof import('node:sqlite') | null} */
let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  // Before Node 22.13, node:sqlite needs a flag or doesn't exist.
}

/** Use as a test option, `test(name, { skip }, fn)`. False when node:sqlite works. */
export const skip = sqlite ? false : 'needs Node 22.13 or later';

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** @typedef {null | number | string | Uint8Array} SqlValue */
/**
 * @typedef {object} D1Meta
 * @property {string} served_by
 * @property {number} duration       milliseconds
 * @property {number} changes        rows changed by the statement itself
 * @property {number} last_row_id
 * @property {boolean} changed_db
 * @property {number} size_after     bytes
 * @property {number} rows_read
 * @property {number} rows_written
 */
/**
 * @typedef {object} D1Result
 * @property {boolean} success
 * @property {D1Meta} meta
 * @property {Record<string, unknown>[]} results
 */

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Turns a value into what SQLite stores, the way D1's bind() does.
 * @param {unknown} value
 * @returns {SqlValue}
 */
function toSql(value) {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return Uint8Array.from(value);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`);
}

/**
 * A row as D1 gives it: a plain object, with BLOBs as arrays of bytes.
 * @param {Record<string, unknown>} row
 */
function toRow(row) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [column, value] of Object.entries(row)) out[column] = value instanceof Uint8Array ? [...value] : value;
  return out;
}

export class D1PreparedStatement {
  /** @param {D1Database} db @param {string} sql @param {SqlValue[]} [params] */
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  /**
   * A new statement with these values for ? or ?1, ?2… The statement it's called on doesn't change.
   * Throws D1_TYPE_ERROR straight away for undefined, bigint and other values D1 can't store.
   * @param {...unknown} values
   */
  bind(...values) {
    return new D1PreparedStatement(this.db, this.sql, values.map(toSql));
  }

  /**
   * The first row, or the value of one column in it. Null when there are no rows.
   * @param {string} [column]
   * @returns {Promise<any>}
   */
  async first(column) {
    const row = execute(this).results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (row[column] === undefined) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  /** Every row, with success and meta. @returns {Promise<D1Result>} */
  async all() {
    return execute(this);
  }

  /** The same as all(), as D1's docs describe. Writes give `results: []`. @returns {Promise<D1Result>} */
  async run() {
    return execute(this);
  }
}

export class D1Database {
  /** @param {string} [path] a file, or ':memory:' (the default) for a database that lives in memory */
  constructor(path = ':memory:') {
    if (!sqlite) throw new Error('node:sqlite needs Node 22.13 or later');
    /** The node:sqlite database underneath, for setting up tests. Code under test uses the D1 methods. */
    this.sqlite = new sqlite.DatabaseSync(path);
    // D1 enforces foreign keys, so ON DELETE CASCADE works.
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  /**
   * Like D1, the SQL is only checked when the statement runs.
   * @param {string} sql
   */
  prepare(sql) {
    return new D1PreparedStatement(this, sql);
  }

  /**
   * Runs the statements in one transaction and gives one result each, in order.
   * If one fails, the whole batch is undone and the promise rejects, as D1 documents.
   * @param {D1PreparedStatement[]} statements
   * @returns {Promise<D1Result[]>}
   */
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => execute(statement));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Runs SQL with no values. Like D1, each line runs as its own statement, so a statement must fit on one line.
   * @param {string} query
   * @returns {Promise<{ count: number, duration: number }>}
   */
  async exec(query) {
    const lines = query.trim().split('\n');
    const start = performance.now();
    lines.forEach((line, i) => {
      try {
        this.sqlite.exec(line);
      } catch (err) {
        const message = `D1_EXEC_ERROR: Error in line ${i + 1}: ${line}: ${messageOf(err)}`;
        throw new Error(message, { cause: err });
      }
    });
    return { count: lines.length, duration: performance.now() - start };
  }

  close() {
    this.sqlite.close();
  }
}

/**
 * Runs one statement and returns D1's result shape.
 * @param {D1PreparedStatement} statement
 * @returns {D1Result}
 */
function execute({ db, sql, params }) {
  const start = performance.now();
  const before = total(db);
  /** @type {Record<string, unknown>[]} */
  let rows;
  try {
    rows = /** @type {Record<string, unknown>[]} */ (db.sqlite.prepare(sql).all(...params));
  } catch (err) {
    throw new Error(`D1_ERROR: ${messageOf(err)}`, { cause: err });
  }
  const duration = performance.now() - start;
  const info = /** @type {{ changes: number, rowid: number, size: number }} */ (db.sqlite.prepare(
    'SELECT changes() AS changes, last_insert_rowid() AS rowid, page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
  ).get());
  // changes() still holds the last write's count after a SELECT, so only use it when this statement changed rows.
  const changes = total(db) > before ? info.changes : 0;
  return {
    success: true,
    meta: {
      served_by: 'node:sqlite',
      duration,
      changes,
      last_row_id: changes ? info.rowid : 0,
      changed_db: changes > 0,
      size_after: info.size,
      rows_read: rows.length,
      rows_written: changes,
    },
    results: rows.map(toRow),
  };
}

/** @param {D1Database} db */
function total(db) {
  return /** @type {{ n: number }} */ (db.sqlite.prepare('SELECT total_changes() AS n').get()).n;
}

/**
 * Runs every .sql file in a folder, in name order, like `wrangler d1 migrations apply`.
 * Each file runs in one transaction, so a file that fails leaves nothing behind.
 * @param {D1Database} db
 * @param {string} [dir] the repo's migrations/ folder by default
 * @returns {string[]} the file names, in the order they ran
 */
export function applyMigrations(db, dir = MIGRATIONS) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    db.sqlite.exec('BEGIN');
    try {
      db.sqlite.exec(readFileSync(join(dir, file), 'utf8'));
      db.sqlite.exec('COMMIT');
    } catch (err) {
      db.sqlite.exec('ROLLBACK');
      throw new Error(`${file} failed: ${messageOf(err)}`, { cause: err });
    }
  }
  return files;
}

/** A new in-memory database with every migration in migrations/ applied. */
export function migratedD1() {
  const db = new D1Database();
  applyMigrations(db);
  return db;
}
