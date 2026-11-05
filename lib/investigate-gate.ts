/**
 * investigate-gate — the tree check and release rule behind the /investigate
 * enforcement hook (GST-1461). Docs: docs/skill-gates.md.
 *
 * When the gate arms it pins a baseline: the repo root, HEAD, the refs and
 * stash list, and the content of every tracked path that differs from HEAD
 * (raw bytes of gated files copied into the session dir). Every later check
 * compares the tree with that one baseline, so a write made by a background
 * command or a parallel call is caught at the next hook call whichever call
 * made it. A gated path whose content moved away from the baseline is a fix
 * write and is put back, unless the new content is the path's blob in HEAD
 * (a revert), in a commit that existed before the baseline (checkout, bisect)
 * or in a stash entry that existed before (stash pop). A commit made after
 * the baseline that touches a gated path is undone with reset --soft.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPlaceholder, labelValue, type SkillLoad, type Transcript } from './skill-contract';
import { GateError, remainingMs } from './skill-gates';

const GIT_TIMEOUT_MS = 3000;
const LOCKFILES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'flake.lock']);
const DOC_PATH = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
/** lib/review-depth.ts's TEST_PATH (gstack-diff-scope's TEST_PATH_RE plus fixture directories), copied because that file's bytes are pinned to a no-loss replay. */
const TEST_PATH = [/(^|\/)(tests?|spec|__tests__)\/|(^|\/)tests?\.py$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|ts|js|exs|dart)$|\.(test|spec)\.[jt]sx?$|_spec\.rb$|Test\.(java|kt)$/, /(^|\/)fixtures?\//];
const HEDGE = /^(?:unknown|unclear|not (?:sure|known|yet known|clear)|undetermined|investigating|still investigating|to be determined|pending|see below|see above|n\/?a|none|tbd\b.*)$/i;
const EVIDENCE_TOOLS = /^(?:Read|Grep|Glob|Bash|LS|NotebookRead|WebFetch)$/;
export const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

export function git(root: string, args: string[], opts: { input?: string; allowFail?: boolean; env?: Record<string, string> } = {}): { ok: boolean; out: Buffer } {
  const r = spawnSync('git', args, { cwd: root, input: opts.input, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...opts.env }, timeout: Math.min(GIT_TIMEOUT_MS, remainingMs()), maxBuffer: 64 * 1024 * 1024 });
  const ok = r.status === 0;
  if (!ok && !opts.allowFail) {
    const why = r.error ? r.error.message : String(r.stderr ?? '').trim().split('\n')[0];
    throw new GateError('GATE_GIT', `git ${args[0]} failed: ${why}`);
  }
  return { ok, out: (r.stdout as Buffer) ?? Buffer.alloc(0) };
}
const text = (b: Buffer) => b.toString('utf8');
const nulList = (b: Buffer) => text(b).split('\0').filter(Boolean);

export function repoRoot(cwd: string): string | null {
  if (!fs.existsSync(cwd)) return null;
  const r = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.ok ? fs.realpathSync(text(r.out).trim()) : null;
}
const headOf = (root: string) => { const r = git(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true }); return r.ok ? text(r.out).trim() : null; };
const branchOf = (root: string) => text(git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }).out).trim();
const changedVsHead = (root: string) => nulList(git(root, ['diff', 'HEAD', '--name-only', '-z', '--no-renames']).out);

