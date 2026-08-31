/**
 * Multi-provider benchmark adapter E2E — hit real claude, codex, gemini CLIs.
 *
 * Periodic tier: runs under `bun run test:e2e` with EVALS=1. Each provider gated
 * on its own `available()` check so missing auth skips that provider (doesn't
 * abort the batch). Uses the simplest possible prompt ("Reply with exactly: ok")
 * to keep cost near $0.001/provider/run.
 *
 * What this catches that unit tests don't:
 *   - CLI output-format drift (the #1 silent breakage path)
 *   - Token parsing from real provider responses
 *   - Auth-failure vs timeout vs rate-limit error code routing
 *   - Cost estimation on real token counts
 *   - Parallel execution via Promise.allSettled — slow provider doesn't block fast
 *
 * NOT covered here (would need dedicated test files):
 *   - Quality judge integration (benchmark-judge.ts, adds ~$0.05/run)
 *   - Multi-turn tool-using prompts — our single-turn smoke skips `toolCalls > 0`
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { ClaudeAdapter } from './helpers/providers/claude';
import { GptAdapter } from './helpers/providers/gpt';
import { GeminiAdapter } from './helpers/providers/gemini';
import { runBenchmark } from './helpers/benchmark-runner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Prerequisites / gating ---

const evalsEnabled = !!process.env.EVALS;
// External-service tests are periodic-tier (CLAUDE.md tiering rule 3) —
// the header above says so, but without a whole-file guard the sharded gate
// runner still selects this file into gate. The positive form below is the
// canonical guard shape classifyPaidTestFile greps for.
const tierOk = process.env.EVALS_TIER === 'periodic';
const describeIfEvals = evalsEnabled && tierOk ? describe : describe.skip;
if (evalsEnabled && !tierOk) {
  process.stderr.write('\nbenchmark-providers: SKIPPED — external-service test, periodic tier only\n');
}

const PROMPT = 'Reply with exactly this text and nothing else: ok';

// Per-provider gate — each test checks its own availability and skips cleanly.
// We construct adapters outside `test` so Bun's test reporter shows the skip reason.
const claude = new ClaudeAdapter();
const gpt = new GptAdapter();
const gemini = new GeminiAdapter();

// Use a temp working directory so provider CLIs can't accidentally touch the repo.
// Created in beforeAll / cleaned in afterAll so concurrent CI runs don't leak.
let workdir: string;

describeIfEvals('multi-provider benchmark adapters (live)', () => {
  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-e2e-'));
  });

  afterAll(() => {
    if (workdir && fs.existsSync(workdir)) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('claude: available() returns structured ok/reason', async () => {
    const check = await claude.available();
    expect(check).toHaveProperty('ok');
    if (!check.ok) {
      expect(typeof check.reason).toBe('string');
      expect(check.reason!.length).toBeGreaterThan(0);
    }
  });

  test('gpt: available() returns structured ok/reason', async () => {
    const check = await gpt.available();
    expect(check).toHaveProperty('ok');
    if (!check.ok) {
      expect(typeof check.reason).toBe('string');
    }
  });

  test('gemini: available() returns structured ok/reason', async () => {
    const check = await gemini.available();
    expect(check).toHaveProperty('ok');
    if (!check.ok) {
      expect(typeof check.reason).toBe('string');
    }
  });

  test('claude: trivial prompt produces parseable output', async () => {
    const check = await claude.available();
    if (!check.ok) {
      process.stderr.write(`\nclaude live smoke: SKIPPED — ${check.reason}\n`);
      return;
    }
    const result = await claude.run({ prompt: PROMPT, workdir, timeoutMs: JUDGE_MS });
    if (result.error) {
      throw new Error(`claude errored: ${result.error.code} — ${result.error.reason}`);
    }
    expect(result.output.toLowerCase()).toContain('ok');
    expect(result.tokens.input).toBeGreaterThan(0);
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.modelUsed).toBe('string');
    expect(result.modelUsed.length).toBeGreaterThan(0);
    const cost = claude.estimateCost(result.tokens, result.modelUsed);
    expect(cost).toBeGreaterThan(0);
  }, CAPTURE_MS);

  test('gpt: trivial prompt produces parseable output', async () => {
    const check = await gpt.available();
    if (!check.ok) {
      process.stderr.write(`\ngpt live smoke: SKIPPED — ${check.reason}\n`);
      return;
    }
    const result = await gpt.run({ prompt: PROMPT, workdir, timeoutMs: JUDGE_MS });
    if (result.error) {
      throw new Error(`gpt errored: ${result.error.code} — ${result.error.reason}`);
    }
    expect(result.output.toLowerCase()).toContain('ok');
    expect(result.tokens.input).toBeGreaterThan(0);
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.modelUsed).toBe('string');
    const cost = gpt.estimateCost(result.tokens, result.modelUsed);
    expect(cost).toBeGreaterThan(0);
  }, CAPTURE_MS);

  test('gemini: trivial prompt produces parseable output', async () => {
    const check = await gemini.available();
    if (!check.ok) {
      process.stderr.write(`\ngemini live smoke: SKIPPED — ${check.reason}\n`);
      return;
    }
    const result = await gemini.run({ prompt: PROMPT, workdir, timeoutMs: JUDGE_MS });
    if (result.error) {
      // auth / rate_limit are ENVIRONMENT conditions the test can't act on
      // (e.g. Google deprecated the individual code-assist auth path — the
      // adapter classifies "no longer supported" as auth). A live smoke
      // reports them as a skip, not a false adapter failure. timeout/unknown
      // still fail: those are the drift classes this test exists to catch.
      if (result.error.code === 'auth' || result.error.code === 'rate_limit') {
        process.stderr.write(`\ngemini live smoke: SKIPPED — ${result.error.code}: ${result.error.reason.slice(0, 160)}\n`);
        return;
      }
      throw new Error(`gemini errored: ${result.error.code} — ${result.error.reason}`);
    }
    // Adapter must never report empty-success (#2159). After content/stats
    // parsing, a healthy run has non-empty assistant text + token counts.
    expect(result.output.trim().length).toBeGreaterThan(0);
    expect(result.output.toLowerCase()).toContain('ok');
    expect(result.tokens.input).toBeGreaterThan(0);
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.modelUsed).toBe('string');
    expect(result.modelUsed.length).toBeGreaterThan(0);
  }, CAPTURE_MS);

  test('timeout error surfaces as error.code=timeout (no exception)', async () => {
    // Use whatever adapter is available first — all three should share timeout semantics.
    const adapter = (await claude.available()).ok ? claude
      : (await gpt.available()).ok ? gpt
      : (await gemini.available()).ok ? gemini
      : null;
    if (!adapter) {
      process.stderr.write('\ntimeout smoke: SKIPPED — no provider available\n');
      return;
    }
    // 100ms timeout is far too short for any real CLI startup → must timeout.
    const result = await adapter.run({ prompt: PROMPT, workdir, timeoutMs: 100 });
    expect(result.error).toBeDefined();
    // Timeout, binary_missing, or unknown (if CLI dies differently) — all acceptable
    // non-crash outcomes. The point is the adapter returns a RunResult, not throws.
    expect(['timeout', 'unknown', 'binary_missing']).toContain(result.error!.code);
    expect(result.durationMs).toBeGreaterThan(0);
  }, 30_000);

  test('runBenchmark: Promise.allSettled means one unavailable provider does not block others', async () => {
    // Use the full runner with all three providers — whichever are unauthed should
    // return entries with available=false and not crash the batch.
    const report = await runBenchmark({
      prompt: PROMPT,
      workdir,
      providers: ['claude', 'gpt', 'gemini'],
      timeoutMs: JUDGE_MS,
      skipUnavailable: false,
    });
    expect(report.entries).toHaveLength(3);
    for (const e of report.entries) {
      expect(['claude', 'gpt', 'gemini']).toContain(e.family);
      if (e.available) {
        expect(e.result).toBeDefined();
      } else {
        expect(typeof e.unavailable_reason).toBe('string');
      }
    }
    // At least one available provider should have produced a non-error result in a healthy CI env.
    const hadSuccess = report.entries.some(e => e.available && e.result && !e.result.error);
    // We don't hard-assert this: if NO providers are authed, skip silently.
    if (!hadSuccess) {
      process.stderr.write('\nrunBenchmark live: no provider produced a clean result (no auth?)\n');
    }
  }, CAPTURE_MS);
});
