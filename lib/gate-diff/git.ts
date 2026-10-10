/**
 * gate-diff git — the candidate model and the hardened git calls behind
 * bin/gstack-gate-diff. ONE comparison: resolved merge-base SHA → the working
 * tree as it stands (`git diff -M --no-color --no-ext-diff --no-textconv
 * <merge-base>`), plus non-ignored untracked files as additions; never the
 * committed + HEAD + untracked concatenation gstack-diff-scope uses. `--commit
 * <sha>` scans one commit's first-parent delta without the working tree.
 *
 * Binary, symlink, submodule and undecodable paths come back as named
 * `unsupported` files, not zero hunks. Every git call runs with
 * GIT_OPTIONAL_LOCKS=0, no pager, no prompt, a timeout, and `--` before paths.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommitInfo, FileDiff, FileStatus, Hunk, Unsupported } from './types';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DIFF_FLAGS = ['diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3'];

export interface GitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export function runGit(args: string[], cwd: string, timeoutMs = 60_000): GitResult {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '--no-pager', ...args], {
    cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? Buffer.alloc(0), stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf-8') };
}

function gitText(args: string[], cwd: string): string | null {
  const r = runGit(args, cwd);
  return r.status === 0 ? r.stdout.toString('utf-8').trim() : null;
}

export function repoRoot(cwd: string): string | null {
  return gitText(['rev-parse', '--show-toplevel'], cwd);
}

export function resolvesToCommit(ref: string, cwd: string): string | null {
  if (!/^[A-Za-z0-9._\/@{}^~-]+$/.test(ref) || ref.startsWith('-')) return null;
  return gitText(['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd);
}

/** origin/HEAD's target → `main` → `master` (the gstack-diff-scope chain), as a ref name. */
export function defaultBase(cwd: string): string {
  const head = gitText(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], cwd);
  if (head) return head.replace(/^refs\/remotes\//, '');
  for (const name of ['main', 'master']) {
    if (resolvesToCommit(name, cwd) || resolvesToCommit(`origin/${name}`, cwd)) return name;
  }
  return 'main';
}

export function isShallow(cwd: string): boolean {
  return gitText(['rev-parse', '--is-shallow-repository'], cwd) === 'true';
}

/** The concrete recovery for an unresolvable base: fetch it from the detected remote, unshallowing when needed. */
export function noBaseFix(ref: string, cwd: string): string {
  const remotes = (gitText(['remote'], cwd) ?? '').split('\n').filter(Boolean);
  const m = /^([^/]+)\/(.+)$/.exec(ref);
  const remote = m && remotes.includes(m[1]) ? m[1] : remotes.includes('origin') ? 'origin' : remotes[0] ?? 'origin';
  const branch = m && remotes.includes(m[1]) ? m[2] : ref;
  if (/^[0-9a-f]{7,64}\^?$/.test(ref) || ref.endsWith('^')) return isShallow(cwd) ? `git fetch --deepen=50 ${remote}` : `git fetch ${remote}`;
  return isShallow(cwd) ? `git fetch --unshallow ${remote} ${branch}` : `git fetch ${remote} ${branch}`;
}

export function mergeBase(a: string, b: string, cwd: string): string | null {
  return gitText(['merge-base', a, b], cwd);
}

export function headSha(cwd: string): string | null {
  return gitText(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], cwd);
}

