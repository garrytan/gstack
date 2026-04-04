/**
 * Tests for LLM judge cache + tier integration.
 * Mocks Anthropic client to avoid API calls.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpCacheDir: string;
const origEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-judge-test-'));
  // Point cache to temp dir and clear tier env vars
  origEnv.GSTACK_STATE_DIR = process.env.GSTACK_STATE_DIR;
  origEnv.EVAL_JUDGE_TIER = process.env.EVAL_JUDGE_TIER;
  origEnv.EVAL_TIER = process.env.EVAL_TIER;
  origEnv.EVAL_CACHE = process.env.EVAL_CACHE;
  process.env.GSTACK_STATE_DIR = tmpCacheDir;
  delete process.env.EVAL_JUDGE_TIER;
  delete process.env.EVAL_TIER;
  delete process.env.EVAL_CACHE;
});

afterEach(() => {
  // Restore env
  for (const [key, val] of Object.entries(origEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  try { fs.rmSync(tmpCacheDir, { recursive: true, force: true }); } catch {}
});

// Test cache key computation directly (doesn't need mock)
describe('cache key computation', () => {
  test('computeCacheKey produces consistent hashes for same input', async () => {
    const { computeCacheKey } = await import('../../lib/eval-cache');
    const key1 = computeCacheKey([], 'claude-sonnet-4-6:test prompt');
    const key2 = computeCacheKey([], 'claude-sonnet-4-6:test prompt');
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
  });

  test('cache key differs when model changes', async () => {
    const { computeCacheKey } = await import('../../lib/eval-cache');
    const key1 = computeCacheKey([], 'claude-sonnet-4-6:test prompt');
    const key2 = computeCacheKey([], 'claude-haiku-4-5:test prompt');
    expect(key1).not.toBe(key2);
  });

  test('cache key differs when prompt changes', async () => {
    const { computeCacheKey } = await import('../../lib/eval-cache');
    const key1 = computeCacheKey([], 'claude-sonnet-4-6:prompt A');
    const key2 = computeCacheKey([], 'claude-sonnet-4-6:prompt B');
    expect(key1).not.toBe(key2);
  });
});

// Test cache read/write directly
describe('cache read/write for llm-judge suite', () => {
  test('cacheRead returns null on miss', async () => {
    const { cacheRead } = await import('../../lib/eval-cache');
    expect(cacheRead('llm-judge', 'nonexistent')).toBeNull();
  });

  test('cacheWrite + cacheRead round-trip', async () => {
    const { cacheRead, cacheWrite } = await import('../../lib/eval-cache');
    const data = { clarity: 5, completeness: 4, actionability: 5, reasoning: 'test' };
    cacheWrite('llm-judge', 'test-key', data, { model: 'claude-sonnet-4-6' });
    const cached = cacheRead('llm-judge', 'test-key');
    expect(cached).toEqual(data);
  });

  test('EVAL_CACHE=0 bypasses cache read', async () => {
    const { cacheRead, cacheWrite } = await import('../../lib/eval-cache');
    cacheWrite('llm-judge', 'bypass-key', { test: true });
    process.env.EVAL_CACHE = '0';
    expect(cacheRead('llm-judge', 'bypass-key')).toBeNull();
  });
});

// Test tier resolution
describe('tier resolution for judge', () => {
  test('defaults to standard (sonnet) when no env set', async () => {
    const { resolveJudgeTier, tierToModel } = await import('../../lib/eval-tier');
    expect(resolveJudgeTier()).toBe('standard');
    expect(tierToModel(resolveJudgeTier())).toBe('claude-sonnet-4-6');
  });

  test('EVAL_JUDGE_TIER=haiku selects fast tier', async () => {
    process.env.EVAL_JUDGE_TIER = 'haiku';
    // Need fresh import to pick up env change
    const { resolveJudgeTier, tierToModel } = await import('../../lib/eval-tier');
    expect(resolveJudgeTier()).toBe('fast');
    expect(tierToModel(resolveJudgeTier())).toBe('claude-haiku-4-5');
  });

  test('EVAL_JUDGE_TIER=opus selects full tier', async () => {
    process.env.EVAL_JUDGE_TIER = 'opus';
    const { resolveJudgeTier, tierToModel } = await import('../../lib/eval-tier');
    expect(resolveJudgeTier()).toBe('full');
    expect(tierToModel(resolveJudgeTier())).toBe('claude-opus-4-6');
  });
});

// Test JudgeMeta shape
describe('JudgeMeta interface', () => {
  test('exported from llm-judge module', async () => {
    const mod = await import('./llm-judge');
    // Verify callJudge and judge are exported functions
    expect(typeof mod.callJudge).toBe('function');
    expect(typeof mod.judge).toBe('function');
    expect(typeof mod.outcomeJudge).toBe('function');
  });
});
