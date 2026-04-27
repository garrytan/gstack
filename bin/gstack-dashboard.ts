#!/usr/bin/env bun
/**
 * gstack-dashboard — terminal viewer for orchestrator + project timelines.
 *
 * Reads ~/.gstack/builders/$B/companies/$C/{timeline.jsonl, costs.jsonl,
 * runs/$RUN_ID/}. Falls back to ~/.gstack/projects/$SLUG/timeline.jsonl
 * for `tail` when no orchestrator filter is given (back-compat with the
 * existing user-typed flow).
 *
 * Pure terminal output. No web server, no JSON output mode (callers that
 * need structured data read JSONL directly). Web command center is Phase B2.
 *
 * Subcommands:
 *   tail       [--builder <s>] [--company <s>] [-n <lines>]
 *   builders
 *   companies  [--builder <s>]
 *   runs       --company <s> [--builder <s>]
 *   show       [<run_id>] --company <s> [--builder <s>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Path resolvers
// ---------------------------------------------------------------------------

const gstackHome = (): string =>
  process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack');
const buildersRoot = (): string => path.join(gstackHome(), 'builders');
const projectsRoot = (): string => path.join(gstackHome(), 'projects');
const builderDir = (b: string): string => path.join(buildersRoot(), b);
const companyDir = (b: string, c: string): string =>
  path.join(builderDir(b), 'companies', c);
const runsDir = (b: string, c: string): string =>
  path.join(companyDir(b, c), 'runs');
const timelinePath = (b: string, c: string): string =>
  path.join(companyDir(b, c), 'timeline.jsonl');
const costsPath = (b: string, c: string): string =>
  path.join(companyDir(b, c), 'costs.jsonl');

function listDirs(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function validateSlug(name: string, value: string): void {
  if (!SLUG_RE.test(value)) {
    die(`invalid ${name}: ${JSON.stringify(value)} (must be kebab-case [a-z0-9-])`);
  }
}

// ---------------------------------------------------------------------------
// Timeline + costs IO
// ---------------------------------------------------------------------------

interface TimelineEvent {
  ts?: string;
  skill?: string;
  event?: string;
  run_id?: string;
  outcome?: string;
  status?: string;
  [k: string]: unknown;
}

function readJsonl(p: string): TimelineEvent[] {
  if (!fs.existsSync(p)) return [];
  const out: TimelineEvent[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line — don't crash a viewer over bad data
    }
  }
  return out;
}

function lastActivity(b: string, c: string): string {
  const p = timelinePath(b, c);
  if (!fs.existsSync(p)) return '—';
  return fmtTs(fs.statSync(p).mtime.toISOString());
}

function totalCostUsd(b: string, c: string): number {
  let sum = 0;
  for (const e of readJsonl(costsPath(b, c))) {
    const v = e.cost_usd;
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

interface CompanyRow {
  builder: string;
  company: string;
  runs: number;
  lastActivity: string;
  costUsd: number;
}

function listCompaniesForBuilder(b: string): CompanyRow[] {
  return listDirs(path.join(builderDir(b), 'companies')).map((c) => ({
    builder: b,
    company: c,
    runs: listDirs(runsDir(b, c)).filter((d) => d !== 'archive').length,
    lastActivity: lastActivity(b, c),
    costUsd: totalCostUsd(b, c),
  }));
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtTs(iso: string | undefined): string {
  if (!iso) return '—';
  return iso.toString().replace('T', ' ').slice(0, 19);
}

function fmtCost(usd: number): string {
  return usd === 0 ? '—' : `$${usd.toFixed(4)}`;
}

function fmtTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? '').length)),
  );
  return rows
    .map((r) =>
      r.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd(),
    )
    .join('\n');
}

function fmtEvent(e: TimelineEvent): string {
  return [
    fmtTs(e.ts).padEnd(19),
    (e.skill ?? '?').padEnd(15),
    (e.event ?? '?').padEnd(12),
    (e.outcome ?? e.status ?? '').toString(),
  ].join('  ').trimEnd();
}

// ---------------------------------------------------------------------------
// Builder/company resolution
// ---------------------------------------------------------------------------

function resolveBuilderForCompany(company: string, hint?: string): string {
  if (hint) {
    validateSlug('builder', hint);
    if (!fs.existsSync(companyDir(hint, company))) {
      die(`company ${JSON.stringify(company)} not found under builder ${JSON.stringify(hint)}`);
    }
    return hint;
  }
  const matches = listDirs(buildersRoot()).filter((b) =>
    fs.existsSync(companyDir(b, company)),
  );
  if (matches.length === 0) {
    die(`company ${JSON.stringify(company)} not found under any builder`);
  }
  if (matches.length > 1) {
    die(`company ${JSON.stringify(company)} exists under multiple builders (${matches.join(', ')}); pass --builder`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function cmdBuilders(): void {
  const builders = listDirs(buildersRoot());
  if (builders.length === 0) {
    process.stderr.write('No builders yet. Run /build to create one.\n');
    return;
  }
  const rows: string[][] = [['BUILDER', 'COMPANIES', 'LAST ACTIVITY', 'TOTAL COST']];
  for (const b of builders) {
    const cos = listCompaniesForBuilder(b);
    const last = cos.map((c) => c.lastActivity).filter((s) => s !== '—').sort().pop() ?? '—';
    const cost = cos.reduce((s, c) => s + c.costUsd, 0);
    rows.push([b, String(cos.length), last, fmtCost(cost)]);
  }
  process.stdout.write(fmtTable(rows) + '\n');
}

function cmdCompanies(flags: Record<string, string>): void {
  const builderFilter = flags['builder'];
  if (builderFilter) validateSlug('builder', builderFilter);
  const builders = builderFilter ? [builderFilter] : listDirs(buildersRoot());
  const rows: CompanyRow[] = [];
  for (const b of builders) for (const r of listCompaniesForBuilder(b)) rows.push(r);
  if (rows.length === 0) {
    process.stderr.write(builderFilter ? `No companies for builder ${builderFilter}.\n` : 'No companies yet.\n');
    return;
  }
  const out: string[][] = [['BUILDER', 'COMPANY', 'RUNS', 'LAST ACTIVITY', 'COST']];
  for (const r of rows) {
    out.push([r.builder, r.company, String(r.runs), r.lastActivity, fmtCost(r.costUsd)]);
  }
  process.stdout.write(fmtTable(out) + '\n');
}

function cmdRuns(flags: Record<string, string>): void {
  if (!flags['company']) die('runs requires --company <slug>');
  validateSlug('company', flags['company']);
  const builder = resolveBuilderForCompany(flags['company'], flags['builder']);
  const company = flags['company'];
  const runIds = listDirs(runsDir(builder, company)).filter((d) => d !== 'archive');
  if (runIds.length === 0) {
    process.stderr.write(`No runs for ${builder}/${company} yet.\n`);
    return;
  }
  const events = readJsonl(timelinePath(builder, company));
  const out: string[][] = [['RUN_ID', 'STARTED', 'STATUS', 'STAGES']];
  // Sort runs by first event ts (ascending), so most recent is at bottom.
  const ranked = runIds
    .map((r) => {
      const re = events.filter((e) => e.run_id === r);
      return { id: r, first: re[0], last: re[re.length - 1], stages: new Set(re.map((e) => e.skill).filter(Boolean) as string[]) };
    })
    .sort((a, b) => (a.first?.ts ?? '').localeCompare(b.first?.ts ?? ''));
  for (const r of ranked) {
    const status = (r.last?.outcome ?? r.last?.status ?? '—') as string;
    out.push([r.id, fmtTs(r.first?.ts), status, [...r.stages].join(',') || '—']);
  }
  process.stdout.write(fmtTable(out) + '\n');
}

function cmdShow(positional: string[], flags: Record<string, string>): void {
  if (positional.length > 1) die('show takes at most one positional argument: <run_id>');
  if (!flags['company']) die('show requires --company <slug>');
  validateSlug('company', flags['company']);
  const builder = resolveBuilderForCompany(flags['company'], flags['builder']);
  const company = flags['company'];
  const runId = positional[0];
  let events = readJsonl(timelinePath(builder, company));
  if (runId) events = events.filter((e) => e.run_id === runId);
  if (events.length === 0) {
    die(runId ? `no events for run ${runId} in ${builder}/${company}` : `no events for ${builder}/${company}`);
  }
  for (const e of events) process.stdout.write(fmtEvent(e) + '\n');
}

function cmdTail(flags: Record<string, string>): void {
  const n = flags['n'] ? parseInt(flags['n'], 10) : 20;
  if (Number.isNaN(n) || n < 1) die(`-n must be a positive integer, got ${JSON.stringify(flags['n'])}`);
  if (flags['builder'] && !flags['company']) die('--builder requires --company');

  let p: string;
  if (flags['company']) {
    validateSlug('company', flags['company']);
    const builder = resolveBuilderForCompany(flags['company'], flags['builder']);
    p = timelinePath(builder, flags['company']);
  } else {
    // Default: most-recently-touched project timeline (back-compat with the
    // original user-typed flow at projects/$SLUG/timeline.jsonl).
    const projDirs = listDirs(projectsRoot())
      .map((d) => ({ d, p: path.join(projectsRoot(), d, 'timeline.jsonl') }))
      .filter((x) => fs.existsSync(x.p))
      .sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
    if (projDirs.length === 0) {
      process.stderr.write('No timelines found.\n');
      return;
    }
    p = projDirs[0].p;
  }
  if (!fs.existsSync(p)) {
    process.stderr.write(`No events yet at ${p}.\n`);
    return;
  }
  const lines = fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()).slice(-n);
  for (const l of lines) {
    try {
      process.stdout.write(fmtEvent(JSON.parse(l)) + '\n');
    } catch {
      process.stdout.write(l + '\n');
    }
  }
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(`gstack-dashboard: ${msg}\n`);
  process.exit(1);
}
function usage(): never {
  process.stderr.write([
    'usage:',
    '  gstack-dashboard tail      [--builder <s>] [--company <s>] [-n <lines>]',
    '  gstack-dashboard builders',
    '  gstack-dashboard companies [--builder <s>]',
    '  gstack-dashboard runs      --company <s> [--builder <s>]',
    '  gstack-dashboard show      [<run_id>] --company <s> [--builder <s>]',
    '',
  ].join('\n'));
  process.exit(2);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('-')) die(`flag --${key} needs a value`);
      flags[key] = val;
      i++;
    } else if (a === '-n') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('-')) die(`-n needs a value`);
      flags['n'] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const sub = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));
  switch (sub) {
    case 'tail':       return cmdTail(flags);
    case 'builders':   return cmdBuilders();
    case 'companies':  return cmdCompanies(flags);
    case 'runs':       return cmdRuns(flags);
    case 'show':       return cmdShow(positional, flags);
    case '-h':
    case '--help':
    case 'help':       usage();
    default:           die(`unknown subcommand: ${sub}`);
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));
