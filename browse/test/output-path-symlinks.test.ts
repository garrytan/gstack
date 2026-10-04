/**
 * Output-destination validation (salvaged from #2971): validateOutputPath must
 * judge the path the kernel will actually write, component by component.
 * The fixture lives under /var/tmp, outside every safe directory, and the
 * validator runs in a child whose cwd (a safe directory) is the fixture's
 * allowed dir; nothing is ever written to HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const VALIDATOR = path.resolve(import.meta.dir, '../src/path-security.ts');
const POSIX = process.platform !== 'win32' && fs.existsSync('/var/tmp');
let root = '';
let allowed = '';
let outside = '';

beforeAll(() => {
  if (!POSIX) return;
  root = fs.realpathSync(fs.mkdtempSync('/var/tmp/gstack-output-path-'));
  allowed = path.join(root, 'allowed');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(allowed, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(allowed, 'internal.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'existing.txt'), 'x');
  const links: Array<[string, string]> = [
    ['internal-link.txt', path.join(allowed, 'internal.txt')],
    ['internal-parent', path.join(allowed, 'nested')],
    ['outward-live.txt', path.join(outside, 'existing.txt')],
    ['outward-dangling.txt', path.join(outside, 'missing.txt')],
    ['outward-parent', outside],
    ['outward-nested', path.join(outside, 'nested')],
    ['dangling-parent', path.join(outside, 'missing-dir')],
    ['loop', path.join(allowed, 'loop')],
  ];
  for (const [name, target] of links) fs.symlinkSync(target, path.join(allowed, name));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function verdicts(files: string[]): Record<string, string | null> {
  const script = `
    import { validateOutputPath } from ${JSON.stringify(VALIDATOR)};
    const out = {};
    for (const f of JSON.parse(process.argv[1])) {
      try { validateOutputPath(f); out[f] = null; } catch (e) { out[f] = e.message; }
    }
    console.log(JSON.stringify(out));
  `;
  const r = Bun.spawnSync([process.execPath, '-e', script, JSON.stringify(files)], {
    cwd: allowed,
    env: { ...process.env, TMPDIR: path.join(allowed, 'nested') },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString());
}

describe.skipIf(!POSIX)('validateOutputPath follows the physical path', () => {
  test('ordinary, new, and in-root symlinked destinations are allowed', () => {
    const files = ['ordinary.txt', 'new-dir/deeper/new.txt', 'internal-link.txt', 'internal-parent/x.txt', 'nested/../x.txt'];
    expect(verdicts(files.map(f => path.join(allowed, f)))).toEqual(Object.fromEntries(files.map(f => [path.join(allowed, f), null])));
  });

  test('destinations that a write would land outside are rejected', () => {
    const files = ['outward-live.txt', 'outward-dangling.txt', 'outward-parent/new.txt', 'outward-nested/../escaped.txt', 'dangling-parent/new.txt', 'loop', 'loop/new.txt'];
    const result = verdicts(files.map(f => `${allowed}/${f}`));
    for (const f of files) expect(result[`${allowed}/${f}`]).toContain('Path must be within');
    expect(fs.existsSync(path.join(outside, 'missing.txt'))).toBe(false);
  });
});
