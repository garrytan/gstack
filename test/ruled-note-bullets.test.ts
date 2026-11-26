/**
 * GST-4003: a PR body may list its `Ruled note: …` lines as markdown bullets (`- ` or `* `). gstack-ship-receipt write and
 * the receipt-versus-prose check read such a line as the bare one, and still want the rest of it word for word.
 */
import { describe, expect, test } from 'bun:test';
import { bodyLineText, bodyListsLine, ruledNoteText, type RuledNote } from '../lib/ruled-notes';
import { checkReceiptProse } from '../lib/ship-receipt-prose';

const note: RuledNote = { finding: 'lib/a.ts:12:correctness', head: 'b'.repeat(40), by: 'GStack Minder (GSTA-36)', reason: 'ships with 3 passes noted', at: '2026-11-26T14:00:00Z', approval: 'a-123' };
const line = `Ruled note: ${ruledNoteText(note)}`;

describe('ruled-note body lines', () => {
  test('a bare line and a - or * list item carry the note', () => {
    for (const body of [line, `- ${line}`, `* ${line}`, `  - ${line}  `, `*\t${line}`, `intro\r\n- ${line}\r\noutro`]) expect(bodyListsLine(body, line)).toBe(true);
    expect(bodyLineText(`- ${line}`)).toBe(line);
  });

  test('anything weaker or different does not', () => {
    for (const body of [`- ${line} (and more)`, `-- ${line}`, `- - ${line}`, `+ ${line}`, `1. ${line}`, `> ${line}`, `-${line}`, `see ${line}`,
      `- ${line.replace('a-123', 'a-124')}`, `- Ruled note:`, '']) expect(bodyListsLine(body, line)).toBe(false);
  });

  test('the prose check leaves a bulleted ruled note out of its counter claims, and only an exact one', () => {
    const receipt = { schema_version: 1, pr: 7, head: 'a'.repeat(40), base: 'main', version: '1.2.3.0', review_loop: { passes: 2 }, ruled_notes: [note] };
    expect(checkReceiptProse(receipt, `Summary.\n\n- ${line}\n`).mismatches).toEqual([]);
    expect(checkReceiptProse(receipt, `Summary.\n\n* ${line}\n`).mismatches).toEqual([]);
    expect(checkReceiptProse(receipt, `Summary.\n\n- ${line} again\n`).mismatches).toEqual([{ field: 'review_loop.passes', prose: 3, receipt: 2 }]);
  });
});
