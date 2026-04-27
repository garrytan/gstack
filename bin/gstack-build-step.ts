#!/usr/bin/env bun
/**
 * gstack-build-step — sentinel-file helper for the /build chain orchestrator.
 *
 * Glue between /build's SKILL.md.tmpl and the per-company artifact tree at
 * ~/.gstack/builders/$BUILDER_SLUG/companies/$COMPANY_SLUG/runs/$RUN_ID/.
 * Resolves paths, validates schema_version: 1 contracts on read, validates
 * required-field shape per stage on write. Composes inline with bash:
 *
 *   eval "$(gstack-build-step paths --run-id "$R" --builder-slug "$B" --company-slug "$C")"
 *   echo "$AUTOPLAN_JSON" | gstack-build-step write-sentinel autoplan --run-id "$R" --builder-slug "$B" --company-slug "$C"
 *   QA_RESULT=$(gstack-build-step read-sentinel qa --run-id "$R" --builder-slug "$B" --company-slug "$C")
 *
 * The helper does not LOG to gstack-timeline-log — that's the caller's job.
 * The helper does not SPAWN sub-agents — that's /build's job. It only owns
 * the sentinel-file contract.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Stage schema (lives here so /build, tests, and downstream skills agree)
// ---------------------------------------------------------------------------

export const STAGES = [
  'office-hours',
  'autoplan',
  'implement',
  'qa',
  'ship',
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Required fields per stage sentinel, beyond `schema_version` (always 1) and
 * `status` (always required across all stages). Keep in sync with the design
 * doc's Sentinel-file table at § A.2.
 */
export const STAGE_REQUIRED_FIELDS: Record<Stage, readonly string[]> = {
  'office-hours': ['design_doc_path', 'decisions_summary', 'context_for_next_stage'],
  'autoplan':     ['plan_path', 'ac_count', 'ac_summary', 'context_for_next_stage'],
  'implement':    ['commit_shas', 'last_ac_index', 'tests_passing', 'context_for_next_stage'],
  'qa':           ['report_path', 'bugs_found', 'bugs_fixed', 'ship_ready', 'context_for_next_stage'],
  'ship':         ['pr_url', 'version_tag', 'commit_sha'],
};

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Slug + run-id validation (security: prevent path traversal)
// ---------------------------------------------------------------------------

