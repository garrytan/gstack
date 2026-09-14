import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicArchiveCacheRoot } from '../lib/cso/cache';
import { sha256, type RunReportV3, type VerificationRequest } from '../lib/cso/contracts';
import { dockerEndpoint, type DockerEndpoint } from '../lib/cso/docker';
import { patchHash } from '../lib/cso/verification';
import { qualifiedNodeCli, type QualifiedCsoCli } from './helpers/cso-qualified-cli';

const requested = process.env.GSTACK_CSO_DOCKER_TESTS === '1' && process.env.GSTACK_CSO_TEST_STACK === 'node';
const enabled = requested && Boolean(process.env.GSTACK_CSO_TEST_IMAGE);
const suite = requested ? describe : describe.skip;

let root = '';
let repo = '';
let state = '';
let endpoint: DockerEndpoint;
let cli: QualifiedCsoCli;

const application = {
  actors: ['unauthenticated caller'],
  assets: ['protected response body'],
  entrypoints: ['GET /security'],
  tenantBoundaries: ['authorization boundary'],
  sensitiveOperations: ['protected response read'],
  invariants: ['unauthenticated requests cannot read the protected response'],
};
const finding = {
  title: 'Unauthenticated security route discloses a secret',
  rootCause: 'The security route returns protected data without an authorization decision',
  location: { path: 'policy.js', line: 1, symbol: 'module.exports' },
  advisoryIds: [],
  severity: 'high',
  confidence: 'high',
  confidenceRationale: 'The captured caller-to-sink trace and control review directly support the finding',
  evidence: 'supported',
  attackerControl: 'An unauthenticated caller can request /security',
  impact: 'The response discloses protected data',
  scenario: 'An unauthenticated caller requests /security and receives the protected response body',
  trace: ['GET /security', 'app.js route', 'policy.js status and body'],
  references: ['policy.js:1', 'app.js security route'],
  recommendation: 'Require an authorization decision before returning the protected body while preserving the control route',
  challenge: {
    reviewer: 'lifecycle-fixture-challenger',
    independent: true,
    mode: 'independent_agent',
    callers: 'The loopback verifier calls the route without credentials',
    controls: 'No middleware or route authorization protects /security',
    counterevidence: 'The legitimate /control route is separate and remains available',
    conclusion: 'The captured route reaches the vulnerable policy without a protective control',
  },
};

function writeSource(target: string, fixed = false): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'cso-node-lifecycle', version: '1.0.0', private: true,
      scripts: { start: 'node app.js', test: 'node --test' },
      dependencies: { 'escape-html': '1.0.3' },
    }) + '\n',
    'package-lock.json': JSON.stringify({
      name: 'cso-node-lifecycle', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'cso-node-lifecycle', version: '1.0.0', dependencies: { 'escape-html': '1.0.3' } },
        'node_modules/escape-html': {
          version: '1.0.3',
          resolved: 'https://registry.npmjs.org/escape-html/-/escape-html-1.0.3.tgz',
          integrity: 'sha512-NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow==',
        },
      },
    }) + '\n',
    'app.js': "const http=require('node:http');const policy=require('./policy');const {control}=require('./control');const port=Number(process.env.PORT);http.createServer((req,res)=>{if(req.url==='/control'){res.writeHead(200);res.end(control());return}if(req.url==='/security'){res.writeHead(policy.status);res.end(policy.body);return}res.writeHead(404);res.end('missing')}).listen(port,'127.0.0.1');\n",
    'control.js': "const escape=require('escape-html');exports.control=()=>escape('CONTROL_OK');\n",
    'policy.js': fixed
      ? "module.exports={status:403,body:'DENIED'};\n"
      : "module.exports={status:200,body:'SECRET'};\n",
    'app.test.js': "const test=require('node:test');const assert=require('node:assert/strict');const {control}=require('./control');test('legitimate control remains available',()=>assert.equal(control(),'CONTROL_OK'));\n",
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(target, name), body, { mode: 0o600 });
}

