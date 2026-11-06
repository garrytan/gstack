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
 * binary, and that change is not plain docs. With the owner's review_loop_grant for a stop head inside range_base..HEAD
 * (`granted`, checked by the plan before it gets here), a code change since the read takes the same one reader (GST-1607, harness-evals #271: the
 * granted fix round moved the product patch the record names). Anything else keeps `done` with the reason.
 */
import { spawnSync } from 'node:child_process';
import { comparePath, touchedPaths } from './ship-patch';
import { docsChangeSince } from './ship-receipt-depth';

export type TargetedDelta = { state: 'dispatch'; range_base: string; paths: string[] } | { state: 'skip'; reason: string };

/** Whether the change since `rangeBase` (where the targeted reader read the patch `ran`) earns the targeted-only read. */
export function targetedDelta(root: string, base: string, rangeBase: string, ran: string, granted = false): TargetedDelta {
  const git = (args: string[], input?: string) => {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const skip = (reason: string): TargetedDelta => ({ state: 'skip', reason });
  const read = git(['rev-parse', '--verify', '--quiet', `${rangeBase}^{commit}`])?.trim();
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim();
  if (!read || !head || git(['merge-base', '--is-ancestor', read, head]) === null) return skip(`range_base ${rangeBase} is not a commit on this branch`);
  if (git(['diff', '--quiet', 'HEAD', '--']) === null || git(['ls-files', '--others', '--exclude-standard'])?.trim()) return skip('uncommitted or untracked edits: commit them first');
  const readBase = git(['merge-base', base, read])?.trim();
  const headBase = git(['merge-base', base, head])?.trim();
  if (!readBase || !headBase) return skip(`no merge base with ${base}`);
  const diff = git(['diff', '--no-color', '--no-ext-diff', readBase, read]);
  const readPatch = diff?.trim() ? git(['patch-id', '--verbatim'], diff)?.trim().split(/\s+/)[0] : undefined;
  if (!readPatch || readPatch !== ran) return skip(`--targeted-ran ${ran} is not the targeted patch at range_base ${read.slice(0, 12)} (${readPatch ?? 'unreadable'}), so it does not say what the reader read`);
  const before = touchedPaths(root, readBase, read);
  const now = touchedPaths(root, headBase, head);
  if (!before || !now) return skip('git could not list the branch patch at range_base or at HEAD');
  const sides = { reviewedBase: readBase, reviewed: read, currentBase: headBase, current: head };
  const paths = [...new Set([...before, ...now])].filter(p => !['same', 'context'].includes(comparePath(root, sides, p))).sort();
  if (!paths.length) return skip(`the branch patch is unchanged since range_base ${read.slice(0, 12)}`);
  const change = docsChangeSince(root, read, head, base);
  if (!change) return skip(`git could not build the PR's own change since range_base ${read.slice(0, 12)}`);
  if (change.verdict === 'code' && !granted) return skip(`the change since range_base ${read.slice(0, 12)} is not docs-only (${change.paths.join(', ')}), so it takes the review loop`);
  if (change.verdict === 'plain') return skip(`the change since range_base ${read.slice(0, 12)} is ${change.paths.length ? 'plain docs' : 'release stamps'}${change.paths.length && change.stamps.length ? ' and release stamps' : ''}, which the targeted record carries (GST-1195, GST-1689)`);
  return { state: 'dispatch', range_base: read, paths: [...change.paths] };
}
