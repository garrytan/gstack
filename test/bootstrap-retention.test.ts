import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createBootstrapRetentionScope, registerBootstrapRetention } from './helpers/bootstrap-retention';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-retain-'));
  roots.push(root);
  const temporary = path.join(root, 'state');
  fs.mkdirSync(temporary);
  const scope = createBootstrapRetentionScope(temporary, path.join(root, 'durable'), 'run-1');
  return { root, temporary, scope };
}

function project(temporary: string) {
  const root = fs.mkdtempSync(path.join(temporary, 'skill-e2e-bs-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  const config = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'config'], { cwd: path.join(import.meta.dir, '..'), encoding: 'utf8', timeout: 5000 });
  expect(config.status).toBe(0);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', `include.path=${config.stdout.trim()}`, 'commit', '-qm', 'initial']]) {
    const result = spawnSync('git', args, { cwd: root, timeout: 5000 });
    expect(result.status, result.stderr.toString()).toBe(0);
  }
  return root;
}

function installed(root: string) {
  fs.writeFileSync(path.join(root, 'bun.lock'), '{"lockfileVersion":1,"fixture":"exact bytes"}\n');
  fs.writeFileSync(path.join(root, 'bun.lockb'), Buffer.from([0, 255, 37, 10]));
  const pkg = path.join(root, 'node_modules', '.store', 'synthetic');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"synthetic","version":"2.0.1"}\n');
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export const installed = true;\n');
  fs.symlinkSync('.store/synthetic', path.join(root, 'node_modules', 'synthetic'));
}

async function settled(retention: ReturnType<typeof registerBootstrapRetention>, root: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, detached: true, stdio: 'ignore' });
  children.push(child);
  retention.lifecycle.onSpawn(child.pid!);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGKILL');
  await exited;
  await retention.lifecycle.onSettled({ deadline: Date.now() + 1000, exited: true });
}

function register(root: string, scope: ReturnType<typeof createBootstrapRetentionScope>) {
  return registerBootstrapRetention(root, 'run-1', { env: scope.env, deadline: Date.now() + 10000 });
}

