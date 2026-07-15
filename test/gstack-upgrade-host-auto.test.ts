import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf-8');
const GENERATED = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md'), 'utf-8');

function setupCommandLines(src: string): string[] {
  return src
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('./setup'));
}

describe('/gstack-upgrade host refresh', () => {
  test('source template re-registers auto-detected hosts after every upgrade', () => {
    const lines = setupCommandLines(TEMPLATE);

    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines).toEqual(expect.arrayContaining([
      './setup --host auto',
      'cd "$INSTALL_DIR" && ./setup --host auto',
      'cd "$LOCAL_GSTACK" && ./setup --host auto',
    ]));
    expect(lines.filter(line => line === './setup' || line.endsWith('&& ./setup'))).toEqual([]);
  });

  test('generated skill matches the host-aware upgrade contract', () => {
    const lines = setupCommandLines(GENERATED);

    expect(lines).toEqual(expect.arrayContaining([
      './setup --host auto',
      'cd "$INSTALL_DIR" && ./setup --host auto',
      'cd "$LOCAL_GSTACK" && ./setup --host auto',
    ]));
    expect(lines.filter(line => line === './setup' || line.endsWith('&& ./setup'))).toEqual([]);
  });
});
