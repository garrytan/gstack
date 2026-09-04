/**
 * Parent-side ownership for daemons intentionally detached by free tests.
 *
 * The shard child owns its normal process group; GStack Browser intentionally
 * calls setsid() and therefore escapes that group. A private registry bridges
 * the ownership boundary without changing production persistence. Cleanup is
 * identity-gated (PID + start time + command class), graceful first, and only
 * then escalates to exact recorded processes/groups.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  TEST_PROCESS_REGISTRY_ENV,
  TEST_PROCESS_REGISTRY_FILE,
  TEST_PROCESS_REGISTRY_ID_ENV,
  TEST_PROCESS_REGISTRY_ROOT_ENV,
  type TestShardProcessKind,
  type TestShardProcessRecord,
  type TestShardProcessRegistryHeader,
} from '../browse/src/test-shard-process-registry';

export interface TestShardProcessRegistryHandle {
  root: string;
  registryPath: string;
  runId: string;
}

export interface TestShardProcessCleanupReport {
  registered: number;
  gracefullyStoppedServers: number;
  termSignals: number;
  killSignals: number;
  identityMismatches: number;
  invalidRecords: number;
  survivors: number;
  unsafeGroups: number;
  success: boolean;
}

export interface TestShardProcessGroupMember {
  pid: number;
  parentPid: number;
  command: string;
}

export interface TestShardProcessCleanupDependencies {
  /** Test seam; production uses the fail-closed OS process-group census. */
  listGroupMembers?: (processGroupId: number) => TestShardProcessGroupMember[];
}

interface RegistryReadResult {
  records: TestShardProcessRecord[];
  invalidRecords: number;
}

const PROCESS_KINDS = new Set<TestShardProcessKind>([
  'browse-server',
  'chromium',
  'terminal-agent',
  'xvfb',
]);

function isPositivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown, runId: string): value is TestShardProcessRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.schema === 1
    && row.type === 'process'
    && row.runId === runId
    && typeof row.kind === 'string'
    && PROCESS_KINDS.has(row.kind as TestShardProcessKind)
    && isPositivePid(row.pid)
    && isPositivePid(row.parentPid)
    && (row.processGroupId === null || isPositivePid(row.processGroupId))
    && typeof row.processStartTime === 'string'
    && (row.port === null || (typeof row.port === 'number' && row.port > 0 && row.port <= 65_535))
    && (row.stateFile === null || typeof row.stateFile === 'string')
    && typeof row.registeredAt === 'string';
}

function readPsField(pid: number, field: 'lstart=' | 'command=' | 'pgid=' | 'ppid='): string {
  if (process.platform === 'win32') return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', field], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function readCommand(pid: number): string {
  if (process.platform !== 'darwin') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    } catch {
      // Fall through to ps on POSIX hosts without procfs.
    }
  }
  return readPsField(pid, 'command=');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function commandMatches(kind: TestShardProcessKind, command: string): boolean {
  switch (kind) {
    case 'browse-server':
      return /(?:^|[\\/])browse[\\/](?:src[\\/]server\.ts|dist[\\/]server-node\.mjs)(?:\s|$)/.test(command);
    case 'chromium':
      return /(?:chrom(?:e|ium)|headless[_-]shell)/i.test(command);
    case 'terminal-agent':
      return /(?:^|[\\/])browse[\\/](?:src[\\/]terminal-agent\.ts|dist[\\/]terminal-agent)/.test(command);
    case 'xvfb':
      return /(?:^|[\\/])Xvfb(?:\s|$)/.test(command);
  }
}

function stillOwns(record: TestShardProcessRecord): boolean {
  if (!isAlive(record.pid)) return false;
  // Windows has no portable `ps` start-time/cmdline surface in the supported
  // bare runner. The unguessable per-shard registry id plus immediate cleanup
  // is the ownership boundary there; POSIX additionally requires command,
  // process start time, and process-group identity to match.
  if (process.platform === 'win32') return true;
  if (!record.processStartTime || record.processGroupId === null) return false;
  const command = readCommand(record.pid);
  if (!commandMatches(record.kind, command)) return false;
  if (readPsField(record.pid, 'lstart=') !== record.processStartTime) return false;
  const currentProcessGroup = readPsField(record.pid, 'pgid=');
  if (!/^\d+$/.test(currentProcessGroup)) return false;
  if (Number.parseInt(currentProcessGroup, 10) !== record.processGroupId) return false;
  return true;
}

