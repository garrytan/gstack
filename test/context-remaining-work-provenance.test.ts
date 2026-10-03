/**
 * Free prompt-byte contract for Remaining Work provenance.
 * Reads SKILL.md and .tmpl as text. Does not spawn a model.
 *
 * protects: the Open-plus-suffix format and the Verify-first split
 * fails_when: the save template drops a suffix or restore offers an assumed or code-read item as the option-A start
 * why_new: the hardening test only executes the bash blocks
 * seam=none
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const SAVE_FILES = ['context-save/SKILL.md.tmpl', 'context-save/SKILL.md'];
const RESTORE_FILES = ['context-restore/SKILL.md.tmpl', 'context-restore/SKILL.md'];
const SUFFIXES = ['(path run)', '(path read)', '(path assumed)', '(code read)', '(target state checked)'];
const RUN_ITEM = 'Open. Run the suite with CONFIG=X. (path run)';
const ASSUMED_ITEM = 'Open. Switch B reads config Y; not executed this session. (path assumed)';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing start marker ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing end marker ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('remaining-work provenance prompt bytes', () => {
  test('save writes Open. plus one suffix; restore splits run from assumed and option A starts on the run item', () => {
    for (const rel of SAVE_FILES) {
      const text = read(rel);
      const step2 = sliceBetween(text, '3. **Remaining work:**', '4. **Notes**');
      const format = sliceBetween(text, '### Remaining Work', '### Notes');
      for (const suffix of SUFFIXES) {
        expect(step2, rel).toContain(suffix);
        expect(format, rel).toContain(suffix);
      }
      expect(step2, rel).toContain('`Open.`');
      expect(format, rel).toContain('`Open.`');
      expect(text, rel).toContain(RUN_ITEM);
      expect(text, rel).toContain(ASSUMED_ITEM);
    }

    for (const rel of RESTORE_FILES) {
      const text = read(rel);
      const next = sliceBetween(text, '**Next steps**', '**Verify first**');
      const verify = sliceBetween(text, '**Verify first**', 'Read the chosen file');
      const optionA = sliceBetween(text, 'If A,', '## If no saved contexts exist');
      expect(next, rel).toContain(RUN_ITEM);
      expect(next, rel).not.toContain(ASSUMED_ITEM);
      expect(verify, rel).toContain(ASSUMED_ITEM);
      expect(verify, rel).not.toContain(RUN_ITEM);
      expect(optionA, rel).toContain(RUN_ITEM);
      expect(optionA, rel).toContain('not an assumed or `(code read)` item');
      expect(optionA, rel).toContain('When Next steps is empty, the first action is to verify the first Verify-first item, not to execute it.');
      expect(text, rel).toContain('- A) Continue working on the remaining items');
      expect(text, rel).toContain('- B) Show the full saved file');
      expect(text, rel).toContain('- C) Just needed the context, thanks');
      expect(text, rel).not.toContain('{remaining work items}');
    }
  });

  test('a file opened this session is (path read) and a next step; the same file from memory is (path assumed) and Verify first', () => {
    for (const rel of SAVE_FILES) {
      const text = read(rel);
      expect(text, rel).toContain('A file opened this session and not executed is `(path read)`.');
      expect(text, rel).toContain('The same file only mentioned from memory is `(path assumed)`.');
    }
    for (const rel of RESTORE_FILES) {
      const text = read(rel);
      const next = sliceBetween(text, '**Next steps**', '**Verify first**');
      const verify = sliceBetween(text, '**Verify first**', 'Read the chosen file');
      expect(next, rel).toContain('marked `(path read)` stays a next step');
      expect(verify, rel).toContain('only mentioned from memory is `(path assumed)` and');
      expect(verify, rel).toContain('is Verify first');
    }
  });

  test('a writing step is (code read) until the target was inspected, and an inferred write is (path assumed)', () => {
    for (const rel of SAVE_FILES) {
      const text = read(rel);
      expect(text, rel).toContain('`INSERT IGNORE` whose writer was read and whose');
      expect(text, rel).toContain('table was not inspected is `(code read)`.');
      expect(text, rel).toContain('The same step after the unique');
      expect(text, rel).toContain('key was inspected is `(target state checked)`.');
      expect(text, rel).toContain('Inferring the write is `(path assumed)`, not `(code read)` and not `(path run)`.');
      expect(text, rel).toContain('Do not mark a writing step `(path run)` unless the write itself ran and the resulting');
    }
    for (const rel of RESTORE_FILES) {
      const text = read(rel);
      const next = sliceBetween(text, '**Next steps**', '**Verify first**');
      const verify = sliceBetween(text, '**Verify first**', 'Read the chosen file');
      const optionA = sliceBetween(text, 'If A,', '## If no saved contexts exist');
      expect(verify, rel).toContain('`INSERT IGNORE` whose writer was read and');
      expect(verify, rel).toContain('is `(code read)` and is Verify first, so do');
      expect(verify, rel).toContain('not offer that insert as the next action');
      expect(next, rel).toContain('`(target state checked)`');
      expect(next, rel).toContain('may be a next step once the unique key was inspected');
      expect(verify, rel).toContain('A writing step that was only inferred is `(path assumed)`, not `(code read)` and not `(path run)`.');
      expect(optionA, rel).not.toContain('INSERT IGNORE');
      expect(optionA, rel).toContain('not an assumed or `(code read)` item');
    }
  });

  test('an unsuffixed legacy item is Verify first, and an Open. item with no path is not', () => {
    for (const rel of RESTORE_FILES) {
      const text = read(rel);
      const verify = sliceBetween(text, '**Verify first**', 'Read the chosen file');
      const next = sliceBetween(text, '**Next steps**', '**Verify first**');
      expect(text, rel).toContain('A missing suffix does not drop the item.');
      expect(verify, rel).toContain('`1. Item from the before-times.` is shown and classified as Verify first.');
      expect(verify, rel).toContain('`Open. Ask the user which title to use.` has no parenthesis and is not');
      expect(verify, rel).toContain('forced into Verify first. Keep that item on Next steps.');
      expect(next, rel).not.toContain('Item from the before-times.');
    }
    for (const rel of SAVE_FILES) {
      const text = read(rel);
      expect(text, rel).toContain('An item that names no concrete path still starts with `Open.` and has no');
      expect(text, rel).toContain('provenance parenthesis. Example: `Open. Ask the user which title to use.`');
    }
  });

  test('save does not instruct a completion-token prefix, and the title sanitizer bash remains', () => {
    for (const rel of SAVE_FILES) {
      const text = read(rel);
      expect(text, rel).toContain('Do not prefix an open item with `[done]`, `[executed]`, or any other completion token.');
      expect(text, rel).toContain('Do not prefix with `[done]`, `[executed]`, or any other completion token.');
      expect(text, rel).not.toMatch(/begin with `\[done\]`|begin with `\[executed\]`|start with `\[done\]`|start with `\[executed\]`/);
      expect(text, rel).toContain('TITLE_SLUG=$(printf');
      expect(text, rel).toContain('${TIMESTAMP}-${TITLE_SLUG}-${SUFFIX}.md');
    }
  });
});
