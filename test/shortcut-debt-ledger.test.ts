/**
 * gstack-shortcut debt-ledger pins (free, static) — WS4.
 *
 * The convention has two halves that must stay joined:
 *   - WRITER: the AskUserQuestion Format preamble (generate-ask-user-format.ts)
 *     mandates the marker when a user accepts a Completeness ≤ 7 durable call:
 *     `gstack-shortcut(dec-<id>): <ceiling>, upgrade when <trigger>`.
 *   - HARVESTER: /retro Step 11.5 greps `gstack-shortcut(` into a debt ledger
 *     joined on the decision id.
 *
 * Nothing else pins either half (the golden ship fixtures are freshness
 * checks — a deliberate deletion regenerates them and passes). A drift where
 * the writer changes the marker shape while the harvester greps the old one
 * silently empties the ledger, so the joint is asserted here explicitly.
 * The marker's redaction-guard survival is pinned in redact-engine.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

/** The canonical marker prefix both halves must agree on. */
const MARKER = 'gstack-shortcut(';

describe('writer: AUQ format preamble mandates the marker', () => {
  const resolver = read('scripts/resolvers/preamble/generate-ask-user-format.ts');

  test('resolver emits the full marker grammar and its guardrails', () => {
    expect(resolver).toContain('gstack-shortcut(dec-<id>): <ceiling>, upgrade when <trigger>');
    // User-sovereignty guardrail: the marker is never agent-initiated.
    expect(resolver).toContain('Never agent-initiated');
    // The trail is joined to the decision store, not free-floating.
    expect(resolver).toContain('gstack-decision-log');
    // Scope guard: turn-level choices never leave debt markers.
    expect(resolver).toContain('never a turn-level choice');
  });

  test('rendered tier-2+ skeletons carry the trail rule (always-loaded, like the AUQ format itself)', () => {
    for (const skill of ['plan-ceo-review', 'ship', 'retro']) {
      const body = read(`${skill}/SKILL.md`);
      expect(body).toContain('Accepted shortcuts leave a trail');
      expect(body).toContain('gstack-shortcut(dec-<id>)');
    }
  });
});

describe('harvester: /retro Step 11.5 debt ledger', () => {
  const tmpl = read('retro/SKILL.md.tmpl');
  const rendered = read('retro/SKILL.md');

  test('template ships the ledger step, and generation carries it into SKILL.md', () => {
    for (const body of [tmpl, rendered]) {
      expect(body).toContain('### Step 11.5: Shortcut Debt Ledger');
      expect(body).toContain(`grep -rn "${MARKER}"`);
      // Zero markers is the healthy case — the step must say so, not fail.
      expect(body).toContain('No shortcut debt. Clean ledger.');
      expect(body).toContain('N markers, M with no trigger.');
    }
  });

  test('the harvest grep excludes convention docs; ledger rows join decisions and name the rot taxonomy', () => {
    const step = tmpl.split('### Step 11.5')[1]?.split('### Step 12')[0] ?? '';
    for (const excl of [
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '--exclude-dir=vendor',
      '--exclude-dir=.claude',
      '--exclude-dir=dist',
      '--exclude="SKILL.md"',
      '--exclude="*.md.tmpl"',
    ]) {
      expect(step).toContain(excl);
    }
    // Zero matches must not fail the pipeline the step runs in.
    expect(step).toContain('|| true');
    // Rows join the decision store and tag the two ways a marker rots.
    expect(step).toContain('gstack-decision-search');
    expect(step).toContain('`unlinked`');
    expect(step).toContain('`no-trigger`');
    expect(step).toContain('never double-count');
  });
});

describe('the joint: writer grammar matches harvester grep', () => {
  test('what the harvester greps is a prefix of what the writer mandates', () => {
    const resolver = read('scripts/resolvers/preamble/generate-ask-user-format.ts');
    const tmpl = read('retro/SKILL.md.tmpl');
    // Harvester pattern, extracted from the actual grep line.
    const grepLine = tmpl.split('\n').find((l) => l.includes('grep -rn'));
    expect(grepLine).toBeDefined();
    const m = /grep -rn "([^"]+)"/.exec(grepLine!);
    expect(m).not.toBeNull();
    const harvested = m![1];
    expect(harvested).toBe(MARKER);
    // Writer's mandated grammar starts with exactly that prefix.
    expect(resolver).toContain(`\`${MARKER}dec-<id>)`);
  });

  test('review checklist suppression and simplification specialist both honor the marker (acknowledged debt is not a finding)', () => {
    expect(read('review/checklist.md')).toContain('gstack-shortcut(dec-*)');
    expect(read('review/specialists/simplification.md')).toContain('gstack-shortcut(dec-*)');
  });
});
