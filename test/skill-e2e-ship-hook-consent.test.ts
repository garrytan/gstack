import { afterAll, test } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import { runShipHookActor } from './helpers/ship-hook-actor';

const describeE2E = describeE2ETier('gate');
const collector = e2eTierEnabled('gate') ? new EvalCollector('e2e', undefined, 'ship-hook-consent') : null;
describeE2E('/ship unmanaged hook boundaries', () => {
  test('ship-unmanaged-hook-consent', async () => {
    await runShipHookActor('ship-unmanaged-hook-consent', entry => collector!.addTest(entry));
  }, CAPTURE_MS);
  test('ship-local-hook-preservation', async () => {
    await runShipHookActor('ship-local-hook-preservation', entry => collector!.addTest(entry));
  }, CAPTURE_MS);
});
afterAll(async () => { await collector?.finalize(); });
