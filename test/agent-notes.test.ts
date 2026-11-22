/**
 * The Agent notes section (lib/agent-notes.ts, GST-1825): the collapsed block at the end of a PR body that holds the
 * lines gstack's tools read. Covers where the receipt goes, which receipt binds (legacy top, inside the notes, a quoted
 * example in the readable part, none), and that the Plan line and issue lines are found inside the notes.
 */
import { describe, expect, test } from 'bun:test';
import { AGENT_NOTES_MARKER, agentNotesOrBody, renderAgentNotes, splitAgentNotes, withAgentNotes } from '../lib/agent-notes';
import { parsePlanLine } from '../lib/plan-record';
import { bindReceipt, computeCensus, extractReceipt, missingIssueLines, orderReceipt, placeReceipt, receiptRuns, renderReceiptBlock } from '../lib/ship-receipt';
import type { ShipReceipt } from '../lib/headless-artifacts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const receipt = (head: string, pr = 7): ShipReceipt => orderReceipt({ schema_version: 1, pr, head, base: 'main' });
const notes = (content: string) => renderAgentNotes(content);

describe('splitAgentNotes and withAgentNotes', () => {
  test('a body with a section splits into the readable part and the content; one without has no notes', () => {
    const body = 'Opening sentence.\n\n## Summary\n\nx\n\n' + notes('Plan: exempt: docs-only\nFixes #14');
    expect(splitAgentNotes(body)).toEqual({ readable: 'Opening sentence.\n\n## Summary\n\nx\n\n', notes: 'Plan: exempt: docs-only\nFixes #14' });
    expect(splitAgentNotes('Opening.\n')).toEqual({ readable: 'Opening.\n', notes: null });
    expect(agentNotesOrBody('Opening.\n')).toBe('Opening.\n');
  });

  test('the marker inside a code fence opens no section, and </details> inside a fence in the notes does not close it', () => {
    const quoted = 'Example:\n\n```md\n' + AGENT_NOTES_MARKER + '\n```\n';
    expect(splitAgentNotes(quoted).notes).toBeNull();
    const inner = 'Plan: exempt: x\n\n```text\n</details>\n```';
    expect(splitAgentNotes('Body.\n\n' + notes(inner)).notes).toBe(inner);
  });

  test('withAgentNotes appends a section, replaces an existing one in place, keeps a trailing badge after it, and is stable', () => {
    const once = withAgentNotes('Opening.\n\n## Summary\n\nx\n', 'Fixes #1');
    expect(once).toBe('Opening.\n\n## Summary\n\nx\n\n' + notes('Fixes #1'));
    const badge = '<!-- capy-badge:start -->\nB\n<!-- capy-badge:end -->\n';
    const twice = withAgentNotes(once + '\n' + badge, 'Fixes #2');
    expect(twice).toBe('Opening.\n\n## Summary\n\nx\n\n' + notes('Fixes #2') + '\n' + badge);
    expect(withAgentNotes(twice, 'Fixes #2')).toBe(twice);
  });

  test('a collapsible a person adds after the section stays after it, and one nested inside the notes stays inside', () => {
    const shots = '<details><summary>Screenshots</summary>\n\n![a](a.png)\n\n</details>\n';
    const body = 'Opening.\n\n' + notes('Fixes #1') + '\n' + shots;
    expect(splitAgentNotes(body).notes).toBe('Fixes #1');
    expect(withAgentNotes(body, 'Fixes #2')).toBe('Opening.\n\n' + notes('Fixes #2') + '\n' + shots);
    expect(placeReceipt(body, receipt(HEAD)).endsWith('</details>\n\n' + shots)).toBe(true);
    const nested = 'Fixes #1\n\n<details><summary>Runs</summary>\n\nr\n\n</details>';
    expect(splitAgentNotes('Opening.\n\n' + notes(nested) + '\n' + shots).notes).toBe(nested);
  });

  test('an open or two-line opener and an unclosed collapsible inside the notes keep text added after the section outside it', () => {
    const after = '\nA note a person added.\n';
    for (const opener of ['<details open><summary>Agent notes</summary>', '<details>\n<summary>Agent notes</summary>']) {
      const body = `Opening.\n\n${AGENT_NOTES_MARKER}\n${opener}\n\nFixes #1\n\n</details>\n${after}`;
      expect(splitAgentNotes(body).notes).toBe('Fixes #1');
      expect(withAgentNotes(body, 'Fixes #2').endsWith('</details>\n' + after)).toBe(true);
    }
    const unclosed = 'Opening.\n\n' + notes('Fixes #1\n\n<details><summary>Runs</summary>\n\nr') + '\n' + after;
    expect(splitAgentNotes(unclosed).notes).toBe('Fixes #1\n\n<details><summary>Runs</summary>\n\nr');
    expect(withAgentNotes(unclosed, 'Fixes #2').endsWith('</details>\n' + after)).toBe(true);
  });
});

