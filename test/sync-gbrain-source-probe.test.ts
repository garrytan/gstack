import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const skill = readFileSync(join(ROOT, 'sync-gbrain/SKILL.md'), 'utf8');
function shellStep(title: string): string {
  const start = skill.indexOf(title);
  if (start < 0) throw new Error(`${title} missing from generated skill`);
  const block = /```bash\n([\s\S]*?)\n```/.exec(skill.slice(start));
  if (!block) throw new Error(`${title} has no bash fence`);
  return block[1].replaceAll('~/.claude/skills/gstack/bin/gstack-gbrain-read-capability.ts', join(ROOT, 'bin/gstack-gbrain-read-capability.ts'));
}

function fixture(pin = 'client-fixture', opts: { pageCount?: number; cycleStatus?: string; cycleMessage?: string; sourceError?: boolean; wrongRegistration?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-step3-'));
  const repo = join(root, 'repo'), home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(home); mkdirSync(bin); mkdirSync(join(home, '.gstack'));
  if (opts.wrongRegistration) mkdirSync(join(root, 'sibling'));
  const init = spawnSync('git', ['init', '--quiet', repo], { timeout: 10_000 });
  if (init.status !== 0) throw new Error('git init failed');
  writeFileSync(join(repo, '.gbrain-source'), `${pin}\n`);
  writeFileSync(join(home, '.gstack', '.gbrain-sync-state.json'), JSON.stringify({
    schema_version: 1, last_writer: 'gstack-gbrain-sync', last_stages: [{
      name: 'code', ran: true, ok: true, detail: { status: 'ok', source_id: 'client-fixture', source_path: repo },
    }],
  }, null, 2));
  const log = join(root, 'calls');
  writeFileSync(join(bin, 'gbrain'), `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
appendFileSync(${JSON.stringify(log)}, args + '\\n');
if (args === 'sources list --json') console.log(${JSON.stringify(JSON.stringify({
    ...(opts.sourceError ? { error: { code: 'partial_read' } } : {}),
    sources: [{ id: 'client-fixture', local_path: opts.wrongRegistration ? join(root, 'sibling') : repo, page_count: opts.pageCount ?? 7 }],
  }))});
else if (args === 'doctor --json --fast') console.log(${JSON.stringify(JSON.stringify({ checks: [{
    name: 'cycle_freshness', status: opts.cycleStatus ?? 'warn', message: opts.cycleMessage ?? 'never cycled client-fixture',
  }] }))});
else process.exit(2);
`);
  chmodSync(join(bin, 'gbrain'), 0o755);
  const run = (title: string) => spawnSync('bash', ['-c', shellStep(title)], {
    cwd: repo, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, GSTACK_HOME: join(home, '.gstack'), PATH: `${bin}:${process.env.PATH}` },
  });
  return { run, calls: () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('actual generated Step 3/3.5 shell reads a pretty state and probes the pinned source', () => {
  const f = fixture();
  try {
    const pages = f.run('## Step 3: Code-index health check');
    const cycle = f.run('## Step 3.5: Call-graph health check');
    expect(pages.status, pages.stderr).toBe(0);
    expect(cycle.status, cycle.stderr).toBe(0);
    expect(pages.stdout).toContain('cwd source: client-fixture, page_count: 7');
    expect(cycle.stdout).toContain('call graph for client-fixture: never');
    expect(f.calls()).toEqual(['sources list --json', 'sources list --json', 'doctor --json --fast']);
  } finally { f.cleanup(); }
});

test('unverified pin never queries another source or reports zero pages', () => {
  const f = fixture('other-source');
  try {
    const pages = f.run('## Step 3: Code-index health check');
    const cycle = f.run('## Step 3.5: Call-graph health check');
    expect(pages.status, pages.stderr).toBe(0);
    expect(cycle.status, cycle.stderr).toBe(0);
    expect(pages.stdout).not.toContain('page_count: 0');
    expect(cycle.stdout).toContain('unknown');
    expect(f.calls()).toEqual([]);
  } finally { f.cleanup(); }
});

test('verified zero pages and completed cycle retain their existing meanings', () => {
  const f = fixture('client-fixture', { pageCount: 0, cycleStatus: 'ok' });
  try {
    expect(f.run('## Step 3: Code-index health check').stdout).toContain('page_count: 0');
    expect(f.run('## Step 3.5: Call-graph health check').stdout).toContain('call graph for client-fixture: completed');
  } finally { f.cleanup(); }
});

test('source-list error and another source cycle never masquerade as zero or never', () => {
  const f = fixture('client-fixture', { sourceError: true, cycleMessage: 'never cycled other-source' });
  try {
    expect(f.run('## Step 3: Code-index health check').stdout).toContain('page_count: \n');
    expect(f.run('## Step 3.5: Call-graph health check').stdout).toContain('call graph for : unknown');
    expect(f.calls()).toEqual(['sources list --json', 'sources list --json']);
  } finally { f.cleanup(); }
});

test('sibling registration with zero pages is unknown, not a reindex offer', () => {
  const f = fixture('client-fixture', { pageCount: 0, wrongRegistration: true });
  try {
    const pages = f.run('## Step 3: Code-index health check');
    const cycle = f.run('## Step 3.5: Call-graph health check');
    expect(pages.status, pages.stderr).toBe(0);
    expect(cycle.status, cycle.stderr).toBe(0);
    expect(pages.stdout).toContain('page_count: \n');
    expect(pages.stdout).not.toContain('page_count: 0');
    expect(cycle.stdout).toContain('call graph for : unknown');
    expect(f.calls()).toEqual(['sources list --json', 'sources list --json']);
  } finally { f.cleanup(); }
});
