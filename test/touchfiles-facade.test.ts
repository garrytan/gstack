/**
 * Pins the touchfiles three-file split (facade + data + logic).
 * Free (no API calls), runs with `bun test`.
 *
 * (a) touchfiles-data.ts stays LITERALS ONLY — no imports/requires, no call
 *     expressions, no spreads, no template literals. Map-diff selection
 *     evaluates old git versions of that file standalone; any logic breaks it.
 * (b) the ./helpers/touchfiles facade re-exports EVERY export of both halves
 *     by identity (===), so existing import sites see the same objects.
 * (c) the data file's exports are importable and non-empty.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import * as path from 'path';

import * as data from './helpers/touchfiles-data';
import * as logic from './helpers/test-selection';
import * as facade from './helpers/touchfiles';

const DATA_PATH = path.join(import.meta.dir, 'helpers', 'touchfiles-data.ts');

// Single-pass scanner: returns the source with comments AND string literals
// removed (only code-position characters survive), plus whether any backtick
// appeared in code position.
//
// Why a state machine instead of regexes: the data strings contain glob
// patterns like 'browse/src/' + '**' (a block-comment OPENER to a naive
// regex) and '*' + '/SKILL.md.tmpl' (a block-comment CLOSER), so regex
// comment-stripping would treat string content as comment delimiters.
// Conversely, comments contain apostrophes ("the model's interpretation"),
// so regex string-stripping applied first would eat code. Tracking state
// character-by-character handles both without false positives.
function stripCommentsAndStrings(src: string): { code: string; sawBacktick: boolean } {
  let code = '';
  let sawBacktick = false;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'single'; i += 1; continue; }
      if (c === '"') { state = 'double'; i += 1; continue; }
      if (c === '`') { sawBacktick = true; i += 1; continue; }
      code += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; code += '\n'; }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; } else { i += 1; }
      continue;
    }
    // single- or double-quoted string
    if (c === '\\') { i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"')) {
      state = 'code';
    }
    i += 1;
  }
  return { code, sawBacktick };
}

describe('touchfiles-data.ts literal-only tripwire', () => {
  const src = readFileSync(DATA_PATH, 'utf-8');
  const { code, sawBacktick } = stripCommentsAndStrings(src);
  const explain =
    'touchfiles-data.ts must stay LITERALS ONLY (map-diff selection evaluates ' +
    'old git versions of it standalone). Move any logic to test-selection.ts.';

  test('scanner sanity: keeps code, strips comments and strings', () => {
    const sample =
      "export const X = { 'a(b)': ['c/**'] }; // call() here\n" +
      '/* import */ const Y = 1; // `tpl`\n';
    const out = stripCommentsAndStrings(sample);
    expect(out.code).toContain('export const X');
    expect(out.code).toContain('const Y = 1');
    expect(out.code).not.toContain('call(');
    expect(out.code).not.toContain('import');
    expect(out.code).not.toContain('a(b)'); // string content stripped
    expect(out.sawBacktick).toBe(false); // backticks inside comments don't count
  });

  test('no import or require statements', () => {
    expect(code, explain).not.toMatch(/\bimport\b/);
    expect(code, explain).not.toMatch(/\brequire\b/);
  });

  test('no spread operator', () => {
    expect(code, explain).not.toContain('...');
  });

  test('no call expressions', () => {
    expect(code, explain).not.toMatch(/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/);
  });

  test('no template literals or interpolation', () => {
    expect(sawBacktick, explain).toBe(false);
    expect(code, explain).not.toContain('${');
  });

  test('no duplicate keys within any map block', () => {
    // JS object evaluation silently keeps the LAST duplicate — the earlier
    // dep list becomes dead weight an editor can update to no effect, and
    // no runtime assertion can see the collapsed key. Scan the source.
    const blocks = src.split(/export const /).slice(1);
    const dupes: string[] = [];
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf(' '));
      const seen = new Set<string>();
      for (const match of block.matchAll(/^\s{2}'([^']+)':/gm)) {
        if (seen.has(match[1])) dupes.push(`${name}: '${match[1]}'`);
        seen.add(match[1]);
      }
    }
    expect(dupes, 'duplicate keys collapse silently — the earlier entry is dead').toEqual([]);
  });
});

describe('facade export parity', () => {
  test('every touchfiles-data export is re-exported by identity', () => {
    const dataExports = Object.keys(data);
    expect(dataExports.length).toBeGreaterThan(0);
    for (const name of dataExports) {
      expect(
        (facade as Record<string, unknown>)[name],
        `facade must re-export '${name}' from touchfiles-data by identity`,
      ).toBe((data as Record<string, unknown>)[name] as never);
    }
  });

  test('every test-selection export is re-exported by identity', () => {
    const logicExports = Object.keys(logic);
    expect(logicExports.length).toBeGreaterThan(0);
    for (const name of logicExports) {
      expect(
        (facade as Record<string, unknown>)[name],
        `facade must re-export '${name}' from test-selection by identity`,
      ).toBe((logic as Record<string, unknown>)[name] as never);
    }
  });

  test('facade exports exactly the union of both halves', () => {
    const union = new Set([...Object.keys(data), ...Object.keys(logic)]);
    expect(new Set(Object.keys(facade))).toEqual(union);
  });

  test('no export name collisions between data and logic', () => {
    const overlap = Object.keys(data).filter((k) => k in logic);
    expect(overlap).toEqual([]);
  });
});

describe('touchfiles-data exports are importable and non-empty', () => {
  test('E2E_TOUCHFILES has entries with non-empty pattern lists', () => {
    const keys = Object.keys(data.E2E_TOUCHFILES);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(data.E2E_TOUCHFILES[key].length, `E2E_TOUCHFILES['${key}'] is empty`).toBeGreaterThan(0);
    }
  });

  test('E2E_TIERS has entries with valid tier values', () => {
    const entries = Object.entries(data.E2E_TIERS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, tier] of entries) {
      expect(['gate', 'periodic'], `E2E_TIERS['${key}'] has invalid tier`).toContain(tier);
    }
  });

  test('LLM_JUDGE_TOUCHFILES has entries with non-empty pattern lists', () => {
    const keys = Object.keys(data.LLM_JUDGE_TOUCHFILES);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(data.LLM_JUDGE_TOUCHFILES[key].length, `LLM_JUDGE_TOUCHFILES['${key}'] is empty`).toBeGreaterThan(0);
    }
  });

  test('GLOBAL_TOUCHFILES is non-empty and covers the selection logic', () => {
    expect(data.GLOBAL_TOUCHFILES.length).toBeGreaterThan(0);
    // The logic file must stay a global touchfile: a bug in selectTests /
    // matchGlob mis-selects every test, so any change to it forces a full run.
    expect(data.GLOBAL_TOUCHFILES).toContain('test/helpers/test-selection.ts');
  });
});
