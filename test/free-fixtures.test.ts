/**
 * PR paid-lane classification inventory (ENG-13, CEO-20, W1a).
 *
 * Every tracked fixture is either registered by a paid touchfile or declared
 * free in FREE_FIXTURES, and every workflow is either a paid lane or listed
 * as free-lane only. A file in neither restores the full gate on every PR
 * that touches it, so the inventory fails here with the edit that fixes it.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FREE_FIXTURES } from './helpers/free-fixtures-data';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { matchGlob } from './helpers/test-selection';
import { isPaidTestFile } from './helpers/paid-test-set';
import { FREE_ONLY_PR_FILES, PAID_WORKFLOW_FILES, PR_PROFILE_MAPS, selectPrProfile, unknownFileLabel } from '../scripts/test-pr-profile';
import { derivedDependencies } from '../scripts/pr-dependencies';

const ROOT = path.resolve(import.meta.dir, '..');
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })
  .stdout.split('\0').filter(Boolean);
const fixtures = tracked.filter(file => file.startsWith('test/fixtures/'));
const paidPatterns = [...new Set([...Object.values(E2E_TOUCHFILES).flat(), ...Object.values(LLM_JUDGE_TOUCHFILES).flat(), ...GLOBAL_TOUCHFILES])];
const registered = (file: string) => paidPatterns.some(pattern => matchGlob(file, pattern));
const mapped = (file: string) => Object.keys(FREE_FIXTURES).some(pattern => matchGlob(file, pattern));
const FIX = 'see docs/TESTING_INTERNALS.md#pr-paid-lane-fallback';

describe('FREE_FIXTURES inventory', () => {
  test('every tracked fixture is registered by a paid touchfile or declared free', () => {
    const unclassified = fixtures.filter(file => !registered(file) && !mapped(file));
    expect(unclassified.map(file => `${file}: neither a paid touchfile nor FREE_FIXTURES lists it. `
      + `Fix: register it in the touchfiles of the paid cases that read it (test/helpers/touchfiles-data.ts), `
      + `or add '${file}': ['<free consumer>'] to FREE_FIXTURES in test/helpers/free-fixtures-data.ts (${FIX})`)).toEqual([]);
  });

  test('every FREE_FIXTURES entry matches a tracked fixture', () => {
    const stale = Object.keys(FREE_FIXTURES).filter(pattern => !pattern.startsWith('test/fixtures/') || !fixtures.some(file => matchGlob(file, pattern)));
    expect(stale.map(pattern => `${pattern}: matches no tracked test/fixtures file. Fix: delete the entry from test/helpers/free-fixtures-data.ts (${FIX})`)).toEqual([]);
  });

  test('every declared consumer is free and names its fixture', () => {
    const problems: string[] = [];
    for (const [pattern, consumers] of Object.entries(FREE_FIXTURES)) {
      const name = pattern.endsWith('/**') ? path.basename(pattern.slice(0, -3)) : path.basename(pattern);
      for (const consumer of consumers) {
        if (!tracked.includes(consumer)) { problems.push(`${pattern}: consumer ${consumer} is not a tracked file`); continue; }
        if (isPaidTestFile(consumer) || registered(consumer)) {
          problems.push(`${pattern}: consumer ${consumer} is paid; move the fixture into that case's touchfiles instead (${FIX})`);
        }
        if (!fs.readFileSync(path.join(ROOT, consumer), 'utf8').includes(name)) {
          problems.push(`${pattern}: consumer ${consumer} never names ${name}; list the file that reads it (${FIX})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('workflow inventory (CEO-20)', () => {
  const workflows = tracked.filter(file => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  const free = (file: string) => FREE_ONLY_PR_FILES.some(pattern => matchGlob(file, pattern));
  const paid = (file: string) => (PAID_WORKFLOW_FILES as readonly string[]).includes(file);

  test('every workflow is classified as paid or free-lane only, never both', () => {
    const problems = workflows.flatMap(file => {
      if (paid(file) && free(file)) return [`${file}: listed as both paid and free-lane only; remove it from FREE_ONLY_PR_FILES`];
      if (!paid(file) && !free(file)) return [`${file}: unclassified workflow. Fix: add '${file}' to FREE_ONLY_PR_FILES in scripts/test-pr-profile.ts, or to PAID_WORKFLOW_FILES if it runs a paid case (${FIX})`];
      return [];
    });
    expect(problems).toEqual([]);
  });

  test('a reusable workflow called by a paid workflow is itself paid', () => {
    const problems: string[] = [];
    for (const lane of PAID_WORKFLOW_FILES) {
      const source = fs.existsSync(path.join(ROOT, lane)) ? fs.readFileSync(path.join(ROOT, lane), 'utf8') : '';
      for (const match of source.matchAll(/uses:\s*\.\/(\.github\/workflows\/[^\s@]+\.ya?ml)/g)) {
        if (!paid(match[1]!)) problems.push(`${lane} calls ${match[1]} via workflow_call; add it to PAID_WORKFLOW_FILES`);
      }
    }
    expect(problems).toEqual([]);
    expect(workflows.length).toBeGreaterThan(PAID_WORKFLOW_FILES.length);
  });

  test('the inventory rule also reads .yaml files', () => {
    expect(unknownFileLabel('.github/workflows/new-check.yaml').label).toBe('add to FREE_ONLY_PR_FILES');
    expect(unknownFileLabel('.github/workflows/evals.yml').label).toBe('full-gate input');
  });
});

describe('PR selection over the W1a single-file fallbacks', () => {
  const select = (changedFiles: string[]) => selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles });

  test('scheduler inputs, free-lane workflows and ubicloud scripts stay in the PR profile', () => {
    // 36497566037 (durations seed), 36485436963 and 36493616568 (free-lane workflow and runner files).
    for (const changed of [
      ['scripts/paid-test-durations.json'],
      ['scripts/free-test-durations.json'],
      ['.github/workflows/quality-gate.yml', '.github/workflows/windows-free-tests.yml', 'scripts/free-test-durations.json'],
      ['scripts/ubicloud/setup-free-suite.sh', 'scripts/ubicloud/ubi-runner.sh'],
      // 36485436963's replayed diff: a free design test outside test/.
      ['design/test/variants-retry-after.test.ts', 'make-pdf/test/render.test.ts', 'browse/test/commands.test.ts'],
    ]) {
      const result = select(changed);
      expect({ changed, mode: result.mode, unknown: result.unknownFiles }).toEqual({ changed, mode: 'pr', unknown: [] });
    }
  });

  test('seed data and the seed allowlist select no paid case; a derived paid-surface file still selects its dependents (#3289)', () => {
    // #3289: the allowlist edit derived 246 gate cases, though only test/free-seed-ratchet.test.ts reads it.
    const seed = select(['scripts/free-test-seed-allowlist.json', 'scripts/free-test-durations.json', 'scripts/free-test-durations-windows.json']);
    expect({ mode: seed.mode, unknown: seed.unknownFiles, derived: seed.derivedFiles, e2e: seed.e2e, judges: seed.judges })
      .toEqual({ mode: 'pr', unknown: [], derived: [], e2e: [], judges: [] });
    const paid = select(['design/src/evolve.ts']);
    expect(paid.derivedFiles.map(entry => entry.file)).toEqual(['design/src/evolve.ts']);
    expect(paid.e2e.length).toBeGreaterThan(0);
  });

  test('the paid workflow itself still restores the full gate (36493452542)', () => {
    const result = select(['.github/workflows/evals.yml']);
    expect(result.mode).toBe('full-fallback');
    expect(result.unknownFileLabels).toEqual([{ file: '.github/workflows/evals.yml', ...unknownFileLabel('.github/workflows/evals.yml') }]);
    expect(result.reasons[0]).toContain('.github/workflows/evals.yml (full-gate input)');
  });

  test('a mapped free fixture is exempt; a paid-registered fixture selects its cases; an unmapped one falls back', () => {
    const free = Object.keys(FREE_FIXTURES).find(pattern => !pattern.includes('*') && FREE_FIXTURES[pattern]!.length > 0)!;
    expect(select([free]).mode).toBe('pr');
    const paidFixture = fixtures.find(file => registered(file) && !mapped(file))!;
    const paidResult = selectPrProfile({ selectedE2E: null, selectedJudges: null, changedFiles: [paidFixture] });
    expect(paidResult.unknownFiles).toEqual([]);
    // A new (tracked) fixture that neither map lists restores the full gate (ENG-13).
    const real = derivedDependencies(PR_PROFILE_MAPS, ROOT);
    const unmapped = selectPrProfile({ selectedE2E: [], selectedJudges: [], changedFiles: ['test/fixtures/new-unmapped-fixture.json'],
      derived: { ...real, tracked: new Set([...real.tracked, 'test/fixtures/new-unmapped-fixture.json']) } });
    expect(unmapped.mode).toBe('full-fallback');
    expect(unmapped.unknownFileLabels[0]).toMatchObject({ label: 'needs touchfile entry' });
    expect(unmapped.unknownFileLabels[0]!.fix).toContain('FREE_FIXTURES');
  });

  test('every fallback label names its fix', () => {
    for (const file of ['test/helpers/new-helper.ts', 'test/skill-e2e-new.test.ts', 'test/fixtures/x.json', '.github/workflows/new.yml', 'lib/new-runtime.ts']) {
      const { label, fix } = unknownFileLabel(file);
      expect(['needs touchfile entry', 'add to FREE_ONLY_PR_FILES', 'real unknown dependency']).toContain(label);
      expect(fix).toContain(file);
      expect(fix).toMatch(/touchfiles-data\.ts|FREE_ONLY_PR_FILES|FREE_FIXTURES/);
    }
  });
});

// Every gstack install is a clone of this repository, so text under test/ sits in each user's home and in every
// eval arm that installs gstack. A real benchmark task there contaminates any eval that uses it (GST-3402). This
// scan fails when a file under test/ or browse/test/ names a SWE-bench-style task id (owner and repository
// joined by two underscores, then a dash and a number, as SWE-rebench and SWE-bench write them). Router and
// fixture tests use synthetic prompts instead, and real task material stays out of this repository.

const TASK_ID = /(?<![\w.-])[A-Za-z0-9][A-Za-z0-9-]*__[A-Za-z0-9][\w.-]*-\d+(?!\d)/g;
const MAX_BYTES = 8 * 1024 * 1024;

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.git' ? [] : files(p);
    return [p];
  });
}

/** Each file under the given roots that names a task id, with the first id it names. */
function taskIds(root: string, dirs: string[]): string[] {
  const hits: string[] = [];
  for (const file of dirs.flatMap((d) => files(path.join(root, d)))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (fs.statSync(file).size > MAX_BYTES) {
      hits.push(rel + ': too large to scan');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(TASK_ID);
    if (m) hits.push(rel + ': ' + m[0]);
  }
  return hits;
}

describe('no benchmark task ids under test/', () => {
  test('no file under test/ or browse/test/ names a SWE-bench-style task id', () => {
    expect(taskIds(ROOT, ['test', 'browse/test'])).toEqual([]);
  });

  test('negative control: a planted task id is caught, and dunder names, versions and plain ids are not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-task-ids-'));
    try {
      const planted = ['acme-widgets', 'gizmo-4242'].join('__');
      const suffixed = ['zz', 'sprocket-77_interface'].join('__');
      fs.mkdirSync(path.join(dir, 'test', 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'tasks.json'), JSON.stringify([{ id: planted }]));
      fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'suffixed.txt'), 'run ' + suffixed + '\n');
      fs.writeFileSync(path.join(dir, 'test', 'near-misses.ts'), [
        "path.join('__pycache__', '__init__.cpython-312.pyc')",
        "const id = 'synthetic-bug-01';",
        "self.__private__ = 'v1-2'",
        "label: foo__bar",
      ].join('\n'));
      expect(taskIds(dir, ['test']).sort()).toEqual(['test/fixtures/suffixed.txt: ' + suffixed.replace(/_interface$/, ''), 'test/fixtures/tasks.json: ' + planted]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
