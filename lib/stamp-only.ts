/**
 * Stamp-only checks: whether a removed/added line pair is a restamp alone, and
 * the branch side (its own lines and fork version) that bounds that check for
 * lines the branch wrote itself. Split from restamp.ts (module-size ratchet).
 */
import { spawnSync } from 'node:child_process';
import { branchAddedLines, forkVersion, rewriteStamps, stampMentions } from './restamp';
import { cmpVersion, parseVersion, versionWidth } from './version-source';

/**
 * A removed/added line pair that a restamp alone explains: every version the
 * removed line mentions in a stamp form and the added line no longer does
 * moves to `newV`, and the rewritten line is the added line byte for byte.
 * The moved versions are the ones the stamp_paths stage moves, not only the
 * old version `oldV` (the gated head's): a tentative `*_KEY_VERSION = '<next
 * minor>'` never equals the base version at the slot and is a stamp all the
 * same (#3512). The stage's own bound applies: a tentative mention is newer
 * than the version the branch was written against, so a moved version older
 * than `oldV` (a released key moved by hand) is not a stamp, and neither is
 * one of another width (`tentativeMentions`: a 3-digit dependency pin in a
 * 4-digit repo is never a candidate, so moving it is a hand edit). A line that
 * moves nothing, or changes anything beyond those mentions, is not one either.
 * With `side`, a removed line the branch added itself, named by its 1-based
 * position `at` in the side's file (GST-979: a base line with the same text
 * is not the branch's), is bounded by its fork point's version instead, the
 * stage's bound for its own lines (GST-895, GST-963): finish's stampedFiles,
 * the tree receipt and the receipt carry all pass the same side. When the
 * version does not move (a slot that keeps its claimed VERSION), only such a
 * branch line may change: the stage moves nothing else then.
 */
export function stampOnlyLine(removed: string, added: string, oldV: string, newV: string, templates: readonly string[] = [], side?: BranchSide, at?: number): boolean {
  if (removed === added) return false;
  if (oldV !== newV && stampOnlyWithin(removed, added, oldV, newV, templates)) return true;
  return !!side && at !== undefined && side.at.has(at) && side.added.has(removed) && stampOnlyWithin(removed, added, side.fork, newV, templates);
}

/**
 * Lines the branch added to one file (since its merge base with the base, less the lines the base added since): their
 * text and their 1-based positions in the side's file, and its fork point's version.
 */
export interface BranchSide { fork: string; added: ReadonlySet<string>; at: ReadonlySet<number> }

/**
 * Each file's BranchSide for `head` against `baseRef`, read lazily and cached: the lines come from merge-base..`to`
 * (`head` unless a reviewed tree stands in for it), the fork version from `head`'s first-parent history
 * (`fallback` when it has no own commit). A file git cannot diff has no side, so its lines keep the `oldV` bound.
 */
export function branchSides(repoRoot: string, baseRef: string, head: string, fallback: string, to = head): (rel: string) => BranchSide | undefined {
  const sides = new Map<string, BranchSide | undefined>();
  let since: string | undefined;
  let fork: string | undefined;
  return rel => {
    if (sides.has(rel)) return sides.get(rel);
    since ??= (spawnSync('git', ['merge-base', baseRef, head], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 }).stdout ?? '').trim();
    let side: BranchSide | undefined;
    if (since) {
      try {
        const own = branchAddedLines(repoRoot, since, [rel], to, branchAddedLines(repoRoot, since, [rel], baseRef)).get(rel);
        if (own?.text.size) side = { fork: (fork ??= forkVersion(repoRoot, baseRef, fallback, head)), added: own.text, at: own.at };
      } catch {}
    }
    sides.set(rel, side);
    return side;
  };
}

function stampOnlyWithin(removed: string, added: string, oldV: string, newV: string, templates: readonly string[]): boolean {
  const floor = parseVersion(oldV);
  const width = versionWidth(oldV);
  const after = stampMentions(added, templates);
  const moved = [...stampMentions(removed, templates)].filter(v => v !== newV && !after.has(v));
  if (!moved.length || !floor) return false;
  if (moved.some(v => { const p = parseVersion(v); return !p || versionWidth(v) !== width || cmpVersion(p, floor) < 0; })) return false;
  let text = removed;
  for (const v of moved) text = rewriteStamps(text, v, newV, templates).text;
  return text === added;
}
