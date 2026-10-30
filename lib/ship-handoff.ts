/**
 * ship-handoff — fresh-context delegation for /ship (GSTA-152 D3, build-spec r2
 * item 3). The parent writes a brief (mode 0600, under its run directory) with
 * the pins computed from git at handoff time, the invocation record and its
 * start tokens, the decisions in scope with the owner's words, the decision
 * trail, the budget and the return contract; its sha256 goes in the parent's
 * ledger with a reservation for the child's whole sub-cap. The child verifies
 * the brief before anything else and admits against its sub-cap with
 * child_used = reading - reading_at_handoff. The context rule never stops a
 * child (GSTA-167): once it has completed a step it hands its remaining steps
 * to a grandchild the same way, up to MAX_CHAIN_DEPTH handoffs from the root. It
 * returns at most 40 lines through a return file; the parent reconciles once
 * per handoff hash (a duplicate return charges nothing twice) and reads the
 * record, never the child's transcript.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveClaudeCommand } from './claude-bin';
import { wtreeFingerprint } from './script-invocation';
import { resultLine } from './result-codes';
import {
  MAX_CHAIN_DEPTH, SHIP_STEPS, budgetError, budgetLine, ledgerFileFor, loadCalibration, mintRunId, mutateLedger, parseStep, pointMarker,
  projector, readLedger, reserveIn, runDirFor, segmentEstimate, tally, usageError, writeLedger, type Handoff, type Ledger,
} from './ship-budget';
import { loadMeterState, saveMeterState } from './claude-usage';
import { parseArgs, readMeter, stopLines, str, tokensOpt, writeReturnFile, type Ctx, type Outcome } from './ship-budget-cli';

export const RECORD_HEADINGS = ['Release', 'Decisions', 'Reviews', 'Checks', 'Documentation', 'Next steps'] as const;
export const RETURN_MAX_LINES = 40;
const sha256 = (text: string | Buffer) => crypto.createHash('sha256').update(text).digest('hex');

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function pinsNow(cwd: string, baseRef: string, env: NodeJS.ProcessEnv): { head: string | null; merge_base: string | null; wtree: string | null } {
  const w = wtreeFingerprint({ cwd, env, timeoutMs: 60_000 });
  return { head: git(cwd, ['rev-parse', 'HEAD']), merge_base: git(cwd, ['merge-base', 'HEAD', baseRef]), wtree: 'tree' in w ? w.tree : null };
}

/** One record section's lines, from its heading to the next of the six. */
export function recordSection(text: string, name: string): string[] | undefined {
  const heading = (line: string) => RECORD_HEADINGS.find(h => new RegExp(`^\\s*(?:[-*]\\s*)?(?:#+\\s*)?(?:\\*\\*)?${h}(?:\\*\\*)?:?(?:\\*\\*)?(?:\\s|$)`).test(line));
  const lines = text.split('\n');
  const at = lines.findIndex(line => heading(line) === name);
  if (at < 0) return undefined;
  const end = lines.findIndex((line, i) => i > at && heading(line) !== undefined);
  return lines.slice(at, end < 0 ? lines.length : end);
}

