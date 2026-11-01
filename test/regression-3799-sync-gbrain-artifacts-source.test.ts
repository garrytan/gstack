/**
 * Regression for #3799: the GBrain Search Guidance block /sync-gbrain writes
 * into CLAUDE.md named the curated-memory source `gstack-brain-<user>`, but
 * the v1.27.0.0 rename made bin/gstack-artifacts-init register
 * `gstack-artifacts-<user>`. Every agent following the block ran
 * `gbrain search ... --source gstack-brain-<user>` and got unknown_source.
 * Pins the block's source name to the one gstack-artifacts-init registers, in
 * the template, the generated skill and this repo's own CLAUDE.md copy.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const START = '<!-- gstack-gbrain-search-guidance:start -->';
const END = '<!-- gstack-gbrain-search-guidance:end -->';

function guidanceBlock(rel: string): string {
  const text = read(rel);
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error(`${rel}: GBrain Search Guidance markers not found`);
  return text.slice(start, end + END.length);
}

const registered = read('bin/gstack-artifacts-init').match(/^SOURCE_ID="([a-z0-9-]+-)\$\{USER:-\$\(whoami\)\}"$/m)?.[1];

describe('#3799 /sync-gbrain guidance names the source gstack-artifacts-init registers', () => {
  test('gstack-artifacts-init registers a per-user source id', () => {
    expect(registered).toBe('gstack-artifacts-');
  });

  for (const rel of ['sync-gbrain/SKILL.md.tmpl', 'sync-gbrain/SKILL.md', 'CLAUDE.md']) {
    test(`${rel}: curated-memory search uses ${registered}<user>`, () => {
      const block = guidanceBlock(rel);
      expect(block).toContain(`--source ${registered}<user>`);
      expect(block).not.toContain('gstack-brain-<user>');
      for (const m of block.matchAll(/--source ([a-z-]+)<user>/g)) expect(m[1]).toBe(registered!);
    });
  }
});