/** Working-tree content fingerprint from the sibling gstack-wtree helper; null when unavailable. */
export function wtreeFingerprint(binDir: string, cwd: string): string | null {
  try {
    const r = spawnSync(path.join(binDir, 'gstack-wtree'), [], { cwd, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const out = (r.stdout || '').trim();
    return r.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** C-style unquote of a git path (`"a\\tb"`), including octal UTF-8 bytes. */
export function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf-8'));
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      const oct = s.slice(i, i + 3).match(/^[0-7]{1,3}/)?.[0] ?? n;
      bytes.push(Number.parseInt(oct, 8));
      i += oct.length - 1;
    } else bytes.push(...Buffer.from({ t: '\t', n: '\n', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' }[n] ?? n, 'utf-8'));
  }
  return Buffer.from(bytes).toString('utf-8');
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string {
  const u = unquoteGitPath(p);
  return u.startsWith(prefix) ? u.slice(2) : u;
}

/** Split `diff --git a/x b/y` into (x, y); equal paths resolve exactly, renames with spaces fall back to the middle ` b/`. */
function splitDiffGitLine(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (m) return [stripPrefix(m[1], 'a/'), stripPrefix(m[2], 'b/')];
  }
  const body = rest.startsWith('a/') ? rest.slice(2) : rest;
  if (body.length % 2 === 1) {
    const half = (body.length - 1) / 2;
    if (body.slice(half, half + 3) === ' b/' && body.slice(0, half) === body.slice(half + 3)) return [body.slice(0, half), body.slice(0, half)];
  }
  const idx = body.indexOf(' b/');
  return idx < 0 ? [body, body] : [body.slice(0, idx), body.slice(idx + 3)];
}

interface Section {
  headers: string[];
  body: string[];
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inBody = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { headers: [line], body: [] };
      sections.push(cur);
      inBody = false;
      continue;
    }
    if (!cur) continue;
    if (!inBody && line.startsWith('@@')) inBody = true;
    if (inBody) cur.body.push(line);
    else cur.headers.push(line);
  }
  return sections;
}

function parseHunks(body: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of body) {
    if (line.startsWith('@@')) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || line.startsWith('\\')) continue;
    if (line.startsWith('+')) cur.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) cur.lines.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ') || line === '') cur.lines.push({ kind: 'ctx', text: line.slice(1) });
  }
  return hunks;
}

function sectionToFile(sec: Section): FileDiff {
  let [oldPath, newPath] = splitDiffGitLine(sec.headers[0].slice('diff --git '.length));
  let status: FileStatus = 'modified';
  let unsupported: Unsupported | undefined;
  for (const h of sec.headers.slice(1)) {
    if (h.startsWith('rename from ')) oldPath = unquoteGitPath(h.slice(12));
    else if (h.startsWith('rename to ')) { newPath = unquoteGitPath(h.slice(10)); status = 'renamed'; }
    else if (h.startsWith('copy from ')) oldPath = unquoteGitPath(h.slice(10));
    else if (h.startsWith('copy to ')) { newPath = unquoteGitPath(h.slice(8)); status = 'copied'; }
    else if (h.startsWith('new file mode')) status = 'added';
    else if (h.startsWith('deleted file mode')) status = 'deleted';
    else if (h.startsWith('--- ') && !h.startsWith('--- /dev/null')) oldPath = stripPrefix(h.slice(4), 'a/');
    else if (h.startsWith('+++ ') && !h.startsWith('+++ /dev/null')) newPath = stripPrefix(h.slice(4), 'b/');
    if (/\b120000\b/.test(h) && /mode/.test(h)) unsupported = 'symlink';
    if (/^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(h) || /\b160000\b/.test(h) && /mode/.test(h)) unsupported = 'submodule';
    if (h.startsWith('Binary files ')) unsupported = unsupported ?? 'binary';
    if (h.startsWith('old mode') || h.startsWith('new mode')) status = status === 'modified' ? 'typechange' : status;
  }
  if (status === 'added') oldPath = newPath;
  if (status === 'deleted') newPath = oldPath;
  const hunks = unsupported ? [] : parseHunks(sec.body);
  if (!unsupported && hunks.some((h) => h.lines.some((l) => /^Subproject commit [0-9a-f]+/.test(l.text)))) unsupported = 'submodule';
  if (!unsupported && sec.body.some((l) => l.includes('\uFFFD'))) unsupported = 'undecodable';
  const file: FileDiff = { oldPath, newPath, status: status === 'typechange' && hunks.length ? 'modified' : status, hunks: unsupported ? [] : hunks };
  if (unsupported) file.unsupported = unsupported;
  return file;
}