function brief(l: Ledger, h: Omit<Handoff, 'sha'>, pins: Record<string, unknown>, recordText: string, o: Record<string, string | undefined>): string {
  const reviews = recordSection(recordText, 'Reviews') ?? [];
  const tokens = [...new Set(reviews.join('\n').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])];
  const block = { version: 1, parent_run: l.run, parent_ledger: l.file, from: h.from, to: h.to, sub_cap: h.sub_cap, parent_tail: l.tail,
    unit: l.meter.contract.unit, meter: l.meter.contract.meter, epoch: h.epoch, reading_at: h.reading_at, ...pins, record: l.record,
    depth: h.depth, return_file: h.return_file, trail: o.trail ?? null, trail_run: o.trailRun ?? null, launch_file: o.launch ?? null, start_tokens: tokens };
  return [
    `# /ship handoff ${h.n}: Steps ${h.from}-${h.to}`, '',
    '```gstack-handoff', JSON.stringify(block, null, 2), '```', '',
    '## Start', '',
    `1. Run \`gstack-ship-budget verify-handoff --in <this file>\` (on Capy add \`--reading <n>\`) before anything else. On a refusal, return its lines and stop.`,
    block.trail ? `2. Run \`gstack-decision-trail start ${block.trail} <your run id>\` before any trail write.` : '2. No decision trail was named.',
    `3. Run /ship --continue <this file> for Steps ${h.from}-${h.to} only, under the printed child run: \`check\` at every boundary and before every dispatch batch, obeying \`verdict=\`. The context rule never stops you: \`verdict=delegate\` hands your remaining steps to a fresh child the same way (ship/sections/budget-handoff.md), and a \`CONTEXT_HIGH:\` note means continue. This run is at chain depth ${h.depth} of ${MAX_CHAIN_DEPTH}.`,
    block.launch_file ? `4. Source the launch file \`${block.launch_file}\` in every shell that runs a gstack command (its path only; never print its values).` : '4. No GSTACK_LAUNCH_FILE was named.', '',
    '## Record', '', `You are the only writer of \`${l.record}\` during this segment. It keeps its six headings (${RECORD_HEADINGS.join(', ')}). Original start tokens: ${tokens.join(', ') || 'none'}.`, '',
    '## Decisions and approvals in scope (verbatim from the record)', '', ...(recordSection(recordText, 'Decisions') ?? ['(none recorded)']), '',
    '## Budget', '', `Sub-cap ${h.sub_cap} ${block.unit} (meter=${block.meter}); the parent keeps a ${l.tail} tail reserve. Ledger: ${l.file}.`, '',
    '## Return contract', '',
    `Finish with \`gstack-ship-budget return --run <your child run> --to <last step done> --changed <record sections you changed>\`. It writes ${h.return_file} (at most ${RETURN_MAX_LINES} lines: the steps done, new HEAD and tree, the record sections changed, the BUDGET line and GSTACK_RESULT) and prints the same lines. The parent reads the record, never your transcript.`, '',
  ].join('\n');
}

export function cmdHandoff(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['run', 'record', 'from', 'to', 'base', 'reviewed-tree', 'trail', 'trail-run', 'sub-cap', 'reading', 'prior-reading', 'child-session']);
  const from = parseStep(str(o, 'from'), '--from'), to = parseStep(str(o, 'to'), '--to');
  if (SHIP_STEPS.indexOf(from as any) > SHIP_STEPS.indexOf(to as any)) throw usageError(`--from ${from} is after --to ${to}`);
  const base = str(o, 'base');
  if (!base) throw usageError('handoff needs --base origin/<base> (the merge base is pinned against it)');
  const file = ledgerFileFor({ run: str(o, 'run'), record: str(o, 'record') }, ctx.env);
  const child = str(o, 'child-session');
  const out = mutateLedger(file, ctx.env, (l): Outcome => {
    const depth = l.depth ?? (l.parent ? 1 : 0);
    if (depth >= MAX_CHAIN_DEPTH) throw usageError(`run ${l.run} is at chain depth ${depth}, the maximum (${MAX_CHAIN_DEPTH}); continue instead`);
    const at = (s: string) => SHIP_STEPS.indexOf(s as any);
    if (l.parent && (at(from) < at(l.parent.from) || at(to) > at(l.parent.to))) throw usageError(`--from ${from} --to ${to} is outside this child's Steps ${l.parent.from}-${l.parent.to}`);
    if (!l.record || !fs.existsSync(l.record)) throw usageError(`the run has no invocation record at ${l.record}`);
    const recordText = fs.readFileSync(l.record, 'utf8');
    const missing = RECORD_HEADINGS.filter(h => !recordSection(recordText, h));
    if (missing.length) throw usageError(`record ${l.record} lacks headings: ${missing.join(', ')}; fix: keep the six headings the ship skill names`);
    const call = readMeter(l, o, true);
    const cal = loadCalibration(l.calibration);
    const t = tally(l);
    const room = l.cap === null ? Infinity : l.cap - t.used - t.reserved - t.unknown - projector(l, cal).reserve;
    const subCap = tokensOpt(o, 'sub-cap') ?? (l.parent && l.cap !== null ? room : Math.min(room, segmentEstimate(cal, l.meter.contract.unit, from, to)));
    if (subCap <= 0 || subCap > room) return { stdout: stopLines(l, { call, next: from, step: from, projected: subCap, reason: 'budget_exhausted' }), exit: 3 };
    const pins = pinsNow(ctx.cwd, base, ctx.env);
    const reviewed = str(o, 'reviewed-tree') ?? null;
    const r = reserveIn(l, { kind: 'child', step: from, next: `child:${from}-${to}`, tokens: subCap });
    const n = l.handoffs.length + 1;
    const draft = { n, file: path.join(l.dir, `handoff-${n}.md`), from, to, sub_cap: subCap, reservation: r.id, depth: depth + 1, reading_at: l.meter.contract.meter === 'estimate' ? null : l.meter.last, epoch: l.meter.epoch, return_file: path.join(l.dir, `return-${n}.txt`) };
    const text = brief(l, draft, { ...pins, base_ref: base, reviewed_tree: reviewed }, recordText, { trail: str(o, 'trail'), trailRun: str(o, 'trail-run'), launch: ctx.env.GSTACK_LAUNCH_FILE });
    fs.writeFileSync(draft.file, text, { mode: 0o600 });
    const sha = sha256(text);
    l.handoffs.push({ ...draft, sha });
    return { stdout: [`HANDOFF: ${draft.file} sha256=${sha} sub_cap=${subCap}`, `RETURN_FILE: ${draft.return_file}`, budgetLine(l, { call, next: from, projected: subCap, verdict: 'delegate' })], exit: 0 };
  });
  if (child && out.exit === 0) joinMeter(file, child, ctx.env);
  return out;
}

