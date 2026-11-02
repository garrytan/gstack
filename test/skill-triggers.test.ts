/**
 * lib/skill-triggers.ts: the trigger-first wording rule for harness listings
 * (Hermes description leads, router lines), on its branches the full-catalog
 * render tests in test/harness-register.test.ts never reach because every
 * current skill has a trigger sentence and a triggers list.
 *
 * Value: protects=Hermes descriptions keep every non-trigger sentence and the (gstack) tag; router/lead fallbacks stay trigger-first and within max;
 *   fails_when=withTriggerLead drops the wrong sentence or the tag, or a fallback branch (no trigger sentence, no triggers, overlong entry) exceeds max or loses its lead;
 *   why_new=the render tests check only the lead's prefix and length over skills that all take the triggers-list branch; seam=none;
 *   no_claim=how any harness ranks or shows the text (pure string functions; synthetic descriptions)
 */
import { describe, expect, test } from 'bun:test';
import { frontmatterList, routerLine, triggerList, withTriggerLead } from '../lib/skill-triggers';

const DESC = 'Pre-landing PR review. Analyzes the diff for structural issues. Use when asked to "review this PR" or "check my diff". Proactively suggest before a merge. (gstack)';
const TRIGGERS = ['review this pr', 'code review', 'check my diff', 'pre-landing review'];

describe('withTriggerLead (Hermes descriptions)', () => {
  test('a triggers-list lead replaces the trigger sentence; every other sentence and the (gstack) tag stay, once', () => {
    const [lead, rest, ...more] = withTriggerLead(DESC, TRIGGERS, 57).split('\n');
    expect(more).toEqual([]);
    expect(lead).toStartWith('Use for: review this pr');
    expect(lead.length).toBeLessThanOrEqual(57);
    expect(rest).toBe('Pre-landing PR review. Analyzes the diff for structural issues. Proactively suggest before a merge. (gstack)');
  });

  test('without triggers the lead is the trigger sentence cut at a word, and the whole description follows unchanged', () => {
    const [lead, ...rest] = withTriggerLead(DESC, [], 40).split('\n');
    expect(lead).toStartWith('Use when asked to');
    expect(lead).toEndWith('...');
    expect(lead.length).toBeLessThanOrEqual(40);
    expect(rest.join('\n')).toBe(DESC);
  });
});

describe('routerLine (router-mode targets)', () => {
  const cases: Array<[string, string, string[], number, (line: string) => void]> = [
    ['trigger sentence and first sentence both fit', 'Debug a crash. Use to find the root cause.', [], 160,
      l => expect(l).toBe('Use to find the root cause. Debug a crash.')],
    ['trigger sentence alone when both do not fit', DESC, [], 60,
      l => { expect(l).toStartWith('Use when asked to'); expect(l).not.toContain('Pre-landing'); }],
    ['no trigger sentence: the triggers list leads', 'Pre-landing PR review. Analyzes the diff.', TRIGGERS, 160,
      l => expect(l).toStartWith('Use for: review this pr, code review')],
    ['neither: the first sentence, cut at a word', 'A very long first sentence about a workflow that goes on and on and on.', [], 40,
      l => { expect(l).toStartWith('A very long first sentence'); expect(l).toEndWith('...'); }],
  ];
  for (const [name, desc, triggers, max, check] of cases) {
    test(name, () => {
      const line = routerLine(desc, triggers, max);
      expect(line.length).toBeLessThanOrEqual(max);
      check(line);
    });
  }
});

test('triggerList: an entry longer than max is cut to fit instead of overflowing', () => {
  const lead = triggerList(['find out why the nightly deploy pipeline keeps failing on the staging cluster'], 57);
  expect(lead).toStartWith('Use for: find out why');
  expect(lead).toEndWith('...');
  expect(lead.length).toBeLessThanOrEqual(57);
});

test('frontmatterList reads one block list, unquoting values and stopping at the next field', () => {
  const md = '---\nname: x\ntriggers:\n  - "quoted one"\n  - \'single\'\n  - plain\nallowed-tools:\n  - Bash\n---\nbody\n  - not frontmatter\n';
  expect(frontmatterList(md, 'triggers')).toEqual(['quoted one', 'single', 'plain']);
  expect(frontmatterList(md, 'voice-triggers')).toEqual([]);
  expect(frontmatterList('no frontmatter\ntriggers:\n  - x\n', 'triggers')).toEqual([]);
});
