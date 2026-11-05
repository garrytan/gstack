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
import * as path from 'path';
import { isTestPath } from './review-depth';
import { isPlaceholder, labelValue, type SkillLoad, type Transcript } from './skill-contract';
import { GateError, remainingMs } from './skill-gates';

const GIT_TIMEOUT_MS = 3000;
const LOCKFILES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'flake.lock']);
const DOC_PATH = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const HEDGE = /^(?:unknown|unclear|not (?:sure|known|yet known|clear)|undetermined|investigating|still investigating|to be determined|pending|see below|see above|n\/?a|none|tbd\b.*)$/i;
const EVIDENCE_TOOLS = /^(?:Read|Grep|Glob|Bash|LS|NotebookRead|WebFetch)$/;
export const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

function git(root: string, args: string[], opts: { input?: string; allowFail?: boolean } = {}): { ok: boolean; out: Buffer } {
  const r = spawnSync('git', args, { cwd: root, input: opts.input, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: Math.min(GIT_TIMEOUT_MS, remainingMs()), maxBuffer: 64 * 1024 * 1024 });
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
function generatedPaths(root: string, paths: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < paths.length; i += 500) {
    const f = nulList(git(root, ['check-attr', '-z', 'linguist-generated', '--', ...paths.slice(i, i + 500)]).out);
    for (let j = 0; j + 2 < f.length + 1; j += 3) if (f[j + 2] === 'set' || f[j + 2] === 'true') out.add(f[j]);
  }
  return out;
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
  if (isTestPath(rel)) return 'test';
  if (DOC_PATH.test(rel)) return 'doc';
  if (LOCKFILES.has(path.posix.basename(rel))) return 'lockfile';
  if (generated) return 'generated';
  if (mode === '120000') return 'symlink';
  return null;
}

/** Whether a repo-relative path is tracked (in HEAD or the index) and gated. */
export function isGatedTracked(root: string, rel: string): boolean {
  const ls = text(git(root, ['ls-files', '-s', '-z', '--', rel]).out).split('\0').filter(Boolean);
  const entry = ls.find(l => l.endsWith(`\t${rel}`));
  if (!entry) return false;
  return excludedReason(rel, entry.split(' ')[0], generatedPaths(root, [rel]).has(rel)) === null;
}

interface Entry { id: string | null; excluded: boolean; mode: number }
export interface Baseline { version: 1; root: string; head: string; taken_at: number; refs: string[]; stashes: string[]; entries: Record<string, Entry> }

function snapshot(root: string, blobs: string, head: string): Baseline {
  const changed = changedVsHead(root);
  const ids = worktreeIds(root, changed);
  const tree = changed.length ? treeEntries(root, head, changed) : new Map<string, TreeEntry>();
  const generated = changed.length ? generatedPaths(root, changed) : new Set<string>();
  const entries: Record<string, Entry> = {};
  for (const p of changed) {
    const id = ids.get(p) ?? null;
    const abs = path.join(root, p);
    const excluded = excludedReason(p, tree.get(p)?.mode, generated.has(p)) !== null;
    let mode = 0o644;
    if (id && /^[0-9a-f]+$/.test(id)) {
      mode = fs.statSync(abs).mode & 0o777;
      if (!excluded && !fs.existsSync(path.join(blobs, id))) {
        fs.mkdirSync(blobs, { recursive: true, mode: 0o700 });
        fs.copyFileSync(abs, path.join(blobs, id));
        fs.chmodSync(path.join(blobs, id), 0o600);
      }
    }
    entries[p] = { id, excluded, mode };
  }
  const refs = nulList(git(root, ['for-each-ref', '--format=%(objectname)%00']).out).map(s => s.trim()).filter(Boolean);
  const stashes = text(git(root, ['log', '-g', '--format=%H', 'refs/stash'], { allowFail: true }).out).split('\n').filter(Boolean);
  return { version: 1, root, head, taken_at: Date.now(), refs: [...new Set([head, ...refs])], stashes, entries };
}

