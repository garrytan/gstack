import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeAdapter } from './helpers/providers/claude';
import { GptAdapter } from './helpers/providers/gpt';

const ENV_KEYS = ['PATH', 'GSTACK_CLAUDE_BIN', 'GSTACK_CLAUDE_BIN_ARGS',
  'GSTACK_CODEX_MODEL', 'EVALS_MODEL', 'GSTACK_EVAL_MODEL', 'GSTACK_EVAL_MODEL_CAPTURE'];
let saved: Record<string, string | undefined>;
let workdir: string;

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
