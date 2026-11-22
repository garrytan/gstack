/**
 * R116 (Garry, 2026-11-21): no gpt-4o or older-generation model in a role gstack chooses. These are the defaults the
 * eval-plan check cannot see because no preregistration names them: the design prototype's orchestrator, the Gemini
 * adapter's label for a run whose CLI reports no model, and context-bill's --exact model. A model counts as current when
 * lib/pricing.ts prices it and names no replacement (currentReplacement).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXACT_DEFAULT_MODEL } from '../lib/context-bill';
import { currentReplacement, hasPricing } from '../lib/pricing';
import { resultFromGeminiStream } from './helpers/providers/gemini';

const ROOT = path.resolve(import.meta.dir, '..');
const current = (model: string) => [model, hasPricing(model), currentReplacement(model)];

describe('defaults gstack chooses are the current generation (R116)', () => {
  test('the design prototype builds its request with design/src/models.ts, never a literal such as gpt-4o', () => {
    const src = fs.readFileSync(path.join(ROOT, 'design', 'prototype.ts'), 'utf8');
    expect(src).toContain('imageRequestBody(brief.prompt');
    expect(src).not.toMatch(/gpt-4o|model:/);
  });

  test('a Gemini run whose CLI reports no model is labelled and priced as a current model', () => {
    const label = resultFromGeminiStream('{"type":"message","role":"assistant","content":"PONG"}').modelUsed!;
    expect(current(label)).toEqual([label, true, null]);
    expect(resultFromGeminiStream('{"type":"init","model":"gemini-3.8-flash"}\n{"type":"message","role":"assistant","content":"PONG"}').modelUsed).toBe('gemini-3.8-flash');
  });

  test('context-bill --exact counts with a current model', () => {
    expect(current(EXACT_DEFAULT_MODEL)).toEqual([EXACT_DEFAULT_MODEL, true, null]);
  });
});
