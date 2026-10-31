#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * oxlint ratchet: `bun run lint [--write-baseline [--oxlint-upgrade]]`.
 *
 * oxlint runs its correctness rules (.oxlintrc.json) over the repository.
 * Existing findings are held to a committed baseline, keyed the way
 * scripts/typecheck-test.ts keys test-code diagnostics: file + rule + message,
 * line-insensitive, mapped to how many times it occurs. Every failure prints a
 * stable code:
 *   LINT_RATCHET_NEW       a new finding, or one more of a known finding
 *   LINT_RATCHET_FIXED     a finding was fixed; --write-baseline locks it in
 *   LINT_BASELINE_INVALID  the baseline is unreadable, malformed or written
 *                          by another oxlint version; never rewritten on its own
 *   OXLINT_MISSING         oxlint is not installed at package.json's pin
 *   OXLINT_CRASH           oxlint exited without a report
 * --write-baseline only shrinks the allowance. The baseline header records
 * the oxlint version, which must equal package.json's exact pin; an oxlint
 * bump rewrites the baseline with --write-baseline --oxlint-upgrade in the
 * same change, so the growth shows up in review.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { compareDiagnostics, type DiagnosticCounts } from './typecheck-test';

export const BASELINE_FILE = 'scripts/lint-baseline.json';
export const CONFIG_FILE = '.oxlintrc.json';
const ROOT = path.resolve(import.meta.dir, '..');

export interface LintBaseline { oxlint: string; findings: DiagnosticCounts }
export interface Findings { counts: DiagnosticCounts; lines: Record<string, number[]> }
export interface OxlintRun { status: number | null; signal?: string | null; error?: Error; stdout: string; stderr: string }
export interface LintResult { exitCode: number; out: string[]; err: string[] }

class LintFailure extends Error {}

const sorted = (counts: DiagnosticCounts): DiagnosticCounts =>
  Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Parse `oxlint --format json` into identity -> count, plus the lines each identity sits on (for messages only). */
export function parseFindings(report: string): Findings {
  const diagnostics = (JSON.parse(report) as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error('report has no diagnostics array');
  const counts: DiagnosticCounts = {}, lines: Record<string, number[]> = {};
  for (const d of diagnostics as Array<{ filename: string; code?: string; message: string; labels?: Array<{ span?: { line?: number } }> }>) {
    const identity = `${d.filename.replaceAll('\\', '/')}\t${d.code ?? 'syntax-error'}\t${d.message.trim()}`;
    counts[identity] = (counts[identity] ?? 0) + 1;
    (lines[identity] ??= []).push(d.labels?.[0]?.span?.line ?? 0);
  }
  return { counts: sorted(counts), lines };
}

export function readBaseline(file: string): LintBaseline {
  const invalid = (why: string) => new LintFailure(`LINT_BASELINE_INVALID: ${BASELINE_FILE} ${why}. ` +
    `It is never rewritten automatically: restore it with \`git checkout origin/main -- ${BASELINE_FILE}\`, then rerun bun run lint.`);
  let parsed: { version?: unknown; oxlint?: unknown; findings?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw invalid(`is missing or unreadable (${(error as Error).message})`);
  }
  const { version, oxlint, findings } = parsed ?? {};
  if (version !== 1 || typeof oxlint !== 'string' || !findings || typeof findings !== 'object' || Array.isArray(findings) ||
      !Object.values(findings).every(n => Number.isSafeInteger(n) && (n as number) > 0)) {
    throw invalid('is malformed (expected { "version": 1, "oxlint": "<version>", "findings": { "<identity>": <count> } })');
  }
  return { oxlint, findings: findings as DiagnosticCounts };
}

function pinnedVersion(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
  const pin = pkg.devDependencies?.oxlint;
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new LintFailure(`LINT_BASELINE_INVALID: package.json must pin oxlint to an exact version in devDependencies (found ${pin ?? 'none'}), so ${BASELINE_FILE} can name the version it was written by.`);
  }
  return pin;
}

