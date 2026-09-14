/**
 * gbrain-supabase-provision — Supabase Management API wrapper for
 * /setup-gbrain path 2a (auto-provision). Engine module behind
 * bin/gstack-gbrain-supabase-provision (thin bun-shebang entry).
 *
 * Rewritten from bash to TypeScript so tests can drive it in-process
 * (injected fetch/env/sleep — decision D7: injection via options, never
 * process.env mutation before import) instead of paying a full Bun boot per
 * spawned test. CLI surface, stdout/stderr shapes, env-var handling, and
 * exit codes are byte-compatible with the bash version.
 *
 * Secrets discipline (D8, D10, D11):
 *   - SUPABASE_ACCESS_TOKEN is read from env; never accepted as argv.
 *   - DB_PASS (for `create` and `pooler-url`) is read from env; never argv.
 *   - The PAT travels only in the Authorization header; it is never
 *     receipted, logged, or echoed.
 *
 * Egress receipts (fail-closed): every API attempt writes a hash-chained
 * receipt via lib/egress-receipt BEFORE the send — sink "supabase-provision",
 * payload sha256 of the exact request body (bodyless: bytes 0, sha256 null).
 * A receipt failure REFUSES the send (nothing hits the network, exit 8),
 * mirroring `_receipted_curl closed` in bin/gstack-egress-lib.sh.
 *
 * Exit codes:
 *   0 — success
 *   2 — usage / invalid input
 *   3 — auth failure (401/403) — retry with fresh PAT
 *   4 — quota / billing (402) — user action needed
 *   5 — conflict (409) — duplicate name, user action needed
 *   6 — timeout (wait subcommand hit its deadline)
 *   7 — terminal failure state from Supabase (INIT_FAILED, REMOVED)
 *   8 — network / 5xx after retries (or egress receipt refusal)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  resolveEgressHome,
  sha256Hex,
  writeOutcome,
  writeReceipt,
} from './egress-receipt';

const PROG = 'gstack-gbrain-supabase-provision';
const API_VERSION = 'v1';
const DEFAULT_WAIT_TIMEOUT = 180;
const POLL_INTERVAL = 5;
const CURL_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/**
 * --help text. Byte-identical to the bash version's documented sections
 * (subcommands, secrets discipline, env, exit codes). The bash version's
 * `sed -n '2,80p'` additionally leaked 14 lines of its own implementation
 * (set +x, variable assignments) past the doc block — that accidental tail
 * is not reproduced.
 */
export const HELP_TEXT = `gstack-gbrain-supabase-provision — Supabase Management API wrapper for
/setup-gbrain path 2a (auto-provision).

Subcommands:
  list-orgs
    GET /v1/organizations. Output: {"orgs": [{"slug","name"}, ...]}

  create <name> <region> <org-slug>
    POST /v1/projects with {name, db_pass, organization_slug, region}.
    db_pass must be in the DB_PASS env var (never argv — D8 grep test
    enforces this). Output: {"ref","name","region","organization_slug","status"}.

    NOTE: does NOT send a \`plan\` field. Per verified Supabase Management
    API OpenAPI, the \`plan\` field is now deprecated at the project level
    — subscription tier is an org-level decision (D17 updated).

  wait <ref> [--timeout <seconds>]
    Poll GET /v1/projects/{ref} every 5s until status=ACTIVE_HEALTHY,
    or fail on terminal states (INIT_FAILED, REMOVED). Default timeout
    180s. Output on success: {"ref","status","elapsed_s"}.

  pooler-url <ref>
    GET /v1/projects/{ref}/config/database/pooler, construct the full
    Session Pooler URL using DB_PASS from env (the API response's
    connection_string is typically templated [PASSWORD] rather than the
    real value — we build from db_user/db_host/db_port/db_name instead).
    Output: {"ref","pooler_url"}.

  list-orphans [--name-prefix <str>]
    GET /v1/projects. Filter to projects whose name starts with --name-prefix
    (default "gbrain") AND whose ref does NOT match the one in the local
    active ~/.gbrain/config.json pooler URL. Those are the gbrain-shaped
    projects that aren't pointed at by a working local config — candidates
    for /setup-gbrain --cleanup-orphans.
    Output: {"active_ref","orphans":[{"ref","name","created_at","region"}, ...]}.

  delete-project <ref>
    DELETE /v1/projects/{ref}. Destructive, one-way — callers must
    double-confirm before invoking. This bin performs NO confirmation
    prompt; the skill's UI layer owns that responsibility.
    Output: {"deleted_ref"}.

Secrets discipline (D8, D10, D11):
  - SUPABASE_ACCESS_TOKEN is read from env; never accepted as argv.
  - DB_PASS (for \`create\` and \`pooler-url\`) is read from env; never argv.
  - Forbidden strings (enforced by skill-validation grep test):
      --insecure, -k (curl), NODE_TLS_REJECT_UNAUTHORIZED
  - \`set +x\` default — debug mode requires explicit opt-in around
    non-secret lines.

Env:
  SUPABASE_ACCESS_TOKEN — PAT for auth (required on all subcommands)
  DB_PASS               — database password (required for create + pooler-url)
  SUPABASE_API_BASE     — override the API host (tests point this at a
                          local mock server). Default: https://api.supabase.com

Exit codes:
  0 — success
  2 — usage / invalid input
  3 — auth failure (401/403) — retry with fresh PAT
  4 — quota / billing (402) — user action needed
  5 — conflict (409) — duplicate name, user action needed
  6 — timeout (wait subcommand hit its deadline)
  7 — terminal failure state from Supabase (INIT_FAILED, REMOVED)
  8 — network / 5xx after retries
`;

