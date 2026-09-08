/**
 * /autoplan cross-skill chain (periodic, paid, real-PTY).
 *
 * Asserts: when /autoplan runs against a plan fixture, the phase markers
 * the autoplan template emits appear in the correct order:
 *
 *   "**Phase 1 complete." (CEO)        →
 *   "**Phase 2 complete." (Design — only if UI scope detected) →
 *   "**Phase 2.5 complete." (DX — optional, skipped if no DX scope) →
 *   "**Phase 3 complete." (Eng — always runs, always LAST: the required
 *     gate reviews the final amended plan)
 *
 * Why this exists: each individual phase has its own plan-mode smoke
 * test. This checks cross-phase completion order, including the conditional
 * Design/DX phases when they run. Completion markers do not establish phase
 * start times or prove that no work overlapped between phases.
 *
 * Approach: read standalone phase-completion announcements and their native
 * assistant timestamps from the isolated transcript. Assert observed ordering. Phase 2 is
 * optional — UI-heavy fixture should make it run; backend-only fixtures
 * should make it skip.
 *
 * Cost: ~$5-8/run, 10-15 min wall clock. Periodic — runs weekly.
 */

import { test, expect } from 'bun:test';
import { PTY_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stripVTControlCharacters } from 'node:util';
import {
  launchClaudePty,
  isPlanReadyVisible,
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
  selectPtyNumberedOption,
} from './helpers/claude-pty-runner';
import { autoplanRoutingSetupInput } from './helpers/autoplan-setup-question';
import { autoplanPhaseCompletions, type AutoplanPhaseHit } from './helpers/autoplan-phase-observer';
import { readPlanCountTranscript, type PlanCountTranscript } from './helpers/plan-count-transcript';
import { createPlanCountSnapshotWriter } from './helpers/plan-count-artifacts';

const describeE2E = describeE2ETier('periodic');

const ROOT = path.resolve(import.meta.dir, '..');
const UI_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plans', 'autoplan-dashboard.md');

function diagnosticTail(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(-3000);
}

describeE2E('/autoplan chain ordering (periodic)', () => {
  test(
    'phase completions are ordered: Phase 1 (CEO) before Phase 3 (Eng), Phase 2 (Design) between when present',
    async () => {
      // Chain-only fixture retains all new UI/API work and supplies existing
      // application contracts; the shared design-scope fixture stays unchanged.
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
          seedSkills: true,
          observeScreen: true,
        });

        let hits: AutoplanPhaseHit[] = [];
        let transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
        let outcome: 'chain_complete' | 'plan_ready' | 'timeout' | 'exited' = 'timeout';
        let evidence = '';
        let viewport = '';
        let fullSessionEvidence = '';
        let exitCode: number | null = null;
        let commandStartedAt = Date.now();
        const saveSnapshot = createPlanCountSnapshotWriter();
        let artifacts: { artifactDir?: string; artifactError?: string } = {};
        const observe = () => {
          transcript = session.hermeticConfigDir
            ? readPlanCountTranscript(session.hermeticConfigDir, tempDir)
            : { status: 'error', calls: [], assistantMessages: [], error: 'No isolated autoplan transcript directory' };
          hits = autoplanPhaseCompletions(transcript, commandStartedAt);
        };
        const capture = (state: string) => {
          artifacts = saveSnapshot({
            skillName: 'autoplan', cwd: tempDir, claudeConfigDir: session.hermeticConfigDir,
            raw: session.rawOutput(), visible: session.visibleText(), viewport,
            observation: { state, hits, native: transcript, exitCode: session.exitCode() },
          });
        };

        try {
          await Bun.sleep(8000);
          session.mark();
          commandStartedAt = Date.now();
          session.send('/autoplan\r');

          const budgetMs = 900_000; // 15 min
          const start = Date.now();
          let lastPermSig = '';
          let lastCheckpointAt = start;
          const seenSetupQuestions = new Set<string>();
          while (Date.now() - start < budgetMs) {
            await Bun.sleep(5000);
            viewport = await session.currentScreen();
            observe();
            if (Date.now() - lastCheckpointAt >= 30_000) {
              capture('in_progress');
              lastCheckpointAt = Date.now();
            }
            if (session.exited()) {
              outcome = 'exited';
              evidence = viewport.slice(-3000);
              break;
            }
            const visible = viewport;

            // Auto-grant any permission dialog so autoplan can keep moving
            // through its phases. The autoplan template auto-decides review
            // questions it owns. Classify on tail to avoid stale matches.
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

            // This new repository also asks once to add gstack routing to
            // CLAUDE.md. Answer only that recognized setup prompt; review and
            // taste decisions remain autoplan's responsibility. The helper
            // deduplicates the complete question before returning an input.
            const setupInput = autoplanRoutingSetupInput(visible, seenSetupQuestions, transcript.calls.find(call => !call.answered && !call.failed));
            if (setupInput !== null) {
              if (setupInput.includes('\r')) await selectPtyNumberedOption(session, Number(setupInput.trim()));
              else session.send(setupInput);
              await Bun.sleep(2000);
              continue;
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
          // Preserve boot failures omitted by mark(), and observe the real exit
          // status before close() deliberately terminates a live session.
          try {
            exitCode = session.exitCode();
            viewport = await session.currentScreen();
            fullSessionEvidence = diagnosticTail(session.visibleText());
            observe();
            capture(outcome);
          } finally { await session.close(); }
        }

        if (outcome === 'exited' || outcome === 'timeout') {
          throw new Error(
            `autoplan chain test FAILED: outcome=${outcome}, exitCode=${exitCode}, hits=${JSON.stringify(hits)}\n` +
              `Native transcript: ${transcript.status}; artifacts=${JSON.stringify(artifacts)}\n` +
              `--- post-command evidence (last 3KB) ---\n${diagnosticTail(evidence)}\n` +
              `--- full-session visible tail, including startup (last 3KB) ---\n${fullSessionEvidence}`,
          );
        }

        // Phase 3 (Eng) MUST have been seen.
        const ceo = hits.find(h => h.phase === 1);
        const design = hits.find(h => h.phase === 2);
        const eng = hits.find(h => h.phase === 3);
        if (!ceo || !eng) {
          throw new Error(
            `Required phase markers missing. Saw: ${JSON.stringify(hits)}\n` +
              `Native transcript: ${transcript.status}; artifacts=${JSON.stringify(artifacts)}\n` +
              `--- evidence ---\n${evidence}`,
          );
        }

        // Sequencing: CEO must end before Eng ends — and Eng is the terminal
        // phase (the required gate reviews the final amended plan). Design and
        // DX (if observed) must end after CEO and before Eng.
        expect(ceo.ts).toBeLessThan(eng.ts);
        if (design) {
          expect(design.ts).toBeGreaterThan(ceo.ts);
          expect(design.ts).toBeLessThan(eng.ts);
        }
        const dx = hits.find(h => h.phase === 2.5);
        if (dx) {
          expect(dx.ts).toBeGreaterThan(ceo.ts);
          expect(dx.ts).toBeLessThan(eng.ts);
        }
        // No phase marker may appear after Eng's (Eng-last invariant).
        const maxTs = Math.max(...hits.map(h => h.ts));
        expect(eng.ts).toBe(maxTs);
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
    PTY_LONG_MS, // 20 min absolute test ceiling
  );
});
