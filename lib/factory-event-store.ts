import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reduceFactoryEvents, type FactoryEvent, type FactoryRunState } from './factory-core';

export interface FactoryEventEnvelope {
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: FactoryEvent;
}

export interface FactoryRunManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCount: number;
}

export interface FileFactoryEventStoreOptions {
  readonly rootDir: string;
  readonly now?: () => Date;
}

export class FileFactoryEventStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: FileFactoryEventStoreOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => new Date());
  }

  append(runId: string, event: FactoryEvent): FactoryEventEnvelope {
    return this.appendValidated(runId, event, () => {});
  }

  appendValidated(
    runId: string,
    event: FactoryEvent,
    validate: (current: readonly FactoryEventEnvelope[]) => void,
  ): FactoryEventEnvelope {
    assertSafeRunId(runId);
    if (event.runId !== runId) {
      throw new Error(`event runId '${event.runId}' does not match store runId '${runId}'`);
    }

    mkdirSync(this.runDir(runId), { recursive: true });

    return this.withRunLock(runId, () => {
      const current = this.readEnvelopes(runId);
      validate(current);
      rewriteCommittedEvents(this.eventsPath(runId), current);
      const timestamp = this.now().toISOString();
      const envelope: FactoryEventEnvelope = {
        sequence: current.length + 1,
        timestamp,
        event,
      };

      appendFileSync(this.eventsPath(runId), `${JSON.stringify(envelope)}\n`, 'utf-8');
      this.writeManifest(runId, timestamp, envelope.sequence);
      return envelope;
    });
  }

  readEvents(runId: string): FactoryEvent[] {
    return this.readEnvelopes(runId).map(envelope => envelope.event);
  }

  readEnvelopes(runId: string): FactoryEventEnvelope[] {
    assertSafeRunId(runId);
    const file = this.eventsPath(runId);
    const manifest = this.readManifest(runId);
    if (!existsSync(file)) {
      if (manifest) throw new Error(`Factory run manifest for '${runId}' exists without an event log`);
      return [];
    }

    const envelopes = manifest
      ? parseFactoryEventLog(readFileSync(file, 'utf-8'), { expectedCount: manifest.eventCount })
      : parseFactoryEventLog(readFileSync(file, 'utf-8'));
    for (const envelope of envelopes) {
      if (envelope.event.runId !== runId) {
        throw new Error(`Factory event log for '${runId}' contains event for '${envelope.event.runId}' at sequence ${envelope.sequence}`);
      }
    }
    return envelopes;
  }

  readState(runId: string): FactoryRunState {
    return reduceFactoryEvents(this.readEvents(runId));
  }

  readManifest(runId: string): FactoryRunManifest | null {
    assertSafeRunId(runId);
    const file = this.manifestPath(runId);
    if (!existsSync(file)) return this.recoverManifestFromEventLog(runId);
    const manifest = JSON.parse(readFileSync(file, 'utf-8')) as FactoryRunManifest;
    if (!isFactoryRunManifest(manifest, runId)) {
      throw new Error(`Factory run manifest for '${runId}' is invalid`);
    }
    return manifest;
  }

  listRunIds(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory() || !isSafeRunId(entry.name) || !existsSync(this.eventsPath(entry.name))) return false;
        try {
          if (this.readManifest(entry.name) === null) return false;
          const envelopes = this.readEnvelopes(entry.name);
          return envelopes.some(envelope => envelope.event.type === 'run_started');
        } catch {
          return false;
        }
      })
      .map(entry => entry.name)
      .sort();
  }

  runDir(runId: string): string {
    assertSafeRunId(runId);
    return join(this.rootDir, runId);
  }

  eventsPath(runId: string): string {
    return join(this.runDir(runId), 'events.jsonl');
  }

  manifestPath(runId: string): string {
    return join(this.runDir(runId), 'manifest.json');
  }

  private withRunLock<T>(runId: string, action: () => T): T {
    const lockDir = join(this.runDir(runId), 'events.lock');
    const start = Date.now();
    while (true) {
      try {
        mkdirSync(lockDir);
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'EEXIST') throw error;
        if (Date.now() - start > 5_000) {
          throw new Error(`Timed out acquiring factory event lock for '${runId}'`);
        }
        sleepSync(25);
      }
    }

    try {
      return action();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  private recoverManifestFromEventLog(runId: string): FactoryRunManifest | null {
    const eventsPath = this.eventsPath(runId);
    if (!existsSync(eventsPath)) return null;
    const envelopes = parseFactoryEventLog(readFileSync(eventsPath, 'utf-8'));
    if (envelopes.length === 0) return null;
    const manifest: FactoryRunManifest = {
      runId,
      createdAt: envelopes[0].timestamp,
      updatedAt: envelopes[envelopes.length - 1].timestamp,
      eventCount: envelopes.length,
    };
    this.writeManifestFile(runId, manifest);
    return manifest;
  }

  private writeManifest(runId: string, updatedAt: string, eventCount: number) {
    const existing = this.readManifest(runId);
    this.writeManifestFile(runId, {
      runId,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
      eventCount,
    });
  }

  private writeManifestFile(runId: string, manifest: FactoryRunManifest) {
    const manifestPath = this.manifestPath(runId);
    const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, manifestPath);
  }
}