// Kebab-case, no leading/trailing dash, no dots/slashes/special chars.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// UUIDv4-shaped string, lowercase. /build mints these; reject anything else
// so a hostile seed prompt can't smuggle in path traversal via run-id.
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateSlug(name: string, value: string): void {
  if (!SLUG_RE.test(value)) {
    die(`invalid ${name}: ${JSON.stringify(value)} (must be kebab-case [a-z0-9-], no leading/trailing dash)`);
  }
}
function validateRunId(value: string): void {
  if (!RUN_ID_RE.test(value)) {
    die(`invalid run-id: ${JSON.stringify(value)} (must be lowercase UUIDv4)`);
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface RunPaths {
  gstackHome: string;
  builderDir: string;
  companyDir: string;
  runDir: string;
  decisions: string;
  costs: string;
  learnings: string;
  timeline: string;
  sentinels: Record<Stage, string>;
}

function resolvePaths(builderSlug: string, companySlug: string, runId: string): RunPaths {
  const gstackHome = process.env.GSTACK_HOME ?? path.join(os.homedir(), '.gstack');
  const builderDir = path.join(gstackHome, 'builders', builderSlug);
  const companyDir = path.join(builderDir, 'companies', companySlug);
  const runDir = path.join(companyDir, 'runs', runId);
  const sentinels = Object.fromEntries(
    STAGES.map((s) => [s, path.join(runDir, `${s}-result.json`)]),
  ) as Record<Stage, string>;
  return {
    gstackHome,
    builderDir,
    companyDir,
    runDir,
    decisions: path.join(companyDir, 'decisions.jsonl'),
    costs: path.join(companyDir, 'costs.jsonl'),
    learnings: path.join(companyDir, 'learnings.jsonl'),
    timeline: path.join(companyDir, 'timeline.jsonl'),
    sentinels,
  };
}

// ---------------------------------------------------------------------------
// Sentinel I/O
// ---------------------------------------------------------------------------

interface SentinelEnvelope {
  schema_version: 1;
  status: string;
  [k: string]: unknown;
}

function readSentinel(p: string, stage: Stage): SentinelEnvelope {
  if (!fs.existsSync(p)) die(`sentinel missing: ${p}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    die(`sentinel is not valid JSON at ${p}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`sentinel is not an object at ${p}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== SCHEMA_VERSION) {
    die(`sentinel at ${p} has schema_version=${JSON.stringify(obj.schema_version)}, refusing (expect ${SCHEMA_VERSION})`);
  }
  if (typeof obj.status !== 'string' || obj.status.length === 0) {
    die(`sentinel at ${p} missing required field: status`);
  }
  for (const f of STAGE_REQUIRED_FIELDS[stage]) {
    if (!(f in obj)) die(`sentinel at ${p} missing required field for stage ${stage}: ${f}`);
  }
  return obj as SentinelEnvelope;
}

function writeSentinel(p: string, stage: Stage, payload: Record<string, unknown>): void {
  // Auto-inject schema_version: 1 if caller omits. If caller supplied, must match.
  if (!('schema_version' in payload)) {
    payload = { schema_version: SCHEMA_VERSION, ...payload };
  } else if (payload.schema_version !== SCHEMA_VERSION) {
    die(`refusing to write schema_version=${JSON.stringify(payload.schema_version)} (expect ${SCHEMA_VERSION})`);
  }
  if (typeof payload.status !== 'string' || (payload.status as string).length === 0) {
    die(`payload missing required field: status (string)`);
  }
  for (const f of STAGE_REQUIRED_FIELDS[stage]) {
    if (!(f in payload)) die(`payload missing required field for stage ${stage}: ${f}`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload) + '\n');
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(`gstack-build-step: ${msg}\n`);
  process.exit(1);
}

function usage(): never {
  process.stderr.write([
    'usage:',
    '  gstack-build-step paths             --run-id <uuid> --builder-slug <s> --company-slug <s>',
    '  gstack-build-step read-sentinel  <stage> --run-id <uuid> --builder-slug <s> --company-slug <s>',
    '  gstack-build-step write-sentinel <stage> --run-id <uuid> --builder-slug <s> --company-slug <s>  (reads JSON from stdin)',
    '  gstack-build-step required-fields <stage>',
    '',
    `stages: ${STAGES.join(', ')}`,
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
      if (val === undefined || val.startsWith('--')) die(`flag --${key} needs a value`);
      flags[key] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function requireFlags(flags: Record<string, string>, names: string[]): void {
  for (const n of names) if (!flags[n]) die(`missing required flag: --${n}`);
}

function requireStage(name: string): Stage {
  if (!(STAGES as readonly string[]).includes(name)) {
    die(`unknown stage: ${name} (expected one of ${STAGES.join(', ')})`);
  }
  return name as Stage;
}

function shellQuote(s: string): string {
  // Single-quote with embedded-quote escape — safe for `eval` consumption.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function cmdPaths(flags: Record<string, string>): void {
  requireFlags(flags, ['run-id', 'builder-slug', 'company-slug']);
  validateSlug('builder-slug', flags['builder-slug']);
  validateSlug('company-slug', flags['company-slug']);
  validateRunId(flags['run-id']);
  const p = resolvePaths(flags['builder-slug'], flags['company-slug'], flags['run-id']);
  process.stdout.write([
    `BUILDER_DIR=${shellQuote(p.builderDir)}`,
    `COMPANY_DIR=${shellQuote(p.companyDir)}`,
    `RUN_DIR=${shellQuote(p.runDir)}`,
    `DECISIONS_LOG=${shellQuote(p.decisions)}`,
    `COSTS_LOG=${shellQuote(p.costs)}`,
    `LEARNINGS_LOG=${shellQuote(p.learnings)}`,
    `TIMELINE_LOG=${shellQuote(p.timeline)}`,
    `SENTINEL_OFFICE_HOURS=${shellQuote(p.sentinels['office-hours'])}`,
    `SENTINEL_AUTOPLAN=${shellQuote(p.sentinels['autoplan'])}`,
    `SENTINEL_IMPLEMENT=${shellQuote(p.sentinels['implement'])}`,
    `SENTINEL_QA=${shellQuote(p.sentinels['qa'])}`,
    `SENTINEL_SHIP=${shellQuote(p.sentinels['ship'])}`,
    '',
  ].join('\n'));
}

function cmdReadSentinel(positional: string[], flags: Record<string, string>): void {
  if (positional.length !== 1) die('read-sentinel needs exactly one positional argument: <stage>');
  const stage = requireStage(positional[0]);
  requireFlags(flags, ['run-id', 'builder-slug', 'company-slug']);
  validateSlug('builder-slug', flags['builder-slug']);
  validateSlug('company-slug', flags['company-slug']);
  validateRunId(flags['run-id']);
  const p = resolvePaths(flags['builder-slug'], flags['company-slug'], flags['run-id']);
  const sentinel = readSentinel(p.sentinels[stage], stage);
  process.stdout.write(JSON.stringify(sentinel) + '\n');
}

async function cmdWriteSentinel(positional: string[], flags: Record<string, string>): Promise<void> {
  if (positional.length !== 1) die('write-sentinel needs exactly one positional argument: <stage>');
  const stage = requireStage(positional[0]);
  requireFlags(flags, ['run-id', 'builder-slug', 'company-slug']);
  validateSlug('builder-slug', flags['builder-slug']);
  validateSlug('company-slug', flags['company-slug']);
  validateRunId(flags['run-id']);
  const raw = await readStdin();
  if (!raw.trim()) die('write-sentinel got empty stdin (expected JSON object)');
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch (e) { die(`stdin is not valid JSON: ${(e as Error).message}`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    die('stdin must be a JSON object');
  }
  const p = resolvePaths(flags['builder-slug'], flags['company-slug'], flags['run-id']);
  writeSentinel(p.sentinels[stage], stage, payload as Record<string, unknown>);
  process.stdout.write(`${p.sentinels[stage]}\n`);
}

function cmdRequiredFields(positional: string[]): void {
  if (positional.length !== 1) die('required-fields needs exactly one positional argument: <stage>');
  const stage = requireStage(positional[0]);
  // Always-required fields are listed first, then stage-specifics.
  process.stdout.write(['schema_version', 'status', ...STAGE_REQUIRED_FIELDS[stage]].join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const sub = argv[0];
  const rest = argv.slice(1);
  const { positional, flags } = parseFlags(rest);

  switch (sub) {
    case 'paths':            return cmdPaths(flags);
    case 'read-sentinel':    return cmdReadSentinel(positional, flags);
    case 'write-sentinel':   return cmdWriteSentinel(positional, flags);
    case 'required-fields':  return cmdRequiredFields(positional);
    case '-h':
    case '--help':
    case 'help':             usage();
    default:                 die(`unknown subcommand: ${sub}`);
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));
