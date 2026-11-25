/**
 * .gitattributes line endings for executables (#3110).
 *
 * Git for Windows checks out with core.autocrlf=true. A tracked script with no
 * `eol` rule is written with CRLF there, and a Linux bash reading that
 * checkout (a synced tree, WSL, a bind mount) fails on `set -o pipefail\r`.
 * `bin/*` is anchored at the root, so nested bin/ dirs, the hook shims and
 * the app launcher had no rule. This pins the rules for
 * every tracked file that starts with `#!`, and keeps the broad patterns from
 * marking a binary file as text.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function git(args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8', input, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function trackedShebangFiles(): string[] {
  return git(['ls-files', '-z']).split('\0').filter((f) => {
    if (!f) return false;
    const full = path.join(ROOT, f);
    let fd: number | undefined;
    try {
      if (!fs.statSync(full).isFile()) return false;
      fd = fs.openSync(full, 'r');
      const head = Buffer.alloc(2);
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!';
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
}

describe('.gitattributes eol rules (#3110)', () => {
  test('every tracked file that starts with #! resolves to eol=lf', () => {
    const files = trackedShebangFiles();
    expect(files.length).toBeGreaterThan(100);
    const out = git(['check-attr', '-z', '--stdin', 'eol'], files.join('\0') + '\0').split('\0');
    const missing: string[] = [];
    for (let i = 0; i + 2 < out.length; i += 3) {
      if (out[i + 2] !== 'lf') missing.push(`${out[i]} (eol: ${out[i + 2]})`);
    }
    expect(missing).toEqual([]);
  });

  test('the nested executables named in #3110 are covered', () => {
    const named = [
      'autoplan/bin/phase-publication-hook',
      'plan-ceo-review/bin/mode-handoff-hook',
      'hosts/claude/hooks/timeline-stop-hook',
      'browse/bin/remote-slug',
      'scripts/app/gstack-browser',
      'browse/test/fixtures/mock-claude/claude',
    ];
    const out = git(['check-attr', 'eol', '--', ...named]);
    for (const f of named) expect(out).toContain(`${f}: eol: lf`);
  });

  test('no file git stores as binary is marked text by the broad patterns', () => {
    const wronglyText = git(['ls-files', '--eol'])
      .split('\n')
      .filter((line) => line.startsWith('i/-text') && /\sattr\/text\b/.test(line));
    expect(wronglyText).toEqual([]);
  });

  test('every shebang file is stored with LF in the index', () => {
    const files = new Set(trackedShebangFiles());
    const crlf = git(['ls-files', '--eol'])
      .split('\n')
      .filter((line) => /^i\/(crlf|mixed)\s/.test(line) && files.has(line.split('\t')[1] ?? ''));
    expect(crlf).toEqual([]);
  });
});
