import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dir, '../scripts/resolvers/review-army.ts'), 'utf8');

describe('semantic-first specialist selection', () => {
  test('hard triggers precede every changed-line shortcut', () => {
    const forced = source.indexOf('Explicit user-forced specialist');
    const auth = source.indexOf('auth hard trigger');
    const schema = source.indexOf('schema/data hard trigger');
    const contract = source.indexOf('contract hard trigger');
    const size = source.indexOf('size-based optional specialists');
    expect(forced).toBeGreaterThan(-1);
    expect(forced).toBeLessThan(auth);
    expect(auth).toBeLessThan(schema);
    expect(schema).toBeLessThan(contract);
    expect(contract).toBeLessThan(size);
    expect(source).toContain('SCOPE_ERROR');
    expect(source).toContain('not_assessed');
  });
});
