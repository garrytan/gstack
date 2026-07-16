/**
 * spec-template-sync: verify spec/SKILL.md.tmpl ↔ spec/SKILL.md stay in sync.
 *
 * Per codex T8 / eng plan: regen and assert no drift. Catches commits that
 * edit the template but forget to run `bun run gen:skill-docs`, or vice versa.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

describe('/spec template/generated sync', () => {
  test('regenerating spec/SKILL.md produces byte-identical output', () => {
    const generatedPath = path.join(ROOT, 'spec', 'SKILL.md');
    const before = fs.readFileSync(generatedPath);

    const res = spawnSync('bun', ['run', 'gen:skill-docs'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    expect(res.status).toBe(0);

    const after = fs.readFileSync(generatedPath);
    expect(after.equals(before)).toBe(true);
  }, 130_000);

  test('spec/SKILL.md is auto-generated header is present', () => {
    const generated = fs.readFileSync(path.join(ROOT, 'spec', 'SKILL.md'), 'utf-8');
    expect(generated).toMatch(/AUTO-GENERATED|do not edit directly/i);
  });
});
