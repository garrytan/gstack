/**
 * pregate remote receipt — a remote_gate receipt from a predecessor tree.
 *
 * The `pregate.json/remote_gate` obligation clears on the gate's own
 * `PREGATE_REMOTE: tree=… tests=… failed=…` line, and that tree had to be the
 * tree pregate.json recorded. A repo whose full gate ran ahead of the ship
 * ("gate ahead of your turn": the gate tested commit G, then /ship's restamp
 * moved the version files) could never clear the obligation with that run:
 * the stamp changed the tree, so every PR paid a second full gate on the
 * stamped head (gbrain #7621, #7674, #7681: 17–37 minutes, 64–128 vCPU each).
 *
 * `substituteStampOnlyTree` is the one accepted substitution. The gated tree
 * and the head tree are diffed path by path, and every differing file is
 * classified by the tree receipt's own rule (lib/tree-receipt.ts
 * `classifyFiles`, the changelog_fragments fold included: the repo's `stamp_files` allowlist and `stamp_patterns`
 * templates from `.gstack/ship-policy.json` on the base branch, beside the
 * built-in version-file, manifest-version, lockfile-root-version and
 * changelog-heading forms). The receipt is accepted for the head only when
 * every differing file is a stamp; a path outside the rule, or a stamp path
 * whose hunk is not the exact old → new rewrite, refuses it with the path
 * named. There is no second stamp list here: a verdict this module reaches is
 * the verdict `gstack-tree-receipt` reaches on the same pair, including its
 * gate rule: a repo whose `stamp_sensitive_gates` names the test lane (`tests`,
 * as gstack's own policy does, because its tests read VERSION and the digest)
 * is refused, since the tree receipt never marks such a lane reusable.
 *
 * Both trees must be objects in this repository (the gated tree is the
 * gated commit's tree once that commit is fetched; the head tree is the
 * working-tree fingerprint `bin/gstack-wtree` wrote). A tree that is not
 * here cannot be diffed and is refused, never trusted.
 */
import { spawnSync } from 'node:child_process';
import type { PregateReceiptSubstitution } from '../headless-artifacts';
import { parseUnifiedDiff, versionAtRef } from '../restamp';
import { isUnavailable, loadPolicyFromBase, SHIP_POLICY_PATH } from '../ship-policy';
import { classifyFiles } from '../tree-receipt';
import { treeMismatch } from './checks/lanes';

/** What `clear` records when a remote_gate receipt from a stamp-only predecessor tree is accepted for the head (the pregate.json shape, lib/headless-artifacts.ts). */
export type StampOnlySubstitution = PregateReceiptSubstitution;

export type SubstitutionResult = { substitution: StampOnlySubstitution } | { problem: string; fix: string };

/** A git object id as the remote gate and bin/gstack-wtree print it: nothing symbolic (`HEAD^{tree}`) or option-shaped reaches git. */
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/** The `stamp_sensitive_gates` labels that name the test tier the remote gate runs: gstack-evidence's `tests` lane, or the obligation itself. */
const STAMP_SENSITIVE_TEST_LANES = new Set(['tests', 'remote_gate']);

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '').replace(/\n$/, '') : null;
}

/** The branch a pregate.json `base` field (`origin/<branch>@<sha>`) names; null when the field is absent or unreadable. */
export function baseBranchOf(base: string | undefined): string | null {
  const m = /^(?:origin\/)?(.+?)@[0-9a-f]+$/.exec(base ?? '');
  return m ? m[1]! : null;
}

/**
 * The fix for a pregate.json recorded against `recorded` when the ship's base
 * is `base`. `resolveBaseBranch` falls back to `main` when origin/HEAD is unset,
 * so a repo whose base is another branch is told how to set it rather than
 * sent to rerun against a branch it may not have.
 */
