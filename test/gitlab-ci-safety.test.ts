import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');

describe('GitLab CI installer safety', () => {
  test('does not pipe the remote Bun installer directly into a shell', () => {
    const ci = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf-8');
    const offenders = ci
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => /bun\.sh\/install/.test(text))
      .filter(({ text }) => /\bcurl\b.*\|\s*(bash|sh)\b/.test(text));

    expect(offenders).toEqual([]);
  });
});
