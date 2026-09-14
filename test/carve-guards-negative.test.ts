/**
 * ET1 — guard-of-guards negative tests (GATE tier, free).
 *
 * Proves the guards actually BITE. The happy-path E1/E2 tests prove the real
 * skills pass; these prove a BROKEN carve fails. Without this, a logic bug in
 * checkOrdering/checkCompleteness would pass silently and protect nothing — the
 * exact silent-pass failure class this whole effort exists to kill.
 *
 * The checks take an injectable `root` (codex #5), so we point the REAL guard
 * functions at a temp fixture dir broken three ways — not at a wrapper.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CarveGuard } from './helpers/carve-guards';
import { checkOrdering, checkCompleteness, discoverCarvedSkills } from './helpers/carve-guard-checks';

let root = '';

/** Write a syntactically-valid carved skill under `root`. */
function writeCarve(skill: string, opts: { stop: boolean; autoGen: boolean; leakBody: boolean }) {
  const dir = path.join(root, skill);
  const secDir = path.join(dir, 'sections');
  fs.mkdirSync(secDir, { recursive: true });
  fs.writeFileSync(
    path.join(secDir, 'manifest.json'),
    JSON.stringify({ skill, sections: [{ id: 'body', file: 'body.md', title: 'Body', trigger: 'doing the work' }] }),
  );
  const header = opts.autoGen ? '<!-- AUTO-GENERATED -->\n' : '';
  fs.writeFileSync(path.join(secDir, 'body.md'), `${header}## Heavy Body\nThe real work lives here. MOVED_MARKER.\n`);
  const stopLine = opts.stop ? '> **STOP.** Before doing the work, Read `sections/body.md` and execute it.\n' : '';
  const leak = opts.leakBody ? 'MOVED_MARKER\n' : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `# ${skill}\n## Step 0: Setup\nstays here\n## Section index\n| When | Read |\n${stopLine}${leak}## EXIT PLAN MODE GATE\n`,
  );
}

const guardFor = (skill: string): CarveGuard => ({
  skill,
  expectedSections: ['body.md'],
  requiredReads: ['body.md'],
  scenario: 'do the work',
  staticInvariants: {
    mustStayInSkeleton: ['## Step 0: Setup'],
    mustMoveToSection: ['MOVED_MARKER'],
    gateAfterStop: 'EXIT PLAN MODE GATE',
  },
  maxSkeletonBytes: 999_999,
  minUnionBytes: 0,
  mustContain: [],
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'carve-neg-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('guard-of-guards — the guards bite (gate, free)', () => {
  test('a well-formed fixture carve passes checkOrdering (control)', () => {
    writeCarve('goodskill', { stop: true, autoGen: true, leakBody: false });
    expect(checkOrdering(root, guardFor('goodskill'))).toEqual([]);
    fs.rmSync(path.join(root, 'goodskill'), { recursive: true, force: true });
  });

  test('E2 fails when the STOP-Read directive is removed', () => {
    writeCarve('nostopskill', { stop: false, autoGen: true, leakBody: false });
    const failures = checkOrdering(root, guardFor('nostopskill'));
    expect(failures.some((f) => f.includes('no STOP-Read directive'))).toBe(true);
    fs.rmSync(path.join(root, 'nostopskill'), { recursive: true, force: true });
  });

  test('E2 fails when heavy body leaks back into the skeleton', () => {
    writeCarve('leakskill', { stop: true, autoGen: true, leakBody: true });
    const failures = checkOrdering(root, guardFor('leakskill'));
    expect(failures.some((f) => f.includes('still in the skeleton'))).toBe(true);
    fs.rmSync(path.join(root, 'leakskill'), { recursive: true, force: true });
  });

  test('E2 fails when a section is hand-edited (no AUTO-GENERATED header)', () => {
    writeCarve('handeditskill', { stop: true, autoGen: false, leakBody: false });
    const failures = checkOrdering(root, guardFor('handeditskill'));
    expect(failures.some((f) => f.includes('hand-edited'))).toBe(true);
    fs.rmSync(path.join(root, 'handeditskill'), { recursive: true, force: true });
  });

  test('E1 fails when a skill is carved on disk but missing from the registry', () => {
    writeCarve('unregisteredskill', { stop: true, autoGen: true, leakBody: false });
    // Discovery sees it...
    expect(discoverCarvedSkills(root)).toContain('unregisteredskill');
    // ...and completeness flags it as an unguarded carve.
    const failures = checkCompleteness(root);
    expect(failures.some((f) => f.includes('unregisteredskill') && f.includes('NOT in CARVE_GUARDS'))).toBe(true);
    fs.rmSync(path.join(root, 'unregisteredskill'), { recursive: true, force: true });
  });
});
