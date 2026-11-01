/**
 * Receipt resolution for plan reality rows (G1, #973).
 *
 * `checkRealityRows` (lib/plan-reality.ts) stays pure: it only asks whether a
 * row carries a receipt. This module asks whether each receipt points at
 * something real, against explicit roots (the checkout a review is about), so
 * only `gstack-plan-reality check` reads the filesystem.
 *
 *   resolved      the file exists inside a root and the cited lines exist,
 *                 or the sha names a commit in a root's repository
 *   unresolved    a relative path into a root's tree that is missing, a
 *                 directory, a dangling link, line 0, a reversed range or a
 *                 line past the end: the claim is false here
 *   unverifiable  this checkout cannot judge it (outside every root, a bare
 *                 name no root has, a symlink leaving the root, a file over
 *                 the size cap, a sha a shallow clone lacks): reported only
 *
 * Reads are bounded: only regular files whose real path stays inside the
 * root, at most `maxBytes`, and no file content ever appears in a result.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RECEIPT_RE, type RealityLine } from './plan-reality';

export type ReceiptOutcome = 'resolved' | 'unresolved' | 'unverifiable';
export interface ReceiptResult { row: string; receipt: string; outcome: ReceiptOutcome; reason: string }
export interface ResolveOptions { roots: readonly string[]; maxBytes?: number }

const MAX_BYTES = 8 * 1024 * 1024;
const PATH_TOKEN_RE = /^(?<file>.+):(?<from>\d+)(?:-(?<to>\d+))?$/;

/** Every receipt token on a row; a `host:port` (no `/` and no `.` before the colon) is not a file receipt. */
export function receiptTokens(rest: string): string[] {
  const re = new RegExp(RECEIPT_RE.source, 'g');
  return [...rest.matchAll(re)].map(m => m[0].replace(/^`|`$/g, '').replace(/^commit /, ''))
    .filter(t => { const m = PATH_TOKEN_RE.exec(t); return !m || /[./]/.test(m.groups!.file!); });
}

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function lineCount(file: string, size: number): number {
  if (size === 0) return 0;
  const buf = fs.readFileSync(file);
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

function resolvePath(token: string, roots: readonly string[], maxBytes: number): { outcome: ReceiptOutcome; reason: string } {
  const m = PATH_TOKEN_RE.exec(token)!;
  const file = m.groups!.file!.replace(/^\.\//, '');
  const first = Number(m.groups!.from), last = Number(m.groups!.to ?? m.groups!.from);
  if (first < 1 || last < first) return { outcome: 'unresolved', reason: `line range ${first}-${last} is not a range of lines` };
  if (!roots.length) return { outcome: 'unverifiable', reason: 'no root to resolve against (not in a git checkout; pass --root)' };
  if (/^[~$]/.test(file)) return { outcome: 'unverifiable', reason: 'path outside every root' };
  let intoTree = false;
  for (const root of roots) {
    const candidate = path.resolve(root, file);
    if (!inside(root, candidate)) continue;
    const top = file.includes('/') ? path.join(root, file.split('/')[0]!) : candidate;
    if (path.isAbsolute(file) || fs.existsSync(top)) intoTree = true;
    let real: string;
    try {
      if (!fs.lstatSync(candidate, { throwIfNoEntry: false })) continue;
      real = fs.realpathSync(candidate);
    } catch (e) {
      return { outcome: 'unresolved', reason: `cannot open (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (!inside(fs.realpathSync(root), real)) return { outcome: 'unverifiable', reason: 'symlink leaves the root' };
    const target = fs.statSync(real);
    if (!target.isFile()) return { outcome: 'unresolved', reason: 'not a regular file' };
    if (target.size > maxBytes) return { outcome: 'unverifiable', reason: `file over ${maxBytes} bytes` };
    const lines = lineCount(real, target.size);
    if (last > lines) return { outcome: 'unresolved', reason: `line ${last} is past the end (${lines} lines)` };
    return { outcome: 'resolved', reason: path.relative(root, candidate) };
  }
  return intoTree ? { outcome: 'unresolved', reason: 'no such file' } : { outcome: 'unverifiable', reason: 'path outside every root' };
}

/** One `git cat-file --batch-check` per root for every sha token; a sha is resolved when any root's repository has the commit. */
function resolveShas(shas: string[], roots: readonly string[]): Map<string, { outcome: ReceiptOutcome; reason: string }> {
  const out = new Map<string, { outcome: ReceiptOutcome; reason: string }>();
  for (const sha of shas) out.set(sha, { outcome: 'unverifiable', reason: 'no root repository has this commit (shallow or another repository)' });
  if (!shas.length) return out;
  for (const root of roots) {
    const r = spawnSync('git', ['cat-file', '--batch-check'], { cwd: root, input: shas.map(s => `${s}^{commit}`).join('\n') + '\n', encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) continue;
    r.stdout.split('\n').filter(Boolean).forEach((line, i) => {
      if (!/ missing$| ambiguous$/.test(line) && shas[i]) out.set(shas[i]!, { outcome: 'resolved', reason: 'commit' });
    });
  }
  return out;
}

export function resolveReceipts(lines: readonly RealityLine[], o: ResolveOptions): ReceiptResult[] {
  const maxBytes = o.maxBytes ?? MAX_BYTES;
  const roots = o.roots.map(r => path.resolve(r));
  const tokens = lines.filter(l => l.status !== 'n/a').flatMap(l => receiptTokens(l.rest).map(receipt => ({ row: l.id, receipt })));
  const shas = [...new Set(tokens.filter(t => !PATH_TOKEN_RE.test(t.receipt)).map(t => t.receipt))];
  const bySha = resolveShas(shas, roots);
  return tokens.map(t => ({ ...t, ...(PATH_TOKEN_RE.test(t.receipt) ? resolvePath(t.receipt, roots, maxBytes) : bySha.get(t.receipt)!) }));
}

/** The git top level of `cwd`, or none outside a checkout. */
export function defaultRoots(cwd: string): string[] {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() ? [r.stdout.trim()] : [];
}
