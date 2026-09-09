import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOutsideReceiptRuntime } from './helpers/outside-voice-receipt';
import { codexExecutionTranscript, foundInvoiceAuthorizationDefect } from './helpers/outside-voice-evidence';

const finding = 'invoice.ts removes the owner check and exposes another user’s bankAccount.\nRecommendation: Restore authorization because invoice financial data crosses ownership boundaries.';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-receipt-free-'));
  const real = path.join(dir, 'real runtime'), repo = path.join(dir, 'repo'), observed = path.join(dir, 'observed.json');
  fs.mkdirSync(path.join(real, 'bin'), { recursive: true }); fs.mkdirSync(repo);
  const launcher = path.join(real, 'bin/gstack-claude-code');
  fs.writeFileSync(launcher, `#!${process.execPath}\nconst input=await Bun.stdin.text();await Bun.write(${JSON.stringify(observed)},JSON.stringify({argv:process.argv.slice(2),input,marker:process.env.RECEIPT_FREE_MARKER}));const request=JSON.parse(input);console.log(JSON.stringify(request.output));console.error('real diagnostic');if(request.signal)process.kill(process.pid,request.signal);else process.exit(request.exit??0);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(real, 'bin/unchanged'), 'unchanged');
  const runtime = createOutsideReceiptRuntime(real, dir, repo);
  const shim = path.join(runtime.runtimeRoot, 'bin/gstack-claude-code');
  const envelope = { status: 'completed', provider: 'claude-code', result: finding, session_id: 'free-session-A', exit_code: 0 };
  const argv = ['--cwd', repo, '--access', 'none', '--timeout-ms', '1000'];
  return { dir, real, repo, observed, launcher, runtime, shim, envelope, argv,
    records: path.join(path.dirname(runtime.runtimeRoot), 'records'),
    async run(output = envelope, exit = 0, signal?: string) {
      const input = JSON.stringify({ output, exit, signal });
      const wrapper = path.join(dir, 'indirect.sh');
      fs.writeFileSync(wrapper, '#!/bin/sh\nexec "$@"\n');
      const child = Bun.spawn(['/bin/sh', wrapper, shim, ...argv], {
        cwd: repo, env: { ...process.env, RECEIPT_FREE_MARKER: 'unchanged-env' },
        stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr, input, command: '/bin/sh ' + wrapper };
    },
    close() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test.skipIf(process.platform === 'win32')('indirect wrapper needs a real nonce-bound completed launcher receipt, not parent stdout', async () => {
  const f = fixture();
  try {
    expect(f.runtime.read()).toEqual({ receipts: [], executions: [] });
    const result = await f.run();
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(f.envelope); expect(result.stderr).toBe('real diagnostic\n');
    expect(JSON.parse(fs.readFileSync(f.observed, 'utf8'))).toEqual({ argv: f.argv, input: result.input, marker: 'unchanged-env' });
    const parent = [{ command: result.command, output: result.stdout, succeeded: true }];
    expect(foundInvoiceAuthorizationDefect(parent, 'claude-code')).toBe(false);
    expect(codexExecutionTranscript(parent)).toEqual([{ type: 'host_execution', host: 'codex', ...parent[0] }]);
    const actual = f.runtime.read();
    expect(actual.receipts).toHaveLength(1); expect(actual.receipts[0]!.pid).toBeGreaterThan(0);
    expect(actual.receipts[0]!.inputBytes).toBe(Buffer.byteLength(result.input));
    expect(foundInvoiceAuthorizationDefect(actual.executions, 'claude-code')).toBe(true);
    expect(fs.realpathSync(path.join(f.runtime.runtimeRoot, 'bin/unchanged'))).toBe(path.join(f.real, 'bin/unchanged'));
  } finally { f.close(); }
}, 10000);

test.skipIf(process.platform === 'win32')('stale, foreign, altered, alias and malformed receipts cannot supply credit', async () => {
  const f = fixture();
  try {
    await f.run(); const file = path.join(f.records, fs.readdirSync(f.records).find(x => x.endsWith('.json'))!);
    const raw = fs.readFileSync(file, 'utf8'), valid = JSON.parse(raw);
    for (const patch of [
      { nonce: 'foreign' }, { cwd: '/foreign' }, { actualCwd: '/foreign' }, { records: '/foreign' },
      { launcher: '/foreign' }, { launcherHash: 'wrong' }, { createdAt: 0 },
      { startedAt: 0 }, { endedAt: Date.now() + 100000 }, { pid: 0 }, { inputBytes: 0 },
      { inputHash: 'bad' }, { stdout: finding }, { stdoutHash: 'bad' }, { stderrHash: 'bad' },
      { argv: ['--cwd', '/foreign'] }, { argv: [...f.argv, '--cwd', f.repo] },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...valid, ...patch })); expect(f.runtime.read().executions, JSON.stringify(patch)).toEqual([]);
    }
    fs.writeFileSync(file, '{broken'); expect(f.runtime.read().receipts).toEqual([]);
    const other = path.join(f.dir, 'other.json'); fs.writeFileSync(other, raw); fs.unlinkSync(file); fs.symlinkSync(other, file);
    expect(f.runtime.read().receipts).toEqual([]); fs.unlinkSync(file); fs.writeFileSync(file, raw);
    fs.appendFileSync(f.launcher, '// altered launcher\n'); expect(f.runtime.read().receipts).toEqual([]);
  } finally { f.close(); }
}, 10000);

test.skipIf(process.platform === 'win32')('real failures, missing session, transport-only output and no-finding reviews remain negative', async () => {
  const f = fixture();
  try {
    const cases = [
      [{ ...f.envelope, status: 'error' }, 0], [{ ...f.envelope, exit_code: 1 }, 0],
      [{ ...f.envelope, session_id: '' }, 0], [{ ...f.envelope, result: 'Tool use: Bash\ninvoice owner' }, 0],
      [{ ...f.envelope, result: 'Recommendation: Accept because no issue was found.' }, 0], [f.envelope, 7],
    ] as const;
    for (const [output, exit] of cases) {
      const result = await f.run(output, exit); expect(result.code).toBe(exit);
      expect(foundInvoiceAuthorizationDefect(f.runtime.read().executions, 'claude-code')).toBe(false);
    }
    expect(f.runtime.read().receipts).toHaveLength(cases.length);
  } finally { f.close(); }
}, 10000);


test.skipIf(process.platform === 'win32')('real signal and observation write failure preserve the child outcome without credit', async () => {
  const f = fixture();
  try {
    const signaled = await f.run(f.envelope, 0, 'SIGTERM');
    expect(signaled.code).toBe(143);
    expect(f.runtime.read().receipts[0]?.signal).toBe('SIGTERM');
    expect(f.runtime.read().executions).toEqual([]);
    fs.rmSync(f.records, { recursive: true });
    const unchanged = await f.run(f.envelope);
    expect(unchanged.code).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toEqual(f.envelope);
    expect(unchanged.stderr).toBe('real diagnostic\n');
    expect(f.runtime.read()).toEqual({ receipts: [], executions: [] });
  } finally { f.close(); }
}, 10000);