export function armBaseline(root: string, blobs: string): Baseline | null {
  const head = headOf(root);
  return head ? snapshot(root, blobs, head) : null;
}

function existedBefore(root: string, base: Baseline, commit: string): boolean {
  if (base.refs.some(r => git(root, ['merge-base', '--is-ancestor', commit, r], { allowFail: true }).ok)) return true;
  const ct = Number(text(git(root, ['show', '-s', '--format=%ct', commit]).out).trim());
  return ct < Math.floor(base.taken_at / 1000);
}

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

export interface CheckResult { baseline: Baseline; violations: string[]; observed: string[]; restored: string[]; failed: Array<{ path: string; why: string }>; reset: string | null }

/** Compare the tree with the baseline, put back fix writes, and return the next baseline. */
export function checkTree(base: Baseline, blobs: string): CheckResult {
  const root = base.root;
  const head = headOf(root);
  if (!head) throw new GateError('GATE_GIT', 'HEAD no longer resolves');
  const changed = changedVsHead(root);
  const cand = [...new Set([...changed, ...Object.keys(base.entries)])];
  const result: CheckResult = { baseline: base, violations: [], observed: [], restored: [], failed: [], reset: null };
  const moved = head !== base.head;
  const newCommit = moved && !existedBefore(root, base, head);
  let committed: string[] = [];
  if (newCommit) {
    const touched = nulList(git(root, ['diff', '--name-only', '-z', '--no-renames', base.head, head]).out);
    const tTree = touched.length ? treeEntries(root, base.head, touched) : new Map<string, TreeEntry>();
    const tGen = touched.length ? generatedPaths(root, touched) : new Set<string>();
    committed = touched.filter(p => excludedReason(p, tTree.get(p)?.mode, tGen.has(p)) === null && (tTree.has(p) || base.entries[p] !== undefined));
  }
  if (!cand.length && !committed.length && !moved) return result;
  const all = [...new Set([...cand, ...committed])];
  const ids = worktreeIds(root, all);
  const baseTree = treeEntries(root, base.head, all);
  const curTree = moved ? treeEntries(root, head, all) : baseTree;
  const generated = generatedPaths(root, all);
  const fix = new Set<string>();
  for (const p of all) {
    const baseEntry = base.entries[p];
    const baseId = baseEntry ? baseEntry.id : baseTree.get(p)?.oid;
    if (baseId === undefined) continue;
    const curId = ids.get(p) ?? null;
    if (curId === baseId && !committed.includes(p)) continue;
    if (excludedReason(p, baseTree.get(p)?.mode ?? curTree.get(p)?.mode, generated.has(p)) !== null) { if (curId !== baseId) result.observed.push(p); continue; }
    if (curId !== baseId && !newCommit && curTree.get(p)?.oid === curId) continue;
    if (curId !== baseId && curId && inStash(root, base, p, curId)) continue;
    fix.add(p);
  }
  result.violations = [...fix].sort();
  if (newCommit && committed.some(p => fix.has(p))) {
    git(root, ['reset', '-q', '--soft', base.head]);
    git(root, ['reset', '-q', base.head, '--', ...committed.filter(p => fix.has(p))], { allowFail: true });
    result.reset = base.head;
  }
  for (const p of result.violations) {
    const baseEntry = base.entries[p];
    const curId = ids.get(p) ?? null;
    const baseId = baseEntry ? baseEntry.id : baseTree.get(p)!.oid;
    if (curId === baseId) continue;
    try {
      if (baseEntry) {
        if (baseEntry.id === null) safeRestore(root, p, null, 0);
        else if (baseEntry.id.startsWith('symlink:')) safeRestore(root, p, null, 0, baseEntry.id.slice(8));
        else safeRestore(root, p, fs.readFileSync(path.join(blobs, baseEntry.id)), baseEntry.mode);
      } else {
        const entry = baseTree.get(p)!;
        safeRestore(root, p, git(root, ['cat-file', '--filters', `${base.head}:${p}`]).out, entry.mode === '100755' ? 0o755 : 0o644);
      }
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
