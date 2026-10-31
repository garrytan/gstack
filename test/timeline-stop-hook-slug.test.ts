/**
 * Timeline Stop hook slug resolution (#3103).
 *
 * Through Git Bash on Windows, gstack-slug took 2.2-2.8 s, past the hook's 2 s
 * budget, so the synchronous spawn timed out on every Stop and nothing was
 * repaired. The hook now reads gstack-slug's versioned cache in-process and,
 * on a miss, hands the slow resolve to a detached child under a TTL lock with
 * a per-cwd negative cache.
 *
 * Fixture: a copy of the hook and its imports in a temp tree whose
 * bin/gstack-slug is a stub (runBin resolves bin/ from the hook's own
 * location). The stub logs each call, sleeps, then prints a slug or fails.
 * The hook runs through Bun argv, never as a shebang.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { slugCacheFile } from '../lib/bin-context';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK_FILES = [
  'hosts/claude/hooks/timeline-stop-hook.ts',
  'hosts/claude/hooks/spawn-bin.ts',
  'hosts/claude/hooks/hook-log.ts',
  'lib/state-root.ts',
  'lib/bin-context.ts',
  'lib/remote-identity.ts',
  'lib/script-invocation.ts',
  'lib/bun-isolation.ts',
  'lib/result-codes.ts',
  'lib/result-codes-release.ts',
  'lib/result-codes-capy.ts',
  'lib/result-codes-budget.ts',
  'lib/result-codes-eval.ts',
];
const SLUG = 'stop-hook-slug-test';
const BUDGET_MS = 2000;

let tmp: string;
let tree: string;
let stateRoot: string;
let projectDir: string;
let callLog: string;

function writeStub(body: string): void {
  const stub = path.join(tree, 'bin', 'gstack-slug');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$PWD" >> ${JSON.stringify(callLog)}\n${body}\n`, { mode: 0o755 });
}

function seedTimeline(): string {
  const file = path.join(stateRoot, 'projects', SLUG, 'timeline.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ skill: 'review', event: 'started', session: '11-1' }) + '\n');
  return file;
}

function repairs(file: string): number {
  return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('"source":"stop-hook"')).length;
}

function runHook(): { status: number | null; ms: number } {
  const env: Record<string, string | undefined> = { ...process.env, GSTACK_STATE_ROOT: stateRoot };
  delete env.GSTACK_PROJECT_SLUG;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(tree, 'hosts', 'claude', 'hooks', 'timeline-stop-hook.ts')], {
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: projectDir }),
    env,
    timeout: 15_000,
  });
  return { status: r.status, ms: Date.now() - t0 };
}

function calls(): number {
  return fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8').split('\n').filter(Boolean).length : 0;
}

const lockFile = () => path.join(stateRoot, 'timeline-stop-hook', 'repair.lock');

async function until(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met before timeout');
    await Bun.sleep(100);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-slug-'));
  tree = path.join(tmp, 'tree');
  stateRoot = path.join(tmp, 'state');
  projectDir = path.join(tmp, 'project');
  callLog = path.join(tmp, 'slug-calls.log');
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(projectDir);
  for (const rel of HOOK_FILES) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tree, rel));
  }
});

afterEach(async () => {
  await until(() => !fs.existsSync(lockFile())).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('timeline-stop-hook slug resolution (#3103)', () => {
  test('cache hit: repairs in the foreground without spawning gstack-slug', () => {
    writeStub('exit 1');
    const timeline = seedTimeline();
    const cache = slugCacheFile(stateRoot, projectDir);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, `v2:${SLUG}`);

    expect(runHook().status).toBe(0);
    expect(repairs(timeline)).toBe(1);
    expect(calls()).toBe(0);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  test('cache miss with a slow gstack-slug: the hook returns within its budget and a background child repairs', async () => {
    writeStub(`sleep 3\necho "SLUG=${SLUG}"\necho "BRANCH=main"`);
    const timeline = seedTimeline();

    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expect(repairs(timeline)).toBe(0);

    await until(() => repairs(timeline) === 1);
    await until(() => !fs.existsSync(lockFile()));
    expect(calls()).toBe(1);
    expect(repairs(timeline)).toBe(1);
  }, 30_000);

  test('negative cache: a directory gstack-slug cannot resolve spawns one child, not one per turn', async () => {
    writeStub('exit 1');
    seedTimeline();

    expect(runHook().status).toBe(0);
    await until(() => calls() === 1 && !fs.existsSync(lockFile()));
    expect(fs.readFileSync(path.join(stateRoot, 'hook-errors.log'), 'utf-8')).toContain('could not resolve project slug');

    expect(runHook().status).toBe(0);
    expect(runHook().status).toBe(0);
    await Bun.sleep(1000);
    expect(calls()).toBe(1);
  }, 30_000);

  test('a fresh lock defers the repair; a lock past its TTL is taken over', () => {
    writeStub('exit 1');
    const timeline = seedTimeline();
    const cache = slugCacheFile(stateRoot, projectDir);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, `v2:${SLUG}`);
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), '999999\n');

    expect(runHook().status).toBe(0);
    expect(repairs(timeline)).toBe(0);

    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile(), old, old);
    expect(runHook().status).toBe(0);
    expect(repairs(timeline)).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});
