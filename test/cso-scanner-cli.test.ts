import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLock } from '../lib/cso/state';

const launcher = resolve(import.meta.dir, '../bin/gstack-cso-launcher');
let root = '', repo = '', state = '', sarif = '';
const env = () => ({ HOME: root, GSTACK_HOME: state, PATH: '/usr/bin:/bin' });
function command(args: string[]) { return spawnSync(launcher, args, { cwd: repo, env: env(), encoding: 'utf8', timeout: 30000 }); }
function start() {
  const r = command(['start', '--repo', repo, '--offline']); expect(r.status).toBe(0);
  const report = JSON.parse(r.stdout), dir = join(state, 'security/cso', report.repoId, report.runId);
  return { runId: report.runId as string, dir, report: () => JSON.parse(fs.readFileSync(join(dir, 'report.json'), 'utf8')), artifacts: () => fs.existsSync(join(dir, 'scanner-outcomes')) ? fs.readdirSync(join(dir, 'scanner-outcomes')) : [] };
}
beforeAll(() => {
  root = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'cso-scanner-cli-')); repo = join(root, 'repo'); state = join(root, 'state'); fs.mkdirSync(repo);
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.test'], ['config', 'user.name', 'Test']]) { const r = spawnSync('/usr/bin/git', ['-C', repo, ...args], { env: env(), encoding: 'utf8', timeout: 30000 }); expect(r.status).toBe(0); }
  fs.writeFileSync(join(repo, 'app.js'), 'export const example = true;\n');
  for (const args of [['add', 'app.js'], ['commit', '-qm', 'fixture']]) expect(spawnSync('/usr/bin/git', ['-C', repo, ...args], { env: env(), encoding: 'utf8', timeout: 30000 }).status).toBe(0);
  sarif = join(root, 'results.sarif'); fs.writeFileSync(sarif, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', version: '2.22.0' } }, results: [{ ruleId: 'js/test', message: { text: 'Candidate defect' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js' }, region: { startLine: 1 } } }] }] }] }));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('compiled scanner evidence persistence', () => {
  test('scan uses the empty qualified catalog and records helper-owned coverage without host execution', () => {
    const run = start(), r = command(['scan', run.runId, 'gitleaks']); expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout); expect(out.status).toBe('not_assessed'); expect(out.gaps[0].message).toContain('No qualified gitleaks');
    expect(out.artifactId).toMatch(/^gitleaks-[a-f0-9]{16}-[a-f0-9]{16}$/);
    expect(run.artifacts()).toEqual([`${out.artifactId}.json`]);
    const stored = JSON.parse(fs.readFileSync(join(run.dir,out.artifact), 'utf8')); expect(stored.provenance.image).toBeNull(); expect(stored.outcome).not.toHaveProperty('repair');
    expect(run.report().coverage.find((x: any) => x.domain === 'scanner:gitleaks')).toMatchObject({ status: 'not_assessed' });
  });
  test('repeated same-content SARIF imports get distinct immutable artifacts and coverage records', () => {
    const run = start(), first = command(['import-sarif', run.runId, sarif]); expect(first.status).toBe(0);
    const firstOut = JSON.parse(first.stdout), before = fs.readFileSync(join(run.dir,firstOut.artifact), 'utf8');
    const second = command(['import-sarif', run.runId, sarif]); expect(second.status).toBe(0); const secondOut = JSON.parse(second.stdout);
    expect(firstOut.artifactId).not.toBe(secondOut.artifactId); expect(run.artifacts()).toHaveLength(2); expect(fs.readFileSync(join(run.dir,firstOut.artifact), 'utf8')).toBe(before);
    const coverage = run.report().coverage.filter((x: any) => x.domain === 'scanner:sarif'); expect(coverage).toHaveLength(2);
    expect(coverage.every((x: any) => x.evidence.some((e: string) => e.startsWith('Immutable outcome:')))).toBe(true);
  });
  test('model submissions cannot erase a scanner failure or replace imported scanner evidence', () => {
    const run = start(); expect(command(['scan', run.runId, 'gitleaks']).status).toBe(0);
    const reportBefore = fs.readFileSync(join(run.dir, 'report.json'), 'utf8');
    const file = join(root, 'scanner-coverage.json'); fs.writeFileSync(file, JSON.stringify({ coverage: [{ domain: 'scanner:gitleaks', scope: 'default', status: 'assessed', method: 'model says clean', gaps: [], exclusions: [], evidence: ['claim'] }] }));
    const r = command(['submit', run.runId, file]); expect(r.status).not.toBe(0); expect(r.stderr).toContain('helper-owned'); expect(fs.readFileSync(join(run.dir, 'report.json'), 'utf8')).toBe(reportBefore);
  });
  test('finished reports reject scanner execution and SARIF persistence without changing artifacts', () => {
    const run = start(); expect(command(['finish', run.runId]).status).toBe(0); const before = fs.readFileSync(join(run.dir, 'report.json'), 'utf8');
    for (const args of [['scan', run.runId, 'gitleaks'], ['import-sarif', run.runId, sarif]]) { const r = command(args); expect(r.status).not.toBe(0); expect(r.stderr).toContain('running audit'); }
    expect(run.artifacts()).toEqual([]); expect(fs.readFileSync(join(run.dir, 'report.json'), 'utf8')).toBe(before);
  });
  test('a live mutation lock protects both scan and SARIF writes', () => {
    const run = start();
    const before = fs.readFileSync(join(run.dir, 'report.json'), 'utf8');
    withLock(run.dir,()=>{for (const args of [['scan', run.runId, 'gitleaks'], ['import-sarif', run.runId, sarif]]) { const r = command(args); expect(r.status).not.toBe(0); expect(r.stderr).toContain('INSUFFICIENT_CAPACITY'); }});
    expect(run.artifacts()).toEqual([]); expect(fs.readFileSync(join(run.dir, 'report.json'), 'utf8')).toBe(before);
  });
  test('concurrent imports preserve every successful artifact and never lose a coverage update', async () => {
    const run = start();
    const attempt = async () => { const child = Bun.spawn([launcher, 'import-sarif', run.runId, sarif], { cwd: repo, env: env(), stdout: 'pipe', stderr: 'pipe' }); const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; };
    const results = await Promise.all([attempt(), attempt()]), successes = results.filter(r => r.code === 0);
    expect(successes.length).toBeGreaterThan(0); for (const failure of results.filter(r => r.code !== 0)) expect(failure.stderr).toContain('INSUFFICIENT_CAPACITY');
    expect(run.artifacts()).toHaveLength(successes.length); expect(run.report().coverage.filter((c: any) => c.domain === 'scanner:sarif')).toHaveLength(successes.length);
    expect(new Set(successes.map(r => JSON.parse(r.stdout).artifactId)).size).toBe(successes.length);
  });
  test('malformed SARIF remains a persisted coverage failure', () => {
    const run = start(), malformed = join(root, 'broken.sarif'); fs.writeFileSync(malformed, '{');
    const r = command(['import-sarif', run.runId, malformed]); expect(r.status).toBe(0); expect(JSON.parse(r.stdout).status).toBe('not_assessed');
    expect(run.report().coverage.find((c: any) => c.domain === 'scanner:sarif')).toMatchObject({ status: 'not_assessed' });
  });
});
