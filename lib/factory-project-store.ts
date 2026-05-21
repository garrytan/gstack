import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  FactoryProjectCatalog,
  FactoryProjectCockpitLayer,
  FactoryProjectExperienceMode,
  FactoryProjectRecord,
  FactoryProjectRunLink,
  FactoryWorkspaceRecord,
} from './factory-project';
import type { PolicySpec } from './factory-core';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type FactoryProjectRunLinkRelationship = NonNullable<FactoryProjectRunLink['relationship']>;

const RELATIONSHIP_VALUES: readonly FactoryProjectRunLinkRelationship[] = [
  'primary',
  'supporting',
  'qa-audit',
  'qa-fix',
  'ship-readiness',
];

const EXPERIENCE_MODES: readonly FactoryProjectExperienceMode[] = ['easy', 'hands-on'];
const COCKPIT_LAYERS: readonly FactoryProjectCockpitLayer[] = ['simple', 'detailed'];

export interface FactoryWorkspacePersistedRecord extends FactoryWorkspaceRecord {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FactoryProjectPersistedRecord extends FactoryProjectRecord {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FactoryProjectRunLinkPersisted extends FactoryProjectRunLink {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FactoryWorkspaceUpsert {
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerName?: string;
  readonly safetyDefaults?: Partial<PolicySpec>;
}

export interface FactoryProjectCreateInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly oneLineGoal: string;
  readonly experienceMode?: FactoryProjectExperienceMode;
  readonly cockpitLayer?: FactoryProjectCockpitLayer;
  readonly primaryRunId?: string;
}

export interface FactoryProjectUpdateInput {
  readonly name?: string;
  readonly oneLineGoal?: string;
  readonly experienceMode?: FactoryProjectExperienceMode;
  readonly cockpitLayer?: FactoryProjectCockpitLayer;
  readonly primaryRunId?: string | null;
  readonly workspaceId?: string;
}

export interface FactoryProjectRunLinkInput {
  readonly runId: string;
  readonly workflowId?: string;
  readonly relationship?: FactoryProjectRunLinkRelationship;
  readonly stage?: FactoryProjectRunLink['stage'];
  readonly bayId?: FactoryProjectRunLink['bayId'];
  readonly policy?: Partial<PolicySpec>;
}

export interface FileFactoryProjectStoreOptions {
  readonly rootDir: string;
  readonly now?: () => Date;
}

interface ProjectIndexEntry {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
}

interface ProjectFileShape {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly oneLineGoal: string;
  readonly experienceMode?: FactoryProjectExperienceMode;
  readonly cockpitLayer?: FactoryProjectCockpitLayer;
  readonly primaryRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RunLinkEnvelope {
  readonly op: 'upsert' | 'remove';
  readonly runId: string;
  readonly link?: FactoryProjectRunLink;
  readonly ts: string;
}

interface WorkspaceEnvelope {
  readonly op: 'upsert' | 'remove';
  readonly workspaceId: string;
  readonly record?: FactoryWorkspacePersistedRecord;
  readonly ts: string;
}

export class FileFactoryProjectStore implements FactoryProjectCatalog {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: FileFactoryProjectStoreOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => new Date());
  }

  // --- Workspaces ---------------------------------------------------------

  createWorkspace(input: FactoryWorkspaceUpsert): FactoryWorkspacePersistedRecord {
    assertSafeFactoryId(input.workspaceId, 'workspace');
    if (this.readWorkspace(input.workspaceId)) {
      throw new Error(`Factory workspace '${input.workspaceId}' already exists`);
    }
    const ts = this.now().toISOString();
    const record: FactoryWorkspacePersistedRecord = {
      workspaceId: input.workspaceId,
      name: input.name,
      ownerName: input.ownerName,
      safetyDefaults: input.safetyDefaults,
      createdAt: ts,
      updatedAt: ts,
    };
    this.appendWorkspaceEnvelope({ op: 'upsert', workspaceId: input.workspaceId, record, ts });
    return record;
  }

