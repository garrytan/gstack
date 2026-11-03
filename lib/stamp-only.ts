/**
 * Stamp-only checks: whether a removed/added line pair is a restamp alone, and
 * the branch side (its own lines and fork version) that bounds that check for
 * lines the branch wrote itself. Split from restamp.ts (module-size ratchet).
 */
import { spawnSync } from 'node:child_process';
import { branchAddedLines, escapeRegExp, forkVersion, recordedVersions, rewriteStamps, stampMentions } from './restamp';
import { VERSION_SLOT } from './ship-policy';
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
 * branch line may change: the stage moves nothing else then. On such a branch
 * line a declared placeholder (`stamp_placeholders`, GST-1026: gbrain's
 * `since: 'TBD'`) may also become the new version, but only inside a
 * `stamp_patterns` template with literal text around its slot, never a built-in
 * form: with at least one such rewrite, the line must then be the added line,
 * or one whose remaining stamp-form moves pass the fork-version bound.
 * Within either bound a built-in form (`vX`, `since: X`, `(was X)`) moves a
 * version above `newV` only when the writer would: `oldV` on any line, one the
 * branch recorded (`side.recorded`) on its own lines. Any other version moves
 * only inside a `stamp_patterns` slot (#3512), so a third party's `QM v0.1.15`
 * rewritten on a line the branch added, even beside such a slot, is product (GST-1245).
 */
export function stampOnlyLine(removed: string, added: string, oldV: string, newV: string, templates: readonly string[] = [], side?: BranchSide, at?: number, placeholders: readonly string[] = []): boolean {
  if (removed === added) return false;
  if (oldV !== newV && stampOnlyWithin(removed, added, oldV, newV, templates, new Set([oldV]))) return true;
  if (!side || at === undefined || !side.at.has(at) || !side.added.has(removed)) return false;
  const recorded = side.recorded ?? new Set([side.fork]);
  if (stampOnlyWithin(removed, added, side.fork, newV, templates, recorded)) return true;
  const filled = fillPlaceholders(removed, newV, templates, placeholders);
  return filled.count > 0 && (filled.text === added || stampOnlyWithin(filled.text, added, side.fork, newV, templates, recorded));
}

/**
 * Lines the branch added to one file (since its merge base with the base, less the lines the base added since): their
 * text and their 1-based positions in the side's file, its fork point's version, and the versions it recorded
 * (recordedVersions; the fork version alone when absent).
 */
export interface BranchSide { fork: string; added: ReadonlySet<string>; at: ReadonlySet<number>; recorded?: ReadonlySet<string> }

/**
 * Each file's BranchSide for `head` against `baseRef`, read lazily and cached: the lines come from merge-base..`to`
 * (`head` unless a reviewed tree stands in for it), the fork version from `head`'s first-parent history
 * (`fallback` when it has no own commit). A file git cannot diff has no side, so its lines keep the `oldV` bound.
 */
export function branchSides(repoRoot: string, baseRef: string, head: string, fallback: string, to = head): (rel: string) => BranchSide | undefined {
  const sides = new Map<string, BranchSide | undefined>();
  let since: string | undefined;
  let fork: string | undefined;
  let recorded: Set<string> | undefined;
  return rel => {
    if (sides.has(rel)) return sides.get(rel);
    since ??= (spawnSync('git', ['merge-base', baseRef, head], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 }).stdout ?? '').trim();
    let side: BranchSide | undefined;
    if (since) {
      try {
        const own = branchAddedLines(repoRoot, since, [rel], to, branchAddedLines(repoRoot, since, [rel], baseRef)).get(rel);
        if (own?.text.size) side = { fork: (fork ??= forkVersion(repoRoot, baseRef, fallback, head)), added: own.text, at: own.at, recorded: (recorded ??= recordedVersions(repoRoot, baseRef, fallback, head)) };
      } catch {}
    }
    sides.set(rel, side);
    return side;
  };
}

/** Each declared placeholder rewritten to `newV` inside each template with literal text around its slot (a bare edge at a word boundary). */
function fillPlaceholders(removed: string, newV: string, templates: readonly string[], placeholders: readonly string[]): { text: string; count: number } {
  let text = removed;
  let count = 0;
  for (const t of templates) {
    const [pre, post] = t.split(VERSION_SLOT) as [string, string];
    if (!pre && !post) continue;
    for (const p of placeholders) {
      const re = new RegExp(`${escapeRegExp(pre)}${pre ? '' : '(?<![A-Za-z0-9_.])'}${escapeRegExp(p)}${post ? '' : '(?![A-Za-z0-9_.])'}${escapeRegExp(post)}`, 'g');
      text = text.replace(re, () => { count++; return pre + newV + post; });
    }
  }
  return { text, count };
}

function stampOnlyWithin(removed: string, added: string, oldV: string, newV: string, templates: readonly string[], recorded: ReadonlySet<string>): boolean {
  const floor = parseVersion(oldV);
  const width = versionWidth(oldV);
  const ceiling = parseVersion(newV);
  const free = (v: string) => { const p = parseVersion(v); return recorded.has(v) || (!!p && !!ceiling && cmpVersion(p, ceiling) <= 0); };
  const after = stampMentions(added, templates);
  const afterSlots = stampMentions(added, templates, false);
  const slotted = stampMentions(removed, templates, false);
  const moved = [...stampMentions(removed, templates)].filter(v => v !== newV && (free(v) ? !after.has(v) : slotted.has(v) && !afterSlots.has(v)));
  if (!moved.length || !floor) return false;
  if (moved.some(v => { const p = parseVersion(v); return !p || versionWidth(v) !== width || cmpVersion(p, floor) < 0; })) return false;
  let text = removed;
  for (const v of moved) text = rewriteStamps(text, v, newV, templates, free(v)).text;
  return text === added;
}
