/**
 * Multi-provider benchmark adapter E2E — hit real claude, codex, gemini CLIs.
 *
 * Periodic tier: runs under `bun run test:e2e` with EVALS=1. Each provider gated
 * on its own `available()` check so missing auth skips that provider (doesn't
 * abort the batch). Uses the simplest possible prompt ("Reply with exactly: ok")
 * to keep cost near $0.001/provider/run.
 *
 * What this catches that unit tests don't:
 *   - CLI invocation drift (a flag rename or trust-prompt change breaking a run)
 *   - Auth-failure vs timeout vs rate-limit error code routing
 *   - The adapter terminates without throwing and returns plain-text output
 *
 * NOT covered here (would need dedicated test files):
 *   - Quality judge integration (autoevals ClosedQA, opt-in)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ClaudeAdapter } from '../lib/model-benchmark/providers/claude';
import { GptAdapter } from '../lib/model-benchmark/providers/gpt';
import { GeminiAdapter } from '../lib/model-benchmark/providers/gemini';
import { runProviderBenchmark } from '../lib/model-benchmark/braintrust-eval';
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
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.modelUsed).toBe('string');
    expect(result.modelUsed.length).toBeGreaterThan(0);
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
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.modelUsed).toBe('string');
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
    // Gemini CLI can return empty output on otherwise-successful runs in some
    // environments. This smoke is about "did the adapter wire up and terminate
    // without throwing" — assert the shape, not the content.
    expect(typeof result.output).toBe('string');
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

  test('runProviderBenchmark: an unauthed/failing provider returns a result, never throws', async () => {
    // Braintrust owns orchestration now. The property we care about: a provider
    // that's unavailable or errors comes back as a ProviderBenchmark (score null,
    // ops carrying the error) instead of throwing and aborting the batch.
    const cases = [{ id: 'smoke', input: PROMPT, required: ['ok'] }];
    const results = await Promise.all(
      (['claude', 'gpt', 'gemini'] as const).map(p => runProviderBenchmark(p, cases, { timeoutMs: 120_000 })),
    );
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(['claude', 'gpt', 'gemini']).toContain(r.provider);
      expect(r.score === null || (typeof r.score === 'number' && r.score >= 0 && r.score <= 1)).toBe(true);
      expect(Array.isArray(r.ops)).toBe(true);
    }
    const hadSuccess = results.some(r => typeof r.score === 'number' && r.ops.some(o => !o.error));
    if (!hadSuccess) {
      process.stderr.write('\nbenchmark live: no provider produced a clean result (no auth?)\n');
    }
  }, 300_000);
});