type Env = Record<string, string | undefined>;

export interface ProvisionOptions {
  /** Injected fetch (tests point it at a Bun.serve mock). Default: global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected environment. Default: process.env. Never read ambiently elsewhere. */
  env?: Env;
  /** stdout sink. Default: process.stdout.write. */
  stdout?: (chunk: string) => void;
  /** stderr sink. Default: process.stderr.write. */
  stderr?: (chunk: string) => void;
  /** Backoff/poll sleep. Tests inject a no-op to run retry paths instantly. */
  sleep?: (ms: number) => Promise<void>;
}

interface Ctx {
  base: string;
  host: string;
  env: Env;
  fetchImpl: typeof globalThis.fetch;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/** Control-flow carrier for the exit code — the module never calls process.exit. */
class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

function die(ctx: Ctx, msg: string, code = 2): never {
  ctx.stderr(`${PROG}: ${msg}\n`);
  throw new ExitError(code);
}

const dieAuth = (ctx: Ctx, msg: string): never => die(ctx, msg, 3);
const dieQuota = (ctx: Ctx, msg: string): never => die(ctx, msg, 4);
const dieConflict = (ctx: Ctx, msg: string): never => die(ctx, msg, 5);
const dieNet = (ctx: Ctx, msg: string): never => die(ctx, msg, 8);

function requirePat(ctx: Ctx): string {
  const pat = ctx.env.SUPABASE_ACCESS_TOKEN;
  if (!pat) {
    dieAuth(
      ctx,
      'SUPABASE_ACCESS_TOKEN is not set. Generate a PAT at https://supabase.com/dashboard/account/tokens',
    );
  }
  return pat as string;
}

function requireDbPass(ctx: Ctx): string {
  const pass = ctx.env.DB_PASS;
  if (!pass) {
    die(ctx, 'DB_PASS env var is required (never passed as argv — that leaks via ps/history)');
  }
  return pass as string;
}

/** jq-interpolation semantics: null/missing renders as the string "null". */
function jstr(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** jq object-shorthand semantics: missing keys become explicit nulls. */
function orNull(v: unknown): unknown {
  return v === undefined ? null : v;
}

function parseJson(ctx: Ctx, text: string, what: string): any {
  try {
    return JSON.parse(text);
  } catch {
    die(ctx, `invalid JSON in ${what}`);
  }
}

/**
 * apiCall <method> <path> [<json-body>]
 * Handles: 401/403 → exit 3, 402 → 4, 409 → 5, 429 + 5xx → retry w/
 * exponential backoff up to 3 attempts. Returns the response body text.
 *
 * Receipt-before-send, fail-closed: writeReceipt runs before every attempt;
 * on receipt failure the send is refused and the run exits 8 (same polarity
 * and refusal message as _receipted_curl closed in gstack-egress-lib.sh).
 */
async function apiCall(ctx: Ctx, method: string, apipath: string, body?: string): Promise<string> {
  const pat = ctx.env.SUPABASE_ACCESS_TOKEN ?? '';
  const url = `${ctx.base}/${API_VERSION}/${apipath}`;

  let attempt = 0;
  let backoff = 2;
  for (;;) {
    attempt += 1;

    // Egress receipt (fail-closed). The receipt hashes the request body only
    // — the PAT (Authorization header) is never receipted or logged.
    let receiptId = '';
    try {
      const receipt = writeReceipt({
        env: ctx.env,
        sink: 'supabase-provision',
        host: ctx.host,
        payloadClass: `provision-api-call (${method} ${apipath})`,
        bytes: body === undefined ? 0 : Buffer.byteLength(body),
        sha256: body === undefined ? null : sha256Hex(body),
        consent: 'user ran gstack-gbrain-supabase-provision',
      });
      receiptId = receipt.id;
    } catch (error) {
      // Refused — the send never happens. Same problem/cause/fix contract as
      // _gstack_egress_refusal in gstack-egress-lib.sh, then exit 8.
      const home = resolveEgressHome(ctx.env);
      const cause = `EGRESS_RECEIPT_FAILED: ${(error as Error)?.message ?? error}`.replace(/\n/g, ' ');
      ctx.stderr(
        `gstack: supabase-provision NOT sent — the egress receipt could not be written (${cause}). ` +
          `Fix: chmod -R u+w ${path.join(home, 'security')} (or check GSTACK_HOME). ` +
          `What this is: gstack records everything it ATTEMPTS to send off-machine; see gstack-egress.\n`,
      );
      throw new ExitError(8);
    }

    let res: Response;
    let text: string;
    try {
      res = await ctx.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': PROG,
        },
        body,
        signal: AbortSignal.timeout(CURL_TIMEOUT_MS),
      });
      // Body read stays INSIDE the transport try: a server that sends
      // headers then resets or stalls the stream is a transport failure
      // (retry, then exit 8) — not an uncaught exception at exit 1.
      text = await res.text();
    } catch {
      // Transport failure (connect refused, timeout, DNS). Best-effort
      // outcome record, then retry — same as the bash curl-failed branch.
      try {
        writeOutcome({ env: ctx.env, receipt: receiptId, status: 'exit:7' });
      } catch {
        // outcome is bookkeeping; the pre-send receipt is the invariant
      }
      if (attempt >= MAX_ATTEMPTS) {
        dieNet(ctx, `network failure calling ${method} ${apipath} after ${attempt} attempts`);
      }
      await ctx.sleep(backoff * 1000);
      backoff *= 2;
      continue;
    }

