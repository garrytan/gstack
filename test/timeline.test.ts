import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync, execSync, spawnSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveProjectIdentity } from '../lib/project-identity';
import { createInstalledAuthorityFixture } from './helpers/installed-authority';

const ROOT = path.resolve(import.meta.dir, '..');
let installed: ReturnType<typeof createInstalledAuthorityFixture>;
let BIN: string;

let tmpDir: string;
let slugDir: string;

beforeAll(() => {
  const build = spawnSync(process.execPath, ['run', 'scripts/build-authority-bundles.ts'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 30_000,
  });
  expect(build.status).toBe(0);
  installed = createInstalledAuthorityFixture(ROOT);
  BIN = installed.bin;
});

afterAll(() => installed?.cleanup());

function runLog(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-timeline-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stderr?.toString() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

function runRead(args: string = '', cwd: string = ROOT): string {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    return execSync(`${BIN}/gstack-timeline-read ${args}`, execOpts).trim();
  } catch {
    return '';
  }
}

function runReadArgs(args: string[] = []): string {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    return execFileSync(path.join(BIN, 'gstack-timeline-read'), args, execOpts).trim(); // timeout via execOpts
  } catch {
    return '';
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-timeline-'));
  slugDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(slugDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function findTimelineFile(): string | null {
  const projectDirs = fs.readdirSync(slugDir);
  if (projectDirs.length === 0) return null;
  const f = path.join(slugDir, projectDirs[0], 'timeline.jsonl');
  return fs.existsSync(f) ? f : null;
}

describe('gstack-timeline-log', () => {
  test('accepts canonical percent-encoded project slugs and rejects malformed or traversal slugs', () => {
    const observer = path.join(BIN, 'gstack-ecpe-observe');
    const input = JSON.stringify({ skill: 'review', event: 'started', branch: 'main' });
    const invoke = (slug: string) => spawnSync(observer, ['timeline-log', input], {
      cwd: ROOT,
      env: { ...process.env, GSTACK_HOME: tmpDir, GSTACK_PROJECT_SLUG: slug },
      encoding: 'utf8',
      timeout: 15_000,
    });

    for (const slug of ['fixture%2Dproject', 'fixture%25project', 'caf%C3%A9']) {
      const canonical = invoke(slug);
      expect(canonical.status).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'projects', slug, 'timeline.jsonl'))).toBe(true);
    }

    for (const invalid of ['fixture%2Gproject', 'fixture%2dproject', 'fixture%41project', 'fixture%2Fproject', '../escape']) {
      const rejected = invoke(invalid);
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain('project_identity_unavailable');
    }
  });

  test('uses a canonical percent-encoded project slug across lifecycle state and observations', () => {
    const observer = path.join(BIN, 'gstack-ecpe-observe');
    const slug = 'fixture%2Dproject';
    const started = spawnSync(observer, [
      'lifecycle-start', '--skill', 'review', '--run-id', 'run-encoded-slug',
      '--branch', 'main', '--slug', slug,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        GSTACK_HOME: tmpDir,
        GSTACK_PROJECT_SLUG: slug,
        ECPE_TESTING: '1',
        ECPE_TEST_STATE_ROOT: tmpDir,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(started.status).toBe(0);
    const timeline = path.join(tmpDir, 'projects', slug, 'timeline.jsonl');
    const row = JSON.parse(fs.readFileSync(timeline, 'utf8').trim());
    expect(row.ecpe.wtree).toBe(slug);
    expect(fs.existsSync(path.join(tmpDir, 'ecpe', 'record-inventory', `${slug}.json`))).toBe(true);
  });

  test('accepts valid JSON and appends to timeline.jsonl', () => {
    const input = '{"skill":"review","event":"started","branch":"main"}';
    const result = runLog(input);
    expect(result.exitCode).toBe(0);

    const f = findTimelineFile();
    expect(f).not.toBeNull();
    const content = fs.readFileSync(f!, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.skill).toBe('review');
    expect(parsed.event).toBe('started');
    expect(parsed.branch).toBe('main');
  });

  test('rejects invalid JSON with exit 0 (non-blocking)', () => {
    const result = runLog('not json at all');
    expect(result.exitCode).toBe(0);

    // No file should be created
    const f = findTimelineFile();
    expect(f).toBeNull();
  });

  test('injects timestamp when ts field is missing', () => {
    const input = '{"skill":"review","event":"started","branch":"main"}';
    runLog(input);

    const f = findTimelineFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.ts).toBeDefined();
    expect(new Date(parsed.ts).getTime()).toBeGreaterThan(0);
  });

  test('preserves timestamp when ts field is present', () => {
    const input = '{"skill":"review","event":"completed","branch":"main","ts":"2025-06-15T10:00:00Z"}';
    runLog(input);

    const f = findTimelineFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.ts).toBe('2025-06-15T10:00:00Z');
  });

  test('stamps canonical repository and raw branch identity on every new write', () => {
    runLog('{"skill":"review","event":"started"}');
    const identity = resolveProjectIdentity(ROOT);
    const parsed = JSON.parse(fs.readFileSync(findTimelineFile()!, 'utf-8').trim());
    expect(parsed.repo_id).toBe(identity.repo_id);
    expect(parsed.branch_ref).toBe(identity.raw_branch);
  });

  test('validates required fields (skill, event) - exits 0 if missing skill', () => {
    const result = runLog('{"event":"started","branch":"main"}');
    expect(result.exitCode).toBe(0);

    const f = findTimelineFile();
    expect(f).toBeNull();
  });

  test('validates required fields (skill, event) - exits 0 if missing event', () => {
    const result = runLog('{"skill":"review","branch":"main"}');
    expect(result.exitCode).toBe(0);

    const f = findTimelineFile();
    expect(f).toBeNull();
  });

  test('rejects ECPE events containing content-bearing keys without blocking legacy telemetry', () => {
    const result = runLog(JSON.stringify({
      skill: 'review',
      event: 'observation',
      ecpe: {
        schema_version: 1,
        run_id: 'run-1',
        timestamp: '2026-08-31T00:00:00.000Z',
        wtree: 'repo-1',
        kind: 'decision',
        work_kind: 'review',
        finish_line: 'review_receipt',
        semantic_roles: ['code'],
        prompt: 'must never enter the timeline',
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(findTimelineFile()).toBeNull();
  });

  test('rejects caller-forged canary-control observations', () => {
    runLog(JSON.stringify({
      skill: 'review',
      event: 'observation',
      ecpe: {
        schema_version: 1,
        run_id: 'run-control',
        timestamp: '2026-08-31T00:00:00.000Z',
        wtree: 'repo-1',
        kind: 'decision',
        execution_purpose: 'canary_control',
        work_kind: 'review',
        finish_line: 'review_receipt',
        capability_ids: ['review.complete'],
      },
    }));

    expect(findTimelineFile()).toBeNull();
  });
});

describe('gstack-timeline-read', () => {
  test('returns empty output for missing file (exit 0)', () => {
    const output = runRead();
    expect(output).toBe('');
  });

  test('filters by --branch', () => {
    runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'feature-a', outcome: 'approved', ts: '2026-03-28T10:00:00Z' }));
    runLog(JSON.stringify({ skill: 'ship', event: 'completed', branch: 'feature-b', outcome: 'merged', ts: '2026-03-28T11:00:00Z' }));

    const output = runRead('--branch feature-a');
    expect(output).toContain('review');
    expect(output).not.toContain('feature-b');
  });

  test('filters branch names containing single quotes', () => {
    runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: "feature/o'hare", outcome: 'approved', ts: '2026-03-28T10:00:00Z' }));
    runLog(JSON.stringify({ skill: 'ship', event: 'completed', branch: 'feature-other', outcome: 'merged', ts: '2026-03-28T11:00:00Z' }));

    const output = runReadArgs(['--branch', "feature/o'hare"]);

    expect(output).toContain('review');
    expect(output).toContain("feature/o'hare");
    expect(output).not.toContain('feature-other');
  });

  test('limits output with --limit', () => {
    for (let i = 0; i < 5; i++) {
      runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', outcome: 'approved', ts: `2026-03-2${i}T10:00:00Z` }));
    }

    const unlimited = runRead('--limit 20');
    const limited = runRead('--limit 2');

    // Count event lines (lines starting with "- ")
    const unlimitedEvents = unlimited.split('\n').filter(l => l.startsWith('- ')).length;
    const limitedEvents = limited.split('\n').filter(l => l.startsWith('- ')).length;

    expect(unlimitedEvents).toBe(5);
    expect(limitedEvents).toBe(2);
  });

  test('keeps distinct events from one run while deduplicating copies across explicit legacy paths', () => {
    const fixtureRepo = path.join(tmpDir, 'fixture-repo');
    fs.mkdirSync(path.join(fixtureRepo, 'config'), { recursive: true });
    execFileSync('/usr/bin/git', ['init', '-q'], { timeout: 30_000, cwd: fixtureRepo });
    fs.writeFileSync(path.join(fixtureRepo, 'README.md'), 'fixture\n');
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { timeout: 30_000, cwd: fixtureRepo });
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { timeout: 30_000, cwd: fixtureRepo });
    fs.writeFileSync(path.join(fixtureRepo, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "fixture-project"
path = "."
kind = "repository"
remote_required = false
active = true
aliases = ["legacy-project"]
`);
    const identity = resolveProjectIdentity(fixtureRepo);
    const canonical = path.join(tmpDir, 'projects', identity.write_slug, 'timeline.jsonl');
    const legacySlug = identity.read_slugs.find((slug) => slug !== identity.write_slug)!;
    const legacy = path.join(tmpDir, 'projects', legacySlug, 'timeline.jsonl');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const started = { skill: 'review', event: 'started', run_id: 'same-run', repo_id: identity.repo_id, ts: '2026-03-28T10:00:00Z' };
    const completed = { skill: 'review', event: 'completed', run_id: 'same-run', repo_id: identity.repo_id, ts: '2026-03-28T10:01:00Z' };
    fs.writeFileSync(canonical, `${JSON.stringify(started)}\n${JSON.stringify(completed)}\n`);
    fs.writeFileSync(legacy, `${JSON.stringify(started)}\n${JSON.stringify(completed)}\n${JSON.stringify({ skill: 'ship', event: 'completed', repo_id: 'wrong/repository', ts: '2026-03-28T10:02:00Z' })}\n`);

    const output = runRead('', fixtureRepo);
    expect(output).toContain('1 /review');
    expect(output.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    expect(output).not.toContain('/ship');
  });

  test('--ecpe-json returns validated run summaries while ignoring legacy events', () => {
    runLog(JSON.stringify({ skill: 'review', event: 'started', branch: 'main' }));
    runLog(JSON.stringify({
      skill: 'review',
      event: 'observation',
      ecpe: {
        schema_version: 1,
        run_id: 'run-json',
        timestamp: '2026-08-31T00:00:00.000Z',
        wtree: 'repo-1',
        kind: 'decision',
        work_kind: 'review',
        finish_line: 'review_receipt',
        semantic_roles: ['code'],
        capability_ids: ['review.complete'],
      },
    }));

    const parsed = JSON.parse(runReadArgs(['--ecpe-json']));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]).toMatchObject({
      run_id: 'run-json',
      wtree: 'repo-1',
      semantic_roles: ['code'],
      capabilities: ['review.complete'],
    });
  });
});
