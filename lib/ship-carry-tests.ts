/**
 * ship-carry-tests: the test edits a receipt carry cannot pass silently (GST-2204, GSTA-461 item 6).
 *
 * The carry leaves test code out of the product patch-id because CI reruns it at the new head, but CI cannot tell a
 * loosened assertion from a fixed one: `expect(a).toBe(1)` rewritten as `expect(typeof a).toBe('number')` passes. So a
 * carry whose test paths lose or change an assertion line since the reviewed head names those hunks
 * (RECEIPT_CARRY_TEST_WEAKENED) and carries only after one scoped fix-check reads them, bound to the packet it read.
 * Added lines never count, so a new test or assertion still carries; a skip marker or a deleted test file raises the
 * review depth, whose refusal runs first. A line the base removed or changed on its own is the base's, reviewed there.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PACKET_SECTION_CAP, type PatchSides } from './ship-patch';

/** An assertion, a matcher or a test block's opening, in the JS/TS, Python, Go, Ruby, Rust, Java, Kotlin, Swift and PHP forms. */
export const ASSERTION_LINE = /\b(expect|assert\w*|refute\w*|should\w*|XCTAssert\w*|XCTFail)\b|\brequire\.\w+|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\.(to[A-Z]\w*|to|not|rejects|resolves)\b|\b(test|it|describe|context|specify|bench)(\.\w+)*\s*\(|\bdef test\w*|\bfunc Test\w*|@Test\b/;

export interface RemovedAssertion { line: number; text: string }
export interface WeakenedHunk extends RemovedAssertion { path: string }

/** The removed lines of a unified diff that read as an assertion, each at its hunk's new-side start line. */
export function removedAssertions(diff: string): RemovedAssertion[] {
  const out: RemovedAssertion[] = [];
  let at = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { at = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || !line.startsWith('-')) continue;
    const text = line.slice(1).trim();
    if (ASSERTION_LINE.test(text)) out.push({ line: at, text });
  }
  return out;
}

function pathDiff(repoRoot: string, from: string, to: string, rel: string, context: number): string | null {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', `-U${context}`, from, to, '--', rel], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** `removed` less one line of the same text per entry in `known`. */
function without(removed: RemovedAssertion[], known: RemovedAssertion[]): RemovedAssertion[] {
  const left = known.map(k => k.text);
  return removed.filter(r => { const i = left.indexOf(r.text); if (i < 0) return true; left.splice(i, 1); return false; });
}

/**
 * The assertion lines the branch removed or changed in `paths` since the reviewed head: lines removed reviewed -> current
 * that the base did not remove itself (reviewedBase -> currentBase), plus lines the branch's current patch removes that its
 * reviewed patch did not (an assertion a base merge brought in and the branch then dropped). A path git cannot diff counts
 * at line 0, so an unreadable diff never passes.
 */
export function weakenedTestHunks(repoRoot: string, s: PatchSides, paths: readonly string[]): WeakenedHunk[] {
  const out: WeakenedHunk[] = [];
  for (const rel of [...paths].sort()) {
    const [since, base, reviewed, current] = [[s.reviewed, s.current], [s.reviewedBase, s.currentBase], [s.reviewedBase, s.reviewed], [s.currentBase, s.current]].map(([a, b]) => pathDiff(repoRoot, a!, b!, rel, 0));
    if (since === null || base === null || reviewed === null || current === null) { out.push({ path: rel, line: 0, text: '(git could not diff this path)' }); continue; }
    const own = without(removedAssertions(since), removedAssertions(base));
    const dropped = without(removedAssertions(current), removedAssertions(reviewed)).filter(d => !own.some(o => o.text === d.text));
    out.push(...[...own, ...dropped].map(r => ({ path: rel, ...r })));
  }
  return out;
}

export const hunkName = (h: WeakenedHunk) => (h.line ? `${h.path}:${h.line}` : h.path);

/**
 * The packet the one fix-check reader reads: per path, its diff since the reviewed head (merged base lines included) and,
 * when the base moved it, the base's own change. `over` names each path whose since-review section passes
 * PACKET_SECTION_CAP lines: one reader cannot be shown it, so the carry sends it to /ship.
 */
export function testReviewPacket(repoRoot: string, s: PatchSides, hunks: readonly WeakenedHunk[]): { text: string; sha256: string; over: string[] } {
  const over: string[] = [];
  const fence = (label: string, body: string) => `${label}\n\`\`\`diff\n${body.trimEnd()}\n\`\`\`\n`;
  const parts = [`# Scoped review: test assertions changed since review\n\nReviewed ${s.reviewed.slice(0, 12)}; current ${s.current.slice(0, 12)}. The receipt's review read the product code; since then these test hunks removed or changed assertion lines: ${hunks.map(hunkName).join(', ')}. Read whether each test still checks what it checked at the reviewed head. A loosened matcher, a removed assertion or test block, or an expected value moved to match new behavior without a reason in the diff is a finding. Report clean, or findings at the blocking floor.\n`];
  for (const rel of [...new Set(hunks.map(h => h.path))]) {
    const since = pathDiff(repoRoot, s.reviewed, s.current, rel, 3) ?? '(git could not diff this path)';
    if (since.split('\n').length > PACKET_SECTION_CAP) over.push(rel);
    const base = pathDiff(repoRoot, s.reviewedBase, s.currentBase, rel, 3);
    parts.push(`## ${rel}\n`, fence('Changed since review', since), ...(base?.trim() ? [fence("The base's own change (reviewed on the base)", base)] : []));
  }
  const text = parts.join('\n');
  return { text, sha256: createHash('sha256').update(text).digest('hex'), over };
}
