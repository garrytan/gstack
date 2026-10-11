/**
 * pregate check `secrets` (tier 1, preflight, never downgradable): the
 * branch's added lines (merge-base → working tree, untracked files included)
 * go through bin/gstack-redact. Exit 0 is clean; 2 (MEDIUM) and 3 (HIGH)
 * fail; anything else is incomplete. Runs regardless of lint tools.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import type { CheckDef, CheckResult, PregateContext } from '../types';

const BIN_DIR = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), '..', '..', '..', 'bin');

/** `+` lines of the diff from the merge-base to the working tree, plus every line of untracked files. */
export function addedLines(ctx: PregateContext): string {
  const diff = spawnSync('git', ['diff', '--no-color', '--unified=0', '--diff-filter=ACMR', ctx.mergeBase, '--'], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: ctx.env });
  const lines: string[] = [];
  for (const line of (diff.stdout ?? '').split('\n')) if (line.startsWith('+') && !line.startsWith('+++')) lines.push(line.slice(1));
  for (const t of ctx.touched) {
    if (!t.uncommitted || t.status === 'D') continue;
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', t.path], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 15_000 }).status === 0;
    if (tracked) continue;
    try { const st = fs.statSync(path.join(ctx.repoRoot, t.path)); if (st.isFile() && st.size <= 4 * 1024 * 1024) lines.push(...fs.readFileSync(path.join(ctx.repoRoot, t.path), 'utf8').split('\n')); } catch { /* unreadable: skipped */ }
  }
  return lines.join('\n');
}

function run(ctx: PregateContext): CheckResult {
  const text = addedLines(ctx);
  const inputs = baseInputs(ctx, { added_lines: sha256(text) });
  if (!text.trim()) return { id: 'secrets', stage: 'preflight', status: 'pass', detail: 'no added lines', inputs };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-secrets-'));
  const file = path.join(tmp, 'added.txt');
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
    const r = spawnSync(path.join(BIN_DIR, 'gstack-redact'), ['--from-file', file, '--json', '--max-bytes', String(64 * 1024 * 1024)], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: Math.min(ctx.timeoutMs, 300_000), maxBuffer: 64 * 1024 * 1024, env: ctx.env });
    if (r.error || r.status === null) return { id: 'secrets', stage: 'preflight', status: 'incomplete', inputs, code: 'PREGATE_INCOMPLETE', detail: `gstack-redact did not finish (${r.error?.message ?? 'killed'})`, fix: 'rerun; raise --timeout for very large diffs' };
    let findings: Array<{ id?: string; description?: string; severity?: string; category?: string; line?: number }> = [];
    try { findings = JSON.parse(r.stdout).findings ?? []; } catch { /* non-JSON output below */ }
    const render = (f: typeof findings[number]) => `${f.severity} ${f.id ?? 'finding'} [${f.category ?? '?'}]: ${f.description ?? ''}${f.line ? ` (added line ${f.line})` : ''}`;
    // HIGH and any MEDIUM credential fail; a MEDIUM hygiene/internal/pii/legal
    // hit in code (a `.local` property reads as a hostname) is listed as warn:
    // there is no user to answer gstack-redact's per-finding question here.
    const blocking = findings.filter(f => f.severity === 'HIGH' || (f.severity === 'MEDIUM' && f.category === 'secret'));
    const advisory = findings.filter(f => f.severity === 'MEDIUM' && f.category !== 'secret');
    if (r.status === 0) return { id: 'secrets', stage: 'preflight', status: 'pass', inputs, detail: `${text.split('\n').length} added lines clean${findings.length ? ` (${findings.length} WARN)` : ''}` };
    if (blocking.length) return { id: 'secrets', stage: 'preflight', status: 'fail', inputs, lines: [...blocking, ...advisory].map(render), code: 'PREGATE_SECRETS', detail: `${blocking.length} credential finding(s) in added lines (${blocking.map(f => f.id).join(', ')})`, fix: 'rotate and remove the credential from the added lines (history included); secrets cannot be downgraded' };
    if (r.status === 2) return { id: 'secrets', stage: 'preflight', status: 'warn', inputs, lines: advisory.map(render), code: 'PREGATE_SECRETS', detail: `${advisory.length} MEDIUM non-credential finding(s) in added lines (${[...new Set(advisory.map(f => f.id))].join(', ')})`, fix: 'read each listed line; gstack-post asks about the same findings when the PR body quotes them' };
    if (r.status === 3) return { id: 'secrets', stage: 'preflight', status: 'fail', inputs, lines: findings.map(render), code: 'PREGATE_SECRETS', detail: 'HIGH finding(s) in added lines', fix: 'rotate and remove the credential from the added lines (history included); secrets cannot be downgraded' };
    return { id: 'secrets', stage: 'preflight', status: 'incomplete', inputs, code: 'PREGATE_INCOMPLETE', detail: `gstack-redact exited ${r.status}: ${(r.stderr ?? '').trim().split('\n').pop() ?? ''}`, fix: 'fix the scanner invocation; an incomplete scan never passes' };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const secretsCheck: CheckDef = { id: 'secrets', stage: 'preflight', tier: 1, downgradable: false, needsRepoCommands: false, run };
