/** Free behavioral tests: every Codex launch goes through our temporary shim.
 * Uses '/bin/bash' to launch the shim (excluded from Windows curation).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexHarnessError, runCodexSkill } from './helpers/codex-session-runner';
import { runRecordedCodexEval, validateCodexDiscovery } from './helpers/codex-eval';
import type { EvalTestEntry } from './helpers/eval-store';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function alive(pid: number): boolean {
  // A reparented, killed grandchild can briefly be a zombie until init reaps
  // it. It is no longer executing or holding any pipe open.
  const status = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 2_000 });
  return status.status === 0 && !status.stdout.trim().startsWith('Z');
}

async function withFakeCodex(
  body: string,
  check: (fixture: { dir: string; skillDir: string; shimDir: string; pids: () => number[]; tempHome: () => string }) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-fixture-'));
  const shimDir = path.join(dir, 'shims');
  const skillDir = path.join(dir, 'skill');
  const operatorConfig = path.join(dir, 'operator-codex');
  const pidsFile = path.join(dir, 'pids.json');
  const homeFile = path.join(dir, 'child-home.txt');
  const script = path.join(dir, 'fake-codex.ts');
  fs.mkdirSync(shimDir);
  fs.mkdirSync(skillDir);
  fs.mkdirSync(operatorConfig);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: fixture\ndescription: local test\n---\nReview the fixture.\n');
  fs.writeFileSync(script, `
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
const pidsFile = ${JSON.stringify(pidsFile)};
fs.writeFileSync(pidsFile, JSON.stringify([process.pid]));
fs.writeFileSync(${JSON.stringify(homeFile)}, process.env.HOME!);
${body}
`);
  fs.writeFileSync(path.join(shimDir, 'codex'), `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  const original = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, EVALS_HERMETIC: process.env.EVALS_HERMETIC };
  const pids = () => fs.existsSync(pidsFile) ? JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[] : [];
  process.env.PATH = `${shimDir}${path.delimiter}${original.PATH}`;
  process.env.CODEX_HOME = operatorConfig; // Never copy real operator credentials.
  process.env.EVALS_HERMETIC = '1';
  try {
    await check({ dir, skillDir, shimDir, pids, tempHome: () => fs.readFileSync(homeFile, 'utf8') });
  } finally {
    for (const pid of pids()) {
      // An intentionally escaped child tests pipe teardown. Only the fixture
      // owner knows its new group ID, so it is explicitly reaped here.
      try { process.kill(-pid, 'SIGKILL'); } catch { /* no such group */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function childHoldingPipes(detached: boolean, exitCode?: number): string {
  return `
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: ${detached}, stdio: ['ignore', 'ignore', 'inherit'],
});
fs.writeFileSync(pidsFile, JSON.stringify([process.pid, child.pid]));
child.unref();
process.stderr.write('invalid fixture metadata before the pipe stalled\\n');
${exitCode === undefined ? 'setInterval(() => {}, 1000);' : `process.exit(${exitCode});`}
`;
}

