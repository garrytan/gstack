/**
 * C8 (#3018): the root router listed every skill and ends "When in doubt,
 * invoke the skill", so it routed to skills the user disabled. A render given
 * the install's disabled skills drops their routing rules and names them as
 * off; the canonical (committed) render is unchanged.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-router-disabled-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function router(host: 'claude' | 'codex', disabledSkills?: string[]) {
  const out = fs.mkdtempSync(path.join(tmp, `${host}-`));
  const r = await runGeneration({ host, outputRoot: out, disabledSkills });
  expect(r.exitCode).toBe(0);
  return fs.readFileSync(host === 'claude' ? path.join(out, 'SKILL.md') : path.join(out, '.agents/skills/gstack/SKILL.md'), 'utf8');
}

describe('C8: disabled skills leave the rendered router', () => {
  for (const host of ['claude', 'codex'] as const) {
    test(`${host}: routing rules drop disabled skills and keep the other side of an "A or B" rule`, async () => {
      const text = await router(host, ['retro', 'gstack-cso', '/careful', 'gstack-upgrade']);
      expect(text).toContain('Disabled on this install (never invoke or suggest them): `/retro`, `/cso`, `/careful`.');
      expect(text).not.toMatch(/→ invoke `\/retro`/);
      expect(text).not.toMatch(/→ invoke `\/cso`/);
      expect(text).toContain('careful mode → invoke `/guard`');
      expect(text).toContain('→ invoke `/gstack-upgrade`');
      expect(text).toContain('→ invoke `/ship`');
    });

    test(`${host}: no disabled skills renders the canonical router byte for byte`, async () => {
      expect(await router(host, [])).toBe(await router(host));
    });
  }

  test('the CLI flag rejects anything but skill names', () => {
    const r = spawnSync(process.execPath, ['scripts/gen-skill-docs.ts', '--host', 'claude', '--dry-run', '--disabled-skills', 'retro,$(touch x)'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--disabled-skills takes skill names');
  });
});
