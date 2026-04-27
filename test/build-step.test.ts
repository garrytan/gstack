import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const STEP = path.join(ROOT, 'bin', 'gstack-build-step.ts');

const RUN_ID = '4c107dc2-f68e-4b6e-8acc-2fc57c009002';
const BUILDER = 'test-builder';
const COMPANY = 'test-co';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-build-step-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

interface RunResult { stdout: string; stderr: string; exitCode: number }

function run(args: string[], opts: { stdin?: string } = {}): RunResult {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    encoding: 'utf-8',
    timeout: 15000,
    input: opts.stdin,
  };
  try {
    const stdout = execSync(`bun run ${STEP} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, execOpts);
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', exitCode: e.status ?? 1 };
  }
}

const RUN_DIR = () => path.join(tmpHome, 'builders', BUILDER, 'companies', COMPANY, 'runs', RUN_ID);

describe('gstack-build-step: paths', () => {
  test('emits shell-eval'+'able variables for the run dir + sentinels', () => {
    const r = run(['paths', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`RUN_DIR='${RUN_DIR()}'`);
    expect(r.stdout).toContain(`SENTINEL_OFFICE_HOURS='${RUN_DIR()}/office-hours-result.json'`);
    expect(r.stdout).toContain(`SENTINEL_AUTOPLAN='${RUN_DIR()}/autoplan-result.json'`);
    expect(r.stdout).toContain(`SENTINEL_IMPLEMENT='${RUN_DIR()}/implement-result.json'`);
    expect(r.stdout).toContain(`SENTINEL_QA='${RUN_DIR()}/qa-result.json'`);
    expect(r.stdout).toContain(`SENTINEL_SHIP='${RUN_DIR()}/ship-result.json'`);
    expect(r.stdout).toContain(`DECISIONS_LOG='${path.join(tmpHome, 'builders', BUILDER, 'companies', COMPANY, 'decisions.jsonl')}'`);
  });

  test('rejects path-traversal slug attempts', () => {
    const r = run(['paths', '--run-id', RUN_ID, '--builder-slug', '../evil', '--company-slug', COMPANY]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/invalid builder-slug/);
  });

  test('rejects malformed run-id', () => {
    const r = run(['paths', '--run-id', 'not-a-uuid', '--builder-slug', BUILDER, '--company-slug', COMPANY]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/invalid run-id/);
  });
});

describe('gstack-build-step: write-sentinel + read-sentinel round-trip', () => {
  test('autoplan: writes valid payload, reads it back unchanged', () => {
    const payload = {
      status: 'ok',
      plan_path: '/plans/p.md',
      ac_count: 7,
      ac_summary: 'AC1: foo. AC2: bar.',
      context_for_next_stage: 'plan locked, 7 ACs.',
    };
    const w = run(['write-sentinel', 'autoplan', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY], {
      stdin: JSON.stringify(payload),
    });
    expect(w.exitCode).toBe(0);
    expect(w.stdout.trim()).toBe(`${RUN_DIR()}/autoplan-result.json`);

    const r = run(['read-sentinel', 'autoplan', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.schema_version).toBe(1);
    expect(parsed.plan_path).toBe('/plans/p.md');
    expect(parsed.ac_count).toBe(7);
  });

  test('write auto-injects schema_version: 1 when caller omits', () => {
    run(['write-sentinel', 'ship', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY], {
      stdin: JSON.stringify({ status: 'ok', pr_url: 'http://gh/pr/1', version_tag: 'v0.0.1', commit_sha: 'abc' }),
    });
    const onDisk = JSON.parse(fs.readFileSync(`${RUN_DIR()}/ship-result.json`, 'utf-8'));
    expect(onDisk.schema_version).toBe(1);
  });

  test('write rejects schema_version mismatch', () => {
    const w = run(['write-sentinel', 'ship', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY], {
      stdin: JSON.stringify({ schema_version: 99, status: 'ok', pr_url: 'x', version_tag: 'y', commit_sha: 'z' }),
    });
    expect(w.exitCode).toBe(1);
    expect(w.stderr).toMatch(/schema_version=99/);
  });

  test('write rejects payload missing required field for stage', () => {
    const w = run(['write-sentinel', 'qa', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY], {
      stdin: JSON.stringify({ status: 'ok', report_path: '/r.md', bugs_found: 0 }),
    });
    expect(w.exitCode).toBe(1);
    expect(w.stderr).toMatch(/missing required field for stage qa: bugs_fixed/);
  });

  test('write rejects payload missing status', () => {
    const w = run(['write-sentinel', 'office-hours', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY], {
      stdin: JSON.stringify({ design_doc_path: '/d.md', decisions_summary: 's', context_for_next_stage: 'c' }),
    });
    expect(w.exitCode).toBe(1);
    expect(w.stderr).toMatch(/missing required field: status/);
  });

  test('read refuses unknown schema_version', () => {
    fs.mkdirSync(RUN_DIR(), { recursive: true });
    fs.writeFileSync(`${RUN_DIR()}/autoplan-result.json`,
      JSON.stringify({ schema_version: 2, status: 'ok', plan_path: '/x', ac_count: 1, ac_summary: 's', context_for_next_stage: 'c' }));
    const r = run(['read-sentinel', 'autoplan', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/schema_version=2.*refusing/);
  });

  test('read errors clearly when sentinel does not exist', () => {
    const r = run(['read-sentinel', 'autoplan', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/sentinel missing/);
  });

  test('write rejects empty stdin', () => {
    const w = run(['write-sentinel', 'ship', '--run-id', RUN_ID, '--builder-slug', BUILDER, '--company-slug', COMPANY], { stdin: '' });
    expect(w.exitCode).toBe(1);
    expect(w.stderr).toMatch(/empty stdin/);
  });
});

describe('gstack-build-step: required-fields + error surfaces', () => {
  test('lists required fields for office-hours', () => {
    const r = run(['required-fields', 'office-hours']);
    expect(r.exitCode).toBe(0);
    const fields = r.stdout.trim().split('\n');
    expect(fields).toEqual(['schema_version', 'status', 'design_doc_path', 'decisions_summary', 'context_for_next_stage']);
  });

  test('lists required fields for ship (no context_for_next_stage — it is the terminal stage)', () => {
    const r = run(['required-fields', 'ship']);
    expect(r.exitCode).toBe(0);
    const fields = r.stdout.trim().split('\n');
    expect(fields).toEqual(['schema_version', 'status', 'pr_url', 'version_tag', 'commit_sha']);
  });

  test('unknown stage exits 1 with clear message', () => {
    const r = run(['required-fields', 'unknown-stage']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown stage: unknown-stage/);
  });

  test('unknown subcommand exits 1', () => {
    const r = run(['totally-not-a-command']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown subcommand: totally-not-a-command/);
  });

  test('no args prints usage to stderr with exit 2', () => {
    const r = run([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });
});
