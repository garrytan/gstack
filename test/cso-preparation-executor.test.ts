import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { PublicArchiveCache } from '../lib/cso/cache';
import { CsoError } from '../lib/cso/contracts';
import { inspectPreparation, type CsoStack } from '../lib/cso/preparation';
import {
  admitPreparationRuntime, admitPreparationSidecar, PreparationExecutor,
  type AcquisitionReceipt, type OfflinePreparationReceipt, type PreparationAcquireRequest,
  type PreparationSandboxRunner, type OfflinePreparationRequest,
} from '../lib/cso/preparation-executor';
import { CSO_HELPER_ABI } from '../lib/cso/runtime-catalog';
import { DockerPreparationSandboxRunner, isBlockedRegistryAddress, RegistryEgressBroker } from '../lib/cso/preparation-docker';
import { completeRuntimeCatalogFixture, qualifiedRuntimeFixture } from './helpers/cso-runtime-catalog';

const roots: string[] = [];
const digest = 'a'.repeat(64);
const artifactBytes = (stack: CsoStack) => Buffer.from(`${stack}-verified-public-archive`);
const h256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const h512 = (value: Buffer | string) => createHash('sha512').update(value).digest('base64');

function root(prefix: string): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(value); return value; }
function writeTree(base: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(base, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  }
}
function snapshot(stack: CsoStack): string {
  const base = root(`cso-executor-${stack}-`), bytes = artifactBytes(stack);
  if (stack === 'node') writeTree(base, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' }, scripts: { postinstall: 'touch /tmp/unsafe' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3, packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } },
      'node_modules/cookie': { name: 'cookie', version: '1.0.0', resolved: 'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz', integrity: `sha512-${h512(bytes)}` },
    } }),
  });
  if (stack === 'bun') writeTree(base, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { cookie: '1.0.0' } }),
    'bun.lock': JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'app', dependencies: { cookie: '1.0.0' } } },
      packages: { cookie: ['cookie@1.0.0', 'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz', {}, `sha512-${h512(bytes)}`] } }),
  });
  if (stack === 'python') writeTree(base, { 'requirements.txt': `flask==3.1.0 --hash=sha256:${h256(bytes)}\n` });
  if (stack === 'rails') writeTree(base, {
    'Gemfile': 'source "https://rubygems.org"\ngem "rack"\ngem "sqlite3"\ngem "pg"\n',
    'Gemfile.lock': `GEM\n  remote: https://rubygems.org/\n  specs:\n    pg (1.5.9)\n    rack (3.1.8)\n    sqlite3 (2.5.0-x86_64-linux-gnu)\n\nPLATFORMS\n  ruby\n  x86_64-linux-gnu\n\nDEPENDENCIES\n  pg\n  rack\n  sqlite3\n\nRUBY VERSION\n   ruby 3.3.6p108\n\nBUNDLED WITH\n   2.6.9\n`,
  });
  return base;
}

function runtime(stack: CsoStack | 'postgresql') { return qualifiedRuntimeFixture(stack); }
function catalog(..._stacks: Array<CsoStack | 'postgresql'>) { return completeRuntimeCatalogFixture('executor-test-v1'); }
function cacheFixture() {
  const base = root('cso-executor-cache-'), staging = path.join(base, 'staging'); fs.mkdirSync(staging, { mode: 0o700 });
  return new PublicArchiveCache({ root: path.join(base, 'cache'), stagingRoot: staging, maxBytes: 1024 * 1024 });
}
// Match the helper's stable-key canonicalization without importing an internal helper.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function receipts(commands: PreparationAcquireRequest['commands']) {
  return commands.map((command, index) => ({ index, commandHash: h256(canonical(command)), exitCode: 0, timedOut: false, outputTruncated: false }));
}

