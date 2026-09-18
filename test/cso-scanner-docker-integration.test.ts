import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonical, sha256 } from '../lib/cso/contracts';
import { dockerEndpoint, ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { createDockerScannerRunner, ScannerRunInput } from '../lib/cso/scanner-executor';
import { QualifiedRuntime } from '../lib/cso/runtime-catalog';
import { assertScannerVersionOutput, QualifiedScanner, scannerVersionHash } from '../lib/cso/scanner-catalog';
import { ScannerId, parseScannerOutput, scannerPlans } from '../lib/cso/scanners';
import { secureDirectory } from '../lib/cso/state';

const requested = process.env.GSTACK_CSO_SCANNER_DOCKER_TESTS === '1';
const suite = requested ? describe : describe.skip;
const HASH = 'a'.repeat(64), DIGEST = `sha256:${HASH}`;
let root = '', source = '', watchdog = '', staged: any;

describe('scanner qualification version evidence',()=>{
  test.each([
    ['gitleaks','gitleaks version 8.30.1','8.30.1'],
    ['osv','osv-scanner version: 2.4.0','2.4.0'],
    ['semgrep','1.136.0','1.136.0'],
    ['zizmor','zizmor 1.11.2','1.11.2'],
    ['trivy','Version: 0.67.2','0.67.2'],
    ['schemathesis','schemathesis, version 4.5.2','4.5.2'],
  ] as const)('accepts a supported real version layout: %s %s',(scanner,output,version)=>{
    expect(()=>assertScannerVersionOutput(scanner,version,`${output}\n`)).not.toThrow();
  });
  test.each(['11.2.3','1.2.30','1.2.3-dev','prefix1.2.3','1.2.3suffix'])('rejects a substring version match: %s',output=>{
    expect(()=>assertScannerVersionOutput('gitleaks','1.2.3',output)).toThrow('exact catalog version');
  });
  test('rejects an expected version that appears only in secondary metadata',()=>{
    expect(()=>assertScannerVersionOutput('gitleaks','1.2.3','gitleaks version 9.9.9\nruntime 1.2.3\n')).toThrow('primary version');
  });
  test('uses the same 8192-byte output boundary as production execution',()=>{
    const prefix='gitleaks version 1.2.3\n',within=prefix+'x'.repeat(8192-Buffer.byteLength(prefix));
    expect(()=>assertScannerVersionOutput('gitleaks','1.2.3',within)).not.toThrow();
    expect(()=>assertScannerVersionOutput('gitleaks','1.2.3',within+'x')).toThrow('bounded output');
  });
});

function write(name: string, body: string): void {
  const target = path.join(source, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body, { mode: 0o600 });
}
function fixture(): void {
  write('app.js', 'export const scannerQualification = true;\n');
  write('package.json', '{"name":"cso-scanner-qualification","version":"1.0.0"}\n');
  write('package-lock.json', '{"name":"cso-scanner-qualification","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"cso-scanner-qualification","version":"1.0.0"}}}\n');
  write('.github/workflows/qualification.yml', 'name: qualification\non: [push]\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo qualification\n');
  write('server.py', [
    'from http.server import BaseHTTPRequestHandler, HTTPServer',
    'class H(BaseHTTPRequestHandler):',
    '  def do_GET(self):',
    "    body = b'CONTROL_OK' if self.path == '/control' else b'[]'",
    '    self.send_response(200)',
    "    self.send_header('Content-Type', 'application/json')",
    "    self.send_header('Content-Length', str(len(body)))",
    '    self.end_headers(); self.wfile.write(body)',
    '  def log_message(self, *args): pass',
    "HTTPServer(('127.0.0.1', 34620), H).serve_forever()",
  ].join('\n') + '\n');
}
function request() {
  return { api: { runtimeProfile: 'qualification-runtime', port: 34620,
    start: { executable: staged.applicationExecutable, args: ['server.py'] },
    control: { name: 'qualification control', path: '/control', method: 'GET' as const, expected: { status: 200, includes: 'CONTROL_OK' } },
    boundaryFiles: ['server.py'], operationIds: ['listItems'],
    schema: { openapi: '3.1.0', info: { title: 'CSO scanner qualification', version: '1.0.0' }, paths: { '/items': { get: { operationId: 'listItems', responses: { '200': { description: 'items' } } } } } } } };
}

beforeAll(async () => {
  if (!requested) return;
  const file = process.env.GSTACK_CSO_SCANNER_PROFILE;
  if (!file) throw new Error('Scanner Docker qualification requires GSTACK_CSO_SCANNER_PROFILE');
  staged = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!['gitleaks', 'osv', 'semgrep', 'zizmor', 'trivy', 'schemathesis'].includes(staged.scanner) || !/^.+@sha256:[a-f0-9]{64}$/.test(staged.image) || !/^[0-9][A-Za-z0-9.+_-]{0,100}$/.test(staged.version) || !Array.isArray(staged.capabilities)) throw new Error('Scanner Docker qualification profile is invalid');
  if (staged.isolationPolicyHash !== ISOLATION_POLICY_HASH) throw new Error('Scanner Docker qualification profile does not match the helper isolation policy');
  if (!process.env.GSTACK_CSO_SCANNER_VERSION_HASH) throw new Error('Scanner Docker qualification requires GSTACK_CSO_SCANNER_VERSION_HASH');
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  if (staged.platform !== platform) throw new Error(`Scanner Docker qualification requires native ${platform}`);
  if (staged.scanner === 'schemathesis' && (typeof staged.applicationExecutable !== 'string' || !staged.applicationExecutable.startsWith('/'))) throw new Error('Schemathesis qualification requires its reviewed fixture runtime executable');
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cso-scanner-docker-'));
  source = secureDirectory(path.join(root, 'source')); fixture();
  process.env.GSTACK_HOME = path.join(root, 'state');
  watchdog = path.resolve(import.meta.dir, '../bin/gstack-cso-watchdog');
  if (!fs.existsSync(watchdog)) throw new Error('Scanner Docker qualification requires the compiled watchdog');
  await dockerEndpoint(secureDirectory(path.join(root, 'docker-home')), { HOME: root, DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock' });
});
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); delete process.env.GSTACK_HOME; });

