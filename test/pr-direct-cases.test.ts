/**
 * DX-11 inventory invariant: editing a paid test file runs its own gate cases
 * in the PR lane even outside the audited fast profile, whenever the runner can
 * select them by name; the rest stay visibly deferred with the fix.
 */
import { describe, expect, test } from 'bun:test';
import { buildRunManifest } from '../scripts/test-paid-shards';
import { E2E_TIERS, E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { PR_PROFILE_CASE_IDS, caseOwnerFile, prProfileDirectCase } from '../scripts/test-pr-profile';

const owned = new Map<string, string[]>();
for (const id of Object.keys(E2E_TOUCHFILES)) {
  if (E2E_TIERS[id] !== 'gate' || (PR_PROFILE_CASE_IDS as readonly string[]).includes(id)) continue;
  const owner = caseOwnerFile(id);
  if (owner) owned.set(owner, [...(owned.get(owner) ?? []), id]);
}

describe('edited paid test files select their own gate cases (DX-11)', () => {
  test('the inventory has direct cases to check', () => {
    expect(owned.size).toBeGreaterThan(10);
  });

  for (const [file, ids] of owned) {
    test(`${file}: its own gate cases run or are deferred with the fix, never a full fallback`, () => {
      const manifest = buildRunManifest({ tier: 'gate', profile: 'pr', sliceCount: 1, evalsAll: false, env: {}, changedFiles: [file] });
      expect(manifest.prCoverage?.mode).toBe('pr');
      const selected = manifest.selection!.e2e!;
      for (const id of ids) {
        if (prProfileDirectCase(id) !== null) {
          expect(selected, id).toContain(id);
          expect(manifest.entries.some(entry => entry.status === 'planned' && entry.file.split('#')[0] === file), id).toBe(true);
        } else {
          expect(selected, id).not.toContain(id);
          expect(manifest.prCoverage!.deferred.find(item => item.id === id)?.reason, id).toContain('cannot select it by name');
        }
      }
      expect(manifest.prCoverage!.directCases.every(id => ids.includes(id))).toBe(true);
    });
  }
});