class FakeRunner implements PreparationSandboxRunner {
  readonly qualification = { schemaVersion: 1 as const, helperAbi: CSO_HELPER_ABI, runnerId: 'fake-qualified-runner',
    policyVersion: 'cso-preparation-v1' as const, supportedStacks: ['node', 'bun', 'python', 'rails'] as CsoStack[],
    registryRestrictionQualified: true as const, dnsRebindingTestsPassed: true as const, acquisitionExcludesSource: true as const,
    offlineContainmentQualified: true as const, immutableArchiveMounts: true as const, resourceLimitsEnforced: true as const };
  acquireCalls = 0;
  prepareCalls = 0;
  acquireRequests: PreparationAcquireRequest[] = [];
  offlineRequests: OfflinePreparationRequest[] = [];
  mutateAcquisition?: (receipt: AcquisitionReceipt) => void;
  mutatePrepared?: (preparedRoot:string) => void;
  disposed:string[]=[];
  beforePrepare?: (request: OfflinePreparationRequest) => void;
  bytes?: Buffer;

  async acquire(request: PreparationAcquireRequest): Promise<AcquisitionReceipt> {
    this.acquireCalls++; this.acquireRequests.push(request);
    const artifacts = [] as AcquisitionReceipt['artifacts'];
    const seen = new Set<string>();
    for (const { index, input } of request.inputs) {
      const key = `${input.name}\0${input.version}`; if (seen.has(key)) continue; seen.add(key);
      const bytes = this.bytes ?? artifactBytes(request.stack), stagingPath = `${request.stack}-${index}.archive`;
      fs.writeFileSync(path.join(request.stagingRoot, stagingPath), bytes, { mode: 0o600 });
      const requestedUrl = input.url ?? (request.stack === 'rails'
        ? `https://rubygems.org/gems/${input.name}-${input.version}.gem`
        : `https://${request.network.allowedHosts[0]}/packages/${input.name}-${input.version}.archive`);
      const requestedHost = new URL(requestedUrl).hostname, hash = h256(bytes);
      artifacts.push({ inputIndex: index, stagingPath, installPath: `${request.stack}/${input.name}-${input.version}.archive`,
        sha256: hash, bytes: bytes.length, requestedHost, requestedUrl, resolvedUrl: null, registryResponseSha256: hash });
    }
    const receipt: AcquisitionReceipt = { schemaVersion: 1, planHash: request.planHash, runtimeId: request.runtime.id,
      runtimeImage: request.runtime.image, platform: request.runtime.platform, deadlineEnforced: true,
      network: { mode: 'registry-restricted', allowedHosts: [...request.network.allowedHosts],
        contactedHosts: [...new Set(artifacts.map(item => item.requestedHost))], redirectVisibility: 'opaque-tls', dnsRebindingBlocked: true,
        credentialsMounted: false, sourceMounted: false, dockerSocketMounted: false },
      lifecycleScriptsExecuted: false, targetCodeExecuted: false, commands: receipts(request.commands), artifacts };
    this.mutateAcquisition?.(receipt);
    return receipt;
  }

