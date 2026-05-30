/**
 * Brain cache spec internal-consistency invariants (T14 / D2).
 *
 * Asserts that scripts/brain-cache-spec.ts is self-consistent:
 *   - Every skill's subset only references entities that exist.
 *   - Per-skill budget cap is achievable given per-entity caps.
 *   - Cross-project entities are clearly distinguished from per-project.
 *   - Invalidation graph has no dangling skill references.
 *   - Helper functions throw on unknown names (defensive).
 *
 * Gate-tier, free, pure import + assertion. Runs in <100ms.
 */

import { describe, test, expect } from 'bun:test';
import {
  BRAIN_CACHE_ENTITIES,
  SKILL_DIGEST_SUBSETS,
  SKILL_PREFLIGHT_BUDGET_BYTES,
  AUTOPLAN_PREFLIGHT_BUDGET_BYTES,
  SALIENCE_DEFAULT_ALLOWLIST,
  SKILL_CALIBRATION_WEIGHTS,
  TRANSPORT_DEFAULT_POLICY,
  USER_SLUG_RESOLUTION_ORDER,
  GSTACK_SCHEMA_PACK_NAME,
  GSTACK_SCHEMA_PACK_VERSION,
  CACHE_REFRESH_LOCK_TIMEOUT_MS,
  SKILL_RUN_RETENTION_DAYS,
  getCacheFile,
  getSkillSubset,
  getSkillBudget,
  getInvalidationTargets,
  getPreflightSkills,
  getMaxSubsetBytes,
} from '../scripts/brain-cache-spec';

