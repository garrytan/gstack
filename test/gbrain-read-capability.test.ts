import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(opts: { state?: unknown; pin?: string; registration?: unknown | ((repo: string) => unknown); slug?: string; list?: string; get?: unknown; fail?: string; gitExecutable?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-read-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(home); mkdirSync(bin);
  const init = spawnSync(opts.gitExecutable ?? 'git', ['init', '--quiet', repo], { timeout: 10_000 });
  if (init.status !== 0 || init.error) throw new Error('git init failed');
  const source = 'client-repo';
  const slug = opts.slug ?? 'code/repo/readme';
  writeFileSync(join(repo, '.gbrain-source'), `${opts.pin ?? source}\n`);
  mkdirSync(join(home, '.gstack'));
  writeFileSync(join(home, '.gstack', '.gbrain-sync-state.json'), JSON.stringify(opts.state ?? {
    schema_version: 1, last_writer: 'gstack-gbrain-sync', last_stages: [
      { name: 'code', ran: true, ok: true, detail: { status: 'ok', source_id: source, source_path: repo } },
    ],
  }, null, 2));
  const log = join(root, 'calls');
  const registration = typeof opts.registration === 'function' ? opts.registration(repo) : opts.registration;
  writeFileSync(join(bin, 'gbrain'), `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2).join(' ');
if (args === ${JSON.stringify(opts.fail)}) process.exit(2);
if (args === 'sources list --json') console.log(${JSON.stringify(JSON.stringify(registration ?? { sources: [{ id: source, local_path: repo }] }))});
else if (args === 'list --source client-repo --limit 1') console.log(${JSON.stringify(opts.list ?? `${slug}\tcode\t2026-09-24\tReadme`)});
else if (args === ${JSON.stringify(`get ${slug} --source client-repo --json`)}) console.log(${JSON.stringify(JSON.stringify(opts.get ?? { source_id: source, slug }))});
else process.exit(3);
`);
  chmodSync(join(bin, 'gbrain'), 0o755);
  const run = (cwd = repo, args: string[] = []) => {
    const result = spawnSync('bun', [join(import.meta.dir, '..', 'bin', 'gstack-gbrain-read-capability.ts'), ...args], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: home, GSTACK_HOME: join(home, '.gstack'), PATH: `${bin}:${process.env.PATH}` },
    });
    return { result, value: JSON.parse(result.stdout), calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
  };
  return { repo, root, run, log };
}

test('source-scoped read validates a pretty sync state, registration, and matching page', () => {
  const f = fixture();
  const result = f.run();
  expect(result.result.status).toBe(0);
  expect(result.value.status).toBe('ready');
  expect(result.calls).toEqual(['sources list --json', 'list --source client-repo --limit 1', 'get code/repo/readme --source client-repo --json']);
});