function handoffBlock(text: string): any {
  const m = /```gstack-handoff\n([\s\S]*?)\n```/.exec(text);
  try { return m ? JSON.parse(m[1]!) : undefined; } catch { return undefined; }
}

export function cmdVerifyHandoff(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['in', 'reading', 'session']);
  const file = str(o, 'in');
  if (!file) throw usageError('verify-handoff needs --in <brief>');
  const text = fs.readFileSync(file, 'utf8');
  const block = handoffBlock(text);
  if (!block?.parent_ledger) throw budgetError('BUDGET_LEDGER_INVALID', `${file}: no gstack-handoff block`);
  const parent = readLedger(block.parent_ledger);
  const sha = sha256(text);
  const h = parent.handoffs.find(x => x.sha === sha);
  const moved: string[] = [];
  if (!h) moved.push(`brief sha256 expected ${parent.handoffs.find(x => x.file === path.resolve(file))?.sha ?? 'a recorded handoff'} actual ${sha}`);
  else if (h.reconciled_at) moved.push(`brief already reconciled at ${h.reconciled_at}`);
  const now = pinsNow(ctx.cwd, block.base_ref, ctx.env);
  for (const k of ['head', 'merge_base', 'wtree'] as const) if (block[k] !== now[k]) moved.push(`${k} expected ${block[k]} actual ${now[k]}`);
  if (block.reviewed_tree && git(ctx.cwd, ['cat-file', '-t', block.reviewed_tree]) !== 'tree') moved.push(`reviewed_tree expected ${block.reviewed_tree} actual missing`);
  if (moved.length) {
    const lines = [`RETURN: handoff=${sha} status=refused steps=${block.from}-${block.to} head=${now.head} tree=${now.wtree}`,
      ...moved.map(m => resultLine('gstack-ship-budget', 'HANDOFF_PIN_MOVED', m)), `GSTACK_RESULT: skill=ship status=refused run=${parent.dir}`];
    writeReturnFile(block.return_file, lines);
    return { stdout: lines, exit: 3 };
  }
  const run = mintRunId();
  const dir = runDirFor(ctx.env, run);
  const child: Ledger = {
    schema_version: 1, kind: 'gstack-ship-budget', run, dir, file: path.join(dir, 'budget.json'), record: block.record, created_at: new Date().toISOString(),
    cap: parent.cap === null ? null : block.sub_cap, tail: 0, stop_overhead: parent.stop_overhead, delegate: parent.delegate, role: 'child',
    depth: h!.depth ?? (parent.depth ?? 0) + 1, ...(parent.call_floor !== undefined ? { call_floor: parent.call_floor } : {}),
    parent: { run: parent.run, ledger: parent.file, handoff_sha: sha, from: block.from, to: block.to, return_file: block.return_file },
    meter: { contract: parent.meter.contract, epoch: 1, baseline: parent.meter.contract.meter === 'capy' ? block.reading_at ?? 0 : 0, last: null,
      ...(parent.meter.contract.meter === 'claude' ? { sessions: [str(o, 'session') ?? ''], config_dir: parent.meter.config_dir } : {}) },
    epochs: [], carried_used: 0, estimate_used: 0, unknown: 0, next_id: 1, reservations: [], handoffs: [], cap_raises: [],
    marker: parent.marker, review_log: parent.review_log, calibration: parent.calibration,
  };
  if (parent.meter.contract.meter === 'claude' && !str(o, 'session')) throw usageError('verify-handoff on meter=claude needs --session <this child session id>');
  readMeter(child, o, true);
  writeLedger(child, ctx.env);
  pointMarker(child.marker, child);
  return { stdout: [`HANDOFF_OK: steps=${block.from}-${block.to} sha256=${sha}`, `BUDGET_RUN: id=${run} ledger=${child.file}`, budgetLine(child, { call: null, next: block.from, projected: 0, verdict: 'continue' })], exit: 0 };
}

