/**
 * #3016 (residual): spawned sessions auto-choose the recommended option, with
 * an exception for destructive or irreversible choices. Granting a consent or
 * publishing data off the machine is a one-way door too, so every spawned
 * directive names it. (The artifacts-sync consent prompt itself is already
 * withheld from spawned and headless sessions.) A consent the user gave
 * interactively stays in force.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONDUCTOR_SPAWNED_DENY_REASON, SPAWNED_CONSENT_RULE, SPAWNED_ESCAPE_SENTENCE } from '../hosts/claude/hooks/spawned-directive.ts';
import { directiveFor } from '../hosts/claude/hooks/auq-error-fallback-hook.ts';

const ROOT = path.resolve(import.meta.dir, '..');

describe('#3016: spawned auto-choice never grants consent or publishes', () => {
  test('every hook directive for a spawned session carries the consent rule', () => {
    expect(SPAWNED_CONSENT_RULE).toContain('never auto-choose it');
    for (const text of [SPAWNED_ESCAPE_SENTENCE, CONDUCTOR_SPAWNED_DENY_REASON, directiveFor('spawned')]) {
      expect(text).toContain(SPAWNED_CONSENT_RULE);
    }
  });

  test("skill-start's spawned-session block names consent and off-machine publishing as exceptions", () => {
    const start = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), 'utf8');
    const block = start.slice(start.indexOf('_emit_block spawned-session'), start.indexOf('\nEOI', start.indexOf('_emit_block spawned-session')));
    expect(block).toContain('never grant a consent or choose an option that publishes or syncs data off this machine');
  });
});