  async prepareOffline(request: OfflinePreparationRequest) {
    this.prepareCalls++; this.offlineRequests.push(request);
    this.beforePrepare?.(request);
    for (const archive of request.archives) {
      expect(fs.existsSync(archive.hostPath)).toBe(true);
      expect(h256(fs.readFileSync(archive.hostPath))).toBe(archive.sha256);
    }
    const preparedRoot = root(`cso-prepared-${request.stack}-`);
    fs.cpSync(request.sourceRoot, preparedRoot, { recursive: true });
    for (const file of request.transformations) {
      const target = path.join(preparedRoot, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content);
    }
    const dependencyRoot = request.stack === 'python' ? '.venv' : request.stack === 'rails' ? 'vendor/bundle' : 'node_modules';
    fs.mkdirSync(path.join(preparedRoot, dependencyRoot), { recursive: true });
    fs.writeFileSync(path.join(preparedRoot, dependencyRoot, '.cso-dependencies'), request.dependencyClosureHash, { mode: 0o600 });
    this.mutatePrepared?.(preparedRoot);
    const services: Array<'application' | 'postgresql'> = ['application'];
    const receipt: OfflinePreparationReceipt = { schemaVersion: 1, planHash: request.planHash, runtimeId: request.runtime.id,
      runtimeImage: request.runtime.image, platform: request.runtime.platform, sourceHash: request.sourceHash,
      dependencyClosureHash: request.dependencyClosureHash, configurationHash: request.configurationHash,
      databaseHash: request.databaseHash, deadlineEnforced: true,
      network: { mode: 'none', namespaceAnchor: 'fake-network-anchor', externalEgress: false, dnsAvailable: false,
        publishedPorts: false, services }, commands: receipts(request.commands), inputSourceReadOnly: true,
      preparedCopySeparate: true, archivesReadOnly: true, applicationCodeExecutedOnlyOffline: true };
    return { preparedRoot, receipt };
  }
  disposePrepared(preparedRoot:string):void{this.disposed.push(preparedRoot);fs.rmSync(preparedRoot,{recursive:true,force:true});}
}