export function cmdReturn(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['run', 'to', 'changed', 'status', 'reading']);
  const to = parseStep(str(o, 'to'), '--to');
  const status = str(o, 'status') ?? 'complete';
  if (!['complete', 'refused', 'incomplete'].includes(status)) throw usageError(`--status '${status}' is not complete, refused or incomplete`);
  return mutateLedger(ledgerFileFor({ run: str(o, 'run') }, ctx.env), ctx.env, l => {
    if (l.role !== 'child' || !l.parent) throw usageError(`run ${l.run} is not a child run`);
    readMeter(l, o, false);
    const head = git(ctx.cwd, ['rev-parse', 'HEAD']);
    const tree = pinsNow(ctx.cwd, 'HEAD', ctx.env).wtree;
    const accepted = new Set((l as any).accepted_skips as string[] | undefined ?? []);
    const unreconciled = l.handoffs.filter(h => !h.reconciled_at);
    const dropped = l.reservations.filter(r => r.remaining?.length && !accepted.has(r.id));
    const result = status === 'complete' && (unreconciled.length || dropped.length) ? 'incomplete' : status;
    const lines = [`RETURN: handoff=${l.parent.handoff_sha} status=${result} steps=${l.parent.from}-${to} head=${head} tree=${tree}`,
      ...unreconciled.map(h => `UNRECONCILED: handoff=${h.sha} steps=${h.from}-${h.to} (reconcile --run ${l.run} --return ${h.return_file} before returning)`),
      ...dropped.map(r => `DROPPED: step=${r.step} reservation=${r.id} roles=${r.remaining!.join(',')} (ADMIT named them; no later check requested them)`),
      `RECORD_CHANGED: ${str(o, 'changed') ?? 'none'}`, budgetLine(l, { call: null, next: '-', projected: 0, verdict: 'continue' }),
      `GSTACK_RESULT: skill=ship status=${result} run=${l.dir}`];
    writeReturnFile(l.parent.return_file, lines);
    l.closed_at = new Date().toISOString();
    return { stdout: lines, exit: 0 };
  });
}

/** Parse a child's return: at most 40 lines with RETURN and GSTACK_RESULT; undefined when it is not a return. */
export function parseReturn(text: string): { handoff: string; status: string; to: string; used: number | null } | undefined {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > RETURN_MAX_LINES) return undefined;
  const ret = /^RETURN: handoff=([0-9a-f]{64}) status=(\w+) steps=[\d.]+-([\d.]+)/.exec(lines[0] ?? '');
  if (!ret || !lines.some(line => line.startsWith('GSTACK_RESULT: skill=ship status='))) return undefined;
  const used = /^BUDGET: used=(\d+)/m.exec(text);
  return { handoff: ret[1]!, status: ret[2]!, to: ret[3]!, used: used ? Number(used[1]) : null };
}

