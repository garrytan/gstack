import * as fs from 'node:fs';
import * as path from 'node:path';
import { collect, sampleLogs } from './collect';
import { AuditError, Budget, assertRepo, fixtureClient, ghClient, recordingClient, type ApiClient } from './github';
import { lessons } from './lessons';
import { measure } from './measure';
import { buildReport, renderCompare, renderMarkdown, SCHEMA, type AuditReport } from './report';
import { CI_SHAPING, changedFiles, staticChecks, timingCheck } from './ship-check';
import { originSlug, readStatic } from './static';
import { GATE_OUTCOMES } from '../gate-outcomes';
import { applyIssue, findIssue, ghWrite, planIssue } from './publish';
import { readConfigKey, resolveStateRoot } from '../state-root';

export const EXIT = { ok: 0, usage: 1, unavailable: 3, partial: 4, internal: 5 } as const;

export const HELP = `gstack-ci-audit: measure a repo's GitHub Actions CI against the nine CI-speed lessons.

Usage:
  gstack-ci-audit run [--repo owner/name] [--since-days 7] [--runs-per-workflow 30] [--workflows a.yml,b.yml]
                      [--since <iso>] [--until <iso>]
                      [--max-calls 800] [--timeout 300] [--logs N] [--ubicloud-family premium|standard]
                      [--prices file.json] [--root dir] [--json] [--out file] [--fixture dir] [--record dir]
  gstack-ci-audit ship-check --base <branch> [--pr <n>] [--repo owner/name] [--root dir] [--json] [--fixture dir]
  gstack-ci-audit compare --before <report.json> [--since <iso>] [run options]
  gstack-ci-audit publish --exit <code> [--report report.json] [--error-file f] [--run-url u] [--repo owner/name] [--dry-run]

run      Reads the window's runs list, job details for the newest N runs of each workflow, and the caches
         list; reads config from --root (default: cwd) when its origin is the repo. Markdown on stdout;
         --json prints the gstack-ci-audit/v1 report; --out also saves the JSON for compare.
ship-check  Few-second report-only check for /ship: static lesson checks on CI files the diff touches,
         and with --pr the PR's previous settled push against comparable all-green PR heads.
         gstack-config: ci_audit_ship off|check (default check), ci_audit_slower_min_s (default 120).
compare  Re-measures runs created after --since (default: the before report's end) and prints both.
publish  Keeps one open "Weekly CI audit" issue for the scheduled audit: a complete run creates or
         replaces it (or closes it when nothing is left to fix); a partial or failed run comments and
         keeps the last complete findings. --dry-run prints the action without writing.

Exit codes: 0 complete, 1 usage, 3 unavailable, 4 partial (labeled), 5 internal error (trace path on stderr).
Examples:
  gstack-ci-audit run --out ci-before.json
  gstack-ci-audit compare --before ci-before.json
  gstack-ci-audit ship-check --base main --pr 3700
Docs: docs/ci-audit.md`;

type Flags = Record<string, string | true>;
const VALUE_FLAGS = new Set(['repo', 'since-days', 'runs-per-workflow', 'workflows', 'max-calls', 'timeout', 'logs', 'ubicloud-family', 'prices', 'root', 'out', 'fixture', 'record', 'base', 'pr', 'before', 'since', 'until', 'exit', 'report', 'error-file', 'run-url']);
const BOOL_FLAGS = new Set(['json', 'help', 'dry-run']);

class UsageError extends Error {}