async function censusProcess(code: string) {
  const child = spawn(process.execPath, ['-e', `
    import * as fs from 'node:fs';
    import { dlopen } from 'bun:ffi';
    const libc = dlopen('libc.so.6', { prctl: { args: ['i32', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' } });
    function dumpable(value) { if (libc.symbols.prctl(4, value, 0, 0, 0) !== 0) throw new Error('prctl failed'); }
    ${code}
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { cwd: os.tmpdir(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  await processReady(child);
  return child;
}

function processReady(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('census process did not become ready')); }, 3000);
    const ready = () => { cleanup(); resolve(); };
    const exited = () => { cleanup(); reject(new Error('census process exited before readiness')); };
    const cleanup = () => { clearTimeout(timer); child.stdout!.off('data', ready); child.off('exit', exited); };
    child.stdout!.once('data', ready);
    child.once('exit', exited);
  });
}

test('paid scope creation preserves non-Linux behavior without inherited qualification authority', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '../scripts/test-paid-shards.ts'), 'utf8');
  const start = source.indexOf('  const bootstrapFile =');
  const end = source.indexOf('  let retentionFailed =', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  // The file shard and its case shards (W5c case-sharding) both get the owned scope.
  for (const [platform, key] of [['linux', 'test/skill-e2e-qa-workflow.test.ts'], ['darwin', 'test/skill-e2e-qa-workflow.test.ts'],
    ['linux', 'test/skill-e2e-qa-workflow.test.ts#qa-bootstrap']] as const) {
    const env: any = { GSTACK_BOOTSTRAP_RETENTION: 'ambient-unowned-scope', GSTACK_EVAL_DIR: '/owned/artifacts' };
    const logs: string[] = [];
    let created = 0;
    new Function('files', 'normalizeRelativePath', 'env', 'process', 'log', 'label', 'createBootstrapRetentionScope', 'childTmp', 'path', 'getProjectEvalDir', body)(
      [key], (file: string) => file, env, { platform, pid: 1 },
      (line: string) => logs.push(line), 'fixture', () => { created++; return { env: { GSTACK_BOOTSTRAP_RETENTION: 'new-owned-scope' } }; },
      '/owned/tmp', path, () => '/owned/default-artifacts',
    );
    expect(created).toBe(platform === 'linux' ? 1 : 0);
    expect(env.GSTACK_BOOTSTRAP_RETENTION).toBe(platform === 'linux' ? 'new-owned-scope' : undefined);
    expect(logs.length).toBe(platform === 'linux' ? 0 : 1);
    if (platform === 'darwin') expect(logs[0]).toContain('native behavior still runs without retained-dependency qualification');
  }
});

describe.skipIf(process.platform !== 'linux')('bootstrap attempt retention boundaries', () => {
  test('pre-existing same-uid nondumpable host process is not an attempt writer', async () => {
    const child = await censusProcess('dumpable(0);');
    expect(fs.statSync(`/proc/${child.pid}`).uid).toBe(process.getuid!());
    expect(() => fs.readlinkSync(`/proc/${child.pid}/cwd`)).toThrow('EACCES');
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    retention.cleanup();
    expect(fs.existsSync(root)).toBe(false);
    expect((await scope.cleanup(Date.now() + 1000)).complete).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(path.join(retention.artifact, 'evidence.json'), 'utf8'));
    expect(evidence.uninspectable.some((native: any) => native.pid === child.pid)).toBe(true);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });

  test.each(['new process', 'new denial', 'different lifetime'])('%s cannot inherit an unrelated process census exclusion', async scenario => {
    const child = scenario === 'new process' ? undefined : await censusProcess(scenario === 'different lifetime'
      ? 'dumpable(0);'
      : "process.stdin.once('data', () => { dumpable(0); console.log('changed'); });");
    const { temporary, scope } = fixture();
    if (scenario === 'different lifetime') {
      const data = JSON.parse(scope.env.GSTACK_BOOTSTRAP_RETENTION);
      data.uninspectable.find((native: any) => native.pid === child!.pid).start = '0';
      scope.env.GSTACK_BOOTSTRAP_RETENTION = JSON.stringify(data);
    }
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    if (scenario === 'different lifetime') await expect(settled(retention, root)).rejects.toThrow('writer census unavailable');
    else await settled(retention, root);
    if (scenario === 'new process') await censusProcess('dumpable(0);');
    if (scenario === 'new denial') {
      const ready = processReady(child!);
      child!.stdin!.write('change');
      await ready;
    }
    const receipt = retention.retain();
    expect(receipt.quiescent).toBe(false);
    expect(receipt.complete).toBe(false);
    expect(receipt.errors.join(' ')).toContain('writer census unavailable: EACCES');
    expect(() => retention.cleanup()).toThrow('writer census unavailable');
    expect(fs.existsSync(root)).toBe(true);
  });

  test.each(['cwd', 'writable descriptor', 'unreadable descriptor'])('escaped process with %s still prevents cleanup', async kind => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const child = await censusProcess(kind === 'cwd'
      ? `process.chdir(${JSON.stringify(root)});`
      : `const fd = fs.openSync(${JSON.stringify(path.join(root, 'bun.lock'))}, 'r+');`);
    const original = fs.readFileSync;
    const read = kind === 'unreadable descriptor' ? spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).startsWith(`/proc/${child.pid}/fdinfo/`)) throw Object.assign(new Error('denied owned descriptor'), { code: 'EACCES', syscall: 'read', path: file });
      return (original as any)(file, ...args);
    }) as any) : undefined;
    try {
      const receipt = retention.retain();
      expect(receipt.quiescent).toBe(false);
      expect(receipt.complete).toBe(false);
      expect(receipt.errors.join(' ')).toContain(kind === 'cwd' ? 'fixture process remains live' : kind === 'writable descriptor' ? 'fixture writer remains live' : 'writer census unavailable');
      expect(() => retention.cleanup()).toThrow();
      expect(fs.existsSync(root)).toBe(true);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally { read?.mockRestore(); }
  });

  test('pre-existing excluded lifetime is still inspected when it becomes readable', async () => {
    const child = await censusProcess("dumpable(0); process.stdin.once('data', file => { dumpable(1); fs.openSync(file.toString(), 'r+'); console.log('changed'); });");
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const ready = processReady(child);
    child.stdin!.write(path.join(root, 'bun.lock'));
    await ready;
    const receipt = retention.retain();
    expect(receipt.quiescent).toBe(false);
    expect(receipt.errors).toContain('fixture writer remains live');
    expect(fs.existsSync(root)).toBe(true);
  });

  test('scope creation cannot exclude writers of existing attempt state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-retain-'));
    roots.push(root);
    const temporary = path.join(root, 'state');
    fs.mkdirSync(temporary);
    fs.mkdirSync(path.join(temporary, 'skill-e2e-bs-existing'));
    expect(() => createBootstrapRetentionScope(temporary, path.join(root, 'durable'), 'run-1')).toThrow('empty temporary state');
  });

  test('scope creation makes temporary state private and later permission changes revoke it', async () => {
    const { temporary, scope } = fixture();
    expect(fs.statSync(temporary).uid).toBe(process.getuid!());
    expect(fs.statSync(temporary).mode & 0o777).toBe(0o700);
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    fs.chmodSync(temporary, 0o755);
    expect(() => register(root, scope)).toThrow('not privately owned');
    const receipt = retention.retain();
    expect(receipt.quiescent).toBe(false);
    expect(receipt.complete).toBe(false);
    expect(receipt.errors).toContain('temporary state is not privately owned');
    expect(fs.existsSync(root)).toBe(true);
    await expect(scope.cleanup(Date.now() + 1000)).rejects.toThrow('not privately owned');
  });

  test('scope creation rejects a foreign-owned temporary root before building exclusions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-retain-'));
    roots.push(root);
    const temporary = path.join(root, 'state');
    fs.mkdirSync(temporary);
    const original = fs.lstatSync;
    const stat = spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      const value = (original as any)(file, ...args);
      if (file === temporary) value.uid = process.getuid!() + 1;
      return value;
    }) as any);
    try {
      expect(() => createBootstrapRetentionScope(temporary, path.join(root, 'durable'), 'run-1')).toThrow('not privately owned');
      expect(fs.readdirSync(temporary)).toEqual([]);
    } finally { stat.mockRestore(); }
  });

  test('reusing a scope cannot baseline-exempt an unreadable process from its prior attempt', async () => {
    const { temporary, scope, root: outer } = fixture();
    const first = project(temporary);
    const retained = register(first, scope);
    installed(first);
    await settled(retained, first);
    await censusProcess(`process.chdir(${JSON.stringify(first)}); dumpable(0);`);
    expect(() => createBootstrapRetentionScope(temporary, path.join(outer, 'another-durable'), 'run-2')).toThrow('empty temporary state');
    const second = project(temporary);
    const retry = register(second, scope);
    installed(second);
    await expect(settled(retry, second)).rejects.toThrow('writer census unavailable');
    expect(retry.retain().quiescent).toBe(false);
    expect(() => retry.cleanup()).toThrow('writer census unavailable');
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });

  test('unreadable final census cannot retain an earlier quiescence claim', async () => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const original = fs.readdirSync;
    let censuses = 0;
    const read = spyOn(fs, 'readdirSync').mockImplementation(((file: any, ...args: any[]) => {
      if (file === '/proc' && ++censuses === 2) throw Object.assign(new Error('final census denied'), { code: 'EACCES' });
      return (original as any)(file, ...args);
    }) as any);
    try {
      const receipt = retention.retain();
      expect(censuses).toBe(2);
      expect(receipt.quiescent).toBe(false);
      expect(receipt.complete).toBe(false);
      expect(receipt.errors).toContain('final census denied');
      expect(fs.existsSync(root)).toBe(true);
    } finally { read.mockRestore(); }
  });

  test.each(['settled', 'still exiting'])('permission denial during kernel exit requires observed settlement: %s', async outcome => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const child = await censusProcess('');
    const originalRead = fs.readFileSync;
    const originalLink = fs.readlinkSync;
    let denied = false;
    let observations = 0;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const content = (originalRead as any)(file, ...args);
      if (file !== `/proc/${child.pid}/stat` || !denied) return content;
      const boundary = content.lastIndexOf(') ') + 2;
      const fields = content.slice(boundary).split(' ');
      fields[6] = String(Number(fields[6]) | 4);
      if (++observations > 1 && outcome === 'settled') fields[0] = 'Z';
      return content.slice(0, boundary) + fields.join(' ');
    }) as any);
    const link = spyOn(fs, 'readlinkSync').mockImplementation(((file: any, ...args: any[]) => {
      if (file === `/proc/${child.pid}/cwd`) {
        denied = true;
        throw Object.assign(new Error('exit transition denied'), { code: 'EACCES', syscall: 'readlink', path: file });
      }
      return (originalLink as any)(file, ...args);
    }) as any);
    try {
      const receipt = retention.retain();
      expect(observations).toBeGreaterThan(1);
      expect(receipt.quiescent).toBe(outcome === 'settled');
      expect(receipt.complete).toBe(outcome === 'settled');
      if (outcome !== 'settled') expect(receipt.errors.join(' ')).toContain('writer census unavailable');
    } finally { read.mockRestore(); link.mockRestore(); }
  });

  test('unreadable owned installation is never acknowledged as complete', async () => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const original = fs.openSync;
    const open = spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
      if (file === path.join(root, 'bun.lock')) throw Object.assign(new Error('owned lock denied'), { code: 'EACCES' });
      return (original as any)(file, ...args);
    }) as any);
    try {
      const receipt = retention.retain();
      expect(receipt.complete).toBe(false);
      expect(receipt.errors).toContain('owned lock denied');
      expect(() => retention.cleanup()).toThrow('owned lock denied');
      expect(fs.existsSync(root)).toBe(true);
      expect((await scope.cleanup(Date.now() + 1000)).removable).toBe(false);
    } finally { open.mockRestore(); }
  });

  test.each(['success', 'assertion failure'])('%s retains exact installation before fixture and shard cleanup', async outcome => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    let failure: unknown;
    try {
      try { if (outcome === 'assertion failure') throw new Error('original assertion'); }
      finally { retention.cleanup(); }
    } catch (error) { failure = error; }
    expect(String(failure)).toBe(outcome === 'success' ? 'undefined' : 'Error: original assertion');
    expect(fs.existsSync(root)).toBe(false);
    const result = await scope.cleanup(Date.now() + 1000);
    expect(result.complete).toBe(true);
    expect(result.removable).toBe(true);
    fs.rmSync(temporary, { recursive: true });
    expect(fs.readFileSync(path.join(retention.artifact, 'files', 'bun.lockb'))).toEqual(Buffer.from([0, 255, 37, 10]));
    expect(fs.readFileSync(path.join(retention.artifact, 'files', 'bun.lock'), 'utf8')).toContain('exact bytes');
    const evidence = JSON.parse(fs.readFileSync(path.join(retention.artifact, 'evidence.json'), 'utf8'));
    expect(evidence.entries.filter((entry: any) => entry.kind === 'file').map((entry: any) => entry.path).sort()).toEqual([
      'bun.lock', 'bun.lockb', 'node_modules/.store/synthetic/index.js', 'node_modules/.store/synthetic/package.json', 'package.json',
    ]);
    expect(evidence.entries.find((entry: any) => entry.kind === 'link').resolved).toBe('node_modules/.store/synthetic');
    expect(evidence.registration.native.settled).toBe(true);
    expect(evidence.registration.initial.gitHead.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(retention.artifact, 'files/node_modules/.store/synthetic/index.js'))).toBe(false);
    expect(fs.readFileSync(path.join(retention.artifact, 'files/node_modules/.store/synthetic/package.json'), 'utf8')).toContain('2.0.1');
  });

  test('both configured retry attempts retain distinct actual roots', async () => {
    const { temporary, scope } = fixture();
    const attempts: string[] = [];
    for (let retry = 0; retry <= 1; retry++) {
      const root = project(temporary);
      const retention = register(root, scope);
      attempts.push(retention.attempt);
      installed(root);
      await settled(retention, root);
      retention.cleanup();
    }
    expect(new Set(attempts).size).toBe(2);
    expect((await scope.cleanup(Date.now() + 1000)).receipts.map(receipt => receipt.attempt).sort()).toEqual(attempts.sort());
  });

  test.each(['success', 'assertion failure', 'scope absent success', 'scope absent assertion failure'])('registered qa-bootstrap body: %s preserves installation and work budget', async outcome => {
    const { temporary, scope } = fixture();
    const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-qa-workflow.test.ts'), 'utf8');
    const start = source.indexOf("  testConcurrentIfSelected('qa-bootstrap', async () => {");
    const end = source.indexOf('  }, JUDGE_MS);', start) + '  }, JUDGE_MS);'.length;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
    let callback: () => Promise<void>;
    let actualRoot = '';
    let retained: ReturnType<typeof registerBootstrapRetention>;
    const scoped = !outcome.startsWith('scope absent');
    const succeeds = !outcome.endsWith('assertion failure');
    let declaredBudget = 0;
    const runSkillTest = async (options: any) => {
      actualRoot = options.workingDirectory;
      expect(path.dirname(actualRoot)).toBe(temporary);
      expect(path.basename(actualRoot)).toStartWith('skill-e2e-bs-');
      expect(options.prompt).toContain('Install vitest: bun add -d vitest');
      expect(options.timeout).toBe(120000);
      expect(options.maxTurns).toBe(12);
      expect(options.nativeLifecycle).toBe(scoped ? retained.lifecycle : undefined);
      installed(actualRoot);
      if (succeeds) fs.writeFileSync(path.join(actualRoot, 'vitest.config.ts'), 'export default {};');
      if (scoped) await settled(retained, actualRoot);
      return { exitReason: 'success' };
    };
    const names = ['testConcurrentIfSelected', 'JUDGE_MS', 'fs', 'path', 'os', 'spawnSync', 'registerBootstrapRetention', 'process', 'runId', 'runSkillTest', 'logCost', 'recordE2E', 'evalCollector', 'expect'];
    new Function(...names, body)(
      (_id: string, run: () => Promise<void>, budget: number) => { callback = run; declaredBudget = budget; },
      120000, fs, path, { tmpdir: () => temporary }, spawnSync,
      (root: string, runId: string, options: { deadline: number }) => {
        retained = registerBootstrapRetention(root, runId, { ...options, env: scope.env });
        return retained;
      },
      { env: { EVALS_RUN_ID: 'run-1', ...(scoped ? scope.env : {}) } }, 'native-run-1', runSkillTest, () => {}, () => {}, {}, expect,
    );
    expect(declaredBudget).toBe(120000);
    if (succeeds) await callback!();
    else await expect(callback!()).rejects.toThrow();
    expect(fs.existsSync(actualRoot)).toBe(false);
    const receipt = await scope.cleanup(Date.now() + 1000);
    expect(receipt.complete).toBe(true);
    expect(receipt.receipts.length).toBe(scoped ? 1 : 0);
    fs.rmSync(temporary, { recursive: true });
    if (scoped) expect(fs.existsSync(path.join(retained!.artifact, 'ack.json'))).toBe(true);
    else expect(retained!).toBeUndefined();
  });

  test.each(['missing lock', 'missing graph', 'escaping link', 'copy failure', 'ack failure', 'root replacement', 'expired deadline'])('%s fails qualification without claiming complete evidence', async failure => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const deadline = Date.now() + (failure === 'expired deadline' ? 1500 : 10000);
    const retention = registerBootstrapRetention(root, 'run-1', { env: scope.env, deadline });
    installed(root);
    await settled(retention, root);
    if (failure === 'missing lock') for (const name of ['bun.lock', 'bun.lockb']) fs.unlinkSync(path.join(root, name));
    if (failure === 'missing graph') fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    if (failure === 'escaping link') fs.symlinkSync(os.tmpdir(), path.join(root, 'node_modules', 'escape'));
    if (failure === 'copy failure') fs.writeFileSync(path.join(retention.artifact, 'files'), 'not a directory');
    if (failure === 'ack failure') fs.mkdirSync(path.join(retention.artifact, 'ack.json.tmp'));
    if (failure === 'root replacement') { fs.renameSync(root, root + '-original'); fs.mkdirSync(root); }
    if (failure === 'expired deadline') {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
    }
    const receipt = retention.retain();
    expect(receipt.complete).toBe(false);
    expect(receipt.errors.length).toBeGreaterThan(0);
    expect(receipt.acknowledged).toBe(failure !== 'ack failure');
    if (failure === 'expired deadline') expect(receipt.errors).toContain('retention deadline expired');
    expect(fs.existsSync(root)).toBe(true);
    if (failure !== 'ack failure') expect(fs.existsSync(path.join(retention.artifact, 'evidence.json'))).toBe(true);
    expect(() => retention.cleanup()).toThrow();
    expect(fs.existsSync(root)).toBe(true);
    const fallback = await scope.cleanup(Date.now() + 1000);
    expect(fallback.complete).toBe(false);
    expect(fallback.removable).toBe(false);
  });

  test('wrong run, unowned root, replaced attempt registration and absent scope are rejected', async () => {
    const { temporary, scope, root: outer } = fixture();
    const root = project(temporary);
    expect(() => registerBootstrapRetention(root, 'wrong-run', { env: scope.env, deadline: Date.now() + 1000 })).toThrow('wrong');
    expect(() => registerBootstrapRetention(outer, 'run-1', { env: scope.env, deadline: Date.now() + 1000 })).toThrow('wrong');
    expect(() => registerBootstrapRetention(root, 'run-1', { env: {}, deadline: Date.now() + 1000 })).toThrow('runner-owned');
    const retention = register(root, scope);
    const registry = JSON.parse(scope.env.GSTACK_BOOTSTRAP_RETENTION).registry.path;
    const file = path.join(registry, retention.attempt + '.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.attempt = '../outside';
    fs.writeFileSync(file, JSON.stringify(data));
    await expect(scope.cleanup(Date.now() + 1000)).rejects.toThrow('wrong attempt');
  });

  test('live native writer cannot be acknowledged as quiescent', async () => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, detached: true, stdio: 'ignore' });
    children.push(child);
    retention.lifecycle.onSpawn(child.pid!);
    await expect(retention.lifecycle.onSettled({ deadline: Date.now(), exited: true })).rejects.toThrow('live');
    const receipt = retention.retain();
    expect(receipt.quiescent).toBe(false);
    expect(receipt.complete).toBe(false);
    expect(receipt.acknowledged).toBe(true);
    expect((await scope.cleanup(Date.now())).removable).toBe(false);
  });

  test('inventory mutation during capture is rejected and bounded partial evidence is acknowledged', async () => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const original = fs.readFileSync;
    let changed = false;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => {
      const content = (original as any)(...args);
      if (!changed && Buffer.isBuffer(content) && content.toString() === 'export const installed = true;\n') {
        changed = true;
        fs.writeFileSync(path.join(root, 'node_modules/.store/synthetic/index.js'), 'changed installed bytes');
      }
      return content;
    }) as any);
    try {
      const receipt = retention.retain();
      expect(changed).toBe(true);
      expect(receipt.complete).toBe(false);
      expect(receipt.acknowledged).toBe(true);
      expect(receipt.errors.join(' ')).toContain('changed');
    } finally { read.mockRestore(); }
  });

  test('artifact symlinks never receive package bytes and missing acknowledgment never passes cleanup', async () => {
    const { temporary, scope, root: outer } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const outside = path.join(outer, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(retention.artifact, 'files'));
    expect(retention.retain().complete).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(retention.artifact, 'ack.json'));
    fs.mkdirSync(path.join(retention.artifact, 'ack.json.tmp'));
    const result = await scope.cleanup(Date.now() + 1000);
    expect(result.complete).toBe(false);
    expect(result.removable).toBe(false);
  });

  test('runner fallback terminates the registered native after callback SIGKILL and keeps durable evidence', async () => {
    const { temporary, scope, root: outer } = fixture();
    const root = project(temporary);
    const script = path.join(outer, 'callback.ts');
    fs.writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import * as fs from 'node:fs';
      import { registerBootstrapRetention } from ${JSON.stringify(path.join(import.meta.dir, 'helpers/bootstrap-retention.ts'))};
      const r = registerBootstrapRetention(${JSON.stringify(root)}, 'run-1', {deadline: Date.now()+10000});
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {cwd:${JSON.stringify(root)},detached:true,stdio:'ignore'});
      r.lifecycle.onSpawn(child.pid!);
      fs.writeFileSync(${JSON.stringify(path.join(outer, 'ready.json'))}, JSON.stringify({artifact:r.artifact,pid:child.pid}));
      console.log('ready');
      setInterval(()=>{},1000);
    `);
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...scope.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('callback did not register')), 3000);
      child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('callback exited before registration')); });
    });
    installed(root);
    const saved = JSON.parse(fs.readFileSync(path.join(outer, 'ready.json'), 'utf8'));
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
    const result = await scope.cleanup(Date.now() + 2000);
    expect(result.complete, JSON.stringify(result.receipts)).toBe(true);
    expect(result.removable).toBe(true);
    fs.rmSync(temporary, { recursive: true });
    expect(fs.existsSync(path.join(saved.artifact, 'ack.json'))).toBe(true);
    expect(fs.readFileSync(path.join(saved.artifact, 'files/bun.lock'), 'utf8')).toContain('exact bytes');
  });
});
