import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { computePaidCaseSelection } from '../scripts/test-paid-shards';
import { FREE_ONLY_PR_FILES, PR_PROFILE_CASE_IDS, selectPrProfile, type PrProfileMaps } from '../scripts/test-pr-profile';
import { normalizeRelativePath } from '../scripts/test-strict-output';
import { normalizeRelativePath as freeNormalize } from '../scripts/test-free-shards';
import { PAID_TEST_GLOBS } from './helpers/paid-test-set';
import { E2E_TIERS, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { selectTests } from './helpers/test-selection';
import { workflowJudgeDependencies } from './helpers/workflow-judge-cache';

const ROOT = path.resolve(import.meta.dir, '..');

function runnerDependencies(root: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const parser = new Bun.Transpiler({ loader: 'tsx' });
  const visit = (file: string) => {
    file = fs.realpathSync(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Dependency outside checkout');
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = fs.readFileSync(file, 'utf8').replace(/^#![^\n]*(?:\n|$)/, '\n');
    let audited = source;
    if (relative === 'test/helpers/test-selection.ts') {
      if (createHash('sha256').update(source).digest('hex') !== '4d2fbcb6249e8d22453d25bfe9b18ee0f4568bbec071918675c38a455d4e1e08') {
        throw new Error('Re-audit the historical touchfile map loader before excluding its computed import');
      }
      audited = source.replace('`const m = await import(${JSON.stringify(dataPath)});`,', "'',");
    }
    const compiled = parser.transformSync(audited);
    const imports = [...parser.scanImports(source), ...parser.scanImports(compiled)];
    const nonliteral = compiled.replace(/(?<![\w.])(?:import|require)\s*\(\s*(['"])[^'"\n]+\1\s*\)/g, '');
    if (/\bimport\s*\(|\brequire\s*[([;,.?)]|\bcreateRequire\b/.test(nonliteral)) {
      throw new Error(`Unresolved module loading in ${relative}`);
    }
    for (const entry of imports) {
      if (isBuiltin(entry.path) || entry.path.startsWith('bun:')) continue;
      visit(Bun.resolveSync(entry.path, path.dirname(file)));
    }
  };
  for (const entry of entries) visit(path.join(root, entry));
  return [...seen].sort();
}

describe('paid/free dependency boundary', () => {
  test('shared normalization preserves the free export and path bytes', () => {
    expect(freeNormalize).toBe(normalizeRelativePath);
    for (const [input, expected] of [
      ['', ''], ['test/example.test.ts', 'test/example.test.ts'],
      ['test\\example.test.ts', 'test/example.test.ts'],
      ['.\\test\\..\\test\\example.test.ts', './test/../test/example.test.ts'],
      ['C:\\work\\test\\example.test.ts', 'C:/work/test/example.test.ts'],
    ]) expect(normalizeRelativePath(input)).toBe(expected);
  });

  test('the paid runner and all paid test static closures exclude every free-only exemption', () => {
    const runner = runnerDependencies(ROOT, ['scripts/test-paid-shards.ts', 'scripts/eval-select.ts']);
    const paid = [...new Set(PAID_TEST_GLOBS.flatMap(pattern => [...new Bun.Glob(pattern).scanSync(ROOT)]))];
    expect(paid.length).toBeGreaterThan(0);
    const all = workflowJudgeDependencies(ROOT, paid);
    for (const dependencies of [runner, all]) {
      expect(dependencies).toContain('scripts/test-strict-output.ts');
      expect(dependencies).toContain('test/helpers/test-selection.ts');
      expect(dependencies).not.toContain('scripts/eval-flake-rank.ts');
      for (const freeOnly of FREE_ONLY_PR_FILES) expect(dependencies).not.toContain(freeOnly);
    }
    expect(runnerDependencies(ROOT, ['scripts/eval-flake-rank.ts'])).toContain('scripts/test-free-shards.ts');
  });

  test('the runner audit follows re-exports, literal imports and requires; unknown loading fails closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-imports-'));
    const write = (file: string, source: string) => fs.writeFileSync(path.join(root, file), source);
    try {
      write('entry.ts', "export * from './bridge';");
      write('bridge.ts', "export { value } from './free';");
      write('free.ts', 'export const value = 1;');
      expect(runnerDependencies(root, ['entry.ts'])).toContain('free.ts');
      for (const source of ["await import('./free');", "require('./free');", "module.require('./free');",
        "import './free';", "await import('./' + 'free');"]) {
        write('bridge.ts', source);
        expect(runnerDependencies(root, ['entry.ts'])).toContain('free.ts');
      }
      for (const source of [
        "const target = './free'; await import(target);",
        "const target = './free'; await import /* indirect */ (target);",
        "const target = 'free'; await import(`./${target}`);",
        "const target = './free'; require(target);",
        "const load = require; load('./free');",
        "const target = process.argv[2]; module.require(target);",
        "import { createRequire as loader } from 'node:module'; loader(import.meta.url)('./free');",
        "const target = process.argv[2]; await import('./' + target);",
        "import './missing';",
        'export {',
      ]) {
        write('bridge.ts', source);
        expect(() => runnerDependencies(root, ['entry.ts']), source).toThrow();
      }
      fs.mkdirSync(path.join(root, 'test/helpers'), { recursive: true });
      write('test/helpers/test-selection.ts', fs.readFileSync(path.join(ROOT, 'test/helpers/test-selection.ts'), 'utf8') + '\n');
      expect(() => runnerDependencies(root, ['test/helpers/test-selection.ts'])).toThrow('Re-audit');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('only audited free-only dependencies avoid unknown-dependency fallback', () => {
    for (const file of [...FREE_ONLY_PR_FILES, 'scripts\\test-free-shards.ts']) {
      const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [file] });
      expect(result.coverage?.mode).toBe('pr');
      expect(result.coverage?.unknownFiles).toEqual([]);
      expect(result.selection).toEqual({ e2e: [], judges: [] });
    }
    for (const file of [
      'scripts/new-helper.ts', 'scripts/free-test-durations.json', 'scripts/eval-flake-rank.ts',
      'lib/new-runtime.ts', 'test/helpers/new-helper.ts', 'test/fixtures/new-fixture.ts',
      '.github/workflows/new-free-tests.yml',
    ]) {
      const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [FREE_ONLY_PR_FILES[0], file] });
      expect(result.coverage?.mode, file).toBe('full-fallback');
      expect(result.coverage?.unknownFiles).toContain(file);
      expect(result.selection.e2e).toEqual(Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === 'gate').sort());
      expect(result.selection.judges).toEqual(Object.keys(LLM_JUDGE_TOUCHFILES).sort());
    }
    const missingBase = computePaidCaseSelection({ profile: 'pr', env: { EVALS_BASE: 'missing-boundary-ref' },
      changedFiles: ['package.json'] });
    expect(missingBase.coverage?.mode).toBe('full-fallback');
  });

  test('mapped shared infrastructure retains every fast PR case and judge, as at 06ed920', () => {
    for (const file of ['scripts/test-pr-profile.ts', 'scripts/test-strict-output.ts',
      'scripts/test-paid-shards.ts', 'test/helpers/eval-budgets.ts']) {
      const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: [FREE_ONLY_PR_FILES[0], file] });
      expect(result.coverage?.mode, file).toBe('pr');
      expect(result.coverage?.unknownFiles).toEqual([]);
      expect(result.selection.e2e).toEqual([...PR_PROFILE_CASE_IDS].sort());
      expect(result.selection.judges).toEqual(Object.keys(LLM_JUDGE_TOUCHFILES).sort());
    }
  });

  test('PR 2956 retains its mapped paid checks without the free runner restoring broad cases', () => {
    const changedFiles = [
      'plan-eng-review/SKILL.md', 'plan-eng-review/SKILL.md.tmpl',
      'plan-eng-review/sections/review-sections.md', 'plan-eng-review/sections/review-sections.md.tmpl',
      'scripts/test-free-shards.ts', 'scripts/test-strict-output.ts',
      'test/eng-scope-entry-ap.test.ts', 'test/helpers/plan-floor-review.ts',
      'test/plan-floor-permission.test.ts', 'test/plan-floor-review.test.ts',
      'test/plan-review-cases.test.ts', 'test/plan-scope-recovery-av.test.ts',
      'test/strict-output-formats.test.ts',
    ];
    const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles });
    const withoutFree = computePaidCaseSelection({ profile: 'pr', env: {},
      changedFiles: changedFiles.filter(file => file !== 'scripts/test-free-shards.ts') });
    expect(result).toEqual(withoutFree);
    expect(result.coverage?.mode).toBe('pr');
    expect(result.coverage?.unknownFiles).toEqual([]);
    expect(result.selection.e2e).toEqual([...PR_PROFILE_CASE_IDS].sort());
    expect(result.selection.judges).toEqual(Object.keys(LLM_JUDGE_TOUCHFILES).sort());
    expect(result.coverage?.deferred.some(item => item.id === 'qa-only-no-fix')).toBe(true);
    expect(result.coverage?.needsFullValidation).toBe(false);
  });

  test('mapped E2E, judge and global dependencies still win over the free-only exemption', () => {
    const file = FREE_ONLY_PR_FILES[0];
    for (const category of ['e2e', 'judge', 'global']) {
      const maps: PrProfileMaps = {
        e2eTouchfiles: { fast: category === 'e2e' ? [file] : ['skill/**'], broad: ['other/**'] },
        tiers: { fast: 'gate', broad: 'gate' },
        judgeTouchfiles: { quality: category === 'judge' ? [file] : ['skill/**'] },
        globalTouchfiles: category === 'global' ? [file] : [],
      };
      const e2e = selectTests([file], maps.e2eTouchfiles, maps.globalTouchfiles);
      const judges = selectTests([file], maps.judgeTouchfiles, maps.globalTouchfiles);
      const result = selectPrProfile({ changedFiles: [file], maps, profile: ['fast'],
        selectedE2E: e2e.selected, selectedJudges: judges.selected });
      expect(result.mode).toBe('pr');
      expect(result.e2e).toEqual(category === 'judge' ? [] : ['fast']);
      expect(result.judges).toEqual(category === 'e2e' ? [] : ['quality']);
    }
    const real = computePaidCaseSelection({ profile: 'pr', env: {},
      changedFiles: [file, 'plan-ceo-review/SKILL.md.tmpl'] });
    expect(real.coverage?.mode).toBe('pr');
    expect(real.selection.e2e).toContain('plan-ceo-review-benefits');
    expect(real.selection.judges).toContain('plan-ceo-review/SKILL.md modes');
    expect(real.selection.e2e?.every(id => PR_PROFILE_CASE_IDS.includes(id as typeof PR_PROFILE_CASE_IDS[number]))).toBe(true);
  });
});
