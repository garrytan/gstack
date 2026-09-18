/** Free coverage of the config actually handed to temp-workspace PTY children. */
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchClaudePty, type ClaudePtyOptions } from './helpers/claude-pty-runner';
import { getHermeticDirs, hermeticSkillsConfigDir } from './helpers/hermetic-env';

const ROOT = path.resolve(import.meta.dir, '..');

async function withFixture(check: (fixture: {
  cwd: string;
  launch: (opts?: ClaudePtyOptions) => Promise<{
    session: Awaited<ReturnType<typeof launchClaudePty>>;
    env: Record<string, string>;
  }>;
}) => Promise<void>): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-workspace-trust-'));
  const previous = {
    binary: process.env.BROWSE_TERMINAL_BINARY,
    hermetic: process.env.EVALS_HERMETIC,
  };
  process.env.BROWSE_TERMINAL_BINARY = process.execPath;
  process.env.EVALS_HERMETIC = '1';
  let childEnv: Record<string, string> = {};
  const spawn = spyOn(Bun, 'spawn').mockImplementation((_command: any, options: any) => {
    childEnv = options.env;
    // Report the same acceptance condition the real CLI checks, before a
    // workflow/model turn. This exercises the actual launch environment.
    const configPath = path.join(childEnv.CLAUDE_CONFIG_DIR, '.claude.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const trusted = config.projects?.[fs.realpathSync(options.cwd)]?.hasTrustDialogAccepted === true;
    options.terminal.data(null, Buffer.from(trusted ? 'FIXTURE_READY' : 'FIXTURE_UNTRUSTED'));
    return { exited: Promise.resolve(trusted ? 0 : 1), terminal: { write() {} }, kill() {} } as any;
  });
  const sessions: Array<Awaited<ReturnType<typeof launchClaudePty>>> = [];
  try {
    await check({
      cwd,
      launch: async (opts = {}) => {
        const session = await launchClaudePty({ cwd, seedSkills: true, ...opts });
        sessions.push(session);
        return { session, env: { ...childEnv } };
      },
    });
  } finally {
    for (const session of sessions) await session.close();
    spawn.mockRestore();
    for (const [key, value] of Object.entries({ BROWSE_TERMINAL_BINARY: previous.binary, EVALS_HERMETIC: previous.hermetic })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe('PTY temporary workspace trust', () => {
  test('temporary workspaces share owned registration without rewriting trust or losing plan artifacts', async () => {
    await withFixture(async ({ cwd, launch }) => {
      const shared = hermeticSkillsConfigDir();
      const before = fs.readFileSync(path.join(shared, '.claude.json'), 'utf8');
      const alias = path.join(cwd, 'alias');
      const workspace = path.join(cwd, 'workspace');
      fs.mkdirSync(workspace);
      fs.symlinkSync(workspace, alias, 'dir');
      const first = await launch({ cwd: alias, env: { ANTHROPIC_API_KEY: 'test-effective-key-12345678901234567890', GSTACK_HOME: path.join(cwd, 'state') } });
      const second = await launch();
      const sameWorkspace = await launch({ cwd: alias });
      for (const child of [first, second, sameWorkspace]) {
        // Main accepts the native trust dialog; it does not manufacture a
        // trusted-folder entry for each disposable cwd before the CLI starts.
        expect(child.session.visibleText()).toBe('FIXTURE_UNTRUSTED');
        expect(child.env.CLAUDE_CONFIG_DIR).toBe(shared);
        expect(child.session.hermeticConfigDir).toBe(shared);
        expect(child.env.HOME.startsWith(getHermeticDirs().runRoot + path.sep)).toBe(true);
        expect(fs.existsSync(path.join(shared, 'settings.json'))).toBe(false);
      }
      expect(first.env.GSTACK_HOME).toBe(path.join(cwd, 'state'));
      expect(fs.readFileSync(path.join(shared, '.claude.json'), 'utf8')).toBe(before);
      expect(fs.realpathSync(path.join(first.env.CLAUDE_CONFIG_DIR, 'skills', 'autoplan', 'SKILL.md')))
        .toBe(fs.realpathSync(path.join(ROOT, 'autoplan', 'SKILL.md')));
      const plans = path.join(shared, 'plans');
      fs.mkdirSync(plans, {recursive: true});
      expect(fs.realpathSync(plans).startsWith(fs.realpathSync(getHermeticDirs().runRoot) + path.sep)).toBe(true);
      const plan = path.join(plans, path.basename(cwd) + '.md');
      fs.writeFileSync(plan, 'plan evidence');
      await first.session.close();
      expect(fs.readFileSync(plan, 'utf8')).toBe('plan evidence');
    });
  });

  test('does not seed skills when the caller did not request them', async () => {
    await withFixture(async ({ launch }) => {
      const { session, env } = await launch({ seedSkills: false });
      expect(session.visibleText()).toBe('FIXTURE_UNTRUSTED');
      expect(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'))).toBe(false);
    });
  });

  test('preserves explicit config overrides and the hermetic opt-out', async () => {
    await withFixture(async ({ cwd, launch }) => {
      const explicit = path.join(cwd, 'explicit');
      fs.mkdirSync(explicit);
      fs.writeFileSync(path.join(explicit, '.claude.json'), '{"diffSidebarOpen":true}');
      const explicitSettings = '{"useAutoModeDuringPlan":true,"permissions":{"deny":["Read"]}}';
      fs.writeFileSync(path.join(explicit, 'settings.json'), explicitSettings);
      const override = await launch({ env: { CLAUDE_CONFIG_DIR: explicit } });
      expect(override.env.CLAUDE_CONFIG_DIR).toBe(explicit);
      expect(fs.readFileSync(path.join(explicit, 'settings.json'), 'utf8')).toBe(explicitSettings);
      expect(override.session.visibleText()).toBe('FIXTURE_UNTRUSTED');
      expect(fs.readFileSync(path.join(explicit, '.claude.json'), 'utf8')).toBe('{"diffSidebarOpen":true}');
      process.env.EVALS_HERMETIC = '0';
      const legacy = await launch({ env: { CLAUDE_CONFIG_DIR: explicit } });
      expect(legacy.env.CLAUDE_CONFIG_DIR).toBe(explicit);
      expect(legacy.session.hermeticConfigDir).toBeNull();
      expect(fs.readFileSync(path.join(explicit, 'settings.json'), 'utf8')).toBe(explicitSettings);
      expect(legacy.session.visibleText()).toBe('FIXTURE_UNTRUSTED');
      expect(fs.readFileSync(path.join(explicit, '.claude.json'), 'utf8')).toBe('{"diffSidebarOpen":true}');
    });
  });

  test('keeps the existing repo-cwd config selection', async () => {
    await withFixture(async ({ launch }) => {
      expect((await launch({ cwd: ROOT })).env.CLAUDE_CONFIG_DIR).toBe(hermeticSkillsConfigDir());
      expect((await launch({ cwd: ROOT, seedSkills: false })).env.CLAUDE_CONFIG_DIR).toBe(getHermeticDirs().configDir);
    });
  });

  test('fails loudly and removes a partial private config when seeding fails', async () => {
    await withFixture(async ({ cwd, launch }) => {
      hermeticSkillsConfigDir();
      const runRoot = getHermeticDirs().runRoot;
      const before = fs.readdirSync(runRoot).sort();
      await expect(launch({ cwd: path.join(cwd, 'does-not-exist') })).rejects.toThrow('ENOENT');
      expect(fs.readdirSync(runRoot).sort()).toEqual(before);
    });
  });
});


test.skipIf(process.platform === 'win32')('a live PTY child receives only owned runtime paths and the requested native observer', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-companion-')));
  const binary = path.join(cwd, 'fake-cli.ts');
  fs.writeFileSync(binary, `#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'pty-companion-cli.ts'), 'utf8')}`, { mode: 0o700 });
  const priorBinary = process.env.BROWSE_TERMINAL_BINARY, priorHermetic = process.env.EVALS_HERMETIC;
  process.env.BROWSE_TERMINAL_BINARY = binary; process.env.EVALS_HERMETIC = '1';
  let session: Awaited<ReturnType<typeof launchClaudePty>> | undefined;
  try {
    session = await launchClaudePty({ cwd, seedSkills: true, model: 'fixture', timeoutMs: 5000,
      observeSetupQuestions: true });
    await session.waitFor(/COMPANION_SETTINGS /, 5000);
    const printed = JSON.parse(session.visibleText().match(/COMPANION_SETTINGS (.+)/)![1]);
    expect(printed.settings).toBeNull();
    expect(printed.args.slice(0, 4)).toEqual(['--model', 'fixture', '--permission-mode', 'plan']);
    expect(printed.args).not.toContain('--allowedTools');
    const additions = printed.args.flatMap((arg: string, index: number) => arg === '--add-dir' ? [printed.args[index + 1]] : []);
    expect(additions).toHaveLength(3);
    for (const directory of additions) expect(directory.startsWith(getHermeticDirs().runRoot + path.sep)).toBe(true);
    expect(fs.realpathSync(additions[0])).toBe(fs.realpathSync(ROOT));
    expect(additions[1]).toBe(session.hermeticSkillStateRoot);
    expect(additions[2]).toBe(path.join(hermeticSkillsConfigDir(), 'skills'));
    const hooks = JSON.parse(printed.args[printed.args.indexOf('--settings') + 1]);
    expect(Object.keys(hooks)).toEqual(['hooks']);
    expect(Object.keys(hooks.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
    for (const entries of Object.values(hooks.hooks) as Array<Array<{matcher: string}>>) {
      expect(entries).toHaveLength(1);
      expect(entries[0].matcher).toBe('^AskUserQuestion$');
    }
  } finally {
    await session?.close();
    if (priorBinary === undefined) delete process.env.BROWSE_TERMINAL_BINARY; else process.env.BROWSE_TERMINAL_BINARY = priorBinary;
    if (priorHermetic === undefined) delete process.env.EVALS_HERMETIC; else process.env.EVALS_HERMETIC = priorHermetic;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 10000);
