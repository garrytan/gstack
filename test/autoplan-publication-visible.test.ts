/**
 * GST-3062 (GEVA-549): an unattended /autoplan session sent four publish messages whose
 * only content was reasoning plus `true autoplan-published dx`. The guard denied the next
 * phase each time with a generic publication_missing and the run ended blocked. A no-op
 * publish with no visible text now gets its own corrective code that names the exact next
 * step, and the guard still denies until a visible report is really published.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REASONS, anchor } from '../autoplan/bin/guard-reasons';
import { guardFixture, section, denial, codeOf, type GuardFixture } from './helpers/autoplan-guard-fixture';

const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const make = () => { const f = guardFixture(); fixtures.push(f); return f; };
const nextPhase = (f: GuardFixture, id = 'next') => f.input(id, 'Read', { file_path: section('design-phase.md') });

/** Phase-close step 6 as the stuck session journaled it: reasoning, the no-op and its result; no text block. */
function reasoningOnlyPublish(f: GuardFixture) {
  const id = f.nextMessage();
  f.say('**Phase 1 complete.**\nConsensus: 3/3 confirmed.', id);
  f.use(`noop-${id}`, 'Bash', { command: 'true autoplan-published ceo' }, id);
  f.result(`noop-${id}`, { content: '' });
  return id;
}
/** Turn every text block that holds `marker` into a private (untagged) thinking block, as Claude Code journals reasoning. */
function intoReasoning(f: GuardFixture, marker: string) {
  const rows = fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const row of rows) if (row.message?.content?.[0]?.type === 'text' && row.message.content[0].text.includes(marker))
    row.message.content = [{ type: 'thinking', thinking: row.message.content[0].text, signature: 'c2lnbmF0dXJl' }];
  fs.writeFileSync(f.transcript, rows.map(r => JSON.stringify(r) + '\n').join(''));
}

describe('a publish message whose report is only in reasoning', () => {
  test('is denied as publication_not_visible with the exact next step, on every attempt', async () => {
    const f = make();
    for (let attempt = 0; attempt < 4; attempt++) reasoningOnlyPublish(f);
    f.journal(); intoReasoning(f, 'Phase 1 complete');
    const output = await f.hook(nextPhase(f));
    expect(codeOf(output)).toBe('publication_not_visible');
    const text = denial(output)!;
    expect(text).toContain('carried no visible text');
    expect(text).toContain('reasoning');
    expect(text).toContain('starting with the line **Phase 1 complete.**');
    expect(text).toContain('`true autoplan-published ceo`');
    expect(REASONS.publication_not_visible.disposition).toBe('corrective');
    expect(text).toContain(`docs/autoplan-guard-troubleshooting.md#${anchor('publication_not_visible')}`);
    expect(text).not.toMatch(/\bretry\b/i);
  });

  test('a visible report afterwards lets the next phase start', async () => {
    const f = make();
    reasoningOnlyPublish(f); f.journal(); intoReasoning(f, 'Phase 1 complete');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('publication_not_visible');
    f.publish(); f.journal(); intoReasoning(f, 'Consensus: 3/3');
    expect(denial(await f.hook(nextPhase(f, 'next-2')))).toBeUndefined();
  });
});

describe('negative controls: the guard still denies a phase whose report is really missing', () => {
  test('no publish message at all stays publication_missing', async () => {
    const f = make(); f.journal();
    const output = await f.hook(nextPhase(f));
    expect(codeOf(output)).toBe('publication_missing');
    expect(denial(output)).toContain('`true autoplan-published ceo`');
  });

  test('a visible publish message without the phase declaration stays publication_missing', async () => {
    const f = make();
    const id = f.nextMessage();
    f.say('Done with the review.', id);
    f.use(`noop-${id}`, 'Bash', { command: 'true autoplan-published ceo' }, id);
    f.result(`noop-${id}`, { content: '' }); f.journal();
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('publication_missing');
  });

  test('a report saved to a file, with a reasoning-only publish, does not publish it', async () => {
    const f = make();
    fs.writeFileSync(path.join(f.cwd, 'ceo-report.md'), '**Phase 1 complete.**\nConsensus: 3/3 confirmed.\n');
    reasoningOnlyPublish(f); f.journal(); intoReasoning(f, 'Phase 1 complete');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('publication_not_visible');
  });
});
