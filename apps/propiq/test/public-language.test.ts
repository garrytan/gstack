/**
 * Engineering vocabulary does not ship to a buyer.
 *
 * This product's honesty commitments are real and they produce real
 * provenance: a rule id, a scoring version, a constant that a figure was
 * counted from. All of that belongs in the report, the methodology page and
 * the API. None of it belongs as the *only* thing a buyer reads.
 *
 * Three of these had shipped at once: `NOT BUILT` as a status chip, a bare
 * `score.buyBand` as the entire explanation of a verdict, and a journey card
 * whose provenance line read `CURRENT_SCORING_VERSION.weights`. Each was
 * defensible in isolation and together they made the site read as a debug view
 * of itself.
 *
 * The rule: a term from the codebase may appear beside an explanation, never
 * instead of one.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.tsx') ? [full] : [];
  });

/**
 * Only what a visitor reads.
 *
 * Comments go first, then JSX text nodes. The `(?<![=!<>-])` is load-bearing:
 * without it `>=` and `=>` both read as a closing tag, and the extractor
 * "finds" every identifier that happens to sit after a comparison or an arrow.
 * That produced two false positives on its first run — an import list, and an
 * interpolation that renders a number rather than its name.
 */
const visibleText = (source: string): string => {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (withoutComments.match(/(?<![=!<>-])>[^<>{}();=]+</g) ?? []).join(' ');
};

const PAGES = walk(join(ROOT, 'src/app')).concat(walk(join(ROOT, 'src/components')));

describe('public copy', () => {
  it('finds pages to check', () => {
    expect(PAGES.length).toBeGreaterThan(40);
  });

  /** Internal status vocabulary, straight out of CLAUDE.md's own table. */
  it('never prints an internal feature status', () => {
    const offenders = PAGES.filter((f) => {
      const text = visibleText(readFileSync(f, 'utf-8'));
      return /\b(NOT BUILT|MOCK\/DEMO|BLOCKED BY DATA)\b/.test(text);
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('never prints an adapter name as if it meant something to a reader', () => {
    const offenders = PAGES.filter((f) => {
      const text = visibleText(readFileSync(f, 'utf-8'));
      return /\bfixture adapter\b|\bPROPIQ_DATA_ADAPTER\b/.test(text);
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  /**
   * A SCREAMING_SNAKE constant name reaching the page means a provenance line
   * was written for a contributor and left where a buyer would find it.
   */
  it('never prints a bare constant name as provenance', () => {
    const offenders = PAGES.filter((f) => {
      const text = visibleText(readFileSync(f, 'utf-8'));
      return /\b(SCORE_PILLARS|RISK_DIMENSIONS|SHORTLIST_LIMIT|ALERT_KINDS|NEGOTIATION_STATUSES|CURRENT_SCORING_VERSION|CHECKLIST)\b/.test(
        text,
      );
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe('a rule id travels with its meaning', () => {
  it('has a sentence for every deciding rule the engine can return', async () => {
    const { DECIDING_RULE_LABELS } = await import('@/domain/decision/engine');
    const engine = readFileSync(join(ROOT, 'src/domain/decision/engine.ts'), 'utf-8');

    // Every quoted rule id the engine hands to `decidingRule`.
    const ids = new Set(
      [...engine.matchAll(/'((?:risk|price|score)\.[A-Za-z]+)'/g)].map((m) => m[1] ?? ''),
    );
    expect(ids.size).toBeGreaterThan(3);

    for (const id of ids) {
      expect(DECIDING_RULE_LABELS[id], `${id} has no reader-facing label`).toBeTruthy();
    }
  });
});
