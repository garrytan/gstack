/**
 * GST-3068 (GEVA-549, day-one eval at e671a531): unattended /autoplan read two rules at the
 * final gate. autoplan/SKILL.md said "end here with its GSTACK_RESULT line and never approve";
 * autoplan/DRIVER.md said to record a relayed owner reply with --by agent:<id> --owner-reply.
 * An A session followed DRIVER.md and reached status=complete; an S-full session followed
 * SKILL.md, refused the owner's relayed "rec", told the owner to run the command and stayed
 * gate_pending. One rule (AUTOPLAN_UNATTENDED_GATE_RULE) now renders into the unattended
 * profile and DRIVER.md, and SKILL.md's gate step defers to it. These checks read the
 * generated files, so a template edit that brings back an unconditional "never approve" fails.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTOPLAN_UNATTENDED_GATE_RULE } from '../scripts/resolvers/autoplan-driver';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const rule = flat(AUTOPLAN_UNATTENDED_GATE_RULE);

/** Sentences that forbid approving with no condition: a "never approve" that neither limits itself to the agent's own judgment nor names an exception. */
const unconditionalNeverApprove = (text: string) =>
  flat(text).split(/(?<=[.;])\s+/).filter(s => /never approve/i.test(s) && !/own judgment|only exception/i.test(s));

const GEVA_549_SKILL_SENTENCE = 'Under `SESSION_KIND: unattended` Read `sections/unattended.md`, end here with its `GSTACK_RESULT` line and never approve.';
const GEVA_549_PROFILE_SENTENCE = 'and the run stops at `status=gate_pending`: never approve.';

describe('unattended /autoplan states one gate rule', () => {
  test('the detector flags the two sentences GEVA-549 ran on (negative control)', () => {
    expect(unconditionalNeverApprove(GEVA_549_SKILL_SENTENCE)).toHaveLength(1);
    expect(unconditionalNeverApprove(GEVA_549_PROFILE_SENTENCE)).toHaveLength(1);
    expect(unconditionalNeverApprove(rule)).toEqual([]);
  });

  test('the rule forbids approving on the agent\'s own judgment and records a relayed owner reply with the words bound', () => {
    expect(rule).toContain('Never approve it on your own judgment: with no owner reply, the run stops at `status=gate_pending`.');
    expect(rule).toContain("Record an owner's reply relayed to you yourself, never handing them the command");
    expect(rule).toContain('--by agent:<id> --owner-reply-file <file of their words>');
  });

  test('the unattended profile and DRIVER.md carry the rule verbatim, and SKILL.md\'s gate step defers to it', () => {
    for (const rel of ['autoplan/sections/unattended.md', 'autoplan/DRIVER.md']) expect({ rel, has: flat(read(rel)).includes(rule) }).toEqual({ rel, has: true });
    const skill = flat(read('autoplan/SKILL.md'));
    expect(skill).toContain('else = A. Under `SESSION_KIND: unattended` Read `sections/unattended.md` and settle the gate by its gate rule instead.');
    expect(skill).not.toContain(GEVA_549_SKILL_SENTENCE);
    expect(flat(read('autoplan/sections/unattended.md'))).not.toContain(GEVA_549_PROFILE_SENTENCE);
  });

  test('no generated text an unattended /autoplan session reads says never approve without the condition', () => {
    for (const rel of ['autoplan/SKILL.md', 'autoplan/sections/unattended.md', 'autoplan/DRIVER.md']) {
      expect({ rel, unconditional: unconditionalNeverApprove(read(rel)) }).toEqual({ rel, unconditional: [] });
    }
  });

  test('every flag the rule names is one gstack-autoplan answer parses', () => {
    const bin = read('bin/gstack-autoplan');
    const flags = [...new Set(AUTOPLAN_UNATTENDED_GATE_RULE.match(/--[a-z][a-z-]+/g) ?? [])];
    expect(flags).toEqual(['--out', '--gate-rev', '--reply', '--by', '--owner-reply-file']);
    for (const f of flags) expect({ f, parsed: bin.includes(`'${f}'`) }).toEqual({ f, parsed: true });
  });
});
