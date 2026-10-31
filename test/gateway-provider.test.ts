import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GatewayAdapter, GATEWAY_MODELS, gatewayEnvironment, foreignModels } from './helpers/providers/gateway';
import { PROVIDER_NAMES, isProviderName } from './helpers/providers/registry';
import { PANEL_ARMS, cellCostUsd } from './helpers/model-panel-harness';
import { familyConflict, modelFamily } from '../lib/outside-voice-runner';
import { estimateCostUsd, hasPricing } from '../lib/pricing';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-provider-'));
const savedBin = process.env.GSTACK_CLAUDE_BIN;
const savedArgs = process.env.GSTACK_CLAUDE_BIN_ARGS;
afterEach(() => {
  if (savedBin === undefined) delete process.env.GSTACK_CLAUDE_BIN;
  else process.env.GSTACK_CLAUDE_BIN = savedBin;
  if (savedArgs === undefined) delete process.env.GSTACK_CLAUDE_BIN_ARGS;
  else process.env.GSTACK_CLAUDE_BIN_ARGS = savedArgs;
});

/** A stand-in claude CLI run by bun (so it works on Windows): records its env and prints a result envelope billing FAKE_MODELS. */
function fakeClaude(): string {
  const script = path.join(tmp, 'fake-claude.js');
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    "if (process.env.FAKE_ARGS_OUT) fs.writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));",
    "fs.writeFileSync(process.env.FAKE_ENV_OUT, Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n') + '\\n');",
    "if (process.env.FAKE_ERROR) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })); process.exit(0); }",
    "const modelUsage = JSON.parse('{' + (process.env.FAKE_MODELS || '') + '}');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 2, usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 }, modelUsage }));",
  ].join('\n') + '\n');
  process.env.GSTACK_CLAUDE_BIN_ARGS = JSON.stringify([script]);
  return process.execPath;
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
    expect(adapter.estimateCost(result.tokens, result.modelUsed)).toBeCloseTo((1000 * 0.25 + 10 * 1.0 + 50 * 0.03 + 7 * 0.25) / 1e6, 5);
    const particleArm = PANEL_ARMS.find(a => a.id === 'particle')!;
    expect(adapter.estimateCost(result.tokens, result.modelUsed)).toBe(cellCostUsd(particleArm, { input: 1000, output: 10, cached: 50, cacheWrite: 7, modelsBilled: [], isError: false, apiErrorStatus: null, turns: 2 }));
  });

  test('a run that billed another model is a MODEL_MIX error, not a result', async () => {
    process.env.GSTACK_CLAUDE_BIN = fakeClaude();
    const adapter = new GatewayAdapter('deepseek', { PATH: process.env.PATH, HOME: tmp, OPENROUTER_API_KEY: 'sk-or', FAKE_ENV_OUT: path.join(tmp, 'env-mix.txt'), FAKE_MODELS: '"deepseek/deepseek-v4.1-flash-1017":{},"claude-haiku-5-5":{}' });
    const result = await adapter.run({ prompt: 'hi', workdir: tmp, timeoutMs: 10_000 });
    expect(result.error?.reason).toBe('MODEL_MIX: the run also billed claude-haiku-5-5');
    expect(foreignModels('particle-ai/particle-1', ['particle-1', 'PARTICLE-AI/particle-1'])).toEqual([]);
  });

  test('gateway runs load no Claude Code settings, so a settings.json key never reaches the gateway', async () => {
    process.env.GSTACK_CLAUDE_BIN = fakeClaude();
    const argsOut = path.join(tmp, 'args.json');
    await new GatewayAdapter('particle', { PATH: process.env.PATH, HOME: tmp, OPENROUTER_API_KEY: 'sk-or', FAKE_ENV_OUT: path.join(tmp, 'env-args.txt'), FAKE_ARGS_OUT: argsOut, FAKE_MODELS: '"particle-ai/particle-1":{}' }).run({ prompt: 'hi', workdir: tmp, timeoutMs: 10_000 });
    const argv: string[] = JSON.parse(fs.readFileSync(argsOut, 'utf-8'));
    const at = argv.indexOf('--setting-sources');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('');
  });

  test('an error envelope from the gateway is an error, not a benchmark result', async () => {
    process.env.GSTACK_CLAUDE_BIN = fakeClaude();
    const adapter = new GatewayAdapter('particle', { PATH: process.env.PATH, HOME: tmp, OPENROUTER_API_KEY: 'sk-or', FAKE_ENV_OUT: path.join(tmp, 'env-err.txt'), FAKE_ERROR: '1' });
    const result = await adapter.run({ prompt: 'hi', workdir: tmp, timeoutMs: 10_000 });
    expect(result.error?.reason).toMatch(/empty or invalid output/);
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
