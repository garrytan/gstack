/**
 * lib/bin-context.ts — slug/branch/flag plumbing shared by the decision bins.
 *
 * Zero coverage before this file, despite being the single audited place the
 * decision bins get their slug, branch, and flag values from. The failure modes
 * are all "wrong data, no error": `resolveSlug` returning a partial line writes
 * decisions into the wrong project directory, and `flagValue` returning the
 * next flag instead of a value (`--project --json`) writes them under a slug
 * literally named `--json`.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveSlug, gitBranch, flagValue } from '../lib/bin-context';

const isWindows = process.platform === 'win32';
const tempDirs: string[] = [];

function makeSlugBin(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-context-'));
  tempDirs.push(dir);
  const bin = path.join(dir, 'gstack-slug');
  fs.writeFileSync(bin, `#!/usr/bin/env sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('flagValue', () => {
  const argv = ['--project', 'gstack', '--limit', '10', '--json'];

  test('returns the value following the flag', () => {
    expect(flagValue(argv, '--project')).toBe('gstack');
    expect(flagValue(argv, '--limit')).toBe('10');
  });

  test('absent flag → undefined', () => {
    expect(flagValue(argv, '--branch')).toBeUndefined();
    expect(flagValue([], '--project')).toBeUndefined();
  });

  test('trailing flag with nothing after it → undefined, not an empty string', () => {
    expect(flagValue(argv, '--json')).toBeUndefined();
  });

  test('first occurrence wins when a flag is repeated', () => {
    expect(flagValue(['--project', 'a', '--project', 'b'], '--project')).toBe('a');
  });

  test('exact match only — no prefix matching', () => {
    expect(flagValue(['--project-slug', 'x'], '--project')).toBeUndefined();
  });

  test('a following flag is returned verbatim (caller validates, not this helper)', () => {
    // Documents current behavior: --project with no value swallows the next flag.
    expect(flagValue(['--project', '--json'], '--project')).toBe('--json');
  });
});

describe('gitBranch', () => {
  test('inside this repo → the current branch name, never "HEAD"', () => {
    const branch = gitBranch();
    const expected = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
    if (expected && expected !== 'HEAD') {
      expect(branch).toBe(expected);
    } else {
      expect(branch).toBeUndefined();
    }
  });

  test('outside a git repo → undefined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-context-nogit-'));
    tempDirs.push(dir);
    const cwd = process.cwd();
    try {
      process.chdir(fs.realpathSync(dir));
      // A stray parent repo would invalidate the assertion; skip if the temp
      // dir happens to sit inside one.
      const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
      }).stdout.trim();
      if (inRepo !== 'true') expect(gitBranch()).toBeUndefined();
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('resolveSlug', () => {
  test('missing bin → "unknown" instead of throwing', () => {
    expect(resolveSlug(path.join(os.tmpdir(), 'definitely-not-a-real-slug-bin'))).toBe('unknown');
  });

  test.skipIf(isWindows)('parses SLUG= from the helper output', () => {
    expect(resolveSlug(makeSlugBin('echo SLUG=gstack'))).toBe('gstack');
  });

  test.skipIf(isWindows)('trims trailing whitespace from the value', () => {
    expect(resolveSlug(makeSlugBin('printf "SLUG=gstack   \\n"'))).toBe('gstack');
  });

  test.skipIf(isWindows)('finds SLUG= on a later line, ignoring other exports', () => {
    expect(resolveSlug(makeSlugBin('echo PROJECT_ROOT=/x\necho SLUG=my-app'))).toBe('my-app');
  });

  test.skipIf(isWindows)('output without a SLUG= line → "unknown"', () => {
    expect(resolveSlug(makeSlugBin('echo PROJECT_ROOT=/x'))).toBe('unknown');
  });

  test.skipIf(isWindows)('no output at all → "unknown"', () => {
    expect(resolveSlug(makeSlugBin('exit 0'))).toBe('unknown');
  });

  test.skipIf(isWindows)('SLUG= must start the line — indented output is not matched', () => {
    expect(resolveSlug(makeSlugBin('echo "  SLUG=indented"'))).toBe('unknown');
  });
});