describe('Codex subprocess lifecycle without API calls', () => {
  test('a missing full skill fixture records one harness error without launching Codex', async () => {
    await withFakeCodex(`process.stdout.write(JSON.stringify({ type: 'item.completed', item: {
  type: 'agent_message', text: 'No gstack review skill is installed here.',
} }));`, async ({ skillDir, pids }) => {
      const source = path.join(skillDir, 'SKILL.md');
      fs.unlinkSync(source);
      const entries: EvalTestEntry[] = [];
      let failure: unknown;
      try {
        await runRecordedCodexEval({
          name: 'missing-full-fixture', suite: 'codex-lifecycle', budgetMs: 2_000,
          run: (signal) => runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000, signal }),
          validate: validateCodexDiscovery,
          record: (entry) => entries.push(entry),
        });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('ENOENT');
      expect((failure as Error).message).toContain(source);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ passed: false, exit_reason: 'harness_error', error: (failure as Error).message });
      expect(pids()).toEqual([]);
    });
  });

  test('captures full JSONL/stderr, including split UTF-8, and removes the temporary home', async () => {
    await withFakeCodex(`
const line = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'gstack review: café' } }) + '\\n');
for (const byte of line) fs.writeSync(1, Buffer.from([byte]));
process.stderr.write('fixture warning\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }));
`, async ({ skillDir, tempHome, pids }) => {
      const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000 });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('gstack review: café');
      expect(result.stderr).toBe('fixture warning\n');
      expect(result.tokens).toBe(10);
      expect(result.rawLines).toHaveLength(2);
      expect(fs.existsSync(tempHome())).toBe(false);
      expect(pids().every((pid) => !alive(pid))).toBe(true);
    });
  });

  for (const exitCode of [2, 137]) {
    test(`retains process exit ${exitCode}`, async () => {
      await withFakeCodex(`process.exit(${exitCode});`, async ({ skillDir }) => {
        const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000 });
        expect(result.exitCode).toBe(exitCode);
      });
    });
  }

  for (const exitCode of [0, 2]) {
    test(`exit ${exitCode} reaps descendants that have already closed inherited pipes`, async () => {
      await withFakeCodex(`
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(pidsFile, JSON.stringify([process.pid, child.pid]));
child.unref();
process.exit(${exitCode});
`, async ({ skillDir, pids, tempHome }) => {
        const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000 });
        expect(result.exitCode).toBe(exitCode);
        expect(pids()).toHaveLength(2);
        const cleanupDeadline = Date.now() + 1_000;
        let allExited = pids().every((pid) => !alive(pid));
        while (!allExited && Date.now() < cleanupDeadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, cleanupDeadline - Date.now())));
          allExited = pids().every((pid) => !alive(pid));
        }
        expect(allExited).toBe(true);
        expect(fs.existsSync(tempHome())).toBe(false);
      });
    });
  }

  test('a real SIGKILL is recorded as exit 137, not a timeout', async () => {
    await withFakeCodex("process.kill(process.pid, 'SIGKILL');", async ({ skillDir }) => {
      const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000 });
      expect(result.exitCode).toBe(137);
    });
  });

  test('timeout kills the process group and drains both streams within the allowance', async () => {
    await withFakeCodex(childHoldingPipes(false), async ({ skillDir, pids, tempHome }) => {
      const started = Date.now();
      const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 750 });
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(pids()).toHaveLength(2);
      expect(pids().every((pid) => !alive(pid))).toBe(true);
      expect(fs.existsSync(tempHome())).toBe(false);
    });
  }, 10_000);

  test('abort kills a running group and removes its temporary home', async () => {
    await withFakeCodex(childHoldingPipes(false), async ({ skillDir, pids, tempHome }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 750);
      try {
        const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 10_000, signal: controller.signal });
        expect(result.exitCode).toBe(124);
        expect(pids()).toHaveLength(2);
        expect(pids().every((pid) => !alive(pid))).toBe(true);
        expect(fs.existsSync(tempHome())).toBe(false);
      } finally { clearTimeout(timer); }
    });
  }, 10_000);

  test('an already aborted call never launches Codex', async () => {
    await withFakeCodex('process.exit(0);', async ({ skillDir, pids }) => {
      const controller = new AbortController();
      controller.abort();
      const result = await runCodexSkill({ skillDir, prompt: 'fixture', signal: controller.signal });
      expect(result.exitCode).toBe(124);
      expect(pids()).toEqual([]);
    });
  });

  test('a real error exit survives an inherited stderr stall', async () => {
    await withFakeCodex(childHoldingPipes(false, 2), async ({ skillDir, pids, tempHome }) => {
      const started = Date.now();
      const result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000 });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('invalid fixture metadata');
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(pids().every((pid) => !alive(pid))).toBe(true);
      expect(fs.existsSync(tempHome())).toBe(false);
    });
  }, 10_000);

  test('exit zero with an escaped stderr holder fails closed and preserves captured evidence', async () => {
    await withFakeCodex(childHoldingPipes(true, 0), async ({ skillDir, tempHome }) => {
      const started = Date.now();
      let failure: unknown;
      try { await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 2_000 }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CodexHarnessError);
      const error = failure as CodexHarnessError;
      expect(error.message).toContain('output drain exceeded 5000ms');
      expect(error.result?.exitCode).toBe(0);
      expect(error.result?.stderr).toContain('invalid fixture metadata');
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(fs.existsSync(tempHome())).toBe(false);
    });
  }, 10_000);

  test('spawn errors reject instead of masquerading as a successful empty result', async () => {
    await withFakeCodex('process.exit(0);', async ({ skillDir, dir, pids }) => {
      await expect(runCodexSkill({ skillDir, prompt: 'fixture', cwd: path.join(dir, 'missing'), timeoutMs: 2_000 }))
        .rejects.toBeInstanceOf(CodexHarnessError);
      expect(pids()).toEqual([]);
    });
  });

  test('binary lookup time counts against the same process budget', async () => {
    await withFakeCodex('process.exit(0);', async ({ skillDir, shimDir, pids }) => {
      fs.writeFileSync(path.join(shimDir, 'which'), '#!/bin/bash\nexec sleep 2\n', { mode: 0o755 });
      const started = Date.now();
      // Bun caches executable resolution within a process. A fresh process
      // must see this fake `which` before any earlier lookup caches /usr/bin/which.
      const script = `
        import { runCodexSkill } from ${JSON.stringify(path.join(import.meta.dir, 'helpers', 'codex-session-runner.ts'))};
        console.log(JSON.stringify(await runCodexSkill({ skillDir: ${JSON.stringify(skillDir)}, prompt: 'fixture', timeoutMs: 100 })));
      `;
      const child = Bun.spawnSync([process.execPath, '-e', script], { env: process.env, timeout: 2_000 });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const result = JSON.parse(child.stdout.toString());
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(pids()).toEqual([]);
    });
  });
});

