/**
 * Godot 4 UID sidecars after review (GST-1604, founderstar#611) and base-declared test code. founderstar#611's owner
 * granted a fix-check, CI then forced one more scripts/ui/cutscene.gd edit (owner-accepted under the review-loop
 * exception), and lint wanted tests/cutscene_check.gd.uid: the one-line UID sidecar of a test script the PR added before
 * review, committed after the fix-check. No route took it, so a one-line random id cost another fix-check or a fresh /ship.
 * A sidecar finish proves from the tree now routes as sidecar=, with no reader; every other .uid keeps its old route with a
 * ROUTE_SIDECAR_REFUSED reason. GDScript tests (tests/*_check.gd) match no built-in test glob, so a base policy can declare
 * them under test_code; a head-only declaration changes nothing.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMechanicalLines } from '../lib/ship-mechanical';
import { isTestCode } from '../lib/ship-patch';
import { REVIEW_EXCLUDE_KEY_VERSION, TEST_CODE_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { READERS_KEY_VERSION } from '../lib/ship-policy-keys';
import { isGodotUidText } from '../lib/ship-sidecar';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(180_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); ships.push(f); return f; };
const wtree = (f: ShipFx) => f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
const head = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const snapshot = (f: ShipFx) => {
  const out = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  return out;
};
const exceptionFile = (f: ShipFx, fixHead: string) => {
  const file = path.join(f.root, 'loop-exception.json');
  fs.writeFileSync(file, JSON.stringify({ accepted_by: 'GStack Minder (rule 23 grant)', date: '2026-11-06', via: 'GSTA-36', reason: 'the CI fix after the granted fix-check, then ship', fix_check: { head: fixHead, findings: 1 } }));
  return file;
};
const behaviorStop = (p: string) => `STOP: behavior, tests or build inputs changed since review (${p}): insert 5–11.5 → 12–14 → 16 before Step 17; plan that Step 9 with gstack-review-plan --post-review, which at the round cap stops for the owner's grant of one scoped fix-check (stage 2.1)`;
const UID = 'uid://cecaux1sm7mo\n';
const SIDECAR = 'tests/cutscene_check.gd.uid';
const CUTSCENE = (extra = '') => `extends Node\nfunc play(): return\n${extra}`;
const CHECK = 'extends SceneTree\nfunc _init():\n\tassert(true)\n\tquit()\n';

interface Shape { after?: (f: ShipFx) => void; base?: Record<string, string>; feat?: Record<string, string>; fixRange?: Record<string, string> }
/**
 * founderstar#611: the PR edits scripts/ui/cutscene.gd and adds tests/cutscene_check.gd, and the review reads them; the
 * granted fix-check reads them and `fixRange` at fixHead; then one commit edits cutscene.gd again and adds what `after`
 * writes (the sidecar).
 */
function founderstar611({ after = f => f.write({ [SIDECAR]: UID }), base = {}, feat = {}, fixRange }: Shape = {}) {
  const f = fx({ 'scripts/ui/cutscene.gd': 'extends Node\nfunc play(): pass\n', ...base }, { 'scripts/ui/cutscene.gd': CUTSCENE(), 'tests/cutscene_check.gd': CHECK, ...feat });
  const reviewed = wtree(f);
  const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  const post = snapshot(f);
  if (fixRange) { f.write(fixRange); f.commit('a fix inside the granted fix-check'); }
  const fixHead = head(f);
  f.write({ 'scripts/ui/cutscene.gd': CUTSCENE('func skip(): pass\n') });
  after(f);
  f.commit('the CI fix after the fix-check, and the UID sidecar lint asks for');
  const run = () => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--reviewed-base', reviewedBase, '--docs-post', post, '--lane', LANE, '--review-loop-exception', `@${exceptionFile(f, fixHead)}`]);
  return { f, run };
}

