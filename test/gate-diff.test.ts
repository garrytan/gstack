/**
 * gate-diff core — the pure detector over planted patch fixtures
 * (test/fixtures/gate-diff/*.patch), one per RH tag, the controls the design
 * names, and the adversarial cases. No git: patch text is parsed with
 * parseUnifiedDiff and fed to scanCandidate. The CLI, the candidate model and
 * the artifact live in test/gate-diff-cli.test.ts.
 *
 * Value: protects=W1 tag table, admission floor, read ordering and cap, id identity, summary counts;
 * fails_when=a tag stops firing on its planted case, a control becomes tagged, or the cap/ordering changes;
 * why_new=the detector is new; seam=none (pure functions).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EMPTY_PROJECT_CONFIG, parseGateIntegrityBlock, scanCandidate, specDirectoryHoldsSpecs, type FileDiff, type ScanResult } from '../lib/gate-diff/index';
import { parseUnifiedDiff } from '../lib/gate-diff/git';
import { classifyPath, globToRegExp, languagesUnlisted } from '../lib/gate-diff/classify';
import { detectRelaxation, gateKey, snapshotOwnerChanged } from '../lib/gate-diff/tags';
import { renderJsonl, renderSummaryLine, renderTable } from '../lib/gate-diff/render';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'gate-diff');

function patch(name: string): FileDiff[] {
  return parseUnifiedDiff(fs.readFileSync(path.join(FIXTURES, `${name}.patch`), 'utf-8'));
}

function scan(name: string, extra: Partial<Parameters<typeof scanCandidate>[0]> = {}): ScanResult {
  return scanCandidate({
    files: patch(name), commits: [], project: EMPTY_PROJECT_CONFIG, specIsTestPath: false,
    candidate: 'deadbeef0000+cafebabe0000', artifact: '/tmp/gate-diff/x.jsonl', ...extra,
  });
}

const tagsOf = (r: ScanResult) => r.hunks.flatMap((h) => h.tags);
const pathsOf = (r: ScanResult) => r.hunks.map((h) => h.path);

describe('gate-diff tags: one planted case per id', () => {
  test('RH-1: a test disabled with .skip', () => {
    const r = scan('rh1-skip');
    expect(pathsOf(r)).toEqual(['test/add.test.ts']);
    expect(tagsOf(r)).toEqual(['RH-1']);
    expect(r.hunks[0].level).toBe('read');
  });

  test('RH-1: a test declaration removed', () => {
    const r = scan('rh1-removed');
    expect(tagsOf(r)).toEqual(['RH-1']);
    expect(r.hunks[0].notes.join(' ')).toContain('1 test declaration(s) removed');
  });

  test('RH-3: a __snapshots__ file changed without its owning test', () => {
    const r = scan('rh3-snapshot-no-owner');
    expect(pathsOf(r)).toEqual(['test/__snapshots__/Button.test.ts.snap']);
    expect(tagsOf(r)).toEqual(['RH-3']);
  });

  test('RH-3?: a golden under testdata/ (owner unresolved, never inferred)', () => {
    const r = scan('rh3-golden');
    expect(tagsOf(r)).toEqual(['RH-3?']);
    expect(r.summary.tagged).toEqual({ 'RH-3?': 1 });
  });

  test('RH-4: a placeholder committed in product code', () => {
    const r = scan('rh4-placeholder');
    expect(pathsOf(r)).toEqual(['src/billing.ts']);
    expect(tagsOf(r)).toEqual(['RH-4']);
  });

  test('RH-12: environment sniffing added in product code', () => {
    expect(tagsOf(scan('rh12-env'))).toEqual(['RH-12']);
  });

  test('RH-13: a suppression pragma admits a product-code hunk', () => {
    const r = scan('rh13-pragma');
    expect(pathsOf(r)).toEqual(['src/parse.ts']);
    expect(tagsOf(r)).toEqual(['RH-13']);
    expect(r.hunks[0].floor).toBeNull();
    expect(r.summary.unmatched).toBe(0);
  });

  test('RH-14: continue-on-error added to a workflow; [skip ci] commits are listed by message', () => {
    const r = scan('rh14-bypass', { commits: [{ sha: 'a'.repeat(40), message: 'fix: tweak [skip ci]\n\nbody' }, { sha: 'b'.repeat(40), message: 'feat: real' }] });
    expect(tagsOf(r)).toEqual(['RH-14', 'RH-14']);
    const commit = r.hunks.find((h) => h.path.startsWith('(commit '));
    expect(commit?.new).toEqual(['fix: tweak [skip ci]']);
    expect(commit?.level).toBe('read');
  });

  test('RH-15: a timeout raised and a coverage threshold lowered, direction shown', () => {
    const r = scan('rh15-timeout');
    expect(r.hunks.map((h) => [h.path, h.tags])).toEqual([
      ['test/slow.test.ts', ['RH-15']],
      ['vitest.config.ts', ['RH-15']],
    ]);
    expect(r.hunks[0].notes).toEqual(['RH-15: timeout 5000 -> 60000 (relaxed: higher relaxes)']);
    expect(r.hunks[1].notes[0]).toContain('relaxed');
  });

  test('RH-15: an exact-count assertion relaxed to a bound', () => {
    const r = scan('rh15-bound');
    expect(tagsOf(r)).toEqual(['RH-15']);
    expect(r.hunks[0].notes[0]).toContain('exact-count assertion relaxed to a bound');
  });

  test('RH-15 is direction-agnostic: a tightened value is still tagged, labelled tightened', () => {
    const d = detectRelaxation({ header: '@@', lines: [{ kind: 'del', text: '  timeout: 60000,' }, { kind: 'add', text: '  timeout: 5000,' }] });
    expect(d.tags).toEqual(['RH-15']);
    expect(d.notes[0]).toContain('tightened');
  });

  test('RH-15?: an unpaired gate value (new file or reordered lines) is read, not inferred', () => {
    const d = detectRelaxation({ header: '@@', lines: [{ kind: 'add', text: 'export default { testTimeout: 60000 };' }] });
    expect(d.tags).toEqual(['RH-15?']);
    expect(gateKey('const minScore = 0.4;')).toEqual({ key: 'minScore', relaxes: 'down', value: 0.4 });
    expect(gateKey("console.log('Test Coverage Audit: 5 new code paths');")).toBeNull();
    expect(gateKey('setTimeout(done, 0);')).toBeNull();
    expect(gateKey('  coverage: { thresholds: { lines: 90 } },')).toMatchObject({ key: 'coverage', value: 90 });
    expect(gateKey('const name = "x";')).toBeNull();
  });

  test('RH-16: an exception swallowed in product code', () => {
    expect(tagsOf(scan('rh16-swallow'))).toEqual(['RH-16']);
  });
});

describe('gate-diff controls: inventory, never findings; tags stay factual', () => {
  test('a test file moved is listed and untagged', () => {
    const r = scan('control-rename');
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]).toMatchObject({ path: 'test/math/add.test.ts', oldPath: 'test/add.test.ts', tags: [], level: 'listed' });
    expect(r.summary).toMatchObject({ listed: 1, eligible: 0, inspected: 0, unread: 0 });
  });

  test('an added test is listed and untagged', () => {
    const r = scan('control-added-test');
    expect(r.hunks.map((h) => [h.path, h.tags, h.level])).toEqual([['test/add.test.ts', [], 'listed']]);
  });

  test('a snapshot updated with its owning test is listed and untagged', () => {
    const r = scan('control-snapshot-with-owner');
    expect(pathsOf(r).sort()).toEqual(['test/Button.test.ts', 'test/__snapshots__/Button.test.ts.snap']);
    expect(tagsOf(r)).toEqual([]);
    expect(r.summary.eligible).toBe(2);
  });

  test('a test deleted beside its deleted source is listed AND tagged RH-1 (judgment belongs to the agent)', () => {
    const r = scan('control-test-deleted-with-source');
    expect(r.hunks.map((h) => [h.path, h.tags])).toEqual([['test/add.test.ts', ['RH-1']]]);
    expect(r.unmatchedPaths).toEqual(['src/add.ts']);
  });

  test('spec/ is a test path only when the tree holds *_spec.* or *.spec.* files', () => {
    const skill = scan('control-spec-skill-dir');
    expect(skill.hunks).toHaveLength(0);
    expect(skill.unmatchedPaths).toEqual(['spec/SKILL.md']);
    expect(specDirectoryHoldsSpecs(['spec/SKILL.md', 'spec/sections/intro.md'])).toBe(false);
    expect(specDirectoryHoldsSpecs(['spec/models/user_spec.rb'])).toBe(true);
    expect(specDirectoryHoldsSpecs(['spec/x.spec.ts'])).toBe(true);
    const rails = scan('control-spec-skill-dir', { specIsTestPath: true });
    expect(rails.hunks.map((h) => [h.path, h.tags])).toEqual([['spec/SKILL.md', []]]);
  });

  test('package.json hunks join the floor only inside a tool section', () => {
    const r = scan('package-json-scripts');
    expect(r.hunks.map((h) => [h.path, h.floor])).toEqual([['package.json', 'config']]);
    const deps = scanCandidate({
      files: [{ oldPath: 'package.json', newPath: 'package.json', status: 'modified', hunks: [{ header: '@@ -6,3 +6,3 @@', lines: [
        { kind: 'ctx', text: '  "dependencies": {' }, { kind: 'del', text: '    "left-pad": "1.0.0"' }, { kind: 'add', text: '    "left-pad": "1.0.1"' }, { kind: 'ctx', text: '  }' },
      ] }] }],
      commits: [], project: EMPTY_PROJECT_CONFIG, specIsTestPath: false, candidate: 'c', artifact: '/tmp/a',
    });
    expect(deps.hunks).toHaveLength(0);
    expect(deps.unmatchedPaths).toEqual(['package.json']);
  });
});

describe('gate-diff adversarial fixtures', () => {
  test('a forged "measured" comment is tagged RH-15 with the citation shown, never suppressed', () => {
    const r = scan('adv-forged-measured');
    expect(tagsOf(r)).toEqual(['RH-15']);
    expect(r.hunks[0].citation).toContain('ship-measure report 2026-10-09');
    expect(r.hunks[0].level).toBe('read');
  });

  test('a commit-message citation attaches to RH-15 hunks without their own', () => {
    const r = scan('rh15-timeout', { commits: [{ sha: 'c'.repeat(40), message: 'test: raise timeout per dec-7f3a2b-timeouts' }] });
    expect(r.hunks[0].citation).toBe('commit: test: raise timeout per dec-7f3a2b-timeouts');
  });

  test('a snapshot regenerated beside an unrelated source edit is tagged RH-3', () => {
    const r = scan('adv-golden-beside-unrelated');
    expect(r.hunks.map((h) => [h.path, h.tags])).toEqual([['test/__snapshots__/Card.test.ts.snap', ['RH-3']]]);
    expect(r.unmatchedPaths).toEqual(['src/unrelated.ts']);
  });

  test('a Kotlin @Ignore under src/test/kotlin/ is listed by the any-depth matcher and tagged RH-1', () => {
    const r = scan('adv-kotlin-ignore');
    expect(r.hunks.map((h) => [h.path, h.floor, h.tags])).toEqual([['src/test/kotlin/FooTest.kt', 'test', ['RH-1']]]);
  });

  test('prose files are floor inventory only: idioms quoted in docs never tag', () => {
    const r = scanCandidate({
      files: [{ oldPath: 'docs/guide.md', newPath: 'docs/guide.md', status: 'modified', hunks: [{ header: '@@ -1 +1,2 @@', lines: [
        { kind: 'add', text: 'Never add `eslint-disable`, `@ts-ignore`, `it.skip` or `--no-verify`.' },
      ] }] }],
      commits: [], project: EMPTY_PROJECT_CONFIG, specIsTestPath: false, candidate: 'c', artifact: '/tmp/a',
    });
    expect(r.hunks).toHaveLength(0);
    expect(r.unmatchedPaths).toEqual(['docs/guide.md']);
  });
});

describe('gate-diff admission, identity, read cap and summary', () => {
  const hunk = (path: string, del: string[], add: string[], header = '@@ -1,2 +1,2 @@') =>
    ({ oldPath: path, newPath: path, status: 'modified' as const, hunks: [{ header, lines: [...del.map((text) => ({ kind: 'del' as const, text })), ...add.map((text) => ({ kind: 'add' as const, text }))] }] });
  const base = { commits: [], project: EMPTY_PROJECT_CONFIG, specIsTestPath: false, candidate: 'c', artifact: '/tmp/a' };

  test('id = sha256(old path, new path, sorted tags, normalised changed lines)[0:12]; duplicates get -2, -3 in path order', () => {
    const files = [
      hunk('test/a.test.ts', ['  timeout: 1,'], ['  timeout: 2,']),
      hunk('test/a.test.ts', ['timeout: 1,'], ['timeout:   2,']),
      hunk('test/a.test.ts', ['timeout: 1,'], ['timeout: 2,']),
    ];
    const r = scanCandidate({ ...base, files });
    expect(r.hunks.map((h) => h.id)).toEqual([r.hunks[0].id, `${r.hunks[0].id}-2`, `${r.hunks[0].id}-3`]);
    expect(r.hunks[0].id).toMatch(/^[0-9a-f]{12}$/);
    const moved = scanCandidate({ ...base, files: [hunk('test/b.test.ts', ['  timeout: 1,'], ['  timeout: 2,'])] });
    expect(moved.hunks[0].id).not.toBe(r.hunks[0].id);
  });

  test('the content backstop admits a renamed test declaration outside the floor, untagged', () => {
    const r = scanCandidate({ ...base, files: [hunk('src/thing.ts', ["test('old name', () => {"], ["test('new name', () => {"])] });
    expect(r.hunks.map((h) => [h.path, h.floor, h.tags])).toEqual([['src/thing.ts', null, []]]);
  });

  test('read level is tagged first, then deletion-bearing, capped; the rest is unread and the result partial', () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) => hunk(`test/del${i}.test.ts`, [`  const x${i} = 1;`], [])),
      hunk('test/skip.test.ts', [], ['it.skip("x", () => {});']),
      hunk('test/added.test.ts', [], ['const y = 1;']),
    ];
    const r = scanCandidate({ ...base, files, readCap: { hunks: 3, bytes: 200 * 1024 } });
    expect(r.summary).toMatchObject({ listed: 6, eligible: 5, inspected: 3, unread: 2 });
    const read = r.hunks.filter((h) => h.level === 'read').map((h) => h.path);
    expect(read).toEqual(['test/del0.test.ts', 'test/del1.test.ts', 'test/skip.test.ts']);
    expect(r.hunks.filter((h) => h.level === 'listed').map((h) => h.path)).toEqual(['test/del2.test.ts', 'test/del3.test.ts', 'test/added.test.ts']);
    const bytes = scanCandidate({ ...base, files, readCap: { hunks: 50, bytes: 30 } });
    expect(bytes.summary.inspected).toBe(1);
    expect(bytes.summary.unread).toBe(4);
  });

  test('unsupported paths are named, never zero hunks; floor ones stay listed', () => {
    const r = scanCandidate({ ...base, files: [
      { oldPath: 'test/fixtures/img.png', newPath: 'test/fixtures/img.png', status: 'modified', hunks: [], unsupported: 'binary' },
      { oldPath: 'vendor/lib', newPath: 'vendor/lib', status: 'modified', hunks: [], unsupported: 'submodule' },
    ] });
    expect(r.unsupportedPaths).toEqual([{ path: 'test/fixtures/img.png', reason: 'binary' }, { path: 'vendor/lib', reason: 'submodule' }]);
    expect(r.hunks.map((h) => [h.path, h.unsupported, h.level])).toEqual([['test/fixtures/img.png', 'binary', 'listed']]);
    expect(r.summary.eligible).toBe(0);
  });

  test('GATE_SUMMARY line carries every field in order; languages_unlisted names uncovered languages', () => {
    const r = scanCandidate({ ...base, files: [hunk('src/Foo.php', ['$a = 1;'], ['$a = 2;']), hunk('test/a.test.ts', [], ['it.only("x", () => {});'])] });
    const line = renderSummaryLine(r.summary);
    expect(line).toBe('GATE_SUMMARY: listed=1 eligible=1 inspected=1 unread=0 tagged={RH-1:1} unmatched=1 coverage=RH-1,RH-3,RH-4,RH-12,RH-13,RH-14,RH-15,RH-16 languages_unlisted=php candidate=c artifact=/tmp/a');
    expect(languagesUnlisted(['a/b.cs', 'c.ts', 'd.rb'])).toEqual(['csharp']);
    expect(renderSummaryLine(scanCandidate({ ...base, files: [] }).summary)).toContain(' tagged={} unmatched=0 ');
  });

  test('table prints read hunks only; jsonl prints every listed hunk with the contract fields', () => {
    const r = scanCandidate({ ...base, files: [hunk('test/a.test.ts', [], ['it.skip("x", () => {});']), hunk('test/b.test.ts', [], ['const z = 1;'])] });
    const table = renderTable(r).split('\n');
    expect(table[0]).toStartWith('GATE_SUMMARY: ');
    expect(table[1]).toBe(`[${r.hunks[0].id}] RH-1 test/a.test.ts @@ -1,2 +1,2 @@`);
    expect(table[2]).toBe('  +it.skip("x", () => {});');
    expect(table[3]).toBe('  citation: none');
    expect(table.filter((l) => l.includes('test/b.test.ts'))).toEqual([]);
    const jsonl = renderJsonl(r).trim().split('\n');
    expect(jsonl).toHaveLength(3);
    const objs = jsonl.slice(1).map((l) => JSON.parse(l));
    expect(Object.keys(objs[0])).toEqual(['id', 'path', 'level', 'tags', 'old', 'new', 'citation']);
    expect(objs.map((o) => o.level)).toEqual(['read', 'listed']);
  });
});

describe('gate-diff classify: floor matcher and CLAUDE.md block', () => {
  const ctx = { project: EMPTY_PROJECT_CONFIG, specIsTestPath: false };

  test('any-depth, case-insensitive test paths and language idioms', () => {
    for (const p of ['src/test/java/FooTest.java', 'Tests/FooTests.swift', 'app/FooTest.kt', 'pkg/x_test.go', 'lib/foo_test.exs', 'tests/test_api.py', 'a/__tests__/b.js', 'Spec/Thing.rb'.replace('Spec', '__TESTS__')]) {
      expect([p, classifyPath(p, ctx)]).toEqual([p, 'test']);
    }
    expect(classifyPath('spec/models/user_spec.rb', ctx)).toBe('test');
    expect(classifyPath('spec/SKILL.md', ctx)).toBeNull();
    expect(classifyPath('spec/SKILL.md', { ...ctx, specIsTestPath: true })).toBe('test');
    expect(classifyPath('src/contest/winner.ts', ctx)).toBeNull();
  });

  test('CI, config, snapshot and golden classes', () => {
    expect(classifyPath('.github/workflows/ci.yml', ctx)).toBe('ci');
    expect(classifyPath('.gitlab-ci.yml', ctx)).toBe('ci');
    expect(classifyPath('Jenkinsfile', ctx)).toBe('ci');
    for (const p of ['vitest.config.mts', 'jest.config.js', 'pytest.ini', 'setup.cfg', 'tox.ini', 'bunfig.toml', '.eslintrc.json', 'eslint.config.js', 'tsconfig.build.json', '.rubocop.yml', '.golangci.yml']) {
      expect([p, classifyPath(p, ctx)]).toEqual([p, 'config']);
    }
    expect(classifyPath('x/__snapshots__/a.snap', ctx)).toBe('snapshot');
    expect(classifyPath('pkg/testdata/a.golden', ctx)).toBe('golden');
    expect(classifyPath('docs/x.yml', ctx)).toBeNull();
    expect(classifyPath('bun.lock', ctx)).toBeNull();
  });

  test('## Gate Integrity block adds test and snapshot paths; globs match any depth', () => {
    const cfg = parseGateIntegrityBlock('# Project\n\n## Test Coverage\nMinimum: 60%\n\n## Gate Integrity\nExtra test paths: features/**, `qa/*.feature`\nSnapshot paths: fixtures/golden/\n\n## Other\nExtra test paths: ignored/\n');
    expect(cfg).toEqual({ extraTestPaths: ['features/**', 'qa/*.feature'], snapshotPaths: ['fixtures/golden/'] });
    const c2 = { project: cfg, specIsTestPath: false };
    expect(classifyPath('features/login.feature', c2)).toBe('test');
    expect(classifyPath('qa/smoke.feature', c2)).toBe('test');
    expect(classifyPath('app/fixtures/golden/out.json', c2)).toBe('golden');
    expect(parseGateIntegrityBlock('no block')).toEqual(EMPTY_PROJECT_CONFIG);
    expect(globToRegExp('/root-only/*.ts').test('a/root-only/b.ts')).toBe(false);
    expect(globToRegExp('/root-only/*.ts').test('root-only/b.ts')).toBe(true);
  });

  test('snapshot owner: conventional __snapshots__/<name>.snap and sibling <name>.snap only', () => {
    expect(snapshotOwnerChanged('t/__snapshots__/a.test.ts.snap', new Set(['t/a.test.ts']))).toBe(true);
    expect(snapshotOwnerChanged('t/__snapshots__/a.test.ts.snap', new Set(['other/a.test.ts']))).toBe(false);
    expect(snapshotOwnerChanged('t/a.snap', new Set(['t/a.test.ts']))).toBe(true);
    expect(snapshotOwnerChanged('t/a.snap', new Set(['t/b.test.ts']))).toBe(false);
  });
});
