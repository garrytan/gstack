import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchClaudePty, runPlanSkillCounting, type ClaudePtySession } from './helpers/claude-pty-runner';

test.skipIf(process.platform === 'win32')('PTY output and exit wake observers without leaving deadline timers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pty-output-'));
  const fake = path.join(dir, 'fake-claude');
  fs.writeFileSync(fake, `#!${process.execPath}
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => process.stdout.write(bytes));
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
process.stdout.write('READY');
`, { mode: 0o755 });
  const originalBinary = process.env.BROWSE_TERMINAL_BINARY;
  let session: ClaudePtySession | undefined;
  try {
    process.env.BROWSE_TERMINAL_BINARY = fake;
    session = await launchClaudePty({ cwd: dir, timeoutMs: 10_000 });
  } finally {
    if (originalBinary === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = originalBinary;
    if (!session) fs.rmSync(dir, { recursive: true, force: true });
  }

  const schedules: Array<{ timer: ReturnType<typeof setTimeout>; delay: number; fired: boolean }> = [];
  const originalTimeout = globalThis.setTimeout;
  let scheduleSpy: ReturnType<typeof spyOn> | undefined;
  let clearSpy: ReturnType<typeof spyOn> | undefined;
  try {
    await session.waitFor('READY', { timeoutMs: 5000 });
    scheduleSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: any[]) => void, delay: number, ...args: any[]) => {
      const entry = { timer: undefined as unknown as ReturnType<typeof setTimeout>, delay, fired: false };
      entry.timer = originalTimeout(() => { entry.fired = true; fn(...args); }, delay);
      schedules.push(entry);
      return entry.timer;
    }) as typeof setTimeout);
    clearSpy = spyOn(globalThis, 'clearTimeout');

    const marker = session.mark();
    const update = session.waitForOutput(marker, 1000);
    const updateTimer = schedules.at(-1)!;
    session.send('changed');
    await update;
    expect(session.visibleSince(marker)).toContain('changed');
    expect(updateTimer.fired).toBe(false);
    expect(clearSpy).toHaveBeenCalledWith(updateTimer.timer);

    const scheduledBeforeBufferedRead = schedules.length;
    await session.waitForOutput(marker, 1000);
    expect(schedules).toHaveLength(scheduledBeforeBufferedRead);

    const unchanged = session.mark();
    await session.waitForOutput(unchanged, 10);
    expect(schedules.at(-1)!.fired).toBe(true);
    expect(session.visibleSince(unchanged)).toBe('');

    const exited = session.waitForOutput(session.mark(), 1000);
    const exitTimer = schedules.at(-1)!;
    await Promise.all([exited, session.close()]);
    expect(session.exited()).toBe(true);
    expect(exitTimer.fired).toBe(false);
    const closeTimer = schedules.find(entry => entry.delay === 2000)!;
    expect(closeTimer).toBeDefined();
    expect(closeTimer.fired).toBe(false);
    for (const entry of schedules) expect(clearSpy).toHaveBeenCalledWith(entry.timer);

    const scheduledBeforeExitedRead = schedules.length;
    await session.waitForOutput(session.mark(), 1000);
    expect(schedules).toHaveLength(scheduledBeforeExitedRead);
  } finally {
    try { await session.close(); }
    finally {
      scheduleSpy?.mockRestore();
      clearSpy?.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}, 15_000);