// Module mocks live in a fresh Bun process so they cannot affect this file's
// real fake-executable cases or any other free test in the parent shard.
describe('Codex stream terminal events', () => {
  const cases = [
    { stream: 'stdout', fault: 'none', exitCode: 0 },
    ...(['stdout', 'stderr'] as const).flatMap(stream =>
      (['premature-close', 'error'] as const).flatMap(fault =>
        [0, 2, 124].map(exitCode => ({ stream, fault, exitCode })))),
  ];
  let fixtureDir = '';
  let observations: any[];

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stream-events-'));
    const script = path.join(fixtureDir, 'stream-events.test.ts');
    const output = path.join(fixtureDir, 'observations.json');
    fs.writeFileSync(script, `
import { mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const fixtureDir = ${JSON.stringify(fixtureDir)};
const cases = ${JSON.stringify(cases)};
const skillDir = path.join(fixtureDir, 'skill');
const temporaryDir = path.join(fixtureDir, 'temporary');
const operatorConfig = path.join(fixtureDir, 'operator-codex');
for (const dir of [skillDir, temporaryDir, operatorConfig]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\\nname: fixture\\ndescription: fixture\\n---\\nReview the fixture.\\n');
process.env.TMPDIR = temporaryDir;
process.env.CODEX_HOME = operatorConfig;
let active;
mock.module('child_process', () => ({
  spawn(command, args, options) {
    if (command !== 'codex') throw new Error('Unexpected executable');
    const current = active;
    current.spawns++;
    current.home = options.env.HOME;
    queueMicrotask(() => {
      const { child, scenario } = current;
      child.stdout.write(JSON.stringify({ type: 'item.completed', item: {
        type: 'agent_message', text: 'The gstack review found no issues in the current branch diff.',
      } }) + '\\n');
      child.stderr.write('retained fixture stderr\\n');
      const affected = child[scenario.stream];
      const other = child[scenario.stream === 'stdout' ? 'stderr' : 'stdout'];
      if (scenario.fault === 'none') affected.end();
      else if (scenario.fault === 'premature-close') affected.destroy();
      else {
        // The runner must preserve the first real stream error when another
        // stream subsequently reports an error during cleanup.
        affected.once('error', () => other.emit('error', new Error('secondary cleanup error')));
        affected.destroy(new Error(scenario.stream + ' primary stream failure'));
      }
      other.end();
      child.exitCode = scenario.exitCode;
      child.emit('exit', scenario.exitCode, null);
    });
    return current.child;
  },
  spawnSync: () => { throw new Error('Unexpected synchronous subprocess'); },
  execFileSync: () => { throw new Error('Unexpected synchronous subprocess'); },
}));
mock.module(${JSON.stringify(path.resolve(import.meta.dir, '../scripts/test-strict-output.ts'))}, () => ({
  killProcessGroup(child, signal) {
    if (child !== active.child) throw new Error('Unknown child');
    active.kills.push(signal);
  },
}));
Bun.spawnSync = (args) => {
  if (JSON.stringify(args) !== JSON.stringify(['which', 'codex'])) throw new Error('Unexpected binary lookup');
  active.lookups++;
  return { exitCode: 0, stdout: Buffer.from('/fixture/codex\\n'), stderr: Buffer.alloc(0), signalCode: null };
};
const { runCodexSkill } = await import(${JSON.stringify(path.join(import.meta.dir, 'helpers/codex-session-runner.ts'))});
const { runRecordedCodexEval, validateCodexReview } = await import(${JSON.stringify(path.join(import.meta.dir, 'helpers/codex-eval.ts'))});
test('observe real runner and recorder with controlled stream lifecycles', async () => {
  const observations = [];
  for (const scenario of cases) {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
      kill() { throw new Error('Group cleanup must be intercepted, never sent to an OS process'); },
    });
    const events = [];
    for (const name of ['stdout', 'stderr']) {
      for (const event of ['end', 'close', 'error']) child[name].on(event, () => events.push(name + ':' + event));
    }
    active = { child, scenario, spawns: 0, lookups: 0, kills: [], home: '' };
    const records = [];
    let result;
    let failure;
    try {
      await runRecordedCodexEval({
        name: 'stream-fixture', suite: 'codex-stream-fixture', budgetMs: 1000,
        run: async signal => {
          result = await runCodexSkill({ skillDir, prompt: 'fixture', timeoutMs: 1000, signal });
          return result;
        },
        validate: validateCodexReview,
        record: entry => records.push(entry),
      });
    } catch (error) { failure = error; result ??= error.result; }
    const beforeLate = JSON.stringify({ result, records });
    const observedEvents = [...events];
    const eof = { stdout: child.stdout.readableEnded, stderr: child.stderr.readableEnded };
    // Cleanup retains harmless error listeners. Late notifications cannot
    // mutate an already returned result or manufacture another attempt.
    child.emit('error', new Error('late process error'));
    child.emit('exit', 99, null);
    for (const name of ['stdout', 'stderr']) {
      child[name].emit('end');
      child[name].emit('close');
      child[name].emit('error', new Error('late stream error'));
      child[name].emit('data', 'late stream data');
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    observations.push({
      scenario, result, records, events: observedEvents, eof,
      failure: failure ? { name: failure.name, message: failure.message } : null,
      lateUnchanged: beforeLate === JSON.stringify({ result, records }),
      spawns: active.spawns, lookups: active.lookups, kills: active.kills,
      temporaryHomeRemoved: !!active.home && !fs.existsSync(active.home),
      streamsDestroyed: child.stdout.destroyed && child.stderr.destroyed,
    });
  }
  fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(observations));
}, 5000);
`);
    const child = spawnSync(process.execPath, ['test', script, '--timeout=5000'], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(child.status, child.stderr || child.stdout).toBe(0);
    observations = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(observations).toHaveLength(cases.length);
  }, 15_000);

  afterAll(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  for (const [index, scenario] of cases.entries()) {
    test(`${scenario.stream} ${scenario.fault} with exit ${scenario.exitCode}`, () => {
      const observation = observations[index];
      expect(observation.spawns).toBe(1);
      expect(observation.lookups).toBe(1);
      expect(observation.kills).toEqual(['SIGKILL']);
      expect(observation.temporaryHomeRemoved).toBe(true);
      expect(observation.streamsDestroyed).toBe(true);
      expect(observation.lateUnchanged).toBe(true);
      expect(observation.records).toHaveLength(1);
      expect(observation.result).toMatchObject({
        exitCode: scenario.exitCode,
        output: 'The gstack review found no issues in the current branch diff.',
        stderr: 'retained fixture stderr\n',
      });
      const entry = observation.records[0];
      if (scenario.fault === 'none') {
        expect(observation.failure).toBeNull();
        expect(observation.eof).toEqual({ stdout: true, stderr: true });
        expect(entry).toMatchObject({ passed: true, exit_reason: 'success' });
      } else {
        expect(entry.passed).toBe(false);
        expect(entry.error).toContain('retained fixture stderr');
        if (scenario.exitCode !== 0) {
          expect(entry.exit_reason).toBe(scenario.exitCode === 124 ? 'timeout' : `exit_code_${scenario.exitCode}`);
          expect(observation.failure.message).toContain(`Codex exited with code ${scenario.exitCode}`);
        } else {
          expect(observation.failure.name).toBe('CodexHarnessError');
          expect(entry.exit_reason).toBe('harness_error');
          if (scenario.fault === 'error') {
            expect(entry.error).toContain(`${scenario.stream} primary stream failure`);
            expect(entry.error).not.toContain('secondary cleanup error');
          } else {
            expect(observation.eof[scenario.stream]).toBe(false);
            expect(observation.events).not.toContain(`${scenario.stream}:end`);
            expect(observation.events).not.toContain(`${scenario.stream}:error`);
            expect(entry.error).toContain(scenario.stream);
            expect(entry.error).toContain('before EOF');
          }
        }
      }
    });
  }
});
