/**
 * GST-3015: in the GST-2944 smoke (gstack c5250ded), unattended /autoplan --full on Opus
 * closed the outside voice --unavailable "needs the owner's consent" in 2 of 3 sessions
 * although the config said codex_reviews: enabled, and in the third it ran the voice with
 * run_in_background and ended its turn, which ends a headless session. The text an
 * unattended driver reads (autoplan/DRIVER.md and the unattended profile) must say that an
 * explicit enabled is the owner's standing consent, that the voice runs in the foreground
 * under a bounded timeout, and that a failure binds outsideVoiceFailurePolicy()'s line.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { outsideVoiceFailurePolicy } from '../scripts/resolvers/outside-voice';
import { generateAutoplanUnattendedVoice } from '../scripts/resolvers/autoplan-driver';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const ctx = { host: 'claude', skillName: 'autoplan' } as unknown as TemplateContext;
const policy = outsideVoiceFailurePolicy(ctx, { timeoutMinutes: 9, onTimeout: 'missing-coverage', stderrOnEmpty: true, fallback: 'none', escape: 0 });

describe('autoplan/DRIVER.md, step 1 of the loop', () => {
  const text = flat(read('autoplan/DRIVER.md'));
  test('an explicit codex_reviews: enabled is the owner\'s standing consent; disabled stays with the runner and unset is unchanged', () => {
    expect(text).toContain("A stored `codex_reviews: enabled` is the owner's standing consent to send each phase's review input to the outside model");
    expect(text).toContain('`OUTSIDE_CONSENT: given by codex_reviews=enabled`');
    expect(text).toContain("the preamble's unattended consent rule does not cover it, and you never close it `--unavailable` over consent or data leaving the machine");
    expect(text).toContain('`OUTSIDE: <phase> not_run reason=consent_missing`');
    expect(text).toContain('an unset `codex_reviews` keeps its existing handling');
  });
  test('the voice runs in the foreground in this turn with a bounded timeout, never in the background', () => {
    expect(text).toContain('Run the voice in the foreground, inside this turn: `gstack-outside-voice run ... --timeout-ms 540000`');
    expect(text).toContain('Claude Code Bash `timeout: 600000`');
    expect(text).toContain('Never `run_in_background`, never a monitor, never end the turn to wait for it');
  });
  test('a failed or timed-out voice binds the documented outside-voice failure line and the run carries on', () => {
    expect(text).toContain('`submit --voice outside --unavailable "<line>"` with the matching line and carry on in the same turn');
    for (const line of policy.split('\n')) expect(text).toContain(flat(line.replace(/^- /, '')));
    expect(policy).toContain('timed out after 9 minutes and was terminated; this pass produced NO findings.');
  });
});

test('the unattended profile points at that step and states the two rules', () => {
  expect(flat(read('autoplan/sections/unattended.md'))).toContain('the outside voice (none when lean) runs per DRIVER.md (enabled `codex_reviews` is consent; foreground only)');
});

test('the resolver renders the same block the generated files carry', () => {
  expect(flat(read('autoplan/DRIVER.md'))).toContain(flat(generateAutoplanUnattendedVoice(ctx)));
});
