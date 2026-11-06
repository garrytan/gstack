/**
 * Mechanical retakes after review (GST-1560, founderstar#563). After two full passes a branch merged its base (7 base-only
 * paths) and retook its rules number 80 -> 81: one line in scripts/core/game.gd, save_version in 8 save fixtures under
 * fixtures/, and one golden. finish said "insert 5–11.5" while gstack-review-plan at the round cap said "done". A
 * retake the base policy declares under mechanical_retake, proven from the diff, now routes as mechanical with no review;
 * anything else in those files still routes as behavior, and the behavior STOP names the planner flag that agrees with it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMechanicalLines } from '../lib/ship-mechanical';
import { MECHANICAL_RETAKE_KEY_VERSION } from '../lib/ship-policy';
import { orderReceipt, validateReceipt } from '../lib/ship-receipt';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(180_000);
const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const GAME = (n: number, { top = '', bottom = '', ready = 'pass' } = {}) => ['extends Node', top, ...Array.from({ length: 8 }, (_, i) => `# rules note ${i + 1}`), `const RULE_NUMBERS := ${n}`,
  ...Array.from({ length: 8 }, (_, i) => `# engine note ${i + 1}`), `func _ready(): ${ready}`, bottom].filter(l => l !== '').join('\n') + '\n';
const SAVES = (n: number, odd: Record<number, number> = {}) => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`fixtures/saves/s${i + 1}.json`, `{\n  "name": "s${i + 1}",\n  "save_version": ${odd[i + 1] ?? n}\n}\n`]));
const GOLDEN = 'test/golden/rules.golden';
const REGEN = JSON.stringify({ entries: [{ id: 'rules-golden', command: `sed -n 's/^const RULE_NUMBERS := //p' scripts/core/game.gd | sed 's/^/rules=/' > ${GOLDEN}`, outputs: [GOLDEN], inputs: ['scripts/core/game.gd'] }] }) + '\n';
const POLICY = JSON.stringify({ mechanical_retake: [{ path: 'scripts/core/game.gd', template: 'const RULE_NUMBERS := {n}', fields: [{ glob: 'fixtures/saves/*.json', field: 'save_version' }], regen: ['rules-golden'] }], min_gstack_version: MECHANICAL_RETAKE_KEY_VERSION }) + '\n';
const behaviorStop = (p: string) => `STOP: behavior, tests or build inputs changed since review (${p}): insert 5–11.5 → 12–14 → 16 before Step 17; plan that Step 9 with gstack-review-plan --post-review, which at the round cap stops for the owner's grant of one scoped fix-check (stage 2.1)`;

/**
 * founderstar#563: the branch took 80 and was reviewed; the base then took 80 for another rule and added 7 files; the
 * branch merged the base and retook 81. `retake` overrides what the retake commit writes.
 */
function founderstar(retake: { game?: string; saves?: Record<string, string>; golden?: string } = {}, policy = true) {
  const f = shipFixture({ ...(policy ? { '.gstack/ship-policy.json': POLICY } : {}), '.gstack/generated.json': REGEN, 'scripts/core/game.gd': GAME(79), ...SAVES(79), [GOLDEN]: 'rules=79\n' },
    { 'scripts/core/game.gd': GAME(80, { bottom: 'func rule_80(): pass' }), ...SAVES(80), [GOLDEN]: 'rules=80\n' });
  ships.push(f);
  const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  f.advanceBase({ 'scripts/core/game.gd': GAME(80, { top: 'func rule_other(): pass' }), ...SAVES(80), [GOLDEN]: 'rules=80\n', ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`base/p${i + 1}.ts`, `export const p${i + 1} = ${i};\n`])) });
  expect(f.git('fetch', '-q', 'origin').status).toBe(0);
  const merged = f.git('merge', '-q', '--no-edit', 'origin/main');
  expect(merged.status, merged.stderr).toBe(0);
  f.write({ 'scripts/core/game.gd': retake.game ?? GAME(81, { top: 'func rule_other(): pass', bottom: 'func rule_80(): pass' }), ...SAVES(81), ...(retake.saves ?? {}), [GOLDEN]: retake.golden ?? 'rules=81\n' });
  f.commit('retake the rules number: 80 -> 81');
  const run = (extra: string[] = []) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--reviewed-base', reviewedBase, '--docs-post', post, '--lane', LANE, ...extra]);
  return { f, run };
}

