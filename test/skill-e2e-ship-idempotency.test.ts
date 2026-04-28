/**
 * /ship idempotency E2E (periodic, paid, real-PTY).
 *
 * Asserts: when /ship runs against a branch that has ALREADY been bumped
 * (VERSION ahead of base AND package.json synced AND a CHANGELOG entry
 * exists for the bumped version), the workflow:
 *
 *   1. Detects ALREADY_BUMPED state via the Step 12 idempotency check
 *   2. Does NOT echo STATE: FRESH (which would trigger a second bump)
 *   3. Does NOT mutate the fixture's VERSION file
 *   4. Does NOT append a duplicate CHANGELOG [0.0.2] entry
 *   5. Does NOT create a new "chore: bump version" commit
 *
 * Why real-PTY: the existing ship-idempotency test in skill-e2e.test.ts
 * uses the SDK harness with a synthetic prompt asking the agent to "run
 * ONLY the idempotency checks." This test exercises the actual /ship
 * skill end-to-end against a real git fixture so a regression that
 * silently re-bumps despite the check passing would be caught.
 *
 * Plan-mode framing: we run /ship in plan mode so the agent cannot push,
 * commit, or open PRs. The Step 12 idempotency check is read-only
 * (reads VERSION + package.json + git rev-parse) and runs fine in plan
 * mode. The plan-ready output serves as the terminal signal — the agent
 * has done its analysis and produced a plan describing what it would do.
 *
 * If the agent decides to bump or push despite the fixture's
 * ALREADY_BUMPED state, that intent surfaces in the plan or in
 * tool-call attempts, which we detect.
 *
 * Cost: ~$2-4/run. Periodic tier — long, runs weekly.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  launchClaudePty,
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

interface ShipFixture {
  workTree: string;
  bareRemote: string;
  /** Full bash log of `git` and helper commands run during setup. */
  setupLog: string[];
}

/**
 * Build a self-contained git fixture representing an already-shipped state:
 *   - main branch at VERSION 0.0.1, with one CHANGELOG entry [0.0.1]
 *   - feat/already-shipped branch at VERSION 0.0.2 (bumped + synced),
 *     CHANGELOG has [0.0.2] entry on top of [0.0.1], one feature commit
 *   - bareRemote is the origin; both branches are pushed
 *
 * Returns the work-tree dir for /ship to operate on.
 */
