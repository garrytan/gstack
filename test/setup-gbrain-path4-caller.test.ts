import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { toSkillTestResult } from './helpers/agent-sdk-runner';
import { buildSetupGbrainFixture, chooseLocalPgliteFixtureAnswer } from './helpers/setup-gbrain-fixture';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { buildHermeticEnv } from './helpers/hermetic-env';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { redactFindingSpans } from '../lib/redact-engine';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

// Assemble synthetic credentials at runtime, as in gate-secret-scan.test.ts.
const CREDENTIAL = ['ghp_', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5'].join('');
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-setup-gbrain-path4-local-pglite.test.ts'), 'utf8');

type Scenario = 'success' | 'no-auq' | 'no-path' | 'leaked-claude-md' | 'leaked-output' | 'diagnostic-secret'
  | 'no-request' | 'no-verifier' | 'no-install' | 'no-init' | 'no-registration' | 'unregistered' | 'wrong-engine' | 'runner-error' | 'exit';
async function runCaller(scenario: Scenario, diagnostic?: { sink: 'output' | 'tool' | 'error'; text: string }) {
  // Execute the current paid callback and sandbox unchanged. Only the SDK
  // result boundary is synthetic; fixture state, retention and cleanup are real.
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path4-caller-evidence-'));
  const callbacks: Array<() => Promise<void>> = [], finalizers: Array<() => Promise<void>> = [];
  const rows: any[] = [], calls: any[] = [];
  const ambient = { HOME: process.env.HOME, PATH: process.env.PATH, GBRAIN_MCP_TOKEN: process.env.GBRAIN_MCP_TOKEN };
  const env = { HOME: '/operator', PATH: '/usr/bin', GBRAIN_MCP_TOKEN: 'operator-token' };
  let fixture: any, closed = 0, finalized = 0;
  const privateBlock = { type: 'thinking', get thinking(): never { throw new Error('private block accessed'); }, get signature(): never { throw new Error('signature accessed'); } };
  const run = async (opts: any) => {
    calls.push(opts);
    const token = fixture.token;
    expect(buildHermeticEnv(env, { HOME: '/isolated' }, opts.env).GBRAIN_MCP_TOKEN).toBe(token);
    expect(buildHermeticEnv(env, { HOME: '/isolated' }).GBRAIN_MCP_TOKEN).toBeUndefined();
    expect(opts.maxTurns).toBe(25); expect(opts.maxRetries).toBe(0); expect(opts.signal).toBeInstanceOf(AbortSignal);
    if (scenario === 'runner-error') throw new Error(`runner failure ${CREDENTIAL}`);
    if (scenario !== 'no-auq') {
      const question = 'Want local code search?';
      const decision = await opts.canUseTool('AskUserQuestion', { questions: [{ question,
        options: [{ label: 'No, remote only' }, { label: 'Yes, local PGLite' }] }] });
      expect(decision.updatedInput.answers[question]).toBe('Yes, local PGLite');
    }
    expect(await opts.canUseTool('Read', { file_path: '/fixture' })).toEqual({ behavior: 'allow', updatedInput: { file_path: '/fixture' } });
    if (scenario !== 'no-request') fixture.requests.push({ rpcMethod: 'initialize', authorizationMatches: true });
    const commands = [
      { command: 'gstack-gbrain-mcp-verify', phase: 'end', exitCode: 0, stdout: '{"status":"success"}' },
      { command: 'gstack-gbrain-install', phase: 'end', exitCode: 0 },
      { command: 'gbrain', phase: 'start', args: ['init', '--pglite', '--json'] },
      { command: 'claude', phase: 'start', args: ['mcp', 'add'], authorizationMatches: true },
    ];
    const missing = { 'no-verifier': 0, 'no-install': 1, 'no-init': 2, 'no-registration': 3 }[scenario];
    fs.writeFileSync(path.join(fixture.root, 'commands.jsonl'), commands.filter((_, i) => scenario !== 'no-path' && i !== missing).map(c => JSON.stringify(c)).join('\n'));
    fs.writeFileSync(path.join(fixture.root, 'mcp-state.json'), JSON.stringify({ registered: scenario !== 'unregistered' }));
    fs.writeFileSync(path.join(fixture.home, '.gbrain', 'config.json'), JSON.stringify({ engine: scenario === 'wrong-engine' ? 'other' : 'pglite' }));
    if (scenario === 'leaked-claude-md') fs.writeFileSync(path.join(fixture.home, 'CLAUDE.md'), token);
    return { output: diagnostic?.sink === 'output' ? `Public report ${diagnostic.text}` : `Public report ${scenario === 'leaked-output' ? token : CREDENTIAL}`, events: [
      { type: 'system', subtype: 'init', session_id: 'session', cwd: fixture.home, model: 'synthetic', tools: ['Read'], get apiKeySource(): never { throw new Error('init credential field accessed'); } },
      { type: 'assistant', session_id: 'session', message: { id: 'msg', role: 'assistant', content: [privateBlock,
        { type: 'text', text: `Public text ${CREDENTIAL}` },
        { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: diagnostic?.sink === 'tool' ? `echo ${diagnostic.text}` : `echo ${token}` } }] } },
      { type: 'user', session_id: 'session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: false,
        content: [privateBlock, { type: 'text', text: `Public result ${token}` }] }] } },
      { type: 'result', get result(): never { throw new Error('raw result field accessed'); } },
    ], toolCalls: [], exitReason: scenario === 'exit' ? 'timeout' : 'success', durationMs: 1, costUsd: 0, turnsUsed: 1, model: 'synthetic',
      browseErrors: diagnostic?.sink === 'error' ? [`public tool failed ${diagnostic.text}`] : scenario === 'diagnostic-secret' ? [`public tool failed ${token} ${CREDENTIAL}`] : [] };
  };
  function executable(text: string, dir: string) {
    for (const declaration of text.matchAll(/^import[\s\S]*?;\n/gm)) text = text.replace(declaration[0], '');
    return new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(
      text.replace(/^export /gm, '').replaceAll('import.meta.dir', JSON.stringify(dir)),
    );
  }
  const sandboxSource = fs.readFileSync(path.join(import.meta.dir, 'helpers/setup-gbrain-sandbox.ts'), 'utf8');
  const bindings = { fs, os, path, http, createHash, randomUUID, runAgentSdkTest: run, toSkillTestResult,
    buildSetupGbrainFixture, CAPTURE_MS, runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS,
    redactFindingSpans, query: () => { throw new Error('A real provider must not run'); } };
  const sandbox = new Function(...Object.keys(bindings), executable(sandboxSource, path.join(import.meta.dir, 'helpers')) +
    '\nreturn { createSetupGbrainSandbox, runSetupGbrainAttempt, SETUP_GBRAIN_FINALIZE_MS };')(...Object.values(bindings));
  const args: Record<string, any> = {
    test: (_name: string, callback: () => Promise<void>, timeout: number) => { expect(timeout).toBe(CAPTURE_MS + sandbox.SETUP_GBRAIN_FINALIZE_MS); callbacks.push(callback); },
    expect, afterAll: (cb: () => Promise<void>) => finalizers.push(cb), CAPTURE_MS,
    describeE2ETier: () => (_name: string, cb: () => void) => cb(), e2eTierEnabled: () => true,
    ...sandbox, createSetupGbrainSandbox: async (options: any) => {
      fixture = await sandbox.createSetupGbrainSandbox({ ...options, evidenceRoot });
      const cleanup = fixture.cleanup;
      fixture.cleanup = async () => { await cleanup(); closed++; };
      return fixture;
    },
    chooseLocalPgliteFixtureAnswer, passThroughNonAskUserQuestion: (_name: string, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    resolveClaudeBinary: () => undefined,
    EvalCollector: class { constructor(tier: string) { expect(tier).toBe('e2e'); } addTest(row: any) { rows.push(row); } async finalize() { finalized++; } },
  };
  try {
    new Function(...Object.keys(args), executable(source, import.meta.dir))(...Object.values(args));
    expect(callbacks).toHaveLength(1);
    let thrown: unknown;
    try { await callbacks[0](); } catch (error) { thrown = error; }
    for (const cb of finalizers) await cb();
    expect(rows).toHaveLength(1); expect(calls).toHaveLength(1);
    expect(closed).toBe(1); expect(finalized).toBe(1); expect(fs.existsSync(fixture.root)).toBe(false);
    expect(env).toEqual({ HOME: '/operator', PATH: '/usr/bin', GBRAIN_MCP_TOKEN: 'operator-token' });
    expect({ HOME: process.env.HOME, PATH: process.env.PATH, GBRAIN_MCP_TOKEN: process.env.GBRAIN_MCP_TOKEN }).toEqual(ambient);
    const evidence = fs.readFileSync(fixture.evidencePath, 'utf8');
    expect(evidence).not.toContain(fixture.token); expect(evidence).not.toContain(CREDENTIAL);
    expect(evidence).not.toContain('thinking'); expect(evidence).not.toContain('apiKeySource');
    expect(JSON.parse(evidence).stage).toBe(thrown ? 'failed' : 'passed');
    return { row: rows[0], thrown, token: fixture.token };
  } finally {
    if (fixture && fs.existsSync(fixture.root)) await fixture.cleanup();
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

test('Path4 caller passes its fake token through the real hermetic env and preserves the AUQ callback', async () => {
  const { row, thrown } = await runCaller('success');
  expect(thrown).toBeUndefined(); expect(row.passed).toBe(true);
});

test('Path4 caller records missing interaction, missing path and token leakage as failures exactly once', async () => {
  for (const scenario of ['no-auq', 'no-path', 'leaked-claude-md', 'leaked-output', 'no-request', 'no-verifier', 'no-install', 'no-init', 'no-registration', 'unregistered', 'wrong-engine', 'runner-error', 'exit'] as const) {
    const { row, thrown } = await runCaller(scenario);
    expect(thrown).toBeDefined(); expect(row.passed).toBe(false);
  }
});

test('Path4 public diagnostics exclude private fields and redact output, tools and error excerpts', async () => {
  const { row, token } = await runCaller('diagnostic-secret');
  const serialized = JSON.stringify(row);
  expect(serialized).not.toContain(token);
  expect(serialized).not.toContain(CREDENTIAL);
  expect(serialized).not.toContain('thinking');
  expect(serialized).not.toContain('apiKeySource');
  expect(row.transcript).toHaveLength(3);
});

test('Path4 caller controls select only their registered paid owner', () => {
  const owners = Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes('test/setup-gbrain-path4-caller.test.ts')).map(([name]) => name);
  expect(owners).toEqual(['setup-gbrain-path4-local-pglite']);
});


test('Path4 redacted credential URLs cannot erase success or mask a failed assertion', async () => {
  // Text redaction can consume JSON punctuation after an unspaced URL host.
  // These synthetic credentials exercise the real redactor and actual callback.
  for (const [scheme, host] of [['postgres', 'db.invalid'], ['https', 'service.invalid']]) {
    const text = `${scheme}://fixture:syntheticCredential923@${host}`;
    for (const sink of ['output', 'tool', 'error'] as const) {
      for (const scenario of ['success', 'no-auq'] as const) {
        const { row, thrown, token } = await runCaller(scenario, { sink, text });
        expect(row.passed).toBe(scenario === 'success');
        if (scenario === 'success') expect(thrown).toBeUndefined();
        else { expect(thrown).toBeDefined(); expect(thrown).not.toBeInstanceOf(SyntaxError); }
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain('syntheticCredential923');
        expect(serialized).not.toContain(token);
        expect(serialized).not.toContain(CREDENTIAL);
        expect(typeof row.output).toBe('string');
        expect(row.output).toContain('Public report');
        expect(Array.isArray(row.transcript)).toBe(true);
        expect(Array.isArray(row.browse_errors)).toBe(true);
      }
    }
  }
});

test('Path4 unbounded secret diagnostics are omitted without changing the recorded verdict', async () => {
  for (const scenario of ['success', 'no-auq'] as const) {
    const text = ['-----BEGIN ', 'PRIVATE KEY----- synthetic incomplete private material'].join('');
    const { row, thrown } = await runCaller(scenario, { sink: 'output', text });
    expect(row.passed).toBe(scenario === 'success');
    if (scenario === 'success') expect(thrown).toBeUndefined();
    else expect(thrown).toBeDefined();
    expect(row.output).toContain('omitted');
    expect(row.transcript).toEqual([]);
    expect(row.browse_errors).toEqual([]);
    expect(JSON.stringify(row)).not.toContain('synthetic incomplete private material');
  }
});
