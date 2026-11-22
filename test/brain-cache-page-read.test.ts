/**
 * #4265: single-page brain-cache entities read the page text gbrain's
 * `get --json` actually returns (compiled_truth; body is a read-mode name),
 * under the lowercased slug gbrain stores.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';

const CACHE = '../bin/gstack-brain-cache';
let TMP_HOME: string;
let STUB: string;
const saved = { home: process.env.GSTACK_HOME, path: process.env.PATH };

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), 'gstack-cache-page-'));
  STUB = mkdtempSync(join(tmpdir(), 'gstack-cache-page-gbrain-'));
  writeFileSync(join(STUB, 'page.json'), JSON.stringify({
    slug: 'gstack/product/some-org-some-repo',
    title: 'Some product',
    body: 'auto',
    compiled_truth: '## What it is\nA tool that ships code.',
    timeline: '',
  }) + '\n');
  writeFileSync(join(STUB, 'gbrain'), [
    '#!/bin/sh',
    'here=$(dirname "$0")',
    'echo "$@" >> "$here/calls"',
    '[ "$1" = get ] && [ "$2" = gstack/product/some-org-some-repo ] && cat "$here/page.json" && exit 0',
    'echo "page_not_found" >&2',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(join(STUB, 'gbrain'), 0o755);
  process.env.PATH = `${STUB}${delimiter}${saved.path ?? ''}`;
  process.env.GSTACK_HOME = TMP_HOME;
  delete require.cache[require.resolve(CACHE)];
});

afterEach(() => {
  if (saved.home) process.env.GSTACK_HOME = saved.home; else delete process.env.GSTACK_HOME;
  process.env.PATH = saved.path;
  rmSync(TMP_HOME, { recursive: true, force: true });
  rmSync(STUB, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('brain-cache single-page read (#4265)', () => {
  test('a product page under a mixed-case project slug comes back as a digest', async () => {
    const mod = await import(CACHE);
    const result = mod.cmdGet('product', 'Some-Org-some-repo');
    expect(result.state).toBe('cold-refreshed');
    const digest = readFileSync(result.path, 'utf-8');
    expect(digest).toContain('# Some product');
    expect(digest).toContain('A tool that ships code.');
    expect(digest).not.toContain('auto');
    expect(readFileSync(join(STUB, 'calls'), 'utf-8')).toContain('get gstack/product/some-org-some-repo --json');
  });
});
