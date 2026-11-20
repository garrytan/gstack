import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

type Identity = { path: string; dev: number; ino: number };
type Native = { pid: number; start: string; group: number; settled: boolean; executable?: { path: string; sha256: string } };
type Scope = { runId: string; temporary: Identity; durable: Identity; registry: Identity; uninspectable: Native[] };
type Registration = { attempt: string; runId: string; deadline: number; root: Identity; artifact: Identity; owner: Native; native?: Native; initial: object };
type Entry = { path: string; kind: string; bytes?: number; sha256?: string; target?: string; resolved?: string };
export type BootstrapReceipt = { attempt: string; complete: boolean; acknowledged: boolean; quiescent: boolean; errors: string[]; artifact: string };

const scopeVariable = 'GSTACK_BOOTSTRAP_RETENTION';
const locks = ['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, target: string) => target.startsWith(root + path.sep);

function identity(file: string): Identity {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || fs.realpathSync(file) !== path.resolve(file)) throw new Error('noncanonical directory');
  return { path: path.resolve(file), dev: stat.dev, ino: stat.ino };
}

function verify(expected: Identity) {
  if (JSON.stringify(identity(expected.path)) !== JSON.stringify(expected)) throw new Error('directory identity changed');
}

function verifyPrivateTemporary(temporary: Identity) {
  verify(temporary);
  const stat = fs.lstatSync(temporary.path);
  if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error('temporary state is not privately owned');
}

function durableWrite(file: string, bytes: Buffer | string) {
  const fd = fs.openSync(file + '.tmp', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(file + '.tmp', file);
  const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function artifactDirectory(root: Identity, directory: string) {
  verify(root);
  let current = root.path;
  for (const part of path.relative(root.path, directory).split(path.sep)) {
    if (!part || part === '..') throw new Error('unsafe artifact directory');
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    identity(current);
  }
}

function readRegular(file: string, maximum = 8 * 1024 * 1024): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw new Error('file type or byte limit');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('file changed during capture');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function executableIdentity(file: string) {
  const resolved = fs.realpathSync(file);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error('toolchain identity unavailable');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let count: number;
    while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
    const after = fs.fstatSync(fd);
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('toolchain changed');
    return { path: resolved, sha256: hash.digest('hex'), dev: before.dev, ino: before.ino };
  } finally { fs.closeSync(fd); }
}

function nativeIdentity(pid: number): Native {
  if (process.platform !== 'linux') throw new Error('native lifetime qualification requires Linux procfs');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
  return { pid, start: stat[19], group: Number(stat[2]), settled: false };
}

function alive(native: Native): boolean {
  try { return nativeIdentity(native.pid).start === native.start; }
  catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
}

function exitedDuringCensus(pid: string, start: string, deadline: number) {
  const until = Math.min(deadline, Date.now() + 20);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    let stat: string[];
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' '); }
    catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; }
    if (stat[19] !== start) return false;
    if (stat[0] === 'Z' || stat[0] === 'X') return true;
    if (!(Number(stat[6]) & 4) || Date.now() >= until) return false;
    Atomics.wait(pause, 0, 0, 1);
  }
}

function quiet(scope: Scope, registration: Registration, deadline: number) {
  verifyPrivateTemporary(scope.temporary);
  if (!registration.native) throw new Error('native lifetime not registered');
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let stat: string[];
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' '); }
    catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw new Error('process census unavailable'); }
    if (stat[0] === 'Z' || stat[0] === 'X') continue;
    if (Number(stat[2]) === registration.native.group) throw new Error('native group remains live');
    if (Number(pid) === process.pid) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === registration.root.path || inside(registration.root.path, cwd)) throw new Error('fixture process remains live');
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (!inside(registration.root.path, target)) continue;
        const flags = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^flags:\s+(\d+)/m);
        if (!flags || (parseInt(flags[1], 8) & 3) !== 0) throw new Error('fixture writer remains live');
      }
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        if (exitedDuringCensus(pid, stat[19], deadline)) continue;
        if (scope.uninspectable.some(native => native.pid === Number(pid) && native.start === stat[19] && alive(native))) continue;
        throw new Error(`writer census unavailable: ${error.code} ${error.syscall} ${error.path}`);
      }
      throw error;
    }
  }
}

