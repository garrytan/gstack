import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { buildHermeticEnv } from './helpers/hermetic-env';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { redactFindingSpans } from '../lib/redact-engine';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const TOKEN = 'gbrain_fake_token_for_test';
const CREDENTIAL = 'ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5';
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-setup-gbrain-path4-local-pglite.test.ts'), 'utf8');

async function runCaller(scenario: 'success' | 'no-auq' | 'no-path' | 'leaked-claude-md' | 'diagnostic-secret') {
  // Execute the paid callback unchanged; all filesystem/network/SDK effects are mocks.
  const preamble = source.slice(0, source.indexOf('const describeE2E'));
  let executable = source;
  for (const declaration of preamble.matchAll(/^import[\s\S]*?;\n/gm)) executable = executable.replace(declaration[0], '');
  executable = executable.replaceAll('import.meta.dir', JSON.stringify(import.meta.dir));
  const js = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(executable);
  const callbacks: Array<() => Promise<void>> = [], finalizers: Array<() => Promise<void>> = [];
  const rows: any[] = [], calls: any[] = [], files = new Map<string, string>();
  const env = { HOME: '/operator', PATH: '/usr/bin', GBRAIN_MCP_TOKEN: 'operator-token' };
  let counter = 0, closed = 0, finalized = 0;
  const virtualFs = {
    mkdtempSync: (prefix: string) => prefix + (++counter), mkdirSync: () => {},
    writeFileSync: (name: string, body: string) => files.set(name, body),
    readFileSync: (name: string) => { if (!files.has(name)) throw new Error('missing mock file: ' + name); return files.get(name)!; },
    existsSync: (name: string) => files.has(name), rmSync: () => {},
  };
  const privateBlock = { type: 'thinking', get thinking(): never { throw new Error('private block accessed'); }, get signature(): never { throw new Error('signature accessed'); } };
  const run = async (opts: any) => {
    calls.push(opts);
    expect(buildHermeticEnv(env, { HOME: '/isolated' }, opts.env).GBRAIN_MCP_TOKEN).toBe(TOKEN);
    expect(buildHermeticEnv(env, { HOME: '/isolated' }).GBRAIN_MCP_TOKEN).toBeUndefined();
    expect(opts.maxTurns).toBe(25);
    if (scenario !== 'no-auq') {
      const decision = await opts.canUseTool('AskUserQuestion', { questions: [{ question: 'Want local code search?', options: [{ label: 'No' }, { label: 'Yes, local PGLite' }] }] });
      expect(decision.updatedInput.answers['Want local code search?']).toBe('Yes, local PGLite');
    }
    expect(await opts.canUseTool('Read', { file_path: '/fixture' })).toEqual({ behavior: 'allow', updatedInput: { file_path: '/fixture' } });
    if (scenario !== 'no-path') {
      const install = [...files.keys()].find(name => name.endsWith('/gstack-gbrain-install'))!;
      files.set(path.join(path.dirname(install), 'install-calls.log'), 'install called');
    }
    if (scenario === 'leaked-claude-md') files.set(path.join(opts.workingDirectory, 'CLAUDE.md'), TOKEN);
    return { output: `Public report ${TOKEN} ${CREDENTIAL}`, events: [
      { type: 'system', subtype: 'init', session_id: 'session', cwd: '/owned', model: 'synthetic', tools: ['Read'], get apiKeySource(): never { throw new Error('init credential field accessed'); } },
      { type: 'assistant', session_id: 'session', message: { id: 'msg', role: 'assistant', content: [privateBlock,
        { type: 'text', text: `Public text ${TOKEN} ${CREDENTIAL}` },
        { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: `echo ${TOKEN}` } }] } },
      { type: 'user', session_id: 'session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: false,
        content: [privateBlock, { type: 'text', text: `Public result ${TOKEN}` }] }] } },
      { type: 'result', get result(): never { throw new Error('raw result field accessed'); } },
    ], exitReason: 'success', durationMs: 1, costUsd: 0, turnsUsed: 1, model: 'synthetic',
      browseErrors: scenario === 'diagnostic-secret' ? [`public tool failed ${TOKEN} ${CREDENTIAL}`] : [] };
  };
  const args: Record<string, any> = {
    test: (_name: string, callback: () => Promise<void>, timeout: number) => { expect(timeout).toBe(CAPTURE_MS); callbacks.push(callback); },
    expect, afterAll: (cb: () => Promise<void>) => finalizers.push(cb), CAPTURE_MS,
    describeE2ETier: () => (_name: string, cb: () => void) => cb(), e2eTierEnabled: () => true,
    fs: virtualFs, os: { tmpdir: () => '/tmp' }, path,
    http: { createServer: () => ({ listen: (_port: number, _host: string, cb: () => void) => cb(), address: () => ({ port: 1234 }), close: (cb: () => void) => { closed++; cb(); } }) },
    runAgentSdkTest: run, passThroughNonAskUserQuestion: (_name: string, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    resolveClaudeBinary: () => undefined, buildSetupGbrainFixture: () => 'fixture methodology',
    EvalCollector: class { addTest(row: any) { rows.push(row); } async finalize() { finalized++; } },
    redactFindingSpans, process: { env },
  };
  new Function(...Object.keys(args), js)(...Object.values(args));
  expect(callbacks).toHaveLength(1);
  let thrown: unknown;
  try { await callbacks[0](); } catch (error) { thrown = error; }
  for (const cb of finalizers) await cb();
  expect(rows).toHaveLength(1); expect(calls).toHaveLength(1);
  expect(closed).toBe(1); expect(finalized).toBe(1);
  expect(env).toEqual({ HOME: '/operator', PATH: '/usr/bin', GBRAIN_MCP_TOKEN: 'operator-token' });
  return { row: rows[0], thrown };
}

test('Path4 caller passes its fake token through the real hermetic env and preserves the AUQ callback', async () => {
  const { row, thrown } = await runCaller('success');
  expect(thrown).toBeUndefined(); expect(row.passed).toBe(true);
});

test('Path4 caller records missing interaction, missing path and token leakage as failures exactly once', async () => {
  for (const scenario of ['no-auq', 'no-path', 'leaked-claude-md'] as const) {
    const { row, thrown } = await runCaller(scenario);
    expect(thrown).toBeDefined(); expect(row.passed).toBe(false);
  }
});

test('Path4 public diagnostics exclude private fields and redact output, tools and error excerpts', async () => {
  const { row } = await runCaller('diagnostic-secret');
  const serialized = JSON.stringify(row);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(CREDENTIAL);
  expect(serialized).not.toContain('thinking');
  expect(serialized).not.toContain('apiKeySource');
  expect(row.transcript).toHaveLength(3);
});

test('Path4 caller controls select only their registered paid owner', () => {
  const owners = Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes('test/setup-gbrain-path4-caller.test.ts')).map(([name]) => name);
  expect(owners).toEqual(['setup-gbrain-path4-local-pglite']);
});