describe('isGodotUidText pins what Godot 4 writes for one UID', () => {
  test('canonical ids with or without the trailing newline, from 0 to 2^63-1', () => {
    for (const t of [UID, 'uid://cecaux1sm7mo', 'uid://a\n', 'uid://b\n', 'uid://d4n4ub6itg400\n']) expect([t, isGodotUidText(t)]).toEqual([t, true]);
  });
  test('anything else: past 2^63-1, z or 9, a leading zero digit, CRLF, a second line, spaces, an empty or invalid id', () => {
    for (const t of ['uid://d4n4ub6itg401\n', 'uid://cecaux1sm7mz\n', 'uid://cecaux1sm7m9\n', 'uid://acecaux1sm7mo\n', 'uid://cecaux1sm7mo\r\n', UID + 'uid://b\n',
      UID + '\n', ' ' + UID, 'uid://cecaux1sm7mo \n', 'UID://cecaux1sm7mo\n', 'uid://\n', 'uid:// \n', 'uid://<invalid>\n', '', 'uid://cecaux1sm7mobb\n']) expect([t, isGodotUidText(t)]).toEqual([t, false]);
  });
});

describe('a Godot UID sidecar added after the fix-check (GST-1604: founderstar#611)', () => {
  test('the #611 shape binds with no reader, and the receipt and the PR body list the sidecar', () => {
    const { f, run } = founderstar611({ feat: { 'scenes/cutscene_check.tscn': `[gd_scene load_steps=2 format=3 uid="uid://b4w2kq0ly8s5n"]\n\n[ext_resource type="Script" uid="${UID.trim()}" path="res://tests/cutscene_check.gd" id="1"]\n` } });
    const r = run();
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 docs=0 metadata=0 tests=0 base=\d+ context=0 accepted=1 sidecar=1$/);
    expect(lineOf(r.stdout, 'UID_SIDECAR')).toBe(`UID_SIDECAR: ${SIDECAR} (beside tests/cutscene_check.gd)`);
    expect(r.stdout).not.toContain('scoped reader');
    expect([r.status, lineOf(r.stdout, 'EVIDENCE')]).toEqual([0, expect.stringMatching(/^EVIDENCE: FRESH label=tests /)]);
    const line = `Godot UID sidecar: ${SIDECAR} (beside tests/cutscene_check.gd)`;
    expect(readMechanicalLines(f.work, f.git('rev-parse', 'HEAD^{tree}').stdout.trim())).toEqual([line]);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n\nCI fix.\n');
    const unlisted = f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '611', '--base', 'main', '--body', body]);
    expect([unlisted.status === 0, unlisted.stderr]).toEqual([false, expect.stringContaining(`does not list ${JSON.stringify(line)}`)]);
    fs.writeFileSync(body, `## Summary\n\nCI fix.\n\n${line}\n`);
    expect(f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '611', '--base', 'main', '--body', body, '--json']).stderr).not.toContain('Godot UID sidecar');
  });

  test('a sidecar beside a script only the review-loop exception accepted binds too', () => {
    const { run } = founderstar611({ fixRange: { 'scripts/ui/skip.gd': 'extends Node\n' }, after: f => f.write({ 'scripts/ui/skip.gd': 'extends Node\nfunc skip(): pass\n', 'scripts/ui/skip.gd.uid': 'uid://b4w2kq0ly8s5n\n' }) });
    const r = run();
    expect(lineOf(r.stdout, 'ROUTE'), r.stdout).toMatch(/ behavior=0 .* accepted=2 sidecar=1$/);
    expect(lineOf(r.stdout, 'UID_SIDECAR')).toBe('UID_SIDECAR: scripts/ui/skip.gd.uid (beside scripts/ui/skip.gd)');
    expect(r.status).toBe(0);
  });

  test('a .uid with no reviewed sibling, a second line, a symlink, an executable or a changed UID refuses and stops as behavior', () => {
    const cases: [string, string, (f: ShipFx) => void, Record<string, string>?, Record<string, string>?][] = [
      ['scripts/menu.gd.uid', 'has no sibling scripts/menu.gd that the reviewed range added or modified or the review-loop exception accepted', f => f.write({ 'scripts/menu.gd.uid': UID }), { 'scripts/menu.gd': 'extends Node\n' }],
      ['tests/ghost.gd.uid', 'has no sibling tests/ghost.gd', f => f.write({ 'tests/ghost.gd.uid': UID })],
      [SIDECAR, 'is not exactly one Godot uid://<id> line', f => f.write({ [SIDECAR]: UID + 'uid://b\n' })],
      [SIDECAR, 'is not a regular non-executable file (mode 120000)', f => fs.symlinkSync('cutscene_check.gd', path.join(f.work, SIDECAR))],
      [SIDECAR, 'is not a regular non-executable file (mode 100755)', f => { f.write({ [SIDECAR]: UID }); fs.chmodSync(path.join(f.work, SIDECAR), 0o755); }],
      ['scripts/ui/cutscene.gd.uid', 'existed at the reviewed tree or the current base', f => f.write({ 'scripts/ui/cutscene.gd.uid': 'uid://b4w2kq0ly8s5n\n' }), { 'scripts/ui/cutscene.gd.uid': UID }],
      [SIDECAR, 'shares its UID with scripts/old.gd.uid', f => f.write({ [SIDECAR]: UID }), { 'scripts/old.gd': 'extends Node\n', 'scripts/old.gd.uid': UID }],
      [SIDECAR, 'shares its UID with scenes/menu.tscn', f => f.write({ [SIDECAR]: UID }), { 'scenes/menu.tscn': `[gd_scene load_steps=1 format=3 uid="${UID.trim()}"]\n` }],
      [SIDECAR, 'shares its UID with assets/icon.png.import', f => f.write({ [SIDECAR]: UID }), { 'assets/icon.png.import': `[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\nuid="${UID.trim()}"\n` }],
    ];
    for (const [p, why, after, base, feat] of cases) {
      const r = founderstar611({ after, base, feat }).run();
      expect([why, r.status, lineOf(r.stdout, 'STOP')]).toEqual([why, 3, behaviorStop(p)]);
      expect([why, lineOf(r.stdout, 'ROUTE_SIDECAR_REFUSED')]).toEqual([why, expect.stringContaining(`ROUTE_SIDECAR_REFUSED: ${p} ${why}`)]);
      expect(r.stdout).not.toContain('UID_SIDECAR:');
    }
  });

  test('a sidecar the base policy excludes from review refuses; a .import file routes as before, with no sidecar line', () => {
    const excluded = founderstar611({ base: { '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: ['tests/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' } }).run();
    expect([excluded.status, lineOf(excluded.stdout, 'ROUTE_SIDECAR_REFUSED')]).toEqual([3, expect.stringContaining('review_exclude_paths')]);
    const imported = founderstar611({ after: f => f.write({ 'tests/icon.png.import': '[remap]\n\nimporter="texture"\nuid="uid://cecaux1sm7mo"\n' }) }).run();
    expect([imported.status, lineOf(imported.stdout, 'STOP')]).toEqual([3, behaviorStop('tests/icon.png.import')]);
    expect(imported.stdout).not.toMatch(/UID_SIDECAR|ROUTE_SIDECAR_REFUSED/);
  });

  test('a sidecar beside a readers.forbid_paths script, or beside an excluded script with a non-ASCII name, refuses too', () => {
    const forbidden = founderstar611({ base: { '.gstack/ship-policy.json': JSON.stringify({ readers: { forbid_paths: ['tests'] }, min_gstack_version: READERS_KEY_VERSION }) + '\n' } }).run();
    expect([forbidden.status, lineOf(forbidden.stdout, 'ROUTE_SIDECAR_REFUSED')]).toEqual([3, expect.stringContaining(`ROUTE_SIDECAR_REFUSED: ${SIDECAR} or its sibling matches`)]);
    const accented = founderstar611({ base: { '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: ['tests/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' }, feat: { 'tests/menü_check.gd': CHECK }, after: f => f.write({ 'tests/menü_check.gd.uid': UID }) }).run();
    expect([accented.status, lineOf(accented.stdout, 'ROUTE_SIDECAR_REFUSED')]).toEqual([3, expect.stringContaining('ROUTE_SIDECAR_REFUSED: tests/menü_check.gd.uid or its sibling matches')]);
    expect(accented.stdout).not.toContain('UID_SIDECAR:');
  });
});

describe('base-declared test_code (GST-1604: GDScript tests)', () => {
  const POLICY = JSON.stringify({ test_code: ['tests/**/*.gd'], min_gstack_version: TEST_CODE_KEY_VERSION }) + '\n';

  test('a declared glob counts as test code, shared helpers and fixtures still excepted', () => {
    expect(isTestCode('tests/cutscene_check.gd')).toBe(false);
    expect(isTestCode('tests/cutscene_check.gd', ['tests/**/*.gd'])).toBe(true);
    expect(isTestCode('tests/ui/menu_check.gd', ['tests/**/*.gd'])).toBe(true);
    expect(isTestCode('tests/helpers/fake_input.gd', ['tests/**/*.gd'])).toBe(false);
    expect(isTestCode('scripts/ui/cutscene.gd', ['tests/**/*.gd'])).toBe(false);
    expect(isTestCode('src/a.test.ts', ['tests/**/*.gd'])).toBe(true);
    expect(isTestCode('.github/workflows/release.yml', ['**/*.yml'])).toBe(false);
    expect(isTestCode('.gstack/ship-policy.yml', ['**/*.yml'])).toBe(false);
    expect(isTestCode('tests/fixtures.yml', ['**/*.yml'])).toBe(true);
  });

  test('the key validates as a glob list behind min_gstack_version, never under .gstack/ or .github/', () => {
    expect(validatePolicy(JSON.parse(POLICY))).toEqual([]);
    expect(validatePolicy({ test_code: ['tests/**/*.gd'] }).map(e => e.message)).toEqual([expect.stringContaining(`set min_gstack_version to ${TEST_CODE_KEY_VERSION}`)]);
    expect(validatePolicy({ test_code: ['.github/**/*.gd'], min_gstack_version: TEST_CODE_KEY_VERSION }).map(e => e.path)).toEqual(['test_code[0]']);
    expect(validatePolicy({ test_code: 'tests/**', min_gstack_version: TEST_CODE_KEY_VERSION }).map(e => e.path)).toEqual(['test_code']);
  });

  /** The PR adds tests/menu_check.gd before review; after review one more check is appended. */
  const appended = (base: Record<string, string>, feat: Record<string, string> = {}) => {
    const f = fx(base, { 'tests/menu_check.gd': CHECK, ...feat });
    const reviewed = wtree(f);
    const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
    const post = snapshot(f);
    f.write({ 'tests/menu_check.gd': CHECK + 'func test_menu():\n\tassert(1 + 1 == 2)\n' }); f.commit('one more check after review');
    return f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--reviewed-base', reviewedBase, '--docs-post', post, '--lane', LANE]);
  };

  test('a check appended after review to a declared GDScript test takes the scoped reader; undeclared or head-only it stops as behavior', () => {
    const declared = appended({ '.gstack/ship-policy.json': POLICY });
    expect(lineOf(declared.stdout, 'ROUTE'), declared.stdout).toMatch(/ behavior=0 docs=0 metadata=0 tests=1 /);
    expect(lineOf(declared.stdout, 'STOP')).toContain('test code changed since review in tests/menu_check.gd');
    for (const [name, r] of [['undeclared', appended({})], ['head-only', appended({}, { '.gstack/ship-policy.json': POLICY })]] as const) {
      expect([name, lineOf(r.stdout, 'ROUTE')]).toEqual([name, expect.stringMatching(/ behavior=1 docs=0 metadata=0 tests=0 /)]);
      expect([name, r.status, lineOf(r.stdout, 'STOP')]).toEqual([name, 3, behaviorStop('tests/menu_check.gd')]);
    }
  });
});