describe('a declared mechanical retake after a base merge (GST-1560: founderstar#563)', () => {
  test('the base merge, the constant, 8 save fixtures and the golden bind without a new review, and the receipt lists them', () => {
    const { f, run } = founderstar();
    const r = run();
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 docs=0 metadata=0 tests=0 base=7 context=0 mechanical=10$/);
    expect(r.stdout).not.toContain('STOP: behavior');
    expect(r.stdout).not.toContain('scoped reader');
    const lines = r.stdout.split('\n').filter(l => l.startsWith('MECHANICAL: '));
    expect(lines).toContain('MECHANICAL: scripts/core/game.gd (constant 80 → 81)');
    expect(lines).toContain('MECHANICAL: fixtures/saves/s8.json (save_version 80 → 81)');
    expect(lines).toContain(`MECHANICAL: ${GOLDEN} (golden, regenerated by rules-golden)`);
    expect(lines).toHaveLength(10);
    expect(lineOf(r.stdout, 'DOCS')).toContain('fresh');

    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n\nRetake.\n');
    const unlisted = f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '563', '--base', 'main', '--body', body]);
    expect(unlisted.status).not.toBe(0);
    expect(unlisted.stderr).toContain('does not list "Mechanical retake: fixtures/saves/s1.json (save_version 80 → 81)"');
    fs.writeFileSync(body, '## Summary\n\n' + lines.map(l => `Mechanical retake: ${l.slice('MECHANICAL: '.length)}`).join('\n') + '\n');
    const listed = f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '563', '--base', 'main', '--body', body, '--json']);
    expect(listed.stderr).not.toContain('Mechanical retake');
    const recorded = readMechanicalLines(f.work, f.git('rev-parse', 'HEAD^{tree}').stdout.trim());
    expect(recorded).toEqual(lines.map(l => `Mechanical retake: ${l.slice('MECHANICAL: '.length)}`).sort());
    const receipt = orderReceipt({ schema_version: 1, head: 'a'.repeat(40), base: 'main', mechanical: recorded });
    expect(Object.keys(receipt).indexOf('mechanical')).toBeGreaterThan(0);
    expect(validateReceipt(receipt).filter(e => e.path.includes('mechanical'))).toEqual([]);
    expect(validateReceipt({ ...receipt, mechanical: [5] }).some(e => e.path.includes('mechanical'))).toBe(true);
    f.write({ 'README.md': '# Fx\n\nedited after finish\n' }); f.commit('docs: an edit after finish');
    expect(readMechanicalLines(f.work, f.git('rev-parse', 'HEAD^{tree}').stdout.trim())).toEqual([]);
  });

  test('one extra non-literal edit in the constant file routes as behavior, and so do the fixtures that hang on it', () => {
    const { run } = founderstar({ game: GAME(81, { top: 'func rule_other(): pass', bottom: 'func rule_80(): pass', ready: 'return' }) });
    const r = run();
    expect(r.status).toBe(3);
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=10 .* base=7 context=0$/);
    expect(r.stdout).toContain('ROUTE_MECHANICAL_REFUSED: scripts/core/game.gd changes more than the declared values since review');
    expect(r.stdout).toContain('ROUTE_MECHANICAL_REFUSED: fixtures/saves/s1.json its constant scripts/core/game.gd is not a proven retake');
    expect(lineOf(r.stdout, 'STOP')).toStartWith('STOP: behavior, tests or build inputs changed since review (');
  });

  test('a fixture holding a value other than the retaken constant routes as behavior; the rest stay mechanical', () => {
    const { run } = founderstar({ saves: SAVES(81, { 3: 82 }) });
    const r = run();
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=1 .* base=7 context=0 mechanical=9$/);
    expect(r.stdout).toContain("ROUTE_MECHANICAL_REFUSED: fixtures/saves/s3.json writes 82 into save_version where it held 80, not the constant's 80 → 81");
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('fixtures/saves/s3.json')]);
  });

  test('an undeclared file named like an Object.prototype key still routes as behavior beside a proven retake', () => {
    const { run } = founderstar({ saves: { constructor: '#!/bin/sh\necho changed after review\n' } });
    const r = run();
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=1 .* base=7 context=0 mechanical=10$/);
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop('constructor')]);
  });

  test('a golden its declared command does not regenerate byte-identically routes as behavior', () => {
    const { run } = founderstar({ golden: 'rules=81 (edited by hand)\n' });
    const r = run();
    expect(r.stdout).toContain(`ROUTE_MECHANICAL_REFUSED: ${GOLDEN} does not regenerate byte-identically from rules-golden (stale)`);
    expect([r.status, lineOf(r.stdout, 'STOP')]).toEqual([3, behaviorStop(GOLDEN)]);
  });

  test('without the base policy declaration the same retake routes as behavior, exactly as before', () => {
    const { run } = founderstar({}, false);
    const r = run();
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=10 .* base=7 context=0$/);
    expect(r.stdout).not.toContain('MECHANICAL');
  });

  test('a policy that declares a glob, two slots or a .gstack/ path as the constant is refused at load', () => {
    const f = shipFixture({ '.gstack/ship-policy.json': JSON.stringify({ mechanical_retake: [{ path: 'scripts/*.gd', template: 'const A := {n} {n}', fields: [{ glob: '.gstack/x.json', field: 'v' }], regen: [] }], min_gstack_version: MECHANICAL_RETAKE_KEY_VERSION }) + '\n' });
    ships.push(f);
    const v = f.run(path.join(BIN, 'gstack-ship-policy'), ['validate', '--json']);
    expect(v.status).not.toBe(0);
    for (const why of ['must be one literal file, not a glob', 'must hold exactly one {n}', 'glob must not name a path under .gstack/ or .github/']) expect(v.stdout + v.stderr).toContain(why);
  });
});

