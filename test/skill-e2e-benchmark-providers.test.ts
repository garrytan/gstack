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
import { ClaudeAdapter } from './helpers/providers/claude';
import { GptAdapter } from './helpers/providers/gpt';
import { GeminiAdapter } from './helpers/providers/gemini';
import { runBenchmark } from './helpers/benchmark-runner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Prerequisites / gating ---

const evalsEnabled = !!process.env.EVALS;
const describeIfEvals = evalsEnabled ? describe : describe.skip;

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
    const result = await claude.run({ prompt: PROMPT, workdir, timeoutMs: 120_000 });
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
  }, 150_000);

  test('gpt: trivial prompt produces parseable output', async () => {
    const check = await gpt.available();
    if (!check.ok) {
      process.stderr.write(`\ngpt live smoke: SKIPPED — ${check.reason}\n`);
      return;
    }
    const result = await gpt.run({ prompt: PROMPT, workdir, timeoutMs: 120_000 });
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
  }, 150_000);

  test('gemini: trivial prompt produces parseable output', async () => {
    const check = await gemini.available();
    if (!check.ok) {
      process.stderr.write(`\ngemini live smoke: SKIPPED — ${check.reason}\n`);
      return;
    }
    const result = await gemini.run({ prompt: PROMPT, workdir, timeoutMs: 120_000 });
    if (result.error) {
      throw new Error(`gemini errored: ${result.error.code} — ${result.error.reason}`);
    }
    expect(result.output.toLowerCase()).toContain('ok');
    // Gemini CLI sometimes returns 0 tokens in the result event (older responses);
    // assert non-negative instead of strictly positive.
    expect(result.tokens.input).toBeGreaterThanOrEqual(0);
    expect(result.tokens.output).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.modelUsed).toBe('string');
  }, 150_000);

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
      timeoutMs: 120_000,
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
  }, 300_000);
});
