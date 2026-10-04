/**
 * Tripwire and fix messages point readers at docs/TESTING_INTERNALS.md#<anchor>.
 * Every such anchor in code must match a heading there, or the fix text sends
 * the reader to the top of a 900-line page.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const DOC = 'docs/TESTING_INTERNALS.md';
const SCAN = ['scripts', 'test', 'lib', 'bin', '.github'];

function githubSlug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'dist') continue;
      out.push(...walk(rel));
    } else if (/\.(ts|sh|ya?ml|mjs)$/.test(entry.name) || !entry.name.includes('.')) out.push(rel);
  }
  return out;
}

test('every TESTING_INTERNALS.md anchor named in code matches a heading', () => {
  const anchors = new Set(
    [...fs.readFileSync(path.join(ROOT, DOC), 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(match => githubSlug(match[1]!)),
  );
  const references = SCAN.flatMap(walk).flatMap(file =>
    [...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/TESTING_INTERNALS\.md#([a-z0-9-]+)/g)]
      .map(match => ({ file, anchor: match[1]! })));
  expect(references.length, 'scan found no TESTING_INTERNALS.md anchors; the regex or scan roots rotted').toBeGreaterThan(0);
  const missing = references.filter(ref => !anchors.has(ref.anchor) && ref.file !== 'test/testing-internals-anchors.test.ts');
  expect(missing.map(ref => `${ref.file} points at ${DOC}#${ref.anchor}, which has no heading; fix: add a "### " heading with that slug to ${DOC} or correct the link`))
    .toEqual([]);
});