function installedVersion(root: string, pin: string): string {
  let installed: string | undefined;
  try {
    installed = (JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'oxlint', 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    throw new LintFailure('OXLINT_MISSING: oxlint is not installed (node_modules/oxlint). Run: bun install');
  }
  if (installed !== pin) throw new LintFailure(`OXLINT_MISSING: installed oxlint ${installed} does not match package.json's pin ${pin}. Run: bun install`);
  return installed;
}

/** The report goes to a file: under Bun, oxlint's CLI exits before a piped stdout drains (a 406 KB report arrived as 219 KB). */
export function runOxlint(root: string): OxlintRun {
  const bin = path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-oxlint-'));
  const report = path.join(dir, 'report.json');
  const fd = fs.openSync(report, 'w');
  try {
    const run = spawnSync(process.execPath, [...bunIsolationArgs(), bin, '-c', CONFIG_FILE, '--format', 'json'], {
      cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', fd, 'pipe'],
    });
    return { status: run.status, signal: run.signal, error: run.error, stdout: fs.readFileSync(report, 'utf8'), stderr: run.stderr ?? '' };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeBaseline(file: string, oxlint: string, findings: DiagnosticCounts): void {
  fs.writeFileSync(file, JSON.stringify({ version: 1, oxlint, findings: sorted(findings) }, null, 2) + '\n');
}

function describe(identity: string, lines: number[] = []): string {
  const [file, rule, message] = identity.split('\t');
  return `${file}${lines.length ? `:${lines.join(',')}` : ''} ${rule}: ${message}`;
}

export function runLint(options: { write?: boolean; upgrade?: boolean; root?: string; oxlint?: (root: string) => OxlintRun } = {}): LintResult {
  const root = options.root ?? ROOT, out: string[] = [], err: string[] = [];
  const done = (exitCode: number): LintResult => ({ exitCode, out, err });
  if (options.upgrade && !options.write) {
    err.push('lint ratchet: --oxlint-upgrade only goes with --write-baseline.');
    return done(2);
  }
  const baselinePath = path.join(root, BASELINE_FILE);
  let pin: string, installed: string, baseline: LintBaseline;
  try {
    pin = pinnedVersion(root);
    baseline = readBaseline(baselinePath);
    installed = installedVersion(root, pin);
  } catch (error) {
    if (!(error instanceof LintFailure)) throw error;
    err.push(error.message);
    return done(2);
  }
  if (options.upgrade && baseline.oxlint === pin) {
    err.push(`lint ratchet: --oxlint-upgrade rewrites a baseline written by another oxlint version, and ${BASELINE_FILE} already matches the pin ${pin}. Use --write-baseline, which only shrinks.`);
    return done(2);
  }
  if (!options.upgrade && baseline.oxlint !== pin) {
    err.push(`LINT_BASELINE_INVALID: ${BASELINE_FILE} was written by oxlint ${baseline.oxlint}, and package.json pins ${pin}. ` +
      'Rewrite it for the new pin in the same change: bun run lint --write-baseline --oxlint-upgrade');
    return done(2);
  }
  const run = (options.oxlint ?? runOxlint)(root);
  let current: Findings | undefined;
  try {
    if (!run.error && !run.signal && (run.status === 0 || run.status === 1)) current = parseFindings(run.stdout);
  } catch {
    current = undefined;
  }
  if (!current) {
    const why = run.error?.message ?? (run.signal ? `signal ${run.signal}` : `exit ${run.status}`);
    err.push(`OXLINT_CRASH: oxlint ${installed} (config ${CONFIG_FILE}) ended without a report (${why}).`);
    const tail = `${run.stderr}${run.stdout}`.trim().split(/\r?\n/).slice(-20).join('\n');
    if (tail) err.push(tail);
    return done(2);
  }
  const total = Object.values(current.counts).reduce((sum, n) => sum + n, 0);
  if (options.upgrade) {
    writeBaseline(baselinePath, pin, current.counts);
    out.push(`lint ratchet: rewrote ${BASELINE_FILE} for oxlint ${pin} (was ${baseline.oxlint}; ${total} findings, ${Object.keys(current.counts).length} identities). Review the growth in the diff.`);
    return done(0);
  }
  const { added, fixed } = compareDiagnostics(baseline.findings, current.counts);
  if (added.length) {
    err.push(`LINT_RATCHET_NEW: ${added.length} new or more frequent oxlint finding(s). Fix them; do not add them to the baseline.`);
    for (const d of added) err.push(`  + ${describe(d.identity, current.lines[d.identity])} (${d.baseline} → ${d.current})`);
    err.push(`Reproduce with: bunx oxlint -c ${CONFIG_FILE} ${[...new Set(added.map(d => d.identity.split('\t')[0]))].join(' ')}`);
    if (options.write) err.push('--write-baseline only shrinks the baseline; it never adds a finding.');
    return done(1);
  }
  if (options.write) {
    writeBaseline(baselinePath, pin, current.counts);
    out.push(`lint ratchet: wrote ${BASELINE_FILE} (${total} findings, ${Object.keys(current.counts).length} identities, ${fixed.length} lowered or removed).`);
    return done(0);
  }
  if (fixed.length) {
    err.push(`LINT_RATCHET_FIXED: ${fixed.length} finding(s) fixed. Lock the smaller allowance in with: bun run lint --write-baseline (it only shrinks)`);
    for (const d of fixed) err.push(`  - ${describe(d.identity)} (${d.baseline} → ${d.current})`);
    return done(1);
  }
  out.push(`lint ratchet: ${total} known findings, none new (oxlint ${pin}).`);
  return done(0);
}

if (import.meta.main) {
  const result = runLint({ write: process.argv.includes('--write-baseline'), upgrade: process.argv.includes('--oxlint-upgrade') });
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  process.exit(result.exitCode);
}
