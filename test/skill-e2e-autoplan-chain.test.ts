/**
 * /autoplan cross-skill chain (periodic, paid, real-PTY).
 *
 * Asserts: when /autoplan runs against a plan fixture, the phase markers
 * the autoplan template emits appear in the correct order:
 *
 *   "**Phase 1 complete." (CEO)        →
 *   "**Phase 2 complete." (Design — only if UI scope detected) →
 *   "**Phase 3 complete." (Eng)        →
 *   "**Phase 3.5 complete." (DX — optional, skipped if no DX scope)
 *
 * Why this exists: each individual phase has its own plan-mode smoke
 * test. Nothing verifies the SEQUENCING — that phases don't run in
 * parallel, that Phase 3 doesn't start before Phase 1 ends, that
 * conditional phases (Design, DX) are skipped when their scope is absent.
 * A regression where the autoplan template wires phases concurrently
 * would not be caught by per-phase tests.
 *
 * Approach: tee timestamps as each "**Phase N complete." marker first
 * appears in the visible buffer. Assert observed ordering. Phase 2 is
 * optional — UI-heavy fixture should make it run; backend-only fixtures
 * should make it skip.
 *
 * Cost: ~$5-8/run, 10-15 min wall clock. Periodic — runs weekly.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  launchClaudePty,
  isPlanReadyVisible,
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const ROOT = path.resolve(import.meta.dir, '..');
const UI_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plans', 'ui-heavy-feature.md');

interface PhaseHit {
  phase: number;
  ts: number;
}

describeE2E('/autoplan chain ordering (periodic)', () => {
  test(
    'phases run sequentially: Phase 1 (CEO) before Phase 3 (Eng), Phase 2 (Design) between when present',
    async () => {
      // UI-heavy fixture so Phase 2 runs.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-chain-'));
      try {
        const gitRun = (args: string[]) =>
          spawnSync('git', args, { cwd: tempDir, stdio: 'pipe', timeout: 5000 });
        gitRun(['init', '-b', 'main']);
        gitRun(['config', 'user.email', 'test@test.com']);
        gitRun(['config', 'user.name', 'Test']);

        const plansDir = path.join(tempDir, '.claude', 'plans');
        fs.mkdirSync(plansDir, { recursive: true });
        fs.copyFileSync(UI_FIXTURE, path.join(plansDir, 'ui-heavy-feature.md'));
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Autoplan chain fixture\n');
        gitRun(['add', '.']);
        gitRun(['commit', '-m', 'init UI-heavy fixture']);

        const session = await launchClaudePty({
          permissionMode: 'plan',
          cwd: tempDir,
          timeoutMs: 1_080_000, // 18 min, slightly above test budget
        });

        const hits: PhaseHit[] = [];
        let outcome: 'chain_complete' | 'plan_ready' | 'timeout' | 'exited' = 'timeout';
        let evidence = '';

        try {
          await Bun.sleep(8000);
          const since = session.mark();
          session.send('/autoplan\r');

          const budgetMs = 900_000; // 15 min
          const start = Date.now();
          // Phase markers in autoplan/SKILL.md (lines 1126, 1211, 1331, 1437):
          //   "**Phase 1 complete." / "**Phase 2 complete." / "**Phase 3 complete." / "**Phase 3.5 complete."
          const phasePattern = /\*\*Phase\s+(\d+(?:\.\d+)?)\s+complete\.?\*\*/g;

          let lastPermSig = '';
          while (Date.now() - start < budgetMs) {
            await Bun.sleep(5000);
            if (session.exited()) {
              outcome = 'exited';
              evidence = session.visibleSince(since).slice(-3000);
              break;
            }
            const visible = session.visibleSince(since);

            // Auto-grant any permission dialog so autoplan can keep moving
            // through its phases. The autoplan template auto-decides AskUserQuestions
            // it owns; only permission prompts (file/tool grants) need our
            // hand-pressing. Classify on tail to avoid stale matches.
            const recentTail = visible.slice(-1500);
            if (isNumberedOptionListVisible(recentTail) && isPermissionDialogVisible(recentTail)) {
              const sig = visible.slice(-500);
              if (sig !== lastPermSig) {
                lastPermSig = sig;
                session.send('1\r');
                await Bun.sleep(2000);
                continue;
              }
            }

            // Re-scan for any phase markers we haven't yet recorded.
            phasePattern.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = phasePattern.exec(visible)) !== null) {
              const phaseNum = parseFloat(m[1] ?? '0');
              if (Number.isNaN(phaseNum)) continue;
              if (hits.some(h => h.phase === phaseNum)) continue;
              hits.push({ phase: phaseNum, ts: Date.now() });
            }

            // Terminal: Phase 3 (Eng) seen — chain reached the required end.
            if (hits.some(h => h.phase === 3)) {
              outcome = 'chain_complete';
              evidence = visible.slice(-3000);
              break;
            }

            // Plan-ready as a fallback terminal — autoplan finished without
            // surfacing a Phase 3 marker. This is a regression surface.
            if (isPlanReadyVisible(visible)) {
              outcome = 'plan_ready';
              evidence = visible.slice(-3000);
              break;
            }
          }
        } finally {
          await session.close();
        }

        if (outcome === 'exited' || outcome === 'timeout') {
          throw new Error(
            `autoplan chain test FAILED: outcome=${outcome}, hits=${JSON.stringify(hits)}\n` +
              `--- evidence (last 3KB) ---\n${evidence}`,
          );
        }

        // Phase 3 (Eng) MUST have been seen.
        const ceo = hits.find(h => h.phase === 1);
        const design = hits.find(h => h.phase === 2);
        const eng = hits.find(h => h.phase === 3);
        if (!ceo || !eng) {
          throw new Error(
            `Required phase markers missing. Saw: ${JSON.stringify(hits)}\n` +
              `--- evidence ---\n${evidence}`,
          );
        }

        // Sequencing: CEO must end before Eng ends. Design (if observed)
        // must end after CEO and before Eng.
        expect(ceo.ts).toBeLessThan(eng.ts);
        if (design) {
          expect(design.ts).toBeGreaterThan(ceo.ts);
          expect(design.ts).toBeLessThan(eng.ts);
        }
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
    1_200_000, // 20 min absolute test ceiling
  );
});
