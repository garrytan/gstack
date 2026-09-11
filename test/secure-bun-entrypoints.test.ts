import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
describe('secure authority entrypoints', () => {
  test('has a literal non-env anchor and a closed registry', () => {
    const anchor = fs.readFileSync(path.join(root, 'bin/gstack-anchor'), 'utf8');
    expect(anchor.startsWith('#!/bin/sh\nPATH=/usr/bin:/bin\n')).toBe(true);
    expect(anchor).not.toContain('command -v');
    const registry = fs.readFileSync(path.join(root, 'lib/authority-command-registry.ts'), 'utf8');
    expect(registry).toContain("'gstack-effect-scope'");
    expect(registry).not.toContain('process.argv');
  });
});