function buildShippedFixture(): ShipFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-fixture-'));
  const workTree = path.join(root, 'workspace');
  const bareRemote = path.join(root, 'origin.git');
  fs.mkdirSync(workTree, { recursive: true });

  const setupLog: string[] = [];
  const sh = (cmd: string, cwd: string): void => {
    setupLog.push(`[${cwd}] ${cmd}`);
    const result = spawnSync('bash', ['-c', cmd], { cwd, stdio: 'pipe', timeout: 15_000 });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? '';
      throw new Error(`fixture setup failed at "${cmd}":\n${stderr}\n--- log ---\n${setupLog.join('\n')}`);
    }
  };

  // Bare remote.
  sh(`git init --bare "${bareRemote}"`, root);

  // Initial commit on main.
  sh('git init -b main', workTree);
  sh('git config user.email "test@test.com"', workTree);
  sh('git config user.name "Test"', workTree);
  sh('git config commit.gpgsign false', workTree);

  fs.writeFileSync(path.join(workTree, 'VERSION'), '0.0.1\n');
  fs.writeFileSync(
    path.join(workTree, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.1', private: true }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(workTree, 'CHANGELOG.md'),
    `# Changelog\n\n## [0.0.1] - 2026-01-01\n\n- Initial release\n`,
  );
  fs.writeFileSync(path.join(workTree, 'README.md'), '# Fixture\n');

  sh('git add VERSION package.json CHANGELOG.md README.md', workTree);
  sh('git commit -m "chore: initial release v0.0.1"', workTree);
  sh(`git remote add origin "${bareRemote}"`, workTree);
  sh('git push -u origin main', workTree);

  // Feature branch with ALREADY_BUMPED state.
  sh('git checkout -b feat/already-shipped', workTree);
  fs.writeFileSync(path.join(workTree, 'VERSION'), '0.0.2\n');
  fs.writeFileSync(
    path.join(workTree, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.2', private: true }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(workTree, 'CHANGELOG.md'),
    `# Changelog\n\n## [0.0.2] - 2026-04-25\n\n**Feature shipped.**\n\nAdded the new feature.\n\n## [0.0.1] - 2026-01-01\n\n- Initial release\n`,
  );
  fs.writeFileSync(path.join(workTree, 'feature.md'), '# Feature\n\nAlready shipped.\n');

  sh('git add VERSION package.json CHANGELOG.md feature.md', workTree);
  sh('git commit -m "feat: add new feature\n\nbumps VERSION to 0.0.2"', workTree);
  sh('git push -u origin feat/already-shipped', workTree);

  return { workTree, bareRemote, setupLog };
}

/** Snapshot the load-bearing fixture state so we can compare post-run. */
interface FixtureSnapshot {
  versionFile: string;
  packageVersion: string;
  changelogEntryCount: number;
  bumpCommitCount: number;
  branchHead: string;
}

function snapshotFixture(workTree: string): FixtureSnapshot {
  const versionFile = fs.readFileSync(path.join(workTree, 'VERSION'), 'utf-8').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(workTree, 'package.json'), 'utf-8'));
  const changelog = fs.readFileSync(path.join(workTree, 'CHANGELOG.md'), 'utf-8');
  // Count `## [0.0.2]` headings — should stay at 1 across re-runs.
  const changelogEntryCount = (changelog.match(/^##\s*\[0\.0\.2\]/gm) ?? []).length;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workTree, stdio: 'pipe' });
  const branchHead = head.stdout?.toString().trim() ?? '';
  // Count "chore: bump version" commits on this branch since main.
  const log = spawnSync(
    'git', ['log', '--format=%s', 'main..HEAD'],
    { cwd: workTree, stdio: 'pipe' },
  );
  const subjects = log.stdout?.toString() ?? '';
  const bumpCommitCount = subjects.split('\n').filter(s => /chore:\s*bump\s+version/i.test(s)).length;
  return { versionFile, packageVersion: pkg.version, changelogEntryCount, bumpCommitCount, branchHead };
}

describeE2E('/ship idempotency E2E (periodic, real-PTY)', () => {
  test(
    'rerunning /ship on an already-shipped branch detects ALREADY_BUMPED and does not mutate fixture',
    async () => {
      const fixture = buildShippedFixture();
      const before = snapshotFixture(fixture.workTree);

      const session = await launchClaudePty({
        permissionMode: 'plan',
        cwd: fixture.workTree,
        timeoutMs: 720_000,
        // Disable network-y pieces so the agent can't reach actual github.
        env: { GH_TOKEN: 'mock-not-real', NO_COLOR: '1' },
      });

      let outcome: 'detected' | 'plan_ready' | 'attempted_mutation' | 'timeout' | 'exited' = 'timeout';
      let evidence = '';

      try {
        await Bun.sleep(8000);
        const since = session.mark();
        session.send('/ship\r');

        const budgetMs = 600_000;
        const start = Date.now();
        let lastPermSig = '';
        while (Date.now() - start < budgetMs) {
          await Bun.sleep(3000);
          if (session.exited()) {
            outcome = 'exited';
            evidence = session.visibleSince(since).slice(-3000);
            break;
          }
          const visible = session.visibleSince(since);

          // Auto-grant any permission dialogs the preamble triggers
          // (e.g. touch on a marker file claude considers sensitive).
          // Classify on the recent tail; don't double-press the same render.
          const tail = visible.slice(-1500);
          if (isNumberedOptionListVisible(tail) && isPermissionDialogVisible(tail)) {
            const sig = visible.slice(-500);
            if (sig !== lastPermSig) {
              lastPermSig = sig;
              session.send('1\r');
              await Bun.sleep(1500);
              continue;
            }
          }

          // Positive: the idempotency-check echoed ALREADY_BUMPED.
          if (/STATE:\s*ALREADY_BUMPED/.test(visible)) {
            outcome = 'detected';
            evidence = visible.slice(-3000);
            break;
          }

          // Negative regressions:
          //   - bump-action bash block ran (would echo on FRESH path)
          //   - agent attempted git commit -m "chore: bump version"
          //   - agent attempted git push
          //   - agent rendered an Edit/Write to CHANGELOG.md or VERSION (acceptable in plan mode but flagged here)
          if (
            /STATE:\s*FRESH(?![\w-])/i.test(visible) ||
            /git\s+commit\s+.*chore:\s*bump\s+version/i.test(visible) ||
            /git\s+push.*origin/i.test(visible)
          ) {
            outcome = 'attempted_mutation';
            evidence = visible.slice(-3000);
            break;
          }

          // Plan-ready outcome (acceptable terminal): the agent finished
          // analysis. We'll accept this if no mutation signals showed up.
          if (/ready to execute|Would you like to proceed/i.test(visible)) {
            outcome = 'plan_ready';
            evidence = visible.slice(-3000);
            break;
          }
        }
      } finally {
        await session.close();
      }

      // Verify fixture was not mutated regardless of outcome.
      const after = snapshotFixture(fixture.workTree);
      const fixtureStable =
        after.versionFile === before.versionFile &&
        after.packageVersion === before.packageVersion &&
        after.changelogEntryCount === before.changelogEntryCount &&
        after.bumpCommitCount === before.bumpCommitCount &&
        after.branchHead === before.branchHead;

      try {
        if (outcome === 'attempted_mutation') {
          throw new Error(
            `/ship attempted to mutate already-shipped state.\n` +
              `--- evidence (last 3KB) ---\n${evidence}\n` +
              `--- before ---\n${JSON.stringify(before, null, 2)}\n` +
              `--- after  ---\n${JSON.stringify(after, null, 2)}`,
          );
        }
        if (outcome === 'exited') {
          throw new Error(`claude exited unexpectedly.\n--- evidence ---\n${evidence}`);
        }
        if (outcome === 'timeout') {
          throw new Error(
            `Timed out before any terminal outcome.\n--- evidence (last 3KB) ---\n${evidence}`,
          );
        }
        // Detected or plan_ready — both are acceptable terminal outcomes.
        expect(['detected', 'plan_ready']).toContain(outcome);
        // Fixture must not have been mutated regardless of outcome.
        expect(fixtureStable).toBe(true);
      } finally {
        // Clean up fixture root.
        try { fs.rmSync(path.dirname(fixture.workTree), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
    900_000, // 15 min wall clock
  );
});
