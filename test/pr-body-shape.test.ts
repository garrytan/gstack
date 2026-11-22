/**
 * lib/pr-body-shape.ts (R76 as amended 2026-11-15): a PR body shows at most three lines before anything folded,
 * every other section sits in a fold, listed words stay below the Agent notes fold, and the /ship receipt ends the
 * body inside Agent notes. The #4353 case is the shape of the real body that PR was opened with: a long opening and
 * open sections, with its receipt in the Agent notes section.
 */
import { describe, expect, test } from 'bun:test';
import { withAgentNotes } from '../lib/agent-notes';
import { checkBodyShape, foldSections, unfoldSections, visibleOpening, VISIBLE_CHARS, VISIBLE_LINES } from '../lib/pr-body-shape';
import { renderReceiptBlock } from '../lib/ship-receipt';
import type { ShipReceipt } from '../lib/headless-artifacts';

const RECEIPT = renderReceiptBlock({ schema_version: 1, pr: 4353, head: '0d6e4079e3aa', base: 'main' } satisfies ShipReceipt);
const kinds = (body: string, terms: string[] = []) => checkBodyShape(body, terms).map(f => `${f.kind}:${f.match}`);
const OPENING = "/ship's reviewers end their reply with one count line, and gstack checks it against the findings it read.\n\nWhy: a blocker a reviewer reports must never vanish.\n\nNothing to do: replies without the line read as before.\n";

describe('the visible opening', () => {
  test('three lines fit; a fourth line, or 700 characters on three lines, is refused', () => {
    expect(kinds(OPENING)).toEqual([]);
    expect(kinds(OPENING + '\nOne more line.\n')).toEqual([`visible-lines:4 lines, ${[...visibleOpening(OPENING + '\nOne more line.\n').join('\n')].length} characters before the first fold`]);
    const long = ['a'.repeat(240), 'b'.repeat(240), 'c'.repeat(220)].join('\n\n');
    expect(visibleOpening(long)).toHaveLength(VISIBLE_LINES);
    expect(kinds(long)[0]).toStartWith('visible-lines:3 lines, 702 characters');
    expect(VISIBLE_CHARS).toBe(600);
  });

  test('HTML comments and folds never count as visible; text left between folds is refused', () => {
    expect(kinds('<!-- a note for tools -->\n' + OPENING + '\n<details><summary>Tests</summary>\n\n- one\n- two\n\n</details>\n')).toEqual([]);
    expect(kinds(OPENING + '\n<details><summary>Tests</summary>\n\n- one\n\n</details>\n\nLoose paragraph.\n')).toEqual(['unfolded:Loose paragraph.']);
  });

  test('nested folds stay inside their parent and a fenced <details> is code, not a fold', () => {
    const nested = OPENING + '\n<details><summary>Tests</summary>\n\n<details><summary>Logs</summary>\n\nlog\n\n</details>\n\nAfter the inner fold.\n\n</details>\n';
    expect(kinds(nested)).toEqual([]);
    expect(foldSections(nested)).toBe(nested);
    const fenced = OPENING + '\n## Example\n\n```html\n<details>\n## not a heading\n```\n';
    expect(foldSections(fenced)).toBe(OPENING + '\n<details><summary>Example</summary>\n\n```html\n<details>\n## not a heading\n```\n\n</details>\n');
    expect(kinds(foldSections(fenced))).toEqual([]);
  });
});

describe('listed words', () => {
  const body = withAgentNotes(OPENING.replace('Why:', 'Why: the outside voice and the pregate said so;') + '\n## Tests\n\n- `lane` stays in code\n', 'Lane notes are fine here.\n\n' + RECEIPT);
  test('a listed word above the Agent notes fold is found once per spelling; code and the notes section are skipped', () => {
    expect(kinds(foldSections(body), ['outside voice', 'pregate', 'lane'])).toEqual(['term:outside voice', 'term:pregate']);
    expect(kinds(foldSections(body))).toEqual([]);
  });

  // Value: protects=a listed word inside a file path or file name is not prose, so a Tests line naming test/ship-receipt-depth.test.ts passes while the
  // same word in a sentence is still refused; fails_when=bare paths in the Tests section refuse routine /ship bodies; why_new=GST-2737 review (granted fix-check)
  test('a listed word inside a file path or file name is skipped; the same word in a sentence is still found', () => {
    const tests = withAgentNotes(OPENING + '\n## Tests\n\n- [x] bun test test/ship-receipt-depth.test.ts: 12 pass\n- [x] bun test release-stamp.test.ts docs/lane.md: pass\n', RECEIPT);
    expect(kinds(foldSections(tests), ['receipt', 'stamp', 'lane'])).toEqual([]);
    const prose = withAgentNotes(OPENING + '\n## Tests\n\n- the receipt was written after test/ship-receipt-depth.test.ts passed\n', RECEIPT);
    expect(kinds(foldSections(prose), ['receipt'])).toEqual(['term:receipt']);
  });
});

describe('the Agent notes section ends the body', () => {
  test('a receipt outside the notes, or text after them, is refused; a Capy badge after them is fine', () => {
    expect(kinds(withAgentNotes(OPENING, RECEIPT))).toEqual([]);
    expect(kinds(OPENING + '\n' + RECEIPT)).toContain('receipt-placement:gstack-ship-receipt');
    expect(kinds(withAgentNotes(OPENING, RECEIPT) + '\nA trailing note.\n')).toEqual(['receipt-placement:A trailing note.']);
    expect(kinds(withAgentNotes(OPENING, RECEIPT) + '\n<a href="https://capy.ai/x"><img src="b"></a>\n')).toEqual([]);
  });
});

describe('folding', () => {
  const original = OPENING.split('\n\n')[0] + '\n\n## Why\n\nThe parser read prose and guessed.\n\n## What changed\n\n- The ask.\n- The check.\n\n## Tests\n\n- 52 pass\n\n';
  const body = withAgentNotes(original, 'Plan: plans/gst-2737.md\n\n' + RECEIPT);
  test("a #4353-shaped body folds every section, keeps the opening and the receipt byte for byte, and passes", () => {
    const folded = foldSections(body);
    expect(folded.startsWith(OPENING.split('\n\n')[0] + '\n\n<details><summary>Why</summary>\n\nThe parser read prose and guessed.\n\n</details>\n\n<details><summary>What changed</summary>\n\n- The ask.\n- The check.\n\n</details>\n\n<details><summary>Tests</summary>\n\n- 52 pass\n\n</details>\n')).toBe(true);
    expect(folded.slice(folded.indexOf('<!-- gstack:agent-notes -->'))).toBe(body.slice(body.indexOf('<!-- gstack:agent-notes -->')));
    expect(folded).toContain(RECEIPT);
    expect(kinds(folded)).toEqual([]);
    expect(kinds(body)[0]).toStartWith('visible-lines:8 lines');
  });

  test('folding is idempotent and unfolding then folding gives the same bytes', () => {
    const folded = foldSections(body);
    expect(foldSections(folded)).toBe(folded);
    expect(foldSections(unfoldSections(folded))).toBe(folded);
    expect(unfoldSections(folded)).toContain('## What changed\n\n- The ask.');
  });

  test('a heading with markup is escaped in the summary and restored on unfold', () => {
    const folded = foldSections('Opening.\n\n## Notes <b>&</b>\n\nx\n');
    expect(folded).toBe('Opening.\n\n<details><summary>Notes &lt;b&gt;&amp;&lt;/b&gt;</summary>\n\nx\n\n</details>\n');
    expect(unfoldSections(folded)).toContain('## Notes <b>&</b>');
  });
});
