import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { CanUseTool, HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkResult, QueryProvider } from './agent-sdk-runner';
import type { EvalTestEntry } from './eval-store';
import { CAPTURE_MS } from './eval-budgets';
import { SHARED_INTERACTIVE_MAX_TURNS } from './shared-libs-eval-fixture';
import { runGeneration } from '../../scripts/gen-skill-docs';
import { gitArgvIn } from './scratch-repo';

/**
 * The native /ship frozen-scope convergence case (docs/ship-policy.md#review-scope).
 *
 * The actor runs the generated Step 9.4 and its repeat decision under
 * review_scope "frozen" against a fixture branch with two CRITICAL findings:
 * one in the diff (invoice.ts drops its owner check) and one in code the branch
 * never touched (payments.ts interpolates a card number into SQL). The contract:
 * the in-diff defect is fixed and committed, the pre-existing one is deferred
 * and its file left byte-identical, pass 2 reviews only the range since pass 1
 * and finds nothing, the loop exits through decision 4, and the review log
 * yields REVIEW_LOOP passes=2 blocking_found=2 deferred=1 fixed=1. Every helper
 * the model touches (gstack-review-scope, gstack-review-log) is the real binary
 * in the fixture's owned state root; the adapters only bind their arguments.
 */
export const SHIP_FROZEN_SCOPE_CASE = 'ship-frozen-scope-convergence';
export const SHIP_FROZEN_SCOPE_SUITE = 'ship-frozen-scope';
export const FROZEN_SCOPE_FIX_IDENTITY = 'invoice.ts:1:authorization';
export const FROZEN_SCOPE_DEFER_IDENTITY = 'payments.ts:2:injection';
const ROOT = path.resolve(import.meta.dir, '../..');
const SAFE_INVOICE = 'export const canReadInvoice = (owner: string, viewer: string) => owner === viewer;\n';
const BROKEN_INVOICE = 'export const canReadInvoice = (_owner: string, _viewer: string) => true;\n';
const PAYMENTS = 'export const chargeCard = (db: { run: (sql: string) => void }, card: string, amount: number) =>\n'
  + "  db.run(`INSERT INTO charges (card, amount) VALUES ('${card}', ${amount})`);\n";
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function command(cwd: string, env: NodeJS.ProcessEnv, executable: string, args: string[], deadline = Infinity) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Frozen-scope case deadline exhausted during setup');
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: Math.min(20_000, remaining) });
  if (result.status !== 0 || result.error) throw new Error(result.error?.message ?? (result.stderr || result.stdout));
  return { stdout: result.stdout, stderr: result.stderr };
}

function section(text: string, first: string, last: string) {
  const start = text.indexOf(first);
  const end = text.indexOf(last, start + first.length);
  if (start < 0 || end < start || text.indexOf(first, start + first.length) >= 0) throw new Error(`Ambiguous workflow boundary: ${first}`);
  return text.slice(start, end).trim();
}

/** The generated Step 9.4 (scope, cap, fix, defer, log) and the repeat decision, as /ship renders them for Claude Code. */
export async function shipFrozenScopeWorkflow() {
  const rendered = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sfrz-render-'));
  try {
    const generated = await runGeneration({ host: 'claude', outputRoot: rendered, contentLinkRoot: null, log: () => {} });
    if (generated.exitCode !== 0) throw new Error('Ship fixture generation failed');
    const army = read(path.join(rendered, 'ship/sections/review-army.md'));
    return section(army, '## Step 9.4: Fix-First and persistence', '**Required-probe parent gate:**');
  } finally { fs.rmSync(rendered, { recursive: true, force: true }); }
}

