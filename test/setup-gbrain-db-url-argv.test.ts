// setup-gbrain keeps the gbrain database URL off the process command line.
//
// The URL carries the Postgres password. A value passed as an argument is
// readable by every local user through `ps` for as long as the process runs,
// so gstack passes credentials through env or a config file, never argv (the
// same rule lib/gbrain-supabase-provision.ts states for DB_PASS). The wireup
// helper already reads ~/.gbrain/config.json once at startup and pins it for
// every child gbrain call (covered in test/gstack-gbrain-source-wireup.test.ts),
// so no skill doc needs to hand it the URL.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_DIR = path.join(ROOT, 'setup-gbrain');
const SECTIONS_DIR = path.join(SKILL_DIR, 'sections');

const docs: Array<[string, string]> = [
  'SKILL.md.tmpl',
  'SKILL.md',
  ...fs
    .readdirSync(SECTIONS_DIR)
    .filter((f) => f.endsWith('.md.tmpl') || f.endsWith('.md'))
    .sort()
    .map((f) => path.join('sections', f)),
].map((rel) => [rel, fs.readFileSync(path.join(SKILL_DIR, rel), 'utf-8')]);

// One shell command: the helper name plus any backslash-continued lines.
const wireupCommand = /gstack-gbrain-source-wireup\b(?:[^\n]*\\\r?\n)*[^\n]*/g;

describe('setup-gbrain passes no database URL on argv', () => {
  test('the wireup command is still documented (guard is not vacuous)', () => {
    const invocations = docs.flatMap(([, text]) => text.match(wireupCommand) ?? []);
    expect(invocations.some((cmd) => cmd.includes('--strict'))).toBe(true);
  });

  test('no gstack-gbrain-source-wireup invocation carries --database-url', () => {
    const offenders = docs.flatMap(([rel, text]) =>
      (text.match(wireupCommand) ?? []).filter((cmd) => cmd.includes('--database-url')).map((cmd) => `${rel}: ${cmd}`),
    );
    expect(offenders).toEqual([]);
  });

  test('the wireup command clears ambient database URLs so config.json wins', () => {
    const lines = docs.flatMap(([rel, text]) =>
      text.split(/\r?\n/).filter((l) => /bin\/gstack-gbrain-source-wireup --strict/.test(l)).map((l) => `${rel}: ${l.trim()}`),
    );
    expect(lines.length).toBeGreaterThan(0);
    const offenders = lines.filter((l) => !/: GBRAIN_DATABASE_URL= DATABASE_URL= ~\/\.claude\//.test(l));
    expect(offenders).toEqual([]);
  });
});
