/**
 * Map-diff selection for touchfiles-data.ts changes.
 * Free (no API calls), runs with `bun test`.
 *
 * Three layers, matching the injectable-core + thin-shell shape:
 *   1. diffTouchfileMapsCore — pure diff logic on injected old/new maps.
 *   2. selectTests wiring — injected MapDiffOutcome, no git.
 *   3. diffTouchfileMaps shell — real git + bun-child evaluation against a
 *      throwaway temp repo (happy path + every fail-closed cause), plus one
 *      end-to-end call against this actual repo's HEAD.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  diffTouchfileMaps,
  diffTouchfileMapsCore,
  selectTests,
  TOUCHFILES_DATA_PATH,
  E2E_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from './helpers/touchfiles';
import type { TouchfileMaps, MapDiffOutcome } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');

function maps(overrides: Partial<TouchfileMaps> = {}): TouchfileMaps {
  return {
    E2E_TOUCHFILES: {
      'alpha': ['a/**'],
      'beta': ['b/**', 'shared/util.ts'],
    },
    E2E_TIERS: {
      'alpha': 'gate',
      'beta': 'periodic',
    },
    LLM_JUDGE_TOUCHFILES: {
      'judge one': ['j/SKILL.md'],
    },
    GLOBAL_TOUCHFILES: ['test/helpers/session-runner.ts'],
    ...overrides,
  };
}

// --- Layer 1: pure core ---

describe('diffTouchfileMapsCore', () => {
  test('identical maps → nothing changed', () => {
    const result = diffTouchfileMapsCore(maps(), maps());
    expect(result.changedTests).toEqual([]);
    expect(result.removedTests).toEqual([]);
    expect(result.globalTouchfilesChanged).toBe(false);
  });

  test('entry added → changed', () => {
    const newMaps = maps({
      E2E_TOUCHFILES: { 'alpha': ['a/**'], 'beta': ['b/**', 'shared/util.ts'], 'gamma': ['g/**'] },
      E2E_TIERS: { 'alpha': 'gate', 'beta': 'periodic', 'gamma': 'gate' },
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.changedTests).toEqual(['gamma']);
    expect(result.removedTests).toEqual([]);
  });

  test('dep glob edited → changed', () => {
    const newMaps = maps({
      E2E_TOUCHFILES: { 'alpha': ['a/**', 'extra/dep.ts'], 'beta': ['b/**', 'shared/util.ts'] },
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.changedTests).toEqual(['alpha']);
  });

  test('tier flipped → changed', () => {
    const newMaps = maps({
      E2E_TIERS: { 'alpha': 'gate', 'beta': 'gate' },
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.changedTests).toEqual(['beta']);
  });

  test('unrelated entries untouched → not selected', () => {
    const newMaps = maps({
      E2E_TOUCHFILES: { 'alpha': ['a/**', 'x.ts'], 'beta': ['b/**', 'shared/util.ts'] },
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.changedTests).not.toContain('beta');
    expect(result.changedTests).not.toContain('judge one');
  });

  test('entry removed from every map → removedTests, not changed', () => {
    const newMaps = maps({
      E2E_TOUCHFILES: { 'alpha': ['a/**'] },
      E2E_TIERS: { 'alpha': 'gate' },
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.removedTests).toEqual(['beta']);
    expect(result.changedTests).not.toContain('beta');
  });

  test('tier entry removed but touchfile entry kept → changed (conservative)', () => {
    const newMaps = maps({
      E2E_TIERS: { 'alpha': 'gate' }, // 'beta' tier dropped, E2E_TOUCHFILES.beta kept
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.changedTests).toContain('beta');
    expect(result.removedTests).toEqual([]);
  });

  test('LLM-judge entries participate in the diff', () => {
    const newMaps = maps({
      LLM_JUDGE_TOUCHFILES: { 'judge one': ['j/SKILL.md', 'j/SKILL.md.tmpl'] },
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.changedTests).toEqual(['judge one']);
  });

  test('GLOBAL_TOUCHFILES entry added → flagged', () => {
    const newMaps = maps({
      GLOBAL_TOUCHFILES: ['test/helpers/session-runner.ts', 'test/helpers/new-global.ts'],
    });
    const result = diffTouchfileMapsCore(maps(), newMaps);
    expect(result.globalTouchfilesChanged).toBe(true);
  });

  test('GLOBAL_TOUCHFILES compared as a set — reorder is not a change', () => {
    const oldMaps = maps({ GLOBAL_TOUCHFILES: ['x.ts', 'y.ts'] });
    const newMaps = maps({ GLOBAL_TOUCHFILES: ['y.ts', 'x.ts'] });
    const result = diffTouchfileMapsCore(oldMaps, newMaps);
    expect(result.globalTouchfilesChanged).toBe(false);
  });
});

// --- Layer 2: selectTests wiring (injected outcome, no git) ---

describe('selectTests map-diff wiring', () => {
  const okOutcome = (changedTests: string[], removedTests: string[] = []): MapDiffOutcome =>
    ({ ok: true, changedTests, removedTests, globalTouchfilesChanged: false });

  test('data-file change selects only map-changed tests, reason map-diff', () => {
    const result = selectTests(
      [TOUCHFILES_DATA_PATH],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: okOutcome(['browse-basic']) },
    );
    expect(result.selected).toEqual(['browse-basic']);
    expect(result.reason).toBe('map-diff');
    expect(result.skipped.length).toBe(Object.keys(E2E_TOUCHFILES).length - 1);
  });

  test('map-diff result unions with pattern matching for other changed files', () => {
    const result = selectTests(
      [TOUCHFILES_DATA_PATH, 'retro/SKILL.md'],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: okOutcome(['browse-basic']) },
    );
    expect(result.selected).toContain('browse-basic'); // from map-diff
    expect(result.selected).toContain('retro');        // from pattern match
    expect(result.selected).toContain('retro-base-branch');
    expect(result.selected).not.toContain('cso-full-audit');
    expect(result.reason).toBe('map-diff');
  });

  test('changedTests scoped to the map being selected against', () => {
    // 'judge one' is an LLM-judge key, not an E2E key — must not leak in.
    const result = selectTests(
      [TOUCHFILES_DATA_PATH],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: okOutcome(['browse-basic', 'judge one']) },
    );
    expect(result.selected).toEqual(['browse-basic']);
  });

  test('removedTests reported, not selected', () => {
    const result = selectTests(
      [TOUCHFILES_DATA_PATH],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: okOutcome([], ['some-retired-test']) },
    );
    expect(result.selected).toEqual([]);
    expect(result.removedTests).toEqual(['some-retired-test']);
  });

  test('FAIL-CLOSED: failed map-diff runs all with cause in reason', () => {
    const result = selectTests(
      [TOUCHFILES_DATA_PATH],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: { ok: false, cause: 'import-failed' } },
    );
    expect(result.selected.length).toBe(Object.keys(E2E_TOUCHFILES).length);
    expect(result.reason).toBe('global — touchfiles-data changed (import-failed)');
  });

  test('GLOBAL_TOUCHFILES edit inside data file runs all', () => {
    const result = selectTests(
      [TOUCHFILES_DATA_PATH],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: { ok: true, changedTests: [], removedTests: [], globalTouchfilesChanged: true } },
    );
    expect(result.selected.length).toBe(Object.keys(E2E_TOUCHFILES).length);
    expect(result.reason).toContain('GLOBAL_TOUCHFILES');
  });

  test('a real global touchfile hit still wins over map-diff', () => {
    const result = selectTests(
      [TOUCHFILES_DATA_PATH, 'test/helpers/session-runner.ts'],
      E2E_TOUCHFILES,
      GLOBAL_TOUCHFILES,
      { mapDiff: okOutcome(['browse-basic']) },
    );
    expect(result.selected.length).toBe(Object.keys(E2E_TOUCHFILES).length);
    expect(result.reason).toBe('global: test/helpers/session-runner.ts');
  });

  test('no data-file change → classic diff behavior, no map-diff consulted', () => {
    const result = selectTests(['retro/SKILL.md'], E2E_TOUCHFILES, GLOBAL_TOUCHFILES, {
      // Poison injection: if the wiring consulted this, the test would fail.
      mapDiff: { ok: false, cause: 'import-failed' },
    });
    expect(result.reason).toBe('diff');
    expect(result.selected).toContain('retro');
    expect(result.removedTests).toBeUndefined();
  });
});

// --- Layer 3: thin shell against a temp git repo ---

const OLD_FIXTURE = `export const E2E_TOUCHFILES: Record<string, string[]> = {
  'alpha': ['a/**'],
  'beta': ['b/**'],
};
export const E2E_TIERS: Record<string, 'gate' | 'periodic'> = {
  'alpha': 'gate',
  'beta': 'periodic',
};
export const LLM_JUDGE_TOUCHFILES: Record<string, string[]> = {
  'judge one': ['j/SKILL.md'],
};
export const GLOBAL_TOUCHFILES = [
  'test/helpers/session-runner.ts',
];
`;

describe('diffTouchfileMaps (git + bun-child shell)', () => {
  let repo: string;

  const git = (args: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      { cwd: repo, stdio: 'pipe', timeout: 10000 },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`);
    }
  };

  const commitDataFile = (source: string, message: string) => {
    const filePath = path.join(repo, TOUCHFILES_DATA_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    git(['add', TOUCHFILES_DATA_PATH]);
    git(['commit', '-q', '-m', message]);
  };

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'touchfiles-map-diff-repo-'));
    git(['init', '-q']);
    commitDataFile(OLD_FIXTURE, 'old maps');
    git(['tag', 'old-maps']);
    // Commit with a broken data file (unterminated string → bun import fails)
    commitDataFile("export const E2E_TOUCHFILES = {\n  'broken: ['\n", 'broken maps');
    git(['tag', 'broken-maps']);
    // Commit with wrong shape (tiers value is a number)
    commitDataFile(
      'export const E2E_TOUCHFILES = {};\n'
      + "export const E2E_TIERS = { 'alpha': 1 };\n"
      + 'export const LLM_JUDGE_TOUCHFILES = {};\n'
      + 'export const GLOBAL_TOUCHFILES = [];\n',
      'wrong shape',
    );
    git(['tag', 'wrong-shape']);
    // Commit that deletes the data file entirely (ref exists, file does not)
    git(['rm', '-q', TOUCHFILES_DATA_PATH]);
    git(['commit', '-q', '-m', 'file deleted']);
    git(['tag', 'no-data-file']);
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('happy path: old version from git vs injected new maps', () => {
    const newMaps: TouchfileMaps = {
      E2E_TOUCHFILES: { 'alpha': ['a/**'], 'beta': ['b/**', 'new-dep.ts'], 'gamma': ['g/**'] },
      E2E_TIERS: { 'alpha': 'periodic', 'beta': 'periodic', 'gamma': 'gate' },
      LLM_JUDGE_TOUCHFILES: { 'judge one': ['j/SKILL.md'] },
      GLOBAL_TOUCHFILES: ['test/helpers/session-runner.ts'],
    };
    const outcome = diffTouchfileMaps('old-maps', repo, newMaps);
    if (!outcome.ok) throw new Error(`expected ok, got cause=${outcome.cause}`);
    expect(outcome.changedTests).toEqual(['alpha', 'beta', 'gamma']); // tier flip, dep edit, added
    expect(outcome.removedTests).toEqual([]);
    expect(outcome.globalTouchfilesChanged).toBe(false);
  });

  test('removed key reported from the git version too', () => {
    const newMaps: TouchfileMaps = {
      E2E_TOUCHFILES: { 'alpha': ['a/**'] },
      E2E_TIERS: { 'alpha': 'gate' },
      LLM_JUDGE_TOUCHFILES: { 'judge one': ['j/SKILL.md'] },
      GLOBAL_TOUCHFILES: ['test/helpers/session-runner.ts'],
    };
    const outcome = diffTouchfileMaps('old-maps', repo, newMaps);
    if (!outcome.ok) throw new Error(`expected ok, got cause=${outcome.cause}`);
    expect(outcome.changedTests).toEqual([]);
    expect(outcome.removedTests).toEqual(['beta']);
  });

  test('missing base ref → fail-closed with missing-base-ref', () => {
    const outcome = diffTouchfileMaps('no-such-ref-anywhere', repo);
    expect(outcome).toEqual({ ok: false, cause: 'missing-base-ref' });
  });

  test('ref exists but file absent → fail-closed with git-show-failed', () => {
    const outcome = diffTouchfileMaps('no-data-file', repo);
    expect(outcome).toEqual({ ok: false, cause: 'git-show-failed' });
  });

  test('old file fails to import → fail-closed with import-failed', () => {
    const outcome = diffTouchfileMaps('broken-maps', repo);
    expect(outcome).toEqual({ ok: false, cause: 'import-failed' });
  });

  test('old file has unexpected shape → fail-closed with shape-mismatch', () => {
    const outcome = diffTouchfileMaps('wrong-shape', repo);
    expect(outcome).toEqual({ ok: false, cause: 'shape-mismatch' });
  });

  test('end-to-end against this repo: HEAD version evaluates and diffs', () => {
    // touchfiles-data.ts exists at HEAD (change-set 1). Whatever the working
    // tree currently holds, the outcome must be a successful evaluation —
    // assert shape, not content, so this stays green before and after the
    // change-set commits.
    const outcome = diffTouchfileMaps('HEAD', ROOT);
    if (!outcome.ok) throw new Error(`expected ok, got cause=${outcome.cause}`);
    expect(Array.isArray(outcome.changedTests)).toBe(true);
    expect(Array.isArray(outcome.removedTests)).toBe(true);
    expect(typeof outcome.globalTouchfilesChanged).toBe('boolean');
  });
});
