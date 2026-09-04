/**
 * Test-shard ownership bridge for processes that deliberately detach.
 *
 * GStack Browser must survive the short shell/agent invocation that starts it,
 * so production daemons use a new session. That same property lets a daemon
 * escape the free-test runner's process-group cleanup. The free runner injects
 * a private, per-shard append-only registry; detached browse processes record
 * only their process identity here. With no injected registry this module is a
 * strict no-op, preserving normal interactive persistence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TEST_PROCESS_REGISTRY_ENV = 'GSTACK_TEST_PROCESS_REGISTRY';
export const TEST_PROCESS_REGISTRY_ID_ENV = 'GSTACK_TEST_PROCESS_REGISTRY_ID';
export const TEST_PROCESS_REGISTRY_ROOT_ENV = 'GSTACK_TEST_PROCESS_REGISTRY_ROOT';
export const TEST_PROCESS_REGISTRY_FILE = '.gstack-detached-processes.jsonl';

export type TestShardProcessKind = 'browse-server' | 'chromium' | 'terminal-agent' | 'xvfb';

export interface TestShardProcessRegistryHeader {
  schema: 1;
  type: 'gstack-test-process-registry';
  runId: string;
  ownerPid: number;
}

export interface TestShardProcessRecord {
  schema: 1;
  type: 'process';
  runId: string;
  kind: TestShardProcessKind;
  pid: number;
  parentPid: number;
  processGroupId: number | null;
  processStartTime: string;
  port: number | null;
  stateFile: string | null;
  registeredAt: string;
}

export interface RegisterTestShardProcessInput {
  kind: TestShardProcessKind;
  pid: number;
  parentPid?: number;
  port?: number;
  stateFile?: string;
}

export interface RegisterTestShardDescendantsInput {
  kind: TestShardProcessKind;
  ancestorPid: number;
  port?: number;
  stateFile?: string;
}

export interface RegisterTestShardProcessDependencies {
  /** Test seam for simulating an unavailable POSIX identity probe. */
  readPsField?: (pid: number, field: 'lstart=' | 'pgid=') => string;
  /** Test seam for distinguishing a dead fake PID from a live unprovable PID. */
  isProcessAlive?: (pid: number) => boolean;
}

function readPsField(pid: number, field: 'lstart=' | 'pgid='): string {
  if (process.platform === 'win32') return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', field], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseHeader(raw: string): TestShardProcessRegistryHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== 1
    || candidate.type !== 'gstack-test-process-registry'
    || typeof candidate.runId !== 'string'
    || typeof candidate.ownerPid !== 'number'
  ) return null;
  return candidate as unknown as TestShardProcessRegistryHeader;
}

function resolveInjectedRegistry(env: NodeJS.ProcessEnv): {
  registryPath: string;
  runId: string;
} | null {
  const registryPath = env[TEST_PROCESS_REGISTRY_ENV];
  const runId = env[TEST_PROCESS_REGISTRY_ID_ENV];
  const registryRoot = env[TEST_PROCESS_REGISTRY_ROOT_ENV];
  if (!registryPath && !runId && !registryRoot) return null;
  if (!registryPath || !runId || !registryRoot) {
    throw new Error('incomplete GStack test process registry environment');
  }
  if (!path.isAbsolute(registryPath) || !path.isAbsolute(registryRoot)) {
    throw new Error('GStack test process registry paths must be absolute');
  }
  if (path.normalize(registryPath) !== path.join(path.normalize(registryRoot), TEST_PROCESS_REGISTRY_FILE)) {
    throw new Error('GStack test process registry path is outside its shard root');
  }

  const registryStat = fs.lstatSync(registryPath);
  if (!registryStat.isFile() || registryStat.isSymbolicLink()) {
    throw new Error('GStack test process registry is not a regular file');
  }
  const effectiveUid = process.geteuid?.() ?? process.getuid?.();
  if (effectiveUid !== undefined && registryStat.uid !== effectiveUid) {
    throw new Error('GStack test process registry has a different owner');
  }
  if ((registryStat.mode & 0o022) !== 0) {
    throw new Error('GStack test process registry is group/world writable');
  }
  const realRoot = fs.realpathSync(registryRoot);
  const realParent = fs.realpathSync(path.dirname(registryPath));
  if (realRoot !== realParent) {
    throw new Error('GStack test process registry parent changed identity');
  }

  const firstLine = fs.readFileSync(registryPath, 'utf8').split('\n', 1)[0] ?? '';
  const header = parseHeader(firstLine);
  if (!header || header.runId !== runId) {
    throw new Error('GStack test process registry header does not match this shard');
  }
  return { registryPath, runId };
}

