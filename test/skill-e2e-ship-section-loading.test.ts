/**
 * /ship section-loading E2E (periodic, paid, real-PTY) — v2 plan T9 mitigation
 * layer 5, the ONLY CI-failing guard against silent section-skip.
 *
 * After the carve, ship is a skeleton whose STOP-Read directives point at
 * sections/*.md. This test runs the REAL /ship skill in plan mode against a
 * fresh version-changing fixture and asserts the agent actually Read the
 * sections its situation requires (review-army + changelog at minimum — every
 * version-changing ship needs the pre-landing review and a CHANGELOG entry).
 *
 * Runs against the INSTALLED skill at ~/.claude/skills/gstack/ship (Codex
 * outside-voice #5: an E2E that reads repo paths would miss install-layout
 * 404s). Section reads are detected from the PTY scrollback — when the agent
 * Reads a section the tool render shows the `sections/<file>.md` path.
 *
 * Plan-mode framing keeps the agent from committing/pushing; producing a plan
 * is the terminal signal. Cost: ~$2-4/run. Periodic tier.
 *
 * Situation matrix (T1 = B): this file covers the fresh version-changing ship;
 * the already-bumped re-run is covered by skill-e2e-ship-idempotency.test.ts,
 * and a no-plan-file variant can be added to FIXTURES below.
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

/** Fresh fixture: feature branch with a real change but VERSION still == base,
 *  so /ship must bump (FRESH) and walk the full pre-landing + changelog flow. */
function buildFreshFixture(): { workTree: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-secload-'));
  const workTree = path.join(root, 'workspace');
  const bareRemote = path.join(root, 'origin.git');
  fs.mkdirSync(workTree, { recursive: true });
  const sh = (cmd: string, cwd: string): void => {
    const r = spawnSync('bash', ['-c', cmd], { cwd, stdio: 'pipe', timeout: 15_000 });
    if (r.status !== 0) throw new Error(`fixture setup failed at "${cmd}":\n${r.stderr?.toString()}`);
  };
  sh(`git init --bare "${bareRemote}"`, root);
  sh('git init -b main', workTree);
  sh('git config user.email "t@t.com" && git config user.name "T" && git config commit.gpgsign false', workTree);
  fs.writeFileSync(path.join(workTree, 'VERSION'), '0.0.1\n');
  fs.writeFileSync(path.join(workTree, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.1', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(workTree, 'CHANGELOG.md'), '# Changelog\n\n## [0.0.1] - 2026-01-01\n\n- Initial release\n');
  fs.writeFileSync(path.join(workTree, 'app.js'), '// base\n');
  sh('git add -A && git commit -m "chore: initial v0.0.1"', workTree);
  sh(`git remote add origin "${bareRemote}" && git push -u origin main`, workTree);
  // Feature branch: a real code change, VERSION untouched → FRESH (needs a bump).
  sh('git checkout -b feat/new-thing', workTree);
  fs.writeFileSync(path.join(workTree, 'app.js'), '// base\nexport function newThing() { return 42; }\n');
  fs.writeFileSync(path.join(workTree, 'app.test.js'), 'test("newThing", () => {});\n');
  sh('git add -A && git commit -m "feat: add newThing"', workTree);
  sh('git push -u origin feat/new-thing', workTree);
  return { workTree, root };
}

// Sections every version-changing ship must consult.
const REQUIRED_SECTIONS = ['review-army.md', 'changelog.md'];

describeE2E('/ship section-loading E2E (periodic, real-PTY, installed skill)', () => {
  test(
    'fresh version-changing ship Reads the required sections',
    async () => {
      const { workTree, root } = buildFreshFixture();
      const session = await launchClaudePty({
        permissionMode: 'plan',
        cwd: workTree,
        timeoutMs: 720_000,
        env: { GH_TOKEN: 'mock-not-real', NO_COLOR: '1' },
      });

      const readSections = new Set<string>();
      let planReady = false;
      try {
        await Bun.sleep(8000);
        const since = session.mark();
        session.send('/ship\r');
        const start = Date.now();
        let lastPermSig = '';
        while (Date.now() - start < 600_000) {
          await Bun.sleep(3000);
          if (session.exited()) break;
          const visible = session.visibleSince(since);
          const tail = visible.slice(-1500);
          if (isNumberedOptionListVisible(tail) && isPermissionDialogVisible(tail)) {
            const sig = visible.slice(-500);
            if (sig !== lastPermSig) { lastPermSig = sig; session.send('1\r'); await Bun.sleep(1500); continue; }
          }
          // Detect section reads from the scrollback (tool render shows the path).
          for (const m of visible.matchAll(/sections\/([A-Za-z0-9._-]+\.md)/g)) readSections.add(m[1]);
          if (/ready to execute|Would you like to proceed|GSTACK REVIEW REPORT/i.test(visible)) {
            planReady = true;
            break;
          }
        }
      } finally {
        await session.close();
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      const missing = REQUIRED_SECTIONS.filter(s => !readSections.has(s));
      expect({ planReady, read: [...readSections], missing }).toEqual({
        planReady: true,
        read: expect.any(Array),
        missing: [],
      });
    },
    900_000,
  );
});