export function cmdReconcile(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['run', 'record', 'return', 'handoff', 'reading', 'prior-reading']);
  return mutateLedger(ledgerFileFor({ run: str(o, 'run'), record: str(o, 'record') }, ctx.env), ctx.env, l => {
    const retFile = str(o, 'return');
    const text = retFile && fs.existsSync(retFile) ? fs.readFileSync(retFile, 'utf8') : undefined;
    const parsed = text ? parseReturn(text) : undefined;
    const sha = parsed?.handoff ?? str(o, 'handoff') ?? l.handoffs.find(x => x.return_file === (retFile && path.resolve(retFile)))?.sha;
    const h = l.handoffs.find(x => x.sha === sha);
    if (!h) throw usageError(`no handoff ${sha ?? '(none named)'} in run ${l.run}; pass --return <file> or --handoff <sha256>`);
    const exitFor = (s: string | undefined) => (s === 'complete' ? 0 : 3);
    if (h.reconciled_at) {
      return { stdout: [`RECONCILED: handoff=${h.sha} child=${h.status} child_used=${h.child_used} (already reconciled at ${h.reconciled_at}; nothing charged twice)`, budgetLine(l, { call: null, next: '-', projected: 0, verdict: 'continue' })], exit: exitFor(h.status) };
    }
    const own = !parsed && fs.existsSync(h.return_file) ? parseReturn(fs.readFileSync(h.return_file, 'utf8')) : undefined;
    const ret = parsed ?? (own?.handoff === h.sha ? own : undefined);
    const call = readMeter(l, o, true);
    const metered = h.reading_at !== null && h.epoch === l.meter.epoch && l.meter.last !== null;
    const childUsed = metered ? Math.max(0, l.meter.last! - h.reading_at!) : ret?.used ?? h.sub_cap;
    const r = l.reservations.find(x => x.id === h.reservation);
    if (r && (r.state === 'open' || r.state === 'consumed')) { r.state = 'settled'; r.settled_at = new Date().toISOString(); }
    if (l.meter.contract.meter === 'estimate') l.estimate_used += childUsed;
    h.status = ret && ret.to !== h.to && ret.status === 'complete' ? 'incomplete' : ret?.status ?? 'interrupted';
    h.child_used = childUsed;
    h.reconciled_at = new Date().toISOString();
    pointMarker(l.marker, l);
    const after = SHIP_STEPS[SHIP_STEPS.indexOf(h.to as any) + 1] ?? '-';
    const lines = [`RECONCILED: handoff=${h.sha} child=${h.status} child_used=${childUsed}`, budgetLine(l, { call, next: h.status === 'complete' ? after : h.from, projected: 0, verdict: h.status === 'complete' ? 'continue' : 'stop' })];
    if (h.status !== 'complete') lines.push(`NEXT: the child returned ${h.status}; regenerate the handoff (gstack-ship-budget handoff --run ${l.run} --from ${h.from} --to ${h.to} --base origin/<base>) or stop`);
    return { stdout: lines, exit: exitFor(h.status) };
  });
}

/** Explicit permissions for a headless child (build-spec r2 item 7, M1): edits and the shell, nothing broader. */
export const CHILD_PERMISSION_ARGS = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Grep,Glob'];

/** Claude Code: launch the child as a background headless session that answers through the return file. */
export function cmdLaunch(argv: string[], ctx: Ctx): Outcome {
  const o = parseArgs(argv, ['in']);
  const file = str(o, 'in');
  if (!file) throw usageError('launch needs --in <brief>');
  const block = handoffBlock(fs.readFileSync(file, 'utf8'));
  if (!block?.parent_ledger) throw budgetError('BUDGET_LEDGER_INVALID', `${file}: no gstack-handoff block`);
  const claude = resolveClaudeCommand(ctx.env);
  if (!claude) throw usageError('no claude binary resolves (PATH, GSTACK_CLAUDE_BIN); launch the child by hand or rerun with --delegate never');
  const session = crypto.randomUUID();
  const prompt = `Load gstack. Your Claude Code session id is ${session}. Run /ship --continue ${path.resolve(file)}: first gstack-ship-budget verify-handoff --in ${path.resolve(file)} --session ${session}, then only the steps the brief names, then gstack-ship-budget return as its return contract says.`;
  const log = path.join(path.dirname(block.return_file), `child-${session}.log`);
  joinMeter(block.parent_ledger, session, ctx.env);
  const out = fs.openSync(log, 'a', 0o600);
  const child = spawn(claude.command, [...claude.argsPrefix, '-p', '--session-id', session, ...CHILD_PERMISSION_ARGS, prompt], { cwd: ctx.cwd, env: ctx.env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  return { stdout: [`CHILD: session=${session} pid=${child.pid} log=${log} return=${block.return_file}`], exit: 0 };
}

/**
 * Claude Code: a child's session joins the meter of the run that launched it and
 * of every ancestor up the chain, so each run meters its whole subtree once.
 */
function joinMeter(file: string, session: string, env: NodeJS.ProcessEnv): void {
  for (let next: string | undefined = file; next;) {
    next = mutateLedger(next, env, l => {
      if (l.meter.contract.meter !== 'claude') return undefined;
      l.meter.sessions = [...new Set([...(l.meter.sessions ?? []), session])];
      const meter = path.join(l.dir, 'claude-meter.json');
      const state = loadMeterState(meter);
      if (state) { state.sessions = l.meter.sessions; saveMeterState(meter, state); }
      return l.parent?.ledger;
    });
  }
}
