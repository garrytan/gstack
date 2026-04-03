import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const SLUG = execSync(`${path.join(ROOT, 'bin', 'gstack-slug')}`, { cwd: ROOT, encoding: 'utf-8' })
  .trim().split('\n')[0].replace('SLUG=', '');

let tmpDir: string;

function run(cmd: string, opts: { expectFail?: boolean } = {}): { stdout: string; stderr: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir, GSTACK_STATE_DIR: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(cmd, execOpts).trim();
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stdout?.toString().trim() || '', stderr: e.stderr?.toString().trim() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

function runGroup(args: string, opts: { expectFail?: boolean } = {}) {
  return run(`${BIN}/gstack-group ${args}`, opts);
}

function runSearch(args: string = '') {
  return run(`${BIN}/gstack-learnings-search ${args}`);
}

function runLog(input: string) {
  return run(`${BIN}/gstack-learnings-log '${input.replace(/'/g, "'\\''")}'`);
}

function writeGroupsJson(data: object) {
  fs.writeFileSync(path.join(tmpDir, 'groups.json'), JSON.stringify(data, null, 2));
}

function readGroupsJson(): any {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'groups.json'), 'utf-8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-groups-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-group create', () => {
  test('creates a group in groups.json', () => {
    runGroup('create Work');
    const data = readGroupsJson();
    expect(data.groups.Work).toBeDefined();
    expect(data.groups.Work.created).toBeDefined();
    expect(data.groups.Personal).toBeDefined(); // Default from migration
  });

  test('idempotent: creating existing group is a no-op', () => {
    runGroup('create Work');
    const data1 = readGroupsJson();
    runGroup('create Work');
    const data2 = readGroupsJson();
    expect(data2.groups.Work.created).toBe(data1.groups.Work.created);
  });

  test('rejects invalid group names', () => {
    const result = runGroup('create "bad name!"', { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  test('accepts valid names with dots and hyphens', () => {
    runGroup('create my-team.v2');
    const data = readGroupsJson();
    expect(data.groups['my-team.v2']).toBeDefined();
  });
});

describe('gstack-group list', () => {
  test('shows groups and members', () => {
    runGroup('create Work');
    runGroup('assign Work');
    const result = runGroup('list');
    expect(result.stdout).toContain('Work');
    expect(result.stdout).toContain('1 project');
  });

  test('--json returns valid JSON', () => {
    runGroup('create Work');
    const result = runGroup('list --json');
    const data = JSON.parse(result.stdout);
    expect(data.groups).toBeDefined();
    expect(data.projects).toBeDefined();
  });

  test('empty groups show 0 projects', () => {
    runGroup('create EmptyGroup');
    const result = runGroup('list');
    expect(result.stdout).toContain('EmptyGroup (0 projects)');
  });
});

describe('gstack-group assign', () => {
  test('assigns current project to a group', () => {
    runGroup('create Work');
    runGroup('assign Work');
    const data = readGroupsJson();
    const slug = Object.keys(data.projects)[0];
    expect(data.projects[slug]).toBe('Work');
  });

  test('reassigns project to different group', () => {
    runGroup('create Work');
    runGroup('create Personal2');
    runGroup('assign Work');
    runGroup('assign Personal2');
    const data = readGroupsJson();
    const slug = Object.keys(data.projects).find(k => data.projects[k] === 'Personal2');
    expect(slug).toBeDefined();
  });

  test('rejects assignment to nonexistent group', () => {
    runGroup('which'); // trigger migration
    const result = runGroup('assign NoSuchGroup', { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });
});

describe('gstack-group which', () => {
  test('returns group name when assigned', () => {
    runGroup('create Work');
    runGroup('assign Work');
    const result = runGroup('which');
    expect(result.stdout).toBe('Work');
  });

  test('returns NO_GROUP when unassigned', () => {
    runGroup('which'); // triggers migration, but current project has no learnings
    const result = runGroup('which');
    expect(result.stdout).toBe('NO_GROUP');
  });
});

describe('gstack-group suggest', () => {
  test('returns groups sorted by owner match', () => {
    runGroup('create Work');
    runGroup('create Personal');
    // Add a project with matching owner prefix to Work
    const owner = SLUG.split('-')[0]; // e.g., "Madrox" from "Madrox-gstack"
    const data = readGroupsJson();
    data.projects[`${owner}-other`] = 'Work';
    writeGroupsJson(data);
    const result = runGroup('suggest');
    // Work should appear first because it has a member with matching owner
    const lines = result.stdout.split('\n');
    expect(lines[0]).toContain('Work');
    expect(lines[0]).toContain('matches owner');
  });
});

describe('migration', () => {
  test('creates groups.json with Personal group on first access', () => {
    runGroup('which');
    expect(fs.existsSync(path.join(tmpDir, 'groups.json'))).toBe(true);
    const data = readGroupsJson();
    expect(data.groups.Personal).toBeDefined();
  });

  test('cross_project=true: assigns all projects to Personal', () => {
    // Set up config
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'cross_project_learnings: true\n');
    // Create some project learnings
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo1'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo2'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo1', 'learnings.jsonl'), '{"key":"k","type":"pattern","insight":"i"}\n');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo2', 'learnings.jsonl'), '{"key":"k2","type":"pattern","insight":"i2"}\n');

    runGroup('which'); // triggers migration
    const data = readGroupsJson();
    expect(data.projects['org-repo1']).toBe('Personal');
    expect(data.projects['org-repo2']).toBe('Personal');
  });

  test('cross_project=false: each project gets solo group', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'cross_project_learnings: false\n');
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo1'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo2'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo1', 'learnings.jsonl'), '{"key":"k","type":"pattern","insight":"i"}\n');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo2', 'learnings.jsonl'), '{"key":"k2","type":"pattern","insight":"i2"}\n');

    runGroup('which');
    const data = readGroupsJson();
    expect(data.projects['org-repo1']).toBe('org-repo1');
    expect(data.projects['org-repo2']).toBe('org-repo2');
    expect(data.groups['org-repo1']).toBeDefined();
    expect(data.groups['org-repo2']).toBeDefined();
  });

  test('unset cross_project: same as false (solo groups)', () => {
    // No config file at all
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo1', 'learnings.jsonl'), '{"key":"k","type":"pattern","insight":"i"}\n');

    runGroup('which');
    const data = readGroupsJson();
    expect(data.projects['org-repo1']).toBe('org-repo1');
  });

  test('migration on brand-new machine (no projects dir)', () => {
    // tmpDir exists but no projects subdirectory
    runGroup('which');
    const data = readGroupsJson();
    expect(data.groups.Personal).toBeDefined();
    expect(Object.keys(data.projects)).toHaveLength(0);
  });

  test('migration with empty project dirs (no learnings.jsonl)', () => {
    fs.mkdirSync(path.join(tmpDir, 'projects', 'empty-project'), { recursive: true });
    // No learnings.jsonl inside
    runGroup('which');
    const data = readGroupsJson();
    // Empty project should NOT be in groups (no learnings to migrate)
    expect(data.projects['empty-project']).toBeUndefined();
  });

  test('migration runs exactly once (idempotent)', () => {
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo1', 'learnings.jsonl'), '{"key":"k","type":"pattern","insight":"i"}\n');

    runGroup('which'); // first run
    const data1 = readGroupsJson();

    // Add another project AFTER migration
    fs.mkdirSync(path.join(tmpDir, 'projects', 'org-repo2'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'org-repo2', 'learnings.jsonl'), '{"key":"k2","type":"pattern","insight":"i2"}\n');

    runGroup('which'); // second run — should NOT re-migrate
    const data2 = readGroupsJson();
    // org-repo2 should NOT be in groups (migration already ran)
    expect(data2.projects['org-repo2']).toBeUndefined();
  });

  test('config migration: true -> learning_scope global', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'cross_project_learnings: true\n');
    runGroup('which');
    const scope = run(`${BIN}/gstack-config get learning_scope`);
    expect(scope.stdout).toBe('global');
  });

  test('config migration: unset -> learning_scope group', () => {
    runGroup('which');
    const scope = run(`${BIN}/gstack-config get learning_scope`);
    expect(scope.stdout).toBe('group');
  });
});

