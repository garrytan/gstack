#!/usr/bin/env bun
/**
 * CEO-2 / CEO-6 acceptance for the /autoplan guard's bounded journal read:
 * build a synthetic parent journal around one real /autoplan invocation, keep
 * appending to it while the guard runs, and measure one hook call (read plus
 * evaluation) in a fresh process: wall milliseconds and peak RSS.
 *
 *   bun scripts/measure-journal-read.ts [--runs N] [--json] [--strict]
 *
 * Two journals, 120 MiB each:
 * - `mixed`: many records of mixed size (assistant text, Bash and Read pairs,
 *   hook attachments), about 10% before the invocation and the rest inside it.
 * - `large-invocation`: a current invocation of many small records.
 * Acceptance (CEO-2): at most 1000 ms and 256 MiB peak RSS on a 4-vCPU Linux
 * runner, with an allow decision. macOS numbers are recorded, not gated
 * (CEO-6). `--strict` exits 1 on a miss. `--measure` and `--append` are the
 * per-run child modes; `--build <benchmark>` writes one journal and prints its
 * metadata path, for profiling.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

const MiB = 1024 * 1024;
const BUDGET_MS = 1000, BUDGET_RSS_MIB = 256;
type Row = { type: string; message?: Record<string, unknown>; extra?: Record<string, unknown> };
type RowMaker = (rnd: () => number, i: number) => Row;
/** Shares of the journal: before /autoplan (`head`), inside its phase work, and after the close Read. */
interface Benchmark { name: string; bytes: number; headShare: number; afterCloseShare: number; head: RowMaker; window: RowMaker }

/** Deterministic, so every runner measures the same journal. */
function random(seed: number) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }
const pad = (n: number) => 'x'.repeat(Math.max(0, Math.round(n)));
/** The envelope Claude Code writes on every assistant message (model, usage), so record sizes match real journals. */
const assistant = (i: number, content: unknown[]): Row => ({ type: 'assistant', message: { id: `msg_pad${i}`, type: 'message', role: 'assistant',
  model: 'claude-opus-4-1-20250805', content, stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 4, cache_creation_input_tokens: 812, cache_read_input_tokens: 48213, output_tokens: 312, service_tier: 'standard' } },
  extra: { requestId: `req_pad${i}`, userType: 'external', gitBranch: 'main' } });

function mixedRow(rnd: () => number, i: number): Row {
  const p = rnd(), id = `toolu_pad${i}`;
  if (p < 0.4) return assistant(i, [{ type: 'text', text: pad(300 + rnd() * 900) }]);
  if (p < 0.55) return assistant(i, [{ type: 'tool_use', id, name: 'Bash', input: { command: `ls ${pad(40)}` } }]);
  if (p < 0.7) return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}b`, content: pad(300 + rnd() * 2700), is_error: false }] },
    extra: { toolUseResult: { stdout: pad(100), stderr: '' } } };
  if (p < 0.78) {
    const content = pad(4000 + rnd() * 36000);
    return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}r`, content }] },
      extra: { toolUseResult: { type: 'text', file: { filePath: '/repo/src/file.ts', content, numLines: 400, startLine: 1, totalLines: 400 } } } };
  }
  return { type: 'attachment', extra: { attachment: { type: 'hook_success', hookEvent: 'PostToolUse', content: pad(150 + rnd() * 300) } } };
}

