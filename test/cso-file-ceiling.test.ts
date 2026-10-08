// /cso file-count ceiling (#3068, manifest half of #2993): snapshot.json has its own
// 16 MiB cap and compact form, every per-entry list in a 1 MiB private artifact is
// bounded with an omitted count, and both capacity errors say what to do next.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MAX_OUTPUT } from '../lib/cso/contracts';
import {
  SNAPSHOT_MANIFEST_LIMIT,
  capture,
  readSnapshotManifest,
  snapshotManifestCapMessage,
  sourceCapMessage,
} from '../lib/cso/snapshot';
import { newRun, readJson } from '../lib/cso/state';

const ROOT = path.resolve(import.meta.dir, '..');
const launcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher');
const MIB = 1024 * 1024;
const ISSUE = 'https://github.com/garrytan/gstack/issues/2993';
const KEY = ['pass', 'word'].join('');
let root = '';
let state = '';
const originalHome = process.env.GSTACK_HOME;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  if (result.status) throw new Error(result.stderr);
  return result.stdout;
}
function cso(repo: string, args: string[]) {
  return spawnSync(launcher, args, { cwd: repo, encoding: 'utf8', env: { HOME: root, GSTACK_HOME: state, PATH: '/usr/bin:/bin' }, timeout: 120_000, maxBuffer: 64 * MIB });
}
function makeRepo(name: string, files: Record<string, string | Buffer>): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, 'config', 'user.name', 'Fixture');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture');
  return repo;
}
function runDir(run: { repoId: string; runId: string }): string {
  return path.join(state, 'security', 'cso', run.repoId, run.runId);
}
function writeInput(name: string, value: unknown): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
const application = { actors: ['tenant user'], assets: ['tenant records'], entrypoints: ['GET /users/:id'], tenantBoundaries: ['tenant id'], sensitiveOperations: ['record read'], invariants: ['tenant isolation'] };
const finding = { title: 'Cross-tenant user read', rootCause: 'Tenant query omits caller tenant predicate', location: { path: 'src/users.ts', line: 1, symbol: 'tenantQuery' }, advisoryIds: [], severity: 'high', confidence: 'high', confidenceRationale: 'The caller-to-query trace and missing tenant predicate directly support the finding', evidence: 'supported', attackerControl: 'Authenticated caller chooses the record ID', impact: 'Another tenant record is returned', scenario: 'A tenant supplies a known record ID owned by another tenant and receives that record', trace: ['GET /users/:id', 'tenantQuery', 'findUnique by id'], references: ['src/users.ts:1', 'OWASP API1:2023'], recommendation: 'Bind the lookup predicate to the authenticated tenant identifier', challenge: { reviewer: 'independent-2', independent: true, mode: 'independent_agent', callers: 'Authenticated route forwards the ID', controls: 'Authentication does not bind tenant', counterevidence: 'Opaque IDs reduce guessing but do not authorize', conclusion: 'The authorization invariant is absent' } };
function completeEvidence(report: any, findings: unknown[]) {
  return { application, findings, coverage: report.coverage.filter((item: any) => !['snapshot-inputs', 'history-inputs'].includes(item.domain)).map((item: any) => ({ ...item, status: 'assessed', method: 'fresh caller and boundary trace', gaps: [], evidence: ['current captured source'] })), gaps: [] };
}
const USERS = 'export const tenantQuery = (id:string) => db.user.findUnique({where:{id}})\n';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-ceiling-'));
  state = path.join(root, 'state');
  process.env.GSTACK_HOME = state;
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CSO snapshot manifest cap', () => {
  test('the snapshot cap is local to snapshot.json; shared limits stay 1 MiB', () => {
    expect(MAX_OUTPUT).toBe(MIB);
    expect(SNAPSHOT_MANIFEST_LIMIT).toBe(16 * MIB);
    const dir = fs.mkdtempSync(path.join(root, 'caps-'));
    fs.chmodSync(dir, 0o700);
    const big = JSON.stringify({ padding: 'x'.repeat(MIB + 16) });
    for (const name of ['report.json', 'snapshot.json']) fs.writeFileSync(path.join(dir, name), big, { mode: 0o600 });
    expect(() => readJson(path.join(dir, 'report.json'))).toThrow('Invalid private state file');
    expect(() => readJson(path.join(dir, 'snapshot.json'))).toThrow('Invalid private state file');
    expect(readSnapshotManifest(dir)).toEqual(JSON.parse(big));
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ padding: 'x'.repeat(16 * MIB) }), { mode: 0o600 });
    expect(() => readSnapshotManifest(dir)).toThrow('Invalid private state file');
  });

  test('every snapshot.json read in the helper goes through readSnapshotManifest', () => {
    const files = fs.readdirSync(path.join(ROOT, 'lib', 'cso')).filter((file) => file.endsWith('.ts'));
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, 'lib', 'cso', file), 'utf8');
      expect(source).not.toMatch(/readJson\(\s*join\([^)]*'snapshot\.json'\)\s*\)/);
    }
    const cli = fs.readFileSync(path.join(ROOT, 'lib', 'cso', 'cli.ts'), 'utf8');
    expect(cli.match(/readSnapshotManifest\(/g)?.length).toBeGreaterThanOrEqual(13);
    const snapshot = fs.readFileSync(path.join(ROOT, 'lib', 'cso', 'snapshot.ts'), 'utf8');
    expect(snapshot).toContain("readJson(join(runDir, 'snapshot.json'), SNAPSHOT_MANIFEST_LIMIT)");
    expect(snapshot).toContain('> SNAPSHOT_MANIFEST_LIMIT');
    expect(snapshot).not.toContain('JSON.stringify(manifest, null, 2)');
  });

  test('both capacity errors name the bound cap, measured value, what counts, next step and #2993', () => {
    const manifest = snapshotManifestCapMessage(61_234, 17_000_000);
    expect(manifest).toStartWith('Snapshot manifest cap exceeded:');
    for (const part of ['61234 source entries', '17000000 byte', 'cap is 16.0 MiB', 'One entry is recorded for every tracked', 'Next step:', ISSUE, 'No supported workaround'])
      expect(manifest).toContain(part);
    const source = sourceCapMessage(346_199_207, 7_561);
    expect(source).toStartWith('64 MiB source cap exceeded:');
    for (const part of ['7561 source files', '346199207 bytes', 'cap is 64.0 MiB', 'files over 1 MiB whose payloads are withheld', 'Next step:', ISSUE, 'No supported workaround'])
      expect(source).toContain(part);
  });

  test('the 64 MiB source cap still fails closed, with the actionable message on stderr', () => {
    const repo = makeRepo('over-source-cap', { 'src/users.ts': USERS, 'assets/a.bin': Buffer.alloc(40 * MIB, 1), 'assets/b.bin': Buffer.alloc(25 * MIB, 1) });
    const result = cso(repo, ['start', '--repo', repo, '--offline']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe('MISSING_INPUT');
    expect(error.message).toStartWith('64 MiB source cap exceeded: 3 source files hold about 65.0 MiB');
    expect(error.message).toContain(ISSUE);
    expect(error.message).toContain('No supported workaround');
  }, 120_000);
});

