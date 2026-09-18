import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { runAgentSdkTest, toSkillTestResult, passThroughNonAskUserQuestion } from './helpers/agent-sdk-runner';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { publicEvents, redactPublicValue } from './helpers/setup-gbrain-sandbox';
import { buildSetupGbrainFixture } from './helpers/setup-gbrain-fixture';
import { resolveEvalModel } from '../lib/eval-model';

const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-setup-gbrain-remote.test.ts'), 'utf8');
type Mode = 'success' | 'max-turns' | 'missing-registration' | 'missing-mode' | 'leaked-token' | 'public-auth-error'
  | 'returned-api-error' | 'returned-execution-error' | 'returned-budget-error'
  | 'final-retain-error' | 'failed-retain-error' | 'cleanup-error' | 'close-error'
  | 'sdk-error' | 'deadline' | 'slow-setup' | 'rate-limit' | 'late' | 'owned-http';
async function fixture(modes: Mode[], budget = 300_000) {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-caller-evidence-'));
  const callbacks: Array<() => Promise<void>> = [], finalizers: Array<() => Promise<void>> = [];
  const rows: any[] = [], calls: any[] = [], publicTrace: string[] = [], homes: string[] = [], observedInputs: any[] = [];
  const sockets: net.Socket[] = [];
  let callIndex = 0, queryIndex = 0, releaseLate: (() => void) | undefined;
  let lateDecision: Promise<unknown> | undefined, serverCloses = 0;
  const privateBlock = { type: 'thinking', get thinking(): never { throw new Error('private thinking read'); }, get signature(): never { throw new Error('private signature read'); } };
  const fakeQuery = (input: any) => {
    const mode = modes[callIndex]!, ordinal = ++queryIndex;
    observedInputs.push(input);
    publicTrace.push(`query:${callIndex}:${ordinal}`);
    let rejectPending: ((error: unknown) => void) | undefined, closed = false;
    const source = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `public-session-${callIndex}-${ordinal}`, cwd: input.options.cwd,
        model: 'synthetic', tools: input.options.tools, claude_code_version: 'synthetic',
        get apiKeySource(): never { throw new Error('private init credential field read'); } };
      if ((mode === 'rate-limit' || mode === 'close-error') && ordinal === 1) throw Object.assign(new Error('429 synthetic rate limit'), { status: 429 });
      yield { type: 'assistant', session_id: 'synthetic', message: { id: 'message', role: 'assistant', content: [privateBlock,
        { type: 'text', text: `Public stage ${input.options.env.GBRAIN_MCP_TOKEN}` }] } };
      if (['sdk-error', 'failed-retain-error', 'cleanup-error', 'close-error'].includes(mode)) throw new Error(`Claude Code process exited with code 143 ${input.options.env.GBRAIN_MCP_TOKEN}`);
      if (mode === 'deadline') await new Promise<void>((_resolve, reject) => { rejectPending = reject; });
      if (mode === 'late') {
        await new Promise<void>(resolve => { releaseLate = resolve; });
        lateDecision = input.options.canUseTool('Write', { file_path: path.join(input.options.cwd, 'CLAUDE.md') }, {});
        await lateDecision.catch(() => { publicTrace.push('late-permission-rejected'); });
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'late first attempt text' }] } };
        return;
      }
      const question = 'Remote setup privacy gate';
      const decision = await input.options.canUseTool('AskUserQuestion', { questions: [{ question,
        options: [{ label: 'Proceed' }, { label: 'Decline' }] }] }, {});
      expect(decision.updatedInput.answers[question]).toBe('Decline');
      expect(await input.options.canUseTool('Read', { file_path: 'fixture' }, {})).toEqual({ behavior: 'allow', updatedInput: { file_path: 'fixture' } });
      const url = /Use this MCP URL: (http:\/\/[^ ]+)\./.exec(input.prompt)![1]!;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
      expect(response.status).toBe(200); await response.text();
      if (mode === 'owned-http') {
        const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) });
        sockets.push(socket); socket.on('error', () => {});
        await new Promise<void>(resolve => socket.once('connect', resolve));
      }
      const bin = input.options.env.PATH.split(path.delimiter)[0];
      if (mode !== 'missing-registration') fs.writeFileSync(path.join(bin, 'claude-calls.log'), 'claude mcp add --transport http gbrain\n');
      fs.writeFileSync(path.join(input.options.cwd, 'CLAUDE.md'), mode === 'leaked-token' ? input.options.env.GBRAIN_MCP_TOKEN : mode === 'missing-mode' ? '# Test project\n' : '# Test project\nMode: remote-http\n');
      yield { type: 'assistant', session_id: 'synthetic', message: { id: 'final', role: 'assistant', content: [privateBlock,
        ...(mode === 'public-auth-error' ? [{ type: 'tool_use', id: 'public-error', name: 'Read', input: { error_class: 'AUTH' } }] : [{ type: 'text', text: 'Remote setup complete.' }])] } };
      const subtype = mode === 'max-turns' ? 'error_max_turns' : mode === 'returned-api-error' ? 'error_api'
        : mode === 'returned-execution-error' ? 'error_during_execution' : mode === 'returned-budget-error' ? 'error_max_budget_usd' : 'success';
      yield { type: 'result', subtype, num_turns: 2, total_cost_usd: 0.12,
        ...(mode === 'returned-execution-error' ? { errors: [`Claude Code process exited with code 143 ${input.options.env.GBRAIN_MCP_TOKEN}`] } : {}) };
    })();
    return Object.assign(source, { close() {
      if (closed) return;
      if (mode === 'close-error' && ordinal === 1) { publicTrace.push(`close-error:${callIndex}:${ordinal}`); throw new Error('first owned SDK close failed'); }
      closed = true;
      publicTrace.push(`close:${callIndex}:${ordinal}`);
      rejectPending?.(new Error('owned query closed'));
    } });
  };
  const httpAdapter = { ...http, createServer: (...args: any[]) => {
    const server = (http.createServer as any)(...args) as http.Server;
    const close = server.closeAllConnections.bind(server);
    server.closeAllConnections = () => { serverCloses++; publicTrace.push(`http-close:${callIndex}`); close();
      if (modes[callIndex] === 'cleanup-error') throw new Error('owned HTTP cleanup failed after closing'); };
    return server;
  } };
  function executable(text: string) {
    for (const declaration of text.matchAll(/^import[\s\S]*?;\n/gm)) text = text.replace(declaration[0], '');
    return new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(text.replaceAll('import.meta.dir', JSON.stringify(import.meta.dir)));
  }
  const fsAdapter = { ...fs, renameSync: (from: string, to: string) => {
    if (path.basename(to) === 'evidence.json') {
      const stage = JSON.parse(fs.readFileSync(from, 'utf8')).stage;
      if (modes[callIndex] === 'final-retain-error' && stage === 'passed') throw new Error('final successful evidence persistence failed');
      if (modes[callIndex] === 'failed-retain-error' && stage === 'failed') throw new Error('failed evidence persistence failed');
    }
    return fs.renameSync(from, to);
  } };
  const bindings = {
    test: (name: string, callback: () => Promise<void>, timeout: number) => {
      expect(name).toBe('verifies, registers HTTP MCP, never writes token to CLAUDE.md');
      expect(timeout).toBe(budget + OFFICE_HOURS_BUN_GRACE_MS); callbacks.push(callback);
    }, expect, afterAll: (cb: () => Promise<void>) => finalizers.push(cb), query: fakeQuery, randomUUID,
    CAPTURE_MS: budget, describeE2ETier: () => (_name: string, cb: () => void) => cb(), e2eTierEnabled: () => true,
    fs: fsAdapter, os, path, http: httpAdapter, runAgentSdkTest: (opts: any) => {
      calls.push(opts); homes.push(opts.workingDirectory);
      expect(opts.maxTurns).toBe(25); expect(opts.maxRetries).toBe(3); expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']);
      expect(opts.userPrompt).toContain('Walk through Steps 4a, 4b, 4c, 5a, 8, 10 ONLY.');
      return runAgentSdkTest(opts);
    }, toSkillTestResult, passThroughNonAskUserQuestion, resolveClaudeBinary: () => '/not-executed/injected-query',
    runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS, publicEvents, redactPublicValue, resolveEvalModel,
    EvalCollector: class { addTest(row: any) { rows.push({ ...row, attempt: rows.length + 1 }); } async finalize() {} },
    // Inject only the three environment inputs read by the extracted paid callback.
    process: { env: { GSTACK_EVAL_DIR: evidenceRoot, PATH: process.env.PATH, EVALS_MODEL: process.env.EVALS_MODEL } },
    buildSetupGbrainFixture: (sections: string[]) => {
      if (modes[callIndex] === 'slow-setup') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, budget + 20);
      return buildSetupGbrainFixture(sections);
    },
    console: { error: (message: string) => { expect(message).not.toContain('gbrain_TEST_TOKEN_THAT_MUST_NEVER_LEAK_84613'); } },
  };
  new Function(...Object.keys(bindings), executable(source))(...Object.values(bindings));
  expect(callbacks).toHaveLength(1);
  const errors: unknown[] = [], evidence: any[] = [];
  try {
    for (callIndex = 0; callIndex < modes.length; callIndex++) {
      try { await callbacks[0]!(); errors.push(undefined); } catch (error) { errors.push(error); }
      const dirs = fs.readdirSync(evidenceRoot).sort();
      const all = dirs.map(dir => ({ dir, data: JSON.parse(fs.readFileSync(path.join(evidenceRoot, dir, 'evidence.json'), 'utf8')) }));
      const current = all.find(x => !evidence.some(e => e.attemptId === x.data.attemptId))!;
      evidence.push(current.data);
      expect(current.data.stage).toBe(modes[callIndex] === 'failed-retain-error' ? 'cleanup-complete' : errors.at(-1) ? 'failed' : 'passed');
      expect(current.data.stages.some((s: any) => s.stage === 'cleanup-complete')).toBe(true);
      expect(current.data.sdkCancelled).toBe(true);
      if (current.data.fixture.gstackHome) expect(fs.existsSync(current.data.fixture.gstackHome)).toBe(false);
      if (current.data.fixture.fakeBinDir) expect(fs.existsSync(current.data.fixture.fakeBinDir)).toBe(false);
      const serialized = JSON.stringify(current.data);
      expect(serialized).not.toContain('gbrain_TEST_TOKEN_THAT_MUST_NEVER_LEAK_84613');
      expect(serialized).not.toContain('thinking'); expect(serialized).not.toContain('apiKeySource');
      expect(serialized).not.toContain('signature');
    }
    if (releaseLate) {
      const before = fs.readdirSync(evidenceRoot).map(dir => fs.readFileSync(path.join(evidenceRoot, dir, 'evidence.json'), 'utf8'));
      releaseLate(); await new Promise(resolve => setTimeout(resolve, 20));
      expect(publicTrace).toContain('late-permission-rejected');
      expect(fs.readdirSync(evidenceRoot).map(dir => fs.readFileSync(path.join(evidenceRoot, dir, 'evidence.json'), 'utf8'))).toEqual(before);
    }
    for (const cb of finalizers) await cb();
    expect(rows).toHaveLength(modes.length);
    expect(JSON.stringify(rows)).not.toContain('gbrain_TEST_TOKEN_THAT_MUST_NEVER_LEAK_84613');
    expect(JSON.stringify(rows)).not.toContain('thinking');
    return { rows, errors, evidence, calls, homes, publicTrace, observedInputs, serverCloses, sockets };
  } finally {
    releaseLate?.();
    sockets.forEach(socket => socket.destroy());
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

test('remote caller preserves successful and max-turns-with-artifacts outcomes and public-only evidence', async () => {
  const result = await fixture(['success', 'max-turns']);
  expect(result.errors).toEqual([undefined, undefined]);
  expect(result.rows.map(r => [r.passed, r.attempt, r.cost_usd])).toEqual([[true, 1, 0.12], [true, 2, 0.12]]);
  expect(result.rows[1].exit_reason).toBe('error_max_turns');
  expect(result.homes[0]).not.toBe(result.homes[1]);
  expect(result.evidence.every(e => e.fixture.claudeCalls.includes('mcp add'))).toBe(true);
});

test('all original remote registration, token, persistence and public error assertions remain required', async () => {
  const result = await fixture(['missing-registration', 'missing-mode', 'leaked-token', 'public-auth-error']);
  expect(result.errors.every(Boolean)).toBe(true);
  expect(result.rows.every(r => !r.passed)).toBe(true);
});

test('SDK exception retains public progress and exact failure without invented usage', async () => {
  const result = await fixture(['sdk-error']);
  expect(result.rows[0].passed).toBe(false); expect(result.rows[0].error).toContain('143');
  expect(result.rows[0].error).toContain('usage unavailable');
  expect(result.evidence[0].events.some((event: any) => event.type === 'system')).toBe(true);
  expect(result.evidence[0].events.some((event: any) => event.type === 'assistant')).toBe(true);
});

test('returned SDK failures cannot pass from completed artifacts and keep their source exit reasons', async () => {
  const result = await fixture(['returned-api-error', 'returned-execution-error', 'returned-budget-error']);
  const reasons = ['error_api', 'error_during_execution', 'error_max_budget_usd'];
  for (const [index, reason] of reasons.entries()) {
    expect(result.errors[index]).toBeDefined();
    expect(result.rows[index].passed).toBe(false);
    expect(result.rows[index].exit_reason).toBe(reason);
    expect(result.rows[index].error).toContain(reason);
    expect(result.rows[index].cost_usd).toBe(0.12);
    expect(result.evidence[index].result.exitReason).toBe(reason);
    expect(result.evidence[index].fixture.claudeCalls).toContain('mcp add --transport http');
    expect(result.evidence[index].fixture.claudeMd).toContain('Mode: remote-http');
  }
  expect(result.rows[1].error).toContain('Claude Code process exited with code 143');
  expect(result.evidence[1].failure).toContain('Claude Code process exited with code 143');
});

test('deadline closes the owned SDK query before force-closing fixture HTTP', async () => {
  const result = await fixture(['deadline'], 30);
  expect(result.rows[0].passed).toBe(false); expect(result.rows[0].exit_reason).toBe('timeout');
  expect(result.publicTrace.indexOf('close:0:1')).toBeLessThan(result.publicTrace.indexOf('http-close:0'));
  expect(result.evidence[0].queryCount).toBe(1); expect(result.evidence[0].querySettled).toBe(1);
});

test('synchronous fixture setup consumes the existing work deadline before SDK launch', async () => {
  const result = await fixture(['slow-setup'], 20);
  expect(result.rows[0].passed).toBe(false); expect(result.rows[0].exit_reason).toBe('timeout');
  expect(result.calls).toHaveLength(0); expect(result.evidence[0].queryCount).toBe(0);
});

test('existing SDK429 retry policy stays three and closes the prior query before retry', async () => {
  const result = await fixture(['rate-limit']);
  expect(result.errors).toEqual([undefined]); expect(result.calls[0].maxRetries).toBe(3);
  expect(result.evidence[0].queryCount).toBe(2); expect(result.evidence[0].querySettled).toBe(2);
  expect(result.publicTrace.indexOf('close:0:1')).toBeLessThan(result.publicTrace.indexOf('query:0:2'));
});

test('late first completion cannot approve tools or overwrite evidence after a fresh second invocation', async () => {
  const result = await fixture(['late', 'success'], 250);
  expect(result.rows.map(r => [r.passed, r.attempt])).toEqual([[false, 1], [true, 2]]);
  expect(result.evidence[0].querySettled).toBe(0);
  expect(result.evidence[0].attemptId).not.toBe(result.evidence[1].attemptId);
  expect(result.homes[0]).not.toBe(result.homes[1]);
}, 10_000);

test('HTTP finalization closes only connections belonging to the owned fixture server', async () => {
  const foreign = http.createServer((_req, res) => res.end('foreign'));
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fixture(['owned-http']);
    expect(result.errors).toEqual([undefined]); expect(result.serverCloses).toBe(1);
    expect(foreign.listening).toBe(true);
    const address = foreign.address() as net.AddressInfo;
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('foreign');
  } finally { await new Promise<void>(resolve => { foreign.close(() => resolve()); foreign.closeAllConnections(); }); }
});