function git(...args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 30_000,
  });
  if (result.status) throw new Error(result.stderr);
  return result.stdout;
}

function runDirectory(run: Pick<RunReportV3, 'repoId' | 'runId'>): string {
  return path.join(state, 'security', 'cso', run.repoId, run.runId);
}

function report(run: Pick<RunReportV3, 'repoId' | 'runId'>): RunReportV3 {
  return JSON.parse(fs.readFileSync(path.join(runDirectory(run), 'report.json'), 'utf8'));
}

function writeInput(name: string, value: unknown): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function helperOwnedCoverage(domain: string): boolean {
  return ['snapshot-inputs', 'history-inputs', 'runtime-readiness'].includes(domain)
    || domain.startsWith('scanner:') || domain.startsWith('preparation:') || domain.startsWith('execution:');
}

function completeEvidence(current: RunReportV3, findings: unknown[] = []): Record<string, unknown> {
  return {
    application,
    findings,
    coverage: current.coverage.filter(item => !helperOwnedCoverage(item.domain)).map(item => ({
      ...item,
      status: 'assessed',
      method: 'fresh caller and security-boundary trace',
      gaps: [],
      evidence: ['current captured source'],
    })),
    gaps: [],
  };
}

function dockerContainers(): string[] {
  const result = spawnSync(endpoint.executable, ['--host', endpoint.uri, 'ps', '--all', '--quiet', '--no-trunc'], {
    encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).toBe(0);
  return result.stdout.trim().split('\n').filter(Boolean).sort();
}

function expectEmptyDirectory(directory: string): void {
  expect(fs.existsSync(directory)).toBe(true);
  expect(fs.readdirSync(directory).sort()).toEqual([]);
}

beforeAll(async () => {
  if (!requested) return;
  if (!enabled) throw new Error('Node lifecycle qualification requires GSTACK_CSO_TEST_IMAGE; a requested cold gate cannot skip');
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  if (process.env.GSTACK_CSO_TEST_PLATFORM !== platform) throw new Error(`Node lifecycle qualification requires native ${platform}`);

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-node-lifecycle-'));
  repo = path.join(root, 'repo');
  state = path.join(root, 'state');
  process.env.GSTACK_HOME = state;
  writeSource(repo);
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('add', '.');
  git('commit', '-qm', 'vulnerable fixture');

  const watchdogPath = path.resolve(import.meta.dir, '../bin/gstack-cso-watchdog');
  const dockerHome = path.join(root, 'docker-home');
  fs.mkdirSync(dockerHome, { recursive: true, mode: 0o700 });
  endpoint = await dockerEndpoint(dockerHome, {
    HOME: root,
    DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
  });
  cli = qualifiedNodeCli({
    image: process.env.GSTACK_CSO_TEST_IMAGE!,
    versions: JSON.parse(process.env.GSTACK_CSO_EXPECTED_VERSIONS || '{}'),
    watchdogPath,
    platform,
  });
});

afterAll(() => {
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.GSTACK_HOME;
  }
});