describe('CSO above the old file-count ceiling', () => {
  test('a 2,500-file repository still captures and round-trips', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 2500; i++) files[`src/pkg/sub/file_number_${i}.ts`] = `export const v${i} = ${i};\n`;
    const repo = makeRepo('plain-2500', files),
      run = newRun(repo),
      manifest = await capture(repo, run.dir);
    expect(manifest.entries).toHaveLength(2500);
    expect(readSnapshotManifest(run.dir)).toEqual(manifest);
  }, 120_000);

  test('a retained pretty-printed snapshot.json from an older helper still loads in recheck', () => {
    const repo = makeRepo('legacy-pretty', { 'src/users.ts': USERS, 'src/other.ts': 'export const unrelated = true\n' }),
      run = JSON.parse(cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']).stdout),
      dir = runDir(run),
      initial = readJson(path.join(dir, 'report.json'));
    expect(cso(repo, ['submit', run.runId, writeInput('legacy-evidence.json', completeEvidence(initial, [finding]))]).status).toBe(0);
    expect(cso(repo, ['finish', run.runId]).status).toBe(0);
    const file = path.join(dir, 'snapshot.json');
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2) + '\n');
    expect(fs.readFileSync(file, 'utf8')).toContain('\n  "entries": [');
    expect(cso(repo, ['inspect', run.runId]).status).toBe(0);
    const findingId = readJson(path.join(dir, 'report.json')).findings[0].id,
      rechecked = cso(repo, ['recheck', findingId, '--run', run.runId, '--repo', repo]);
    expect(rechecked.stderr).toBe('');
    expect(rechecked.status).toBe(0);
    expect(JSON.parse(rechecked.stdout).parent.runId).toBe(run.runId);
  }, 120_000);
});