/** Register one detached process when, and only when, the free runner owns it. */
export function registerTestShardProcess(
  input: RegisterTestShardProcessInput,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RegisterTestShardProcessDependencies = {},
): boolean {
  const registry = resolveInjectedRegistry(env);
  if (!registry) return false;
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error(`invalid test-owned ${input.kind} PID`);
  }
  if (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port <= 0 || input.port > 65_535)) {
    throw new Error(`invalid test-owned ${input.kind} port`);
  }

  const readIdentityField = dependencies.readPsField ?? readPsField;
  const processIsAlive = dependencies.isProcessAlive ?? isProcessAlive;
  const processStartTime = readIdentityField(input.pid, 'lstart=');
  if (process.platform !== 'win32' && !processStartTime) {
    // A mock or very short-lived child may already be gone. With no process
    // left to own, omitting the row is safe; a live/EPERM PID whose identity
    // cannot be proven must stop the shard instead of weakening cleanup.
    if (!processIsAlive(input.pid)) return false;
    throw new Error(`cannot prove test-owned ${input.kind} process start time`);
  }
  const processGroupRaw = readIdentityField(input.pid, 'pgid=');
  const processGroupId = /^\d+$/.test(processGroupRaw) ? Number.parseInt(processGroupRaw, 10) : null;
  if (process.platform !== 'win32' && processGroupId === null) {
    if (!processIsAlive(input.pid)) return false;
    throw new Error(`cannot prove test-owned ${input.kind} process group`);
  }
  // The supported bare Windows runner has no equivalent `ps` identity
  // surface. Its records intentionally carry an empty start time and null
  // group; parent cleanup branches to the per-shard run-id boundary there.
  const record: TestShardProcessRecord = {
    schema: 1,
    type: 'process',
    runId: registry.runId,
    kind: input.kind,
    pid: input.pid,
    parentPid: input.parentPid ?? process.ppid,
    processGroupId,
    processStartTime,
    port: input.port ?? null,
    stateFile: input.stateFile ? path.resolve(input.stateFile) : null,
    registeredAt: new Date().toISOString(),
  };

  const before = fs.lstatSync(registry.registryPath);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(
    registry.registryPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow,
  );
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('GStack test process registry changed during append');
    }
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Register matching descendants of a test-owned daemon. Playwright's public
 * Browser object does not expose `.process()` in every supported build, while
 * the OS child tree does. This fallback runs only under an injected test
 * registry, so production browser launches pay no process-census cost.
 */
export function registerTestShardDescendants(
  input: RegisterTestShardDescendantsInput,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!resolveInjectedRegistry(env) || process.platform === 'win32') return 0;
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.status !== 0) return 0;

  const rows: Array<{ pid: number; parentPid: number; command: string }> = [];
  for (const line of (result.stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1], 10),
      parentPid: Number.parseInt(match[2], 10),
      command: match[3],
    });
  }
  const descendants = new Set<number>([input.ancestorPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.parentPid) || descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  const matchesKind = (command: string): boolean => {
    switch (input.kind) {
      case 'chromium': return /(?:chrom(?:e|ium)|headless[_-]shell)/i.test(command);
      case 'terminal-agent': return /(?:^|[\\/])browse[\\/](?:src[\\/]terminal-agent\.ts|dist[\\/]terminal-agent)/.test(command);
      case 'xvfb': return /(?:^|[\\/])Xvfb(?:\s|$)/.test(command);
      case 'browse-server': return /(?:^|[\\/])browse[\\/](?:src[\\/]server\.ts|dist[\\/]server-node\.mjs)(?:\s|$)/.test(command);
    }
  };

  let registered = 0;
  for (const row of rows) {
    if (row.pid === input.ancestorPid || !descendants.has(row.pid) || !matchesKind(row.command)) continue;
    if (registerTestShardProcess({
      kind: input.kind,
      pid: row.pid,
      parentPid: row.parentPid,
      port: input.port,
      stateFile: input.stateFile,
    }, env)) registered += 1;
  }
  return registered;
}