  upsertWorkspace(input: FactoryWorkspaceUpsert): FactoryWorkspacePersistedRecord {
    assertSafeFactoryId(input.workspaceId, 'workspace');
    const existing = this.readWorkspace(input.workspaceId);
    const ts = this.now().toISOString();
    const record: FactoryWorkspacePersistedRecord = {
      workspaceId: input.workspaceId,
      name: input.name,
      ownerName: input.ownerName,
      safetyDefaults: input.safetyDefaults,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.appendWorkspaceEnvelope({ op: 'upsert', workspaceId: input.workspaceId, record, ts });
    return record;
  }

  removeWorkspace(workspaceId: string): void {
    assertSafeFactoryId(workspaceId, 'workspace');
    if (!this.readWorkspace(workspaceId)) return;
    this.appendWorkspaceEnvelope({ op: 'remove', workspaceId, ts: this.now().toISOString() });
  }

  readWorkspace(workspaceId: string): FactoryWorkspacePersistedRecord | null {
    assertSafeFactoryId(workspaceId, 'workspace');
    return this.materializeWorkspaces().get(workspaceId) ?? null;
  }

  listWorkspaces(): readonly FactoryWorkspacePersistedRecord[] {
    return [...this.materializeWorkspaces().values()]
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }

  // --- Projects -----------------------------------------------------------

  createProject(input: FactoryProjectCreateInput): FactoryProjectPersistedRecord {
    assertSafeFactoryId(input.projectId, 'project');
    assertSafeFactoryId(input.workspaceId, 'workspace');
    if (this.readProjectFile(input.projectId)) {
      throw new Error(`Factory project '${input.projectId}' already exists`);
    }

    const ts = this.now().toISOString();
    const file: ProjectFileShape = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      name: input.name,
      oneLineGoal: input.oneLineGoal,
      experienceMode: assertEnumOrUndefined(input.experienceMode, EXPERIENCE_MODES, 'experienceMode'),
      cockpitLayer: assertEnumOrUndefined(input.cockpitLayer, COCKPIT_LAYERS, 'cockpitLayer'),
      primaryRunId: input.primaryRunId,
      createdAt: ts,
      updatedAt: ts,
    };

    mkdirSync(this.projectDir(input.projectId), { recursive: true });
    this.writeProjectFile(input.projectId, file);
    this.appendProjectIndexEntry({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      createdAt: ts,
    });

    return projectRecordFromFile(file, []);
  }

  updateProject(projectId: string, patch: FactoryProjectUpdateInput): FactoryProjectPersistedRecord {
    assertSafeFactoryId(projectId, 'project');
    const current = this.readProjectFile(projectId);
    if (!current) throw new Error(`Factory project '${projectId}' not found`);
    if (patch.workspaceId !== undefined) assertSafeFactoryId(patch.workspaceId, 'workspace');

    const ts = this.now().toISOString();
    const next: ProjectFileShape = {
      ...current,
      name: patch.name ?? current.name,
      oneLineGoal: patch.oneLineGoal ?? current.oneLineGoal,
      experienceMode: patch.experienceMode !== undefined
        ? assertEnumOrUndefined(patch.experienceMode, EXPERIENCE_MODES, 'experienceMode')
        : current.experienceMode,
      cockpitLayer: patch.cockpitLayer !== undefined
        ? assertEnumOrUndefined(patch.cockpitLayer, COCKPIT_LAYERS, 'cockpitLayer')
        : current.cockpitLayer,
      primaryRunId: patch.primaryRunId === null
        ? undefined
        : patch.primaryRunId ?? current.primaryRunId,
      workspaceId: patch.workspaceId ?? current.workspaceId,
      updatedAt: ts,
    };

    this.writeProjectFile(projectId, next);
    return projectRecordFromFile(next, this.materializeLinks(projectId));
  }

  readProject(projectId: string): FactoryProjectPersistedRecord | null {
    assertSafeFactoryId(projectId, 'project');
    const file = this.readProjectFile(projectId);
    if (!file) return null;
    return projectRecordFromFile(file, this.materializeLinks(projectId));
  }