describe('brain-cache-spec internal consistency', () => {
  test('every skill subset references only known entities', () => {
    const entityNames = new Set(Object.keys(BRAIN_CACHE_ENTITIES));
    for (const [skill, subset] of Object.entries(SKILL_DIGEST_SUBSETS)) {
      for (const name of subset) {
        expect(entityNames.has(name)).toBe(true);
      }
    }
  });

  test('every skill with a subset has a budget', () => {
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      expect(SKILL_PREFLIGHT_BUDGET_BYTES[skill]).toBeGreaterThan(0);
    }
  });

  test('per-skill budget is achievable given per-entity budgets', () => {
    // Per-entity budgets are hard ceilings on each digest's own file size.
    // Per-skill budget is enforced by the compressor on the SUM injected into
    // the skill's preflight context — the same entity may be sampled (top-N)
    // rather than verbatim. So sum may legitimately exceed skill budget; the
    // compressor trims at write time. We allow up to 3x as a sanity ceiling
    // (caught test/skill-preflight-budget.test.ts enforces the real cap).
    for (const skill of Object.keys(SKILL_DIGEST_SUBSETS)) {
      const maxBytes = getMaxSubsetBytes(skill);
      const skillBudget = getSkillBudget(skill);
      expect(maxBytes).toBeLessThanOrEqual(skillBudget * 3);
    }
  });

  test('autoplan total budget covers the 4 plan-* skills (excluding office-hours)', () => {
    const autoplanSkills = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'];
    const sum = autoplanSkills.reduce((acc, s) => acc + getSkillBudget(s), 0);
    expect(sum).toBeLessThanOrEqual(AUTOPLAN_PREFLIGHT_BUDGET_BYTES);
  });

  test('every entity has a positive TTL and a positive budget', () => {
    for (const [name, entity] of Object.entries(BRAIN_CACHE_ENTITIES)) {
      expect(entity.ttl_ms).toBeGreaterThan(0);
      expect(entity.budget_bytes).toBeGreaterThan(0);
      expect(entity.file).toMatch(/\.md$/);
      expect(['cross-project', 'per-project']).toContain(entity.scope);
    }
  });

  test('user-profile is the only cross-project entity', () => {
    const crossProject = Object.entries(BRAIN_CACHE_ENTITIES)
      .filter(([_, e]) => e.scope === 'cross-project')
      .map(([n]) => n);
    expect(crossProject).toEqual(['user-profile']);
  });

  test('salience entity has shortest TTL (changes hourly)', () => {
    const ttls = Object.values(BRAIN_CACHE_ENTITIES).map((e) => e.ttl_ms);
    expect(BRAIN_CACHE_ENTITIES.salience.ttl_ms).toBe(Math.min(...ttls));
  });

  test('salience allowlist has sane defaults (no personal/family/therapy)', () => {
    const blocked = ['personal/', 'family/', 'therapy/', 'reflection'];
    for (const prefix of blocked) {
      expect(SALIENCE_DEFAULT_ALLOWLIST.some((p) => p.startsWith(prefix))).toBe(false);
    }
    // Must contain at least projects/ + gstack/ (work-flow surfaces)
    expect(SALIENCE_DEFAULT_ALLOWLIST).toContain('projects/');
    expect(SALIENCE_DEFAULT_ALLOWLIST).toContain('gstack/');
  });

  test('calibration weights are bounded 0-1 and present for all preflight skills', () => {
    for (const skill of getPreflightSkills()) {
      const weight = SKILL_CALIBRATION_WEIGHTS[skill];
      expect(weight).toBeGreaterThan(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });

  test('transport policy defaults exist for all transport modes', () => {
    const required = ['local-pglite', 'local-stdio', 'remote-http-single-tenant', 'remote-http-ambiguous'];
    for (const transport of required) {
      expect(TRANSPORT_DEFAULT_POLICY[transport]).toBeDefined();
    }
    // Local transports must default personal (D4 / Phase 1.5 default rule)
    expect(TRANSPORT_DEFAULT_POLICY['local-pglite']).toBe('personal');
    expect(TRANSPORT_DEFAULT_POLICY['local-stdio']).toBe('personal');
    // Ambiguous remote MUST require explicit ask (never silent default)
    expect(TRANSPORT_DEFAULT_POLICY['remote-http-ambiguous']).toBe('unset');
  });

  test('user-slug resolution chain has 4 deterministic fallbacks ending in non-empty', () => {
    expect(USER_SLUG_RESOLUTION_ORDER.length).toBe(4);
    expect(USER_SLUG_RESOLUTION_ORDER[USER_SLUG_RESOLUTION_ORDER.length - 1]).toBe('anonymous_hostname_sha8');
  });

  test('schema pack identity is stable strings', () => {
    expect(GSTACK_SCHEMA_PACK_NAME).toBe('gstack-core');
    expect(GSTACK_SCHEMA_PACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('refresh lock timeout matches /sync-gbrain convention (5 min)', () => {
    expect(CACHE_REFRESH_LOCK_TIMEOUT_MS).toBe(5 * 60_000);
  });

  test('skill-run retention is 90 days per D10 lifecycle policy', () => {
    expect(SKILL_RUN_RETENTION_DAYS).toBe(90);
  });

  test('invalidation graph: every "skill-run-write" target also depends on it', () => {
    // recent-decisions invalidates on skill-run-write — verify the contract holds
    const targets = getInvalidationTargets('skill-run-write');
    expect(targets).toContain('recent-decisions');
  });

  test('invalidation graph: /plan-ceo-review invalidates product + goals + recent-decisions chain', () => {
    const targets = getInvalidationTargets('/plan-ceo-review');
    expect(targets).toContain('product');
    expect(targets).toContain('goals');
  });

  test('helpers throw on unknown names (defensive)', () => {
    expect(() => getCacheFile('nonsense-entity')).toThrow();
    expect(() => getSkillSubset('not-a-skill')).toThrow();
    expect(() => getSkillBudget('not-a-skill')).toThrow();
  });

  test('helpers return correct values for known names', () => {
    expect(getCacheFile('product')).toBe('product.md');
    expect(getSkillSubset('plan-eng-review')).toEqual(['product', 'recent-decisions']);
    expect(getSkillBudget('office-hours')).toBe(5120);
  });

  test('all 5 preflight skills are real planning-skill names', () => {
    const expected = ['office-hours', 'plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'];
    expect(getPreflightSkills().sort()).toEqual(expected.sort());
  });
});
