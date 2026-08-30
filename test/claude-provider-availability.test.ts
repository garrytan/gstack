import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeAdapter } from './helpers/providers/claude';

const MANAGED_ENV = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_BIN',
  'CLAUDE_BIN_ARGS',
  'FAKE_CLAUDE_AUTH_FAIL',
  'FAKE_CLAUDE_LOGGED_IN',
  'GSTACK_CLAUDE_BIN',
  'GSTACK_CLAUDE_BIN_ARGS',
  'PATH',
] as const;

describe('ClaudeAdapter availability', () => {
  let originalEnv: Record<string, string | undefined>;
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'gstack-claude-provider-'));
    const fakeCli = join(scratchDir, 'fake-claude.ts');
    writeFileSync(fakeCli, `
const args = Bun.argv.slice(2);
if (args.join(' ') === 'auth status --json') {
  if (process.env.FAKE_CLAUDE_AUTH_FAIL === '1') process.exit(3);
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN === '1' }));
} else if (args.includes('-p')) {
  console.log(JSON.stringify({ result: JSON.stringify(args), usage: {} }));
} else {
  process.exit(2);
}
`);
    // Mutate env LAST: any throwing setup above (mkdtemp/writeFile) runs before
    // env is touched, so a failure can't leave vars deleted in this shared
    // process for the rest of the shard.
    originalEnv = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
    for (const key of MANAGED_ENV) delete process.env[key];
    process.env.GSTACK_CLAUDE_BIN = process.execPath;
    process.env.GSTACK_CLAUDE_BIN_ARGS = JSON.stringify([fakeCli]);
  });

  afterEach(() => {
    for (const key of MANAGED_ENV) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test('accepts the Claude CLI loggedIn status without a credentials file', async () => {
    process.env.FAKE_CLAUDE_LOGGED_IN = '1';
    expect(await new ClaudeAdapter().available()).toEqual({ ok: true });
  });

  test('rejects logged-out CLI status with the exact login command', async () => {
    process.env.FAKE_CLAUDE_LOGGED_IN = '0';
    const result = await new ClaudeAdapter().available();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('claude auth login');
  });

  test('accepts ANTHROPIC_API_KEY as a non-interactive fallback', async () => {
    process.env.FAKE_CLAUDE_LOGGED_IN = '0';
    process.env.ANTHROPIC_API_KEY = 'test-only-placeholder';
    expect(await new ClaudeAdapter().available()).toEqual({ ok: true });
  });

  test('distinguishes a broken auth probe from a logged-out CLI', async () => {
    process.env.FAKE_CLAUDE_LOGGED_IN = '1';
    process.env.FAKE_CLAUDE_AUTH_FAIL = '1';
    const result = await new ClaudeAdapter().available();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Could not verify Claude auth');
  });

  test('unresolvable claude binary → not-found reason before any probe', async () => {
    delete process.env.GSTACK_CLAUDE_BIN;
    delete process.env.GSTACK_CLAUDE_BIN_ARGS;
    process.env.PATH = scratchDir;
    const result = await new ClaudeAdapter().available();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('claude CLI not found on PATH');
  });

  test('runs without loading user settings or inherited MCP servers', async () => {
    const result = await new ClaudeAdapter().run({
      prompt: 'test prompt',
      workdir: scratchDir,
      timeoutMs: 2_000,
    });
    const args = JSON.parse(result.output) as string[];
    expect(args).toContain('--setting-sources');
    expect(args).toContain('project');
    expect(args).toContain('--strict-mcp-config');
  });
});