export function parseFlags(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd = '', ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new UsageError(`unexpected argument: ${a}`);
    const [, name, inline] = m;
    if (BOOL_FLAGS.has(name!)) { flags[name!] = true; continue; }
    if (!VALUE_FLAGS.has(name!)) throw new UsageError(`unknown flag --${name}`);
    const v = inline ?? rest[++i];
    if (v == null || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    flags[name!] = v;
  }
  return { cmd, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
function num(f: Flags, k: string, d: number, max = Infinity): number {
  const v = str(f, k);
  if (v == null) return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new UsageError(`--${k} must be a positive number${max < Infinity ? ` up to ${max}` : ''}`);
  return n;
}

function client(f: Flags, budget: Budget): ApiClient {
  const fx = str(f, 'fixture');
  const base = fx ? fixtureClient(fx, budget) : ghClient(budget);
  const rec = str(f, 'record');
  return rec ? recordingClient(base, rec) : base;
}

function repoFor(f: Flags, root: string): string {
  const r = str(f, 'repo') ?? originSlug(root);
  if (!r) throw new UsageError('no --repo and the current directory has no GitHub origin');
  return assertRepo(r);
}

export function errorLines(e: AuditError, used: number, max: number): string[] {
  const row = GATE_OUTCOMES[e.code];
  return [`CI_AUDIT: unavailable ${e.detail} (${e.code})`, `fix: ${row.fix} (docs/troubleshooting.md#${row.anchor})`, `retry: ${e.retry}`, `used: ${used}/${max} calls`];
}

async function runAudit(f: Flags, out: (s: string) => void): Promise<{ report: AuditReport; code: number }> {
  const root = path.resolve(str(f, 'root') ?? process.cwd());
  const repo = repoFor(f, root);
  const budget = new Budget(num(f, 'max-calls', 800, 5000), num(f, 'timeout', 300, 3600) * 1000);
  const api = client(f, budget);
  const since = str(f, 'since');
  const until = str(f, 'until');
  if ([since, until].some(v => v != null && !Number.isFinite(Date.parse(v)))) throw new UsageError('--since and --until take an ISO time like 2026-10-31T03:00:00Z');
  const end = until ? Date.parse(until) : Date.now();
  const sinceDays = since ? Math.max(1 / 24, (end - Date.parse(since)) / 86400_000) : num(f, 'since-days', 7, 90);
  const data = await collect(api, budget, { repo, sinceDays, until: until && new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z'), runsPerWorkflow: num(f, 'runs-per-workflow', 30, 300), workflows: str(f, 'workflows')?.split(',') });
  if (!data.runs.length) throw new AuditError('ci_audit_no_runs', `no GitHub Actions runs for ${repo} since ${data.since}`);
  const logsN = num(f, 'logs', 0, 20);
  const logs = logsN ? await sampleLogs(api, data, logsN) : undefined;
  const fam = (str(f, 'ubicloud-family') as 'premium' | 'standard' | undefined) ?? logs?.ubicloudFamily;
  const pricesFile = str(f, 'prices');
  const prices = pricesFile ? JSON.parse(fs.readFileSync(pricesFile, 'utf8')) : undefined;
  const st = originSlug(root)?.toLowerCase() === repo.toLowerCase() ? readStatic(root, data.defaultBranch) : null;
  const m = measure(data);
  const ls = lessons({ data, m, st, logs: logs && { ...logs, ubicloudFamily: fam }, prices });
  const report = buildReport({ ...data, calls: budget.used }, m, ls, st, prices, fam);
  return { report, code: report.partial.length ? EXIT.partial : EXIT.ok };
}

async function shipCheck(f: Flags, out: (s: string) => void): Promise<number> {
  const mode = (readConfigKey('ci_audit_ship') ?? 'check').trim();
  if (mode === 'off') { out('CI_AUDIT: off (gstack-config ci_audit_ship=off)'); return EXIT.ok; }
  if (mode !== 'check') throw new UsageError(`gstack-config ci_audit_ship must be off or check, not ${mode}`);
  const base = str(f, 'base');
  if (!base) throw new UsageError('ship-check needs --base <branch>');
  const root = path.resolve(str(f, 'root') ?? process.cwd());
  const repo = repoFor(f, root);
  const minS = Number(readConfigKey('ci_audit_slower_min_s') ?? 120) || 120;
  const budget = new Budget(10, 10_000);
  const touched = (changedFiles(root, base) ?? []).filter(x => CI_SHAPING.test(x));
  const st = touched.length ? readStatic(root, base) : null;
  const statics = st ? staticChecks(st, touched, false) : [];
  const lines: string[] = [];
  const pr = str(f, 'pr');
  let timing = 'CI_AUDIT: static only (no PR number)';
  let code: number = EXIT.ok;
  if (pr) {
    try { timing = (await timingCheck(client(f, budget), repo, num(f, 'pr', 0), minS)).line; }
    catch (e) { if (!(e instanceof AuditError)) throw e; timing = errorLines(e, budget.used, budget.maxCalls)[0]!; code = EXIT.unavailable; }
  }
  lines.push(timing);
  lines.push(touched.length ? `CI_AUDIT_FILES: ${touched.length} CI-shaping file(s) changed: ${touched.slice(0, 5).join(', ')}` : 'CI_AUDIT_FILES: none changed');
  for (const s of statics.slice(0, 5)) lines.push(`CI_AUDIT_LESSON: ${s}`);
  if (touched.some(x => x.startsWith('.github/workflows/'))) lines.push(`CI_AUDIT_NEXT: after this PR's CI runs, gstack-ci-audit compare --before <a run --out report from before the change>`);
  lines.push(`CI_AUDIT_USED: ${budget.used} calls`);
  for (const l of f.json ? [JSON.stringify({ schema: SCHEMA, ok: code === EXIT.ok, lines })] : lines) out(l);
  return code;
}

export async function main(argv: string[], out: (s: string) => void = s => process.stdout.write(s + '\n'), err: (s: string) => void = s => process.stderr.write(s + '\n')): Promise<number> {
  let parsed: { cmd: string; flags: Flags };
  try { parsed = parseFlags(argv); } catch (e) { err(`gstack-ci-audit: ${(e as Error).message}\n\n${HELP}`); return EXIT.usage; }
  const { cmd, flags } = parsed;
  if (flags.help || cmd === '--help' || cmd === 'help' || !cmd) { out(HELP); return cmd ? EXIT.ok : EXIT.usage; }
  const json = Boolean(flags.json);
  try {
    if (cmd === 'ship-check') return await shipCheck(flags, out);
    if (cmd === 'publish') return await publishIssue(flags, out);
    if (cmd === 'run' || cmd === 'compare') {
      const before = cmd === 'compare' ? readReport(str(flags, 'before')) : null;
      if (before && !str(flags, 'since')) flags.since = before.window.until;
      const { report, code } = await runAudit(flags, out);
      const outFile = str(flags, 'out');
      if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n');
      if (before) out(json ? JSON.stringify({ schema: SCHEMA, ok: true, before, after: report }) : renderCompare(before, report));
      else out(json ? JSON.stringify(report, null, 1) : renderMarkdown(report));
      if (code === EXIT.partial) err(`CI_AUDIT: partial ${report.partial.join('; ')}`);
      return code;
    }
    err(`gstack-ci-audit: unknown command ${cmd}\n\n${HELP}`);
    return EXIT.usage;
  } catch (e) {
    if (e instanceof UsageError) { err(`gstack-ci-audit: ${e.message}`); return EXIT.usage; }
    if (e instanceof AuditError) {
      const lines = errorLines(e, 0, 0).slice(0, 3);
      if (json) out(JSON.stringify({ schema: SCHEMA, ok: false, error: { code: e.code, reason: e.detail, fix: lines[1]!.slice(5), retry: e.retry } }));
      for (const l of lines) err(l);
      return EXIT.unavailable;
    }
    const dir = path.join(resolveStateRoot(), 'ci-audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const trace = path.join(dir, `trace-${Date.now()}.txt`);
    fs.writeFileSync(trace, String((e as Error)?.stack ?? e), { mode: 0o600 });
    err(`CI_AUDIT: unavailable internal error (ci_audit_internal)\nfix: report it with the trace file\ntrace: ${trace}`);
    if (json) out(JSON.stringify({ schema: SCHEMA, ok: false, error: { code: 'ci_audit_internal', reason: String((e as Error)?.message ?? e), trace } }));
    return EXIT.internal;
  }
}

async function publishIssue(f: Flags, out: (s: string) => void): Promise<number> {
  const exit = Number(str(f, 'exit'));
  if (!Number.isInteger(exit) || exit < 0) throw new UsageError('publish needs --exit <the run command\'s exit code>');
  const repo = repoFor(f, path.resolve(str(f, 'root') ?? process.cwd()));
  const file = str(f, 'report');
  const report = file && fs.existsSync(file) && fs.statSync(file).size ? readReport(file) : null;
  const errFile = str(f, 'error-file');
  const error = errFile && fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').split('\n').find(l => l.startsWith('CI_AUDIT:')) ?? fs.readFileSync(errFile, 'utf8').trim() : undefined;
  const budget = new Budget(5, 60_000);
  const existing = await findIssue(client(f, budget), repo);
  const action = planIssue({ exit, report, error, runUrl: str(f, 'run-url') }, existing);
  if (f['dry-run']) { out(JSON.stringify({ existing: existing?.number ?? null, ...action })); return EXIT.ok; }
  out(await applyIssue(ghWrite(budget), repo, action, existing));
  return EXIT.ok;
}

function readReport(file?: string): AuditReport {
  if (!file) throw new UsageError('compare needs --before <report.json>');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r?.schema !== SCHEMA) throw new UsageError(`${file} is not a ${SCHEMA} report (schema: ${r?.schema ?? 'none'})`);
  return r;
}
