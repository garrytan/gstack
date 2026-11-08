/**
 * A phase report whose declaration sits inside a sentence. Claude Code can journal
 * prose between tool calls as a paraphrased narration summary, which folds a
 * preface ("I checked the packet…") into the declaration. The guard still denies,
 * but names the fix (publication_buried) instead of calling the report missing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { guardFixture, section, denial, codeOf, type GuardFixture } from './helpers/autoplan-guard-fixture';
import { autoplanPhaseCompletions, buriedPhaseDeclaration } from '../lib/autoplan-phase-publication';

const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const make = () => { const f = guardFixture(); fixtures.push(f); return f; };
const next = (f: GuardFixture) => f.input('next', 'Read', { file_path: section('design-phase.md') });
const counted = (text: string) => autoplanPhaseCompletions({ status: 'ready', calls: [],
  assistantMessages: [{ text, timestamp: '2026-11-08T03:42:14.959Z' }] } as any, 0).map(h => h.phase);

describe('buriedPhaseDeclaration', () => {
  // The summaries Claude Code 2.1.319 journaled for one real Phase 1 close (session c3a1c6bc).
  const buried = 'I checked the packet against the plan and all four edits are in place, with the native reviewer\'s hash matching. ' +
    'Phase 1 is complete with 9 native issues and no outside review, so the work moves on to Phase 2.';
  const opening = 'Phase 1 is complete: the outside review was unavailable, and the native subagent raised nine issues.';

  test('a mid-sentence declaration is buried and is not counted as a report', () => {
    expect(buriedPhaseDeclaration(buried, 1)).toBe(true);
    expect(counted(buried)).toEqual([]);
  });

  test('a declaration that opens the line is counted, not buried', () => {
    expect(counted(opening)).toEqual([1]);
    expect(buriedPhaseDeclaration(opening, 1)).toBe(false);
    expect(buriedPhaseDeclaration('**Phase 1 complete.**\nOutside review: unavailable.', 1)).toBe(false);
  });

  test('other phases, negations, fenced examples and 2.5 boundaries are not buried', () => {
    expect(buriedPhaseDeclaration(buried, 3)).toBe(false);
    expect(buriedPhaseDeclaration('The guard says Phase 1 is not complete yet.', 1)).toBe(false);
    expect(buriedPhaseDeclaration('Template:\n```\nThen Phase 1 complete.\n```', 1)).toBe(false);
    expect(buriedPhaseDeclaration('So Phase 2.5 is done.', 2)).toBe(false);
    expect(buriedPhaseDeclaration('So Phase 2.5 is done.', 2.5)).toBe(true);
  });
});

describe('publication_buried at the next phase entry', () => {
  test('a report with a preface sentence is denied as publication_buried with the fix named', async () => {
    const f = make(); const id = f.nextMessage();
    f.say('I checked the packet against the plan. Phase 1 is complete with 9 native issues, so work moves on.', id);
    f.use(`noop-${id}`, 'Bash', { command: 'true autoplan-published ceo' }, id);
    f.result(`noop-${id}`, { content: '' }); f.journal();
    const output = await f.hook(next(f));
    expect(codeOf(output)).toBe('publication_buried');
    expect(denial(output)).toContain('**Phase 1 complete.**');
    expect(denial(output)).toContain('`true autoplan-published <phase>`');
    expect(denial(output)).not.toMatch(/\bretry\b/i);
  });

  test('controls: no report at all stays publication_missing; a report that opens the message is allowed', async () => {
    const missing = make(); missing.journal();
    expect(codeOf(await missing.hook(next(missing)))).toBe('publication_missing');
    const published = make(); published.publish(); published.journal();
    expect(denial(await published.hook(next(published)))).toBeUndefined();
  });
});
