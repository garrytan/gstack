/**
 * review-targeted-delta — the targeted-only read after a finished review loop (GST-1598,
 * docs/review-policy.md#targeted-only-read-after-the-loop). A targeted record names the commit its reader read, and
 * gstack-ship-receipt write carries it across a later change only when that change is release stamps and plain docs
 * (plainDocsSince, GST-1195); this module classifies the change with the same docsChangeSince, so the two agree
 * (GST-1689). A docs claim added after the loop finished (a changelog fragment with dollar figures, harness-evals #225)
 * left no exit: the plan printed `done`, so nothing dispatched the reader the receipt asks for. bin/gstack-review-plan
 * asks this module when the loop is done and the head has targeted classes the passed --targeted-ran no longer covers.
 * It dispatches one targeted reader on HEAD only when range_base is the commit that read happened on (its targeted
 * patch-id is --targeted-ran), every path the PR's own change moved since, release stamps aside, is docs class and not
 * binary, and that change is not plain docs. Anything else keeps `done` with the reason.
 */
import { spawnSync } from './spawn-sync';
import { comparePath, touchedPaths } from './ship-patch';
import { docsChangeSince, targetedClassesSince } from './ship-receipt-depth';

export type TargetedDelta = { state: 'dispatch'; range_base: string; paths: string[] } | { state: 'skip'; reason: string; carried?: true };

/** Whether the change since `rangeBase` (where the targeted reader read the patch `ran`) earns the targeted-only read. */
const gitIn = (root: string) => (args: string[], input?: string) => {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
/** The targeted patch-id at `read` (its committed diff against its merge base with `base`), as the TARGETED line prints it. */
function patchAt(git: ReturnType<typeof gitIn>, base: string, read: string): string | undefined {
  const readBase = git(['merge-base', base, read])?.trim();
  const diff = readBase ? git(['diff', '--no-color', '--no-ext-diff', readBase, read]) : null;
  return diff?.trim() ? git(['patch-id', '--verbatim'], diff)?.trim().split(/\s+/)[0] : undefined;
}

/**
 * Whether the targeted record a reader made at `rangeBase` (patch `ran`) carries to HEAD across a fix range every path of which
 * the owner ruled (gstack-review-plan's RULED_EDIT): only when nothing the PR changed since carries a targeted class, the rule
 * gstack-ship-receipt write's ruled carry applies (parseReviewTargeted, HARN-1 #638). Otherwise the plan dispatches the reader.
 */
export function ruledCarries(root: string, base: string, rangeBase: string, ran: string, excluded?: ReadonlySet<string>): boolean {
  const git = gitIn(root);
  const read = git(['rev-parse', '--verify', '--quiet', `${rangeBase}^{commit}`])?.trim();
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim();
  if (!read || !head || patchAt(git, base, read) !== ran) return false;
  return targetedClassesSince(root, read, head, base, excluded)?.length === 0;
}

export function targetedDelta(root: string, base: string, rangeBase: string, ran: string): TargetedDelta {
  const git = gitIn(root);
  const skip = (reason: string, carried?: true): TargetedDelta => ({ state: 'skip', reason, ...(carried ? { carried } : {}) });
  const read = git(['rev-parse', '--verify', '--quiet', `${rangeBase}^{commit}`])?.trim();
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim();
  if (!read || !head || git(['merge-base', '--is-ancestor', read, head]) === null) return skip(`range_base ${rangeBase} is not a commit on this branch`);
  if (git(['diff', '--quiet', 'HEAD', '--']) === null || git(['ls-files', '--others', '--exclude-standard'])?.trim()) return skip('uncommitted or untracked edits: commit them first');
  const readBase = git(['merge-base', base, read])?.trim();
  const headBase = git(['merge-base', base, head])?.trim();
  if (!readBase || !headBase) return skip(`no merge base with ${base}`);
  const readPatch = patchAt(git, base, read);
  if (!readPatch || readPatch !== ran) return skip(`--targeted-ran ${ran} is not the targeted patch at range_base ${read.slice(0, 12)} (${readPatch ?? 'unreadable'}), so it does not say what the reader read`);
  const before = touchedPaths(root, readBase, read);
  const now = touchedPaths(root, headBase, head);
  if (!before || !now) return skip('git could not list the branch patch at range_base or at HEAD');
  const sides = { reviewedBase: readBase, reviewed: read, currentBase: headBase, current: head };
  const paths = [...new Set([...before, ...now])].filter(p => !['same', 'context', 'spliced'].includes(comparePath(root, sides, p))).sort();
  if (!paths.length) return skip(`the branch patch is unchanged since range_base ${read.slice(0, 12)}`);
  const change = docsChangeSince(root, read, head, base);
  if (!change) return skip(`git could not build the PR's own change since range_base ${read.slice(0, 12)}`);
  if (change.verdict === 'code') return skip(`the change since range_base ${read.slice(0, 12)} is not docs-only (${change.paths.join(', ')}), so it takes the review loop`);
  if (change.verdict === 'plain') return skip(`the change since range_base ${read.slice(0, 12)} is ${change.paths.length ? 'plain docs' : 'release stamps'}${change.paths.length && change.stamps.length ? ' and release stamps' : ''}, which the targeted record carries (GST-1195, GST-1689)`, true);
  return { state: 'dispatch', range_base: read, paths: [...change.paths] };
}
