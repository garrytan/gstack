import { expect, test } from 'bun:test';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('same-barrier cell styling distinguishes a startup suggestion from the identical typed text', async () => {
  const projection = new PtyCurrentScreen();
  try {
    const text = '❯ Try "refactor src/設定.ts"';
    projection.feed('\x1b[2J\x1b[H❯ \x1b[7mT\x1b[27m\x1b[2mry "refactor src/設定.ts"\x1b[22m');
    const placeholder = projection.snapshot();
    projection.feed('\x1b[2J\x1b[H' + text);
    const draft = projection.snapshot();
    const a = await placeholder, b = await draft;
    expect(a.lines[0].text).toBe(text);
    expect(b.lines[0].text).toBe(text);
    expect(a.styledText).toEqual([
      { row: 0, start: 2, text: 'T', dim: false, inverse: true },
      { row: 0, start: 3, text: 'ry "refactor src/設定.ts"', dim: true, inverse: false },
    ]);
    expect(b.styledText).toEqual([]);
    expect(a.inputOffset).toBeLessThan(b.inputOffset);
  } finally { projection.dispose(); }
});

test('public xterm projection restores globals and reconstructs an exact current file dialog without a DOM', async () => {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const self = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const projection = new PtyCurrentScreen();
  try {
    let header = 'Create file /tmp/fixture/gstck-test-plan-co.md';
    projection.feed('\x1b[?2026h\x1b[?25l\x1b[2J\x1b[H' + header);
    let index = header.indexOf('gstck') + 3;
    projection.feed(`\x1b[1;${index + 1}H\x1b[@a`);
    header = header.slice(0, index) + 'a' + header.slice(index);
    index = header.indexOf('-co.md') + 2;
    projection.feed(`\x1b[1;${index + 1}H\x1b[@e`);
    header = header.slice(0, index) + 'e' + header.slice(index);
    projection.feed('\x1b[2;1HDo you want to create gstack-test-plan-ceo.md?\r\n❯ 1. Yes\r\n  2. Yes, and switch to accept edits\r\n  3. No\x1b[?2026l');
    const snapshot = await projection.snapshot();
    expect(snapshot.cols).toBe(120);
    expect(snapshot.rows).toBe(40);
    expect(snapshot.lines[0].text).toBe('Create file /tmp/fixture/gstack-test-plan-ceo.md');
    expect(snapshot.text).toContain('Do you want to create gstack-test-plan-ceo.md?\n❯ 1. Yes');
    expect(snapshot.text).not.toContain('\x1b');
    expect(Object.getOwnPropertyDescriptor(globalThis, 'navigator')).toEqual(navigator);
    expect(Object.getOwnPropertyDescriptor(globalThis, 'self')).toEqual(self);
    expect(typeof document).toBe('undefined');
  } finally { projection.dispose(); }
});

test('screen snapshots preserve UTF-8 chunks and bind the barrier before later writes', async () => {
  const projection = new PtyCurrentScreen();
  try {
    const bytes = new TextEncoder().encode('界');
    expect(projection.feed(bytes.slice(0, 1))).toBe(1);
    const partial = projection.snapshot();
    expect(projection.feed(bytes.slice(1))).toBe(3);
    const complete = projection.snapshot();
    projection.feed('\r\x1b[2KLater screen');
    expect((await partial).inputOffset).toBe(1);
    expect((await complete).lines[0].text).toBe('界');
    expect((await complete).inputOffset).toBe(3);
    const latest = await projection.snapshot();
    expect(latest.lines[0].text).toBe('Later screen');
    expect(latest.inputOffset).toBe(projection.inputOffset);
  } finally { projection.dispose(); }
});

