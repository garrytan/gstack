import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PublicArchiveCache } from '../lib/cso/cache';
import { canonical, CsoError, sha256 } from '../lib/cso/contracts';
import { inspectPreparation, type CsoStack } from '../lib/cso/preparation';
import {
  admitPreparationRuntime,
  PreparationExecutor,
  type AcquisitionReceipt,
  type OfflinePreparationReceipt,
  type OfflinePreparationRequest,
  type PreparationAcquireRequest,
  type PreparationSandboxRunner,
} from '../lib/cso/preparation-executor';
import { CSO_HELPER_ABI } from '../lib/cso/runtime-catalog';
import { completeRuntimeCatalogFixture } from './helpers/cso-runtime-catalog';

const roots: string[] = [];
const archiveBytes = Buffer.from('adversarial-public-archive');
const sha512 = (value: Buffer | string) => createHash('sha512').update(value).digest('base64');

function temporary(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

function writeTree(root: string, files: Record<string, string | object>): void {
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function catalog(_stack: 'node' | 'bun') { return completeRuntimeCatalogFixture('adversarial-test-v1'); }

function cacheFixture(): PublicArchiveCache {
  const root = temporary('cso-adversarial-cache-');
  const stagingRoot = path.join(root, 'staging');
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  return new PublicArchiveCache({ root: path.join(root, 'cache'), stagingRoot, maxBytes: 1024 * 1024 });
}

const qualification = {
  schemaVersion: 1 as const, helperAbi: CSO_HELPER_ABI, runnerId: 'adversarial-qualified-runner',
  policyVersion: 'cso-preparation-v1' as const, supportedStacks: ['node', 'bun', 'python', 'rails'] as CsoStack[],
  registryRestrictionQualified: true as const, dnsRebindingTestsPassed: true as const,
  acquisitionExcludesSource: true as const, offlineContainmentQualified: true as const,
  immutableArchiveMounts: true as const, resourceLimitsEnforced: true as const,
};

function commandReceipts(commands: PreparationAcquireRequest['commands']) {
  return commands.map((command, index) => ({
    index, commandHash: sha256(canonical(command)), exitCode: 0, timedOut: false, outputTruncated: false,
  }));
}

function offlineReceipt(request: OfflinePreparationRequest): OfflinePreparationReceipt {
  return {
    schemaVersion: 1, planHash: request.planHash, runtimeId: request.runtime.id, runtimeImage: request.runtime.image,
    platform: request.runtime.platform, sourceHash: request.sourceHash, dependencyClosureHash: request.dependencyClosureHash,
    configurationHash: request.configurationHash, databaseHash: request.databaseHash, deadlineEnforced: true,
    network: { mode: 'none', namespaceAnchor: 'adversarial-anchor', externalEgress: false, dnsAvailable: false,
      publishedPorts: false, services: ['application'] },
    commands: commandReceipts(request.commands), inputSourceReadOnly: true, preparedCopySeparate: true,
    archivesReadOnly: true, applicationCodeExecutedOnlyOffline: true,
  };
}

class PreparedSymlinkRunner implements PreparationSandboxRunner {
  readonly qualification = qualification;
  constructor(private readonly linkTarget: string) {}
  async acquire(): Promise<AcquisitionReceipt> { throw new Error('fixture has no public dependencies'); }
  async prepareOffline(request: OfflinePreparationRequest) {
    const call = temporary('cso-adversarial-prepared-');
    const preparedRoot = path.join(call, 'prepared');
    fs.mkdirSync(preparedRoot, { mode: 0o700 });
    fs.cpSync(request.sourceRoot, preparedRoot, { recursive: true });
    fs.mkdirSync(path.join(preparedRoot, 'node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(preparedRoot, 'node_modules/lib'), { recursive: true });
    fs.writeFileSync(path.join(preparedRoot, 'node_modules/lib/tool.js'), 'export default 1;\n');
    fs.writeFileSync(path.join(call, 'outside.txt'), 'outside\n');
    fs.symlinkSync(this.linkTarget, path.join(preparedRoot, 'node_modules/.bin/tool'));
    return { preparedRoot, receipt: offlineReceipt(request) };
  }
  disposePrepared(preparedRoot: string): void { fs.rmSync(path.dirname(preparedRoot), { recursive: true, force: true }); }
}

function dependencyFreeNode(): string {
  const root = temporary('cso-adversarial-node-');
  writeTree(root, {
    'package.json': { name: 'app', version: '1.0.0' },
    'package-lock.json': { name: 'app', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'app', version: '1.0.0' } } },
  });
  return root;
}

async function prepareWithLink(linkTarget: string) {
  const snapshot = dependencyFreeNode(), plan = inspectPreparation(snapshot, 'node');
  expect(plan.status).toBe('ready');
  const admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
  const executor = new PreparationExecutor({ cache: cacheFixture(), runner: new PreparedSymlinkRunner(linkTarget) });
  const deadline = Date.now() + 60_000;
  const closure = await executor.acquire({ plan, admission, snapshot, deadline });
  return executor.prepareOffline({ plan, admission, snapshot, closure, deadline });
}

class ConcurrentAcquisitionRunner implements PreparationSandboxRunner {
  readonly qualification = qualification;
  readonly stagingRoots: string[] = [];
  private arrivals = 0;
  private release!: () => void;
  private readonly barrier = new Promise<void>(resolve => { this.release = resolve; });

  async acquire(request: PreparationAcquireRequest): Promise<AcquisitionReceipt> {
    this.stagingRoots.push(request.stagingRoot);
    this.arrivals++;
    if (this.arrivals === 2) this.release();
    await this.barrier;
    const stagingPath = 'cso-public/same-plan-0.archive';
    const target = path.join(request.stagingRoot, stagingPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, archiveBytes, { flag: 'wx', mode: 0o600 });
    const input = request.inputs[0].input;
    const hash = sha256(archiveBytes);
    const requestedUrl = input.url!;
    return {
      schemaVersion: 1, planHash: request.planHash, runtimeId: request.runtime.id, runtimeImage: request.runtime.image,
      platform: request.runtime.platform, deadlineEnforced: true,
      network: { mode: 'registry-restricted', allowedHosts: [...request.network.allowedHosts],
        contactedHosts: [new URL(requestedUrl).hostname], redirectVisibility: 'opaque-tls',
        dnsRebindingBlocked: true, credentialsMounted: false, sourceMounted: false, dockerSocketMounted: false },
      lifecycleScriptsExecuted: false, targetCodeExecuted: false, commands: commandReceipts(request.commands),
      artifacts: [{ inputIndex: request.inputs[0].index, stagingPath, installPath: 'node/0.tgz', sha256: hash,
        bytes: archiveBytes.length, requestedHost: new URL(requestedUrl).hostname, requestedUrl, resolvedUrl: null,
        registryResponseSha256: hash }],
    };
  }
  async prepareOffline(): Promise<never> { throw new Error('not used'); }
  disposePrepared():void{}
}

function oneDependencyNode(): string {
  const root = temporary('cso-adversarial-node-dependency-');
  writeTree(root, {
    'package.json': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } },
    'package-lock.json': { name: 'app', version: '1.0.0', lockfileVersion: 3, packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } },
      'node_modules/cookie': { name: 'cookie', version: '1.0.0',
        resolved: 'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz',
        integrity: `sha512-${sha512(archiveBytes)}` },
    } },
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CSO preparation adversarial regressions', () => {
  test('accepts a contained relative symlink in a prepared dependency tree', async () => {
    const prepared = await prepareWithLink('../lib/tool.js');
    expect(prepared.preparedManifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  for (const target of ['../../../outside.txt', '/etc/passwd']) {
    test(`rejects a prepared dependency symlink escaping through ${target.startsWith('/') ? 'an absolute target' : 'a relative target'}`, async () => {
      try {
        await prepareWithLink(target);
        throw new Error('expected escaping prepared-tree symlink to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(CsoError);
        expect((error as CsoError).code).toBe('UNSAFE_PATH');
      }
    });
  }

  test('rejects conflicting duplicate Node logical lock identities', () => {
    const root = temporary('cso-adversarial-node-conflict-');
    writeTree(root, {
      'package.json': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } },
      'package-lock.json': { name: 'app', version: '1.0.0', lockfileVersion: 3, packages: {
        '': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } },
        'node_modules/cookie': { name: 'cookie', version: '1.0.0',
          resolved: 'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz', integrity: `sha512-${sha512('first')}` },
        'node_modules/nested/node_modules/cookie': { name: 'cookie', version: '1.0.0',
          resolved: 'https://registry.npmjs.org/cookie/-/cookie-other-1.0.0.tgz', integrity: `sha512-${sha512('second')}` },
      } },
    });
    const plan = inspectPreparation(root, 'node');
    expect(plan.status).toBe('prerequisites');
    expect(plan.prerequisites[0]?.code).toBe('CONFLICTING_LOCK_IDENTITY');
    expect(plan.acquisition).toEqual([]);
  });

  test('rejects conflicting duplicate Bun logical lock identities', () => {
    const root = temporary('cso-adversarial-bun-conflict-');
    writeTree(root, {
      'package.json': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } },
      'bun.lock': { lockfileVersion: 1, workspaces: { '': { name: 'app', dependencies: { cookie: '1.0.0' } } }, packages: {
        first: ['cookie@1.0.0', 'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz', {}, `sha512-${sha512('first')}`],
        second: ['cookie@1.0.0', 'https://registry.npmjs.org/cookie/-/cookie-other-1.0.0.tgz', {}, `sha512-${sha512('second')}`],
      } },
    });
    const plan = inspectPreparation(root, 'bun');
    expect(plan.status).toBe('prerequisites');
    expect(plan.prerequisites[0]?.code).toBe('CONFLICTING_LOCK_IDENTITY');
    expect(plan.acquisition).toEqual([]);
  });

  test('gives concurrent acquisitions of the same plan non-colliding staging namespaces', async () => {
    const snapshot = oneDependencyNode(), plan = inspectPreparation(snapshot, 'node');
    expect(plan.status).toBe('ready');
    const admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
    const runner = new ConcurrentAcquisitionRunner();
    const executor = new PreparationExecutor({ cache: cacheFixture(), runner });
    const requests = [1, 2].map(() => executor.acquire({ plan, admission, snapshot, deadline: Date.now() + 60_000 }));
    const results = await Promise.allSettled(requests);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(new Set(runner.stagingRoots).size).toBe(2);
  });
});