export function baseMismatchFix(repoRoot: string, base: string, recorded: string): string {
  const fix = `rerun gstack-pregate --base ${base}, then clear again`;
  if (git(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']) !== null) return fix;
  return `${fix}; or, since origin/HEAD is unset here, git remote set-head origin ${recorded} so clear reads that base's policy`;
}

/**
 * Whether `gatedTree` differs from `headTree` only as a stamp does, under the
 * base branch's ship policy. Returns the substitution to record, or the
 * problem (opening with the same tree-mismatch clause `remoteReportProblem`
 * prints) with the fix.
 */
export function substituteStampOnlyTree(repoRoot: string, base: string, gatedTree: string, headTree: string): SubstitutionResult {
  const short = (t: string) => t.slice(0, 12);
  const mismatch = treeMismatch(gatedTree, headTree);
  const rerun = `rerun the remote gate on tree ${short(headTree)} and pass its output with --receipt, or run gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands`;
  for (const [label, tree] of [['gated', gatedTree], ['head', headTree]] as const) {
    if (!OBJECT_ID.test(tree)) return { problem: `${mismatch}; the ${label} tree ${JSON.stringify(tree.slice(0, 40))} is not a git object id, so it cannot be compared`, fix: rerun };
    if (git(repoRoot, ['cat-file', '-t', '--end-of-options', tree]) !== 'tree') {
      return { problem: `${mismatch}; the ${label} tree ${short(tree)} is not an object in this repository, so the two trees cannot be compared`, fix: label === 'gated' ? `fetch the commit the remote gate tested (git fetch origin <its sha>) so its tree is here, then clear again; or ${rerun}` : rerun };
    }
  }
  const loaded = loadPolicyFromBase(repoRoot, base);
  if (isUnavailable(loaded)) return { problem: `${mismatch}; the ship policy on origin/${loaded.base} could not be read (${loaded.detail}), so the stamp rule is unknown`, fix: `git fetch origin ${loaded.base}, then clear again; or ${rerun}` };
  if (loaded.source.kind === 'base' && !loaded.present) return { problem: `${mismatch}; ${SHIP_POLICY_PATH} exists on ${loaded.source.label} but could not be read, so the stamp rule is unknown`, fix: `git fetch origin ${base}, then clear again; or ${rerun}` };
  if (loaded.errors.length) return { problem: `${mismatch}; ${SHIP_POLICY_PATH} on ${loaded.source.label} is invalid (${loaded.errors.map(e => `${e.path}: ${e.message}`).join('; ')}), so the stamp rule is unknown`, fix: `fix the policy on the base branch (gstack-ship-policy validate), then clear again; or ${rerun}` };
  // The tree receipt never marks a stamp-sensitive lane reusable: a repo whose tests read VERSION or generated bytes says so here, and its test tier is what the remote gate ran.
  const sensitive = loaded.policy.stamp_sensitive_gates.filter(g => STAMP_SENSITIVE_TEST_LANES.has(g));
  if (sensitive.length) return { problem: `${mismatch}, and ${loaded.source.label} lists the test lane as stamp-sensitive (stamp_sensitive_gates: ${sensitive.join(', ')}), so a run on another tree never covers this one`, fix: rerun };
  const gv = versionAtRef(repoRoot, gatedTree);
  const cv = versionAtRef(repoRoot, headTree);
  const versionRel = 'rel' in cv ? cv.rel : 'rel' in gv ? gv.rel : 'VERSION';
  const oldV = 'version' in gv ? gv.version : null;
  const newV = 'version' in cv ? cv.version : null;
  // The patch is read with a fixed presentation (no textconv, no rename pairing, submodules included, a/ b/ prefixes) and
  // reconciled against the plumbing inventory of the pair, so a diff driver or diff.* setting can neither hide a path nor rename it.
  const diff = git(repoRoot, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', '--end-of-options', gatedTree, headTree]);
  if (diff === null) return { problem: `${mismatch}; git diff ${short(gatedTree)} ${short(headTree)} failed`, fix: rerun };
  const inventory = git(repoRoot, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--ignore-submodules=none', '--end-of-options', gatedTree, headTree]);
  if (inventory === null) return { problem: `${mismatch}; git diff-tree ${short(gatedTree)} ${short(headTree)} failed`, fix: rerun };
  const files = classifyFiles(repoRoot, parseUnifiedDiff(diff), gatedTree, headTree, loaded.policy, versionRel, oldV, newV);
  if (!files.length) return { problem: `${mismatch}; the trees differ but git diff produced no file entry to classify`, fix: rerun };
  const expected = new Set(inventory.split('\0').filter(Boolean));
  const seen = new Set(files.map(f => f.path));
  const unaccounted = [...expected].filter(p => !seen.has(p)).concat([...seen].filter(p => !expected.has(p)));
  if (unaccounted.length) return { problem: `${mismatch}; the patch between the trees does not account for every differing path (${unaccounted.join(', ')}), so the difference cannot be classified`, fix: rerun };
  const changed = files.filter(f => f.verdict === 'changed');
  if (changed.length) {
    const named = changed.map(c => `${c.path} (${c.rule}${c.residual ? `: ${c.residual}` : ''}${c.line ? `, line ${c.line}` : ''})`).join('; ');
    return { problem: `${mismatch}, and the trees differ beyond the stamp rule of ${loaded.source.label}: ${named}`, fix: `${rerun}; a receipt from a predecessor tree is accepted only when every differing path is a stamp (stamp_files, stamp_patterns and the built-in version, manifest, lockfile and changelog forms; see docs/pregate.md#remote-gate-stamp-only)` };
  }
  return { substitution: { gated_tree: gatedTree, accepted_for: headTree, policy: loaded.source.label, files: files.map(f => ({ path: f.path, rule: f.rule })) } };
}

/** One line naming the substitution, for `clear`'s output and `verify`'s ok line. */
export function describeSubstitution(s: StampOnlySubstitution): string {
  return `gated tree ${s.gated_tree.slice(0, 12)} accepted for tree ${s.accepted_for.slice(0, 12)} under ${s.policy}; stamp-only: ${s.files.map(f => `${f.path} (${f.rule})`).join(', ')}`;
}
