/** Free PTY replay of numbered-menu selection with deferred cursor updates. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('PTY numbered-option selection', () => {
  test.skipIf(process.platform === 'win32')('waits for the selected option to update before confirming', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-option-replay-'));
    const fake = path.join(dir, 'fake-claude');
    const worker = path.join(dir, 'worker.ts');
    const resultFile = path.join(dir, 'result.json');
    const cases = [
      { name: 'coalesced-second', index: 2, coalesced: true, expected: 1 },
      { name: 'selected-second', index: 2, coalesced: false, expected: 2 },
      { name: 'selected-third', index: 3, coalesced: false, expected: 3 },
    ].map(item => ({ ...item, cwd: path.join(dir, item.name), record: path.join(dir, item.name + '.jsonl') }));
    for (const item of cases) fs.mkdirSync(item.cwd);

    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
const item = JSON.parse(process.env.OPTION_REPLAY);
const record = (event) => fs.appendFileSync(item.record, JSON.stringify(event) + '\n');
record({type:'startup', pid:process.pid, cwd:process.cwd()});
process.stdin.setRawMode?.(true);
let selected = 1;
let confirmed = false;
process.stdin.on('data', (data) => {
  record({type:'input', data:data.toString()});
  for (const key of data.toString()) {
    if (/^[1-3]$/.test(key)) {
      // Model a menu whose selection state commits on a later render.
      // Enter in the same input turn sees the previous selected option.
      setTimeout(() => {
        selected = Number(key);
        record({type:'selected', selected});
      }, 100);
    } else if (key === '\r' && !confirmed) {
      confirmed = true;
      record({type:'confirmed', selected});
      process.stdout.write('\nCONFIRMED:' + selected + '\n');
    }
  }
});
process.stdout.write('OPTION_MENU_READY\n❯1.First\n2.Second\n3.Third\n');
process.on('SIGINT', () => process.exit(0));
process.stdin.resume();
`);
    fs.chmodSync(fake, 0o755);
    const runner = pathToFileURL(path.resolve(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(worker, `
import { launchClaudePty, selectPtyNumberedOption } from ${JSON.stringify(runner)};
const cases = ${JSON.stringify(cases)};
const results = await Promise.all(cases.map(async item => {
  const session = await launchClaudePty({cwd:item.cwd, timeoutMs:5000, env:{OPTION_REPLAY:JSON.stringify(item)}});
  try {
    await session.waitFor('OPTION_MENU_READY', {timeoutMs:2000, pollMs:20});
    if (item.coalesced) session.send(String(item.index) + '\\r');
    else await selectPtyNumberedOption(session, item.index);
    await session.waitFor('CONFIRMED:', {timeoutMs:2000, pollMs:20});
    const selected = Number(session.visibleText().match(/CONFIRMED:([1-3])/)?.[1]);
    return {name:item.name, selected};
  } finally { await session.close(); }
}));
await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify(results));
`);
    const child = Bun.spawn([process.execPath, worker], {
      env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode, stdout + stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual(
        cases.map(item => ({ name: item.name, selected: item.expected })),
      );
      for (const item of cases) {
        const events = fs.readFileSync(item.record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(events[0].cwd).toBe(fs.realpathSync(item.cwd));
        const inputs = events.filter(event => event.type === 'input');
        expect(inputs.map(event => event.data).join('')).toBe(`${item.index}\r`);
        const confirmations = events.filter(event => event.type === 'confirmed');
        expect(confirmations).toEqual([{ type: 'confirmed', selected: item.expected }]);
        if (!item.coalesced) {
          expect(inputs.map(event => event.data)).toEqual([String(item.index), '\r']);
          const selectionIndex = events.findIndex(event => event.type === 'selected');
          expect(selectionIndex).toBeGreaterThan(-1);
          expect(selectionIndex).toBeLessThan(events.findIndex(event => event.type === 'confirmed'));
        }
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
  }, 10_000);
});