  listProjects(workspaceId?: string): readonly FactoryProjectPersistedRecord[] {
    if (workspaceId !== undefined) assertSafeFactoryId(workspaceId, 'workspace');
    const indexed = this.readProjectIndex();
    const seen = new Set<string>();
    const records: FactoryProjectPersistedRecord[] = [];
    for (const entry of indexed) {
      if (seen.has(entry.projectId)) continue;
      seen.add(entry.projectId);
      const file = this.readProjectFile(entry.projectId);
      if (!file) continue; // index drift / unfinished create: degrade silently
      if (workspaceId !== undefined && file.workspaceId !== workspaceId) continue;
      records.push(projectRecordFromFile(file, this.materializeLinks(entry.projectId)));
    }
    return records.sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  // --- Run links ----------------------------------------------------------

  addRunLink(projectId: string, link: FactoryProjectRunLinkInput): FactoryProjectRunLinkPersisted {
    assertSafeFactoryId(projectId, 'project');
    assertSafeFactoryId(link.runId, 'run');
    if (link.relationship !== undefined && !RELATIONSHIP_VALUES.includes(link.relationship)) {
      throw new Error(`Unknown factory run link relationship '${link.relationship}'`);
    }
    const file = this.readProjectFile(projectId);
    if (!file) throw new Error(`Factory project '${projectId}' not found`);

    const existing = this.materializePersistedLinks(projectId).get(link.runId);
    const ts = this.now().toISOString();
    const persisted: FactoryProjectRunLinkPersisted = {
      runId: link.runId,
      workflowId: link.workflowId,
      relationship: link.relationship,
      stage: link.stage,
      bayId: link.bayId,
      policy: link.policy,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    const projectLink: FactoryProjectRunLink = {
      runId: persisted.runId,
      workflowId: persisted.workflowId,
      relationship: persisted.relationship,
      stage: persisted.stage,
      bayId: persisted.bayId,
      policy: persisted.policy,
    };
    this.appendLinkEnvelope(projectId, { op: 'upsert', runId: link.runId, link: projectLink, ts });
    return persisted;
  }

  removeRunLink(projectId: string, runId: string): void {
    assertSafeFactoryId(projectId, 'project');
    assertSafeFactoryId(runId, 'run');
    if (!this.readProjectFile(projectId)) {
      throw new Error(`Factory project '${projectId}' not found`);
    }
    if (!this.materializeLinks(projectId).some(existing => existing.runId === runId)) return;
    this.appendLinkEnvelope(projectId, { op: 'remove', runId, ts: this.now().toISOString() });
  }

  listRunLinks(projectId: string): readonly FactoryProjectRunLinkPersisted[] {
    assertSafeFactoryId(projectId, 'project');
    if (!this.readProjectFile(projectId)) return [];
    return [...this.materializePersistedLinks(projectId).values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  // --- Paths --------------------------------------------------------------

  projectsIndexPath(): string {
    return join(this.rootDir, 'projects.jsonl');
  }

  workspacesPath(): string {
    return join(this.rootDir, 'workspaces.jsonl');
  }

  projectDir(projectId: string): string {
    assertSafeFactoryId(projectId, 'project');
    return join(this.rootDir, projectId);
  }

  projectFilePath(projectId: string): string {
    return join(this.projectDir(projectId), 'project.json');
  }

  projectLinksPath(projectId: string): string {
    return join(this.projectDir(projectId), 'links.jsonl');
  }

  // --- Internal helpers ---------------------------------------------------

  private materializeWorkspaces(): Map<string, FactoryWorkspacePersistedRecord> {
    const path = this.workspacesPath();
    const result = new Map<string, FactoryWorkspacePersistedRecord>();
    if (!existsSync(path)) return result;
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const parsed = parseJson<WorkspaceEnvelope>(line, `workspaces.jsonl line ${index + 1}`);
      if (typeof parsed.workspaceId !== 'string') {
        throw new Error(`Factory workspaces log line ${index + 1} is missing workspaceId`);
      }
      if (parsed.op === 'remove') {
        result.delete(parsed.workspaceId);
        continue;
      }
      if (parsed.op !== 'upsert' || !parsed.record) {
        throw new Error(`Factory workspaces log line ${index + 1} is invalid`);
      }
      if (parsed.record.workspaceId !== parsed.workspaceId) {
        throw new Error(`Factory workspaces log line ${index + 1} has mismatched workspaceId`);
      }
      result.set(parsed.workspaceId, parsed.record);
    }
    return result;
  }

  private readProjectIndex(): readonly ProjectIndexEntry[] {
    const path = this.projectsIndexPath();
    if (!existsSync(path)) return [];
    const entries: ProjectIndexEntry[] = [];
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const parsed = parseJson<ProjectIndexEntry>(line, `projects.jsonl line ${index + 1}`);
      if (typeof parsed.projectId !== 'string' || typeof parsed.workspaceId !== 'string' || typeof parsed.createdAt !== 'string') {
        throw new Error(`Factory projects.jsonl line ${index + 1} is invalid`);
      }
      entries.push(parsed);
    }
    return entries;
  }

  private readProjectFile(projectId: string): ProjectFileShape | null {
    const file = this.projectFilePath(projectId);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf-8');
    const parsed = parseJson<ProjectFileShape>(raw, `project.json for '${projectId}'`);
    if (parsed.projectId !== projectId) {
      throw new Error(`Factory project file for '${projectId}' has mismatched projectId`);
    }
    return parsed;
  }

  private writeProjectFile(projectId: string, file: ProjectFileShape): void {
    writeAtomicFile(this.projectFilePath(projectId), `${JSON.stringify(file, null, 2)}\n`);
  }

  private materializeLinks(projectId: string): readonly FactoryProjectRunLink[] {
    return [...this.materializePersistedLinks(projectId).values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(persistedToLink);
  }

  private materializePersistedLinks(projectId: string): Map<string, FactoryProjectRunLinkPersisted> {
    const path = this.projectLinksPath(projectId);
    const result = new Map<string, FactoryProjectRunLinkPersisted>();
    if (!existsSync(path)) return result;
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const parsed = parseJson<RunLinkEnvelope>(line, `links.jsonl for '${projectId}' line ${index + 1}`);
      if (typeof parsed.runId !== 'string' || typeof parsed.ts !== 'string') {
        throw new Error(`Factory link log line ${index + 1} for '${projectId}' is invalid`);
      }
      if (parsed.op === 'remove') {
        result.delete(parsed.runId);
        continue;
      }
      if (parsed.op !== 'upsert' || !parsed.link) {
        throw new Error(`Factory link log line ${index + 1} for '${projectId}' is invalid`);
      }
      if (parsed.link.runId !== parsed.runId) {
        throw new Error(`Factory link log line ${index + 1} for '${projectId}' has mismatched runId`);
      }
      const previous = result.get(parsed.runId);
      result.set(parsed.runId, {
        runId: parsed.link.runId,
        workflowId: parsed.link.workflowId,
        relationship: parsed.link.relationship,
        stage: parsed.link.stage,
        bayId: parsed.link.bayId,
        policy: parsed.link.policy,
        createdAt: previous?.createdAt ?? parsed.ts,
        updatedAt: parsed.ts,
      });
    }
    return result;
  }

  private appendWorkspaceEnvelope(envelope: WorkspaceEnvelope): void {
    mkdirSync(this.rootDir, { recursive: true });
    appendJsonLine(this.workspacesPath(), envelope);
  }

  private appendProjectIndexEntry(entry: ProjectIndexEntry): void {
    mkdirSync(this.rootDir, { recursive: true });
    appendJsonLine(this.projectsIndexPath(), entry);
  }

  private appendLinkEnvelope(projectId: string, envelope: RunLinkEnvelope): void {
    mkdirSync(this.projectDir(projectId), { recursive: true });
    appendJsonLine(this.projectLinksPath(projectId), envelope);
  }
}

export function isSafeFactoryProjectId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id) && !id.includes('..');
}

export function assertSafeFactoryId(id: string, label: 'workspace' | 'project' | 'run'): void {
  if (typeof id !== 'string' || !isSafeFactoryProjectId(id)) {
    throw new Error(`Unsafe factory ${label} id '${id}'`);
  }
}

function projectRecordFromFile(
  file: ProjectFileShape,
  linkedRuns: readonly FactoryProjectRunLink[],
): FactoryProjectPersistedRecord {
  return {
    projectId: file.projectId,
    workspaceId: file.workspaceId,
    name: file.name,
    oneLineGoal: file.oneLineGoal,
    experienceMode: file.experienceMode,
    cockpitLayer: file.cockpitLayer,
    primaryRunId: file.primaryRunId,
    linkedRuns,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function persistedToLink(persisted: FactoryProjectRunLinkPersisted): FactoryProjectRunLink {
  return {
    runId: persisted.runId,
    workflowId: persisted.workflowId,
    relationship: persisted.relationship,
    stage: persisted.stage,
    bayId: persisted.bayId,
    policy: persisted.policy,
  };
}

function parseJson<T>(line: string, label: string): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(`Invalid JSON on ${label}: ${(error as Error).message}`);
  }
}

function assertEnumOrUndefined<T extends string>(value: T | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${label} '${value}'. Expected one of: ${allowed.join(', ')}`);
  }
  return value;
}

function writeAtomicFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tempPath, 'w');
  try {
    writeAllSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, path);
  fsyncParentDirectory(path);
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    writeAllSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(path);
}

function writeAllSync(fd: number, content: string): void {
  const buffer = Buffer.from(content, 'utf-8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('Factory project store write made no progress');
    offset += written;
  }
}

function fsyncParentDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Re-export listing helpers for callers that scan disk directly during recovery.
export function listProjectIdsOnDisk(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isSafeFactoryProjectId(entry.name))
    .map(entry => entry.name)
    .filter(name => existsSync(join(rootDir, name, 'project.json')))
    .sort();
}
