/** CEO-3 + DX-1: every guard outcome has a stable code, a disposition, honest text and a documented anchor. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REASONS, REMOVED_CODES, FALLBACK, GUIDE, anchor, reasonText } from '../autoplan/bin/guard-reasons';

const ROOT = path.join(import.meta.dir, '..');
const hook = fs.readFileSync(path.join(ROOT, 'autoplan/bin/phase-publication-hook.ts'), 'utf8');
const guide = fs.readFileSync(path.join(ROOT, 'docs/autoplan-guard-troubleshooting.md'), 'utf8');
const sample = { phase: 1, keys: ['model'], cause: 'A cause', size: '40 MiB', limit: '32 MiB' };

describe('guard reason inventory', () => {
  test('every fail() and denied() site in the hook names a code from the table', () => {
    const sites = [...hook.matchAll(/\b(?:fail|denied)\('([^']+)'/g)].map(m => m[1]!);
    expect(sites.length).toBeGreaterThan(40);
    for (const code of sites) expect(Object.keys(REASONS)).toContain(code);
    // No free-text denial survives outside the table.
    expect(hook).not.toMatch(/\bfail\((?:`|")/);
    expect(hook).not.toMatch(/reason: '[A-Z]/);
  });

  test('no denial advises a retry; transients say what to wait for; fallbacks print the runnable fallback', () => {
    for (const [code, reason] of Object.entries(REASONS)) {
      const text = reasonText(code, sample, '2.1.292');
      expect({ code, retry: /\bretry/i.test(text) }).toEqual({ code, retry: false });
      expect(text).toContain(`(code ${code}, Claude Code 2.1.292)`);
      expect(text).toContain(`${GUIDE}#${anchor(code)}`);
      if (reason.disposition === 'transient') expect(text).toMatch(/\bWait for\b/);
      if (reason.disposition === 'fallback') expect(text).toContain(FALLBACK);
      if (reason.disposition === 'unverified') expect(text).toContain('Phase-report enforcement was skipped for this call');
      if (reason.disposition === 'corrective') expect(text).not.toContain(FALLBACK);
    }
    expect(FALLBACK).toContain('/plan-ceo-review, then /plan-devex-review, then /plan-eng-review');
    expect(FALLBACK).toContain('/context-save');
    expect(FALLBACK).toContain('/context-restore, then /autoplan <plan path>');
  });

  test('UC1 classes: Claude Code states are unverified, integrity failures stay denials', () => {
    const unverified = Object.entries(REASONS).filter(([, r]) => r.disposition === 'unverified').map(([c]) => c).sort();
    expect(unverified).toEqual(['journal_lag', 'rewritten', 'too_large', 'unrecognized_shape', 'unseen_version']);
    for (const integrity of ['dispatch_prompt', 'agent_key', 'current_mismatch', 'cross_phase_batch', 'identity', 'snapshot',
      'competing_root', 'foreign_cwd', 'sidechain', 'agent', 'cycle']) expect(REASONS[integrity as keyof typeof REASONS].disposition).toBe('fallback');
    expect(REASONS.publication_missing.disposition).toBe('corrective');
    expect(reasonText('agent_key', { keys: ['model'] })).toContain('A model override is not allowed for /autoplan reviewer dispatch');
  });

  test('the troubleshooting page has one anchor per code (removed codes keep theirs) and keeps the no-override line', () => {
    for (const code of [...Object.keys(REASONS), ...REMOVED_CODES]) expect({ code, anchored: guide.includes(`<a id="${anchor(code)}"></a>`) }).toEqual({ code, anchored: true });
    expect(guide).toContain('There is no environment variable that turns the guard off.');
    expect(guide).toContain('## Unverified allows');
  });
});