suite('CSO Node producer-visible repair lifecycle fixture', () => {
  test('finds, reproduces, bundles, replays, and closes against current source through the command dispatcher', async () => {
    const beforeContainers = dockerContainers();
    let originalRunDirectory = '';
    let completed = false;
    try {
      const original = await cli.command<RunReportV3>(['start', '--repo', repo, '--comprehensive']);
      originalRunDirectory = runDirectory(original);
      expect(original.coverage.find(item => item.domain === 'runtime-readiness')).toMatchObject({ status: 'assessed' });
      expect(await cli.command(['submit', original.runId, writeInput('finding.json', completeEvidence(original, [finding]))])).toMatchObject({ findings: 1, completeness: 'complete' });

      const submitted = report(original);
      const submittedFinding = submitted.findings[0];
      expect(submittedFinding).toMatchObject({ reproduction: 'not_attempted', repair: 'not_attempted', closure: 'open' });
      const plan = await cli.command<any>(['runtime-plan', original.runId, 'node', '--port', '34569']);
      const vulnerable = fs.readFileSync(path.join(originalRunDirectory, 'snapshot', 'policy.js'), 'utf8');
      const repaired = "module.exports={status:403,body:'DENIED'};\n";
      const request: VerificationRequest = {
        findingId: submittedFinding.id,
        runtimeProfile: cli.runtime.id,
        port: 34569,
        start: plan.start.command,
        legitimate: [{ name: 'legitimate control', path: '/control', method: 'GET', expected: { status: 200, includes: 'CONTROL_OK' } }],
        security: { name: 'unauthorized secret is denied', path: '/security', method: 'GET', expected: { status: 403, includes: 'DENIED' }, vulnerable: { status: 200, includes: 'SECRET' } },
        existingTests: plan.tests.commands,
        fixtures: {},
        boundaryFiles: ['app.js', 'policy.js'],
        testFiles: plan.tests.files,
        changes: [{ path: 'policy.js', beforeSha256: sha256(vulnerable), after: repaired, effect: 'source' }],
        review: {
          reviewer: 'independent-lifecycle-fixture-reviewer',
          independent: true,
          rootCauseRepaired: true,
          featurePreserved: true,
          boundaryMocks: false,
          rationale: 'The access decision now denies the unauthorized path while the legitimate control and original test remain intact.',
          reviewedPatchHash: '',
        },
      };
      request.review.reviewedPatchHash = patchHash(request);
      const requestPath = writeInput('verification.json', request);
      const review = await cli.command<any>(['record-review', original.runId, requestPath, '--producer', 'lifecycle-fixture-producer']);
      request.review.artifactId = review.reviewArtifactId;
      writeInput('verification.json', request);

      const verified = await cli.command<any>(['verify', original.runId, requestPath]);
      expect(verified).toMatchObject({
        result: 'runtime_tested',
        verification: {
          result: 'runtime_tested',
          assertionAssurance: 'authenticated_out_of_process',
          testCompletionAssurance: 'self_reported',
          reviewAssurance: 'self_attested',
          before: { booted: true, legitimate: true, security: 'intended_failure', existingTests: true },
          after: { booted: true, legitimate: true, security: 'pass', existingTests: true },
        },
      });
      const verifiedReport = report(original);
      expect(verifiedReport.findings[0]).toMatchObject({
        reproduction: 'reproduced',
        repair: 'runtime_tested',
        verificationId: verified.verification.id,
        verificationAssurance: {
          assertions: 'authenticated_out_of_process',
          testCompletion: 'self_reported',
          review: 'self_attested',
        },
      });
      const bundle = JSON.parse(fs.readFileSync(path.join(originalRunDirectory, verified.bundle), 'utf8'));
      expect(bundle).toMatchObject({ id: verified.verification.id, requiredInputs: { runtimeImage: cli.runtime.image } });
      expect(bundle.requiredInputs.dependencyClosures.before.archives).toEqual([
        expect.objectContaining({
          name: 'escape-html',
          version: '1.0.3',
          requestedHost: 'registry.npmjs.org',
          declaredIntegrity: 'sha512-NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow==',
        }),
      ]);

      const replayed = await cli.command<any>(['replay', verified.verification.id]);
      expect(replayed).toMatchObject({ bundle: verified.verification.id, result: 'runtime_tested' });
      expect(JSON.parse(fs.readFileSync(path.join(originalRunDirectory, 'replays', `${replayed.replayId}.json`), 'utf8'))).toMatchObject({
        replayId: replayed.replayId,
        bundleId: verified.verification.id,
        verification: { result: 'runtime_tested' },
      });
      expect(await cli.command(['finish', original.runId])).toMatchObject({ status: 'finished', completeness: 'complete' });

      fs.writeFileSync(path.join(repo, 'policy.js'), repaired, { mode: 0o600 });
      git('add', 'policy.js');
      git('commit', '-qm', 'repair authorization policy');
      const recheck = await cli.command<any>(['recheck', submittedFinding.id, '--run', original.runId, '--repo', repo]);
      const recheckRun = { repoId: original.repoId, runId: recheck.runId };
      const fresh = report(recheckRun);
      expect(fresh.parent).toEqual({ runId: original.runId, findingId: submittedFinding.id, kind: 'recheck' });
      expect(fresh.source.originalHash).not.toBe(original.source.originalHash);
      expect(report(original).findings[0]).toMatchObject({ closure: 'open', verificationId: verified.verification.id });
      const freshBoundary = fs.readFileSync(path.join(runDirectory(recheckRun), 'snapshot', 'policy.js'), 'utf8');
      expect(freshBoundary).toBe(repaired);

      const claim = {
        findingId: submittedFinding.id,
        outcome: 'resolved',
        evidence: [
          { kind: 'caller', path: 'policy.js', line: 1, observation: 'Fresh route trace reaches the repaired authorization decision' },
          { kind: 'security_boundary', path: 'policy.js', line: 1, observation: 'Fresh boundary source returns the denial without the protected body' },
        ],
        rootCause: finding.rootCause,
      };
      expect(await cli.command(['submit', recheck.runId, writeInput('recheck.json', { ...completeEvidence(fresh), recheck: claim })])).toMatchObject({ findings: 0, completeness: 'complete' });
      const retainedClaim = JSON.parse(fs.readFileSync(path.join(runDirectory(recheckRun), 'recheck-claim.json'), 'utf8'));
      expect(retainedClaim.evidence).toEqual([
        expect.objectContaining({ kind: 'caller', path: expect.stringMatching(/^@cso-path\/\//), sourceState: 'present', snapshotHash: fresh.source.originalHash, sourceHash: sha256(Buffer.from(repaired)), executionHash: sha256(Buffer.from(repaired)) }),
        expect.objectContaining({ kind: 'security_boundary', path: expect.stringMatching(/^@cso-path\/\//), sourceState: 'present', snapshotHash: fresh.source.originalHash, sourceHash: sha256(Buffer.from(repaired)), executionHash: sha256(Buffer.from(repaired)) }),
      ]);
      expect(await cli.command(['finish', recheck.runId])).toMatchObject({ status: 'finished', completeness: 'complete' });
      expect(report(original).findings[0]).toMatchObject({
        closure: 'resolved',
        reproduction: 'reproduced',
        repair: 'runtime_tested',
        verificationId: verified.verification.id,
      });
      completed = true;
    } finally {
      expect(dockerContainers()).toEqual(beforeContainers);
      if (originalRunDirectory) {
        for (const directory of ['archive-staging', 'archive-materializations', 'preparation-execution', 'verification']) {
          const full = path.join(originalRunDirectory, directory);
          if (fs.existsSync(full)) expect(fs.readdirSync(full).sort()).toEqual([]);
        }
      }
    }

    expect(completed).toBe(true);
    for (const directory of ['archive-staging', 'archive-materializations', 'preparation-execution', 'verification']) {
      expectEmptyDirectory(path.join(originalRunDirectory, directory));
    }
    const cache = publicArchiveCacheRoot();
    expect(fs.lstatSync(path.join(cache, '.lock')).isFile()).toBe(true);
    expect(fs.readdirSync(path.join(cache, 'entries'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(cache, 'metadata'))).toHaveLength(1);
    expectEmptyDirectory(path.join(cache, '.mutation-lock-leases'));
    for (const directory of ['incoming', 'recovery']) expectEmptyDirectory(path.join(cache, directory));
  }, 10 * 60_000);
});
