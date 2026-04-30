import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveSlug,
  statePath,
  lockPath,
  freshState,
  loadState,
  saveState,
  acquireLock,
  releaseLock,
  readLockInfo,
} from '../state';
import type { Phase } from '../types';

// Override the state directory for each test so we don't pollute the real
// ~/.gstack/build-state.
let realStateDir: string | undefined;
let tmpStateDir: string;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-state-test-'));
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

const phases: Phase[] = [
  {
    index: 0,
    number: '1',
    name: 'Foo',
    featureIndex: 0,
    featureNumber: '1',
    featureName: 'Full plan',
    testSpecDone: true,
    implementationDone: false,
    reviewDone: false,
    body: '',
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: 5,
    reviewCheckboxLine: 6,
  },
  {
    index: 1,
    number: '2',
    name: 'Bar',
    featureIndex: 0,
    featureNumber: '1',
    featureName: 'Full plan',
    testSpecDone: true,
    implementationDone: true,
    reviewDone: true,
    body: '',
    testSpecCheckboxLine: -1,
    implementationCheckboxLine: 10,
    reviewCheckboxLine: 11,
  },
];

describe('deriveSlug', () => {
  it('strips .md extension and prefixes with build-', () => {
    expect(deriveSlug('/abs/path/agnt2-impl-plan-20260427.md')).toBe(
      'build-agnt2-impl-plan-20260427'
    );
  });
  it('handles uppercase .MD', () => {
    expect(deriveSlug('foo.MD')).toBe('build-foo');
  });
});

describe('freshState', () => {
  it('marks already-checked phases as committed and others as pending', () => {
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases });
    expect(s.phases[0].status).toBe('pending');
    expect(s.phases[1].status).toBe('committed');
    expect(s.features![0].status).toBe('pending');
  });
  it('points currentPhaseIndex at first non-committed', () => {
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases });
    expect(s.currentPhaseIndex).toBe(0);
  });
  it('marks all pre-checked phases as ready to ship, not completed', () => {
    const allDone: Phase[] = phases.map((p) => ({
      ...p,
      implementationDone: true,
      reviewDone: true,
    }));
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases: allDone });
    expect(s.completed).toBe(false);
    expect(s.features![0].status).toBe('phases_done');
    expect(s.currentFeatureIndex).toBe(0);
  });

  it('creates feature states from parsed feature groups', () => {
    const s = freshState({
      planFile: '/x/foo.md',
      branch: 'main',
      phases,
      features: [
        { index: 0, number: '1', name: 'Foo feature', body: '', phaseIndexes: [0] },
        { index: 1, number: '2', name: 'Bar feature', body: '', phaseIndexes: [1] },
      ],
    });
    expect(s.features!.map((f) => f.name)).toEqual(['Foo feature', 'Bar feature']);
    expect(s.features![0].status).toBe('pending');
    expect(s.features![1].status).toBe('phases_done');
    expect(s.currentFeatureIndex).toBe(0);
  });

  it('does not create executable state for empty feature groups', () => {
    const s = freshState({
      planFile: '/x/foo.md',
      branch: 'main',
      phases,
      features: [
        { index: 0, number: '1', name: 'Empty feature', body: '', phaseIndexes: [] },
        { index: 1, number: '2', name: 'Real feature', body: '', phaseIndexes: [0, 1] },
      ],
    });
    expect(s.features!.map((f) => f.name)).toEqual(['Real feature']);
    expect(s.features![0].phaseIndexes).toEqual([0, 1]);
    expect(s.features![0].status).toBe('pending');
  });

  it('does NOT mark a phase committed when testSpecDone=false even if impl+review are checked', () => {
    const tddPhase: Phase[] = [{
      index: 0, number: '1', name: 'TDD', body: '',
      testSpecDone: false, testSpecCheckboxLine: 5,
      implementationDone: true, reviewDone: true,
      implementationCheckboxLine: 6, reviewCheckboxLine: 7,
    }];
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases: tddPhase });
    expect(s.phases[0].status).toBe('pending');
    expect(s.completed).toBe(false);
  });

  it('freshState sets impl_done (not gemini_done) when implementation checked but review is not', () => {
    const implDonePhase: Phase[] = [{
      index: 0, number: '1', name: 'ImplDone', body: '',
      testSpecDone: true, testSpecCheckboxLine: -1,
      implementationDone: true, reviewDone: false,
      implementationCheckboxLine: 5, reviewCheckboxLine: 6,
    }];
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases: implDonePhase });
    expect(s.phases[0].status).toBe('impl_done');
  });
});

