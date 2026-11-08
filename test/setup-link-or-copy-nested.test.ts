/**
 * _link_or_copy (non-Windows) must make DST a symlink to SRC, even when DST
 * already exists as a real directory from a prior install. `ln -snf SRC DST`
 * does NOT replace a real directory — it nests the link inside as DST/basename,
 * which produced the kiro-host `lib/lib -> <checkout>/lib` layout and broke
 * every bin script importing `$SCRIPT_DIR/../lib/<module>.ts` (e.g.
 * gstack-learnings-log importing jsonl-store.ts). Same extract-and-run harness
 * convention as test/setup-link-ownership.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { runBashScript } from './helpers/bash-script';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function not found: ${name}`);
  return SETUP_SRC.slice(start, end + 2);
}

function run(lines: string[], tmp: string) {
  const r = runBashScript(lines.join('\n'), {
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? '', HOME: tmp },
  });
  if (/command not found/.test(r.stderr ?? '')) {
    throw new Error(`harness drift (missing extracted helper):\n${r.stderr}`);
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mkSrc(tmp: string): string {
  const src = path.join(tmp, 'checkout-lib');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'jsonl-store.ts'), 'export const hasInjection = () => false;\n');
  fs.writeFileSync(path.join(src, 'other.ts'), 'export const x = 1;\n');
  return src;
}

describe.skipIf(process.platform === 'win32')('_link_or_copy: DST becomes a symlink to SRC, never a nested link', () => {
  test('DST is an existing real directory (prior install): it is replaced by a symlink, no nested DST/basename', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-link-nest-'));
    try {
      const src = mkSrc(tmp);
      const dst = path.join(tmp, 'install-lib');
      // Simulate the broken state: a real directory with a stale curated file.
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(path.join(dst, 'stale-curated.ts'), 'export const stale = 1;\n');

      const r = run(
        ['set -e', 'IS_WINDOWS=0', extractFn('_link_or_copy'), `_link_or_copy "${src}" "${dst}"`],
        tmp,
      );
      expect(r.status).toBe(0);

      // DST itself is now a symlink pointing at SRC.
      expect(fs.lstatSync(dst).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(dst)).toBe(fs.realpathSync(src));

      // The module the bin scripts import resolves directly under DST.
      expect(fs.existsSync(path.join(dst, 'jsonl-store.ts'))).toBe(true);

      // No nested link (DST/checkout-lib) and no leftover stale curated file.
      expect(fs.existsSync(path.join(dst, path.basename(src)))).toBe(false);
      expect(fs.existsSync(path.join(dst, 'stale-curated.ts'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('DST is an existing symlink: replaced atomically (regression guard for the existing path)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-link-relink-'));
    try {
      const src = mkSrc(tmp);
      const older = path.join(tmp, 'older-lib');
      fs.mkdirSync(older, { recursive: true });
      const dst = path.join(tmp, 'install-lib');
      fs.symlinkSync(older, dst);

      const r = run(
        ['set -e', 'IS_WINDOWS=0', extractFn('_link_or_copy'), `_link_or_copy "${src}" "${dst}"`],
        tmp,
      );
      expect(r.status).toBe(0);
      expect(fs.lstatSync(dst).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(dst)).toBe(fs.realpathSync(src));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('DST does not exist: a fresh symlink is created', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-link-fresh-'));
    try {
      const src = mkSrc(tmp);
      const dst = path.join(tmp, 'install-lib');
      const r = run(
        ['set -e', 'IS_WINDOWS=0', extractFn('_link_or_copy'), `_link_or_copy "${src}" "${dst}"`],
        tmp,
      );
      expect(r.status).toBe(0);
      expect(fs.lstatSync(dst).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(dst, 'jsonl-store.ts'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
