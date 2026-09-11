import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeAdapter, claudeExecArgs, claudeExecEnvironment, claudeExecWorkingDirectory, claudeProducerPaths, resultFromClaudeOutput } from './helpers/providers/claude';
import { codexExecArgs, codexExecEnvironment, codexExecWorkingDirectory, codexProducerConfig, codexProducerPaths, GptAdapter, resultFromCodexStream } from './helpers/providers/gpt';
import { geminiExecArgs, geminiExecEnvironment, geminiExecWorkingDirectory, geminiProducerPaths, geminiProducerSystemSettings } from './helpers/providers/gemini';
import { CSO_PRODUCER_SHELL_ENV, csoProducerChildEnvironment } from './helpers/providers/types';

const ENV_KEYS = ['PATH', 'GSTACK_CLAUDE_BIN', 'GSTACK_CLAUDE_BIN_ARGS',
  'GSTACK_CODEX_MODEL', 'EVALS_MODEL', 'GSTACK_EVAL_MODEL', 'GSTACK_EVAL_MODEL_CAPTURE'];
let saved: Record<string, string | undefined>;
let workdir: string;

describe('CSO producer provider policies', () => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const helperAt = (directory: string) => join(directory, `gstack-cso-launcher${suffix}`);
  const providerAt = (directory: string) => ({ executable: join(directory, `provider${suffix}`), argsPrefix: [] as string[] });
  const policy = (stateDirectory: string, sourceDirectory: string, helperLauncher: string) => ({
    stateDirectory, sourceDirectory, helperLauncher, helperGeneration: join(dirname(helperLauncher), '.gstack-cso-generation'), providerCommand: providerAt(dirname(helperLauncher)),
  });

  test('keeps exact Codex read-only defaults and gives the producer a custom least-privilege profile', () => {
    const providerWorkdir = join(tmpdir(), 'gstack-provider-work');
    const common = { prompt: 'Reply OK', workdir: providerWorkdir, timeoutMs: 5000 };
    expect(codexExecArgs(common, 'gpt-test')).toEqual([
      'exec', 'Reply OK', '-C', providerWorkdir,
      '-s', 'read-only', '--skip-git-repo-check', '--json', '-m', 'gpt-test',
    ]);

    const state = join(providerWorkdir, 'state');
    const source = join(providerWorkdir, 'source');
    const helper = helperAt(join(providerWorkdir, 'installed'));
    const producer = { ...common, csoProducer: policy(state, source, helper) };
    expect(codexExecArgs(producer, 'gpt-test')).toEqual([
      'exec', 'Reply OK', '-C', codexProducerPaths(state).workdir,
      '--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check',
      '--json', '-m', 'gpt-test',
    ]);
    expect(codexExecWorkingDirectory(common)).toBe(providerWorkdir);
    expect(codexExecWorkingDirectory(producer)).toBe(codexProducerPaths(state).workdir);

    const config = codexProducerConfig(producer);
    expect(config).toContain('default_permissions = "cso-producer"');
    expect(config).toContain('":root" = "deny"\n":minimal" = "read"');
    expect(config).toContain('[permissions.cso-producer.filesystem.":workspace_roots"]\n"." = "write"');
    expect(config).toContain('[permissions.cso-producer.network]\nenabled = false');
    expect(config).toContain(`include_only = ${JSON.stringify(CSO_PRODUCER_SHELL_ENV)}`);
    expect(config).toContain(`${JSON.stringify(join(state, 'cso-home'))} = "write"`);
    for (const admitted of [
      join(dirname(helper), `cso-eval-producer${suffix}`), helper,
      join(dirname(helper), `gstack-cso-core${suffix}`), join(dirname(helper), `gstack-cso-watchdog${suffix}`),
      join(dirname(helper), '.gstack-cso-generation'), source,
    ]) expect(config).toContain(`${JSON.stringify(admitted)} = "read"`);
    expect(config).not.toContain(`${JSON.stringify(dirname(helper))} = "read"`);
    expect(config).not.toContain(`${JSON.stringify(dirname(source))} = "read"`);
    expect(config).not.toContain('OPENAI_API_KEY');
    expect(() => codexExecArgs({ ...common, csoProducer: policy('relative-state', source, helper) }, 'gpt-test')).toThrow('absolute normalized path');
    expect(() => codexExecArgs({ ...common, csoProducer: policy(state, 'relative-source', helper) }, 'gpt-test')).toThrow('absolute normalized path');
    expect(() => codexExecArgs({ ...common, csoProducer: { ...policy(state, source, helper), helperGeneration: join(dirname(helper), 'wrong-generation') } }, 'gpt-test')).toThrow('exact adjacent');
    expect(codexExecArgs(producer, 'gpt-test').join(' ')).not.toMatch(/(?:^|\s)(?:-s|--sandbox)(?:\s|$)|danger|bypass|approve-for-me/);
  });

  test('keeps exact Claude defaults and enables its producer-only noninteractive safe policy', () => {
    const work = join(tmpdir(), 'gstack-claude-work');
    const state = join(work, 'state');
    const source = join(work, 'source');
    const helper = helperAt(join(work, 'installed'));
    const common = { prompt: 'Reply OK', workdir: work, timeoutMs: 5000 };
    expect(claudeExecArgs(common, 'claude-test', ['wrapper'])).toEqual([
      'wrapper', '-p', '--output-format', 'json', '--model', 'claude-test',
    ]);
    const producer = { ...common, csoProducer: policy(state, source, helper) };
    expect(claudeExecArgs(producer, 'claude-test')).toEqual([
      '-p', '--output-format', 'json', '--model', 'claude-test',
      '--restricted', '--safe-mode', '--no-session-persistence',
      '--permission-prompts', 'none', '--permission-mode', 'dontAsk',
      '--tools', 'Bash,Write',
      '--allowed-tools', `Bash(${helper}),Bash(${helper} *),Write`,
      '--add-dir', claudeProducerPaths(state).workdir,
      '--add-dir', source,
      '--add-dir', join(state, 'cso-home'),
      '--strict-mcp-config', '--no-chrome',
    ]);
    expect(claudeExecWorkingDirectory(common)).toBe(work);
    expect(claudeExecWorkingDirectory(producer)).toBe(claudeProducerPaths(state).workdir);
    expect(claudeExecArgs(producer, 'claude-test').join(' ')).not.toMatch(/bypassPermissions|danger/);
  });

  test('keeps exact Gemini defaults and replaces deprecated yolo only for the producer', () => {
    const work = join(tmpdir(), 'gstack-gemini-work');
    const state = join(work, 'state');
    const source = join(work, 'source');
    const helper = helperAt(join(work, 'installed'));
    const common = { prompt: 'Reply OK', workdir: work, timeoutMs: 5000, model: 'gemini-test' };
    expect(geminiExecArgs(common)).toEqual([
      '-p', 'Reply OK', '--output-format', 'stream-json', '--yolo', '--model', 'gemini-test',
    ]);
    const producer = { ...common, csoProducer: policy(state, source, helper) };
    const producerArgs = geminiExecArgs(producer);
    expect(producerArgs).toEqual([
      '-p', 'Reply OK', '--output-format', 'stream-json',
      '--approval-mode', 'yolo', '--include-directories', geminiProducerPaths(state).workdir, '-e', 'none',
      '--model', 'gemini-test',
    ]);
    expect(producerArgs).not.toContain(work);
    expect(producerArgs).not.toContain(source);
    expect(geminiExecWorkingDirectory(common)).toBe(work);
    expect(geminiExecWorkingDirectory(producer)).toBe(geminiProducerPaths(state).workdir);
    const contextFileName = `.gstack-cso-context-${'a'.repeat(32)}.md`;
    expect(geminiProducerSystemSettings(contextFileName, helper)).toEqual({
      advanced: { ignoreLocalEnv: true },
      admin: { extensions: { enabled: false }, mcp: { enabled: false }, skills: { enabled: false } },
      context: { fileName: [contextFileName], includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false, memoryBoundaryMarkers: [] },
      hooksConfig: { enabled: false },
      privacy: { usageStatisticsEnabled: false },
      security: {
        environmentVariableRedaction: { allowed: [], blocked: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'], enabled: true },
        folderTrust: { enabled: false }, toolSandboxing: false,
      },
      skills: { enabled: false },
      telemetry: { enabled: false, logPrompts: false },
      tools: { allowed: [`run_shell_command(${helper})`, 'write_file'], core: [`run_shell_command(${helper})`, 'write_file'], sandbox: false },
    });
    expect(() => geminiProducerSystemSettings('GEMINI.md', helper)).toThrow('INVALID_GEMINI_CONTEXT_FILENAME');
  });

  test('passes only selected provider auth plus safe execution inputs and strips Docker credentials', () => {
    const fixtureRoot = join(tmpdir(), 'gstack-provider-environment-policy');
    const state = join(fixtureRoot, 'state');
    const source = join(fixtureRoot, 'source');
    const helpers = join(fixtureRoot, 'helpers');
    const work = join(fixtureRoot, 'work');
    const sourceEnv = {
      PATH: '/usr/bin', HOME: '/home/eval', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      GSTACK_HOME: state, GSTACK_SESSION_KIND: 'spawned', GSTACK_HEADLESS: '1',
      OPENAI_API_KEY: 'openai-auth', ANTHROPIC_API_KEY: 'anthropic-auth', CLAUDE_CODE_OAUTH_TOKEN: 'claude-auth',
      GEMINI_API_KEY: 'gemini-auth', GOOGLE_CLOUD_PROJECT: 'project',
      CSO_EVAL_PAID: '1', AWS_SECRET_ACCESS_KEY: 'unrelated',
      DOCKER_HOST: 'tcp://remote.example:2376', DOCKER_CONFIG: '/credentials', DOCKER_CERT_PATH: '/certs',
    };
    const safe = { PATH: '/usr/bin', HOME: '/home/eval', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', GSTACK_HOME: state, GSTACK_SESSION_KIND: 'spawned', GSTACK_HEADLESS: '1' };
    expect(csoProducerChildEnvironment('gpt', sourceEnv)).toEqual({ ...safe, OPENAI_API_KEY: 'openai-auth' });
    expect(csoProducerChildEnvironment('claude', sourceEnv)).toEqual({ ...safe, ANTHROPIC_API_KEY: 'anthropic-auth', CLAUDE_CODE_OAUTH_TOKEN: 'claude-auth' });
    expect(csoProducerChildEnvironment('gemini', sourceEnv)).toEqual({ ...safe, GEMINI_API_KEY: 'gemini-auth', GOOGLE_CLOUD_PROJECT: 'project' });
    const helper = helperAt(helpers);
    const producer = policy(state, source, helper);
    const common = { prompt: '', workdir: work, timeoutMs: 1, csoProducer: producer };
    const codexPaths = codexProducerPaths(state);
    expect(codexExecEnvironment(common, sourceEnv)).toEqual({
      ...safe, HOME: codexPaths.home, GSTACK_HOME: join(state, 'cso-home'), CODEX_HOME: codexPaths.home, OPENAI_API_KEY: 'openai-auth',
    });
    const claudePaths = claudeProducerPaths(state);
    expect(claudeExecEnvironment(common, sourceEnv)).toEqual({
      ...safe, HOME: claudePaths.home, GSTACK_HOME: join(state, 'cso-home'),
      ANTHROPIC_API_KEY: 'anthropic-auth', CLAUDE_CODE_OAUTH_TOKEN: 'claude-auth', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
    const geminiPaths = geminiProducerPaths(state);
    expect(geminiExecEnvironment(common, sourceEnv)).toEqual({
      ...safe, HOME: geminiPaths.home, GSTACK_HOME: join(state, 'cso-home'),
      GEMINI_API_KEY: 'gemini-auth', GOOGLE_API_KEY: 'gemini-auth', GOOGLE_CLOUD_PROJECT: 'project',
      GEMINI_SANDBOX: 'false', GEMINI_TELEMETRY_ENABLED: 'false', GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
      GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_SYSTEM_MD: 'false', GEMINI_WRITE_SYSTEM_MD: 'false',
      GEMINI_CLI_HOME: geminiPaths.home,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: geminiPaths.systemDefaults,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: geminiPaths.systemSettings,
    });
    for (const env of [codexExecEnvironment(common, sourceEnv), claudeExecEnvironment(common, sourceEnv), geminiExecEnvironment(common, sourceEnv)]) {
      expect(env.CSO_EVAL_PAID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.DOCKER_HOST).toBeUndefined();
    }
  });

  test('preserves default provider environments and rejects producer escape-hatch arguments', () => {
    const fixtureRoot = join(tmpdir(), 'gstack-provider-default-policy');
    const state = join(fixtureRoot, 'state');
    const source = join(fixtureRoot, 'source');
    const helpers = join(fixtureRoot, 'helpers');
    const work = join(fixtureRoot, 'work');
    const sourceEnv = { PATH: '/bin', CSO_EVAL_PAID: '1', UNRELATED_SECRET: 'kept-by-default', GEMINI_API_KEY: 'key' };
    const common = { prompt: '', workdir: work, timeoutMs: 1 };
    const producer = policy(state, source, helperAt(helpers));
    expect(codexExecEnvironment(common, sourceEnv)).toBe(sourceEnv);
    expect(claudeExecEnvironment(common, sourceEnv)).toEqual({ ...sourceEnv, GSTACK_HEADLESS: '1' });
    expect(geminiExecEnvironment(common, sourceEnv)).toEqual({ ...sourceEnv, GOOGLE_API_KEY: 'key' });
    for (const invoke of [
      () => codexExecArgs({ ...common, csoProducer: producer, extraArgs: ['--unsafe'] }, 'model'),
      () => claudeExecArgs({ ...common, csoProducer: producer, extraArgs: ['--unsafe'] }, 'model'),
      () => geminiExecArgs({ ...common, csoProducer: producer, extraArgs: ['--unsafe'] }),
    ]) expect(invoke).toThrow('does not accept extra provider arguments');
  });

  test('fails paid Codex producers closed on empty or malformed success output',()=>{
    for(const raw of ['', '   \n', 'not json\n{bad', '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}']){
      expect(resultFromCodexStream(raw,{model:'gpt-test',producer:true})).toMatchObject({output:'',error:{code:'unknown',reason:'empty output from codex CLI (exit 0)'}});
    }
    expect(resultFromCodexStream('diagnostic\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',{producer:true}).error).toBeUndefined();
    expect(resultFromCodexStream('',{producer:false}).error).toBeUndefined();
  });

  test('requires Claude producer JSON with a nonblank string result',()=>{
    for(const raw of ['', 'plain text', '{}', '{"result":42}', '{"result":"  "}', '{"type":"result","subtype":"success","is_error":true,"result":"API Error: connection failed"}', '{"type":"result","subtype":"error_during_execution","result":"partial"}']){
      expect(resultFromClaudeOutput(raw,{model:'claude-test',producer:true})).toMatchObject({output:'',error:{code:'unknown',reason:'empty or invalid output from claude CLI (exit 0)'}});
    }
    const valid=resultFromClaudeOutput('{"result":"OK"}',{producer:true});expect(valid.output).toBe('OK');expect(valid.error).toBeUndefined();
    const legacy=resultFromClaudeOutput('plain text');expect(legacy.output).toBe('plain text');expect(legacy.error).toBeUndefined();
  });

  test.skipIf(process.platform === 'win32')('executes the exact receipt-bound provider command despite a hostile PATH', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cso-bound-provider-'));
    const previousPath = process.env.PATH;
    try {
      const state = join(fixture, 'state');
      const source = join(fixture, 'source');
      const installed = join(fixture, 'installed');
      const hostile = join(fixture, 'hostile');
      for (const directory of [state, source, installed, hostile]) mkdirSync(directory);
      const bound = join(installed, 'codex');
      const boundMarker = join(fixture, 'bound-ran');
      const hostileMarker = join(fixture, 'hostile-ran');
      writeFileSync(bound, `#!/bin/sh\ntouch ${JSON.stringify(boundMarker)}\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"BOUND"}}'\n`, { mode: 0o755 });
      writeFileSync(join(hostile, 'codex'), `#!/bin/sh\ntouch ${JSON.stringify(hostileMarker)}\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"HOSTILE"}}'\n`, { mode: 0o755 });
      process.env.PATH = `${hostile}:${previousPath ?? ''}`;
      const helper = helperAt(installed);
      const result = await new GptAdapter().run({
        prompt: 'Reply OK', workdir: fixture, timeoutMs: 5000, model: 'gpt-test',
        csoProducer: { ...policy(state, source, helper), providerCommand: { executable: bound, argsPrefix: [] } },
      });
      expect(result.output).toBe('BOUND');
      expect(existsSync(boundMarker)).toBe(true);
      expect(existsSync(hostileMarker)).toBe(false);
      expect(existsSync(codexProducerPaths(state).root)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

// Both adapters execute these stubs, so a regression can never launch a paid CLI.
describe.skipIf(process.platform === 'win32')('provider model selection', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    workdir = mkdtempSync(join(tmpdir(), 'gstack-model-defaults-'));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PATH = `${workdir}:${saved.PATH ?? ''}`;
    process.env.GSTACK_CLAUDE_BIN = join(workdir, 'claude');
    for (const cli of ['claude', 'codex']) {
      const response = cli === 'claude'
        ? '{"result":"OK","usage":{"input_tokens":1,"output_tokens":1}}'
        : '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}';
      writeFileSync(join(workdir, cli), `#!/bin/sh\nprintf '%s\\n' "$@" > args.txt\nprintf '%s\\n' '${response}'\n`, { mode: 0o755 });
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  async function selected(adapter: ClaudeAdapter | GptAdapter, model?: string) {
    // Start with PATH in the child environment; Bun can cache executable lookup
    // when process.env.PATH is changed after startup.
    const source = `
      import { ${adapter.name === 'claude' ? 'ClaudeAdapter' : 'GptAdapter'} as Adapter }
        from ${JSON.stringify(join(import.meta.dir, 'helpers/providers', `${adapter.name}.ts`))};
      const result = await new Adapter().run(${JSON.stringify({ prompt: 'Reply OK', workdir, timeoutMs: 5000, model })});
      console.log(JSON.stringify(result));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', source], {
      env: { ...process.env }, encoding: 'utf8', timeout: 10000,
    }));
    const args = readFileSync(join(workdir, 'args.txt'), 'utf8').trim().split('\n');
    const flag = adapter.name === 'claude' ? '--model' : '-m';
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('OK');
    expect(args[args.indexOf(flag) + 1]).toBe(result.modelUsed);
    return result.modelUsed;
  }

  test('Codex defaults to Astra and explicit model wins over the environment', async () => {
    const adapter = new GptAdapter();
    expect(await selected(adapter)).toBe('gpt-6-astra');
    process.env.GSTACK_CODEX_MODEL = 'gpt-5.6-sol';
    expect(await selected(adapter)).toBe('gpt-5.6-sol');
    expect(await selected(adapter, 'custom-codex')).toBe('custom-codex');
  });

  test('Claude defaults to Fable and preserves the full override chain', async () => {
    const adapter = new ClaudeAdapter();
    expect(await selected(adapter)).toBe('claude-fable-5-1');
    process.env.GSTACK_EVAL_MODEL = 'global-model';
    expect(await selected(adapter)).toBe('global-model');
    process.env.GSTACK_EVAL_MODEL_CAPTURE = 'capture-model';
    expect(await selected(adapter)).toBe('capture-model');
    process.env.EVALS_MODEL = 'evals-model';
    expect(await selected(adapter)).toBe('evals-model');
    expect(await selected(adapter, 'explicit-model')).toBe('explicit-model');
  });

  test('Codex skill evals default to Astra and preserve model overrides', () => {
    writeFileSync(join(workdir, 'SKILL.md'), '# Fixture\nReply OK.\n');
    for (const [override, explicit, expected] of [
      ['', undefined, 'gpt-6-astra'],
      ['gpt-5.6-sol', undefined, 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'custom-codex', 'custom-codex'],
    ]) {
      if (override) process.env.GSTACK_CODEX_MODEL = override;
      else delete process.env.GSTACK_CODEX_MODEL;
      const source = `
        import { runCodexSkill } from ${JSON.stringify(join(import.meta.dir, 'helpers/codex-session-runner.ts'))};
        const result = await runCodexSkill(${JSON.stringify({ skillDir: workdir, prompt: 'Reply OK', model: explicit, timeoutMs: 1000 })});
        console.log(JSON.stringify(result));
        process.exit(0);
      `;
      const result = JSON.parse(execFileSync(process.execPath, ['-e', source], {
        env: { ...process.env }, encoding: 'utf8', timeout: 10000,
      }));
      expect(result.exitCode).toBe(0);
      const args = readFileSync(join(workdir, 'args.txt'), 'utf8').trim().split('\n');
      expect(args[args.indexOf('--model') + 1]).toBe(expected);
    }
  });
});