export function parseFactoryEventLog(content: string, options: { readonly expectedCount?: number } = {}): FactoryEventEnvelope[] {
  const envelopes: FactoryEventEnvelope[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (options.expectedCount !== undefined && envelopes.length >= options.expectedCount) break;
    const line = lines[index].trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid factory event JSON on line ${index + 1}: ${(error as Error).message}`);
    }

    if (!isFactoryEventEnvelope(parsed)) {
      throw new Error(`Invalid factory event envelope on line ${index + 1}`);
    }
    if (parsed.sequence !== envelopes.length + 1) {
      throw new Error(`Invalid factory event sequence on line ${index + 1}: expected ${envelopes.length + 1}, got ${parsed.sequence}`);
    }
    envelopes.push(parsed);
  }

  if (options.expectedCount !== undefined && envelopes.length < options.expectedCount) {
    throw new Error(`Factory event log ended before manifest eventCount ${options.expectedCount}`);
  }

  return envelopes;
}

export function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) && !runId.includes('..');
}

export function assertSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) {
    throw new Error(`Unsafe factory run id '${runId}'`);
  }
}

function rewriteCommittedEvents(file: string, envelopes: readonly FactoryEventEnvelope[]): void {
  writeFileSync(file, envelopes.map(envelope => JSON.stringify(envelope)).join('\n') + (envelopes.length > 0 ? '\n' : ''), 'utf-8');
}

function isFactoryRunManifest(input: unknown, runId: string): input is FactoryRunManifest {
  if (!isObject(input)) return false;
  return input.runId === runId
    && typeof input.createdAt === 'string'
    && typeof input.updatedAt === 'string'
    && Number.isInteger(input.eventCount)
    && input.eventCount >= 0;
}

function isFactoryEventEnvelope(input: unknown): input is FactoryEventEnvelope {
  if (!input || typeof input !== 'object') return false;
  const record = input as Partial<FactoryEventEnvelope>;
  return Number.isInteger(record.sequence)
    && record.sequence > 0
    && typeof record.timestamp === 'string'
    && isFactoryEvent(record.event);
}

function isFactoryEvent(input: unknown): input is FactoryEvent {
  if (!input || typeof input !== 'object') return false;
  const event = input as Record<string, unknown>;
  if (typeof event.type !== 'string' || typeof event.runId !== 'string') return false;

  switch (event.type) {
    case 'run_started':
      return isRunPlan(event.plan, event.runId);
    case 'phase_started':
      return typeof event.phaseId === 'string';
    case 'phase_completed':
      return typeof event.phaseId === 'string' && (event.artifacts === undefined || isArtifactArray(event.artifacts));
    case 'gate_requested':
      return isGateRequest(event.gate);
    case 'gate_decision':
      return isGateDecision(event.decision);
    case 'artifact_created':
      return isArtifact(event.artifact);
    case 'risk_detected':
      return isRisk(event.risk);
    case 'run_completed':
      return isRunResult(event.result);
    case 'run_failed':
      return isFactoryError(event.error);
    default:
      return false;
  }
}

function isObject(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

function isRunPlan(input: unknown, eventRunId: string): boolean {
  if (!isObject(input)) return false;
  return input.runId === eventRunId
    && typeof input.workflow === 'string'
    && isFactoryMode(input.mode)
    && typeof input.goal === 'string'
    && (input.cwd === undefined || typeof input.cwd === 'string')
    && (input.repo === undefined || isRepoContext(input.repo))
    && (input.context === undefined || isObject(input.context))
    && isPolicy(input.policy)
    && Array.isArray(input.phases)
    && input.phases.every(isPlannedPhase)
    && isCapabilityArray(input.requiredCapabilities)
    && Array.isArray(input.expectedArtifacts)
    && input.expectedArtifacts.every(isArtifactExpectation)
    && Array.isArray(input.risks)
    && input.risks.every(isRisk);
}

function isRepoContext(input: unknown): boolean {
  if (!isObject(input)) return false;
  return (input.provider === undefined || ['github', 'gitlab', 'local'].includes(String(input.provider)))
    && (input.owner === undefined || typeof input.owner === 'string')
    && (input.name === undefined || typeof input.name === 'string')
    && (input.branch === undefined || typeof input.branch === 'string')
    && (input.baseBranch === undefined || typeof input.baseBranch === 'string');
}

function isPolicy(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.allowWrites === 'boolean'
    && typeof input.allowNetwork === 'boolean'
    && typeof input.allowBrowser === 'boolean'
    && typeof input.requireHumanForDestructive === 'boolean'
    && typeof input.maxParallelWriteTimelines === 'number'
    && Number.isInteger(input.maxParallelWriteTimelines)
    && isQuestionMode(input.defaultQuestionMode);
}

function isPlannedPhase(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && typeof input.title === 'string'
    && isAgentRole(input.role)
    && typeof input.objective === 'string'
    && isPhaseConcurrency(input.concurrency)
    && isCapabilityArray(input.requiredCapabilities)
    && Array.isArray(input.gates)
    && input.gates.every(isGateSpec)
    && Array.isArray(input.expectedArtifacts)
    && input.expectedArtifacts.every(isArtifactExpectation);
}

function isAgentRole(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && typeof input.title === 'string'
    && (input.prompt === undefined || typeof input.prompt === 'string');
}

function isGateSpec(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && typeof input.title === 'string'
    && typeof input.description === 'string'
    && ['human-decision', 'policy', 'verification'].includes(String(input.kind))
    && (input.failClosed === undefined || typeof input.failClosed === 'boolean');
}

function isArtifactExpectation(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.phaseId === 'string'
    && isArtifactKind(input.kind)
    && typeof input.required === 'boolean'
    && typeof input.description === 'string';
}

function isGateRequest(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && typeof input.phaseId === 'string'
    && typeof input.title === 'string'
    && typeof input.description === 'string'
    && (input.options === undefined || (Array.isArray(input.options) && input.options.every(option => typeof option === 'string')))
    && (input.recommendation === undefined || typeof input.recommendation === 'string');
}

function isGateDecision(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.gateId === 'string'
    && typeof input.decision === 'string'
    && (input.reason === undefined || typeof input.reason === 'string')
    && ['user', 'policy', 'adapter'].includes(String(input.decidedBy));
}

function isArtifact(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && isArtifactKind(input.kind)
    && typeof input.summary === 'string'
    && (input.phaseId === undefined || typeof input.phaseId === 'string')
    && (input.uri === undefined || typeof input.uri === 'string')
    && (input.path === undefined || typeof input.path === 'string')
    && (input.metadata === undefined || isObject(input.metadata));
}

function isArtifactArray(input: unknown): boolean {
  return Array.isArray(input) && input.every(isArtifact);
}

function isRisk(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && ['info', 'warning', 'blocking'].includes(String(input.severity))
    && typeof input.message === 'string'
    && typeof input.recommendation === 'string';
}

function isRunResult(input: unknown): boolean {
  if (!isObject(input)) return false;
  return ['completed', 'failed', 'cancelled'].includes(String(input.status))
    && typeof input.summary === 'string'
    && isArtifactArray(input.artifacts);
}

function isFactoryError(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.code === 'string'
    && typeof input.message === 'string'
    && (input.phaseId === undefined || typeof input.phaseId === 'string')
    && (input.retryable === undefined || typeof input.retryable === 'boolean');
}

function isCapabilityArray(input: unknown): boolean {
  return Array.isArray(input) && input.every(isCapabilityName);
}

function isFactoryMode(input: unknown): boolean {
  return ['plan-only', 'build', 'review', 'ship'].includes(String(input));
}

function isPhaseConcurrency(input: unknown): boolean {
  return ['serial', 'parallel-readonly', 'isolated-worktree'].includes(String(input));
}

function isQuestionMode(input: unknown): boolean {
  return ['pause', 'auto-recommend', 'fail-closed'].includes(String(input));
}

function isCapabilityName(input: unknown): boolean {
  return [
    'agent-session',
    'artifact-store',
    'browser',
    'ci',
    'filesystem',
    'git',
    'pull-request',
    'questions',
    'test-runner',
    'worktree',
  ].includes(String(input));
}

function isArtifactKind(input: unknown): boolean {
  return [
    'browser-trace',
    'design-doc',
    'diff',
    'plan',
    'pr',
    'qa-report',
    'release-note',
    'review',
    'screenshot',
    'test-result',
  ].includes(String(input));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
