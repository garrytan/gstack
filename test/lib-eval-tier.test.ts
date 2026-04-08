/**
 * Tests for lib/eval-tier.ts — model tier selection.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { resolveTier, resolveJudgeTier, tierToModel, TIER_ALIASES } from '../lib/eval-tier';

describe('lib/eval-tier', () => {
  const origEvalTier = process.env.EVAL_TIER;
  const origJudgeTier = process.env.EVAL_JUDGE_TIER;

  afterEach(() => {
    if (origEvalTier === undefined) delete process.env.EVAL_TIER;
    else process.env.EVAL_TIER = origEvalTier;
    if (origJudgeTier === undefined) delete process.env.EVAL_JUDGE_TIER;
    else process.env.EVAL_JUDGE_TIER = origJudgeTier;
  });

  describe('resolveTier', () => {
    test('defaults to standard when unset', () => {
      delete process.env.EVAL_TIER;
      expect(resolveTier()).toBe('standard');
    });

    test('resolves tier names directly', () => {
      process.env.EVAL_TIER = 'fast';
      expect(resolveTier()).toBe('fast');
      process.env.EVAL_TIER = 'full';
      expect(resolveTier()).toBe('full');
    });

    test('resolves model aliases', () => {
      process.env.EVAL_TIER = 'haiku';
      expect(resolveTier()).toBe('fast');
      process.env.EVAL_TIER = 'sonnet';
      expect(resolveTier()).toBe('standard');
      process.env.EVAL_TIER = 'opus';
      expect(resolveTier()).toBe('full');
    });

    test('is case-insensitive', () => {
      process.env.EVAL_TIER = 'HAIKU';
      expect(resolveTier()).toBe('fast');
      process.env.EVAL_TIER = 'Full';
      expect(resolveTier()).toBe('full');
    });

    test('defaults to standard for unknown value', () => {
      process.env.EVAL_TIER = 'gpt-4';
      expect(resolveTier()).toBe('standard');
    });
  });

  describe('resolveJudgeTier', () => {
    test('falls back to EVAL_TIER when EVAL_JUDGE_TIER unset', () => {
      delete process.env.EVAL_JUDGE_TIER;
      process.env.EVAL_TIER = 'fast';
      expect(resolveJudgeTier()).toBe('fast');
    });

    test('uses EVAL_JUDGE_TIER when set', () => {
      process.env.EVAL_TIER = 'fast';
      process.env.EVAL_JUDGE_TIER = 'full';
      expect(resolveJudgeTier()).toBe('full');
    });

    test('resolves aliases for judge tier', () => {
      process.env.EVAL_JUDGE_TIER = 'opus';
      expect(resolveJudgeTier()).toBe('full');
    });
  });

  describe('tierToModel', () => {
    test('maps fast to haiku', () => {
      expect(tierToModel('fast')).toBe('claude-haiku-4-5');
    });

    test('maps standard to sonnet', () => {
      expect(tierToModel('standard')).toBe('claude-sonnet-4-6');
    });

    test('maps full to opus', () => {
      expect(tierToModel('full')).toBe('claude-opus-4-6');
    });
  });

  describe('TIER_ALIASES', () => {
    test('contains expected aliases', () => {
      expect(TIER_ALIASES.haiku).toBe('fast');
      expect(TIER_ALIASES.sonnet).toBe('standard');
      expect(TIER_ALIASES.opus).toBe('full');
    });
  });
});
