/**
 * #3628: a host that keeps the Stop hook's stdin open after writing its payload
 * held the hook for as long as the pipe stayed open (fs.readFileSync(0) waits
 * for EOF), well past the hook's 2 s budget and toward the host's 15 s RPC
 * window. The hook must return within its budget and still repair the timeline.
 *
 * Windows-safe by construction: the hook runs through Bun argv
 * (process.execPath), state lives under os.tmpdir().
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK_TS = path.join(ROOT, 'hosts', 'claude', 'hooks', 'timeline-stop-hook.ts');
const SLUG = 'stop-hook-stdin';
const BUDGET_MS = 2_000;
const STARTUP_ALLOWANCE_MS = process.platform === 'win32' ? 3_000 : 1_500;

let home = '', project = '', timeline = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-stdin-home-')));
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-stdin-proj-')));
  fs.mkdirSync(path.join(home, 'projects', SLUG), { recursive: true });
  timeline = path.join(home, 'projects', SLUG, 'timeline.jsonl');
  fs.writeFileSync(timeline, JSON.stringify({ skill: 'review', event: 'started', session: '1-1' }) + '\n');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

async function runHookHoldingStdin(payload: string | null): Promise<{ code: number | null; ms: number }> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, ...bunIsolationArgs(), HOOK_TS], {
    stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    env: { ...process.env, GSTACK_HOME: home, GSTACK_STATE_ROOT: home, GSTACK_PROJECT_SLUG: SLUG },
  });
  if (payload !== null) { child.stdin.write(payload); child.stdin.flush(); }
  const kill = setTimeout(() => child.kill(), 10_000);
  const code = await child.exited;
  clearTimeout(kill);
  const ms = performance.now() - started;
  try { child.stdin.end(); } catch { /* already closed */ }
  return { code, ms };
}

const repairs = () => fs.readFileSync(timeline, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.source === 'stop-hook');

test('a complete payload on a pipe that never closes: returns within budget and repairs (#3628)', async () => {
  const r = await runHookHoldingStdin(JSON.stringify({ hook_event_name: 'Stop', cwd: project }));
  expect(r.code).toBe(0);
  expect(r.ms).toBeLessThan(BUDGET_MS + STARTUP_ALLOWANCE_MS);
  expect(repairs()).toHaveLength(1);
}, 20_000);

test('an open pipe with no data: returns within budget (#3628)', async () => {
  const r = await runHookHoldingStdin(null);
  expect(r.code).toBe(0);
  expect(r.ms).toBeLessThan(BUDGET_MS + STARTUP_ALLOWANCE_MS);
}, 20_000);