export const FROZEN_SCOPE_FINDINGS = [
  { fingerprint: FROZEN_SCOPE_FIX_IDENTITY, path: 'invoice.ts', line: 1, severity: 'CRITICAL', category: 'authorization', source: 'checklist',
    problem: 'canReadInvoice returns true for every viewer, so any caller reads any invoice.', recommended_fix: 'Accept only the invoice owner as the viewer.' },
  { fingerprint: FROZEN_SCOPE_DEFER_IDENTITY, path: 'payments.ts', line: 2, severity: 'CRITICAL', category: 'injection', source: 'specialist:security',
    problem: 'chargeCard interpolates the card value into the SQL text, so a crafted card string runs arbitrary SQL.', recommended_fix: 'Bind card and amount as parameters.' },
];

export function createShipFrozenScopeFixture(workflow: string, root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sfrz-')), deadline = Infinity) {
  const routing = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']
    .filter(key => process.env[key] !== undefined);
  if (routing.length) throw new Error(`Refusing ambient Git routing: ${routing.join(', ')}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const repo = path.join(root, 'project');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const assets = path.join(root, 'assets');
  for (const dir of [repo, home, state, assets]) fs.mkdirSync(dir, { mode: 0o700 });
  const env = { HOME: home, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, CLAUDE_PLUGIN_DATA: '',
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  const git = (...args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Frozen-scope case deadline exhausted during setup');
    const result = gitArgvIn(repo, args, Math.min(10_000, remaining), env);
    if (result.status !== 0 || result.error) throw new Error(result.error?.message ?? result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q', '-b', 'main');
  const invoice = path.join(repo, 'invoice.ts');
  const payments = path.join(repo, 'payments.ts');
  fs.writeFileSync(invoice, SAFE_INVOICE, { mode: 0o644 });
  fs.writeFileSync(payments, PAYMENTS, { mode: 0o644 });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.gstack/tmp/\n', { mode: 0o644 });
  git('add', '.gitignore', 'invoice.ts', 'payments.ts');
  git('commit', '-qm', 'Seed invoice authorization and card charges');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'fixture/frozen-scope');
  fs.writeFileSync(invoice, BROKEN_INVOICE);
  git('add', 'invoice.ts');
  git('commit', '-qm', 'Let any viewer read an invoice');
  const head = git('rev-parse', 'HEAD');
  const tmp = path.join(repo, '.gstack', 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const findingsPath = path.join(tmp, 'review-findings-p1.json');
  write(findingsPath, FROZEN_SCOPE_FINDINGS);
  const workflowPath = path.join(assets, 'workflow.md');
  fs.writeFileSync(workflowPath, workflow, { mode: 0o600 });
  const draft = path.join(root, 'review-record.json');
  const receipts = path.join(root, 'receipts.jsonl');
  const fullEnv = { ...process.env, ...env };
  const token = command(repo, fullEnv, path.join(ROOT, 'bin/gstack-review-log'), ['--start', 'review'], deadline).stdout.trim();
  const startFiles = fs.readdirSync(state, { recursive: true }).filter(file => String(file).endsWith(`/${token}.json`));
  if (startFiles.length !== 1) throw new Error('Expected one owned real review-start receipt');
  const start = json(path.join(state, String(startFiles[0])));
  if (start.repo !== repo || start.branch !== 'fixture/frozen-scope') throw new Error('Review-start receipt has foreign ownership');
  const commands = Object.fromEntries(['classify', 'defer', 'persist', 'commit', 'repeat', 'continue', 'stop'].map(action =>
    [action, `${quote(process.execPath)} ${quote(import.meta.path)} --fixture ${quote(root)} ${action}`])) as Record<string, string>;
  write(path.join(root, 'fixture.json'), { repo, env, invoice, payments, head, tokens: [token], draft, receipts, tmp });
  const executions: Array<{ tool: string; input: Record<string, unknown>; allowed: boolean; pass: number }> = [];
  const refusals: string[] = [];
  const rows = () => read(receipts).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { action: string; pass: number; head?: string });
  const pass = () => rows().filter(row => row.action === 'persist').length + 1;
  const finished = () => rows().some(row => row.action === 'continue' || row.action === 'stop');
  const readable = new Set([workflowPath, invoice, payments]);
  const invalid = (tool: string, input: Record<string, unknown>) => {
    if (finished()) return 'Loop decision already taken';
    const target = typeof input.file_path === 'string' ? path.resolve(repo, input.file_path) : '';
    if (tool === 'Read') return target && (readable.has(target) || (target.startsWith(tmp + path.sep) && fs.existsSync(target))) ? undefined : 'Read outside the declared files';
    if (tool === 'Write') {
      if (target === draft) return typeof input.content === 'string' && input.content.length <= 16_384 ? undefined : 'Review record too large';
      if (target === invoice) return typeof input.content === 'string' ? undefined : 'Write needs content';
      return 'Write outside invoice.ts and the review record';
    }
    if (tool === 'Edit') return target === invoice && typeof input.old_string === 'string' && typeof input.new_string === 'string' ? undefined : 'Edit outside invoice.ts';
    if (tool === 'Bash') return typeof input.command === 'string' && !input.run_in_background && Object.values(commands).includes(input.command.trim()) ? undefined : 'Bash outside the fixture interface';
    return 'Undeclared tool';
  };
  const canUseTool: CanUseTool = async (tool, input) => {
    const reason = invalid(tool, input as Record<string, unknown>);
    if (reason) { refusals.push(reason); return { behavior: 'deny', message: reason }; }
    return { behavior: 'allow', updatedInput: input };
  };
  const preToolUse: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') throw new Error('Unexpected hook');
    const toolInput = input.tool_input as Record<string, unknown>;
    const reason = invalid(input.tool_name, toolInput);
    executions.push({ tool: input.tool_name, input: toolInput, allowed: !reason, pass: pass() });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: reason ? 'deny' : 'allow',
      ...(reason ? { permissionDecisionReason: reason } : {}),
      ...(input.tool_name === 'Bash' && !reason ? { updatedInput: { command: toolInput.command, timeout: 30000, run_in_background: false } } : {}) } };
  };
  const prompt = `Load gstack's bounded /ship review-loop path from ${workflowPath}: Step 9.4 and the "Decide whether to repeat Step 9" decisions that follow it. This invocation runs unattended (SESSION_KIND: headless, no owner present) under review_scope policy \`frozen\` with base \`origin/main\`, on branch fixture/frozen-scope in ${repo}. PASS is 1 and CYCLES is 0 on entry. The pass-1 Step 9.3 result is already written at ${findingsPath}; verify each finding against its source (${invoice}, ${payments}) before acting on the classified output. Execute the workflow through its decision, pass by pass, until the decision continues to Step 10 or stops the loop.

Supported interactions, declared before launch:
- Read: ${workflowPath}, ${invoice}, ${payments}, and any file under ${tmp}/ once it exists.
- Edit or Write: ${invoice} only, and only to apply a fix for a finding the classified output scopes \`fix\`. ${payments} is never written in this fixture. Write also accepts ${draft}, the item-6 review record of the current pass: the JSON object the gstack-review-log example takes (skill, timestamp, status, issues_found, critical, informational, quality_score 10.0, specialists {}, findings with fingerprint, severity, action and the copied locus, kind and blocking, commit, via "ship", completed, converged, cycles, pass, review_scope, range_base). The record's commit is the short HEAD: ${head.slice(0, 7)} now, and the sha the commit adapter prints after it commits a fix; no git command is needed for it.
- Bash accepts exactly these single commands, without chaining, redirection or backgrounding. Each is the bound adapter for the generated helper command it names and does not decide which item or decision applies:
  ${commands.classify} runs gstack-review-scope classify for the current pass against this pass's .gstack/tmp/review-findings-p$PASS.json (--range-base is bound from pass 2 on); it writes .gstack/tmp/review-classified-p$PASS.json and prints the REVIEW_SCOPE line and the classified JSON.
  ${commands.defer} runs gstack-review-scope defer on the current pass's classified file; it writes .gstack/tmp/review-deferred.json and prints the DEFERRED lines and the rendered PR-body sections (a deferred finding stays on the PR; no issue is filed).
  ${commands.persist} passes ${draft} to the real gstack-review-log with this pass's REVIEW_START token (--finish); the pass-1 token was captured before this prompt, and the repeat adapter captures the next one.
  ${commands.commit} runs item 4's commit of the fixed file (git add invoice.ts && git commit -m "fix: pre-landing review fixes").
  ${commands.repeat} takes decision 3: it runs the next pass's Steps 5 through 9.3 on the range since the previous pass, writes that pass's .gstack/tmp/review-findings-p$PASS.json and prints the result with the new REVIEW_START captured.
  ${commands.continue} takes decision 4 (no edits in this pass): continue to Step 10 and stop this fixture.
  ${commands.stop} takes decision 1 or 2: STOP the loop and stop this fixture.
No owner can answer here, so AskUserQuestion is not available: a finding the classified output scopes \`fix\` is resolved as AUTO-FIX under the Fix-First heuristic, and no finding is skipped. The gate scan of item 2.5, freshness, memory updates and Step 10 itself are outside this fixture. Stop after the continue or stop adapter completes.`;
  const snapshot = () => ({ invoice: read(invoice), payments: read(payments), originalPayments: PAYMENTS, head, start, refusals, executions, receipts: rows(),
    workflowSha256: digest(workflow), promptSha256: digest(prompt), stateRoot: state, repo,
    status: gitArgvIn(repo, ['status', '--porcelain'], 10_000, env).stdout.toString().trim(),
    headNow: gitArgvIn(repo, ['rev-parse', 'HEAD'], 10_000, env).stdout.toString().trim(),
    rows: (() => { try { return reviewRows(repo, fullEnv); } catch (error) { return { error: String(error) }; } })(),
    loop: (() => { try { return loopSummary(repo, fullEnv, start.started_at); } catch (error) { return { error: String(error) }; } })() });
  return { root, repo, env, workflowPath, findingsPath, invoice, payments, draft, commands, prompt, preToolUse, canUseTool, snapshot };
}

function reviewRows(repo: string, env: NodeJS.ProcessEnv) {
  const out = command(repo, env, path.join(ROOT, 'bin/gstack-review-read'), []).stdout;
  return out.split('---CONFIG---')[0]!.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}

function loopSummary(repo: string, env: NodeJS.ProcessEnv, since: string) {
  return JSON.parse(command(repo, env, path.join(ROOT, 'bin/gstack-review-scope'), ['summary', '--no-ledger', '--since', since, '--json']).stdout.trim());
}

export async function shipFrozenScopeFailures(fixture: ReturnType<typeof createShipFrozenScopeFixture>, result: Pick<AgentSdkResult, 'exitReason'>) {
  const evidence = fixture.snapshot();
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  check(result.exitReason === 'success', `actor ended: ${result.exitReason}`);
  const denied = evidence.executions.filter(event => !event.allowed).map(event => `${event.tool} ${JSON.stringify(event.input).slice(0, 160)}`);
  check(evidence.refusals.length === 0 && denied.length === 0, `undeclared interaction: ${[...evidence.refusals, ...denied].join('; ')}`);
  check(evidence.payments === evidence.originalPayments, 'pre-existing payments.ts was edited: the frozen scope fixes only the diff');
  try {
    const url = `${pathToFileURL(fixture.invoice).href}?v=${randomUUID()}`;
    const mod = await import(url) as { canReadInvoice?: (owner: string, viewer: string) => boolean };
    check(typeof mod.canReadInvoice === 'function' && mod.canReadInvoice('owner', 'owner') === true && mod.canReadInvoice('owner', 'other') === false,
      'invoice.ts still accepts a viewer other than the owner');
  } catch (error) { failures.push(`invoice.ts does not load after the fix: ${String(error).split('\n')[0]}`); }
  const actions = evidence.receipts.map(row => row.action);
  check(actions.at(-1) === 'continue', `loop did not exit through decision 4 (adapters: ${actions.join(' → ') || 'none'})`);
  check(actions.filter(action => action === 'repeat').length === 1, 'expected exactly one repeat pass');
  check(actions.filter(action => action === 'persist').length === 2, 'expected one logged row per pass');
  const order = (first: string, second: string) => actions.includes(first) && actions.includes(second) && actions.indexOf(first) < actions.indexOf(second);
  check(order('classify', 'defer') && order('defer', 'persist') && order('persist', 'commit') && order('commit', 'repeat'), 'pass 1 ran its items out of order');
  check(evidence.status === '' && evidence.headNow !== evidence.head, 'the fix was not committed before pass 2');
  const rows = Array.isArray(evidence.rows) ? evidence.rows.filter(row => row.skill === 'review' && row.via === 'ship') : [];
  const [first, second] = rows;
  check(rows.length === 2 && first?.pass === 1 && second?.pass === 2, `expected pass 1 and pass 2 review rows, found ${rows.map(row => row.pass).join(', ') || 'none'}`);
  const identity = (f: Record<string, any>) => f?.fingerprint ?? `${f?.path}:${f?.line}`;
  const fixed = (first?.findings ?? []).find((f: Record<string, any>) => identity(f) === FROZEN_SCOPE_FIX_IDENTITY);
  const deferred = (first?.findings ?? []).find((f: Record<string, any>) => identity(f) === FROZEN_SCOPE_DEFER_IDENTITY);
  check(['fixed', 'auto-fixed'].includes(fixed?.action) && fixed?.blocking === true && fixed?.locus === 'diff', 'pass 1 did not record the in-diff defect as fixed');
  check(deferred?.action === 'deferred' && deferred?.blocking === true && deferred?.locus === 'outside', 'pass 1 did not record the pre-existing defect as deferred');
  check(first?.review_scope === 'frozen' && second?.review_scope === 'frozen', 'rows do not carry the frozen policy');
  check(typeof second?.range_base === 'string' && second.range_base.length >= 7 && evidence.head.startsWith(second.range_base), 'pass 2 did not record the pass-1 head as its range base');
  check(!(second?.findings ?? []).some((f: Record<string, any>) => ['fixed', 'auto-fixed'].includes(f?.action)) && Number(second?.issues_found) === 0, 'pass 2 recorded fixes or open defects on an empty range review');
  const loop = evidence.loop as Record<string, any>;
  check(loop?.passes === 2 && loop?.blocking_found === 2 && loop?.deferred === 1 && loop?.fixed === 1 && loop?.scope === 'frozen',
    `REVIEW_LOOP summary ${JSON.stringify(loop)} is not passes=2 blocking_found=2 deferred=1 fixed=1 scope=frozen`);
  return { failures, evidence };
}

export async function runShipFrozenScopeActor(record: (entry: EvalTestEntry) => void, injectedQuery?: QueryProvider, artifactDirectory?: string) {
  const started = Date.now();
  const deadline = started + CAPTURE_MS - 20000;
  const artifacts = artifactDirectory ?? process.env.GSTACK_EVAL_DIR;
  const evidenceFile = artifacts ? path.join(artifacts, `${SHIP_FROZEN_SCOPE_CASE}-${randomUUID()}.json`) : undefined;
  let workflow = '';
  let fixture: ReturnType<typeof createShipFrozenScopeFixture> | undefined;
  let result: AgentSdkResult | undefined;
  let failure: unknown;
  let passed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const events: SDKMessage[] = [];
  try {
    if (!artifacts) throw new Error('Frozen-scope actor requires GSTACK_EVAL_DIR for durable evidence');
    fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { runAgentSdkTest, resolveClaudeBinary } = await import('./agent-sdk-runner');
    workflow = await shipFrozenScopeWorkflow();
    fixture = createShipFrozenScopeFixture(workflow, undefined, deadline);
    const binary = injectedQuery ? undefined : resolveClaudeBinary();
    if (!injectedQuery && !binary) throw new Error('Native frozen-scope actor requires the pinned Claude CLI');
    const owned = fixture;
    const controller = new AbortController();
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { const error = new Error('Frozen-scope case deadline exhausted'); controller.abort(error); reject(error); }, Math.max(1, deadline - Date.now()));
    });
    const running = runAgentSdkTest({ systemPrompt: { type: 'preset', preset: 'claude_code' }, userPrompt: owned.prompt,
      workingDirectory: owned.repo, env: owned.env, maxTurns: SHARED_INTERACTIVE_MAX_TURNS, maxRetries: 0,
      signal: controller.signal, allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
      settingSources: [], testName: SHIP_FROZEN_SCOPE_CASE, pathToClaudeCodeExecutable: binary ?? undefined,
      canUseTool: owned.canUseTool,
      queryProvider: options => {
        const stream = (injectedQuery ?? query)({ ...options, options: { ...options.options, cwd: owned.repo, allowedTools: [],
          canUseTool: owned.canUseTool, hooks: { PreToolUse: [{ hooks: [owned.preToolUse] }] } } });
        const iterator = stream[Symbol.asyncIterator]();
        return new Proxy(stream, { get(target, property) {
          if (property === Symbol.asyncIterator) return async function* () {
            for (let next = await iterator.next(); !next.done; next = await iterator.next()) { events.push(next.value); yield next.value; }
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    });
    result = await Promise.race([running, expired]);
    const verdict = await shipFrozenScopeFailures(owned, result);
    if (verdict.failures.length) throw new Error(verdict.failures.join('; '));
    passed = true;
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    try {
      const terminal = events.findLast(event => event.type === 'result');
      const costUsd = typeof terminal?.total_cost_usd === 'number' && Number.isFinite(terminal.total_cost_usd) && terminal.total_cost_usd >= 0 ? terminal.total_cost_usd : null;
      const billing = { knownCostUsd: costUsd ?? 0, costKnown: costUsd !== null, status: !events.length ? 'not_started' : costUsd !== null ? 'complete' : 'incomplete' };
      const billingNote = billing.costKnown ? '' : 'Terminal billing is incomplete; actual total cost is unknown. Only known charges are summed; all events are retained.';
      const output = JSON.stringify({ error: failure === undefined ? undefined : String(failure), prompt: fixture?.prompt, workflow,
        evidence: fixture?.snapshot(), events, output: result?.output, started, deadline, root: fixture?.root, billing });
      if (evidenceFile) fs.writeFileSync(evidenceFile, output + '\n', { mode: 0o600 });
      record({ name: SHIP_FROZEN_SCOPE_CASE, suite: SHIP_FROZEN_SCOPE_SUITE, tier: 'e2e', passed, duration_ms: Date.now() - started,
        cost_usd: billing.knownCostUsd, transcript: [{ type: 'fixture_billing', cost_known: billing.costKnown, billing }, ...events],
        prompt: fixture?.prompt, turns_used: result?.turnsUsed, model: result?.model, output,
        error: [failure === undefined ? '' : String(failure), billingNote].filter(Boolean).join('\n') || undefined,
        exit_reason: passed ? 'success' : result?.exitReason === 'success' ? 'assertion_failed' : result?.exitReason ?? 'runner_error' });
    } finally {
      if (fixture && passed) fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  if (failure !== undefined) throw failure;
  return evidenceFile!;
}

if (import.meta.main && process.argv[2] === '--fixture') {
  const root = fs.realpathSync(process.argv[3]!);
  const config = json(path.join(root, 'fixture.json')) as { repo: string; env: Record<string, string>; invoice: string; head: string; tokens: string[]; draft: string; receipts: string; tmp: string };
  const action = process.argv[4];
  const env = { ...process.env, ...config.env };
  const bin = (name: string, args: string[]) => command(config.repo, env, path.join(ROOT, 'bin', name), args);
  const receipts = read(config.receipts).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { action: string; pass: number });
  const persisted = receipts.filter(row => row.action === 'persist').length;
  const pass = persisted + 1;
  const file = (name: string) => path.join(config.tmp, name);
  const classified = file(`review-classified-p${pass}.json`);
  if (receipts.some(row => row.action === 'continue' || row.action === 'stop')) throw new Error('Loop decision already taken');
  let output = '';
  if (action === 'classify') {
    const findings = file(`review-findings-p${pass}.json`);
    if (!fs.existsSync(findings)) throw new Error(`No Step 9.3 result for pass ${pass}`);
    const args = ['classify', '--base', 'origin/main', '--pass', String(pass), '--policy', 'frozen', '--findings', findings, '--json'];
    if (pass > 1) args.push('--range-base', config.head);
    const run = bin('gstack-review-scope', args);
    fs.writeFileSync(classified, run.stdout, { mode: 0o600 });
    output = run.stderr.trim() + '\n' + run.stdout.trim();
  } else if (action === 'defer') {
    if (!fs.existsSync(classified)) throw new Error(`Classify pass ${pass} first`);
    const deferred = file('review-deferred.json');
    const run = bin('gstack-review-scope', ['defer', '--findings', classified, '--out', deferred]);
    output = [run.stderr.trim(), run.stdout.trim()].filter(Boolean).join('\n');
  } else if (action === 'persist') {
    if (!fs.existsSync(config.draft)) throw new Error('Write the review record first');
    const token = config.tokens[persisted];
    if (!token) throw new Error('No REVIEW_START token for this pass');
    const run = bin('gstack-review-log', [JSON.stringify(json(config.draft)), '--finish', token]);
    output = [run.stderr.trim(), run.stdout.trim()].filter(Boolean).join('\n') || 'logged';
  } else if (action === 'commit') {
    if (persisted < 1) throw new Error('Log this pass (items 5–6) before committing');
    const add = gitArgvIn(config.repo, ['add', 'invoice.ts'], 10_000, config.env);
    if (add.status !== 0) throw new Error(add.stderr.toString());
    const commit = gitArgvIn(config.repo, ['commit', '-qm', 'fix: pre-landing review fixes'], 10_000, config.env);
    if (commit.status !== 0) throw new Error(commit.stderr.toString() || 'nothing to commit');
    output = gitArgvIn(config.repo, ['rev-parse', '--short', 'HEAD'], 10_000, config.env).stdout.toString().trim();
  } else if (action === 'repeat') {
    if (!receipts.some(row => row.action === 'commit')) throw new Error('Repeat requires the fixes of this pass committed (item 4)');
    if (receipts.some(row => row.action === 'repeat')) throw new Error('Only one repeat pass is supported');
    const token = bin('gstack-review-log', ['--start', 'review']).stdout.trim();
    config.tokens.push(token);
    write(path.join(root, 'fixture.json'), config);
    write(file(`review-findings-p${pass}.json`), []);
    const head = gitArgvIn(config.repo, ['rev-parse', 'HEAD'], 10_000, config.env).stdout.toString().trim();
    output = JSON.stringify({ pass, range: `${config.head}..${head}`, tests: 'pass', steps: '5–9.3 complete', findings: [], coverage: 'completed',
      step_9_3_result: `.gstack/tmp/review-findings-p${pass}.json`, review_start_captured: true });
  } else if (action === 'continue' || action === 'stop') {
    if (persisted < 1) throw new Error('Decide only after this pass is logged');
    output = JSON.stringify({ decision: action === 'continue' ? 4 : 'stop', next: action === 'continue' ? 'Step 10' : 'STOP' });
  } else throw new Error('Unknown fixture action');
  fs.appendFileSync(config.receipts, JSON.stringify({ action, pass, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  console.log(output);
}