test('symlink-equivalent registered worktree passes but another source path fails closed', () => {
  const f = fixture();
  symlinkSync(f.repo, join(f.root, 'alias'));
  const statePath = join(f.root, 'home', '.gstack', '.gbrain-sync-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.last_stages[0].detail.source_path = join(f.root, 'alias');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const registration = { sources: [{ id: 'client-repo', local_path: join(f.root, 'alias') }] };
  const bin = join(f.root, 'bin', 'gbrain');
  writeFileSync(bin, readFileSync(bin, 'utf8').replace(JSON.stringify(JSON.stringify({ sources: [{ id: 'client-repo', local_path: f.repo }] })), JSON.stringify(JSON.stringify(registration))));
  expect(f.run().value.status).toBe('ready');
  writeFileSync(join(f.repo, '.gbrain-source'), 'other-source\n');
  const result = f.run();
  expect(result.value.status).toBe('unknown');
  expect(result.calls).toEqual(['sources list --json', 'list --source client-repo --limit 1', 'get code/repo/readme --source client-repo --json']);
});

test('rejects the former header-only and multi-row TSV response before get', () => {
  for (const list of [
    'slug\ttype\tdate\ttitle',
    'source_id\tslug\ttitle\nclient-repo\tcode/repo/readme\tReadme',
    'code/repo/readme\tcode\t2026-09-24\tReadme\ncode/repo/other\tcode\t2026-09-24\tOther',
  ]) {
    const result = fixture({ list }).run();
    expect(result.value.status).toBe('unknown');
    expect(result.calls).toEqual(['sources list --json', 'list --source client-repo --limit 1']);
  }
});

test('accepts native JSON metadata without requiring a content field', () => {
  const result = fixture().run();
  expect(result.value.status).toBe('ready');
  expect(result.calls).toHaveLength(3);
});

test('accepts a bounded literal-Unicode code slug', () => {
  const slug = 'code/路径/mañana🌳.ts';
  const result = fixture({ slug }).run();
  expect(result.value.status).toBe('ready');
  expect(result.calls.at(-1)).toBe(`get ${slug} --source client-repo --json`);
});

test.each(['--help', 'code/a/../b', 'code/./b', 'code/\u0007bad', 'a'.repeat(513)])('rejects unsafe slug %j before get', slug => {
  const result = fixture({ slug }).run();
  expect(result.value.status).toBe('unknown');
  expect(result.calls).toEqual(['sources list --json', 'list --source client-repo --limit 1']);
});

test('rejects a JSON error envelope with matching source and slug', () => {
  const result = fixture({ get: { source_id: 'client-repo', slug: 'code/repo/readme', content: '# Readme', error: { code: 'not_found' } } }).run();
  expect(result.value.status).toBe('unknown');
});

test('rejects a JSON array response', () => {
  const result = fixture({ get: [{ source_id: 'client-repo', slug: 'code/repo/readme' }] }).run();
  expect(result.value.status).toBe('unknown');
});

test('rejects a source-list error envelope before any page operation', () => {
  const result = fixture({ registration: repo => ({
    error: { code: 'partial_read' },
    sources: [{ id: 'client-repo', local_path: repo }],
  }) }).run();
  expect(result.value.status).toBe('unknown');
  expect(result.calls).toEqual(['sources list --json']);
});

test('source-only returns registration-bound count without reading a page', () => {
  const f = fixture({ registration: repo => ({ sources: [{ id: 'client-repo', local_path: repo, page_count: 7 }] }) });
  const result = f.run(undefined, ['--source-only']);
  expect(result.value).toMatchObject({ status: 'source', source_id: 'client-repo', page_count: 7 });
  expect(result.calls).toEqual(['sources list --json']);
});

test('source-only rejects a sibling registration even when its count is zero', () => {
  const f = fixture({ registration: repo => ({ sources: [{ id: 'client-repo', local_path: join(repo, '..'), page_count: 0 }] }) });
  const result = f.run(undefined, ['--source-only']);
  expect(result.value.status).toBe('unknown');
  expect(result.value.page_count).toBeUndefined();
  expect(result.calls).toEqual(['sources list --json']);
});

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0'])('source-only rejects an unsafe page count %j', count => {
  const result = fixture({ registration: repo => ({ sources: [{ id: 'client-repo', local_path: repo, page_count: count }] }) })
    .run(undefined, ['--source-only']);
  expect(result.value.status).toBe('unknown');
  expect(result.value.page_count).toBeUndefined();
  expect(result.calls).toEqual(['sources list --json']);
});

test('the test fixture bounds git init and rejects a failed init', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  expect(source).toMatch(/spawnSync\(opts\.gitExecutable \?\? 'git', \['init', '--quiet', repo\], \{[^}]*timeout: 10_000/);
  expect(source).toContain("if (init.status !== 0 || init.error) throw new Error('git init failed')");
  const root = mkdtempSync(join(tmpdir(), 'gbrain-failed-git-'));
  roots.push(root);
  const failingGit = join(root, 'git');
  writeFileSync(failingGit, '#!/bin/sh\nexit 27\n');
  chmodSync(failingGit, 0o755);
  expect(() => fixture({ gitExecutable: failingGit })).toThrow('git init failed');
});

test.each([
  { state: { schema_version: 1, last_writer: 'other', last_stages: [] } },
  { state: { schema_version: 1, last_writer: 'gstack-gbrain-sync', last_stages: [{ name: 'code', ran: false, ok: true }] } },
  { pin: 'wrong' },
  { registration: { sources: [{ id: 'client-repo', local_path: '/other' }] } },
  { list: 'slug\ttype\tdate\ttitle' },
  { list: 'code/repo/readme\tcode\t2026-09-24\tReadme\ncode/repo/second\tcode\t2026-09-24\tSecond' },
  { list: '' },
  { list: `${'a'.repeat(513)}\tcode\t2026-09-24\tToo long` },
  { get: { source_id: 'other', slug: 'code/repo/readme', content: '# Readme' } },
  { get: { source_id: 'client-repo', slug: 'wrong', content: '# Readme' } },
  { fail: 'list --source client-repo --limit 1' },
  { fail: 'get code/repo/readme --source client-repo --json' },
])('unverified or transient evidence is unknown, without mutation: %#', opts => {
  const f = fixture(opts);
  const result = f.run();
  expect(result.result.status).toBe(0);
  expect(result.value.status).toBe('unknown');
  expect(result.calls.every(call => /^(sources list --json|list --source client-repo --limit 1|get )/.test(call))).toBe(true);
});

test.each(['--no-code', '--dry-run', '--refresh-cache', '--audit'])('%s skips the probe without querying gbrain', mode => {
  const result = fixture().run(undefined, [mode]);
  expect(result.result.status).toBe(0);
  expect(result.value.status).toBe('skipped');
  expect(result.calls).toEqual([]);
});
