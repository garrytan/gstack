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

// Override HOME for the duration of each test so we don't pollute the
// real ~/.gstack/build-state.
let realHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-state-test-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (realHome) process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const phases: Phase[] = [
  {
    index: 0,
    number: '1',
    name: 'Foo',
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
  });
  it('points currentPhaseIndex at first non-committed', () => {
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases });
    expect(s.currentPhaseIndex).toBe(0);
  });
  it('marks build completed when all phases are pre-checked', () => {
    const allDone: Phase[] = phases.map((p) => ({
      ...p,
      implementationDone: true,
      reviewDone: true,
    }));
    const s = freshState({ planFile: '/x/foo.md', branch: 'main', phases: allDone });
    expect(s.completed).toBe(true);
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
