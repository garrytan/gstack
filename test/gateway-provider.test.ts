import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GatewayAdapter, GATEWAY_MODELS, gatewayEnvironment, foreignModels } from './helpers/providers/gateway';
import { PROVIDER_NAMES, isProviderName } from './helpers/providers/registry';
import { familyConflict, modelFamily } from '../lib/outside-voice-runner';
import { estimateCostUsd, hasPricing } from '../lib/pricing';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-provider-'));
const savedBin = process.env.GSTACK_CLAUDE_BIN;
afterEach(() => {
  if (savedBin === undefined) delete process.env.GSTACK_CLAUDE_BIN;
  else process.env.GSTACK_CLAUDE_BIN = savedBin;
});

/** A stand-in claude CLI: records its env and prints a result envelope billing FAKE_MODELS. */
function fakeClaude(): string {
  const bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'cat > /dev/null',
    'env > "$FAKE_ENV_OUT"',
    'printf \'{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":2,"usage":{"input_tokens":1000,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":7},"modelUsage":{%s}}\' "$FAKE_MODELS"',
  ].join('\n') + '\n', { mode: 0o755 });
  return bin;
}

describe('gateway provider', () => {
  test('the child env drops every Anthropic credential and pins all aliases to the arm model', () => {
    const env = gatewayEnvironment('particle-ai/particle-1', { PATH: '/bin', OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'sk-ant', GSTACK_ANTHROPIC_API_KEY: 'sk-ant-2', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
    expect(Object.values(env).filter((v) => /sk-ant|oauth/.test(v))).toEqual([]);
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('particle-ai/particle-1');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('particle-ai/particle-1');
    expect(env.PATH).toBe('/bin');
    expect(gatewayEnvironment('m', { OPENROUTER_API_KEY: 'k', GSTACK_GATEWAY_BASE_URL: 'https://ai-gateway.vercel.sh' }).ANTHROPIC_BASE_URL).toBe('https://ai-gateway.vercel.sh');
  });

  test('a run through the adapter reaches claude without the Anthropic key and reports usage at our prices', async () => {
    process.env.GSTACK_CLAUDE_BIN = fakeClaude();
    const envOut = path.join(tmp, 'env-ok.txt');
    const adapter = new GatewayAdapter('particle', { PATH: process.env.PATH, HOME: tmp, OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'sk-ant-real', FAKE_ENV_OUT: envOut, FAKE_MODELS: '"particle-ai/particle-1":{}' });
    const result = await adapter.run({ prompt: 'hi', workdir: tmp, timeoutMs: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.modelUsed).toBe('particle-ai/particle-1');
    expect(result.tokens).toEqual({ input: 1000, output: 10, cached: 50, cacheWrite: 7 });
    const childEnv = fs.readFileSync(envOut, 'utf-8');
    expect(childEnv).not.toContain('sk-ant-real');
    expect(childEnv).toContain('ANTHROPIC_AUTH_TOKEN=sk-or');
    expect(adapter.estimateCost(result.tokens, result.modelUsed)).toBe(+((1000 * 0.25 + 10 * 1.0 + 50 * 0.03) / 1e6).toFixed(6));
  });

  test('a run that billed another model is a MODEL_MIX error, not a result', async () => {
    process.env.GSTACK_CLAUDE_BIN = fakeClaude();
    const adapter = new GatewayAdapter('deepseek', { PATH: process.env.PATH, HOME: tmp, OPENROUTER_API_KEY: 'sk-or', FAKE_ENV_OUT: path.join(tmp, 'env-mix.txt'), FAKE_MODELS: '"deepseek/deepseek-v4.1-flash-1017":{},"claude-haiku-5-5":{}' });
    const result = await adapter.run({ prompt: 'hi', workdir: tmp, timeoutMs: 10_000 });
    expect(result.error?.reason).toBe('MODEL_MIX: the run also billed claude-haiku-5-5');
    expect(foreignModels('particle-ai/particle-1', ['particle-1', 'PARTICLE-AI/particle-1'])).toEqual([]);
  });

  test('available() names the missing key with a fix', async () => {
    process.env.GSTACK_CLAUDE_BIN = fakeClaude();
    const check = await new GatewayAdapter('particle', { PATH: process.env.PATH }).available();
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('OPENROUTER_API_KEY is not set');
    expect((await new GatewayAdapter('particle', { PATH: process.env.PATH, OPENROUTER_API_KEY: 'k' }).available()).ok).toBe(true);
  });

  test('the registry lists the gateway providers once, by name', () => {
    expect(PROVIDER_NAMES).toEqual(['claude', 'gpt', 'gemini', 'particle', 'deepseek']);
    expect(isProviderName('particle')).toBe(true);
    expect(isProviderName('toString')).toBe(false);
    expect(GATEWAY_MODELS).toEqual({ particle: 'particle-ai/particle-1', deepseek: 'deepseek/deepseek-v4.1-flash-1017' });
  });

  test('particle-1 is DeepSeek family, so it is never an independent voice beside DeepSeek', () => {
    for (const id of ['particle-ai/particle-1', 'particle/particle-1', 'particle-1', 'Particle-AI/Particle-1']) expect(modelFamily(id)).toBe('deepseek');
    expect(modelFamily('particle-ai/particle-2')).toBe('unknown');
    expect(familyConflict('particle-ai/particle-1', 'deepseek/deepseek-v4.1-flash-1017')).toBeDefined();
    expect(familyConflict('particle-ai/particle-1', 'claude-opus-5-5')).toBeUndefined();
  });

  test('every panel and gateway id is priced', () => {
    for (const id of ['particle-ai/particle-1', 'particle/particle-1', 'particle-1', 'deepseek/deepseek-v4.1-flash-1017', 'claude-opus-5-5', 'claude-sonnet-5-5']) expect(hasPricing(id)).toBe(true);
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000, cached: 1_000_000 }, 'deepseek/deepseek-v4.1-flash-1017')).toBeCloseTo(0.15 + 0.6 + 0.003, 6);
  });
});