function loadScope(env: NodeJS.ProcessEnv): Scope {
  if (!env[scopeVariable]) throw new Error('bootstrap retention requires a runner-owned scope');
  const scope: Scope = JSON.parse(env[scopeVariable]!);
  verifyPrivateTemporary(scope.temporary); verify(scope.durable); verify(scope.registry);
  if (!inside(scope.temporary.path, scope.registry.path) || inside(scope.temporary.path, scope.durable.path)) throw new Error('invalid retention scope');
  return scope;
}

export function createBootstrapRetentionScope(temporaryRoot: string, durableRoot: string, runId: string) {
  const temporary = identity(temporaryRoot);
  if (fs.lstatSync(temporary.path).uid !== process.getuid!()) throw new Error('temporary state is not privately owned');
  fs.chmodSync(temporary.path, 0o700);
  verifyPrivateTemporary(temporary);
  if (fs.readdirSync(temporary.path).length) throw new Error('retention scope requires empty temporary state');
  const uninspectable: Native[] = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let native: Native | undefined;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      native = nativeIdentity(Number(pid));
      fs.readlinkSync(`/proc/${pid}/cwd`);
      fs.readdirSync(`/proc/${pid}/fd`);
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      if (!native || (error.code !== 'EACCES' && error.code !== 'EPERM')) throw error;
      if (alive(native)) uninspectable.push(native);
    }
  }
  if (path.resolve(durableRoot) === temporary.path || inside(temporary.path, path.resolve(durableRoot))) throw new Error('artifact root must survive temporary cleanup');
  fs.mkdirSync(durableRoot, { recursive: true, mode: 0o700 });
  const durable = fs.mkdtempSync(path.join(fs.realpathSync(durableRoot), 'bootstrap-'));
  fs.chmodSync(durable, 0o700);
  const registry = fs.mkdtempSync(path.join(fs.realpathSync(temporaryRoot), '.bootstrap-'));
  fs.chmodSync(registry, 0o700);
  if (inside(temporary.path, fs.realpathSync(durableRoot))) throw new Error('artifact root resolves into temporary state');
  const scope: Scope = { runId, temporary, durable: identity(durable), registry: identity(registry), uninspectable };
  return { env: { [scopeVariable]: JSON.stringify(scope) }, cleanup: (deadline: number) => cleanupBootstrapRetentions(scope, deadline) };
}

export function registerBootstrapRetention(root: string, runId: string, options: { deadline: number; env?: NodeJS.ProcessEnv }) {
  const scope = loadScope(options.env ?? process.env);
  if (!Number.isFinite(options.deadline) || options.deadline <= Date.now()) throw new Error('bootstrap deadline expired');
  const owned = identity(root);
  if (runId !== scope.runId || path.dirname(owned.path) !== scope.temporary.path || !path.basename(root).startsWith('skill-e2e-bs-')) throw new Error('wrong bootstrap root or run');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error('initial Git input unavailable');
    return result.stdout;
  };
  const attempt = randomUUID();
  const artifact = path.join(scope.durable.path, attempt);
  fs.mkdirSync(artifact, { mode: 0o700 });
  const gitStatus = git(['status', '--porcelain=v1']);
  if (gitStatus.trim()) throw new Error('initial Git inputs are not clean');
  const registration: Registration = {
    attempt, runId, deadline: options.deadline, root: owned, artifact: identity(artifact), owner: nativeIdentity(process.pid),
    initial: { package: readRegular(path.join(root, 'package.json')).toString('base64'),
      gitHead: git(['rev-parse', 'HEAD']), gitTree: git(['rev-parse', 'HEAD^{tree}']), gitFiles: git(['ls-files', '--stage']), gitStatus,
      bun: { version: Bun.version, ...executableIdentity(process.execPath) },
      nodeCompatibility: process.versions.node, externalNode: Bun.which('node') ? executableIdentity(Bun.which('node')!) : null,
      platform: process.platform, arch: process.arch },
  };
  const save = () => durableWrite(path.join(scope.registry.path, attempt + '.json'), JSON.stringify(registration));
  durableWrite(path.join(artifact, 'registration.json'), JSON.stringify(registration));
  save();
  return {
    attempt, artifact,
    lifecycle: {
      onSpawn(pid: number) {
        registration.native = nativeIdentity(pid);
        if (registration.native.group !== pid) throw new Error('native process is not group owner');
        const executable = fs.realpathSync(`/proc/${pid}/exe`);
        registration.native.executable = executableIdentity(executable);
        save();
        durableWrite(path.join(artifact, 'registration.json'), JSON.stringify(registration));
      },
      async onSettled(input: { deadline: number; exited: boolean }) {
        if (!input.exited) throw new Error('native exit was not observed');
        while (true) {
          try { quiet(scope, registration, input.deadline); break; }
          catch (error) {
            if (Date.now() >= input.deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(20, input.deadline - Date.now())));
          }
        }
        registration.native!.settled = true;
        save();
      },
    },
    retain() { return retain(scope, registration, false, options.deadline); },
    cleanup() {
      const receipt = retain(scope, registration, false, options.deadline);
      if (receipt.complete && receipt.acknowledged && receipt.quiescent) { verify(registration.root); fs.rmSync(root, { recursive: true }); }
      if (!receipt.complete || !receipt.acknowledged) throw new Error(`bootstrap retention failed: ${receipt.errors.join('; ')}`);
      return receipt;
    },
  };
}

