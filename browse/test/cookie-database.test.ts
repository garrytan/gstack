import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCookieDatabase } from '../src/cookie-database';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookie-db-')));
const dbPath = path.join(root, 'Cookies');
const adapterPath = path.join(root, 'cookie-database.mjs');
const corruptPath = path.join(root, 'private-corrupt-fixture');
const missingPath = path.join(root, 'private-missing-fixture');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required for cookie database adapter tests');

beforeAll(() => {
  const database = new Database(dbPath);
  database.run('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, expires_utc INTEGER, has_expires INTEGER)');
  const insert = database.query('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)');
  insert.run('.fixture.test', 'large-expiry', new Uint8Array([0, 127, 255]), 13300000000000001n, 1);
  insert.run('.fixture.test', 'session', new Uint8Array([]), 0, 0);
  insert.run('.fixture.test', 'expired', new Uint8Array([]), 500, 1);
  insert.run('.other.test', 'other-session', new Uint8Array([]), 0, 0);
  database.close();
  chmodSync(dbPath, 0o600);
  writeFileSync(corruptPath, 'private-fixture-not-a-database', { mode: 0o600 });
  const source = readFileSync(path.resolve(import.meta.dir, '../src/cookie-database.ts'), 'utf8');
  writeFileSync(adapterPath, new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(source), { mode: 0o600 });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function runNode(source: string, flags: string[] = []) {
  const result = spawnSync(node!, ['--input-type=module', ...flags, '-e', source, pathToFileURL(adapterPath).href, dbPath, corruptPath, missingPath], {
    encoding: 'utf8', timeout: 10_000, env: {
      PATH: path.dirname(node!), HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
      NODE_NO_WARNINGS: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('cookie database runtime adapter', () => {
  test('reproduces the old Node null stub before cookie queries can run', () => {
    const result = runNode(`
      import { existsSync } from 'node:fs';
      const Database = null;
      let attemptedQuery = false;
      try {
        const database = new Database(process.argv[2], { readonly: true });
        attemptedQuery = true;
        database.query('SELECT host_key FROM cookies').all();
      } catch (error) {
        console.log(JSON.stringify({ fixtureExists: existsSync(process.argv[2]), error: error.name, attemptedQuery }));
      }
    `);
    expect(result).toEqual({ fixtureExists: true, error: 'TypeError', attemptedQuery: false });
  });

  test('Bun returns JSON-safe domain counts and preserves precise expiry integers and blobs', () => {
    const database = openCookieDatabase(dbPath);
    try {
      const domains = database.query('SELECT host_key AS domain, COUNT(*) AS count FROM cookies WHERE has_expires = 0 OR expires_utc > ? GROUP BY host_key ORDER BY count DESC').all(1000);
      expect(domains).toEqual([{ domain: '.fixture.test', count: 2 }, { domain: '.other.test', count: 1 }]);
      expect(JSON.parse(JSON.stringify(domains))).toEqual(domains);
      const rows = database.query('SELECT name, encrypted_value, expires_utc, has_expires FROM cookies WHERE host_key IN (?, ?) AND expires_utc = ?').all('fixture.test', '.fixture.test', 13300000000000001n) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].expires_utc).toBe(13300000000000001n);
      expect(rows[0].has_expires).toBe(1);
      expect(Array.from(rows[0].encrypted_value)).toEqual([0, 127, 255]);
    } finally {
      database.close();
    }
  });

  test('Node uses built-in SQLite even with a Bun server polyfill and preserves the same values', () => {
    const result = runNode(`
      globalThis.Bun = { fixturePolyfill: true };
      const { openCookieDatabase } = await import(process.argv[1]);
      const database = openCookieDatabase(process.argv[2]);
      try {
        const domains = database.query('SELECT host_key AS domain, COUNT(*) AS count FROM cookies WHERE has_expires = 0 OR expires_utc > ? GROUP BY host_key ORDER BY count DESC').all(1000);
        const rows = database.query('SELECT name, encrypted_value, expires_utc, has_expires FROM cookies WHERE host_key IN (?, ?) AND expires_utc = ?').all('fixture.test', '.fixture.test', 13300000000000001n);
        console.log(JSON.stringify({ domains, rowCount: rows.length, expiry: String(rows[0].expires_utc), expiryType: typeof rows[0].expires_utc,
          flag: rows[0].has_expires, blob: Array.from(rows[0].encrypted_value) }));
      } finally { database.close(); }
    `);
    expect(result).toEqual({ domains: [{ domain: '.fixture.test', count: 2 }, { domain: '.other.test', count: 1 }],
      rowCount: 1, expiry: '13300000000000001', expiryType: 'bigint', flag: 1, blob: [0, 127, 255] });
  });

  for (const runtime of ['Bun', 'Node']) {
    test(`${runtime} converts only integers inside the safe Number range`, () => {
      const sql = 'SELECT 9007199254740991 AS safe_positive, -9007199254740991 AS safe_negative, 9007199254740992 AS unsafe_positive, -9007199254740992 AS unsafe_negative, 9223372036854775807 AS maximum, 1.5 AS fractional, NULL AS empty';
      let row: any;
      if (runtime === 'Bun') {
        const database = openCookieDatabase(dbPath);
        try {
          row = database.query(sql).all()[0];
          row = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { type: typeof value, value: String(value) }]));
        } finally { database.close(); }
      } else {
        row = runNode(`
          const { openCookieDatabase } = await import(process.argv[1]);
          const database = openCookieDatabase(process.argv[2]);
          try {
            const row = database.query(${JSON.stringify(sql)}).all()[0];
            console.log(JSON.stringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { type: typeof value, value: String(value) }]))));
          } finally { database.close(); }
        `);
      }
      expect(row).toEqual({ safe_positive: { type: 'number', value: '9007199254740991' }, safe_negative: { type: 'number', value: '-9007199254740991' },
        unsafe_positive: { type: 'bigint', value: '9007199254740992' }, unsafe_negative: { type: 'bigint', value: '-9007199254740992' },
        maximum: { type: 'bigint', value: '9223372036854775807' }, fractional: { type: 'number', value: '1.5' }, empty: { type: 'object', value: 'null' } });
    });

    test(`${runtime} refuses database writes and leaves the source bytes unchanged`, () => {
      const before = readFileSync(dbPath);
      const writes = ["INSERT INTO cookies VALUES ('private-insert', 'attempt', NULL, 0, 0)",
        "UPDATE cookies SET name = 'private-update'", 'DELETE FROM cookies', 'CREATE TABLE private_created_table (value TEXT)'];
      let results: any[];
      if (runtime === 'Bun') {
        const database = openCookieDatabase(dbPath);
        try {
          results = writes.map(sql => {
            try { database.query(sql).all(); return { wrote: true }; }
            catch (error: any) { return { code: error.code, message: error.message }; }
          });
        } finally { database.close(); }
      } else {
        results = runNode(`
          const { openCookieDatabase } = await import(process.argv[1]);
          const database = openCookieDatabase(process.argv[2]);
          try {
            const results = ${JSON.stringify(writes)}.map(sql => {
              try { database.query(sql).all(); return { wrote: true }; }
              catch (error) { return { code: error.code, message: error.message }; }
            });
            console.log(JSON.stringify(results));
          } finally { database.close(); }
        `);
      }
      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result.code).toBe('SQLITE_READONLY');
        expect(result.message).not.toContain('private-');
        expect(result.message).not.toContain('private_created_table');
      }
      expect(readFileSync(dbPath)).toEqual(before);
    });

    test(`${runtime} keeps parameters bound instead of interpreting SQL-looking values`, () => {
      const value = ".fixture.test'; DROP TABLE cookies; --";
      let rows: unknown[];
      if (runtime === 'Bun') {
        const database = openCookieDatabase(dbPath);
        try {
          rows = database.query('SELECT name FROM cookies WHERE host_key = ?').all(value);
          expect(database.query('SELECT COUNT(*) AS count FROM cookies').all()).toEqual([{ count: 4 }]);
        } finally { database.close(); }
      } else {
        const result = runNode(`
          const { openCookieDatabase } = await import(process.argv[1]);
          const database = openCookieDatabase(process.argv[2]);
          try {
            const rows = database.query('SELECT name FROM cookies WHERE host_key = ?').all(${JSON.stringify(value)});
            console.log(JSON.stringify({ rows, counts: database.query('SELECT COUNT(*) AS count FROM cookies').all() }));
          } finally { database.close(); }
        `);
        rows = result.rows;
        expect(result.counts).toEqual([{ count: 4 }]);
      }
      expect(rows).toEqual([]);
    });

    test(`${runtime} supports a mutable close method for copied-profile cleanup`, () => {
      if (runtime === 'Bun') {
        const database = openCookieDatabase(dbPath);
        const close = database.close.bind(database);
        let cleanup = false;
        database.close = () => { close(); cleanup = true; };
        database.close();
        expect(cleanup).toBe(true);
        expect(() => database.query('SELECT 1').all()).toThrow();
      } else {
        expect(runNode(`
          const { openCookieDatabase } = await import(process.argv[1]);
          const database = openCookieDatabase(process.argv[2]);
          const close = database.close.bind(database);
          let cleanup = false;
          database.close = () => { close(); cleanup = true; };
          database.close();
          let closed = false;
          try { database.query('SELECT 1').all(); } catch { closed = true; }
          console.log(JSON.stringify({ cleanup, closed }));
        `)).toEqual({ cleanup: true, closed: true });
      }
    });

    test(`${runtime} sanitizes open, corrupt-database, query, and binding failures`, () => {
      const exercise = (open: typeof openCookieDatabase, missing: string, corrupt: string, valid: string) => {
        const results: { code: string; message: string }[] = [];
        for (const file of [missing, corrupt]) {
          let database: ReturnType<typeof openCookieDatabase> | undefined;
          try { database = open(file); database.query('SELECT * FROM cookies').all(); }
          catch (error: any) { results.push({ code: error.code, message: error.message }); }
          finally { database?.close(); }
        }
        const database = open(valid);
        try {
          try { database.query('SELECT private_query_sentinel FROM cookies').all(); }
          catch (error: any) { results.push({ code: error.code, message: error.message }); }
          try { database.query('SELECT ? AS value').all(Symbol('private-binding-sentinel')); }
          catch (error: any) { results.push({ code: error.code, message: error.message }); }
        } finally { database.close(); }
        return results;
      };
      const results = runtime === 'Bun' ? exercise(openCookieDatabase, missingPath, corruptPath, dbPath) : runNode(`
        const { openCookieDatabase } = await import(process.argv[1]);
        const exercise = ${exercise.toString()};
        console.log(JSON.stringify(exercise(openCookieDatabase, process.argv[4], process.argv[3], process.argv[2])));
      `);
      expect(results.map((result: any) => result.code)).toEqual(['SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'SQLITE_ERROR', 'SQLITE_ERROR']);
      expect(JSON.stringify(results)).not.toMatch(/private[-_]|Cookies|cookie-db-/);
      expect(existsSync(missingPath)).toBe(false);
    });
  }

  for (const failure of ['missing module', 'missing export']) {
    test(`Node import remains available without SQLite and cookie use fails safely (${failure})`, () => {
      const result = runNode(`
        import Module from 'node:module';
        const original = Module._load;
        let loads = 0;
        Module._load = function(name, ...args) {
          if (name === 'node:sqlite') {
            loads++;
            if (${JSON.stringify(failure)} === 'missing export') return {};
            throw new Error('private-module-error');
          }
          return original.call(this, name, ...args);
        };
        try {
          const { openCookieDatabase } = await import(process.argv[1]);
          const loadsAtImport = loads;
          try { openCookieDatabase(process.argv[2]); }
          catch (error) { console.log(JSON.stringify({ loadsAtImport, loads, code: error.code, message: error.message })); }
        } finally { Module._load = original; }
      `);
      expect(result.loadsAtImport).toBe(0);
      expect(result.loads).toBe(1);
      expect(result.code).toBe('sqlite_unavailable');
      expect(result.message).toContain('Node.js 22.13 or newer');
      expect(result.message).toContain('Upgrade Node.js or enable SQLite');
      expect(result.message).not.toContain('private-module-error');
      expect(result.message).not.toContain(dbPath);
    });
  }

  test('actual Node with SQLite disabled can import the module and gets version guidance only on cookie use', () => {
    const result = runNode(`
      const { openCookieDatabase } = await import(process.argv[1]);
      try { openCookieDatabase(process.argv[2]); }
      catch (error) { console.log(JSON.stringify({ imported: true, code: error.code, message: error.message })); }
    `, ['--no-experimental-sqlite']);
    expect(result.imported).toBe(true);
    expect(result.code).toBe('sqlite_unavailable');
    expect(result.message).toContain('Node.js 22.13 or newer');
    expect(result.message).toContain('Upgrade Node.js or enable SQLite');
    expect(result.message).not.toContain(dbPath);
  });
});
