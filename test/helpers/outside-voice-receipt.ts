/** Fixture-only witness of the real launcher; not a same-UID tamper boundary. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateOutsideReview } from '../../lib/outside-review-result';
import type { OutsideExecution } from './outside-voice-evidence';

const LIMIT = 32 * 1024 * 1024;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
type Binding = { nonce: string; cwd: string; launcher: string; launcherHash: string; records: string; createdAt: number };
type Receipt = Binding & { id: string; pid: number; startTicks: string | null; argv: string[];
  actualCwd: string; startedAt: number; endedAt: number; exitCode: number | null; signal: string | null;
  inputHash: string; inputBytes: number; stdout: string; stderr: string; stdoutHash: string; stderrHash: string };

/** Called only by the fixture's executable shim, never by the review model. */
export async function recordOutsideInvocation(binding: Binding, argv: string[]): Promise<void> {
  // Do not substitute argv, cwd, environment, access, model, tools or deadlines.
  const startedAt = Date.now();
  const child = spawn(binding.launcher, argv, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let startTicks: string | null = null;
  try { startTicks = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]!; } catch { /* Unknown off Linux or after an early exit. */ }
  const input = createHash('sha256'); let inputBytes = 0; let inputEnded = false; let bytes = 0; let overflow = false;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => { input.update(chunk); inputBytes += chunk.length; });
  process.stdin.once('end', () => { inputEnded = true; });
  process.stdin.pipe(child.stdin!);
  child.stdin!.on('error', () => { /* The real launcher may reject arguments before reading stdin. */ });
  for (const [stream, output, saved] of [[child.stdout!, process.stdout, stdout], [child.stderr!, process.stderr, stderr]] as const) {
    stream.on('data', (chunk: Buffer) => {
      output.write(chunk); bytes += chunk.length;
      if (bytes <= LIMIT) saved.push(Buffer.from(chunk)); else overflow = true;
    });
  }
  const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* Already exited. */ } };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  process.stdin.unpipe(child.stdin!); process.stdin.pause();
  if (!ended.error && child.pid && !overflow && inputEnded) try {
    const outputBytes = Buffer.concat(stdout), diagnosticBytes = Buffer.concat(stderr);
    const output = outputBytes.toString(), diagnostic = diagnosticBytes.toString();
    if (!Buffer.from(output).equals(outputBytes) || !Buffer.from(diagnostic).equals(diagnosticBytes)) throw new Error('Non-UTF8 result');
    const receipt: Receipt = { ...binding, id: randomUUID(), pid: child.pid, startTicks, argv,
      actualCwd: process.cwd(), startedAt, endedAt: Date.now(), exitCode: ended.code, signal: ended.signal,
      inputHash: input.digest('hex'), inputBytes, stdout: output, stderr: diagnostic,
      stdoutHash: hash(output), stderrHash: hash(diagnostic) };
    const file = path.join(binding.records, receipt.id + '.json');
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file);
  } catch { /* Observation failure never changes the real launcher's result. */ }
  if (ended.signal) process.kill(process.pid, ended.signal);
  else process.exitCode = ended.code ?? 1;
}

export function createOutsideReceiptRuntime(runtimeRoot: string, fixtureRoot: string, cwd: string) {
  const folder = fs.mkdtempSync(path.join(fixtureRoot, 'outside-receipt-'));
  const facade = path.join(folder, 'runtime'), records = path.join(folder, 'records');
  fs.mkdirSync(facade); fs.mkdirSync(records, { mode: 0o700 }); fs.mkdirSync(path.join(facade, 'bin'));
  for (const entry of fs.readdirSync(runtimeRoot)) if (entry !== 'bin')
    fs.symlinkSync(path.join(runtimeRoot, entry), path.join(facade, entry));
  for (const entry of fs.readdirSync(path.join(runtimeRoot, 'bin'))) if (entry !== 'gstack-claude-code')
    fs.symlinkSync(path.join(runtimeRoot, 'bin', entry), path.join(facade, 'bin', entry));
  const launcher = path.join(runtimeRoot, 'bin/gstack-claude-code');
  const binding: Binding = { nonce: randomUUID(), cwd, launcher, launcherHash: hash(fs.readFileSync(launcher)), records, createdAt: Date.now() };
  const shim = path.join(facade, 'bin/gstack-claude-code');
  fs.writeFileSync(shim, `#!${process.execPath}\nimport {recordOutsideInvocation} from ${JSON.stringify(pathToFileURL(import.meta.path).href)};\nawait recordOutsideInvocation(${JSON.stringify(binding)},process.argv.slice(2));\n`, { mode: 0o755 });
  const shimHash = hash(fs.readFileSync(shim));
  return {
    runtimeRoot: facade,
    read() {
      const receipts: Receipt[] = [], executions: OutsideExecution[] = [];
      let names: string[];
      try {
        if (hash(fs.readFileSync(shim)) !== shimHash || hash(fs.readFileSync(launcher)) !== binding.launcherHash) return { receipts, executions };
        names = fs.readdirSync(records);
      } catch { return { receipts, executions }; }
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(records, name);
        try {
          const info = fs.lstatSync(file);
          if (!info.isFile() || info.size > LIMIT * 3 || fs.realpathSync(file) !== file) continue;
          const r: Receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Object.entries(binding).some(([key, value]) => r[key as keyof Receipt] !== value) ||
              r.id + '.json' !== name || r.actualCwd !== cwd || !Number.isSafeInteger(r.pid) || r.pid <= 0 ||
              (process.platform === 'linux' && !/^\d+$/.test(r.startTicks ?? '')) ||
              !Number.isSafeInteger(r.startedAt) || !Number.isSafeInteger(r.endedAt) ||
              r.startedAt < binding.createdAt || r.endedAt < r.startedAt || r.endedAt > Date.now() ||
              !Array.isArray(r.argv) || !r.argv.every(x => typeof x === 'string') ||
              r.argv.filter(x => x === '--cwd').length !== 1 || r.argv[r.argv.indexOf('--cwd') + 1] !== cwd ||
              typeof r.stdout !== 'string' || typeof r.stderr !== 'string' ||
              hash(r.stdout) !== r.stdoutHash || hash(r.stderr) !== r.stderrHash ||
              !/^[a-f0-9]{64}$/.test(r.inputHash) || !Number.isSafeInteger(r.inputBytes) || r.inputBytes <= 0) continue;
          receipts.push(r);
          const envelope = JSON.parse(r.stdout);
          if (r.exitCode !== 0 || r.signal !== null || envelope?.status !== 'completed' ||
              envelope.provider !== 'claude-code' || envelope.exit_code !== 0 ||
              typeof envelope.session_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope.session_id) ||
              typeof envelope.result !== 'string' || !validateOutsideReview(envelope.result, 'review').completed) continue;
          // This command describes the recorded real argv, not the outer shell text.
          const quote = (word: string) => /^[A-Za-z0-9_\/.:-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'";
          executions.push({ command: [launcher, ...r.argv].map(quote).join(' '), output: envelope.result, succeeded: true });
        } catch { /* Malformed, foreign or incomplete receipt supplies no evidence. */ }
      }
      return { receipts, executions };
    },
  };
}
