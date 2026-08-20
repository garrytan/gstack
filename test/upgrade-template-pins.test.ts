/**
 * Static pins for the v1.68 wave's prose-tier behaviors — the coverage audit
 * flagged these as the only surfaces a future template edit could silently
 * revert without failing anything.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('gstack-upgrade template: ff-only precedes the gated reset (#2517)', () => {
  const tmpl = read('gstack-upgrade/SKILL.md.tmpl');

  test('git pull --ff-only runs before any reset --hard', () => {
    const ff = tmpl.indexOf('git pull --ff-only --autostash');
    const reset = tmpl.indexOf('git reset --hard origin/main');
    expect(ff).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    expect(ff).toBeLessThan(reset);
  });

  test('the ff path carries the FF_OK success gate that skips the fallback', () => {
    expect(tmpl).toContain('FF_OK');
    expect(tmpl.indexOf('FF_OK')).toBeLessThan(tmpl.indexOf('git reset --hard origin/main'));
  });

  test('the destructive fallback is gated on unpushed commits, not just a clean tree', () => {
    // A clean tree with unpushed local commits is NOT safe for reset --hard.
    expect(tmpl).toContain('git rev-list origin/main..HEAD');
    expect(tmpl.indexOf('git rev-list origin/main..HEAD')).toBeLessThan(
      tmpl.indexOf('git reset --hard origin/main'),
    );
  });
});

describe('untrusted-content warning injection points (#2441)', () => {
  test('scrape and skillify templates carry the shared token', () => {
    // The wording lives in ONE exported const (resolvers/browse.ts); these
    // pins keep the injection POINTS from silently disappearing.
    expect(read('scrape/SKILL.md.tmpl')).toContain('{{UNTRUSTED_CONTENT_WARNING}}');
    expect(read('skillify/SKILL.md.tmpl')).toContain('{{UNTRUSTED_CONTENT_WARNING}}');
  });
});

describe('brain-uninstall removes the spool queue', () => {
  test('uninstall cleans .brain-queue.d alongside the legacy queue file', () => {
    const src = read('bin/gstack-brain-uninstall');
    expect(src).toContain('.brain-queue.d');
    expect(src).toContain('.brain-queue.jsonl');
  });
});