function signalPid(record: TestShardProcessRecord, signal: NodeJS.Signals): boolean {
  if (!stillOwns(record)) return false;
  try {
    process.kill(record.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function readRegistry(handle: TestShardProcessRegistryHandle): RegistryReadResult {
  const lines = fs.readFileSync(handle.registryPath, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('test process registry lost its header');

  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0]);
  } catch {
    throw new Error('test process registry header is malformed');
  }
  if (typeof headerValue !== 'object' || headerValue === null) {
    throw new Error('test process registry header is malformed');
  }
  const header = headerValue as Record<string, unknown>;
  if (header.schema !== 1 || header.type !== 'gstack-test-process-registry' || header.runId !== handle.runId) {
    throw new Error('test process registry header identity changed');
  }

  const records: TestShardProcessRecord[] = [];
  let invalidRecords = 0;
  for (const line of lines.slice(1)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidRecords += 1;
      continue;
    }
    if (!isRecord(value, handle.runId)) {
      invalidRecords += 1;
      continue;
    }
    records.push(value);
  }
  const unique = new Map<string, TestShardProcessRecord>();
  for (const record of records) {
    unique.set(`${record.kind}:${record.pid}:${record.processStartTime}`, record);
  }
  return { records: [...unique.values()], invalidRecords };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(records: TestShardProcessRecord[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (records.some(stillOwns) && Date.now() < deadline) {
    await sleep(50);
  }
}

function groupMembers(processGroupId: number): TestShardProcessGroupMember[] {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error instanceof Error
      ? result.error.message
      : `ps exited ${result.status ?? 'without a status'}`;
    throw new Error(`process-group census failed for PGID ${processGroupId}: ${reason}`);
  }
  const members: TestShardProcessGroupMember[] = [];
  for (const line of (result.stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number.parseInt(match[3], 10) !== processGroupId) continue;
    members.push({
      pid: Number.parseInt(match[1], 10),
      parentPid: Number.parseInt(match[2], 10),
      command: match[4],
    });
  }
  return members;
}

function trustedBrowseGroups(records: TestShardProcessRecord[]): Map<number, TestShardProcessRecord> {
  const trusted = new Map<number, TestShardProcessRecord>();
  for (const record of records) {
    if (
      record.kind === 'browse-server'
      && record.processGroupId === record.pid
      && stillOwns(record)
    ) {
      trusted.set(record.pid, record);
    }
  }
  return trusted;
}

/**
 * Take a final parent-side census of known daemon members in a process group whose
 * leader was already proven to be this shard's exact browse server. Chromium
 * can spawn helpers after the server's launch-time snapshot, and the watchdog
 * can replace a terminal agent during shutdown. PGID membership cannot cross
 * the server's setsid boundary, so this closes that late-child window without
 * looking at or targeting unrelated user browser sessions.
 */
function includeLateDaemonMembers(
  records: TestShardProcessRecord[],
  trustedGroups: Map<number, TestShardProcessRecord>,
  listGroupMembers: (processGroupId: number) => TestShardProcessGroupMember[] = groupMembers,
): TestShardProcessRecord[] {
  if (process.platform === 'win32' || trustedGroups.size === 0) return records;
  const unique = new Map<string, TestShardProcessRecord>();
  for (const record of records) {
    unique.set(`${record.kind}:${record.pid}:${record.processStartTime}`, record);
  }
  for (const [processGroupId, owner] of trustedGroups) {
    for (const member of listGroupMembers(processGroupId)) {
      if (records.some((record) => record.pid === member.pid)) continue;
      const kind: TestShardProcessKind | null = commandMatches('chromium', member.command)
        ? 'chromium'
        : commandMatches('terminal-agent', member.command) ? 'terminal-agent' : null;
      if (kind === null) continue;
      const processStartTime = readPsField(member.pid, 'lstart=');
      if (!processStartTime) continue;
      const record: TestShardProcessRecord = {
        schema: 1,
        type: 'process',
        runId: owner.runId,
        kind,
        pid: member.pid,
        parentPid: member.parentPid,
        processGroupId,
        processStartTime,
        port: owner.port,
        stateFile: owner.stateFile,
        registeredAt: new Date().toISOString(),
      };
      unique.set(`${record.kind}:${record.pid}:${record.processStartTime}`, record);
    }
  }
  return [...unique.values()];
}

function groupMemberAllowed(
  owner: TestShardProcessRecord,
  member: { pid: number; parentPid: number; command: string },
  records: TestShardProcessRecord[],
  trustedBrowseGroupIds: Set<number>,
): boolean {
  const recorded = records.find((record) => record.pid === member.pid && stillOwns(record));
  if (recorded) return true;
  // Playwright helpers are not individually exposed in every build and the
  // server watchdog may replace its terminal agent during shutdown. The exact
  // trusted server group plus this command allowlist closes both append races.
  return (owner.kind === 'chromium'
      || (owner.kind === 'browse-server'
        && owner.processGroupId !== null
        && trustedBrowseGroupIds.has(owner.processGroupId)))
    && (commandMatches('chromium', member.command) || commandMatches('terminal-agent', member.command));
}

function signalExactGroup(
  owner: TestShardProcessRecord,
  records: TestShardProcessRecord[],
  signal: NodeJS.Signals,
  trustedBrowseGroupIds: Set<number> = new Set(),
  listGroupMembers: (processGroupId: number) => TestShardProcessGroupMember[] = groupMembers,
): 'sent' | 'empty' | 'unsafe' {
  if (process.platform === 'win32' || owner.processGroupId === null || owner.processGroupId !== owner.pid) {
    return 'empty';
  }
  const members = listGroupMembers(owner.processGroupId);
  if (members.length === 0) return 'empty';
  if (!members.every((member) => groupMemberAllowed(owner, member, records, trustedBrowseGroupIds))) return 'unsafe';
  try {
    process.kill(-owner.processGroupId, signal);
    return 'sent';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'empty';
    throw error;
  }
}

export function createTestShardProcessRegistry(root: string): TestShardProcessRegistryHandle {
  const registryPath = path.join(root, TEST_PROCESS_REGISTRY_FILE);
  const runId = randomUUID();
  const header: TestShardProcessRegistryHeader = {
    schema: 1,
    type: 'gstack-test-process-registry',
    runId,
    ownerPid: process.pid,
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
  return { root, registryPath, runId };
}

export function registryEnvironment(handle: TestShardProcessRegistryHandle): NodeJS.ProcessEnv {
  return {
    [TEST_PROCESS_REGISTRY_ENV]: handle.registryPath,
    [TEST_PROCESS_REGISTRY_ID_ENV]: handle.runId,
    [TEST_PROCESS_REGISTRY_ROOT_ENV]: handle.root,
  };
}

/** Start graceful teardown as soon as the parent receives SIGINT/SIGTERM. */
export function signalRegisteredServersForCancellation(handle: TestShardProcessRegistryHandle): number {
  if (!fs.existsSync(handle.registryPath)) return 0;
  let sent = 0;
  for (const record of readRegistry(handle).records) {
    if (record.kind === 'browse-server' && signalPid(record, process.platform === 'win32' ? 'SIGTERM' : 'SIGINT')) {
      sent += 1;
    }
  }
  return sent;
}

/** Synchronous last resort for process `exit`, where awaiting is impossible. */
export function forceReapRegisteredProcessesSync(handle: TestShardProcessRegistryHandle): number {
  if (!fs.existsSync(handle.registryPath)) return 0;
  let { records } = readRegistry(handle);
  const trustedGroups = trustedBrowseGroups(records);
  records = includeLateDaemonMembers(records, trustedGroups);
  let sent = 0;
  for (const record of records) {
    if (signalPid(record, 'SIGKILL')) sent += 1;
  }
  for (const owner of records) {
    const result = signalExactGroup(owner, records, 'SIGKILL', new Set(trustedGroups.keys()));
    if (result === 'sent') sent += 1;
  }
  return sent;
}

export async function reapTestShardProcesses(
  handle: TestShardProcessRegistryHandle,
  dependencies: TestShardProcessCleanupDependencies = {},
): Promise<TestShardProcessCleanupReport> {
  const listGroupMembers = dependencies.listGroupMembers ?? groupMembers;
  let registry = readRegistry(handle);
  let records = registry.records;
  let invalidRecords = registry.invalidRecords;
  const trustedGroups = trustedBrowseGroups(records);
  records = includeLateDaemonMembers(records, trustedGroups, listGroupMembers);
  const initiallyLiveServers = records.filter((record) => record.kind === 'browse-server' && stillOwns(record));
  for (const server of initiallyLiveServers) {
    signalPid(server, process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
  }
  await waitFor(initiallyLiveServers, 2_500);
  const gracefullyStoppedServers = initiallyLiveServers.filter((record) => !stillOwns(record)).length;

  // A server may start its terminal agent while graceful shutdown is in
  // flight. Re-read the append-only registry before escalation.
  registry = readRegistry(handle);
  records = includeLateDaemonMembers(registry.records, trustedGroups, listGroupMembers);
  invalidRecords = Math.max(invalidRecords, registry.invalidRecords);
  let termSignals = 0;
  for (const record of records) {
    if (signalPid(record, 'SIGTERM')) termSignals += 1;
  }
  await waitFor(records, 750);

  registry = readRegistry(handle);
  records = includeLateDaemonMembers(registry.records, trustedGroups, listGroupMembers);
  invalidRecords = Math.max(invalidRecords, registry.invalidRecords);
  let killSignals = 0;
  let unsafeGroups = 0;
  for (const owner of records) {
    const result = signalExactGroup(
      owner,
      records,
      'SIGKILL',
      new Set(trustedGroups.keys()),
      listGroupMembers,
    );
    if (result === 'sent') killSignals += 1;
    if (result === 'unsafe') unsafeGroups += 1;
  }
  for (const record of records) {
    if (signalPid(record, 'SIGKILL')) killSignals += 1;
  }
  await waitFor(records, 750);

  const survivors = records.filter(stillOwns).length;
  const identityMismatches = records.filter((record) => isAlive(record.pid) && !stillOwns(record)).length;
  return {
    registered: records.length,
    gracefullyStoppedServers,
    termSignals,
    killSignals,
    identityMismatches,
    invalidRecords,
    survivors,
    unsafeGroups,
    success: survivors === 0 && unsafeGroups === 0 && identityMismatches === 0 && invalidRecords === 0,
  };
}
