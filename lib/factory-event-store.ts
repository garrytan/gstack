import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    assertSafeRunId(runId);
    if (event.runId !== runId) {
      throw new Error(`event runId '${event.runId}' does not match store runId '${runId}'`);
    }

    mkdirSync(this.runDir(runId), { recursive: true });

    return this.withRunLock(runId, () => {
      const current = this.readEnvelopes(runId);
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
    if (!existsSync(file)) return [];

    const envelopes = parseFactoryEventLog(readFileSync(file, 'utf-8'));
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
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as FactoryRunManifest;
  }

  listRunIds(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isSafeRunId(entry.name))
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

  private writeManifest(runId: string, updatedAt: string, eventCount: number) {
    const existing = this.readManifest(runId);
    const manifest: FactoryRunManifest = {
      runId,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
      eventCount,
    };
    writeFileSync(this.manifestPath(runId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }
}

export function parseFactoryEventLog(content: string): FactoryEventEnvelope[] {
  const envelopes: FactoryEventEnvelope[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
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
      return isObject(event.plan) && typeof (event.plan as { runId?: unknown }).runId === 'string';
    case 'phase_started':
      return typeof event.phaseId === 'string';
    case 'phase_completed':
      return typeof event.phaseId === 'string' && (event.artifacts === undefined || Array.isArray(event.artifacts));
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
  return !!input && typeof input === 'object';
}

function isGateRequest(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && typeof input.phaseId === 'string'
    && typeof input.title === 'string'
    && typeof input.description === 'string';
}

function isGateDecision(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.gateId === 'string'
    && typeof input.decision === 'string'
    && ['user', 'policy', 'adapter'].includes(String(input.decidedBy));
}

function isArtifact(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.id === 'string'
    && typeof input.kind === 'string'
    && typeof input.summary === 'string';
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
    && Array.isArray(input.artifacts);
}

function isFactoryError(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.code === 'string'
    && typeof input.message === 'string';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