    try {
      writeOutcome({ env: ctx.env, receipt: receiptId, status: 'exit:0' });
    } catch {
      // best-effort
    }

    const status = res.status;
    if (status >= 200 && status <= 299) return text;
    if (status === 401) {
      dieAuth(ctx, '401 Unauthorized — your PAT is invalid or expired. Re-generate at https://supabase.com/dashboard/account/tokens');
    }
    if (status === 403) {
      dieAuth(ctx, `403 Forbidden — your PAT lacks permission for ${method} ${apipath}. Regenerate with All Access scope.`);
    }
    if (status === 402) {
      dieQuota(ctx, '402 Payment Required — Supabase project/organization quota exceeded. See https://supabase.com/dashboard');
    }
    if (status === 409) {
      dieConflict(ctx, `409 Conflict on ${method} ${apipath} — likely a duplicate project name. Pick a different name and re-run.`);
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
      if (attempt >= MAX_ATTEMPTS) {
        dieNet(ctx, `${status} after ${attempt} attempts on ${method} ${apipath}`);
      }
      await ctx.sleep(backoff * 1000);
      backoff *= 2;
      continue;
    }

    // 400, 404, etc. — surface the error body for debugging.
    let err = '';
    try {
      const parsed = JSON.parse(text);
      const candidate = parsed?.message ?? parsed?.error;
      if (typeof candidate === 'string') err = candidate;
    } catch {
      // non-JSON error body — fall through to the no-message variant
    }
    if (err) {
      die(ctx, `HTTP ${status} from ${method} ${apipath}: ${err}`);
    } else {
      die(ctx, `HTTP ${status} from ${method} ${apipath} (no error message in response)`);
    }
  }
}

