/**
 * No module-scope GSTACK_HOME assignment in any test file.
 *
 * Shard processes evaluate many test-file modules in one bun process, and a
 * module can be loaded before its tests run — so a module-scope
 * `process.env.GSTACK_HOME = ...` leaks into every sibling file in the
 * shard. The damage was real before the 2026-08 sweep: relink.test.ts:28
 * documents a "fresh install" test seeing a neighbor's skill_prefix, and
 * cdp-e2e once baked a sibling's temp dir into artifacts that outlived it
 * (dangling symlinks into a deleted render dir).
 *
 * The pattern is: save the original, assign in beforeAll, restore in
 * afterAll — confining the value to the file's execution window. See
 * browse/test/cdp-e2e.test.ts for the reference shape.
 *
 * Heuristic: repo test files write module-scope statements unindented, so a
 * column-0 assignment is module scope; indented assignments (inside hooks,
 * tests, or helpers) are fine.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function trackedTestFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '*.test.ts'], {
    cwd: ROOT, encoding: 'utf-8',
  });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter(Boolean);
}

describe('GSTACK_HOME module-scope tripwire', () => {
  test('no test file assigns process.env.GSTACK_HOME at module scope', () => {
    const files = trackedTestFiles();
    expect(files.length).toBeGreaterThan(100); // scan-rot guard

    const offenders: string[] = [];
    for (const rel of files) {
      const lines = fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/^(?:process\.env\.GSTACK_HOME|process\.env\.GSTACK_STATE_ROOT)\s*=[^=]/.test(line)) {
          offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(offenders,
      `module-scope env assignment leaks across shard siblings — move into beforeAll + restore in afterAll:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
