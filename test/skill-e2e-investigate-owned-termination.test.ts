import { afterAll, test } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import { runBoundaryActor } from './helpers/workflow-boundaries-fixture';

const describeE2E = describeE2ETier('gate');
const collector = e2eTierEnabled('gate') ? new EvalCollector('e2e') : null;
describeE2E('/investigate run-owned terminal paths', () => {
  test('investigate-owned-abort', async () => {
    await runBoundaryActor('investigate-owned-abort', entry => collector!.addTest(entry));
  }, CAPTURE_MS);
  test('investigate-owned-ending-error', async () => {
    await runBoundaryActor('investigate-owned-ending-error', entry => collector!.addTest(entry));
  }, CAPTURE_MS);
});
afterAll(async () => { await collector?.finalize(); });