async function cmdListOrgs(ctx: Ctx, args: string[]): Promise<void> {
  let jsonMode = false;
  for (const arg of args) {
    if (arg === '--json') jsonMode = true;
    else die(ctx, `list-orgs: unknown flag: ${arg}`);
  }

  requirePat(ctx);
  const resp = parseJson(ctx, await apiCall(ctx, 'GET', 'organizations'), 'organizations response');
  if (!Array.isArray(resp)) die(ctx, 'list-orgs: expected an array from GET organizations');
  if (jsonMode) {
    const out = { orgs: resp.map((o: any) => ({ slug: orNull(o?.slug), name: orNull(o?.name) })) };
    ctx.stdout(JSON.stringify(out, null, 2) + '\n');
  } else {
    for (const o of resp) ctx.stdout(`${jstr(o?.slug)}\t${jstr(o?.name)}\n`);
  }
}

async function cmdCreate(ctx: Ctx, args: string[]): Promise<void> {
  let name = '';
  let region = '';
  let orgSlug = '';
  let jsonMode = false;
  let instanceSize = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') jsonMode = true;
    else if (arg === '--instance-size') {
      const value = args[++i];
      if (value === undefined) die(ctx, 'create: --instance-size requires a value');
      instanceSize = value;
    } else if (arg.startsWith('--')) die(ctx, `create: unknown flag: ${arg}`);
    else if (!name) name = arg;
    else if (!region) region = arg;
    else if (!orgSlug) orgSlug = arg;
    else die(ctx, 'create: too many positional arguments');
  }
  if (!name) die(ctx, 'create: missing <name>');
  if (!region) die(ctx, 'create: missing <region>');
  if (!orgSlug) die(ctx, 'create: missing <org-slug>');

  requirePat(ctx);
  const dbPass = requireDbPass(ctx);

  const body: Record<string, string> = {
    name,
    db_pass: dbPass,
    organization_slug: orgSlug,
    region,
  };
  if (instanceSize) body.desired_instance_size = instanceSize;

  const resp = parseJson(
    ctx,
    await apiCall(ctx, 'POST', 'projects', JSON.stringify(body)),
    'create response',
  );
  if (jsonMode) {
    const out = {
      ref: orNull(resp?.ref),
      name: orNull(resp?.name),
      region: orNull(resp?.region),
      organization_slug: orNull(resp?.organization_slug),
      status: orNull(resp?.status),
    };
    ctx.stdout(JSON.stringify(out, null, 2) + '\n');
  } else {
    ctx.stdout(`ref=${jstr(resp?.ref)} status=${jstr(resp?.status)} region=${jstr(resp?.region)}\n`);
  }
}

async function cmdWait(ctx: Ctx, args: string[]): Promise<void> {
  let ref = '';
  let timeout = String(DEFAULT_WAIT_TIMEOUT);
  let jsonMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--timeout') {
      const value = args[++i];
      if (value === undefined) die(ctx, 'wait: --timeout requires a value');
      timeout = value;
    } else if (arg === '--json') jsonMode = true;
    else if (arg.startsWith('--')) die(ctx, `wait: unknown flag: ${arg}`);
    else ref = arg;
  }
  if (!ref) die(ctx, 'wait: missing <ref>');
  // Validate up front: NaN would make the deadline comparison below always
  // false and the poll loop run forever (the bash predecessor errored here).
  const timeoutSeconds = Number(timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    die(ctx, 'wait: --timeout must be a non-negative integer (seconds)');
  }

  requirePat(ctx);

  let elapsed = 0;
  for (;;) {
    const resp = parseJson(ctx, await apiCall(ctx, 'GET', `projects/${ref}`), 'project status response');
    const status: string = resp?.status ?? 'UNKNOWN';
    if (status === 'ACTIVE_HEALTHY') {
      if (jsonMode) {
        ctx.stdout(JSON.stringify({ ref, status, elapsed_s: elapsed }, null, 2) + '\n');
      } else {
        ctx.stdout(`ready ref=${ref} status=${status} elapsed_s=${elapsed}\n`);
      }
      return;
    }
    if (['INIT_FAILED', 'REMOVED', 'RESTORE_FAILED', 'PAUSE_FAILED'].includes(status)) {
      ctx.stderr(`${PROG}: project ${ref} reached terminal failure state '${status}'\n`);
      throw new ExitError(7);
    }
    const stillProvisioning = [
      'COMING_UP', 'INACTIVE', 'ACTIVE_UNHEALTHY', 'UNKNOWN', 'RESTORING',
      'UPGRADING', 'PAUSING', 'RESTARTING', 'RESIZING', 'GOING_DOWN',
    ].includes(status);
    if (!stillProvisioning) {
      // Unexpected status from Supabase. Log but keep polling.
      ctx.stderr(`${PROG}: unexpected status '${status}' — continuing to poll\n`);
    }

    if (elapsed >= timeoutSeconds) {
      ctx.stderr(`${PROG}: wait timed out after ${timeout}s (last status: ${status})\n`);
      ctx.stderr(`${PROG}: re-run with /setup-gbrain --resume-provision ${ref}\n`);
      throw new ExitError(6);
    }
    await ctx.sleep(POLL_INTERVAL * 1000);
    elapsed += POLL_INTERVAL;
  }
}