interface TreeEntry { mode: string; oid: string }
function treeEntries(root: string, rev: string, paths: string[]): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (let i = 0; i < paths.length; i += 500) {
    for (const rec of nulList(git(root, ['ls-tree', '-z', rev, '--', ...paths.slice(i, i + 500)]).out)) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
      if (m && m[2] === 'blob') out.set(m[4], { mode: m[1], oid: m[3] });
    }
  }
  return out;
}
/** Paths rev's attributes mark linguist-generated, read through a scratch index so a worktree .gitattributes cannot exempt source (git before 2.40 has no check-attr --source). */
function generatedPaths(root: string, rev: string, paths: string[]): Set<string> {
  const out = new Set<string>();
  if (!paths.length) return out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-attr-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(root, ['read-tree', rev], { env });
    for (let i = 0; i < paths.length; i += 500) {
      const f = nulList(git(root, ['check-attr', '--cached', '-z', 'linguist-generated', '--', ...paths.slice(i, i + 500)], { env }).out);
      for (let j = 0; j + 2 < f.length + 1; j += 3) if (f[j + 2] === 'set' || f[j + 2] === 'true') out.add(f[j]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

type IndexEntry = { mode: string; oid: string };
/** Stage-0 index entries; a conflicted path maps to undefined (left alone on restore). */
function indexEntries(root: string, paths: string[]): Map<string, IndexEntry | undefined> {
  const out = new Map<string, IndexEntry | undefined>();
  for (let i = 0; i < paths.length; i += 500) {
    for (const rec of nulList(git(root, ['ls-files', '-s', '-z', '--', ...paths.slice(i, i + 500)]).out)) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(rec);
      if (m) out.set(m[4], m[3] === '0' && !out.has(m[4]) ? { mode: m[1], oid: m[2] } : undefined);
    }
  }
  return out;
}

/** Copy a file's raw bytes into the session dir under their sha256, the key a restore reads back. */
function saveBytes(blobs: string, file: string): string {
  const bytes = fs.readFileSync(file);
  const key = createHash('sha256').update(bytes).digest('hex');
  const dest = path.join(blobs, key);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(blobs, { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, bytes, { mode: 0o600 });
    fs.chmodSync(dest, 0o600);
  }
  return key;
}

/** The content id of a worktree path: its git blob id (filters applied), symlink:<target>, dir, or null when absent. */
function worktreeIds(root: string, paths: string[]): Map<string, string | null> {
  const ids = new Map<string, string | null>();
  const files: string[] = [];
  for (const p of paths) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, p)); } catch { ids.set(p, null); continue; }
    if (st.isSymbolicLink()) ids.set(p, `symlink:${fs.readlinkSync(path.join(root, p))}`);
    else if (st.isDirectory()) ids.set(p, 'dir');
    else if (p.includes('\n')) ids.set(p, 'unhashable');
    else files.push(p);
  }
  if (files.length) {
    const oids = text(git(root, ['hash-object', '--stdin-paths'], { input: `${files.join('\n')}\n` }).out).trim().split('\n');
    files.forEach((p, i) => ids.set(p, oids[i] ?? null));
  }
  return ids;
}

export type ExcludedReason = 'test' | 'doc' | 'lockfile' | 'generated' | 'symlink';
export function excludedReason(rel: string, mode?: string, generated = false): ExcludedReason | null {
  if (TEST_PATH.some(r => r.test(rel))) return 'test';
  if (DOC_PATH.test(rel)) return 'doc';
  if (LOCKFILES.has(path.posix.basename(rel))) return 'lockfile';
  if (generated) return 'generated';
  if (mode === '120000') return 'symlink';
  return null;
}

/** Whether a repo-relative path is tracked (in HEAD or the index) and gated. */
export function isGatedTracked(root: string, rel: string, rev: string): boolean {
  const ls = text(git(root, ['ls-files', '-s', '-z', '--', rel]).out).split('\0').filter(Boolean);
  const entry = ls.find(l => l.endsWith(`\t${rel}`));
  if (!entry) return false;
  return excludedReason(rel, entry.split(' ')[0], generatedPaths(root, rev, [rel]).has(rel)) === null;
}

interface Entry { id: string | null; excluded: boolean; mode: number; backup?: string; index?: IndexEntry | null }
export interface Baseline { version: 1; root: string; head: string; branch?: string; tips?: Record<string, string>; taken_at: number; refs: string[]; stashes: string[]; entries: Record<string, Entry> }

