/**
 * Tier-alignment invariant (free, static).
 *
 * Kills the "inert demotion" defect class: E2E_TIERS declares a test's tier,
 * but the paid test files also self-gate on `process.env.EVALS_TIER === '<tier>'`.
 * When the two disagree, the touchfiles declaration is dead metadata — the
 * #2077 demotion of the plan-mode/finding-floor smokes to 'periodic' was inert
 * for months because the files still gated on 'gate' and ran in the blocking
 * lane on every gate run.
 *
 * Mapping rule (test filenames do NOT map mechanically to tier keys): for each
 * `test/skill-e2e-*.test.ts` with an EVALS_TIER self-gate, search the
 * E2E_TOUCHFILES / LLM_JUDGE_TOUCHFILES dep lists for the exact file path. If
 * found under key K, the file's self-gate tier must equal E2E_TIERS[K].
 *
 * Self-registration is a HARD invariant (the dep-list sweep): every
 * skill-e2e file must be named in at least one touchfiles dep list, so that
 * editing only the test's prompt/assertions diff-selects the test itself.
 * Before the sweep, 129 of ~177 E2E keys did not list their own declaring
 * file — a changed test never re-ran on its own change. Files that genuinely
 * cannot be mapped (no E2E map key exists for them) sit in KNOWN_UNREGISTERED
 * below; that set is a ratchet, it only shrinks.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { E2E_TOUCHFILES, E2E_TIERS, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles';
import { isPaidTestFile } from './helpers/paid-test-set';
import { knownTestNamesInSource, PARENT_MAPPER_TEST_NAMES } from '../scripts/test-paid-shards';

const TEST_DIR = import.meta.dir;
// Both quote styles — a mechanical refactor to double quotes must not
// silently drop a file from the invariant (fail-open is the defect class
// this test exists to kill).
const SELF_GATE_RE = /EVALS_TIER\s*===\s*['"](gate|periodic)['"]/g;
// Consolidated gate helper (test/helpers/e2e-gate.ts). Both regexes stay
// active: migrated files self-gate via `describeE2ETier('<tier>')` (or the
// boolean form `e2eTierEnabled('<tier>')`), while stragglers still using the
// raw predicate are caught by SELF_GATE_RE above. The tier argument maps to
// the declared tier exactly like the raw predicate's tier literal did.
const HELPER_GATE_RE = /\b(?:describeE2ETier|e2eTierEnabled)\(\s*['"](gate|periodic)['"]/g;

/**
 * Ratchet, not amnesty (the contract KNOWN_MATRIX_GAPS pioneered before the
 * legacy eval matrix and its test retired): skill-e2e files that are named in NO
 * touchfiles dep list because no E2E map key exists for them. Every entry
 * carries a one-line reason. Do NOT add new files here — give the test an
 * E2E map key (touchfiles + tier) and register the file in its dep list.
 * A stale entry (file deleted, or file now registered) FAILS the suite —
 * delete it. Target: empty set.
 */
const KNOWN_UNREGISTERED = new Set([
  // Standalone periodic self-gated probe; template-literal testNames (auq-consistency-${i}), no E2E map key — fail-open-safe, runs on every periodic sweep.
  'test/skill-e2e-auq-consistency.test.ts',
  // Standalone periodic self-gated matrix; template-literal testNames (auq-matrix-${m.skill}), no E2E map key — fail-open-safe, runs on every periodic sweep.
  'test/skill-e2e-auq-matrix.test.ts',
  // Standalone periodic self-gated A/B probe; template-literal testNames (auq-ab-${label}), no E2E map key — fail-open-safe, runs on every periodic sweep.
  'test/skill-e2e-auq-verbose-vs-carved-ab.test.ts',
  // bin-script pipeline test (spawns bun scripts, no model spend) that lives under the skill-e2e-* glob; no E2E map key exists for it.
  'test/skill-e2e-memory-pipeline.test.ts',
]);

