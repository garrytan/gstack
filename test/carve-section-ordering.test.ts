/**
 * E2 — carve static ordering guard (GATE tier, free, deterministic).
 *
 * The per-PR mechanical backstop for EVERY carved skill: it fails CI the moment a
 * regen drops/weakens a skeleton's STOP-Read directive, strands a section, leaks
 * heavy body back into the skeleton, or moves a post-STOP gate above the STOP.
 *
 * Data-driven from the canonical CARVE_GUARDS registry (EQ1) with per-skill
 * invariants (codex outside-voice #3 — NOT a copy of the ceo-specific test, which
 * this generalizes and retires). One test() per skill so a failure names the skill.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { checkOrdering } from './helpers/carve-guard-checks';

const ROOT = path.resolve(import.meta.dir, '..');

describe('carve static ordering (gate, free)', () => {
  for (const guard of Object.values(CARVE_GUARDS)) {
    test(`${guard.skill}: skeleton routes to sections correctly`, () => {
      const failures = checkOrdering(ROOT, guard);
      expect({ skill: guard.skill, failures }).toEqual({ skill: guard.skill, failures: [] });
    });
  }
});