test.skipIf(process.platform === 'win32')('split terminal redraws settle before routing question input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pty-split-redraw-'));
  const fake = path.join(dir, 'fake-claude');
  const input = path.join(dir, 'input.txt');
  const ready = `PTY_READY:${dir}`;
  fs.writeFileSync(fake, `#!${process.execPath}
import * as fs from 'node:fs';
import * as path from 'node:path';
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'split-redraw');
fs.mkdirSync(project, {recursive:true});
fs.writeFileSync(path.join(project, 'split-redraw.jsonl'), JSON.stringify({
  cwd:process.cwd(), sessionId:'split-redraw', isSidechain:false,
  message:{role:'assistant',content:[{type:'text',text:'Fixture CLI started.'}]},
}) + '\\n');
let started = false;
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => {
  fs.appendFileSync(${JSON.stringify(input)}, bytes);
  if (started) return;
  started = true;
  process.stdout.write('☐Stripe event types\\nWhich event should the handler accept?\\n❯1.Specify one canonical event\\n2.Accept all events\\n');
  setTimeout(() => process.stdout.write('·'.repeat(4200) + '\\nMinimum required test cases:\\n1.Happy path\\n2.Email failure\\n3.DB timeout\\n4.Unknown event\\n5.Unknown user\\n❯1\\n'), 30);
  setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HGSTACK REVIEW REPORT\\n'), 700);
});
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
process.stdout.write(${JSON.stringify(ready)} + '\\x1b[2J\\x1b[H');
`, { mode: 0o755 });
  const originalBinary = process.env.BROWSE_TERMINAL_BINARY;
  try {
    process.env.BROWSE_TERMINAL_BINARY = fake;
    const result = await runPlanSkillCounting({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '# Split redraw fixture',
      isLastStep0AUQ: () => false, reviewCountCeiling: 1, timeoutMs: 9000, startupReadyMarker: ready,
    });
    expect(result.outcome).toBe('completion_summary');
    expect(fs.readFileSync(input, 'utf8')).toBe('/plan-ceo-review\r');
  } finally {
    if (originalBinary === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = originalBinary;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 12_000);

test.skipIf(process.platform === 'win32')('a missing startup-ready marker sends no command and cleans the owned PTY fixture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pty-not-ready-'));
  const fake = path.join(dir, 'fake-claude');
  const record = path.join(dir, 'started.json');
  const input = path.join(dir, 'input.txt');
  fs.writeFileSync(fake, `#!${process.execPath}
import * as fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}));
process.stdin.setRawMode(true);
process.stdin.on('data', bytes => fs.appendFileSync(${JSON.stringify(input)}, bytes));
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
process.stdout.write('BOOTING, NOT READY');
`, { mode: 0o755 });
  const originalBinary = process.env.BROWSE_TERMINAL_BINARY;
  try {
    process.env.BROWSE_TERMINAL_BINARY = fake;
    await expect(runPlanSkillCounting({
      skillName: 'plan-ceo-review', slashCommand: '/plan-ceo-review', followUpPrompt: '# Owned startup fixture',
      isLastStep0AUQ: () => false, reviewCountCeiling: 1, timeoutMs: 6500,
      startupReadyMarker: `PTY_READY:${dir}`,
    })).rejects.toThrow();
    expect(fs.existsSync(input)).toBe(false);
    const started = JSON.parse(fs.readFileSync(record, 'utf8'));
    expect(() => process.kill(started.pid, 0)).toThrow();
    expect(fs.existsSync(started.cwd)).toBe(false);
  } finally {
    if (originalBinary === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
    else process.env.BROWSE_TERMINAL_BINARY = originalBinary;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test('close releases observers even when the child never reports exit', async () => {
  const originalBinary = process.env.BROWSE_TERMINAL_BINARY;
  const signals: string[] = [];
  const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => ({
    exited: new Promise(() => {}),
    kill: (signal: string) => { signals.push(signal); },
    terminal: { write() {} },
  })) as typeof Bun.spawn);
  let session: ClaudePtySession | undefined;
  let closed: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    process.env.BROWSE_TERMINAL_BINARY = process.execPath;
    session = await launchClaudePty({ timeoutMs: 10_000 });
    const output = session.waitForOutput(session.mark(), 10_000);
    closed = session.close();
    await Promise.race([output, new Promise<void>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('close did not release the output waiter')), 500);
    })]);
    clearTimeout(deadline);
    await closed;
    expect(signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(session.exited()).toBe(false);
    await session.waitForOutput(session.mark(), 10_000);
  } finally {
    clearTimeout(deadline);
    try { await (closed ?? session?.close()); }
    finally {
      spawnSpy.mockRestore();
      if (originalBinary === undefined) delete process.env.BROWSE_TERMINAL_BINARY;
      else process.env.BROWSE_TERMINAL_BINARY = originalBinary;
    }
  }
}, 10_000);

test.skipIf(process.platform === 'win32')('continuous PTY redraws coalesce expensive observations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pty-redraw-'));
  const fake = path.join(dir, 'fake-claude');
  const worker = path.join(dir, 'worker.ts');
  const ready = `PTY_READY:${dir}`;
  fs.writeFileSync(fake, `#!${process.execPath}
let spinner;
process.stdin.setRawMode(true);
process.stdin.on('data', () => {
  spinner ??= setInterval(() => process.stdout.write('\\rWorking ' + performance.now()), 5);
});
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
process.stdout.write(${JSON.stringify(ready)} + '\\x1b[2J\\x1b[H');
`, { mode: 0o755 });
  const screenUrl = pathToFileURL(path.join(import.meta.dir, 'helpers/pty-screen.ts')).href;
  const runnerUrl = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
  fs.writeFileSync(worker, `import {mock} from 'bun:test';
const {createPtyScreen} = await import(${JSON.stringify(screenUrl)});
const observations = [];
mock.module(${JSON.stringify(screenUrl)}, () => ({createPtyScreen: async (...args) => {
  const screen = await createPtyScreen(...args);
  return {...screen, read: async () => { observations.push(performance.now()); return screen.read(); }};
}}));
const {runPlanSkillCounting} = await import(${JSON.stringify(runnerUrl)});
const start = performance.now();
const result = await runPlanSkillCounting({skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',
  followUpPrompt:'# Continuous redraw fixture',isLastStep0AUQ:()=>false,reviewCountCeiling:1,
  timeoutMs:9000,startupReadyMarker:${JSON.stringify(ready)}});
console.log(JSON.stringify({outcome:result.outcome,elapsedMs:performance.now()-start,reads:observations.length}));
`);
  const child = Bun.spawn([process.execPath, worker], {
    env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1', EVALS_RUN_ID: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.outcome).toBe('timeout');
    expect(result.reads).toBeGreaterThanOrEqual(3);
    expect(result.reads).toBeLessThanOrEqual(Math.ceil(result.elapsedMs / 250) + 1);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