describe('loadState / saveState round-trip', () => {
  it('saves and reloads a state', () => {
    const original = freshState({ planFile: '/x/foo.md', branch: 'main', phases });
    saveState(original, { noGbrain: true });
    const reloaded = loadState(original.slug, { noGbrain: true });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.slug).toBe(original.slug);
    expect(reloaded!.phases).toHaveLength(2);
    expect(reloaded!.phases[1].status).toBe('committed');
  });

  it('returns null when no state file exists (and no gbrain)', () => {
    expect(loadState('build-nonexistent', { noGbrain: true })).toBeNull();
  });

  it('throws on corrupt state', () => {
    const slug = 'build-corrupt';
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), '{not valid json');
    expect(() => loadState(slug, { noGbrain: true })).toThrow(/corrupt/);
  });

  it('updates lastUpdatedAt on every save', async () => {
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases });
    saveState(s, { noGbrain: true });
    const first = s.lastUpdatedAt;
    await new Promise((r) => setTimeout(r, 10));
    saveState(s, { noGbrain: true });
    expect(s.lastUpdatedAt).not.toBe(first);
  });

  it('writes via temp+rename (no .tmp.* file left behind on success)', () => {
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases });
    saveState(s, { noGbrain: true });
    const dir = path.dirname(statePath(s.slug));
    const stragglers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stragglers).toHaveLength(0);
  });

  it('loadState migrates persisted gemini_done → impl_done (rename backward compat)', () => {
    // Simulate a state file written before the gemini_done→impl_done rename.
    const slug = 'build-migration-test';
    const oldState = {
      planFile: '/x/foo.md', planBasename: 'foo', slug,
      branch: 'main', startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(), currentPhaseIndex: 0,
      phases: [{ index: 0, number: '1', name: 'Foo', status: 'gemini_done' }],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.phases[0].status).toBe('impl_done');
  });

  it('loadState keeps legacy all-phase-done state unshipped when completed=false', () => {
    const slug = 'build-legacy-unshipped-test';
    const oldState = {
      planFile: '/x/foo.md', planBasename: 'foo', slug,
      branch: 'feat/foo', startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(), currentPhaseIndex: 0,
      phases: [
        { index: 0, number: '1', name: 'Foo', status: 'committed' },
        { index: 1, number: '2', name: 'Bar', status: 'committed' },
      ],
      completed: false,
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.features![0].status).toBe('pending');
    expect(loaded!.currentFeatureIndex).toBe(0);
    fs.rmSync(statePath(slug), { force: true });
  });

  it('loadState migrates legacy model fields into roleConfigs', () => {
    const slug = 'build-model-migration-test';
    const oldState = {
      planFile: '/x/foo.md', planBasename: 'foo', slug,
      branch: 'main', startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(), currentPhaseIndex: 0,
      phases: [{ index: 0, number: '1', name: 'Foo', status: 'pending' }],
      completed: false,
      geminiModel: 'gemini-old',
      codexModel: 'codex-old',
      codexReviewModel: 'review-old',
    };
    fs.mkdirSync(path.dirname(statePath(slug)), { recursive: true });
    fs.writeFileSync(statePath(slug), JSON.stringify(oldState));
    const loaded = loadState(slug, { noGbrain: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.roleConfigs!.primaryImpl.model).toBe('gemini-old');
    expect(loaded!.roleConfigs!.secondaryImpl.model).toBe('codex-old');
    expect(loaded!.roleConfigs!.reviewSecondary.model).toBe('review-old');
  });
});

describe('lock acquire / release', () => {
  it('first acquire succeeds, second on same slug fails', () => {
    expect(acquireLock('build-x')).toBe(true);
    expect(acquireLock('build-x')).toBe(false);
    releaseLock('build-x');
  });

  it('release lets next acquire succeed', () => {
    acquireLock('build-x');
    releaseLock('build-x');
    expect(acquireLock('build-x')).toBe(true);
    releaseLock('build-x');
  });

  it('release on missing lock is a no-op (no throw)', () => {
    expect(() => releaseLock('build-never-locked')).not.toThrow();
  });

  it('readLockInfo returns the pid + timestamp written at acquire', () => {
    acquireLock('build-x');
    const info = readLockInfo('build-x');
    expect(info).toContain(String(process.pid));
    releaseLock('build-x');
  });

  it('readLockInfo returns null when no lock', () => {
    expect(readLockInfo('build-no-lock')).toBeNull();
  });
});

describe('paths', () => {
  it('statePath, lockPath are siblings under ~/.gstack/build-state', () => {
    const s = statePath('build-x');
    const l = lockPath('build-x');
    expect(path.dirname(s)).toBe(path.dirname(l));
    expect(s.endsWith('build-x.json')).toBe(true);
    expect(l.endsWith('build-x.lock')).toBe(true);
  });
});
