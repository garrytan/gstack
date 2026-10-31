/**
 * changelog-fragments — unversioned CHANGELOG fragments (docs/ship-policy.md#changelog-fragments).
 * Under the policy key `changelog_fragments: { dir }` a PR adds `<dir>/<slug>.md` instead of an
 * `[Unreleased]` section and leaves its release-version fields at its merge base's values; the
 * merge step folds every fragment into the CHANGELOG under the version it allocates and deletes the
 * fragment files. Fragments are read as Git blobs, never through the filesystem: only regular files
 * (mode 100644) directly under `dir` count, so a symlink, gitlink or nested path cannot pull bytes
 * from outside the repository into a stamp.
 */
import { spawnSync } from 'node:child_process';
import { headingVersion, parseChangelog } from './changelog-check';
import type { Bump } from './version-source';

export const FRAGMENT_README = 'README.md';
export const MAX_FRAGMENT_BYTES = 64 * 1024;
const BUMP_RANK: Record<Bump, number> = { micro: 0, patch: 1, minor: 2, major: 3 };

export interface Fragment { path: string; body: string; bump: Bump | null }
export interface FragmentError { code: 'CHANGELOG_FRAGMENT_INVALID'; path: string; message: string }
export interface FragmentSet { fragments: Fragment[]; errors: FragmentError[] }

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** The fragment file name /ship writes for a branch: one flat path segment. */
export function fragmentSlug(branch: string): string {
  const slug = branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  return slug || 'change';
}