suite('qualified CSO scanner image', () => {
  test('runs the exact adapter through DockerGroup with network-none inputs and bounded normalization', async () => {
    const id = staged.scanner as ScannerId, api = id === 'schemathesis' ? request().api : undefined;
    const plan = scannerPlans({ snapshotRoot: '/source', offline: true, selected: [id], deadlineSeconds: 120,
      tools: { [id]: { available: true, version: staged.version, capabilities: staged.capabilities } },
      semgrepRules: staged.assets?.semgrepRules?.path, advisoryCache: staged.assets?.advisoryDatabase?.path,
      ...(api ? { schemaPath: '/policy/openapi.json', baseUrl: `http://127.0.0.1:${api.port}/`, operationIds: api.operationIds, seed: 1, maxExamples: 3 } : {}) })[0];
    expect(plan.prerequisites).toEqual([]);
    expect(plan.network).toBe(id === 'schemathesis' ? 'loopback' : 'none');
    const profile: QualifiedScanner = { id: `qualification-${id}`, scanner: id, state: 'qualified', platform: staged.platform, image: staged.image,
      entrypoint: '/opt/cso/entrypoint', executable: '/opt/cso/bin/scanner', version: staged.version, versionOutputSha256: HASH, helperAbi: 3,
      isolationPolicyHash: staged.isolationPolicyHash, capabilities: staged.capabilities, ...(staged.assets ? { assets: staged.assets } : {}),
      qualifiedAt: '2026-01-01T00:00:00.000Z', qualification: { sourceCommit: 'a'.repeat(40), workflow: 'https://github.com/example/example/actions/runs/1', sbomDigest: DIGEST, provenanceDigest: DIGEST, verifiedProvenance: true, containmentPassed: true, adapterContractPassed: true, offlineAssetsPassed: true } };
    const manifest = { version: 3 as const, root: source, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), entries: [], headCommit: 'a'.repeat(40), originalHash: sha256(canonical([])), executionHash: sha256(canonical([])) };
    const input: ScannerRunInput = { id, runId: `scanner-qualification-${Date.now()}`, runDir: root, manifest, policy: { mode: 'comprehensive', scope: 'qualification', diff: false, base: 'HEAD', offline: true, budgetSeconds: 600, maxWorkers: 3, maxRepairs: 3 }, executionDeadline: Date.now() + 120_000, platform: staged.platform, watchdogPath: watchdog, ...(api ? { request: { api } } : {}) };
    let runtime: QualifiedRuntime | undefined, application: any;
    if (api) {
      runtime = { id: 'qualification-runtime', stack: 'python', platform: staged.platform, state: 'qualified', image: staged.image, entrypoint: '/opt/cso/entrypoint', helperAbi: 3, versions: { python: '3.14.0', uv: '1.0.0', 'cso-preparation': '1.0.0' }, policyVersion: 'cso-isolation-v1', qualifiedAt: '2026-01-01T00:00:00.000Z', qualification: { kind: 'application', sourceCommit: 'a'.repeat(40), workflow: 'https://github.com/example/example/actions/runs/1', sbomDigest: DIGEST, provenanceDigest: DIGEST, verifiedProvenance: true, containmentPassed: true, coldStartPassed: true, positiveNegativeAssertionsPassed: true, heldOutRepairPassed: true } };
      application = { sourceRoot: source, environment: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONUNBUFFERED: '1' }, proof: { dependencyClosureHash: HASH, preparedManifestHash: HASH, sourceProjectionHash: HASH, receiptHash: HASH, executionEnvironmentHash: HASH, databaseHash: HASH }, cleanup: async () => {} };
    }
    const runner = await createDockerScannerRunner({ input, plan, profile, runtime, application, deadline: input.executionDeadline });
    try {
      const version = await runner.version();
      expect(version.exitCode).toBe(0); expect(version.timedOut).not.toBe(true); expect(version.truncated).not.toBe(true);
      assertScannerVersionOutput(id,staged.version,version.stdout,version.stderr);
      profile.versionOutputSha256 = scannerVersionHash(version.stdout, version.stderr);
      const execution = await runner.scan(), outcome = parseScannerOutput(plan, { ...execution, version: staged.version, databaseUpdatedAt: staged.assets?.advisoryDatabase?.updatedAt });
      expect(outcome.status).toBe('complete'); expect(outcome.gaps).toEqual([]); expect(outcome.version).toBe(staged.version);
      fs.writeFileSync(path.resolve(process.env.GSTACK_CSO_SCANNER_VERSION_HASH!), `${profile.versionOutputSha256}\n`, { flag: 'wx', mode: 0o600 });
    } finally { await runner.cleanup(); }
  }, 180_000);
});