function snapshot(root: string, blobs: string, head: string): Baseline {
  const changed = [...new Set([...changedVsHead(root), ...nulList(git(root, ['diff', '--cached', 'HEAD', '--name-only', '-z', '--no-renames']).out)])];
  const ids = worktreeIds(root, changed);
  const tree = changed.length ? treeEntries(root, head, changed) : new Map<string, TreeEntry>();
  const generated = generatedPaths(root, head, changed);
  const staged = indexEntries(root, changed);
  const entries: Record<string, Entry> = {};
  for (const p of changed) {
    const id = ids.get(p) ?? null;
    const abs = path.join(root, p);
    const excluded = excludedReason(p, tree.get(p)?.mode, generated.has(p)) !== null;
    let mode = 0o644;
    let backup: string | undefined;
    if (id && /^[0-9a-f]+$/.test(id)) {
      mode = fs.statSync(abs).mode & 0o777;
      if (!excluded) backup = saveBytes(blobs, abs);
    }
    entries[p] = { id, excluded, mode, ...(backup ? { backup } : {}), index: staged.has(p) ? staged.get(p) : null };
  }
  const refs = nulList(git(root, ['for-each-ref', '--format=%(objectname)%00']).out).map(s => s.trim()).filter(Boolean);
  const stashes = text(git(root, ['log', '-g', '--format=%H', 'refs/stash'], { allowFail: true }).out).split('\n').filter(Boolean);
  const tips = Object.fromEntries(text(git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']).out).split('\n').filter(Boolean).map(l => l.split(' ')));
  return { version: 1, root, head, branch: branchOf(root), tips, taken_at: Date.now(), refs: [...new Set([head, ...refs])], stashes, entries };
}

export function armBaseline(root: string, blobs: string): Baseline | null {
  const head = headOf(root);
  return head ? snapshot(root, blobs, head) : null;
}

function existedBefore(root: string, base: Baseline, commit: string): boolean {
  const unseen = git(root, ['rev-list', '-n', '1', '--stdin'], { input: `${commit}\n${base.refs.map(r => `^${r}`).join('\n')}\n`, allowFail: true });
  if (unseen.ok ? !text(unseen.out).trim() : base.refs.some(r => git(root, ['merge-base', '--is-ancestor', commit, r], { allowFail: true }).ok)) return true;
  const ct = Number(text(git(root, ['show', '-s', '--format=%ct', commit]).out).trim());
  return ct < Math.floor(base.taken_at / 1000);
}

/** Whether a remote-tracking ref holds the commit (a fetched upstream commit a merge brings in). */
const onRemote = (root: string, commit: string) => text(git(root, ['for-each-ref', '--count=1', '--contains', commit, 'refs/remotes'], { allowFail: true }).out).trim() !== '';

function inStash(root: string, base: Baseline, rel: string, id: string): boolean {
  return base.stashes.some(s => {
    const r = git(root, ['rev-parse', '-q', '--verify', `${s}:${rel}`], { allowFail: true });
    return r.ok && text(r.out).trim() === id;
  });
}

/** Write bytes (or remove the path) without following a symlink or leaving root. */
function safeRestore(root: string, rel: string, content: Buffer | null, mode: number, symlink?: string): void {
  const parts = rel.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(dir); } catch { /* missing */ }
    if (!st) fs.mkdirSync(dir, { mode: 0o755 });
    else if (!st.isDirectory()) throw new Error(`${path.relative(root, dir)} is not a directory inside the repository`);
  }
  const abs = path.join(root, rel);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(abs); } catch { /* absent */ }
  if (st?.isDirectory()) throw new Error(`${rel} is now a directory`);
  if (content === null && symlink === undefined) { if (st) fs.unlinkSync(abs); return; }
  const tmp = `${abs}.gstack-restore-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  if (symlink !== undefined) fs.symlinkSync(symlink, tmp);
  else fs.writeFileSync(tmp, content!, { mode });
  fs.renameSync(tmp, abs);
}

export interface CheckResult { baseline: Baseline; violations: string[]; observed: string[]; restored: string[]; failed: Array<{ path: string; why: string }>; reset: string | null; staged: string[]; saved: Array<{ path: string; file: string }> }

/** Compare the tree with the baseline, put back fix writes, and return the next baseline. */
export function checkTree(base: Baseline, blobs: string): CheckResult {
  const root = base.root;
  const head = headOf(root);
  if (!head) throw new GateError('GATE_GIT', 'HEAD no longer resolves');
  const result: CheckResult = { baseline: base, violations: [], observed: [], restored: [], failed: [], reset: null, staged: [], saved: [] };
  let target = head;
  const merged: string[] = [];
  const upstream = (c: string) => existedBefore(root, base, c) || onRemote(root, c);
  if (head !== base.head) {
    while (!upstream(target)) {
      const parents = text(git(root, ['rev-list', '--parents', '-n', '1', target]).out).trim().split(' ').slice(1);
      if (!parents.length) throw new GateError('GATE_GIT', `no commit under ${head.slice(0, 12)} existed before the baseline`);
      merged.push(...parents.slice(1).filter(upstream));
      target = parents[0];
    }
  }
  const branch = branchOf(root);
  const tip = branch === base.branch ? base.head : branch ? base.tips?.[branch] : undefined;
  if (tip && target !== head && target !== tip && git(root, ['merge-base', '--is-ancestor', target, tip], { allowFail: true }).ok) target = tip;
  const newCommit = target !== head;
  const moved = target !== base.head;
  const committed = newCommit ? nulList(git(root, ['diff', '--name-only', '-z', '--no-renames', target, head]).out) : [];
  const cand = [...new Set([...changedVsHead(root), ...Object.keys(base.entries), ...committed])];
  if (!cand.length && head === base.head) return result;
  const ids = worktreeIds(root, cand);
  const baseTree = treeEntries(root, base.head, cand);
  const refTree = moved ? treeEntries(root, target, cand) : baseTree;
  const headTree = newCommit ? treeEntries(root, head, cand) : refTree;
  const mergedTrees = merged.map(m => treeEntries(root, m, cand));
  const generated = generatedPaths(root, base.head, cand);
  const fix = new Set<string>();
  for (const p of cand) {
    const baseEntry = base.entries[p];
    const want = baseEntry ? baseEntry.id : refTree.get(p)?.oid;
    if (want === undefined) continue;
    const known = (id: string | null) => id === want || (id !== null && (id === baseTree.get(p)?.oid || id === refTree.get(p)?.oid || mergedTrees.some(t => t.get(p)?.oid === id)));
    const curId = ids.get(p) ?? null;
    const committedFix = committed.includes(p) && !known(headTree.get(p)?.oid ?? null);
    if (!committedFix && (known(curId) || (curId !== null && inStash(root, base, p, curId)))) continue;
    if (excludedReason(p, baseTree.get(p)?.mode ?? refTree.get(p)?.mode ?? headTree.get(p)?.mode, generated.has(p)) !== null) { result.observed.push(p); continue; }
    fix.add(p);
  }
  result.violations = [...fix].sort();
  if (newCommit && committed.some(p => fix.has(p))) {
    git(root, ['reset', '-q', '--soft', target]);
    git(root, ['reset', '-q', target, '--', ...committed.filter(p => fix.has(p))], { allowFail: true });
    result.reset = target;
    result.staged = committed.filter(p => !fix.has(p));
  }
  for (const p of result.violations) {
    const baseEntry = base.entries[p];
    const curId = ids.get(p) ?? null;
    if (curId === (baseEntry ? baseEntry.id : refTree.get(p)!.oid)) continue;
    try {
      if (curId && /^[0-9a-f]+$/.test(curId)) result.saved.push({ path: p, file: path.join(blobs, saveBytes(blobs, path.join(root, p))) });
      if (baseEntry) {
        if (baseEntry.id === null) safeRestore(root, p, null, 0);
        else if (baseEntry.id.startsWith('symlink:')) safeRestore(root, p, null, 0, baseEntry.id.slice(8));
        else safeRestore(root, p, fs.readFileSync(path.join(blobs, baseEntry.backup ?? baseEntry.id)), baseEntry.mode);
      } else {
        const cur = fs.lstatSync(path.join(root, p), { throwIfNoEntry: false });
        const kept = cur?.isFile() ? cur.mode & 0o777 : undefined;
        safeRestore(root, p, git(root, ['cat-file', '--filters', `${target}:${p}`]).out, kept ?? (refTree.get(p)!.mode === '100755' ? 0o755 : 0o644));
        if (kept !== undefined) fs.chmodSync(path.join(root, p), kept);
      }
      const staged = baseEntry ? baseEntry.index : refTree.get(p);
      if (staged === null) git(root, ['update-index', '--force-remove', '--', p]);
      else if (staged) git(root, ['update-index', '--add', '--cacheinfo', staged.mode, staged.oid, p]);
      result.restored.push(p);
    } catch (e) {
      result.failed.push({ path: p, why: e instanceof Error ? e.message : String(e) });
    }
  }
  result.baseline = snapshot(root, blobs, headOf(root) ?? base.head);
  return result;
}

export interface RootCause { stated: boolean; cause?: string; rejected?: { value: string; why: string } }

/** A \`Root cause: <value>\` line in assistant text after the load and after an evidence tool call, not a placeholder or hedge. */
export function rootCause(t: Transcript, load: SkillLoad): RootCause {
  let evidence = false;
  let rejected: RootCause['rejected'];
  for (const e of t.events.slice(load.at + 1)) {
    if (e.kind === 'tool_use' && EVIDENCE_TOOLS.test(e.name)) evidence = true;
    if (e.kind !== 'text') continue;
    const value = labelValue(e.text, 'Root cause');
    if (value === null) continue;
    if (isPlaceholder(value) || HEDGE.test(value.replace(/[.!]+$/, '').trim())) { rejected = { value, why: 'it is a placeholder or a hedge, not a cause' }; continue; }
    if (!evidence) { rejected = { value, why: 'it came before you read code or ran anything' }; continue; }
    return { stated: true, cause: createHash('sha256').update(value).digest('hex').slice(0, 12) };
  }
  return { stated: false, ...(rejected ? { rejected } : {}) };
}
