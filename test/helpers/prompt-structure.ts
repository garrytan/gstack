/**
 * Structural checks for skill templates, sections and generated SKILL.md.
 *
 * docs/test-value-bar.md: a prompt-byte contract covers only machine-read tokens
 * (markers, field names, command lines, enum values, file paths). These helpers
 * assert those tokens, section presence and step order; safety lines are checked
 * on meaning with case-insensitive keywords. They never pin an English sentence.
 */
import { expect } from 'bun:test';

const FIX = 'Fix: restore the token or heading in the template and run `bun run gen:skill-docs`; if it was renamed on purpose, update the token here (docs/test-value-bar.md).';

/** Collapse whitespace so wrapped template lines compare as one line. */
export const compact = (text: string): string => text.replace(/\s+/g, ' ');

const find = (text: string, marker: string | RegExp, from = 0): number => {
  if (typeof marker === 'string') return text.indexOf(marker, from);
  const at = text.slice(from).search(marker);
  return at < 0 ? -1 : from + at;
};

/** The text from `start` up to `end` (or the end of text); throws naming the missing marker. */
export function between(text: string, start: string | RegExp, end?: string | RegExp): string {
  const from = find(text, start);
  if (from < 0) throw new Error(`Section start ${String(start)} not found. ${FIX}`);
  if (end === undefined) return text.slice(from);
  const to = find(text, end, from + 1);
  if (to < 0) throw new Error(`Section end ${String(end)} not found after ${String(start)}. ${FIX}`);
  return text.slice(from, to);
}

/** Every token is present; the failure lists the missing ones. */
export function expectTokens(text: string, tokens: (string | RegExp)[], where = 'text'): void {
  const missing = tokens.filter(token => find(text, token) < 0).map(String);
  expect(missing, `${where} lacks machine-read tokens: ${missing.join(' | ')}. ${FIX}`).toEqual([]);
}

/** No retired token is present. */
export function expectAbsent(text: string, tokens: (string | RegExp)[], where = 'text'): void {
  const present = tokens.filter(token => find(text, token) >= 0).map(String);
  expect(present, `${where} still carries retired tokens: ${present.join(' | ')}. ${FIX}`).toEqual([]);
}

/** Markers appear, in this order. */
export function expectOrdered(text: string, markers: (string | RegExp)[], where = 'text'): void {
  const positions = markers.map(marker => find(text, marker));
  const missing = markers.filter((_, index) => positions[index]! < 0).map(String);
  expect(missing, `${where} lacks ordered markers: ${missing.join(' | ')}. ${FIX}`).toEqual([]);
  const order = markers.map(String);
  const actual = [...order].sort((a, b) => positions[order.indexOf(a)]! - positions[order.indexOf(b)]!);
  expect(actual, `${where} markers are out of order. ${FIX}`).toEqual(order);
}

/**
 * Meaning-level check for a safety line: each group's words all occur, case-insensitively,
 * within one sentence of the text. Rewording keeps it green; dropping the rule does not.
 */
export function expectMentions(text: string, groups: string[][], where = 'text'): void {
  const sentences = text.split(/(?<=[.!?])\s+|\n\s*\n/).map(sentence => sentence.toLowerCase());
  const missing = groups.filter(words => !sentences.some(sentence => words.every(word => sentence.includes(word.toLowerCase()))));
  expect(missing.map(words => words.join('+')), `${where} no longer states a required rule (all words in one sentence): ${missing.map(words => words.join('+')).join(' | ')}. Restore the rule in the template; reword freely but keep these words.`).toEqual([]);
}