function retain(scope: Scope, registration: Registration, fallback: boolean, ownerDeadline: number): BootstrapReceipt {
  if (!/^[0-9a-f-]{36}$/.test(registration.attempt)) throw new Error('wrong attempt');
  const artifact = path.join(scope.durable.path, registration.attempt);
  if (registration.artifact.path !== artifact) throw new Error('wrong artifact root');
  const receipt: BootstrapReceipt = { attempt: registration.attempt, complete: false, acknowledged: false, quiescent: false, errors: [], artifact };
  const entries: Entry[] = [];
  try {
    verify(scope.temporary); verify(scope.registry); verify(scope.durable); verify(registration.artifact);
    if (!/^[0-9a-f-]{36}$/.test(registration.attempt) || registration.runId !== scope.runId || path.dirname(registration.root.path) !== scope.temporary.path || !path.basename(registration.root.path).startsWith('skill-e2e-bs-')) throw new Error('wrong attempt or root');
    verify(registration.root);
    if (fallback && alive(registration.owner)) throw new Error('attempt owner remains live');
    const deadline = Math.min(registration.deadline, ownerDeadline);
    quiet(scope, registration, deadline);
    receipt.quiescent = true;
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error('retention deadline expired');
    if (!fallback && !registration.native?.settled) throw new Error('native settlement not acknowledged');
    let bytes = 0;
    const seen = new Set<string>();
    const visit = (relative: string, copy: boolean) => {
      if (seen.has(relative)) return;
      seen.add(relative);
      if (seen.size > 50000 || Date.now() > deadline) throw new Error('inventory limit exceeded');
      verify(registration.root);
      const file = path.join(registration.root.path, relative);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const resolved = fs.realpathSync(file);
        if (!inside(registration.root.path, resolved)) throw new Error('escaping installed link');
        const destination = path.relative(registration.root.path, resolved);
        if (!destination.startsWith('node_modules' + path.sep)) throw new Error('installed link leaves package tree');
        entries.push({ path: relative, kind: 'link', target, resolved: destination });
        visit(destination, false);
      } else if (stat.isDirectory()) {
        if (fs.realpathSync(file) !== file) throw new Error('directory link changed during capture');
        entries.push({ path: relative, kind: 'directory' });
        for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name), copy);
      } else {
        if (!stat.isFile() || fs.realpathSync(file) !== file) throw new Error('unsafe installed file');
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024) throw new Error('inventory byte limit exceeded');
        const content = readRegular(file, 64 * 1024 * 1024);
        entries.push({ path: relative, kind: 'file', bytes: content.length, sha256: digest(content) });
        if (copy || path.basename(file) === 'package.json') {
          const output = path.join(artifact, 'files', relative);
          artifactDirectory(registration.artifact, path.dirname(output));
          durableWrite(output, content);
          if (!fs.readFileSync(output).equals(content)) throw new Error('copy verification failed');
        }
      }
    };
    visit('package.json', true);
    const availableLocks = locks.filter(name => fs.existsSync(path.join(registration.root.path, name)));
    for (const lock of availableLocks) visit(lock, true);
    if (!availableLocks.length) receipt.errors.push('installed lock missing');
    if (!fs.existsSync(path.join(registration.root.path, 'node_modules'))) receipt.errors.push('installed graph missing');
    else visit('node_modules', false);
    if (!entries.some(entry => entry.path.startsWith('node_modules/') && entry.path.endsWith('/package.json'))) receipt.errors.push('installed manifests missing');
    for (const entry of entries) {
      const file = path.join(registration.root.path, entry.path);
      if (entry.kind === 'file' && digest(readRegular(file, 64 * 1024 * 1024)) !== entry.sha256) throw new Error('inventory changed');
      if (entry.kind === 'link' && (fs.readlinkSync(file) !== entry.target || path.relative(registration.root.path, fs.realpathSync(file)) !== entry.resolved)) throw new Error('link changed');
      if (entry.kind === 'directory') {
        const children = entries.filter(child => path.dirname(child.path) === entry.path).map(child => path.basename(child.path)).sort();
        if (JSON.stringify(fs.readdirSync(file).sort()) !== JSON.stringify(children)) throw new Error('inventory changed');
      }
      if (Date.now() > deadline) throw new Error('verification limit exceeded');
    }
    verify(registration.root);
    receipt.quiescent = false;
    quiet(scope, registration, deadline);
    receipt.quiescent = true;
    receipt.complete = receipt.errors.length === 0;
  } catch (error) { receipt.errors.push(error instanceof Error ? error.message : 'capture failed'); }
  try {
    verify(scope.durable); verify(registration.artifact);
    const evidence = JSON.stringify({ registration, fallback, receipt, entries, uninspectable: scope.uninspectable });
    durableWrite(path.join(artifact, fallback ? 'fallback-evidence.json' : 'callback-evidence.json'), evidence);
    durableWrite(path.join(artifact, 'evidence.json'), evidence);
    if (digest(fs.readFileSync(path.join(artifact, 'evidence.json'))) !== digest(evidence)) throw new Error('evidence readback failed');
    durableWrite(path.join(artifact, 'ack.json'), JSON.stringify({ attempt: registration.attempt, sha256: digest(evidence), complete: receipt.complete }));
    const ack = JSON.parse(fs.readFileSync(path.join(artifact, 'ack.json'), 'utf8'));
    receipt.acknowledged = ack.attempt === registration.attempt && ack.sha256 === digest(evidence);
  } catch { receipt.errors.push('durable acknowledgment failed'); receipt.complete = false; }
  return receipt;
}

