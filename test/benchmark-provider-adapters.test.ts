import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resultFromCodexStream } from './helpers/providers/gpt';
import { GeminiAdapter } from './helpers/providers/gemini';
import { estimateCostUsd } from './helpers/pricing';
import { formatMarkdown, formatTable, type BenchmarkReport } from './helpers/benchmark-runner';

describe('Codex token accounting', () => {
  const turn = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21_155, cached_input_tokens: 9_984, output_tokens: 5 } });

  test('cached input is split out of input_tokens and priced at the cache-read rate', () => {
    const result = resultFromCodexStream(turn, { model: 'gpt-5.4' });
    expect(result.tokens).toEqual({ input: 11_171, cached: 9_984, output: 5 });
    // gpt-5.4: $2.50/MTok uncached, 10% of that for cache reads, $10/MTok output.
    expect(estimateCostUsd(result.tokens, 'gpt-5.4')).toBeCloseTo(0.030474, 5);
  });

  test('turns accumulate both buckets', () => {
    const second = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 10 } });
    expect(resultFromCodexStream(`${turn}\n${second}`).tokens).toEqual({ input: 11_221, cached: 10_134, output: 15 });
  });

  test('reports show new and cached input', () => {
    const report: BenchmarkReport = {
      prompt: 'p', workdir: '/tmp', startedAt: '2026-10-07T00:00:00Z', durationMs: 1,
      entries: [{ provider: 'gpt', family: 'gpt', available: true, result: resultFromCodexStream(turn, { model: 'gpt-5.4' }), costUsd: 0.03 }],
    };
    expect(formatTable(report)).toContain('11171+9984→5');
    expect(formatMarkdown(report)).toContain('11171+9984→5');
  });
});

describe('Gemini availability', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-avail-'));
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'gemini'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, '.gemini'));
    fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{}');
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  // Bun fixes os.homedir() at startup, so each check runs in a child with the temp HOME.
  function availability(extraEnv: Record<string, string> = {}): { ok: boolean; reason?: string } {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, ...extraEnv };
    delete env.GOOGLE_API_KEY;
    if (!extraEnv.GEMINI_API_KEY) delete env.GEMINI_API_KEY;
    const script = `const { GeminiAdapter } = await import(${JSON.stringify(path.join(import.meta.dir, 'helpers/providers/gemini.ts'))}); console.log(JSON.stringify(await new GeminiAdapter().available()));`;
    const child = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf-8', timeout: 30_000 });
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout.trim().split('\n').pop()!);
  }

  test('stored OAuth alone is not ready and names the API key fix', () => {
    const check = availability();
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('stored Gemini OAuth');
    expect(check.reason).toContain('GEMINI_API_KEY');
  });

  test('an API key is ready', () => {
    expect(availability({ GEMINI_API_KEY: 'fixture-not-a-key' })).toEqual({ ok: true });
  });
});
