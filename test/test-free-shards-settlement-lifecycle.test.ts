import { describe } from 'bun:test';
import { eligibleFreeRetryFiles } from '../scripts/test-free-shards';
import { registerOwnedBrowserSettlementCases, SETTLEMENT_MODE_GROUPS } from './helpers/free-owned-browser-settlement';

describe('test-free-shards: owned detached browser settlement (success, failure, timeout and cancellation)', () => {
  registerOwnedBrowserSettlementCases(SETTLEMENT_MODE_GROUPS.lifecycle, { eligibleFreeRetryFiles });
});
