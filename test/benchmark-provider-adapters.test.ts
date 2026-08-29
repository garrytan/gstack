import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { isCapacityError, providerErrorDetail } from './helpers/providers/errors';
import { GptAdapter } from './helpers/providers/gpt';
import { geminiAuthReadiness } from './helpers/providers/gemini';

describe('benchmark provider hardening', () => {
  test('does not treat stored Gemini OAuth as non-interactive readiness', () => {
    const oauthOnly = geminiAuthReadiness(true, false);
    expect(oauthOnly.ok).toBe(false);
    expect(oauthOnly.reason).toContain('UNSUPPORTED_CLIENT');
    expect(geminiAuthReadiness(false, true)).toEqual({ ok: true });
    expect(geminiAuthReadiness(true, true)).toEqual({ ok: true });
  });

  test('recognizes model-capacity errors without confusing auth or quota failures', () => {
    expect(isCapacityError('Selected model is at capacity. Please try a different model')).toBe(true);
    expect(isCapacityError('The provider is overloaded right now')).toBe(true);
    expect(isCapacityError('Model temporarily unavailable due to high demand')).toBe(true);
    expect(isCapacityError('Error 401: login required')).toBe(false);
    expect(isCapacityError('429 quota exceeded')).toBe(false);
  });

  test('combines stderr and message without duplicating subprocess output', () => {
    const stderr = 'Selected model is at capacity.';
    expect(providerErrorDetail({ stderr: Buffer.from(stderr), message: `Command failed\n${stderr}` }))
      .toBe(`Command failed\n${stderr}`);
    expect(providerErrorDetail({ stderr: Buffer.from('stderr only'), message: 'message only' }))
      .toBe('stderr only\nmessage only');
  });

  test('Codex ignores inherited stdin and separates cached input tokens', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'helpers/providers/gpt.ts'), 'utf8');
    expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe']");

    const gpt = new GptAdapter();
    const parseJsonl = (gpt as unknown as {
      parseJsonl(raw: string): { tokens: { input: number; output: number; cached?: number } };
    }).parseJsonl.bind(gpt);
    const parsed = parseJsonl([
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21_155, cached_input_tokens: 9_984, output_tokens: 5 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 10 } }),
    ].join('\n'));
    expect(parsed.tokens).toEqual({ input: 11_221, cached: 10_134, output: 15 });
  });
});