describe('E2E tier alignment (touchfiles declaration vs test self-gate)', () => {
  const testFiles = readdirSync(TEST_DIR)
    .filter((f) => f.startsWith('skill-e2e-') && f.endsWith('.test.ts'))
    .sort();

  const allDeps: Record<string, string[]> = { ...E2E_TOUCHFILES, ...LLM_JUDGE_TOUCHFILES };

  test('every self-gated test file named in a dep list matches its declared tier', () => {
    const misaligned: string[] = [];
    const unregistered: string[] = [];
    const reported: string[] = [];

    for (const file of testFiles) {
      const content = readFileSync(path.join(TEST_DIR, file), 'utf-8');
      const repoPath = `test/${file}`;

      // HARD self-registration invariant, independent of self-gate shape:
      // a skill-e2e file named in no dep list means editing the test itself
      // selects nothing — the changed test never re-runs on its own change.
      const owningKeys = Object.keys(allDeps).filter((k) => allDeps[k].includes(repoPath));
      if (owningKeys.length === 0 && !KNOWN_UNREGISTERED.has(repoPath)) {
        unregistered.push(
          `${repoPath}: not named in any touchfiles dep list — editing this test file would `
          + 'never diff-select it. Add the file path to its E2E map key\'s dep list in '
          + 'test/helpers/touchfiles-data.ts (do NOT extend KNOWN_UNREGISTERED for new files).',
        );
      }

      const tiers = new Set<string>();
      for (const m of content.matchAll(SELF_GATE_RE)) tiers.add(m[1]);
      for (const m of content.matchAll(HELPER_GATE_RE)) tiers.add(m[1]);
      if (tiers.size === 0) {
        // Every skill-e2e file is expected to self-gate; zero matches means
        // either a genuinely ungated file or a gate shape the regex can't
        // see — both worth a visible report, never a silent skip.
        reported.push(`${repoPath}: no detectable EVALS_TIER self-gate`);
        continue;
      }
      if (tiers.size > 1) {
        reported.push(`${repoPath}: mixed-tier self-gates (${[...tiers].join(', ')}) — not tier-checked`);
        continue;
      }
      const selfTier = [...tiers][0];

      if (owningKeys.length === 0) {
        // Only KNOWN_UNREGISTERED files reach here (anything else already
        // hard-failed above) — keep the visible nudge.
        reported.push(`${repoPath} (self-gates '${selfTier}'): not named in any touchfiles dep list`);
        continue;
      }
      for (const k of owningKeys) {
        const declared = E2E_TIERS[k];
        if (!declared) {
          // A dep-list key with no E2E_TIERS entry (e.g. an LLM-judge key)
          // can't tier-check this file — report instead of silently passing.
          reported.push(`${repoPath}: matched key '${k}' which has no E2E_TIERS entry`);
          continue;
        }
        if (declared !== selfTier) {
          misaligned.push(
            `${repoPath}: self-gates on '${selfTier}' but E2E_TIERS['${k}'] declares '${declared}' — the declaration is inert`,
          );
        }
      }
    }

    // Reported, not asserted: tier-observability holes the invariant can see
    // but not arbitrate (map-driven files legitimately have no whole-file
    // self-gate; ratcheted files stay visible). Registration itself is
    // asserted below.
    if (reported.length > 0) {
      console.warn(
        `[tier-alignment] ${reported.length} file(s) outside the tier invariant:\n  ` + reported.join('\n  '),
      );
    }

    expect(unregistered).toEqual([]);
    expect(misaligned).toEqual([]);
  });

  // Ratchet cleanup enforcement (same shrink-only contract as the retired
  // matrix test's burn-down): a KNOWN_UNREGISTERED entry whose file was deleted, or
  // whose file is now named in a dep list, is stale — delete the entry so
  // the set can only shrink.
  test('KNOWN_UNREGISTERED holds only live, still-unregistered files', () => {
    const stale = [...KNOWN_UNREGISTERED].filter((repoPath) => {
      const file = repoPath.replace(/^test\//, '');
      if (!testFiles.includes(file)) return true; // file gone
      return Object.keys(allDeps).some((k) => allDeps[k].includes(repoPath)); // now registered
    });
    expect(
      stale,
      'Entry registered in a dep list or file removed — delete it from KNOWN_UNREGISTERED.',
    ).toEqual([]);
  });

  // HARD invariant (C6): the paid sharded runner skips a skill-e2e shard when
  // none of the file's MAPPED test names (E2E map keys quoted in its source,
  // union E2E map keys whose dep list registers the file) are diff-selected.
  // A skill-e2e file the mapper cannot see at all is only safe if it provably
  // opts out of name-based selection: it must not touch the e2e-helpers
  // selection surface (describeIfSelected / runSkillTest / selectedTests) AND
  // it must carry an explicit whole-file EVALS_TIER self-gate (the child-side
  // gate that makes the parent's fail-open keep semantically correct).
  //
  // Anything else is an invisible-test-names hole: the parent could drop a
  // shard whose child would have run real work. Fix by either quoting the
  // test's E2E map key as a string literal in the file, or adding the file's
  // path to its key's dep list in test/helpers/touchfiles-data.ts.
  test('every paid skill-e2e file is visible to the parent diff mapper (or provably fail-open-safe)', () => {
    const invisible: string[] = [];

    for (const file of testFiles) {
      const repoPath = `test/${file}`;
      if (!isPaidTestFile(repoPath)) continue;
      const content = readFileSync(path.join(TEST_DIR, file), 'utf-8');

      const quoted = knownTestNamesInSource(content, PARENT_MAPPER_TEST_NAMES);
      const registered = Object.keys(E2E_TOUCHFILES).filter((k) => E2E_TOUCHFILES[k].includes(repoPath));
      if (quoted.length + registered.length > 0) continue; // parent-mappable

      const usesNameSelection = /\b(describeIfSelected|runSkillTest|selectedTests)\b/.test(content);
      // Both self-gate shapes count: the raw predicate and the consolidated
      // helper (test/helpers/e2e-gate.ts documents this file as a consumer
      // that must recognize describeE2ETier/e2eTierEnabled).
      const selfGated = /EVALS_TIER\s*===\s*['"](gate|periodic)['"]/.test(content)
        || /\b(?:describeE2ETier|e2eTierEnabled)\(\s*['"](gate|periodic)['"]/.test(content);
      if (!usesNameSelection && selfGated) continue; // fail-open-safe standalone

      invisible.push(
        `${repoPath}: invisible to the parent diff mapper — no E2E map key quoted in the file, `
        + 'not registered in any E2E_TOUCHFILES dep list, and it '
        + (usesNameSelection
          ? 'uses name-based selection (describeIfSelected/runSkillTest/selectedTests)'
          : 'has no whole-file EVALS_TIER self-gate')
        + '. Quote the test\'s E2E map key as a string literal, or add this file path to its '
        + 'key\'s dep list in test/helpers/touchfiles-data.ts.',
      );
    }

    expect(invisible).toEqual([]);
  });
});
