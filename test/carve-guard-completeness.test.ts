/**
 * E1 — carve-guard completeness meta-guard (GATE tier, free).
 *
 * Makes the carve gap impossible to reopen: every skill carved on disk (owns a
 * sections/manifest.json) MUST be in the canonical CARVE_GUARDS registry, and
 * vice-versa. Because the static (E2) and behavioral (T2) guards are data-driven
 * FROM the registry, registry membership IS guard coverage — so this set-parity
 * check is the whole game (codex #2: no need to grep test source). Carve a 7th
 * skill without a registry entry and this fails CI.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { checkCompleteness } from './helpers/carve-guard-checks';

const ROOT = path.resolve(import.meta.dir, '..');

describe('carve-guard completeness (gate, free)', () => {
  test('filesystem carved set == CARVE_GUARDS set, and every entry is consistent', () => {
    expect(checkCompleteness(ROOT)).toEqual([]);
  });
});
