/**
 * `gstack-autoplan run` with the api runner for both voices (GBRA-223 claim 6):
 * a complete autoplan result (INPUT receipt plus the findings fence) binds and
 * the run reaches its gate; a response stopped at the output limit is named
 * truncated and interrupts the run. The provider is a local server, so no key
 * or network is used.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MAX_TOKENS } from '../lib/outside-voice-api';
import { AUTOPLAN, ROOT, SMALL_PLAN, env } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-run-api-'));
let mode: 'ok' | 'cut' | 'bad-outside' | 'hang' = 'ok';
let calls = 0;
let openaiLimits: unknown[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      if (mode === 'hang') { await Bun.sleep(5000); return new Response('late', { status: 504 }); }
      const body = await req.json();
      const prompt = String(body.messages[0].content);
      const m = /INPUT: ([a-z]+) ([0-9a-f]{64})/.exec(prompt.slice(prompt.lastIndexOf('RESULT FORMAT')))!;
      const text = mode === 'cut'
        ? `INPUT: ${m[1]} ${m[2]}\n\nA long review that ran out of output tokens before the findings fen`
        : `INPUT: ${m[1]} ${m[2]}\n\nComplete review.\n\n\`\`\`gstack-findings\n{"id":"F1","severity":"Medium","title":"Name the retry metric","fix":"add retries_total"}\n\`\`\`\n`;
      if (new URL(req.url).pathname.endsWith('/messages')) return Response.json({ model: body.model, stop_reason: mode === 'cut' ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } });
      openaiLimits.push(body.max_completion_tokens);
      return Response.json({ model: body.model, choices: [{ finish_reason: mode === 'cut' ? 'length' : 'stop', message: { content: mode === 'bad-outside' ? `INPUT: ${m[1]} ${m[2]}\n\nA review with no findings fence.` : text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    },
  });
});
afterAll(() => { server.stop(true); fs.rmSync(TMP, { recursive: true, force: true }); });

async function run(name: string, extra: string[] = [], keys: Record<string, string> = { ANTHROPIC_API_KEY: 'ak-test', OPENAI_API_KEY: 'sk-test' }) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.md'), SMALL_PLAN);
  const out = path.join(dir, 'run');
  const base = `http://127.0.0.1:${server.port}`;
  const proc = Bun.spawn(['bun', AUTOPLAN, 'run', '--out', out, '--plan', path.join(dir, 'plan.md'), '--no-ui', '--no-dx', '--native-model', 'anthropic/claude-opus-5-5', '--outside-model', 'openai/gpt-6-astra', '--runner', 'api', '--native-runner', 'api', ...extra], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: env({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ...keys, ANTHROPIC_BASE_URL: base, OPENAI_BASE_URL: `${base}/v1`, GSTACK_AUTOPLAN_CHECKPOINT_DIR: '', GSTACK_STATE_ROOT: path.join(TMP, 'state') }),
  });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
  const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  return { status, stdout, stderr, out, state: fs.existsSync(path.join(out, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')) : null };
}

describe('gstack-autoplan run --native-runner api --runner api', () => {
  test('a complete result binds both voices in every phase and the run reaches its gate', async () => {
    mode = 'ok';
    const r = await run('ok');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`GSTACK_RESULT: skill=autoplan status=gate_pending run=${r.out}`);
    for (const phase of ['ceo', 'eng']) for (const voice of ['native', 'outside']) expect(r.state.phases[phase][voice]).toMatchObject({ status: 'completed', findings: 1 });
  }, 150_000);

  test('a spend cap binds api attempts at their priced worst case and settles them at their usage', async () => {
    mode = 'ok';
    openaiLimits = [];
    const r = await run('capped', ['--spend-cap', '8']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`GSTACK_RESULT: skill=autoplan status=gate_pending run=${r.out}`);
    expect(r.stdout).not.toMatch(/^ESTIMATE:/m);
    const ledger = JSON.parse(fs.readFileSync(path.join(r.out, 'spend.json'), 'utf8'));
    expect(ledger.reserved).toEqual([]);
    expect(ledger.settled.length).toBe(4);
    for (const s of ledger.settled) expect(s.usd).toBeGreaterThan(0);
    expect(openaiLimits.length).toBeGreaterThan(0);
    for (const limit of openaiLimits) expect(limit).toBe(DEFAULT_MAX_TOKENS);
    calls = 0;
    const zero = await run('zero-cap', ['--spend-cap', '0']);
    expect(zero.status).toBe(3);
    expect(zero.stdout + zero.stderr).toContain('SPEND_CAP_EXCEEDED');
    expect(calls).toBe(0);
  }, 150_000);

  test('an outside result with no findings fence leaves the run native-only instead of aborting it', async () => {
    mode = 'bad-outside';
    const r = await run('bad-outside');
    expect(r.status, r.stderr).toBe(0);
    expect(r.state.status).toBe('gate_pending');
    expect(r.state.phases.ceo.outside.status).toBe('unavailable');
    expect(r.state.phases.ceo.native).toMatchObject({ status: 'completed', findings: 1 });
  }, 150_000);

  test('--max-tokens needs a positive integer', async () => {
    const r = await run('max0', ['--max-tokens', '0']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--max-tokens needs a positive integer');
    expect(r.state).toBeNull();
  }, 30_000);

  test('a response stopped at the output limit is named truncated and interrupts the run', async () => {
    mode = 'cut';
    const r = await run('cut');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/native voice unavailable: truncated: .*output limit/);
    expect(r.state.status).toBe('interrupted');
  }, 150_000);

  test('a truncated call settles what it cost, and a retry with a larger output limit is admitted afresh against the cap', async () => {
    mode = 'cut';
    const first = await run('cut-retry', ['--spend-cap', '8']);
    expect(first.state.status).toBe('interrupted');
    const truncated = first.state.phases.ceo.native.attempts[0].attempt;
    const ledger = JSON.parse(fs.readFileSync(path.join(first.out, 'spend.json'), 'utf8'));
    expect(ledger.reserved.map((r: any) => r.attempt)).not.toContain(truncated);
    expect(ledger.settled.find((s: any) => s.attempt === truncated).usd).toBeGreaterThan(0);
    mode = 'ok';
    calls = 0;
    const retry = await run('cut-retry', ['--spend-cap', '8', '--max-tokens', '2000000']);
    expect(retry.status).toBe(3);
    expect(retry.stdout + retry.stderr).toContain('SPEND_CAP_EXCEEDED');
    expect(calls).toBe(0);
  }, 150_000);

  test('a call refused before any request leaves charges nothing: with no key the attempt stays open and the rerun reuses it at the cap that admitted it', async () => {
    mode = 'ok';
    calls = 0;
    const first = await run('no-key', ['--spend-cap', '8'], { OPENAI_API_KEY: 'sk-test' });
    expect(first.state.status).toBe('interrupted');
    expect(calls).toBe(0);
    const open = first.state.phases.ceo.native.attempts[0];
    expect(open.state).toBe('dispatched');
    expect(JSON.parse(fs.readFileSync(path.join(first.out, 'spend.json'), 'utf8')).settled).toEqual([]);
    const retry = await run('no-key', ['--spend-cap', '8']);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain(`GSTACK_RESULT: skill=autoplan status=gate_pending run=${retry.out}`);
    expect(retry.state.phases.ceo.native.attempts.map((a: any) => a.attempt)).toEqual([open.attempt]);
    const ledger = JSON.parse(fs.readFileSync(path.join(retry.out, 'spend.json'), 'utf8'));
    expect(ledger.settled.length).toBe(4);
    expect(ledger.released ?? []).toEqual([]);
    for (const s of ledger.settled) expect(s.label).toMatch(/^(ceo|eng)\/(native|outside)$/);
  }, 150_000);

  test('a call that was sent and timed out with no usage is charged its reservation, so the cap binds on the rerun', async () => {
    mode = 'hang';
    const first = await run('timed-out', ['--spend-cap', '8', '--deadline', '0.02']);
    expect(first.state.status).toBe('interrupted');
    const sent = first.state.phases.ceo.native.attempts[0];
    expect(sent.state).toBe('superseded');
    const ledger = JSON.parse(fs.readFileSync(path.join(first.out, 'spend.json'), 'utf8'));
    expect(ledger.reserved.map((r: any) => r.attempt)).not.toContain(sent.attempt);
    expect(ledger.settled.find((s: any) => s.attempt === sent.attempt).usd).toBe('unknown');
  }, 150_000);
});
