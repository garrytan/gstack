/**
 * Periodic /health behavior: full-log failure counts, visible partial coverage,
 * comparable histories, and an unscored no-tools run. One bounded capture;
 * wording follows the model, while process receipts and history are asserted.
 */
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import {
  createHealthEvalFixture, healthReportingFailures, recordHealthAttempt,
} from './helpers/health-eval-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const describeE2E = describeE2ETier('periodic');
const collector = e2eTierEnabled('periodic') ? new EvalCollector('e2e') : null;

describeE2E('/health trustworthy reporting (periodic)', () => {
  test('health-reporting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-health-eval-'));
    try {
      let fixture: ReturnType<typeof createHealthEvalFixture>;
      await recordHealthAttempt(
        entry => collector!.addTest(entry),
        async () => {
          fixture = createHealthEvalFixture(dir, ROOT);
          // The runner resolves its transcript directory on import. Keep a
          // skipped paid file free of that operator-state lookup/write.
          const { runSkillTest } = await import('./helpers/session-runner');
          return runSkillTest({
            prompt: fixture.prompt,
            workingDirectory: dir,
            maxTurns: 18,
            allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
            timeout: CAPTURE_MS,
            testName: 'health-reporting',
            // The collector retains the transcript in GSTACK_EVAL_DIR. Omit
            // runId so the runner does not write a global heartbeat/run log.
            env: { GSTACK_HOME: fixture.gstackHome },
          });
        },
        result => {
          expect(result.browseErrors).toEqual([]);
          expect(healthReportingFailures(fixture)).toEqual([]);
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, CAPTURE_LONG_MS);
});

afterAll(async () => { await collector?.finalize(); });
