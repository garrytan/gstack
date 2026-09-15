/**
 * Copilot pipeline tests.
 *
 * The model call itself is not exercised here — what matters is that the
 * context handed to it contains only already-computed figures, and that the
 * guard catches anything the model asserts beyond them.
 */

import { describe, expect, it } from 'vitest';

process.env.PROPIQ_DATA_ADAPTER = 'fixture';

import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { classifyIntent, selectComputed, MAX_QUESTION_LENGTH } from '@/ai/copilot';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { guardAnswer, renderComputedContext, renderEvidenceContext } from '@/ai/grounding';

const NOW = '2026-06-01T00:00:00.000Z';

const loadIntel = async (id = 'prop-nm-3a'): Promise<PropertyIntelligence> => {
  const intel = await buildPropertyIntelligence(asId<PropertyId>(id), { now: NOW });
  if (!intel) throw new Error('fixture property missing');
  return intel;
};

describe('classifyIntent', () => {
  it.each([
    ['Why is the score only 72?', 'explainScore'],
    ['Is it worth the asking price?', 'explainValuation'],
    ['What are the biggest risks here?', 'explainRisk'],
    ['What IRR would I get?', 'explainFinancials'],
    ['Should I buy this?', 'explainVerdict'],
    ['What should I do next?', 'nextActions'],
    ['What are the next steps?', 'nextActions'],
    ['What should I ask the builder?', 'nextActions'],
    ['Tell me about the neighbourhood', 'general'],
  ])('classifies %j as %s', (question, expected) => {
    expect(classifyIntent(question)).toBe(expected);
  });

  it('falls back to general rather than guessing', () => {
    expect(classifyIntent('qwerty asdf')).toBe('general');
  });
});

describe('selectComputed', () => {
  it('always includes the verdict, score and data status', async () => {
    const computed = selectComputed(await loadIntel(), 'general');
    expect(computed['decision.verdict']).toBeDefined();
    expect(computed['decision.decidingRule']).toBeDefined();
    expect(computed['score.version']).toBeDefined();
    expect(computed['property.dataStatus']).toBe('demo');
  });

  it('includes valuation figures for a valuation question', async () => {
    const computed = selectComputed(await loadIntel(), 'explainValuation');
    expect(computed['valuation.mid']).toBeDefined();
    expect(computed['valuation.askingDeviationPercent']).toBeDefined();
  });

  it('says so plainly when there is no valuation to explain', async () => {
    const thin = await loadIntel('prop-sv-2a');
    const computed = selectComputed(thin, 'explainValuation');
    expect(computed['valuation.status']).toContain('insufficient evidence');
    expect(computed['valuation.mid']).toBeUndefined();
  });

  it('includes risk drivers for a risk question', async () => {
    const computed = selectComputed(await loadIntel(), 'explainRisk');
    expect(Array.isArray(computed['risk.dimensions'])).toBe(true);
    expect(computed['risk.compositeBand']).toBeDefined();
  });

  it('withholds financial metrics when there is no rent estimate', async () => {
    const intel = await loadIntel();
    const noRent: PropertyIntelligence = {
      ...intel,
      investment: {
        ...intel.investment,
        base: {
          ...intel.investment.base,
          assumptions: { ...intel.investment.base.assumptions, monthlyRent: 0 },
        },
      },
    };
    const computed = selectComputed(noRent, 'explainFinancials');
    expect(computed['investment.status']).toContain('no rent estimate');
    expect(computed['investment.irrPercent']).toBeUndefined();
  });

  it('never leaks a commercial field into the model context', async () => {
    const computed = selectComputed(await loadIntel(), 'general');
    const serialised = JSON.stringify(computed);
    expect(serialised).not.toContain('paidPlacement');
    expect(serialised).not.toContain('commissionPossible');
  });
});

describe('grounded context', () => {
  it('carries every evidence field with its status and date', async () => {
    const intel = await loadIntel();
    const block = renderEvidenceContext(intel.property.evidence);
    expect(block).toContain('property.askingPrice');
    expect(block).toContain('status=demo');
    expect(block).toContain('observed=');
  });

  it('tells the model the computed figures are already calculated', async () => {
    const block = renderComputedContext(selectComputed(await loadIntel(), 'explainFinancials'));
    expect(block).toContain('do not recompute');
  });

  it('accepts an answer whose figures all appear in the context', async () => {
    const intel = await loadIntel();
    const context = `${renderEvidenceContext(intel.property.evidence)}\n\n${renderComputedContext(
      selectComputed(intel, 'explainValuation'),
    )}`;
    const answer = `The asking price is ${intel.property.askingPrice}.`;
    expect(guardAnswer(answer, context, 'test').grounded).toBe(true);
  });

  it('flags an answer that asserts a figure absent from the context', async () => {
    const intel = await loadIntel();
    const context = renderEvidenceContext(intel.property.evidence);
    const result = guardAnswer('It last sold for 98765432 rupees in 2019.', context, 'test');
    expect(result.grounded).toBe(false);
    expect(result.unsupportedClaims).toContain('98765432');
  });
});

describe('question bounds', () => {
  it('caps question length so a prompt cannot be padded without limit', () => {
    expect(MAX_QUESTION_LENGTH).toBeLessThanOrEqual(2000);
    expect(MAX_QUESTION_LENGTH).toBeGreaterThan(100);
  });
});
