import { afterAll, test } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import { runBoundaryActor } from './helpers/workflow-boundaries-fixture';

const describeE2E = describeE2ETier('gate');
const collector = e2eTierEnabled('gate') ? new EvalCollector('e2e') : null;
describeE2E('/investigate run-owned completion', () => {
  test('investigate-owned-completion', async () => {
    await runBoundaryActor('investigate-owned-completion', entry => collector!.addTest(entry));
  }, CAPTURE_MS);
});
afterAll(async () => { await collector?.finalize(); });
