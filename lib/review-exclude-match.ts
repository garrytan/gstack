/**
 * review-exclude-match — which changed paths each review_exclude_paths pattern matches, and which fixed strings a file
 * holds, at a cost that does not grow with the number of patterns or strings (GST-4003; harness-evals#616, 16,165 files).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';

const MAX_BUFFER = 256 * 1024 * 1024;
function git(root: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): { ok: boolean; status: number | null; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, env, encoding: 'utf8', timeout: 120_000, maxBuffer: MAX_BUFFER });
  return { ok: r.status === 0, status: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

export interface SelectInput { root: string; mergeBase: string; head?: string }
export interface Matched { oldMode: string; newMode: string; oldSha: string; newSha: string }

/** Every changed path each pattern matches, with its modes, from git's raw diff; untracked files are never part of it, since no reader's git diff shows them and the receipt reads the committed head. */
export function select(i: SelectInput, patterns: readonly string[]): { byPattern: Map<string, string[]>; files: Map<string, Matched> } | { error: string } {
  const byPattern = new Map<string, string[]>();
  const files = new Map<string, Matched>();
  if (!patterns.length) return { byPattern, files };
  const range = i.head ? [i.mergeBase, i.head] : [i.mergeBase];
  const specs = patterns.map(p => `:(top,glob)${p}`);
  const raw = git(i.root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', ...range, '--', ...specs]);
  if (!raw.ok) return { error: `git diff --raw ${range.join(' ')} -- ${specs.join(' ')}: ${raw.err.split('\n')[0] || `exit ${raw.status}`}` };
  const parts = raw.out.split('\0');
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const [oldMode, newMode, oldSha, newSha] = parts[k]!.slice(1).split(' ');
    const f = parts[k + 1]!;
    if (f && !files.has(f)) files.set(f, { oldMode: oldMode ?? '', newMode: newMode ?? '', oldSha: oldSha ?? '', newSha: newSha ?? '' });
  }
  if (patterns.length === 1) return { byPattern: new Map([[patterns[0]!, [...files.keys()]]]), files };
  // GST-4003: one diff for every pattern, then each pattern's share from git's own pathspec match over scratch indexes of just
  // those paths (a diff per pattern took 0.2 s each over harness-evals#616's 16,165 files, and the cap is now 256 patterns).
  // A deleted path and a new one can be a file and a directory of the same name (data/x/a.json gone, data/x added), which one
  // index cannot hold, so the head side and the deleted side get an index each; one that does not list every path it was
  // given sends every pattern back to its own diff. A pattern with a bracket class or a backslash gets its own diff too: git's
  // tree walk also matches a directory whose name spells the pattern out (res/[0-9]*/), and ls-files' wildmatch does not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-select-'));
  try {
    const sides = [[...files].filter(([, m]) => m.newMode !== '000000'), [...files].filter(([, m]) => m.newMode === '000000')].filter(s => s.length);
    const hits = patterns.map(() => new Set<string>());
    for (const [n, side] of sides.entries()) {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, `index-${n}`) };
      const entries = side.map(([f, m]) => `${m.newMode !== '000000' ? m.newMode : m.oldMode} e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\t${f}`);
      const listed = git(i.root, ['update-index', '-z', '--index-info'], entries.join('\0') + '\0', env).ok ? git(i.root, ['ls-files', '-z', '--full-name'], undefined, env) : null;
      if (!listed?.ok || listed.out.split('\0').filter(Boolean).length !== side.length) return perPattern(i, patterns, range, files);
      for (const [k, spec] of specs.entries()) {
        const ls = git(i.root, ['ls-files', '-z', '--full-name', '--', spec], undefined, env);
        if (!ls.ok) return { error: `git ls-files -- ${spec}: ${ls.err.split('\n')[0] || `exit ${ls.status}`}` };
        for (const f of ls.out.split('\0')) if (f) hits[k]!.add(f);
      }
    }
    for (const [k, p] of patterns.entries()) byPattern.set(p, [...files.keys()].filter(f => hits[k]!.has(f)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const literal = patterns.filter(p => /[[\\]/.test(p));
  const own = literal.length ? perPattern(i, literal, range, files) : null;
  if (own && 'error' in own) return own;
  for (const [p, matched] of own?.byPattern ?? []) byPattern.set(p, matched);
  return { byPattern, files };
}

/** Each pattern's paths from its own `git diff --raw`, as select read them before GST-4003: the fallback when a scratch index cannot hold the paths. */
function perPattern(i: SelectInput, patterns: readonly string[], range: readonly string[], files: Map<string, Matched>): ReturnType<typeof select> {
  const byPattern = new Map<string, string[]>();
  for (const p of patterns) {
    const spec = `:(top,glob)${p}`;
    const raw = git(i.root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', ...range, '--', spec]);
    if (!raw.ok) return { error: `git diff --raw ${range.join(' ')} -- ${spec}: ${raw.err.split('\n')[0] || `exit ${raw.status}`}` };
    byPattern.set(p, raw.out.split('\0').filter((f, k) => k % 2 === 1 && f));
  }
  return { byPattern, files };
}

/**
 * A fixed-string search that hands git only each string's last-segment suffix (its extension, or the whole last segment
 * when it has none), so `git grep -f` reads a handful of patterns instead of thousands: git tries every pattern on every
 * line, and 16,165 paths over harness-evals' code took 37 s where their 9 extensions took 0.4 s. Every string ends with its
 * token, so a file holding a string holds its token (git's list is a superset), and `holds` then finds exactly the strings
 * a body contains by checking, at the end of each token occurrence, the strings of each length that end there.
 */
export function fixedIndex(strings: readonly string[]): { tokens: string[]; holds: (body: string) => Set<string> } {
  const groups = new Map<string, Map<number, Set<string>>>();
  for (const s of strings) {
    const base = s.slice(s.lastIndexOf('/', s.length - 2) + 1);
    const dot = base.lastIndexOf('.');
    const token = dot > 0 ? base.slice(dot) : base;
    const byLength = groups.get(token) ?? groups.set(token, new Map()).get(token)!;
    (byLength.get(s.length) ?? byLength.set(s.length, new Set()).get(s.length)!).add(s);
  }
  const holds = (body: string) => {
    const out = new Set<string>();
    for (const [token, byLength] of groups) {
      if (!token) { out.add(''); continue; }
      for (let at = body.indexOf(token); at >= 0; at = body.indexOf(token, at + 1)) {
        const end = at + token.length;
        for (const [n, set] of byLength) if (end >= n && set.has(body.slice(end - n, end))) out.add(body.slice(end - n, end));
      }
    }
    return out;
  };
  return { tokens: [...groups.keys()], holds };
}
