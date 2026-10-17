/**
 * Remaining Work provenance (#3004): prompt-byte contract for the shipped
 * context-save and context-restore SKILL.md files.
 *
 * The markers are a wire format between two skills: /context-save writes them
 * into a checkpoint and a later /context-restore sorts on them. Only that
 * contract is pinned (marker tokens, group headings, banner, option-A order),
 * not the surrounding prose. Behavior is covered by the periodic E2E case
 * context-restore-provenance-order.
 *
 * Value: protects=save writes the five provenance markers and restore sorts them into Next steps and Verify first; fails_when=a marker, a group or the saved-order option A is dropped; why_new=no test reads Remaining Work; seam=none
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const MARKERS = ['(path run)', '(path read)', '(path assumed)', '(code read)', '(target state checked)'];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('Remaining Work provenance contract', () => {
  test('context-save marks every item Open. and defines all five markers, writing steps first', () => {
    const save = read('context-save/SKILL.md');
    const table = between(save, '**Remaining Work provenance.**', 'If the user provided a title');
    for (const marker of MARKERS) expect(table).toContain(`\`${marker}\``);
    expect(table).toContain('`Open.`');
    expect(table).toContain('`[done]`');
    expect(table.indexOf('a writing step')).toBeLessThan(table.indexOf('names a concrete path'));
    expect(table).toContain('**Markers stay English literals.**');
    expect(table).toContain('**Decisions Made and file claims.**');
    const format = between(save, '### Remaining Work', '### Notes');
    expect(format).toContain('`Open.`');
  });

  test('context-restore sorts into Next steps and Verify first and option A walks saved order', () => {
    const restore = read('context-restore/SKILL.md');
    expect(restore).not.toContain('{remaining work items}');
    const rules = between(restore, '**Sort Remaining Work by provenance.**', 'Read the chosen file');
    const verifyFirst = between(rules, 'Put an item under **Verify first**', 'Every other item');
    for (const marker of ['(path assumed)', '(code read)']) expect(verifyFirst).toContain(`\`${marker}\``);
    expect(verifyFirst).toContain('reports a failure');
    expect(verifyFirst).toContain('has no marker');
    expect(verifyFirst).toContain('translated or unknown marker');
    expect(restore).toContain('**No useful branch discriminator.**');
    const nextSteps = between(rules, 'Every other item goes under **Next steps**', 'Verifying means');
    for (const marker of ['(path run)', '(path read)', '(target state checked)']) expect(nextSteps).toContain(`\`${marker}\``);
    expect(rules).toContain(
      '`This checkpoint predates provenance markers; items naming commands, paths or writes are listed under Verify first.`',
    );
    const summary = between(restore, '### Remaining Work', '### Notes');
    expect(summary.indexOf('Next steps')).toBeLessThan(summary.indexOf('Verify first'));
    const optionA = between(restore, 'If A,', '## If no saved contexts exist');
    expect(optionA).toContain('first Remaining Work item in saved order');
    expect(optionA).toContain('under Verify first, suggest verifying it');
  });
});
