import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorsOf, brokenLinks } from '../lib/doc-links';

test('heading IDs remain unique when a natural suffix collides with a duplicate', () => {
  expect([...anchorsOf('# A\n# A\n# A-1\n# A\n')]).toEqual(['a', 'a-1', 'a-1-1', 'a-2']);
});

test('shorter fences and backticks followed by text do not close a code block', () => {
  const text = '````md\n```\n# Hidden\n```` trailing\n# Also hidden\n````\n# Visible\n';
  expect([...anchorsOf(text)]).toEqual(['visible']);
});

test('a backtick line with backticks after the marker is inline code, not a fence', () => {
  const text = '# Before\n```` ```receipt ```` block in the PR body.\n# After\n';
  expect([...anchorsOf(text)]).toEqual(['before', 'after']);
});

test('a repository filename beginning with two dots is not an escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-links-'));
  try {
    writeFileSync(join(root, 'README.md'), '[inside](..notes.md)\n[outside](../outside.md)\n');
    writeFileSync(join(root, '..notes.md'), '# Notes\n');
    expect(brokenLinks(root, ['README.md'])).toEqual([
      { file: 'README.md', line: 2, target: '../outside.md', reason: 'points outside the repository' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
