/**
 * Which session a CLI call sends (#1961): precedence, the off switch, and the
 * agent-harness walk that gives each agent its own session across fresh
 * shells. The live case runs a real process named "claude" on Linux.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { autoSessionName, chooseSession, extractSession, harnessOf, type ProcLookup } from '../src/session-name';

const table = (rows: Record<number, [number, string]>): ProcLookup => (pid) => {
  const row = rows[pid];
  return row ? { ppid: row[0], comm: row[1] } : null;
};
// 400 bash -> 300 sh -> 200 <harness> -> 1
const under = (harness: string) => table({ 400: [300, 'bash'], 300: [200, 'sh'], 200: [1, harness] });

describe('extractSession', () => {
  test('strips --session and its value anywhere in args', () => {
    expect(extractSession(['https://x', '--session', 'a1', '--json'])).toEqual({ session: 'a1', args: ['https://x', '--json'] });
    expect(extractSession(['text'])).toEqual({ session: undefined, args: ['text'] });
  });
});

describe('harness walk', () => {
  test('skips shells to the first other ancestor', () => {
    expect(harnessOf(400, under('claude'))).toEqual({ pid: 200, comm: 'claude' });
  });
  test('a known agent harness names the session by its pid', () => {
    for (const h of ['claude', 'codex', 'cursor-agent']) expect(autoSessionName({}, 400, under(h))).toBe('agent-200');
  });
  test('node counts only with CLAUDECODE=1', () => {
    expect(autoSessionName({}, 400, under('node'))).toBeUndefined();
    expect(autoSessionName({ CLAUDECODE: '1' }, 400, under('node'))).toBe('agent-200');
  });
  test('a human terminal and a shared harness get no session', () => {
    expect(autoSessionName({}, 400, under('tmux: server'))).toBeUndefined();
    expect(autoSessionName({ CLAUDECODE: '1' }, 400, under('capy-server'))).toBeUndefined();
    expect(autoSessionName({}, 400, () => null)).toBeUndefined();
  });
});

describe('chooseSession precedence', () => {
  const base = { hasTab: false, flag: undefined, env: {}, parentPid: 400, lookup: under('claude') };
  test('an explicit tab wins and sends no session', () => {
    expect(chooseSession({ ...base, hasTab: true, flag: 'a' })).toEqual({});
  });
  test('--session beats BROWSE_SESSION, which beats the harness', () => {
    expect(chooseSession({ ...base, flag: 'f', env: { BROWSE_SESSION: 'e' } })).toEqual({ session: 'f' });
    expect(chooseSession({ ...base, env: { BROWSE_SESSION: 'e' } })).toEqual({ session: 'e' });
    expect(chooseSession(base)).toEqual({ session: 'agent-200', auto: true });
  });
  test('empty or off turns sessions off', () => {
    expect(chooseSession({ ...base, env: { BROWSE_SESSION: '' } })).toEqual({});
    expect(chooseSession({ ...base, env: { BROWSE_SESSION: 'off' } })).toEqual({});
    expect(chooseSession({ ...base, flag: 'off' })).toEqual({});
  });
});

describe.if(process.platform === 'linux')('live /proc walk', () => {
  test('two fresh shells under one "claude" process get the same session, named by its pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-name-'));
    try {
      const claude = path.join(dir, 'claude');
      fs.copyFileSync('/bin/bash', claude);
      fs.chmodSync(claude, 0o755);
      const probe = `${JSON.stringify(process.execPath)} -e 'import("${path.resolve(import.meta.dir, '../src/session-name.ts')}").then(m => console.log(m.autoSessionName({}, process.ppid, m.systemProcLookup())))'`;
      const r = spawnSync(claude, ['-c', `echo HARNESS=$$; bash -c '${probe.replace(/'/g, `'\\''`)}'; sh -c '${probe.replace(/'/g, `'\\''`)}'; true`], { encoding: 'utf8', timeout: 30_000 });
      const harness = r.stdout.match(/HARNESS=(\d+)/)?.[1];
      const names = r.stdout.split('\n').filter(l => l.startsWith('agent-'));
      expect(harness).toBeDefined();
      expect(names).toEqual([`agent-${harness}`, `agent-${harness}`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sidebar terminal agent', () => {
  test('its claude keeps the user\'s tab: the spawn env turns the automatic session off', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, '../src/terminal-agent.ts'), 'utf8');
    const start = source.indexOf('function spawnClaude');
    const spawnEnv = source.slice(start, source.indexOf('--append-system-prompt', start));
    expect(spawnEnv).toContain("BROWSE_SESSION: '',");
    const lookup: ProcLookup = () => ({ ppid: 0, comm: 'claude' });
    expect(chooseSession({ hasTab: false, flag: undefined, env: { BROWSE_SESSION: '' }, parentPid: 7, lookup })).toEqual({});
  });
});

describe('CLI retry after a token change', () => {
  test('the retried request keeps the --session the caller named', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-session-retry-'));
    try {
      const stateFile = path.join(dir, 'browse.json');
      fs.writeFileSync(stateFile, JSON.stringify({ port: 9, token: 'fresh-token' }));
      const script = path.join(dir, 'retry.ts');
      fs.writeFileSync(script, `
        const bodies = [];
        globalThis.fetch = async (_url, init) => {
          bodies.push(JSON.parse(init.body));
          return bodies.length === 1 ? new Response('Unauthorized', { status: 401 }) : new Response('ok');
        };
        const { sendCommand } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/cli.ts'))});
        await sendCommand({ port: 9, token: 'stale-token' }, 'click', ['#delete', '--session', 'intended']);
        console.log('BODIES=' + JSON.stringify(bodies));
      `);
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, BROWSE_STATE_FILE: stateFile, BROWSE_SESSION: '' } });
      const bodies = JSON.parse(r.stdout.match(/BODIES=(.*)/)?.[1] ?? '[]');
      expect(bodies).toHaveLength(2);
      for (const body of bodies) expect(body).toMatchObject({ command: 'click', args: ['#delete'], session: 'intended' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gstack-render browse calls', () => {
  test('turn the automatic session off: render pins its own tab ids', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, '../../lib/aside-render.ts'), 'utf8');
    expect(source).toContain("const browseEnv = { ...process.env, BROWSE_SESSION: '' };");
    const calls = source.match(/runProc\(bin,[^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).toContain('browseEnv');
  });
});