async function cmdPoolerUrl(ctx: Ctx, args: string[]): Promise<void> {
  let ref = '';
  let jsonMode = false;
  for (const arg of args) {
    if (arg === '--json') jsonMode = true;
    else if (arg.startsWith('--')) die(ctx, `pooler-url: unknown flag: ${arg}`);
    else ref = arg;
  }
  if (!ref) die(ctx, 'pooler-url: missing <ref>');

  requirePat(ctx);
  const dbPass = requireDbPass(ctx);

  const resp = parseJson(
    ctx,
    await apiCall(ctx, 'GET', `projects/${ref}/config/database/pooler`),
    'pooler config response',
  );

  // Prefer the singular Session Pooler config when Supabase returns an
  // array (response shape can vary by project state). Fall back to the
  // first PRIMARY entry if no "session" pool_mode is present.
  const entry: any = Array.isArray(resp)
    ? resp.find((e: any) => e?.pool_mode === 'session') ?? resp[0]
    : resp;

  const asField = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
  const dbUser = asField(entry?.db_user);
  const dbHost = asField(entry?.db_host);
  let dbPort = asField(entry?.db_port);
  const dbName = asField(entry?.db_name);
  let poolMode = asField(entry?.pool_mode);

  if (!dbUser || !dbHost || !dbPort || !dbName) {
    die(ctx, 'pooler-url: missing pooler config fields (db_user/db_host/db_port/db_name); re-poll or check project state');
  }

  // Issue #1301: New Supabase projects' Management API returns a single
  // transaction-mode pooler at port 6543, but the shared pooler tenant
  // for fresh projects only listens on the session port 5432. Trusting
  // db_port verbatim makes `gbrain init` hang to TCP timeout (transaction
  // port unreachable) before falling into "tenant not found"-style errors
  // that look like auth bugs. Rewrite transaction/6543 -> session/5432.
  // Override with GSTACK_SUPABASE_TRUST_API_PORT=1 if a future API version
  // starts returning a working transaction port and this rewrite is wrong.
  if ((ctx.env.GSTACK_SUPABASE_TRUST_API_PORT ?? '0') !== '1' && poolMode === 'transaction' && dbPort === '6543') {
    ctx.stderr(
      'pooler-url: API returned transaction pooler (port 6543); shared pooler for new projects listens on session port 5432 — rewriting (set GSTACK_SUPABASE_TRUST_API_PORT=1 to disable)\n',
    );
    dbPort = '5432';
    poolMode = 'session';
  }

  // Percent-encode the password segment: DB_PASS is caller-controlled and a
  // reserved character (/ # ? % @) changes URI structure — the project
  // provisions fine and then every consumer fails to parse the DSN, leaving
  // an unusable billable orphan.
  const url = `postgresql://${dbUser}:${encodeURIComponent(dbPass)}@${dbHost}:${dbPort}/${dbName}`;

  if (jsonMode) {
    ctx.stdout(JSON.stringify({ ref, pooler_url: url }, null, 2) + '\n');
  } else {
    // Non-JSON mode prints the URL; callers capturing it into a variable
    // keep it in process memory only.
    ctx.stdout(url + '\n');
  }
}