describe('placeReceipt: the receipt lives in the Agent notes section', () => {
  test('a body with no receipt gets a section holding the receipt; the other notes content stays above it', () => {
    const fresh = placeReceipt('Opening.\n\n## Summary\n\nx\n', receipt(HEAD));
    expect(fresh).toBe('Opening.\n\n## Summary\n\nx\n\n' + notes(renderReceiptBlock(receipt(HEAD))));
    const withLines = placeReceipt('Opening.\n\n' + notes('Plan: exempt: docs-only\nFixes #14'), receipt(HEAD));
    expect(splitAgentNotes(withLines).notes).toBe('Plan: exempt: docs-only\nFixes #14\n\n' + renderReceiptBlock(receipt(HEAD)).trim());
    expect(placeReceipt(withLines, receipt(HEAD))).toBe(withLines);
  });

  test('a new receipt replaces the one in the notes, the old one joins the runs block there, and a quoted example fence in the readable part stays', () => {
    const example = 'Here is what the record looks like:\n\n' + renderReceiptBlock(receipt(OTHER, 1)) + '\nMore prose.\n';
    const first = placeReceipt(example + '\n' + notes('Fixes #14'), receipt(HEAD));
    const second = placeReceipt(first, receipt(OTHER));
    expect(second.match(/```gstack-ship-receipt/g)).toHaveLength(2);
    expect(splitAgentNotes(second).readable).toBe(example.trimEnd() + '\n\n');
    expect(splitAgentNotes(second).notes!.match(/```gstack-ship-receipt/g)).toHaveLength(1);
    expect(extractReceipt(second).receipt!.head).toBe(OTHER);
    expect(receiptRuns(second).map(r => r.head)).toEqual([HEAD]);
    expect(splitAgentNotes(second).notes).toStartWith('Fixes #14\n\n```gstack-ship-receipt');
  });

  test('a legacy body (receipt at the top, no section) keeps its layout, so its Plan and issue lines stay readable', () => {
    const legacy = renderReceiptBlock(receipt(HEAD)) + '\nOpening.\n\n## Approvals\n\nPlan: exempt: docs-only\n';
    const placed = placeReceipt(legacy, receipt(OTHER));
    expect(placed).toStartWith('```gstack-ship-receipt\n');
    expect(placed).not.toContain(AGENT_NOTES_MARKER);
    expect(extractReceipt(placed).receipt!.head).toBe(OTHER);
    expect(receiptRuns(placed).map(r => r.head)).toEqual([HEAD]);
    expect(parsePlanLine(placed)?.line).toBe('Plan: exempt: docs-only');
  });
});

