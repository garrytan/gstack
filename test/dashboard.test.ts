import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const DASH = path.join(ROOT, 'bin', 'gstack-dashboard.ts');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-dashboard-'));
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

interface RunResult { stdout: string; stderr: string; exitCode: number }

// spawnSync (not execSync) so we capture stderr on exit-0 too — several
// dashboard cases legitimately write friendly messages to stderr while
// exiting 0 (empty home, no companies for filter, etc).
function run(args: string[]): RunResult {
  const r = spawnSync('bun', ['run', DASH, ...args], {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    encoding: 'utf-8',
    timeout: 15000,
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    exitCode: r.status ?? 1,
  };
}

// ---- fixture builder ----

function seedCompany(builder: string, company: string, opts: { events?: any[]; costs?: any[]; runs?: string[] } = {}): void {
  const cd = path.join(tmpHome, 'builders', builder, 'companies', company);
  fs.mkdirSync(cd, { recursive: true });
  if (opts.events) {
    fs.writeFileSync(path.join(cd, 'timeline.jsonl'), opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  if (opts.costs) {
    fs.writeFileSync(path.join(cd, 'costs.jsonl'), opts.costs.map((c) => JSON.stringify(c)).join('\n') + '\n');
  }
  for (const r of opts.runs ?? []) {
    fs.mkdirSync(path.join(cd, 'runs', r), { recursive: true });
  }
}

function seedProject(slug: string, events: any[]): void {
  const pd = path.join(tmpHome, 'projects', slug);
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, 'timeline.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const RUN_A = '4c107dc2-f68e-4b6e-8acc-2fc57c009002';
const RUN_B = '5d208ed3-074f-5c7e-9bdd-3df68e10a113';

// ---------------------------------------------------------------------------

describe('gstack-dashboard: empty home', () => {
  test('builders: empty home prints friendly message to stderr, exit 0', () => {
    const r = run(['builders']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/No builders/);
    expect(r.stdout).toBe('');
  });

  test('tail: empty home prints "No timelines found", exit 0', () => {
    const r = run(['tail']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/No timelines/);
  });

  test('companies: empty home → friendly message, exit 0', () => {
    const r = run(['companies']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/No companies/);
  });
});

describe('gstack-dashboard: builders + companies', () => {
  test('lists builders with company counts and last activity', () => {
    seedCompany('alice', 'co-a', { runs: [RUN_A], costs: [{ run_id: RUN_A, cost_usd: 1.50 }] });
    seedCompany('alice', 'co-b', { runs: [RUN_B], costs: [{ run_id: RUN_B, cost_usd: 0.25 }] });
    seedCompany('bob', 'project-x', { runs: [RUN_A] });

    const r = run(['builders']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('BUILDER');
    expect(r.stdout).toContain('alice');
    expect(r.stdout).toMatch(/alice\s+2\b/);  // 2 companies
    expect(r.stdout).toContain('bob');
    expect(r.stdout).toMatch(/bob\s+1\b/);
    expect(r.stdout).toContain('$1.7500');
  });

  test('companies --builder filters correctly', () => {
    seedCompany('alice', 'co-a', { runs: [RUN_A] });
    seedCompany('bob', 'project-x', { runs: [RUN_A] });

    const r = run(['companies', '--builder', 'alice']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('co-a');
    expect(r.stdout).not.toContain('project-x');
  });

  test('companies --builder rejects path-traversal slug', () => {
    const r = run(['companies', '--builder', '../evil']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/invalid builder/);
  });

  test('companies with no filter shows all builders', () => {
    seedCompany('alice', 'co-a', { runs: [RUN_A] });
    seedCompany('bob', 'project-x', { runs: [RUN_A] });
    const r = run(['companies']);
    expect(r.stdout).toContain('co-a');
    expect(r.stdout).toContain('project-x');
  });
});

describe('gstack-dashboard: runs + show', () => {
  test('runs lists each run with start time and inferred status', () => {
    seedCompany('alice', 'co-a', {
      runs: [RUN_A, RUN_B],
      events: [
        { ts: '2026-04-27T10:00:00Z', skill: 'office-hours', event: 'started', run_id: RUN_A },
        { ts: '2026-04-27T10:30:00Z', skill: 'office-hours', event: 'completed', outcome: 'success', run_id: RUN_A },
        { ts: '2026-04-27T11:00:00Z', skill: 'office-hours', event: 'started', run_id: RUN_B },
      ],
    });
    const r = run(['runs', '--company', 'co-a']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(RUN_A);
    expect(r.stdout).toContain(RUN_B);
    expect(r.stdout).toContain('2026-04-27 10:00:00');
    expect(r.stdout).toContain('success');
  });

  test('runs requires --company', () => {
    const r = run(['runs']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/requires --company/);
  });

  test('runs auto-resolves builder when company is unique across builders', () => {
    seedCompany('alice', 'unique-co', { runs: [RUN_A], events: [{ ts: '2026-04-27T10:00:00Z', skill: 'autoplan', event: 'started', run_id: RUN_A }] });
    const r = run(['runs', '--company', 'unique-co']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(RUN_A);
  });

  test('runs errors when company exists under multiple builders without --builder', () => {
    seedCompany('alice', 'shared', { runs: [RUN_A] });
    seedCompany('bob', 'shared', { runs: [RUN_B] });
    const r = run(['runs', '--company', 'shared']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/exists under multiple builders/);
  });

  test('runs errors when --builder/--company combo does not exist', () => {
    seedCompany('alice', 'co-a', { runs: [RUN_A] });
    const r = run(['runs', '--company', 'co-a', '--builder', 'bob']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not found under builder/);
  });

  test('show <run_id> filters to events for that run only', () => {
    seedCompany('alice', 'co-a', {
      runs: [RUN_A, RUN_B],
      events: [
        { ts: '2026-04-27T10:00:00Z', skill: 'office-hours', event: 'started', run_id: RUN_A },
        { ts: '2026-04-27T11:00:00Z', skill: 'autoplan', event: 'started', run_id: RUN_B },
      ],
    });
    const r = run(['show', RUN_A, '--company', 'co-a']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('office-hours');
    expect(r.stdout).not.toContain('autoplan');
  });

  test('show without run_id prints all company events', () => {
    seedCompany('alice', 'co-a', {
      runs: [RUN_A],
      events: [
        { ts: '2026-04-27T10:00:00Z', skill: 'office-hours', event: 'started', run_id: RUN_A },
        { ts: '2026-04-27T10:30:00Z', skill: 'autoplan', event: 'started', run_id: RUN_A },
      ],
    });
    const r = run(['show', '--company', 'co-a']);
    expect(r.stdout).toContain('office-hours');
    expect(r.stdout).toContain('autoplan');
  });

  test('show errors clearly when run_id has no events', () => {
    seedCompany('alice', 'co-a', { runs: [RUN_A], events: [] });
    fs.writeFileSync(path.join(tmpHome, 'builders', 'alice', 'companies', 'co-a', 'timeline.jsonl'), '');
    const r = run(['show', RUN_A, '--company', 'co-a']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/no events for run/);
  });
});

describe('gstack-dashboard: tail', () => {
  test('tail with --company reads orchestrator timeline', () => {
    seedCompany('alice', 'co-a', {
      runs: [RUN_A],
      events: [
        { ts: '2026-04-27T10:00:00Z', skill: 'office-hours', event: 'started', run_id: RUN_A },
        { ts: '2026-04-27T10:30:00Z', skill: 'autoplan', event: 'completed', outcome: 'success', run_id: RUN_A },
      ],
    });
    const r = run(['tail', '--company', 'co-a']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('office-hours');
    expect(r.stdout).toContain('autoplan');
  });

  test('tail default reads most-recently-touched project timeline (back-compat)', () => {
    seedProject('garrytan-gstack', [
      { ts: '2026-04-27T10:00:00Z', skill: 'review', event: 'started', branch: 'main' },
    ]);
    const r = run(['tail']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('review');
  });

  test('tail -n limits output', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-04-27T1${i}:00:00Z`,
      skill: `skill-${i}`,
      event: 'completed',
      run_id: RUN_A,
    }));
    seedCompany('alice', 'co-a', { runs: [RUN_A], events });
    const r = run(['tail', '--company', 'co-a', '-n', '3']);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(r.stdout).toContain('skill-9');
    expect(r.stdout).toContain('skill-8');
    expect(r.stdout).toContain('skill-7');
    expect(r.stdout).not.toContain('skill-6');
  });

  test('tail rejects --builder without --company', () => {
    const r = run(['tail', '--builder', 'alice']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--builder requires --company/);
  });
});

describe('gstack-dashboard: error surfaces', () => {
  test('unknown subcommand exits 1', () => {
    const r = run(['totally-not-a-command']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown subcommand/);
  });

  test('no args exits 2 with usage on stderr', () => {
    const r = run([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });
});
