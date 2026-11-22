/**
 * #4155: Claude Code can journal a phase report between tool calls as a
 * paraphrased narration summary. When the report opened with a preface
 * sentence, the summary folds it in, so the declaration starts a sentence but
 * not the line. It still counts; quoted, negated and foreign-phase mentions
 * in the same position do not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { autoplanPhaseCompletions } from '../lib/autoplan-phase-publication';
import { guardFixture, section, denial, codeOf, type GuardFixture } from './helpers/autoplan-guard-fixture';

const at = Date.parse('2026-11-08T03:42:14.959Z');
const observe = (text: string) => autoplanPhaseCompletions({ status: 'ready', calls: [],
  assistantMessages: [{ sessionId: 'autoplan-fixture', text, timestamp: new Date(at).toISOString() }] }, at - 1);

// The narration summary Claude Code 2.1.319 journaled for one real Phase 1 report (#4155).
const captured = "I checked the packet against the plan and all four edits are in place, with the native reviewer's hash matching. " +
  'Phase 1 is complete with 9 native issues and no outside review, so the work moves on to Phase 2.';

describe('a declaration that starts a sentence inside the line', () => {
  test('the captured narration summary counts as Phase 1 and nothing else', () => {
    expect(observe(captured)).toEqual([{ phase: 1, ts: at }]);
  });

  test('other affirmative forms after a preface sentence count', () => {
    expect(observe('Checked the packet. Phase 2.5 (DX) is done: 4 findings.')).toEqual([{ phase: 2.5, ts: at }]);
    expect(observe('All edits verified! **Phase 3 complete.** Moving on.')).toEqual([{ phase: 3, ts: at }]);
    expect(observe('The reviewer said "looks good." Phase 2 is finished.')).toEqual([{ phase: 2, ts: at }]);
  });

  const rejected = [
    'The template says "Done. Phase 1 is complete. Moving on." for this step.',
    'Codex wrote “Checked. Phase 1 complete. Next.” in its notes.',
    'The marker is `Done. Phase 1 complete. Next.` in the template.',
    "The log reads 'Done. Phase 1 complete. Next.' for the reviewer's run.",
    'The log reads ‘Done. Phase 1 complete. Next.’ for this step.',
    'Example: Done. Phase 1 complete.',
    'The template example: Done. Phase 1 complete. Next.',
    'The expected announcement reads as follows. Phase 1 complete.',
    'I checked the packet. I did not declare Phase 1 complete yet.',
    'I checked the packet. Phase 1 is not complete.',
    'I checked the packet. Phase 1 is complete with no outside review.',
    'I checked the packet. Phase 1 will be complete after the review.',
    'Wait for the review before Phase 1 is complete with 9 issues.',
    'I checked the packet. Phase 4 is complete.',
    'I checked the packet. Phase 2.1 is complete.',
    '- Checked the packet. Phase 1 complete.',
    '1. Phase 1 complete.',
    '# Checked. Phase 1 complete.',
    '> Checked. Phase 1 complete.',
    'Example:\nChecked the packet. Phase 1 complete.',
    '```text\nChecked the packet. Phase 1 complete.\n```',
  ];
  test.each(rejected)('%s does not count', text => expect(observe(text)).toEqual([]));
});

const NARRATION = 'Eg0KC0IJbmFycmF0aW9u'; // Synthetic signature tag path 2→1→8=narration, as in autoplan-public-narration-ad.json.
const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

/** Phase-close step 6, journaled the way #4155 saw it: the report as a narration summary, then the no-op and its result. */
async function nextPhaseEntry(summary: string) {
  const f = guardFixture(); fixtures.push(f);
  const id = f.nextMessage();
  f.say(summary, id); f.use(`noop-${id}`, 'Bash', { command: 'true autoplan-published ceo' }, id);
  f.result(`noop-${id}`, { content: '' }); f.journal();
  const rows = fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const report = rows.find(r => r.message?.content?.[0]?.text === summary);
  report.message.content = [{ type: 'thinking', thinking: summary, signature: NARRATION }];
  fs.writeFileSync(f.transcript, rows.map(r => JSON.stringify(r) + '\n').join(''));
  return f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }));
}

describe('the publication guard on a narration-journaled report', () => {
  test('the captured summary lets Phase 2 start', async () => {
    expect(denial(await nextPhaseEntry(captured))).toBeUndefined();
  });

  test('a quoted, negated or other-phase summary is still publication_missing', async () => {
    for (const summary of [
      'I checked the packet. The template says "Done. Phase 1 is complete. Next." for this step.',
      'I checked the packet. I did not declare Phase 1 complete yet.',
      'I checked the packet. Phase 2 is complete with 4 design issues.',
    ]) expect(codeOf(await nextPhaseEntry(summary)), summary).toBe('publication_missing');
  });
});
