import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveClaudeCommand, resolveClaudeBinary } from '../src/claude-bin';

// Empty env baseline — no PATH, no overrides — ensures no environmental claude binary leaks in.
const EMPTY_ENV = { PATH: '', Path: '' } as NodeJS.ProcessEnv;

describe('claude-bin', () => {
  test('no override, no PATH match → returns null', () => {
    expect(resolveClaudeCommand(EMPTY_ENV)).toBeNull();
    expect(resolveClaudeBinary(EMPTY_ENV)).toBeNull();
  });

  test('absolute-path override returned as-is', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      GSTACK_CLAUDE_BIN: '/opt/custom/claude',
    });
    expect(got).toEqual({ command: '/opt/custom/claude', argsPrefix: [] });
  });

  test('CLAUDE_BIN works as fallback alias for GSTACK_CLAUDE_BIN', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      CLAUDE_BIN: '/opt/custom/claude',
    });
    expect(got?.command).toBe('/opt/custom/claude');
  });

  test('GSTACK_CLAUDE_BIN takes precedence over CLAUDE_BIN', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      GSTACK_CLAUDE_BIN: '/explicit/path',
      CLAUDE_BIN: '/fallback/path',
    });
    expect(got?.command).toBe('/explicit/path');
  });

  test('PATH-resolvable override goes through Bun.which (the bug the fork shipped)', () => {
    // Make a fake binary in a temp dir, point PATH at it, set override to bare command name.
    // Windows requires the file to have a PATHEXT-listed extension to be discoverable
    // via Bun.which — without the extension Bun.which returns undefined.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-test-'));
    const isWindows = process.platform === 'win32';
    const fakeBinName = isWindows ? 'fake-claude-cli.cmd' : 'fake-claude-cli';
    const fakeBin = path.join(tmpDir, fakeBinName);
    fs.writeFileSync(fakeBin, isWindows ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n');
    if (!isWindows) fs.chmodSync(fakeBin, 0o755);
    try {
      const got = resolveClaudeCommand({
        PATH: tmpDir,
        GSTACK_CLAUDE_BIN: 'fake-claude-cli',
      });
      expect(got?.command).toBe(fakeBin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('override pointing at missing binary → null (no silent fallback to bare claude)', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      GSTACK_CLAUDE_BIN: 'definitely-not-a-real-binary-xyz',
    });
    expect(got).toBeNull();
  });

  test('GSTACK_CLAUDE_BIN_ARGS as JSON array → parsed argsPrefix', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      GSTACK_CLAUDE_BIN: '/opt/custom/claude',
      GSTACK_CLAUDE_BIN_ARGS: '["--no-cache", "--verbose"]',
    });
    expect(got?.argsPrefix).toEqual(['--no-cache', '--verbose']);
  });

  test('GSTACK_CLAUDE_BIN_ARGS as scalar string → treated as single argument', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      GSTACK_CLAUDE_BIN: '/opt/custom/claude',
      GSTACK_CLAUDE_BIN_ARGS: 'claude',
    });
    expect(got?.argsPrefix).toEqual(['claude']);
  });

  test('argsPrefix empty when no override args set', () => {
    const got = resolveClaudeCommand({
      ...EMPTY_ENV,
      GSTACK_CLAUDE_BIN: '/opt/custom/claude',
    });
    expect(got?.argsPrefix).toEqual([]);
  });
});