async function cmdListOrphans(ctx: Ctx, args: string[]): Promise<void> {
  let namePrefix = 'gbrain';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name-prefix') {
      const value = args[++i];
      if (value === undefined) die(ctx, 'list-orphans: --name-prefix requires a value');
      namePrefix = value;
    } else if (arg === '--json') {
      // parsed for symmetry; output is the same JSON object either way
    } else if (arg.startsWith('--')) die(ctx, `list-orphans: unknown flag: ${arg}`);
    else die(ctx, `list-orphans: unexpected arg: ${arg}`);
  }

  requirePat(ctx);
  const all = parseJson(ctx, await apiCall(ctx, 'GET', 'projects'), 'projects response');
  if (!Array.isArray(all)) die(ctx, 'list-orphans: expected an array from GET projects');

  // Extract the active brain's ref from ~/.gbrain/config.json if present.
  // Pooler URL format: postgresql://postgres.<ref>:<PASSWORD>@...
  let activeRef: string | null = null;
  const home = ctx.env.HOME || os.homedir();
  const gbrainCfg = path.join(home, '.gbrain', 'config.json');
  if (fs.existsSync(gbrainCfg)) {
    let dbUrl = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(gbrainCfg, 'utf-8'));
      if (typeof cfg?.database_url === 'string') dbUrl = cfg.database_url;
    } catch {
      // unreadable/unparseable config — same as jq failing: no active ref
    }
    if (dbUrl) {
      // Extract user portion before the colon: postgresql://USER:PASSWORD@...
      const match = dbUrl.match(/^[a-z]+:\/\/([^:]+):.*$/);
      const user = match ? match[1] : dbUrl;
      // User format: postgres.<ref> — pull ref suffix
      if (user.startsWith('postgres.')) activeRef = user.slice('postgres.'.length);
    }
  }

  const orphans = all
    .filter((p: any) => typeof p?.name === 'string' && p.name.startsWith(namePrefix))
    .filter((p: any) => p?.ref !== activeRef)
    .map((p: any) => ({
      ref: orNull(p?.ref),
      name: orNull(p?.name),
      created_at: orNull(p?.created_at),
      region: orNull(p?.region),
    }));

  ctx.stdout(JSON.stringify({ active_ref: activeRef, orphans }, null, 2) + '\n');
}

async function cmdDeleteProject(ctx: Ctx, args: string[]): Promise<void> {
  let ref = '';
  for (const arg of args) {
    if (arg === '--json') {
      // parsed for symmetry; output is the same JSON object either way
    } else if (arg.startsWith('--')) die(ctx, `delete-project: unknown flag: ${arg}`);
    else ref = arg;
  }
  if (!ref) die(ctx, 'delete-project: missing <ref>');

  requirePat(ctx);
  await apiCall(ctx, 'DELETE', `projects/${ref}`);
  ctx.stdout(JSON.stringify({ deleted_ref: ref }, null, 2) + '\n');
}

/**
 * Run the provision CLI. Returns the process exit code (never calls
 * process.exit) — the bin entry maps it to the real process, tests read it
 * directly.
 */
export async function runProvision(argv: string[], options: ProvisionOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const base = env.SUPABASE_API_BASE || 'https://api.supabase.com';
  // Host for the receipt: strip scheme, strip any path (keeps the port).
  let host = base.includes('://') ? base.slice(base.indexOf('://') + 3) : base;
  host = host.split('/')[0];

  const ctx: Ctx = {
    base,
    host,
    env,
    fetchImpl: options.fetch ?? globalThis.fetch,
    stdout: options.stdout ?? ((chunk) => process.stdout.write(chunk)),
    stderr: options.stderr ?? ((chunk) => process.stderr.write(chunk)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'list-orgs': await cmdListOrgs(ctx, rest); break;
      case 'create': await cmdCreate(ctx, rest); break;
      case 'wait': await cmdWait(ctx, rest); break;
      case 'pooler-url': await cmdPoolerUrl(ctx, rest); break;
      case 'list-orphans': await cmdListOrphans(ctx, rest); break;
      case 'delete-project': await cmdDeleteProject(ctx, rest); break;
      case '--help':
      case '-h':
      case 'help':
        ctx.stdout(HELP_TEXT);
        break;
      case undefined:
      case '':
        die(ctx, 'usage: gstack-gbrain-supabase-provision {list-orgs|create|wait|pooler-url|list-orphans|delete-project|--help}');
        break;
      default:
        die(ctx, `unknown subcommand: ${cmd}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
}