/** One fragment's text: optional `---` front matter holding only `bump:`, then a non-empty body with no release heading. */
export function parseFragment(rel: string, text: string): Fragment | FragmentError {
  const bad = (message: string): FragmentError => ({ code: 'CHANGELOG_FRAGMENT_INVALID', path: rel, message });
  const normalized = text.replace(/\r\n/g, '\n');
  let body = normalized;
  let bump: Bump | null = null;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (fm) {
    body = normalized.slice(fm[0].length);
    for (const line of fm[1]!.split('\n').filter(l => l.trim())) {
      const kv = /^\s*bump\s*:\s*['"]?(micro|patch|minor|major)['"]?\s*$/.exec(line);
      if (!kv) return bad(`front matter may hold only "bump: micro|patch|minor|major", found ${JSON.stringify(line.trim().slice(0, 60))}`);
      bump = kv[1] as Bump;
    }
  }
  const lines = body.split('\n');
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) return bad('the fragment has no entry text');
  const heading = lines.find(l => /^##\s/.test(l) && headingVersion(l));
  if (heading) return bad(`a fragment carries no release heading (the merge step writes it), found ${JSON.stringify(heading.trim())}`);
  return { path: rel, body: lines.join('\n'), bump };
}

/**
 * The fragments in `dir` of a tree-ish (a commit or tree id), or of the index when `treeish` is
 * null. `exclude` names a tree-ish whose fragments are not this change's own (the base branch, or a
 * stacked pin's parent): a path present there with the same blob is skipped, a path present there
 * with other bytes is an error. With `changelog`, a fragment whose lines appear whole and in order in a released
 * section of that file at `exclude` is an error too: a landed PR's fragment carried back in by stacked history.
 * `onReleased: 'skip'` drops such a fragment instead: a merge-step stamp commit never folds it.
 */
export function readFragments(cwd: string, treeish: string | null, dir: string, exclude?: string | null, changelog?: string | null, onReleased: 'error' | 'skip' = 'error'): FragmentSet {
  const prefix = dir.replace(/\/+$/, '') + '/';
  const list = (t: string | null) => {
    const r = t === null ? git(cwd, ['ls-files', '-s', '-z', '--', prefix]) : git(cwd, ['ls-tree', '-r', '-z', '--full-tree', t, '--', prefix]);
    const out: Array<{ mode: string; sha: string; path: string }> = [];
    for (const rec of r.out.split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t');
      const meta = rec.slice(0, tab).split(/\s+/);
      out.push(t === null ? { mode: meta[0]!, sha: meta[1]!, path: rec.slice(tab + 1) } : { mode: meta[0]!, sha: meta[2]!, path: rec.slice(tab + 1) });
    }
    return out;
  };
  const excluded = new Map((exclude ? list(exclude) : []).map(e => [e.path, e.sha]));
  const shown = exclude && changelog ? git(cwd, ['show', `${exclude}:${changelog}`]) : null;
  const released = shown?.ok ? parseChangelog(shown.out.replace(/\r\n/g, '\n')).sections.filter(s => !s.unreleased).map(s => s.lines) : [];
  const isReleased = (body: string) => {
    const want = body.split('\n');
    return released.some(lines => lines.some((_, i) => want.every((w, k) => lines[i + k] === w)));
  };
  const fragments: Fragment[] = [];
  const errors: FragmentError[] = [];
  for (const e of list(treeish).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rest = e.path.slice(prefix.length);
    if (rest === FRAGMENT_README) continue;
    const err = (message: string) => errors.push({ code: 'CHANGELOG_FRAGMENT_INVALID', path: e.path, message });
    if (rest.includes('/')) { err(`fragments live directly in ${prefix} (one flat file each), not in a subdirectory`); continue; }
    if (e.mode !== '100644') { err(`must be a regular file (mode 100644), found mode ${e.mode}${e.mode === '120000' ? ' (symlink)' : e.mode === '160000' ? ' (gitlink)' : ''}`); continue; }
    if (!rest.endsWith('.md')) { err('a fragment is a .md file'); continue; }
    const prior = excluded.get(e.path);
    if (prior === e.sha) continue;
    if (prior !== undefined) { err('a fragment of this name already exists on the base with other text; fragments are never edited after they land'); continue; }
    const size = git(cwd, ['cat-file', '-s', e.sha]);
    if (!size.ok || Number(size.out.trim()) > MAX_FRAGMENT_BYTES) { err(`larger than ${MAX_FRAGMENT_BYTES} bytes or unreadable`); continue; }
    const blob = git(cwd, ['cat-file', 'blob', e.sha]);
    if (!blob.ok) { err('blob unreadable'); continue; }
    const parsed = parseFragment(e.path, blob.out);
    if ('code' in parsed) errors.push(parsed);
    else if (isReleased(parsed.body)) { if (onReleased === 'error') err(`its text is already released in ${changelog} on the base (a landed PR's fragment carried in by stacked history); delete it from this branch`); }
    else fragments.push(parsed);
  }
  return { fragments, errors };
}

/** The highest of the policy bump and every fragment's declared bump. */
export function effectiveBump(level: Bump, fragments: readonly Fragment[]): Bump {
  return fragments.reduce<Bump>((acc, f) => (f.bump && BUMP_RANK[f.bump] > BUMP_RANK[acc] ? f.bump : acc), level);
}

/**
 * Put the fragment bodies, in path order, into the CHANGELOG's `[Unreleased]` section (created at the
 * top when absent), so the existing re-heading moves fragments and a legacy entry together under one
 * version. Returns the text unchanged when there are no fragments.
 */
export function foldIntoUnreleased(text: string, fragments: readonly Fragment[]): string {
  if (!fragments.length) return text;
  const parsed = parseChangelog(text);
  const bodies = fragments.map(f => f.body).join('\n\n');
  const unreleased = parsed.sections.find(s => s.unreleased);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (unreleased) {
    const own = lines.slice(unreleased.start + 1, unreleased.end);
    while (own.length && !own[0]!.trim()) own.shift();
    while (own.length && !own[own.length - 1]!.trim()) own.pop();
    const merged = [lines[unreleased.start]!, '', ...bodies.split('\n'), ...(own.length ? ['', ...own] : []), ''];
    return [...lines.slice(0, unreleased.start), ...merged, ...lines.slice(unreleased.end)].join('\n');
  }
  const at = parsed.sections[0]?.start ?? lines.length;
  const head = lines.slice(0, at);
  while (head.length && !head[head.length - 1]!.trim()) head.pop();
  return [...head, ...(head.length ? [''] : []), '## [Unreleased]', '', ...bodies.split('\n'), '', ...lines.slice(at)].join('\n');
}