describe('gstack-learnings-search --scope group', () => {
  test('returns learnings from all projects in same group', () => {
    // Set up two projects in same group
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'other-repo'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'local-pattern', type: 'pattern', insight: 'from local', confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'other-repo', 'learnings.jsonl'),
      JSON.stringify({ key: 'remote-pattern', type: 'pattern', insight: 'from remote', confidence: 7, source: 'observed', ts: '2026-03-29T00:00:00Z' }) + '\n');

    writeGroupsJson({
      groups: { Work: { created: '2026-03-30T00:00:00Z' } },
      projects: { [slug]: 'Work', 'other-repo': 'Work' }
    });

    const result = runSearch('--scope group');
    expect(result.stdout).toContain('local-pattern');
    expect(result.stdout).toContain('remote-pattern');
    expect(result.stdout).toContain('[from: other-repo]');
    expect(result.stdout).not.toContain('[from: ' + slug + ']'); // local project has no provenance tag
  });

  test('falls back to project scope when unassigned', () => {
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'local-only', type: 'pattern', insight: 'just local', confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');

    // groups.json exists but project not assigned
    writeGroupsJson({ groups: { Work: { created: '2026-03-30T00:00:00Z' } }, projects: {} });

    // UNASSIGNED_GROUP goes to stderr; the search still succeeds and returns local results
    const result = runSearch('--scope group');
    expect(result.stdout).toContain('local-only');
  });

  test('falls back gracefully when groups.json missing', () => {
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'fallback', type: 'pattern', insight: 'still works', confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');

    // No groups.json at all
    const result = runSearch('--scope group');
    expect(result.stdout).toContain('fallback');
  });

  test('handles missing JSONL for a group member', () => {
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'local', type: 'pattern', insight: 'local insight', confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');

    // ghost-repo is in the group but has no JSONL file
    writeGroupsJson({
      groups: { Work: { created: '2026-03-30T00:00:00Z' } },
      projects: { [slug]: 'Work', 'ghost-repo': 'Work' }
    });

    const result = runSearch('--scope group');
    expect(result.stdout).toContain('local');
    expect(result.exitCode).toBe(0); // should not crash
  });

  test('preserves different insights with same key+type across repos', () => {
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'other-repo'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'n-plus-one', type: 'pattern', insight: 'use includes for has_many', confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'other-repo', 'learnings.jsonl'),
      JSON.stringify({ key: 'n-plus-one', type: 'pattern', insight: 'use eager_load for polymorphic', confidence: 6, source: 'observed', ts: '2026-03-29T00:00:00Z' }) + '\n');

    writeGroupsJson({
      groups: { Work: { created: '2026-03-30T00:00:00Z' } },
      projects: { [slug]: 'Work', 'other-repo': 'Work' }
    });

    const result = runSearch('--scope group');
    expect(result.stdout).toContain('use includes for has_many');
    expect(result.stdout).toContain('use eager_load for polymorphic');
  });

  test('collapses exact duplicate insights across repos', () => {
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'other-repo'), { recursive: true });

    const sameInsight = 'always check null returns from find queries';
    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'null-check', type: 'pitfall', insight: sameInsight, confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'other-repo', 'learnings.jsonl'),
      JSON.stringify({ key: 'null-check', type: 'pitfall', insight: sameInsight, confidence: 6, source: 'observed', ts: '2026-03-29T00:00:00Z' }) + '\n');

    writeGroupsJson({
      groups: { Work: { created: '2026-03-30T00:00:00Z' } },
      projects: { [slug]: 'Work', 'other-repo': 'Work' }
    });

    const result = runSearch('--scope group');
    // Should show only 1 entry (collapsed, highest confidence kept)
    expect(result.stdout).toContain('1 loaded');
    expect(result.stdout).toContain('confidence: 8/10');
  });

  test('--cross-project backward compat maps to --scope global', () => {
    const slug = SLUG;

    fs.mkdirSync(path.join(tmpDir, 'projects', slug), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'projects', 'unrelated-repo'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'projects', slug, 'learnings.jsonl'),
      JSON.stringify({ key: 'local', type: 'pattern', insight: 'local', confidence: 8, source: 'observed', ts: '2026-03-30T00:00:00Z' }) + '\n');
    fs.writeFileSync(path.join(tmpDir, 'projects', 'unrelated-repo', 'learnings.jsonl'),
      JSON.stringify({ key: 'remote', type: 'pattern', insight: 'remote', confidence: 7, source: 'observed', ts: '2026-03-29T00:00:00Z' }) + '\n');

    const result = runSearch('--cross-project');
    expect(result.stdout).toContain('local');
    expect(result.stdout).toContain('remote');
  });
});