test('final successful evidence persistence fails the matching record before PASS acceptance', async () => {
  const result = await fixture(['final-retain-error']);
  expect(result.errors[0]).toBeDefined(); expect(result.rows[0].passed).toBe(false);
  expect(result.rows[0].error).toContain('final successful evidence persistence failed');
  expect(result.evidence[0].stage).toBe('failed');
});

test('failure diagnostics and HTTP cleanup cannot replace the original SDK failure', async () => {
  const result = await fixture(['failed-retain-error', 'cleanup-error']);
  for (let i = 0; i < 2; i++) {
    expect(result.rows[i].passed).toBe(false); expect(result.rows[i].error).toContain('143');
    expect(String(result.errors[i])).toContain('143');
    expect(result.evidence[i].failure).toContain('143');
  }
  expect(String(result.errors[0])).toContain('failed evidence persistence failed');
  expect(String(result.errors[1])).toContain('owned HTTP cleanup failed');
  expect(result.serverCloses).toBe(2);
});

test('throwing SDK close cannot skip the other query or owned HTTP cleanup', async () => {
  const result = await fixture(['close-error']);
  expect(result.rows[0].passed).toBe(false); expect(result.rows[0].error).toContain('143');
  expect(result.publicTrace).toContain('close-error:0:1');
  expect(result.publicTrace).toContain('close:0:2'); expect(result.publicTrace).toContain('http-close:0');
  expect(result.evidence[0].cleanupErrors.join(' ')).toContain('first owned SDK close failed');
  expect(result.evidence[0].queryCount).toBe(2); expect(result.serverCloses).toBe(1);
});