describe('finish and gstack-review-plan agree at the round cap (GST-1560)', () => {
  test('the behavior STOP names --post-review, and the planner then plans the owner\'s exit at the cap, never done', () => {
    const { f, run } = founderstar({ game: GAME(81, { top: 'func rule_other(): pass', bottom: 'func rule_80(): pass', ready: 'return' }) });
    expect(lineOf(run().stdout, 'STOP')).toContain('plan that Step 9 with gstack-review-plan --post-review, which at the round cap stops for the owner\'s grant of one scoped fix-check');
    const plan = (...a: string[]) => lineOf(f.run(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--adversarial-ran', ...a]).stdout, 'NEXT');
    expect(plan('--pass', '2', '--last', 'full')).toStartWith('NEXT: done');
    expect(plan('--pass', '2', '--last', 'full', '--post-review')).toStartWith('NEXT: stop (edits after the review bound (Step 16 stage 2.1)');
    expect(plan('--pass', '1', '--last', 'fix-check', '--fix-checks', '1', '--post-review')).toStartWith('NEXT: stop (edits after the review bound');
    expect(plan('--pass', '1', '--last', 'full', '--post-review')).toMatch(/^NEXT: (full|fix-check) \(edits after the review bound/);
    const stage2 = fs.readFileSync(path.join(ROOT, 'ship/SKILL.md.tmpl'), 'utf8').split('### 2. Choose the change route')[1]!.split('### 3.')[0]!;
    expect(stage2).toContain('--post-review');
  });
});
