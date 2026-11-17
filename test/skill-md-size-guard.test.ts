/**
 * Generated SKILL.md size guard (#3199). Several agent runtimes and skill
 * loaders cap one SKILL.md at 100,000 characters; Hermes' skill editor refuses
 * every edit to a larger skill without naming the size. This free test renders
 * every host and fails when any generated SKILL.md is over the limit.
 *
 * Skills already over the limit are pinned at their exact size in
 * test/fixtures/skill-md-size-allowlist.json (a ratchet): growth past a pin
 * fails, and a shrink below a pin fails until the pin is lowered. The shared
 * preamble hoist (GSTA-96) already moved each tier 2+ skill's shared preamble
 * into sections/preamble.md.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts/index';

const ROOT = path.resolve(import.meta.dir, '..');
const ALLOWLIST_FILE = 'test/fixtures/skill-md-size-allowlist.json';

interface Allowlist {
  limit: number;
  pins: Record<string, number>;
}

function countChars(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function sizeViolations(sizes: Record<string, number>, allowlist: Allowlist): string[] {
  const { limit, pins } = allowlist;
  const violations: string[] = [];
  for (const [key, actual] of Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b))) {
    const [host, skill] = key.split('/');
    const pin = pins[key];
    const where = `host ${host}, skill ${skill}: ${actual} chars, limit ${limit}`;
    if (pin === undefined) {
      if (actual > limit) violations.push(`${where}, not pinned. Shrink it to ${limit} chars or fewer.`);
    } else if (actual > pin) {
      violations.push(`${where}, pinned at ${pin}: grew by ${actual - pin}. Shrink it back to ${pin} chars or fewer.`);
    } else if (actual < pin) {
      violations.push(actual > limit
        ? `${where}, pinned at ${pin}: shrank by ${pin - actual}. Lower the pin "${key}" to ${actual} in ${ALLOWLIST_FILE}.`
        : `${where}, pinned at ${pin}: now within the limit. Delete the pin "${key}" from ${ALLOWLIST_FILE}.`);
    }
  }
  for (const key of Object.keys(pins).sort()) {
    if (!(key in sizes)) violations.push(`pin "${key}" names no generated SKILL.md. Delete it from ${ALLOWLIST_FILE}.`);
  }
  return violations;
}

const SIZE_FIX = 'Fix: move skill-specific prose into sections/*.md that the skill reads on demand (on non-Claude hosts, also add the skill '
  + 'to CARVED_ON_EVERY_HOST in scripts/resolvers/sections.ts so its sections stop being inlined), or cut duplicated text; '
  + 'then run `bun run gen:skill-docs` and rerun this test. A pin may only go down: when a pinned skill shrinks, '
  + `lower its pin in ${ALLOWLIST_FILE} to the new size, and delete it once the skill is within the limit. `
  + 'Raising a pin is an owner decision.';

function renderAllHosts(outDir: string): Record<string, number> {
  const render = Bun.spawnSync(
    ['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', outDir],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 180_000 },
  );
  if (render.exitCode !== 0) {
    throw new Error(`gen-skill-docs --host all --out-dir failed (exit ${render.exitCode}):\n${render.stderr.toString()}`);
  }
  const sizes: Record<string, number> = {};
  for (const host of ALL_HOST_CONFIGS) {
    // Claude's tracked tree is what ships: an out-dir Claude render repoints
    // section paths into the render, so it is not byte-identical.
    const skillsRoot = host.name === 'claude' ? ROOT : path.join(outDir, host.hostSubdir, 'skills');
    const skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name);
    if (host.name === 'claude') skillDirs.push('.');
    for (const dir of skillDirs) {
      const file = path.join(skillsRoot, dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      if (host.name === 'claude' && !fs.existsSync(`${file}.tmpl`)) continue;
      sizes[`${host.name}/${dir === '.' ? 'gstack' : dir}`] = countChars(fs.readFileSync(file, 'utf-8'));
    }
  }
  return sizes;
}

describe('generated SKILL.md size guard (#3199)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-size-guard-'));
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  test('the ratchet flags over-limit, grown, shrunk, within-limit and stale entries', () => {
    const allowlist = { limit: 100, pins: { 'h/grew': 150, 'h/shrank': 150, 'h/under': 150, 'h/same': 150, 'h/gone': 150 } };
    const violations = sizeViolations({ 'h/new': 101, 'h/ok': 100, 'h/grew': 151, 'h/shrank': 149, 'h/under': 99, 'h/same': 150 }, allowlist);
    expect(violations).toEqual([
      'host h, skill grew: 151 chars, limit 100, pinned at 150: grew by 1. Shrink it back to 150 chars or fewer.',
      'host h, skill new: 101 chars, limit 100, not pinned. Shrink it to 100 chars or fewer.',
      `host h, skill shrank: 149 chars, limit 100, pinned at 150: shrank by 1. Lower the pin "h/shrank" to 149 in ${ALLOWLIST_FILE}.`,
      `host h, skill under: 99 chars, limit 100, pinned at 150: now within the limit. Delete the pin "h/under" from ${ALLOWLIST_FILE}.`,
      `pin "h/gone" names no generated SKILL.md. Delete it from ${ALLOWLIST_FILE}.`,
    ]);
    expect(countChars('é—x')).toBe(3);
  });

  test('every host\'s generated SKILL.md is within 100,000 chars or at its exact pin', () => {
    const allowlist: Allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, ALLOWLIST_FILE), 'utf-8'));
    expect(allowlist.limit).toBe(100_000);
    const sizes = renderAllHosts(outDir);
    for (const host of ALL_HOST_CONFIGS) {
      expect(Object.keys(sizes).some(key => key.startsWith(`${host.name}/`)), `no rendered skills for ${host.name}`).toBe(true);
    }
    const violations = sizeViolations(sizes, allowlist);
    if (violations.length > 0) {
      throw new Error(`${violations.length} generated SKILL.md size violation(s):\n  ${violations.join('\n  ')}\n${SIZE_FIX}`);
    }
  });
});