function errorCode(error: unknown): string | undefined { return error instanceof CsoError ? error.code : undefined; }
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe('CSO constrained dependency preparation executor', () => {
  test('the unqualified default catalog and forged admissions fail closed', async () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), runner = new FakeRunner(), cache = cacheFixture();
    expect(() => admitPreparationRuntime({ plan, platform: 'linux/amd64' })).toThrow('MISSING_QUALIFIED_RUNTIME');
    const executor = new PreparationExecutor({ cache, runner });
    try {
      await executor.acquire({ plan, admission: { schemaVersion: 1, catalogRevision: 'forged', runtime: runtime('node') },
        snapshot: source, deadline: Date.now() + 60_000 });
      throw new Error('expected forged admission to fail');
    } catch (error) { expect(errorCode(error)).toBe('PREREQUISITE'); }
    expect(runner.acquireCalls).toBe(0);
  });

  for (const stack of ['node', 'bun', 'python', 'rails'] as const) test(`${stack} acquisition is registry-restricted and target setup is offline`, async () => {
    const source = snapshot(stack), plan = inspectPreparation(source, stack); expect(plan.status).toBe('ready');
    const admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog(stack) });
    const runner = new FakeRunner(), cache = cacheFixture(), executor = new PreparationExecutor({ cache, runner });
    const deadline = Date.now() + 60_000;
    const closure = await executor.acquire({ plan, admission, snapshot: source, deadline });
    expect(closure.archives.length).toBeGreaterThan(0);
    expect(cache.get(closure.archives[0].sha256)?.bytes).toBe(artifactBytes(stack).length);
    expect(runner.acquireRequests[0].sourceMounted).toBe(false);
    expect('sourceRoot' in runner.acquireRequests[0]).toBe(false);
    expect(runner.acquireRequests[0].network.allowedHosts).toEqual(plan.registryHosts);

    const reused = await executor.acquire({ plan, admission, snapshot: source, deadline, offline: true, existingClosure: closure });
    expect(reused.closureHash).toBe(closure.closureHash); expect(runner.acquireCalls).toBe(1);
    const prepared = await executor.prepareOffline({ plan, admission, snapshot: source, closure, deadline,
      database: stack === 'rails' ? { adapter: 'sqlite' } : undefined });
    expect(prepared.preparedRoot).not.toBe(source); expect(prepared.preparedManifestHash).toMatch(/^[a-f0-9]{64}$/);expect(prepared.preparedDependencyHash).toMatch(/^[a-f0-9]{64}$/);
    if (stack === 'rails') {
      expect(prepared.executionEnvironment).toMatchObject({ PATH: '/usr/local/bin:/usr/bin:/bin', BUNDLE_PATH: '/work/vendor/bundle', BUNDLE_FROZEN: 'true' });
      expect(prepared.executionEnvironment).not.toHaveProperty('RAILS_ENV');
      expect(prepared.executionEnvironment).not.toHaveProperty('RACK_ENV');
      expect(prepared.executionEnvironment).not.toHaveProperty('SECRET_KEY_BASE');
    }
    expect(prepared.receipt.network.mode).toBe('none'); expect(prepared.receipt.network.externalEgress).toBe(false);
    expect(runner.offlineRequests[0].archives.every(item => item.containerPath.startsWith('/archives/'))).toBe(true);
  });

  test('offline mode names the missing closure before invoking acquisition', async () => {
    const source = snapshot('python'), plan = inspectPreparation(source, 'python'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('python') });
    const runner = new FakeRunner(), executor = new PreparationExecutor({ cache: cacheFixture(), runner });
    try { await executor.acquire({ plan, admission, snapshot: source, deadline: Date.now() + 60_000, offline: true }); }
    catch (error) { expect(errorCode(error)).toBe('MISSING_INPUT'); }
    expect(runner.acquireCalls).toBe(0);
  });

  test('prepared dependency identity detects offline test-toolchain mutation',async()=>{
    const source=snapshot('node'),plan=inspectPreparation(source,'node'),admission=admitPreparationRuntime({plan,platform:'linux/amd64',catalog:catalog('node')}),runner=new FakeRunner(),executor=new PreparationExecutor({cache:cacheFixture(),runner}),deadline=Date.now()+60_000,closure=await executor.acquire({plan,admission,snapshot:source,deadline});
    const before=await executor.prepareOffline({plan,admission,snapshot:source,closure,deadline});runner.mutatePrepared=root=>fs.writeFileSync(path.join(root,'node_modules','.cso-dependencies'),'changed toolchain bytes');const after=await executor.prepareOffline({plan,admission,snapshot:source,closure,deadline});expect(after.preparedDependencyHash).not.toBe(before.preparedDependencyHash);
  });

  test('network-policy and exact-command receipt changes are rejected before promotion', async () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
    const runner = new FakeRunner(), cache = cacheFixture(), executor = new PreparationExecutor({ cache, runner });
    runner.mutateAcquisition = receipt => { receipt.network.contactedHosts.push('evil.invalid'); receipt.commands[0].commandHash = digest; };
    try { await executor.acquire({ plan, admission, snapshot: source, deadline: Date.now() + 60_000 }); }
    catch (error) { expect(errorCode(error)).toBe('ISOLATION_FAILED'); }
    expect(cache.stats().entries).toBe(0);
  });

  test('lock integrity is independently checked over staged bytes', async () => {
    const source = snapshot('bun'), plan = inspectPreparation(source, 'bun'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('bun') });
    const runner = new FakeRunner(); runner.bytes = Buffer.from('tampered-registry-response');
    try { await new PreparationExecutor({ cache: cacheFixture(), runner }).acquire({ plan, admission, snapshot: source, deadline: Date.now() + 60_000 }); }
    catch (error) { expect(errorCode(error)).toBe('INCOMPATIBLE_INPUT'); return; }
    throw new Error('expected mismatched lock integrity to fail');
  });

  test('every offline cache hit is rehashed and poison blocks reuse', async () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
    const runner = new FakeRunner(), cache = cacheFixture(), executor = new PreparationExecutor({ cache, runner }), deadline = Date.now() + 60_000;
    const closure = await executor.acquire({ plan, admission, snapshot: source, deadline });
    const hit = cache.get(closure.archives[0].sha256)!; fs.chmodSync(hit.path, 0o600); fs.writeFileSync(hit.path, 'poison'); fs.chmodSync(hit.path, 0o400);
    try { await executor.acquire({ plan, admission, snapshot: source, deadline, offline: true, existingClosure: closure }); }
    catch (error) { expect(errorCode(error)).toBe('INCOMPATIBLE_INPUT'); return; }
    throw new Error('expected poisoned cache reuse to fail');
  });

  test('threads cancellation into retained-closure cache verification', async () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
    const runner = new FakeRunner(), cache = cacheFixture(), executor = new PreparationExecutor({ cache, runner }), deadline = Date.now() + 60_000;
    const closure = await executor.acquire({ plan, admission, snapshot: source, deadline });
    const controller = new AbortController(), original = fs.readSync.bind(fs); let cacheReads = 0;
    const reader = spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView,
      offset: number, length: number, position: number | null) => {
      const read = original(fd, buffer, offset, length, position);
      if (length === 64 * 1024 && read > 0) { cacheReads++; controller.abort(); }
      return read;
    }) as typeof fs.readSync);
    try {
      await executor.acquire({ plan, admission, snapshot: source, deadline, signal: controller.signal, offline: true, existingClosure: closure });
      throw new Error('expected retained closure verification to be cancelled');
    } catch (error) { expect(errorCode(error)).toBe('CANCELLED'); }
    finally { reader.mockRestore(); }
    expect(cacheReads).toBe(1); expect(runner.acquireCalls).toBe(1);
  });

  test('cancels acquisition while independently hashing staged archive bytes', async () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
    const runner = new FakeRunner(), cache = cacheFixture(), executor = new PreparationExecutor({ cache, runner });
    const controller = new AbortController(), original = fs.readSync.bind(fs); let stagedReads = 0;
    const reader = spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView,
      offset: number, length: number, position: number | null) => {
      const read = original(fd, buffer, offset, length, position);
      if (length === 64 * 1024 && read > 0) { stagedReads++; controller.abort(); }
      return read;
    }) as typeof fs.readSync);
    try {
      await executor.acquire({ plan, admission, snapshot: source, deadline: Date.now() + 60_000, signal: controller.signal });
      throw new Error('expected staged archive verification to be cancelled');
    } catch (error) { expect(errorCode(error)).toBe('CANCELLED'); }
    finally { reader.mockRestore(); }
    expect(stagedReads).toBe(1); expect(runner.acquireCalls).toBe(1); expect(cache.stats().entries).toBe(0);
  });

  test('run-owned archive copies survive a cache eviction between validation and runner start', async () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: catalog('node') });
    const runner = new FakeRunner(), base = root('cso-eviction-race-'), staging = path.join(base, 'staging'); fs.mkdirSync(staging, { mode: 0o700 });
    const bytes = artifactBytes('node'), cache = new PublicArchiveCache({ root: path.join(base, 'cache'), stagingRoot: staging, maxBytes: bytes.length });
    const executor = new PreparationExecutor({ cache, runner }), deadline = Date.now() + 60_000;
    const closure = await executor.acquire({ plan, admission, snapshot: source, deadline });
    runner.beforePrepare = request => {
      expect(request.archives[0].hostPath).not.toBe(cache.get(closure.archives[0].sha256)?.path);
      const replacement = Buffer.alloc(bytes.length, 0x78), replacementPath = path.join(staging, 'replacement'); fs.writeFileSync(replacementPath, replacement, { mode: 0o600 });
      cache.promote('replacement', h256(replacement));
      expect(cache.get(closure.archives[0].sha256)).toBeUndefined();
    };
    const prepared = await executor.prepareOffline({ plan, admission, snapshot: source, closure, deadline });
    expect(prepared.dependencyClosureHash).toBe(closure.closureHash);
  });

  test('offline lifecycle source mutation fails closed and disposes the returned execution copy', async () => {
    const source=snapshot('node'),plan=inspectPreparation(source,'node'),admission=admitPreparationRuntime({plan,platform:'linux/amd64',catalog:catalog('node')}),runner=new FakeRunner(),executor=new PreparationExecutor({cache:cacheFixture(),runner}),deadline=Date.now()+60_000;
    const closure=await executor.acquire({plan,admission,snapshot:source,deadline});runner.mutatePrepared=prepared=>fs.writeFileSync(path.join(prepared,'package.json'),'{}');
    try{await executor.prepareOffline({plan,admission,snapshot:source,closure,deadline});throw new Error('expected lifecycle source mutation to fail');}
    catch(error){expect(errorCode(error)).toBe('ISOLATION_FAILED');}
    expect(runner.disposed).toHaveLength(1);expect(fs.existsSync(runner.disposed[0])).toBe(false);
  });

  test('Rails PostgreSQL requires and records a same-catalog qualified sidecar', async () => {
    const source = snapshot('rails'), plan = inspectPreparation(source, 'rails'), runtimes = catalog('rails', 'postgresql');
    const admission = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: runtimes });
    const sidecar = admitPreparationSidecar({ platform: 'linux/amd64', catalog: runtimes });
    const runner = new FakeRunner(), executor = new PreparationExecutor({ cache: cacheFixture(), runner }), deadline = Date.now() + 60_000;
    const closure = await executor.acquire({ plan, admission, snapshot: source, deadline });
    const prepared = await executor.prepareOffline({ plan, admission, snapshot: source, closure, deadline, database: { adapter: 'postgresql', sidecar } });
    expect(prepared.receipt.network.services).toEqual(['application']);
    expect(prepared.database).toEqual({ adapter: 'postgresql', connections: ['primary'],
      sidecar: { id: sidecar.runtime.id, image: sidecar.runtime.image } });
    expect(prepared.databaseHash).toBe(runner.offlineRequests[0].databaseHash);
    expect(runner.offlineRequests[0].database?.sidecar?.image).toContain('@sha256:');
  });

  test('the host registry broker rejects unallowlisted and private-address CONNECT requests', async () => {
    for (const [allowed, requested] of [['registry.npmjs.org', 'evil.invalid'], ['localhost', 'localhost']] as const) {
      let verified = false;
      // Bun 1.3.10 can transiently report ENOENT on the first Unix-socket
      // connect immediately after a verified listen when many shard processes
      // are creating sockets. Retry only that runtime transient against a new
      // private socket; every policy error and repeated ENOENT still fails.
      for (let attempt = 0; attempt < 3 && !verified; attempt++) {
        const base = root('cso-broker-'), socketPath = path.join(base, 'registry.sock');
        const broker = new RegistryEgressBroker(socketPath, [allowed], Date.now() + 30_000, 1024 * 1024);
        await broker.start();
        try {
          let reply: string;
          try {
            reply = await new Promise<string>((resolveReply, reject) => {
              const socket = net.createConnection({ path: socketPath }); let output = '';
              socket.setTimeout(5_000, () => socket.destroy(new Error('registry broker test connection timed out')));
              socket.once('connect', () => socket.write(`CONNECT ${requested}:443 HTTP/1.1\r\nHost: ${requested}:443\r\n\r\n`));
              socket.on('data', chunk => { output += chunk.toString(); }); socket.once('end', () => resolveReply(output)); socket.once('error', reject);
            });
          } catch (error: any) {
            if (error?.code === 'ENOENT' && attempt < 2) continue;
            throw error;
          }
          expect(reply).toContain('403 Forbidden');
          expect(() => broker.assertClean()).toThrow();
          expect(broker.contactedHosts.size).toBe(0);
          verified = true;
        } finally { await broker.close(); }
      }
      expect(verified).toBe(true);
    }
  });

  test('registry broker close cancels and joins a pending DNS task before removing its socket', async () => {
    const base = root('cso-broker-close-'), socketPath = path.join(base, 'registry.sock');
    let completeLookup!: (addresses: Array<{ address: string; family: 4 | 6 }>) => void, markLookup!: () => void, cancellations = 0;
    const lookupStarted = new Promise<void>(resolve => { markLookup = resolve; });
    const lookup = new Promise<Array<{ address: string; family: 4 | 6 }>>(resolve => { completeLookup = resolve; });
    const broker = new RegistryEgressBroker(socketPath, ['registry.npmjs.org'], Date.now() + 30_000, 1024 * 1024, () => {
      markLookup(); return { promise: lookup, cancel: () => { cancellations++; } };
    });
    await broker.start();
    const socket = net.createConnection({ path: socketPath }); socket.on('error', () => {});
    const socketClosed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    await new Promise<void>((resolveConnect, reject) => { socket.once('connect', resolveConnect); socket.once('error', reject); });
    socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
    await lookupStarted;
    await Promise.race([broker.close(), Bun.sleep(1_000).then(() => { throw new Error('broker close did not join cancelled DNS work'); })]);
    await Promise.race([socketClosed, Bun.sleep(1_000).then(() => { throw new Error('broker client socket remained open after close'); })]);
    expect(cancellations).toBe(1); expect(socket.destroyed).toBe(true); expect(fs.existsSync(socketPath)).toBe(false);
    completeLookup([{ address: '8.8.8.8', family: 4 }]); await Bun.sleep(10);
    expect(broker.contactedHosts.size).toBe(0);
  });

  test('registry broker bounds DNS resolution by the connection deadline', async () => {
    const base = root('cso-broker-deadline-'), socketPath = path.join(base, 'registry.sock'); let cancellations = 0;
    const broker = new RegistryEgressBroker(socketPath, ['registry.npmjs.org'], Date.now() + 250, 1024 * 1024,
      () => ({ promise: new Promise(() => {}), cancel: () => { cancellations++; } }));
    await broker.start();
    try {
      const reply = await new Promise<string>((resolveReply, reject) => {
        const socket = net.createConnection({ path: socketPath }); let output = '';
        socket.once('connect', () => socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n'));
        socket.on('data', chunk => { output += chunk.toString(); }); socket.once('end', () => resolveReply(output)); socket.once('error', reject);
      });
      expect(reply).toContain('403 Forbidden'); expect(cancellations).toBe(1); expect(() => broker.assertClean()).toThrow();
    } finally { await broker.close(); }
  });

  test('registry address classification rejects mapped, translated, private, and unspecified destinations', () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.2.3.4', '100.64.0.1'])
      expect(isBlockedRegistryAddress(address, 4)).toBe(true);
    for (const address of ['::', '::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1',
      '64:ff9b::7f00:1', '64:ff9b:1::a9fe:a9fe', '100::1', '2001:db8::1', '2002:7f00:1::',
      '3fff::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1'])
      expect(isBlockedRegistryAddress(address, 6)).toBe(true);
    expect(isBlockedRegistryAddress('8.8.8.8', 4)).toBe(false);
    expect(isBlockedRegistryAddress('2606:4700:4700::1111', 6)).toBe(false);
    expect(isBlockedRegistryAddress('not-an-address', 4)).toBe(true);
    expect(isBlockedRegistryAddress('127.0.0.1', 6)).toBe(true);
  });

  test('the concrete Docker runner requires the catalog-qualified container helper contract', () => {
    const source = snapshot('node'), plan = inspectPreparation(source, 'node'), withoutHelper = catalog('node');
    delete withoutHelper.runtimes[0].versions['cso-preparation'];
    expect(() => admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: withoutHelper })).toThrow('MISSING_RUNTIME_TOOL_VERSION');
    const withHelper = catalog('node');
    const admitted = admitPreparationRuntime({ plan, platform: 'linux/amd64', catalog: withHelper });
    const runner = new DockerPreparationSandboxRunner({ endpoint: {} as any, watchdogPath: '/missing', controlRoot: root('cso-docker-runner-'), admission: admitted });
    expect(runner.qualification).toMatchObject({ runnerId: 'docker-registry-broker-v1', registryRestrictionQualified: true, offlineContainmentQualified: true });
  });
});