async function cleanupBootstrapRetentions(scope: Scope, deadline: number) {
  verifyPrivateTemporary(scope.temporary);
  verify(scope.registry);
  const receipts: BootstrapReceipt[] = [];
  for (const name of fs.readdirSync(scope.registry.path).sort()) {
    if (!name.endsWith('.json')) throw new Error('unfinished bootstrap registration');
    const registration: Registration = JSON.parse(readRegular(path.join(scope.registry.path, name)).toString());
    if (!/^[0-9a-f-]{36}\.json$/.test(name) || name !== registration.attempt + '.json' || registration.runId !== scope.runId) throw new Error('wrong attempt registration');
    const artifact = path.join(scope.durable.path, registration.attempt);
    try {
      verify(scope.durable); verify(registration.artifact);
      if (registration.artifact.path !== artifact) throw new Error('wrong artifact root');
      const evidence = fs.readFileSync(path.join(artifact, 'evidence.json'));
      const ack = JSON.parse(readRegular(path.join(artifact, 'ack.json')).toString());
      if (ack.attempt !== registration.attempt || ack.sha256 !== digest(evidence)) throw new Error('invalid acknowledgment');
      const saved = JSON.parse(evidence.toString());
      if (JSON.stringify(saved.registration) !== JSON.stringify(registration)) throw new Error('registration changed');
      if (!saved.receipt.quiescent) throw new Error('previous retention did not establish quiescence');
      receipts.push({ ...saved.receipt, acknowledged: true });
    } catch {
      try {
        verify(scope.temporary); verify(scope.durable); verify(registration.artifact); verify(registration.root);
        const durableRegistration = JSON.parse(readRegular(path.join(artifact, 'registration.json')).toString());
        if (JSON.stringify(durableRegistration) !== JSON.stringify({ ...registration, native: registration.native && { ...registration.native, settled: false } })) throw new Error('native registration mismatch');
        if (alive(registration.owner)) throw new Error('attempt owner remains live');
        if (registration.native && alive(registration.native)) {
          if (nativeIdentity(registration.native.pid).group !== registration.native.pid) throw new Error('native group identity changed');
          process.kill(-registration.native.pid, 'SIGKILL');
        }
        while (Date.now() < deadline) {
          try { quiet(scope, registration, deadline); break; }
          catch { await new Promise(resolve => setTimeout(resolve, Math.min(20, deadline - Date.now()))); }
        }
      } catch {}
      receipts.push(retain(scope, registration, true, deadline));
    }
  }
  return { complete: receipts.every(receipt => receipt.complete), removable: receipts.every(receipt => receipt.complete && receipt.acknowledged && receipt.quiescent), receipts };
}
