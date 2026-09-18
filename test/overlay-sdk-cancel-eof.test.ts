import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runAgentSdkTest, __resetSemaphoreForTests, type QueryProvider } from './helpers/agent-sdk-runner';
import { captureOverlayQueryAttempts } from './helpers/overlay-attempt';

const terminal = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0 };
const assistant = { type: 'assistant', message: { id: 'owned', content: [{ type: 'text', text: 'owned fake result' }] } };
const options = (directory: string, signal: AbortSignal, queryProvider: QueryProvider) => ({ workingDirectory: directory, signal, queryProvider, systemPrompt: '', userPrompt: 'owned free probe', settingSources: [], env: { ANTHROPIC_API_KEY: '', HOME: directory, GSTACK_HOME: path.join(directory, '.gstack') } });

test('SDK cancellation after the terminal event but before EOF rejects and releases its permit', async () => {
  __resetSemaphoreForTests(1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cancel-eof-'));
  const controller = new AbortController(); let closes = 0;
  const provider = (() => {
    const stream = (async function* () { yield assistant; yield terminal; controller.abort(new Error('cancel at EOF')); })();
    return Object.assign(stream, { close: () => { closes++; } });
  }) as unknown as QueryProvider;
  try {
    await expect(runAgentSdkTest(options(dir, controller.signal, provider))).rejects.toThrow('cancel at EOF');
    expect(closes).toBe(1);
    const successful = (() => (async function* () { yield assistant; yield terminal; })()) as unknown as QueryProvider;
    expect((await runAgentSdkTest(options(dir, new AbortController().signal, successful))).exitReason).toBe('success');
  } finally { __resetSemaphoreForTests(3); fs.rmSync(dir, { recursive: true, force: true }); }
});

// The live SDK path uses an owned Bun child, never a shebang or real provider.
// This specific probe needs POSIX SIGTERM interception; Windows terminates the
// process instead. Keep the platform-independent cancellation test above active.
test.skipIf(process.platform === 'win32')('real SDK close cannot turn an aborted terminal stream into success', async () => {
  __resetSemaphoreForTests(1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cancel-native-'));
  const script = path.join(dir, 'owned-child.ts');
  fs.writeFileSync(script, `process.on('SIGTERM', () => {});\nprocess.stdin.resume();\nconsole.log(${JSON.stringify(JSON.stringify(assistant))});\nconsole.log(${JSON.stringify(JSON.stringify(terminal))});\nsetInterval(() => {}, 1000);\n`);
  const controller = new AbortController();
  let child: ChildProcess | undefined; let exited: Promise<void> | undefined;
  const provider = ((args: Parameters<QueryProvider>[0]) => query({ ...args, options: { ...args.options,
    pathToClaudeCodeExecutable: script,
    spawnClaudeCodeProcess: spawnOptions => {
      child = spawn(process.execPath, [script], { cwd: dir, env: { PATH: dir, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TMP: dir, TEMP: dir, EVALS: '' }, stdio: ['pipe', 'pipe', 'ignore'], signal: spawnOptions.signal });
      exited = new Promise(resolve => child!.once('exit', () => resolve()));
      return child as any;
    },
  } })) as QueryProvider;
  const captured = captureOverlayQueryAttempts(dir, 'owned-native', provider);
  let result: unknown; let error: unknown; let timer: ReturnType<typeof setTimeout> | undefined;
  const running = runAgentSdkTest(options(dir, controller.signal, captured)).then(value => { result = value; }, cause => { error = cause; });
  try {
    const stream = path.join(dir, 'owned-native-sdk-attempt-1.jsonl');
    const end = Date.now() + 2000;
    while (Date.now() < end && (!fs.existsSync(stream) || !fs.readFileSync(stream, 'utf8').includes('result'))) await Bun.sleep(5);
    expect(fs.readFileSync(stream, 'utf8')).toContain('result');
    await Bun.sleep(20);
    controller.abort(new Error('cancel native EOF'));
    await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('runner did not settle')), 1000); })]);
    expect(error).toBe(controller.signal.reason);
    expect(result).toBeUndefined();
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    // A settled Query is not proof of child exit. Reap only this owned child.
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await running;
    __resetSemaphoreForTests(3); fs.rmSync(dir, { recursive: true, force: true });
  }
}, 5000);