test('projection copies mutable bytes and handles wrapping and alternate screens', async () => {
  const projection = new PtyCurrentScreen({ cols: 12, rows: 3 });
  try {
    const bytes = new TextEncoder().encode('Original');
    projection.feed(bytes);
    bytes.fill(120);
    expect((await projection.snapshot()).lines[0].text).toBe('Original');
    projection.feed('\x1b[2J\x1b[H123456789012wrap');
    const wrapped = await projection.snapshot();
    expect(wrapped.lines[1]).toEqual({ text: 'wrap', wrapped: true });
    projection.feed('\x1b[?1049h\x1b[2J\x1b[HAlternate');
    expect((await projection.snapshot()).bufferType).toBe('alternate');
    projection.feed('\x1b[?1049l');
    expect((await projection.snapshot()).lines[0].text).toBe('123456789012');
  } finally { projection.dispose(); }
});

test('disposing a projection rejects queued snapshots and future work', async () => {
  const projection = new PtyCurrentScreen();
  projection.feed('Pending');
  const pending = projection.snapshot();
  projection.dispose();
  await expect(pending).rejects.toThrow('disposed');
  expect(() => projection.feed('later')).toThrow('disposed');
  expect(() => projection.snapshot()).toThrow('disposed');
  projection.dispose();
});

test('a line feed preserves the cursor column while CRLF starts at column zero', async () => {
  const projection = new PtyCurrentScreen();
  try {
    projection.feed('abc\nZ\r\nNext');
    const snapshot = await projection.snapshot();
    expect(snapshot.lines.slice(0, 3).map(line => line.text)).toEqual(['abc', '   Z', 'Next']);
  } finally { projection.dispose(); }
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('invalid flush timeout %s fails before loading xterm', value => {
  expect(() => new PtyCurrentScreen({ flushTimeoutMs: value })).toThrow('finite and positive');
});

test('a stalled decoder has a bounded rejection and import failures restore navigator', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'current-screen-free-'));
  const helper = path.join(import.meta.dir, 'helpers', 'pty-current-screen.ts');
  const xterm = import.meta.resolve('xterm');
  const source = `import { mock } from 'bun:test';
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let disposed = 0;
    mock.module(${JSON.stringify(xterm)}, () => {
      if (typeof navigator !== 'undefined') throw new Error('navigator was not hidden for import');
      throw new Error('controlled import failure');
    });
    const { PtyCurrentScreen } = await import(${JSON.stringify(helper)});
    let importError = ''; try { new PtyCurrentScreen().feed('x'); } catch (cause) { importError = String(cause); }
    const restored = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    mock.module(${JSON.stringify(xterm)}, () => ({ Terminal: class { write() {} dispose() { disposed++; } } }));
    const projection = new PtyCurrentScreen({ flushTimeoutMs: 10 });
    projection.feed('queued');
    let timeout = ''; try { await projection.snapshot(); } catch (cause) { timeout = String(cause); }
    console.log(JSON.stringify({ importError, restored: ['get', 'set', 'value', 'writable', 'enumerable', 'configurable'].every(key => before?.[key] === restored?.[key]),
      timeout, disposed }));`;
  const child = Bun.spawn([process.execPath, '-e', source], { cwd: tmp,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, TMPDIR: tmp }, stdout: 'pipe', stderr: 'pipe' });
  const watchdog = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.importError).toContain('controlled import failure');
    expect(result.restored).toBe(true);
    expect(result.timeout).toContain('within 10ms');
    expect(result.disposed).toBe(1);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 10_000);

test('resizing the decoded viewport requires a completed barrier and creates no new output', async () => {
  const projection = new PtyCurrentScreen();
  try {
    projection.feed('Old viewport');
    const pending = projection.snapshot();
    expect(() => projection.resize(120, 80)).toThrow('snapshot is pending');
    const before = await pending;
    projection.resize(120, 80);
    const after = await projection.snapshot();
    expect(after.rows).toBe(80);
    expect(after.cols).toBe(120);
    expect(after.inputOffset).toBe(before.inputOffset);
    projection.feed('\x1b[2J\x1b[HNew heading\x1b[70;1HNew low row');
    const repainted = await projection.snapshot();
    expect(repainted.lines[0].text).toBe('New heading');
    expect(repainted.lines[69].text).toBe('New low row');
    expect(repainted.inputOffset).toBeGreaterThan(after.inputOffset);
    projection.resize(120, 40);
    expect((await projection.snapshot()).rows).toBe(40);
  } finally { projection.dispose(); }
  expect(() => projection.resize(120, 80)).toThrow('disposed');
});

