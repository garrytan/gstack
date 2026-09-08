import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { trustDialogInput } from './helpers/pty-trust-dialog';

const OLD = 'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm';
const CURRENT = 'Accessingworkspace:\r\n/tmp/fixture\r\nQuicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\r\n❯No,exit\r\nYes,Itrustthisfolder\r\nEntertoconfirm·Esctocancel';

describe('startup trust selection', () => {
  test('confirms the explicit affirmative choice in the old numbered menu', () => {
    expect(trustDialogInput(OLD)).toBe('\r');
    expect(trustDialogInput('Do you trust the files in this folder?\n 1. Yes\n 2. Yes, and always allow access to /tmp/fixture\n❯ 3. No, exit'))
      .toBe('\x1b[A\x1b[A\r');
  });

  test('moves to affirmative when the current unnumbered menu defaults to exit', () => {
    expect(trustDialogInput(CURRENT)).toBe('\x1b[B\r');
    expect(trustDialogInput(CURRENT.replace('❯No,exit', 'No,exit').replace('Yes,Itrust', '❯Yes,Itrust'))).toBe('\r');
  });

  test('handles ANSI cursor visibility and rows collapsed by cursor positioning', () => {
    expect(trustDialogInput('\x1b[?25l' + CURRENT + '\x1b[?25h')).toBe('\x1b[B\r');
    expect(trustDialogInput('Accessing workspace:\n❯No,\x1b[1Cexit\x1b[1BYes,I\x1b[1Ctrustthisfolder'))
      .toBe('\x1b[B\r');
  });

  test('waits for complete choices and a known selected option', () => {
    expect(trustDialogInput('Accessing workspace:\n❯ No, exit')).toBeNull();
    expect(trustDialogInput('Accessing workspace:\n❯ Yes, I trust this folder')).toBeNull();
    expect(trustDialogInput(CURRENT.replace('❯', ''))).toBeNull();
    expect(trustDialogInput('Accessing workspace:\n❯ No, exit\n❯ Yes, I trust this folder')).toBeNull();
    expect(trustDialogInput('Do you trust the files in this folder?\n❯ Continue\nCancel')).toBeNull();
  });

  test('ignores ordinary questions and uses the latest full dialog redraw', () => {
    expect(trustDialogInput('Should we enable a setting?\n❯ 1. Yes\n2. No')).toBeNull();
    expect(trustDialogInput('The text says "trust this folder" but no menu is shown.')).toBeNull();
    expect(trustDialogInput(OLD + '\n' + CURRENT)).toBe('\x1b[B\r');
  });

  test.skipIf(process.platform === 'win32')('the real PTY driver accepts both menu orders, including a partial current render', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-trust-replay-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const resultFile = path.join(dir, 'result.json');
    const cases = [
      { name: 'old', menu: OLD, selected: 0, affirmative: 0, expected: '\r' },
      { name: 'current', menu: CURRENT, selected: 0, affirmative: 1, expected: '\x1b[B\r' },
      { name: 'partial', menu: CURRENT, selected: 0, affirmative: 1, expected: '\x1b[B\r' },
    ].map((item) => ({ ...item, cwd: path.join(dir, item.name), record: path.join(dir, item.name + '.jsonl') }));
    for (const item of cases) fs.mkdirSync(item.cwd);
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
const item = JSON.parse(process.env.TRUST_REPLAY);
const record = (event) => fs.appendFileSync(item.record, JSON.stringify(event) + '\n');
record({type:'startup', pid:process.pid, cwd:process.cwd(), config:process.env.CLAUDE_CONFIG_DIR});
process.stdin.setRawMode?.(true);
let selected = item.selected;
let menuComplete = false;
let inputReadyAt = Infinity;
let pending = '';
process.stdin.on('data', (data) => {
  const inputReady = Date.now() >= inputReadyAt;
  record({type:'input', data:data.toString(), menuComplete, inputReady});
  // Current Claude startup can paint the menu before its input listener is
  // ready. Early navigation is lost; an early Enter retains the exit default.
  if (!inputReady) return;
  pending += data.toString();
  while (pending.length) {
    if (pending.startsWith('\x1b[A')) { setTimeout(() => { selected -= 1; }, 100); pending = pending.slice(3); }
    else if (pending.startsWith('\x1b[B')) { setTimeout(() => { selected += 1; }, 100); pending = pending.slice(3); }
    else if (pending[0] === '\x1b' && pending.length < 3) break;
    else {
      const key = pending[0]; pending = pending.slice(1);
      if (key === '\r') {
        if (!menuComplete || selected !== item.affirmative) process.exit(1);
        process.stdout.write('\nTRUST_ACCEPTED\n');
      }
    }
  }
});
if (item.name === 'partial') {
  process.stdout.write('Accessingworkspace:\r\n❯No,exit\r\n');
  setTimeout(() => { menuComplete = true; inputReadyAt = Date.now() + 900; process.stdout.write('Yes,Itrustthisfolder\r\nEntertoconfirm'); }, 650);
} else {
  menuComplete = true;
  inputReadyAt = Date.now() + 900;
  process.stdout.write(item.menu);
}
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    const runner = pathToFileURL(path.resolve(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(worker, `
import { launchClaudePty } from ${JSON.stringify(runner)};
const cases = ${JSON.stringify(cases)};
const results = await Promise.all(cases.map(async item => {
  const session = await launchClaudePty({cwd:item.cwd, timeoutMs:8000, env:{TRUST_REPLAY:JSON.stringify(item)}});
  try { await session.waitFor('TRUST_ACCEPTED', {timeoutMs:5000}); return item.name; }
  finally { await session.close(); }
}));
await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify(results));
`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode, stdout + stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual(cases.map((item) => item.name));
      for (const item of cases) {
        const events = fs.readFileSync(item.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(events[0].cwd).toBe(fs.realpathSync(item.cwd));
        expect(events[0].config).not.toBe(path.join(os.homedir(), '.claude'));
        const inputs = events.filter((event) => event.type === 'input');
        expect(inputs.map((event) => event.data).join('')).toBe(item.expected);
        expect(inputs.every((event) => event.menuComplete)).toBe(true);
        expect(inputs.every((event) => event.inputReady)).toBe(true);
        if (item.affirmative !== item.selected) expect(inputs.map((event) => event.data)).toEqual(['\x1b[B', '\r']);
        expect(() => process.kill(events[0].pid, 0)).toThrow();
      }
    } finally {
      clearTimeout(killer);
      child.kill('SIGKILL');
      for (const item of cases) {
        if (!fs.existsSync(item.record)) continue;
        const first = JSON.parse(fs.readFileSync(item.record, 'utf8').split('\n')[0]!);
        try { process.kill(first.pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