describe('which receipt binds', () => {
  test('a legacy receipt at the top still binds when the body gained an Agent notes section without one, and placing a new receipt moves it and its runs into the notes', () => {
    const legacy = renderReceiptBlock(receipt(OTHER)) + '\n```gstack-receipt-runs\n' + JSON.stringify({ head: 'c'.repeat(40) }) + '\n```\n\nOpening.\n\n## Summary\n\nx\n\n' + notes('Fixes #14');
    expect(bindReceipt(legacy, '7', [OTHER])).toMatchObject({ ok: true, head: OTHER });
    expect(receiptRuns(legacy).map(r => r.head)).toEqual(['c'.repeat(40)]);
    const placed = placeReceipt(legacy, receipt(HEAD));
    expect(placed).toStartWith('Opening.');
    expect(placed.match(/```gstack-ship-receipt/g)).toHaveLength(1);
    expect(extractReceipt(placed).receipt!.head).toBe(HEAD);
    expect(receiptRuns(placed).map(r => r.head)).toEqual(['c'.repeat(40), OTHER]);
    expect(splitAgentNotes(placed).notes).toStartWith('Fixes #14\n\n```gstack-ship-receipt');
  });

  test('(a) a legacy receipt at the top of a body with no section binds', () => {
    const body = renderReceiptBlock(receipt(HEAD)) + '\nOpening.\n\n## Summary\n\nx\n';
    expect(bindReceipt(body, '7', [HEAD])).toMatchObject({ ok: true, head: HEAD });
  });

  test('(b) a receipt inside the Agent notes section binds', () => {
    const body = 'Opening.\n\n## Summary\n\nx\n\n' + notes('Fixes #14\n\n' + renderReceiptBlock(receipt(HEAD)));
    expect(bindReceipt(body, '7', [HEAD])).toMatchObject({ ok: true, head: HEAD });
  });

  test('(c) an example fence in the readable part never binds when the body has a section; the real one in the notes does', () => {
    const body = 'Opening.\n\n' + renderReceiptBlock(receipt(OTHER)) + '\n## Summary\n\nx\n\n' + notes(renderReceiptBlock(receipt(HEAD)));
    expect(extractReceipt(body).receipt!.head).toBe(HEAD);
    expect(bindReceipt(body, '7', [HEAD])).toMatchObject({ ok: true, head: HEAD });
    expect(bindReceipt(body, '7', [OTHER])).toMatchObject({ ok: false, code: 'QUEUE_RECEIPT_STALE' });
    const quotedOnly = 'Opening.\n\n' + renderReceiptBlock(receipt(OTHER)) + '\n' + notes('Fixes #14');
    expect(bindReceipt(quotedOnly, '7', [OTHER])).toMatchObject({ ok: false, code: 'QUEUE_RECEIPT_MISSING' });
  });

  test('(d) a body with no receipt binds nothing, with or without a section', () => {
    expect(bindReceipt('Opening.\n', '7', [HEAD])).toMatchObject({ ok: false, code: 'QUEUE_RECEIPT_MISSING' });
    expect(bindReceipt('Opening.\n\n' + notes('Fixes #14'), '7', [HEAD])).toMatchObject({ ok: false, code: 'QUEUE_RECEIPT_MISSING' });
  });

  test('the census counts the receipt in the notes and ignores a quoted one in the readable part', () => {
    const body = 'Opening.\n\n' + renderReceiptBlock(orderReceipt({ schema_version: 1, head: OTHER, base: 'main', run: 'quoted' })) + '\n'
      + notes(renderReceiptBlock(orderReceipt({ schema_version: 1, head: HEAD, base: 'main', run: 'real', session_kind: 'unattended' })));
    const census = computeCensus('acme/widget', '2026-11-01', [{ number: 1, mergedAt: '2026-11-02T00:00:00Z', body }], null);
    expect(census.runs).toEqual(['real']);
    expect(census.unattended_prs).toBe(1);
  });
});

describe('readers find their lines inside the Agent notes section', () => {
  test('the Plan line is read from the notes first; with none there, the readable part still counts', () => {
    const body = 'Opening.\n\n## Summary\n\nx\n\n' + notes('Plan: exempt: docs-only\n\n' + renderReceiptBlock(receipt(HEAD)));
    expect(parsePlanLine(body)).toEqual({ kind: 'exempt', line: 'Plan: exempt: docs-only', reason: 'docs-only' });
    expect(parsePlanLine('Plan: approved: r-1\n\n' + notes('Plan: exempt: docs-only'))?.kind).toBe('exempt');
    const readableOnly = 'Plan: approved: r-1\n\n' + notes('Fixes #14');
    expect(parsePlanLine(readableOnly)).toEqual({ kind: 'approved', line: 'Plan: approved: r-1', token: 'r-1' });
    const older = 'Opening.\n\n## Approvals\n\nPlan: exempt: docs-only\n';
    expect(parsePlanLine(placeReceipt(older, receipt(HEAD)))).toEqual(parsePlanLine(older));
    expect(parsePlanLine('## Approvals\n\nPlan: exempt: docs-only\n')?.kind).toBe('exempt');
  });

  test('issue lines count inside the notes, in the readable part, and in a legacy body', () => {
    const issues = { fixes: [14], refs: [30], flakes: [] };
    expect(missingIssueLines('Opening.\n\n' + notes('Fixes #14\nRefs #30'), issues)).toEqual([]);
    expect(missingIssueLines('## Issues\nFixes #14\n\n' + notes('Refs #30'), issues)).toEqual([]);
    expect(missingIssueLines('Opening.\n\n' + notes('Fixes #14'), issues)).toEqual(['Refs #30']);
  });
});