test.skipIf(process.platform === 'win32').each([120, 240].flatMap(cols => [
  ...['normal', 'already-exited', 'body-error'].map(scenario => [cols, scenario, 40, 80] as const),
  [cols, 'normal', 120, 480] as const,
  ...['normal', 'already-exited', 'body-error'].map(scenario => [cols, scenario, 120, 960] as const),
]))('owned local PTY sessions preserve viewport geometry and cleanup (%i columns, %s, %i initial rows, %i expanded rows)', async (cols, scenario, initialRows, expandedRows) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-viewport-free-')));
  const native = path.join(tmp, 'native.ts');
  const wrapper = path.join(tmp, 'native-wrapper');
  const probe = path.join(tmp, 'probe.ts');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.copyFileSync(path.join(import.meta.dir, 'fixtures', 'native-viewport.ts'), native);
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(native) + ' ' + quote(scenario) + '\n', { mode: 0o700 });
  // The native driver now selects fixed geometry at launch. Adaptive
  // resizeQuestionViewport is retired; exercise the same fourteen geometry
  // and lifecycle scenarios against the decoder the current driver uses.
  fs.writeFileSync(probe, `import { launchClaudePty } from ${JSON.stringify(path.join(import.meta.dir, 'helpers', 'claude-pty-runner.ts'))};
    const evidence=[];
    for (const rows of [${initialRows},${expandedRows},${initialRows}]) {
      const session=await launchClaudePty({cwd:${JSON.stringify(tmp)},cols:${cols},rows,observeScreen:true,timeoutMs:5000});
      let viewport,observedError=null,rawStable=false;
      try {
        await session.waitFor('LOW:'+rows,{timeoutMs:2000});
        const raw=session.rawOutput();
        viewport=await session.currentScreen();
        rawStable=raw===session.rawOutput();
        if (${JSON.stringify(scenario)}==='already-exited') {
          const end=Date.now()+2000;
          while(!session.exited()&&Date.now()<end)await Bun.sleep(20);
          if(!session.exited())throw new Error('Native child failed to exit');
        }
        if (${JSON.stringify(scenario)}==='body-error') throw new Error('controlled body failure');
      } catch(cause) { observedError=String(cause); }
      finally { await session.close(); await session.close(); }
      let stillRunning=false;
      try { process.kill(session.pid(),0); stillRunning=true; }
      catch(cause) { if(cause.code!=='ESRCH')throw cause; }
      evidence.push({rows,viewport,rawStable,observedError,exited:session.exited(),stillRunning,
        finalViewport:await session.currentScreen()});
    }
    console.log(JSON.stringify(evidence));`);
  const child = Bun.spawn([process.execPath, probe], { cwd: tmp, env: { PATH: process.env.PATH ?? '', HOME: tmp, TMPDIR: tmp,
    TERM: 'xterm-256color', EVALS_HERMETIC: '1', BROWSE_TERMINAL_BINARY: wrapper }, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(timedOut, stderr).toBe(false);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.map((entry: { rows: number }) => entry.rows)).toEqual([initialRows, expandedRows, initialRows]);
    for (const entry of result) {
      expect(entry.viewport.startsWith(`NATIVE:${cols}x${entry.rows}`)).toBe(true);
      expect(entry.viewport.split('\n')).toHaveLength(entry.rows);
      expect(entry.viewport.split('\n')[entry.rows - 3]).toBe(`LOW:${entry.rows}`);
      expect(entry.viewport).not.toContain('\x1b');
      expect(entry.rawStable).toBe(true);
      expect(entry.finalViewport).toBe(entry.viewport);
      expect(entry.exited).toBe(true);
      expect(entry.stillRunning).toBe(false);
      expect(entry.observedError).toBe(scenario === 'body-error' ? 'Error: controlled body failure' : null);
    }
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 12_000);