/** Parse `git diff` text (as produced with the flags above) into structured files. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  return splitSections(text).map(sectionToFile);
}

function decode(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/** merge-base → working tree (tracked changes, staged and unstaged, with rename detection). */
export function diffWorkingTree(mergeBaseSha: string, cwd: string): FileDiff[] {
  const r = runGit([...DIFF_FLAGS, mergeBaseSha, '--'], cwd);
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return parseUnifiedDiff(decode(r.stdout));
}

/**
 * The commit's first parent, EMPTY_TREE for a root commit, or null when the
 * parent is missing (shallow boundary). Read from the raw object: `git log
 * --format=%P` hides a shallow boundary's parents, which would make the
 * boundary look like a root and list the whole tree as added.
 */
export function firstParent(sha: string, cwd: string): string | null {
  const raw = gitText(['cat-file', '-p', `${sha}^{commit}`], cwd);
  if (raw === null) return null;
  const parent = /^parent ([0-9a-f]{40,64})$/m.exec(raw.split('\n\n')[0] ?? '')?.[1];
  if (!parent) return EMPTY_TREE;
  return resolvesToCommit(parent, cwd);
}

/** One commit's first-parent delta (root commits diff against the empty tree). Throws when the parent is missing. */
export function diffCommit(sha: string, cwd: string): FileDiff[] {
  const parent = firstParent(sha, cwd);
  if (!parent) throw new Error(`first parent of ${sha} is not present (shallow history); fix: ${noBaseFix(`${sha}^`, cwd)}`);
  const r = runGit([...DIFF_FLAGS, parent, sha, '--'], cwd);
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return parseUnifiedDiff(decode(r.stdout));
}

export function untrackedPaths(cwd: string): string[] {
  const r = runGit(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
  if (r.status !== 0) return [];
  return r.stdout.toString('utf-8').split('\0').filter(Boolean);
}

/** Non-ignored untracked files as whole-file additions; binary/symlink/undecodable named, nested repos as submodules. */
export function untrackedAsAdded(cwd: string, root: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const rel of untrackedPaths(cwd)) {
    const abs = path.join(root, rel);
    const file: FileDiff = { oldPath: rel, newPath: rel, status: 'added', hunks: [] };
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) file.unsupported = 'symlink';
      else if (st.isDirectory()) file.unsupported = 'submodule';
      else {
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 8000).includes(0)) file.unsupported = 'binary';
        else {
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          } catch {
            file.unsupported = 'undecodable';
            out.push(file);
            continue;
          }
          const lines = text.split('\n');
          if (lines[lines.length - 1] === '') lines.pop();
          file.hunks = [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((t) => ({ kind: 'add' as const, text: t })) }];
        }
      }
    } catch {
      file.unsupported = 'undecodable';
    }
    out.push(file);
  }
  return out;
}

export function commitsInRange(fromExclusive: string, toInclusive: string, cwd: string): CommitInfo[] {
  const r = runGit(['log', '--format=%H%x00%B%x00', `${fromExclusive}..${toInclusive}`, '--'], cwd);
  if (r.status !== 0) return [];
  const parts = r.stdout.toString('utf-8').split('\0');
  const out: CommitInfo[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const sha = parts[i].trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) out.push({ sha, message: parts[i + 1] });
  }
  return out;
}

export function commitInfo(sha: string, cwd: string): CommitInfo | null {
  const msg = gitText(['log', '-1', '--format=%B', sha, '--'], cwd);
  return msg === null ? null : { sha, message: msg };
}

/** Paths in the candidate tree: tracked + untracked for the working tree, `ls-tree` for a commit. */
export function treePaths(cwd: string, commit?: string): string[] {
  const r = commit
    ? runGit(['ls-tree', '-r', '-z', '--name-only', commit, '--'], cwd)
    : runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd);
  if (r.status !== 0) return [];
  return r.stdout.toString('utf-8').split('\0').filter(Boolean);
}

export function readClaudeMd(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  } catch {
    return '';
  }
}
