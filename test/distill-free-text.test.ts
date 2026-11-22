/**
 * gstack-distill-free-text — Layer 8 dream cycle (plan-tune cathedral T10).
 *
 * Covers the SDK-free paths: status, dry-run, rate cap, no-event handling.
 * The real API call path is exercised by the E2E test in T16; here we
 * verify the bin's deterministic plumbing without burning tokens.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-distill-free-text');
const QLOG_BIN = path.join(ROOT, 'bin', 'gstack-question-log');

let stateRoot: string;
let fixtureCwd: string;
let cwdSlug: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-dist-'));
  cwdSlug = 'distill-fixture';
  fixtureCwd = path.join(stateRoot, cwdSlug);
  fs.mkdirSync(fixtureCwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function makeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  delete env.GSTACK_HOME;
  return { ...env, ...extra };
}

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(BIN, args, {
    env: makeEnv(),
    encoding: 'utf-8',
    cwd: fixtureCwd,
    timeout: 30_000,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

function writeAuqOtherEvent(text: string): void {
  spawnSync(
    QLOG_BIN,
    [
      JSON.stringify({
        skill: 'plan-tune',
        question_id: 'hook-distill00',
        question_summary: 'Test question for distillation',
        options_count: 2,
        user_choice: 'Other',
        source: 'auq-other',
        free_text: text,
        session_id: 's-distill',
        tool_use_id: 'tu-distill-' + Math.random().toString(36).slice(2, 8),
      }),
    ],
    {
      env: makeEnv(),
      cwd: fixtureCwd,
      encoding: 'utf-8',
      timeout: 30_000,
    },
  );
}

function writeCostLogEntry(slug: string, dateIso: string): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.appendFileSync(
    path.join(stateRoot, 'distill-cost.jsonl'),
    JSON.stringify({ ts: dateIso, slug, proposals_count: 0, cost_usd_est: 0 }) + '\n',
  );
}

// ----------------------------------------------------------------------
// Status subcommand
// ----------------------------------------------------------------------

describe('--status', () => {
  test('reports "no runs yet" when cost log absent', () => {
    const r = run(['--status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no distill runs/);
  });

  test('reports counts when prior runs exist', () => {
    writeCostLogEntry(cwdSlug, new Date().toISOString());
    writeCostLogEntry(cwdSlug, new Date().toISOString());
    const r = run(['--status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('RUNS: 2');
    expect(r.stdout).toMatch(/TODAY: 2 run\(s\)/);
  });
});

// ----------------------------------------------------------------------
// No rate cap (v1.52.0.0 cap audit) — the natural rate of free-text events
// is rare enough that count-based capping was theatrical. Cost log alone
// provides auditability via --status.
// ----------------------------------------------------------------------

describe('no rate cap (audit removed)', () => {
  test('never exits with RATE_CAPPED, even with many runs today', () => {
    const today = new Date().toISOString();
    for (let i = 0; i < 10; i++) writeCostLogEntry(cwdSlug, today);
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/RATE_CAPPED/);
  });
});

// ----------------------------------------------------------------------
// No events / no log
// ----------------------------------------------------------------------

describe('no-event paths', () => {
  test('exits NO_LOG when question-log.jsonl missing', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/NO_LOG/);
  });

  test('exits NO_FREE_TEXT when log has events but none are auq-other', () => {
    spawnSync(
      QLOG_BIN,
      [
        JSON.stringify({
          skill: 'plan-tune',
          question_id: 'hook-other00',
          question_summary: 'Q',
          options_count: 2,
          user_choice: 'A',
          source: 'hook',
          session_id: 's',
          tool_use_id: 'tu-x',
        }),
      ],
      { env: makeEnv(), cwd: fixtureCwd, encoding: 'utf-8', timeout: 30_000 },
    );
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/NO_FREE_TEXT/);
  });
});

// ----------------------------------------------------------------------
// Dry-run
// ----------------------------------------------------------------------

describe('--dry-run', () => {
  test('emits the distill prompt + events JSON without calling API', () => {
    writeAuqOtherEvent('I always include tests with new features');
    writeAuqOtherEvent('Skip design review for typo fixes');
    // Strip ANTHROPIC_API_KEY to prove no API call happens.
    const env = makeEnv();
    delete env.ANTHROPIC_API_KEY;
    const res = spawnSync(BIN, ['--dry-run'], { env, cwd: fixtureCwd, encoding: 'utf-8', timeout: 30_000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('DISTILL PROMPT');
    expect(res.stdout).toContain('always include tests');
  });
});

// ----------------------------------------------------------------------
// API key required
// ----------------------------------------------------------------------

describe('API auth', () => {
  test('fails loud when ANTHROPIC_API_KEY missing on sync run', () => {
    writeAuqOtherEvent('Some free text response that needs distilling');
    const env = makeEnv();
    delete env.ANTHROPIC_API_KEY;
    const res = spawnSync(BIN, [], { env, cwd: fixtureCwd, encoding: 'utf-8', timeout: 30_000 });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(res.stderr).toMatch(/separate billing/);
  });
});

// ----------------------------------------------------------------------
// Background spawn
// ----------------------------------------------------------------------

describe('--background', () => {
  test('detaches and exits with DISTILL_SPAWNED', () => {
    const r = run(['--background']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DISTILL_SPAWNED: pid=\d+/);
  });
});

// ----------------------------------------------------------------------
// Egress receipt (#4617): the typed answers leave the machine, so the
// send writes a receipt first, fail-closed. A local stand-in for the
// Anthropic API (ANTHROPIC_BASE_URL) records what the ledger held when
// the request arrived.
// ----------------------------------------------------------------------

describe('egress receipt', () => {
  const ledgerPath = () => path.join(stateRoot, 'security', 'egress.jsonl');
  const ledgerRecords = (): Array<Record<string, unknown>> =>
    fs.existsSync(ledgerPath())
      ? fs.readFileSync(ledgerPath(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

  async function distillAgainstStub(): Promise<{ status: number; stderr: string; requests: Array<Array<Record<string, unknown>>> }> {
    const requests: Array<Array<Record<string, unknown>>> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        await req.text();
        requests.push(ledgerRecords());
        return Response.json({
          id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub',
          content: [{ type: 'text', text: '{"proposals": []}' }],
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    });
    try {
      const proc = Bun.spawn({
        cmd: [BIN],
        env: makeEnv({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` }),
        cwd: fixtureCwd,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      return { status, stderr, requests };
    } finally {
      server.stop(true);
    }
  }

  test('writes a content-free distill-free-text receipt before the model call', async () => {
    writeAuqOtherEvent('please never ask me about design review on typo fixes');
    const r = await distillAgainstStub();
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.length).toBe(1);
    const atSend = r.requests[0].filter((rec) => rec.type === 'egress' && rec.sink === 'distill-free-text');
    expect(atSend.length).toBe(1);
    expect(atSend[0].host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(atSend[0].payload_class).toContain('count=1');
    expect(atSend[0].sha256).toBeNull();
    const ledger = fs.readFileSync(ledgerPath(), 'utf-8');
    expect(ledger).not.toContain('typo fixes');
    expect(ledger).not.toContain('test-key');
    expect(ledgerRecords().some((rec) => rec.type === 'outcome')).toBe(true);
  });

  test('refuses the send when the receipt cannot be written (fail-closed)', async () => {
    writeAuqOtherEvent('ship small PRs please');
    fs.writeFileSync(path.join(stateRoot, 'security'), 'not a directory');
    const r = await distillAgainstStub();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('EGRESS_RECEIPT_FAILED');
    expect(r.requests.length).toBe(0);
    const log = fs.readFileSync(path.join(stateRoot, 'projects', cwdSlug, 'question-log.jsonl'), 'utf-8');
    expect(log).not.toContain('distilled_at');
  });
});

