import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promoteConductorEnv } from '../lib/conductor-env-shim';

describe('conductor-env-shim', () => {
  const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GSTACK_ANTHROPIC_API_KEY', 'GSTACK_OPENAI_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('promotes GSTACK_ANTHROPIC_API_KEY to ANTHROPIC_API_KEY when canonical is empty', () => {
    process.env.GSTACK_ANTHROPIC_API_KEY = 'sk-ant-test-123';
    promoteConductorEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-123');
  });

  test('promotes GSTACK_OPENAI_API_KEY to OPENAI_API_KEY when canonical is empty', () => {
    process.env.GSTACK_OPENAI_API_KEY = 'sk-oai-test-456';
    promoteConductorEnv();
    expect(process.env.OPENAI_API_KEY).toBe('sk-oai-test-456');
  });

  test('does not overwrite canonical when both canonical and GSTACK_-prefixed are set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-original';
    process.env.GSTACK_ANTHROPIC_API_KEY = 'sk-ant-prefixed';
    promoteConductorEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-original');
  });

  test('no-op when neither canonical nor GSTACK_-prefixed are set', () => {
    promoteConductorEnv();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});
