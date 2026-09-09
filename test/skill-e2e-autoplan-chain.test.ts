/**
 * /autoplan native chain sequencing (periodic, paid, real PTY).
 *
 * The calibrated UI/API fixture requires full CEO → Design → DX → Eng review.
 * This test disables only the outside CLI through codex_reviews; the native
 * subagents and every applicable phase still run. Require real native phase
 * completion announcements in order, with Eng last. Completion order does not
 * establish phase start times or prove non-overlap.
 *
 * Outside coverage here is disabled, never completed. The separate dual-voice
 * and cross-harness evals exercise provider dispatch; this test does not replace
 * those or establish per-phase Autoplan outside completion coverage.
 *
 * Specified four-phase allowance: 80 min work, 84 min session, 85 min test.
 * This changes eval timing policy; it is not measured calibration.
 */

import { test, expect } from 'bun:test';
import { AUTOPLAN_CHAIN_BUDGET } from './helpers/eval-budgets';
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
import { autoplanSetupDecision, type AutoplanSetupDecision } from './helpers/autoplan-setup-question';
import { autoplanPhaseCompletions, type AutoplanPhaseHit } from './helpers/autoplan-phase-observer';
import { readPlanCountTranscript, type PlanCountTranscript } from './helpers/plan-count-transcript';
import { createPlanCountSnapshotWriter } from './helpers/plan-count-artifacts';
import { createNativeReviewState } from './helpers/plan-count-fixture';

const describeE2E = describeE2ETier('periodic');

const ROOT = path.resolve(import.meta.dir, '..');
const UI_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plans', 'autoplan-dashboard.md');

function diagnosticTail(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(-3000);
}

describeE2E('/autoplan native chain ordering (periodic)', () => {
  test(
    'full native phase completions are ordered: CEO before Design before DX before Eng',
    async () => {
      // Chain-only fixture retains all new UI/API work and supplies existing
      // application contracts; the shared design-scope fixture stays unchanged.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-chain-'));
      let nativeState: ReturnType<typeof createNativeReviewState> | undefined;
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

        nativeState = createNativeReviewState();
        const session = await launchClaudePty({
          env: nativeState.env,
          permissionMode: 'plan',
          cwd: tempDir,
          timeoutMs: AUTOPLAN_CHAIN_BUDGET.sessionMs,
          seedSkills: true,
          observeScreen: true,
        });

        let hits: AutoplanPhaseHit[] = [];
        let transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
        let outcome: 'chain_complete' | 'plan_ready' | 'timeout' | 'exited' | 'unsupported_setup' = 'timeout';
        let unsupportedSetup: Extract<AutoplanSetupDecision, { kind: 'unsupported_setup' }> | null = null;
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
            observation: { state, hits, native: transcript, exitCode: session.exitCode(), unsupportedSetup,
              retention: 'Current raw/visible/viewport and parsed native metadata only; full parent JSONL retention is not guaranteed.' },
          });
        };

        try {
          await Bun.sleep(8000);
          session.mark();
          commandStartedAt = Date.now();
          session.send('/autoplan\r');

          const budgetMs = AUTOPLAN_CHAIN_BUDGET.workMs;
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

            // This new repository offers routing and an optional design-doc
            // prerequisite. Keep the supplied plan and continue its full
            // review; taste decisions remain autoplan's responsibility. The helper
            // deduplicates the complete question before returning an input.
            const setup = autoplanSetupDecision(visible, seenSetupQuestions, transcript.calls.find(call => !call.answered && !call.failed));
            if (setup.kind === 'input') {
              if (setup.input.includes('\r')) await selectPtyNumberedOption(session, Number(setup.input.trim()));
              else session.send(setup.input);
              for (const signature of setup.signatures) seenSetupQuestions.add(signature);
              await Bun.sleep(2000);
              continue;
            }
            if (setup.kind === 'unsupported_setup') {
              outcome = 'unsupported_setup';
              unsupportedSetup = setup;
              evidence = viewport.slice(-3000);
              break;
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

        if (outcome === 'exited' || outcome === 'timeout' || outcome === 'unsupported_setup') {
          throw new Error(
            `autoplan chain test FAILED: outcome=${outcome}, exitCode=${exitCode}, hits=${JSON.stringify(hits)}\n` +
              `Native transcript: ${transcript.status}; artifacts=${JSON.stringify(artifacts)}\n` +
              (unsupportedSetup ? `Unsupported setup: ${JSON.stringify(unsupportedSetup)}; no input sent. Artifacts contain UI and parsed metadata, not guaranteed full parent JSONL.\n` : '') +
              `--- post-command evidence (last 3KB) ---\n${diagnosticTail(evidence)}\n` +
              `--- full-session visible tail, including startup (last 3KB) ---\n${fullSessionEvidence}`,
          );
        }

        // Phase 3 (Eng) MUST have been seen.
        const ceo = hits.find(h => h.phase === 1);
        const design = hits.find(h => h.phase === 2);
        const dx = hits.find(h => h.phase === 2.5);
        const eng = hits.find(h => h.phase === 3);
        if (!ceo || !design || !dx || !eng) {
          throw new Error(
            `Required phase markers missing. Saw: ${JSON.stringify(hits)}\n` +
              `Native transcript: ${transcript.status}; artifacts=${JSON.stringify(artifacts)}\n` +
              `--- evidence ---\n${evidence}`,
          );
        }

        // This fixture has UI and API scope: all four phases are required.
        expect(ceo.ts).toBeLessThan(design.ts);
        expect(design.ts).toBeLessThan(dx.ts);
        expect(dx.ts).toBeLessThan(eng.ts);
        // No phase marker may appear after Eng's (Eng-last invariant).
        const maxTs = Math.max(...hits.map(h => h.ts));
        expect(eng.ts).toBe(maxTs);
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        finally { nativeState?.cleanup(); }
      }
    },
    AUTOPLAN_CHAIN_BUDGET.testMs, // explicit registered four-phase exception
  );
});
