/**
 * ship-policy-keys — the gstack release that introduced each .gstack/ship-policy.json key, moved out of lib/ship-policy.ts
 * (which re-exports every name here) so that file stays under its size ratchet and the line every key-adding PR edits
 * lives in its own file. This file is in .gstack/ship-policy.json stamp_paths beside lib/ship-policy.ts.
 */
import type { PolicyKey } from './ship-policy';

/**
 * The gstack release that introduced each key. Keys newer than
 * POLICY_COMPAT_FLOOR need `min_gstack_version` before they take a
 * non-default value, so a crew on mixed gstack versions sees one named
 * refusal instead of a policy each version reads differently. Unknown keys
 * always fail closed: there is no extension mechanism.
 */
export const POLICY_COMPAT_FLOOR = '1.91.98.0';
export const SHIP_QUEUE_KEYS_VERSION = '1.91.108.0';
export const TRAIN_KEYS_VERSION = '1.91.146.0';
// Each constant is the release that first reads its key: a policy declaring the key must name at least
// that version as min_gstack_version, so an older gstack refuses the policy by name instead of failing on
// an unknown key. review_scope shipped in 1.91.256.0 (#3481), docs.caps in 1.91.270.0 (#3487). A new key's
// constant is written as a tentative future version clear of main's pace (the next minor, never the next patch,
// which main takes first and the released-key test below then reds at the pin), in this exact
// `_KEY_VERSION = '<version>'` form: this file is in .gstack/ship-policy.json stamp_paths with that form as a
// stamp_patterns template, so the slot stamp's gstack-restamp stamp_paths stage moves the tentative value to the
// allocated version. The stage reads lines the branch added: a tentative value newer than the fork version moves,
// an untouched released constant stays, and a branch-added line naming the base's own version is re-read as a
// stale stamp and moves too, so never rewrite a released constant's line. Until the tree receipt accepts a
// stamp-form move whose old value is not the base version (#3512), the train's stamp-only check passes such a
// move only when the tentative value equals the base version at the slot, which a next-minor value never does:
// a PR that adds a key cannot clear the train until #3512 lands. test/gstack-ship-policy.test.ts holds
// an unreleased constant newer than every CHANGELOG heading and a released one on a heading whose entry names
// its key, so a value a stamp did not move fails there.
export const REVIEW_SCOPE_KEY_VERSION = '1.91.256.0';
export const DOCS_CAPS_KEY_VERSION = '1.91.270.0';
export const CHANGELOG_FRAGMENTS_KEY_VERSION = '1.91.336.0';
/** `bump: never` is a value of an older key, so the per-key floor check misses it; compatErrors checks it by value. */
export const BUMP_NEVER_KEY_VERSION = '1.91.353.0';
export const BASE_RED_KEY_VERSION = '1.91.374.0';
/** `train.gates` and `train.land` are values of the older train key, so compatErrors checks them by value, as for bump: never. */
export const TRAIN_GATES_KEY_VERSION = '1.92.0.0';
export const STAMP_PLACEHOLDERS_KEY_VERSION = '1.94.16.0';
export const REVIEW_EXCLUDE_KEY_VERSION = '1.93.33.0';
export const RELEASE_GATE_KEY_VERSION = '1.96.0.0';
export const REVIEW_POLICY_KEY_VERSION = '1.94.30.0';
export const MERGE_KEY_VERSION = '1.95.0.0';
export const LAND_KEY_VERSION = '1.96.0.0';
export const READERS_KEY_VERSION = '1.96.0.0';
export const BOOKKEEPING_KEY_VERSION = '1.96.0.0';
export const MECHANICAL_RETAKE_KEY_VERSION = '1.97.0.0';
export const TEST_CODE_KEY_VERSION = '1.97.0.0';
export const CI_RECORD_TIMEOUT_KEY_VERSION = '1.97.0.0';
export const PLAN_RECORD_KEY_VERSION = '1.98.0.0';
export const POLICY_KEY_INTRODUCED: Record<PolicyKey, string> = {
  bump: '1.91.73.0', queue_mode: '1.91.73.0', release_tool: '1.91.73.0', release_outputs: '1.91.73.0', stamp_paths: '1.91.73.0',
  changelog: '1.91.73.0', mirror: '1.91.73.0', history: '1.91.73.0', preregistration_shas: '1.91.73.0', stamp_sensitive_gates: '1.91.73.0',
  pr_count: '1.91.73.0', maintainers: '1.91.73.0', stamp_files: '1.91.98.0', stamp_patterns: '1.91.98.0', restamp_command: '1.91.98.0',
  migrations: '1.91.98.0', gate_command: SHIP_QUEUE_KEYS_VERSION, full_e2e: SHIP_QUEUE_KEYS_VERSION, min_gstack_version: SHIP_QUEUE_KEYS_VERSION,
  train: TRAIN_KEYS_VERSION, review_scope: REVIEW_SCOPE_KEY_VERSION, docs: DOCS_CAPS_KEY_VERSION,
  changelog_fragments: CHANGELOG_FRAGMENTS_KEY_VERSION,
  base_red: BASE_RED_KEY_VERSION, review_exclude_paths: REVIEW_EXCLUDE_KEY_VERSION, review: REVIEW_POLICY_KEY_VERSION, release_gate: RELEASE_GATE_KEY_VERSION,
  stamp_placeholders: STAMP_PLACEHOLDERS_KEY_VERSION, merge: MERGE_KEY_VERSION, land: LAND_KEY_VERSION, readers: READERS_KEY_VERSION,
  bookkeeping: BOOKKEEPING_KEY_VERSION, mechanical_retake: MECHANICAL_RETAKE_KEY_VERSION, test_code: TEST_CODE_KEY_VERSION, ci_record_timeout_s: CI_RECORD_TIMEOUT_KEY_VERSION,
  plan_record: PLAN_RECORD_KEY_VERSION,
};
