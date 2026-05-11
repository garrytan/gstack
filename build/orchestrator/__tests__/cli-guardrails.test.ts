/**
 * Tests for printPhaseReport and verifyPostShip.
 *
 * verifyPostShip tests use a real local git repo with a bare "origin" so all
 * git operations work without network access. The gh check is exercised via
 * the failure path (gh not authed in CI, status !== 0 → warning line).
 */
import { describe, it, expect, beforeAll, afterAll, spyOn, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { printPhaseReport, verifyPostShip } from '../cli';
import type { Phase, PhaseState } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makePhase(overrides?: Partial<Phase>): Phase {
  return {
    index: 0,
    number: '1',
    name: 'Auth middleware',
    body: '',
    testSpecDone: false,
    testSpecCheckboxLine: 5,
    implementationCheckboxLine: 6,
    reviewCheckboxLine: 7,
    implementationDone: false,
    reviewDone: false,
    dualImpl: false,
    kind: 'code',
    ...overrides,
  };
}

function makePhaseState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    index: 0,
    number: '1',
    name: 'Auth middleware',
    status: 'committed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// printPhaseReport tests
// ---------------------------------------------------------------------------

describe('printPhaseReport', () => {
  let tmpDir: string;
  let repoPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-report-test-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    git(['init', '--initial-branch=main'], repoPath);
    git(['config', 'user.email', 'test@test.com'], repoPath);
    git(['config', 'user.name', 'Test User'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'initial commit for phase report test'], repoPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints PHASE N COMPLETE banner with phase number and name', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    printPhaseReport(makePhase(), makePhaseState(), null, repoPath);
    spy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('PHASE 1 COMPLETE');
    expect(out).toContain('Auth middleware');
  });

  it('shows FINAL SHIP when nextPhaseName is null', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    printPhaseReport(makePhase(), makePhaseState(), null, repoPath);
    spy.mockRestore();
    expect(logs.join('\n')).toContain('FINAL SHIP');
  });

  it('shows next phase name when provided', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    printPhaseReport(makePhase(), makePhaseState(), 'Database layer', repoPath);
    spy.mockRestore();
    expect(logs.join('\n')).toContain('Database layer');
  });

  it('shows Test Spec line when geminiTestSpec is present', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    const stateWithSpec = makePhaseState({
      geminiTestSpec: { startedAt: new Date().toISOString(), outputLogPath: 'x.log', retries: 0, exitCode: 0 },
    });
    printPhaseReport(makePhase(), stateWithSpec, null, repoPath);
    spy.mockRestore();
    expect(logs.join('\n')).toContain('Test Spec:');
  });

  it('omits Test Spec line when geminiTestSpec is absent', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    printPhaseReport(makePhase(), makePhaseState(), null, repoPath);
    spy.mockRestore();
    expect(logs.join('\n')).not.toContain('Test Spec:');
  });

  it('shows GATE PASS in review status when verdict is GATE PASS', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    const stateWithReview = makePhaseState({
      codexReview: { iterations: 2, finalVerdict: 'GATE PASS', outputLogPaths: [] },
    });
    printPhaseReport(makePhase(), stateWithReview, null, repoPath);
    spy.mockRestore();
    expect(logs.join('\n')).toContain('GATE PASS');
    expect(logs.join('\n')).toContain('iters: 2');
  });

  it('reads commit sha from the provided cwd, not process cwd', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });
    printPhaseReport(makePhase(), makePhaseState(), null, repoPath);
    spy.mockRestore();
    // The commit message we created contains 'phase report test' — it should appear
    // in the Commit line if cwd is correctly used.
    expect(logs.join('\n')).toContain('phase report test');
  });
});

// ---------------------------------------------------------------------------
// verifyPostShip tests — real local git + bare origin
// ---------------------------------------------------------------------------