function smallRow(rnd: () => number, i: number): Row {
  const p = rnd(), id = `toolu_small${i}`;
  if (p < 0.35) return assistant(i, [{ type: 'text', text: pad(40 + rnd() * 160) }]);
  if (p < 0.6) return assistant(i, [{ type: 'tool_use', id, name: 'Grep', input: { pattern: 'x' } }]);
  if (p < 0.85) return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}g`, content: pad(20 + rnd() * 200), is_error: false }] } };
  return { type: 'attachment', extra: { attachment: { type: 'hook_success', hookEvent: 'PostToolUse', content: pad(50) } } };
}

const BENCHMARKS: Benchmark[] = [
  { name: 'mixed', bytes: 120 * MiB, headShare: 0.1, afterCloseShare: 0.02, head: mixedRow, window: mixedRow },
  // ENG-5: a current invocation of many small records (about 60k), after an ordinary mixed history.
  { name: 'large-invocation', bytes: 120 * MiB, headShare: 0.6, afterCloseShare: 0.01, head: mixedRow, window: smallRow },
];

/** Build one journal: a published Phase 1 and the Phase 2 entry Read as the current, journaled call. */
async function build(bench: Benchmark) {
  const { guardFixture, section } = await import('../test/helpers/autoplan-guard-fixture');
  const f = guardFixture('ceo');
  f.publish();
  f.use('next', 'Read', { file_path: section('design-phase.md') });
  const step = (id: string) => f.steps.findIndex(s => s.kind === 'result' && s.id === id);
  const head = bench.bytes * bench.headShare, after = bench.bytes * bench.afterCloseShare, window = bench.bytes - head - after;
  const rnd = random(bench.name.length);
  let i = 0, records = 0;
  const fill = (budget: number, row: RowMaker) => {
    const rows: Row[] = [];
    // About 300 bytes of per-record metadata (uuid, parent, cwd, session, version, timestamp) join each row.
    for (let used = 0; used < budget; i++) { const r = row(rnd, i); rows.push(r); used += JSON.stringify(r).length + 300; }
    records += rows.length;
    return rows;
  };
  // An earlier typed conversation that ended its turn; then /autoplan's phase work after init and after the
  // entry Read; then a little after the close Read.
  const earlier = (): Row[] => [{ type: 'user', message: { role: 'user', content: 'Review the retry change first.' },
    extra: { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() } }, ...fill(head, bench.head),
    { type: 'assistant', message: { role: 'assistant', id: 'msg_earlier_end', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } }];
  f.journal(f.steps.length, at => at === -1 ? earlier() : at === step('init') || at === step('entry') ? fill(window / 2, bench.window)
    : at === step('close') ? fill(after, bench.window) : []);
  const input = f.input('next', 'Read', { file_path: section('design-phase.md') });
  const meta = path.join(f.cwd, 'measure.json');
  fs.writeFileSync(meta, JSON.stringify({ input, cwd: f.cwd, stateRoot: f.stateRoot }));
  return { f, meta, records };
}

/** Child: one hook call in a fresh process; peak RSS is this process's own. */
async function measure(meta: string) {
  const { input, cwd, stateRoot } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const { runPublicationHook } = await import('../autoplan/bin/phase-publication-hook.ts');
  const root = fs.realpathSync(path.join(import.meta.dir, '..'));
  process.env.CLAUDE_PROJECT_DIR = cwd; process.env.GSTACK_STATE_ROOT = stateRoot; process.env.GSTACK_HOME = stateRoot;
  const started = performance.now();
  const output: any = await runPublicationHook(input, root);
  const wallMs = performance.now() - started;
  const decision = output?.hookSpecificOutput?.permissionDecision === 'deny' ? `deny: ${output.hookSpecificOutput.permissionDecisionReason}`
    : output?.systemMessage ? `unverified: ${output.systemMessage}` : 'allow';
  // resourceUsage().maxRSS is in kilobytes on Linux and macOS.
  process.stdout.write(JSON.stringify({ wallMs: Math.round(wallMs), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), decision }) + '\n');
}

/** Child: Claude Code keeps writing while the guard reads (progress records outside the conversation chain). */
function append(file: string) {
  const fd = fs.openSync(file, 'a');
  let n = 0;
  const tick = () => {
    fs.writeSync(fd, JSON.stringify({ type: 'progress', uuid: randomUUID(), parentUuid: randomUUID(), isSidechain: false,
      sessionId: path.basename(file, '.jsonl'), cwd: path.dirname(file), timestamp: new Date().toISOString(), data: pad(800), n: n++ }) + '\n');
    setTimeout(tick, 1);
  };
  tick();
}

async function child(args: string[], timeoutMs: number) {
  const proc = Bun.spawn([process.execPath, import.meta.path, ...args], { stdout: 'pipe', stderr: 'inherit' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const text = await new Response(proc.stdout).text();
  clearTimeout(timer);
  if ((await proc.exited) !== 0) throw new Error(`measure child failed: ${args.join(' ')}`);
  return JSON.parse(text.trim());
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--measure') return measure(argv[1]!);
  if (argv[0] === '--append') return append(argv[1]!);
  if (argv[0] === '--build') { const built = await build(BENCHMARKS.find(b => b.name === argv[1])!); return console.log(built.meta); }
  const requested = argv.includes('--runs') ? Number(argv[argv.indexOf('--runs') + 1]) : 3;
  const runs = Number.isInteger(requested) && requested > 0 ? requested : 3;
  const results = [];
  for (const bench of BENCHMARKS) {
    const built = await build(bench);
    try {
      for (let run = 1; run <= runs; run++) {
        const before = fs.statSync(built.f.transcript).size;
        const appender = Bun.spawn([process.execPath, import.meta.path, '--append', built.f.transcript], { stdout: 'ignore', stderr: 'inherit' });
        await Bun.sleep(50);
        try {
          const measured = await child(['--measure', built.meta], 60_000);
          results.push({ benchmark: bench.name, run, journalMiB: Number((before / MiB).toFixed(1)), records: built.records,
            appendedBytes: fs.statSync(built.f.transcript).size - before, ...measured,
            pass: measured.wallMs <= BUDGET_MS && measured.peakRssMiB <= BUDGET_RSS_MIB && measured.decision === 'allow' });
        } finally { appender.kill(); await appender.exited; }
      }
    } finally { built.f.cleanup(); }
  }
  const platform = { os: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, bun: Bun.version };
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ platform, budget: { ms: BUDGET_MS, rssMiB: BUDGET_RSS_MIB }, results }, null, 2) + '\n');
  else {
    console.log(`# Journal read measurement (${platform.os}, ${platform.arch}, ${platform.cpus} vCPU, Bun ${platform.bun})`);
    console.log('| benchmark | run | journal MiB | records | appended bytes | wall ms | peak RSS MiB | decision | verdict |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of results) console.log(`| ${r.benchmark} | ${r.run} | ${r.journalMiB} | ${r.records} | ${r.appendedBytes} | ${r.wallMs} | ` +
      `${r.peakRssMiB} | ${r.decision.slice(0, 60)} | ${r.pass ? 'PASS' : 'MISS'} |`);
  }
  if (argv.includes('--strict') && results.some(r => !r.pass)) process.exit(1);
}

await main();
