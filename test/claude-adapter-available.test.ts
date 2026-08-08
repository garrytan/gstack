/**
 * Unit tests for ClaudeAdapter.available() auth detection (issue #1890).
 *
 * The adapter must not drop the claude provider for a logged-in macOS
 * subscription install, where the credential lives in the login Keychain and
 * ~/.claude/.credentials.json is absent yet `claude -p` works. available()
 * stays strict on non-macOS, where ~/.claude/.credentials.json is the actual
 * credential store.
 *
 * Does NOT exercise the live CLI — resolveClaudeCommand is satisfied with a
 * real binary via GSTACK_CLAUDE_BIN, os.homedir is pointed at an empty dir so
 * the creds file is reliably absent, and process.platform is overridden.
 */

import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeAdapter } from './helpers/providers/claude';

const adapter = new ClaudeAdapter();
const origPlatform = process.platform;
const origKey = process.env.ANTHROPIC_API_KEY;
const origBin = process.env.GSTACK_CLAUDE_BIN;

let emptyHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  // A home with no ~/.claude/.credentials.json, regardless of the real machine.
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-test-'));
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(emptyHome);
  // resolveClaudeCommand resolves an existing absolute binary (not the live CLI).
  process.env.GSTACK_CLAUDE_BIN = process.execPath;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  homedirSpy.mockRestore();
  setPlatform(origPlatform);
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = origKey;
  if (origBin === undefined) delete process.env.GSTACK_CLAUDE_BIN;
  else process.env.GSTACK_CLAUDE_BIN = origBin;
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

test('macOS subscription install (no creds file, no key) reports available', async () => {
  setPlatform('darwin');
  const check = await adapter.available();
  expect(check.ok).toBe(true);
});

test('non-macOS with no creds file and no key reports not available', async () => {
  setPlatform('linux');
  const check = await adapter.available();
  expect(check.ok).toBe(false);
  expect(check.reason).toMatch(/No Claude auth found/);
});

test('ANTHROPIC_API_KEY makes the adapter available on any platform', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  setPlatform('linux');
  expect((await adapter.available()).ok).toBe(true);
  setPlatform('darwin');
  expect((await adapter.available()).ok).toBe(true);
});

test('a present .credentials.json makes the adapter available on non-macOS', async () => {
  setPlatform('linux');
  fs.mkdirSync(path.join(emptyHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(emptyHome, '.claude', '.credentials.json'), '{}');
  expect((await adapter.available()).ok).toBe(true);
});

test('an unresolvable binary still reports not available before the auth sniff', async () => {
  setPlatform('darwin');
  // A bare (non-absolute) name forces a PATH lookup, which fails — an absolute
  // override is trusted as-is by the resolver and would not exercise this path.
  process.env.GSTACK_CLAUDE_BIN = 'no-such-claude-binary-xyz';
  const check = await adapter.available();
  expect(check.ok).toBe(false);
  expect(check.reason).toMatch(/claude CLI not found/);
});