describe('verifyPostShip', () => {
  let tmpDir: string;
  let repoPath: string;
  let bareOrigin: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-post-ship-test-'));
    bareOrigin = path.join(tmpDir, 'origin.git');
    repoPath = path.join(tmpDir, 'repo');

    // Create a bare "origin" repo
    fs.mkdirSync(bareOrigin, { recursive: true });
    git(['init', '--bare', '--initial-branch=main'], bareOrigin);

    // Create the working repo cloned from bare
    git(['clone', bareOrigin, repoPath], tmpDir);
    git(['config', 'user.email', 'test@test.com'], repoPath);
    git(['config', 'user.name', 'Test User'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'initial'], repoPath);
    git(['push', 'origin', 'main'], repoPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports clean working tree when no uncommitted changes', async () => {
    const { report } = await verifyPostShip(repoPath, 'main');
    const out = report.join('\n');
    expect(out).toContain('Working tree: ✅ clean');
  });

  it('reports dirty working tree when uncommitted changes exist', async () => {
    fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'untracked');
    const { ok, report } = await verifyPostShip(repoPath, 'main');
    fs.unlinkSync(path.join(repoPath, 'dirty.txt'));
    expect(ok).toBe(false);
    expect(report.join('\n')).toContain('⚠ dirty');
  });

  it('reports in sync when local HEAD matches the remote base', async () => {
    const { report } = await verifyPostShip(repoPath, 'main');
    expect(report.join('\n')).toContain('Base sync:   ✅ in sync with origin/main');
  });

  it('reports HEAD mismatch and sets ok=false when local is ahead of origin', async () => {
    // Make a local commit without pushing
    fs.writeFileSync(path.join(repoPath, 'ahead.txt'), 'ahead');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'local only'], repoPath);
    const { ok, report } = await verifyPostShip(repoPath, 'main');
    // Restore: push so later tests are clean
    git(['push', 'origin', 'main'], repoPath);
    expect(ok).toBe(false);
    expect(report.join('\n')).toContain('⚠ local HEAD');
  });

  it('uses origin/HEAD for post-ship checks when the default branch is not main', async () => {
    const nonMainTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-post-ship-develop-'));
    const nonMainBare = path.join(nonMainTmp, 'origin.git');
    const nonMainRepo = path.join(nonMainTmp, 'repo');
    try {
      fs.mkdirSync(nonMainBare, { recursive: true });
      git(['init', '--bare', '--initial-branch=develop'], nonMainBare);
      git(['clone', nonMainBare, nonMainRepo], nonMainTmp);
      git(['config', 'user.email', 'test@test.com'], nonMainRepo);
      git(['config', 'user.name', 'Test User'], nonMainRepo);
      fs.writeFileSync(path.join(nonMainRepo, 'README.md'), 'develop\n');
      git(['add', '.'], nonMainRepo);
      git(['commit', '-m', 'develop init'], nonMainRepo);
      git(['push', '-u', 'origin', 'develop'], nonMainRepo);
      git(['fetch', 'origin'], nonMainRepo);
      git(['remote', 'set-head', 'origin', '-a'], nonMainRepo);

      const { report } = await verifyPostShip(nonMainRepo, 'develop');
      const out = report.join('\n');

      expect(out).toContain('Branches:    ✅ no unmerged feat/* on origin/develop');
      expect(out).toContain('Base sync:   ✅ in sync with origin/develop');
    } finally {
      fs.rmSync(nonMainTmp, { recursive: true, force: true });
    }
  });

  it('reports no unmerged feat/* branches when branch list is clean', async () => {
    const { report } = await verifyPostShip(repoPath, 'main');
    expect(report.join('\n')).toContain('Branches:    ✅ no unmerged feat/*');
  });

  it('reports unmerged feat/* branch when one exists on origin', async () => {
    // Push a feat branch to origin without merging it
    git(['checkout', '-b', 'feat/unmerged-test'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'feat.txt'), 'work');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'feat work'], repoPath);
    git(['push', 'origin', 'feat/unmerged-test'], repoPath);
    git(['checkout', 'main'], repoPath);

    const { ok, report } = await verifyPostShip(repoPath, 'main');

    // Cleanup: delete the remote branch
    git(['push', 'origin', '--delete', 'feat/unmerged-test'], repoPath);
    git(['branch', '-D', 'feat/unmerged-test'], repoPath);

    expect(ok).toBe(false);
    expect(report.join('\n')).toContain('feat/unmerged-test');
  });

  it('excludes the current ship branch from the unmerged check', async () => {
    // Push a feat branch — simulate shipping FROM that branch
    git(['checkout', '-b', 'feat/being-shipped'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'ship.txt'), 'ship');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'shipping this'], repoPath);
    git(['push', 'origin', 'feat/being-shipped'], repoPath);
    git(['checkout', 'main'], repoPath);

    // When branch='feat/being-shipped', that branch should be excluded from check
    const { report } = await verifyPostShip(repoPath, 'feat/being-shipped');
    const branchLine = report.find(l => l.includes('Branches:'));

    // Cleanup
    git(['push', 'origin', '--delete', 'feat/being-shipped'], repoPath);
    git(['branch', '-D', 'feat/being-shipped'], repoPath);

    // The branch being shipped should not be flagged as unmerged
    expect(branchLine).toContain('✅ no unmerged feat/*');
  });

  it('gh failure is handled gracefully — adds to issues but does not throw', async () => {
    // gh is either not authed or not installed in test env → status !== 0
    // The function should report a warning, not crash.
    const { report } = await verifyPostShip(repoPath, 'main');
    // We can't assert the PR check passes without real gh auth, but we CAN
    // assert the function completes and returns a report array.
    expect(Array.isArray(report)).toBe(true);
    expect(report.length).toBeGreaterThan(0);
    // The PR line must be present (either ✅ or ⚠)
    const prLine = report.find(l => l.includes('PR:'));
    expect(prLine).toBeTruthy();
  });
});
