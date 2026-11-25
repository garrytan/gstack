/**
 * own-lines: whether two heads on one line of history carry the pull request's own added and removed lines byte-identical, at
 * the same places, against the base (GST-2968). lib/pregate/run-check.ts uses it to accept a tested merge whose own lines are
 * the head's; it moved here from the round-grant module GST-3562 part 4 removed.
 */
import { spawnSync } from './spawn-sync';

interface Hunk { path: string; start: number; len: number; added: number }

/** A zero-context diff's hunks: the file (its old side, or its new side when created), the old-side start and length, and the added length. */
function hunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let minus = '', path = '';
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) minus = l.slice(4);
    else if (l.startsWith('+++ ')) path = minus === '/dev/null' ? l.slice(4) : minus;
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (m) out.push({ path, start: +m[1]!, len: m[2] === undefined ? 1 : +m[2], added: m[3] === undefined ? 1 : +m[3] });
  }
  return out;
}

/**
 * The old-side line own hunk h starts at once the base's hunks have moved its file, or null when the base edited a line h changes or
 * inserted inside or right next to h, so its place can't be carried over. Spans are in half-line steps: 2n is line n, 2n+1 the gap after it.
 */
function carried(base: readonly Hunk[], h: Hunk): number | null {
  const span = (x: Hunk, pad: number): [number, number] => x.len ? [2 * x.start - pad, 2 * (x.start + x.len - 1) + pad] : [2 * x.start + 1 - pad, 2 * x.start + 1 + pad];
  const [lo, hi] = span(h, 1);
  let shift = 0;
  for (const b of base.filter(x => x.path === h.path)) {
    const [blo, bhi] = span(b, 0);
    if (blo <= hi && lo <= bhi) return null;
    if (bhi < lo) shift += b.added - b.len;
  }
  return h.start + shift;
}

/**
 * Whether a and b are on one line of history and carry byte-identical own lines against baseRef at the same places: equal
 * zero-context patch-ids, and each own hunk of a, carried through the base's changes between the two forks, starts where b's does.
 * Moving a line to another place in the same file changes no patch-id, so the places are compared too.
 */
export function ownLinesSame(repoRoot: string, baseRef: string, a: string, b: string): boolean {
  const git = (args: string[], input?: string) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repoRoot, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (git(['merge-base', '--is-ancestor', a, b]).status !== 0 && git(['merge-base', '--is-ancestor', b, a]).status !== 0) return false;
  const fork = (c: string) => { const f = git(['merge-base', baseRef, c]); return f.status === 0 ? f.stdout.trim() : null; };
  const diff = (x: string, y: string) => { const d = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', '-U0', x, y]); return d.status === 0 ? d.stdout : null; };
  const id = (d: string) => { const p = git(['patch-id', '--verbatim'], d); return p.status === 0 ? p.stdout.trim().split(/\s+/)[0] || null : null; };
  const fa = fork(a), fb = fork(b);
  if (!fa || !fb) return false;
  const da = diff(fa, a), db = diff(fb, b), moved = fa === fb ? '' : diff(fa, fb);
  if (!da?.trim() || !db?.trim() || moved === null) return false;
  const x = id(da);
  if (x === null || x !== id(db)) return false;
  const base = hunks(moved), there = hunks(db), here = hunks(da);
  return here.length === there.length && here.every((h, i) => h.path === there[i]!.path && h.len === there[i]!.len && carried(base, h) === there[i]!.start);
}
