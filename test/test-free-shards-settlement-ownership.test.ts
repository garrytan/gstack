import { describe } from 'bun:test';
import { registerOwnedBrowserSettlementCases, SETTLEMENT_MODE_GROUPS } from './helpers/free-owned-browser-settlement';

describe('test-free-shards: owned detached browser settlement (ownership-mismatch modes)', () => {
  registerOwnedBrowserSettlementCases(SETTLEMENT_MODE_GROUPS.ownership);
});
