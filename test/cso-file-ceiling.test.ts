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
import { boundedList, newRun, readJson } from '../lib/cso/state';
import { runProcess } from '../lib/cso/process';

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
// Long nested paths where most files are excluded or withheld and many carry
// scanner hits: the shape that overflowed report.json and sensitive-evidence.json.
function hostileFiles(count: number): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = { 'src/users.ts': USERS };
  for (let i = 1; i < count; i++) {
    const dir = `packages/very-long-workspace-package-name-${i % 50}/src/components/deeply/nested/feature-area-${i % 17}`;
    switch (i % 5) {
      case 0:
        files[`${dir}/module_file_number_${i}.ts`] = Array.from({ length: 12 }, (_, k) => `${KEY} = "Sup3rS3cretValue${i}x${k}"\n`).join('');
        break;
      case 1:
        files[`node_modules/${dir}/dependency_file_number_${i}.js`] = `module.exports=${i}\n`;
        break;
      case 2:
        files[`.claude/${dir}/agent_config_file_number_${i}.md`] = `cfg ${i}\n`;
        break;
      case 3:
        files[`${dir}/binary_asset_number_${i}.bin`] = Buffer.from(`a\0b${i}`);
        break;
      default:
        files[`${dir}/certificate_number_${i}.pem`] = `not a key ${i}\n`;
    }
  }
  return files;
}

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

describe('CSO bounded per-entry lists', () => {
  test('keeps leading items, appends one omitted-count summary, and leaves short lists untouched', () => {
    const items = Array.from({ length: 1000 }, (_, i) => `entry-${i}`);
    expect(boundedList(3, (i) => items[i], { bytes: 4096 }, 2, (n) => `${n} omitted`)).toEqual(items.slice(0, 3));
    const budget = { bytes: 2048 },
      kept = boundedList(items.length, (i) => items[i], budget, 2, (n) => `${n} omitted`);
    expect(kept.length).toBeLessThan(items.length);
    expect(kept.at(-1)).toBe(`${items.length - kept.length + 1} omitted`);
    expect(kept.slice(0, -1)).toEqual(items.slice(0, kept.length - 1));
    expect(budget.bytes).toBeGreaterThanOrEqual(0);
  });
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

  test('Git path listings over 1 MiB are admitted, with and without a comparison base', async () => {
    const files: Record<string, string> = {},
      dir = Array.from({ length: 6 }, (_, i) => `workspace-segment-with-a-long-descriptive-name-${i}`).join('/');
    for (let i = 1; i <= 5000; i++) files[`${dir}/file_number_${i}.ts`] = `export const v${i} = ${i};\n`;
    const repo = makeRepo('long-listing', files);
    expect(Buffer.byteLength(git(repo, 'ls-files', '-z'))).toBeGreaterThan(MIB);
    const plain = await capture(repo, newRun(repo).dir);
    expect(plain.entries).toHaveLength(5000);
    const based = await capture(repo, newRun(repo).dir, 'HEAD');
    expect(based.entries).toHaveLength(5000);
    expect(based.changedPaths).toEqual([]);
  }, 180_000);

  test('only raw callers can opt in to output above MAX_OUTPUT', async () => {
    const cwd = fs.mkdtempSync(path.join(root, 'raw-')),
      script = ['-c', 'head -c 1200000 /dev/zero | tr "\\0" a'],
      env = { PATH: '/usr/bin:/bin' };
    expect((await runProcess('/bin/sh', script, { cwd, env, maxBytes: 2 * MIB })).truncated).toBe(true);
    expect((await runProcess('/bin/sh', script, { cwd, env, raw: true })).truncated).toBe(true);
    const raw = await runProcess('/bin/sh', script, { cwd, env, raw: true, maxBytes: 2 * MIB });
    expect(raw.truncated).toBe(false);
    expect(raw.stdout).toHaveLength(1_200_000);
  });

  test('5,000 long nested paths, mostly excluded or withheld with many scanner hits, run start to final report and recheck', () => {
    const repo = makeRepo('hostile-5000', hostileFiles(5000)),
      started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    expect(Buffer.byteLength(started.stdout)).toBeLessThan(MIB);
    const run = JSON.parse(started.stdout),
      dir = runDir(run);

    const rawManifest = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'),
      manifest = readSnapshotManifest(dir);
    expect(Buffer.byteLength(rawManifest)).toBeGreaterThan(MIB);
    expect(rawManifest).toBe(JSON.stringify(manifest) + '\n');
    expect(manifest.entries).toHaveLength(5000);

    const evidence = readJson(path.join(dir, 'sensitive-evidence.json'));
    expect(fs.statSync(path.join(dir, 'sensitive-evidence.json')).size).toBeLessThan(MIB);
    expect(evidence.at(-1).note).toContain(`${evidence.at(-1).omitted} more files with sensitive-pattern findings are not listed`);
    expect(evidence.length - 1 + evidence.at(-1).omitted).toBe(999);

    const initial = readJson(path.join(dir, 'report.json')),
      snapshot = initial.coverage.find((item: any) => item.domain === 'snapshot-inputs'),
      transformations = initial.source.transformations;
    expect(fs.statSync(path.join(dir, 'report.json')).size).toBeLessThan(400 * 1024);
    expect(snapshot.evidence).toEqual(['1000 sanitized execution inputs captured; 3000 explicit non-executable exclusions; 1000 unread in-scope inputs; 0 tracked deletions']);
    expect(snapshot.status).toBe('partial');
    const omittedCount = (line: string) => Number(line.match(/^(\d+) more/)?.[1]);
    expect(snapshot.gaps.length - 1 + omittedCount(snapshot.gaps.at(-1))).toBe(1000);
    expect(snapshot.gaps.at(-1)).toContain('more unread or deleted in-scope inputs are not listed to keep report.json within its 1 MiB bound');
    expect(snapshot.exclusions.length - 1 + omittedCount(snapshot.exclusions.at(-1))).toBe(3000);
    expect(transformations.at(-1).path).toBe('[not listed]');
    expect(transformations.length - 1 + omittedCount(transformations.at(-1).handling)).toBe(4999);
    expect(transformations.length).toBeGreaterThan(100);
    expect(initial.events[0].message).toBe('Captured 5000 source entries; 4999 transformations disclosed');

    const inspected = cso(repo, ['inspect', run.runId]);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).manifest.entries).toHaveLength(5000);

    expect(cso(repo, ['submit', run.runId, writeInput('hostile-evidence.json', completeEvidence(initial, [finding]))]).status).toBe(0);
    const finished = cso(repo, ['finish', run.runId]);
    expect(finished.stderr).toBe('');
    expect(finished.status).toBe(0);
    const final = readJson(path.join(dir, 'report.json'));
    expect(final.status).toBe('finished');
    expect(final.findings).toHaveLength(1);
    expect(fs.statSync(path.join(dir, 'report.json')).size).toBeLessThan(MIB);

    const rechecked = cso(repo, ['recheck', final.findings[0].id, '--repo', repo]);
    expect(rechecked.stderr).toBe('');
    expect(rechecked.status).toBe(0);
    const child = JSON.parse(rechecked.stdout);
    expect(child.parent).toEqual({ runId: run.runId, findingId: final.findings[0].id, kind: 'recheck' });
    expect(readSnapshotManifest(runDir({ ...child, repoId: run.repoId })).entries).toHaveLength(5000);
  }, 300_000);

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
