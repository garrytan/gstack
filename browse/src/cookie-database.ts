import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function databaseError(error: unknown): Error & { code: string } {
  const detail = error as { errcode?: number; errno?: number; code?: string } | null;
  const codes: Record<number, string> = {
    5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 8: 'SQLITE_READONLY', 10: 'SQLITE_IOERR',
    11: 'SQLITE_CORRUPT', 14: 'SQLITE_CANTOPEN', 26: 'SQLITE_CORRUPT',
  };
  const number = detail?.errcode ?? detail?.errno;
  const code = typeof number === 'number' ? codes[number & 255] ?? 'SQLITE_ERROR'
    : Object.values(codes).includes(detail?.code ?? '') ? detail!.code! : 'SQLITE_ERROR';
  const message = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    ? 'Cookie database is locked. Close the source browser and retry.'
    : 'Cookie database operation failed (' + code + ').';
  return Object.assign(new Error(message), { code });
}

export function openCookieDatabase(dbPath: string): {
  query(sql: string): { all(...bindings: any[]): unknown[] };
  close(): void;
} {
  const isBun = typeof process.versions.bun === 'string';
  let Database;
  try {
    const sqlite = require(isBun ? 'bun:sqlite' : 'node:sqlite');
    Database = isBun ? sqlite.Database : sqlite.DatabaseSync;
    if (typeof Database !== 'function') throw new Error();
  } catch {
    throw Object.assign(new Error(isBun
      ? 'Cookie import requires a Bun runtime with SQLite support. Upgrade Bun and retry.'
      : 'Cookie import requires Node.js 22.13 or newer with built-in SQLite enabled. Upgrade Node.js or enable SQLite and retry.'), { code: 'sqlite_unavailable' });
  }

  let database;
  try {
    database = new Database(dbPath, isBun ? { readonly: true, safeIntegers: true } : { readOnly: true });
  } catch (error) {
    throw databaseError(error);
  }

  return {
    query(sql) {
      let statement;
      try {
        statement = isBun ? database.query(sql) : database.prepare(sql);
        if (!isBun) statement.setReadBigInts(true);
      } catch (error) {
        throw databaseError(error);
      }
      return {
        all(...bindings) {
          try {
            return statement.all(...bindings).map((row: Record<string, unknown>) => Object.fromEntries(
              Object.entries(row).map(([key, value]) => [key,
                typeof value === 'bigint' && Number.isSafeInteger(Number(value)) ? Number(value) : value]),
            ));
          } catch (error) {
            throw databaseError(error);
          }
        },
      };
    },
    close() {
      try {
        database.close();
      } catch (error) {
        throw databaseError(error);
      }
    },
  };
}
