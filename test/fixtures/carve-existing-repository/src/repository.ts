import { Database } from 'bun:sqlite';

/** Private API used by the reconciliation CLI in this process. All access to
 * this SQLite table uses this repository; values are public numeric counters. */
export class CounterRepository {
  constructor(private readonly db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value REAL NOT NULL)');
  }
  private key(key: string): void {
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) throw new TypeError('Counter key must contain 1-128 characters');
  }
  get(key: string): number | undefined {
    this.key(key);
    return (this.db.query('SELECT value FROM counters WHERE key = ?').get(key) as { value: number } | null)?.value;
  }
  set(key: string, value: number): void {
    this.key(key);
    if (!Number.isFinite(value)) throw new TypeError('Counter value must be a finite number');
    this.db.query('INSERT INTO counters(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
