import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FactoryRunStatusDto } from '../lib/factory';
import { createFactoryProjectFacade } from '../lib/factory-project';
import {
  FileFactoryProjectStore,
  assertSafeFactoryId,
  isSafeFactoryProjectId,
  listProjectIdsOnDisk,
} from '../lib/factory-project-store';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';

function makeStore(times?: Date[]) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-project-store-'));
  const queue = times ? [...times] : undefined;
  const store = new FileFactoryProjectStore({
    rootDir,
    now: queue ? () => queue.shift() ?? new Date('2099-12-31T00:00:00.000Z') : undefined,
  });
  return { rootDir, store, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

describe('isSafeFactoryProjectId', () => {
  test('rejects traversal and unsafe characters', () => {
    expect(isSafeFactoryProjectId('tutor-match')).toBe(true);
    expect(isSafeFactoryProjectId('Project_1.0')).toBe(true);
    expect(isSafeFactoryProjectId('A')).toBe(true);

    expect(isSafeFactoryProjectId('')).toBe(false);
    expect(isSafeFactoryProjectId('..')).toBe(false);
    expect(isSafeFactoryProjectId('../escape')).toBe(false);
    expect(isSafeFactoryProjectId('foo/bar')).toBe(false);
    expect(isSafeFactoryProjectId('foo\\bar')).toBe(false);
    expect(isSafeFactoryProjectId('-leading-dash')).toBe(false);
    expect(isSafeFactoryProjectId('.hidden')).toBe(false);
    expect(isSafeFactoryProjectId('a..b')).toBe(false);
    expect(isSafeFactoryProjectId('with space')).toBe(false);

    expect(() => assertSafeFactoryId('../escape', 'project')).toThrow("Unsafe factory project id '../escape'");
    expect(() => assertSafeFactoryId('../escape', 'workspace')).toThrow("Unsafe factory workspace id");
    expect(() => assertSafeFactoryId('../escape', 'run')).toThrow("Unsafe factory run id");
  });
});

describe('FileFactoryProjectStore workspaces', () => {
  test('round-trips workspace records via append-log with safety defaults', () => {
    const { rootDir, store, cleanup } = makeStore([
      new Date('2026-05-21T10:00:00.000Z'),
      new Date('2026-05-21T10:01:00.000Z'),
    ]);
    try {
      const created = store.createWorkspace({
        workspaceId: 'studio-1',
        name: "Maya's Studio",
        ownerName: 'Maya',
        safetyDefaults: { allowBrowser: true, commandSafetyProfile: 'read-only' },
      });
      expect(created).toMatchObject({
        workspaceId: 'studio-1',
        name: "Maya's Studio",
        ownerName: 'Maya',
        createdAt: '2026-05-21T10:00:00.000Z',
        updatedAt: '2026-05-21T10:00:00.000Z',
      });

      const updated = store.upsertWorkspace({ workspaceId: 'studio-1', name: 'Studio One', ownerName: 'Maya' });
      expect(updated).toMatchObject({
        workspaceId: 'studio-1',
        name: 'Studio One',
        createdAt: '2026-05-21T10:00:00.000Z',
        updatedAt: '2026-05-21T10:01:00.000Z',
      });
      expect(updated.safetyDefaults).toBeUndefined();

      expect(store.readWorkspace('studio-1')).toEqual(updated);
      expect(store.listWorkspaces().map(workspace => workspace.workspaceId)).toEqual(['studio-1']);

      const logPath = path.join(rootDir, 'workspaces.jsonl');
      expect(readFileSync(logPath, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test('rejects duplicate create and traversal ids', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createWorkspace({ workspaceId: 'studio-1', name: 'Studio One' });
      expect(() => store.createWorkspace({ workspaceId: 'studio-1', name: 'Studio One' }))
        .toThrow("Factory workspace 'studio-1' already exists");

      expect(() => store.createWorkspace({ workspaceId: '../escape', name: 'no' }))
        .toThrow("Unsafe factory workspace id '../escape'");
      expect(() => store.readWorkspace('../escape')).toThrow('Unsafe factory workspace id');
    } finally {
      cleanup();
    }
  });

  test('remove tombstones drop the workspace from listings', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createWorkspace({ workspaceId: 'studio-1', name: 'Studio One' });
      store.createWorkspace({ workspaceId: 'studio-2', name: 'Studio Two' });
      store.removeWorkspace('studio-1');

      expect(store.readWorkspace('studio-1')).toBeNull();
      expect(store.listWorkspaces().map(workspace => workspace.workspaceId)).toEqual(['studio-2']);
    } finally {
      cleanup();
    }
  });
});

describe('FileFactoryProjectStore projects', () => {
  test('persists projects atomically with index + canonical json file', () => {
    const { rootDir, store, cleanup } = makeStore([
      new Date('2026-05-21T11:00:00.000Z'),
      new Date('2026-05-21T11:05:00.000Z'),
    ]);
    try {
      const record = store.createProject({
        projectId: 'tutor-match',
        workspaceId: 'studio-1',
        name: 'Tutor Match',
        oneLineGoal: 'Match tutors with students.',
        experienceMode: 'easy',
        cockpitLayer: 'simple',
        primaryRunId: 'run-review',
      });
      expect(record).toMatchObject({
        projectId: 'tutor-match',
        workspaceId: 'studio-1',
        name: 'Tutor Match',
        oneLineGoal: 'Match tutors with students.',
        experienceMode: 'easy',
        cockpitLayer: 'simple',
        primaryRunId: 'run-review',
        linkedRuns: [],
        createdAt: '2026-05-21T11:00:00.000Z',
        updatedAt: '2026-05-21T11:00:00.000Z',
      });

      const indexPath = path.join(rootDir, 'projects.jsonl');
      expect(existsSync(indexPath)).toBe(true);
      expect(JSON.parse(readFileSync(indexPath, 'utf-8').trim())).toEqual({
        projectId: 'tutor-match',
        workspaceId: 'studio-1',
        createdAt: '2026-05-21T11:00:00.000Z',
      });

      const projectPath = path.join(rootDir, 'tutor-match', 'project.json');
      expect(existsSync(projectPath)).toBe(true);
      // Atomic temp file should not linger after the rename.
      const dirEntries = readdirSync(path.join(rootDir, 'tutor-match'));
      expect(dirEntries.every(name => !name.endsWith('.tmp'))).toBe(true);

      const updated = store.updateProject('tutor-match', { name: 'Tutor Match (alpha)', primaryRunId: 'run-review-2' });
      expect(updated.name).toBe('Tutor Match (alpha)');
      expect(updated.primaryRunId).toBe('run-review-2');
      expect(updated.createdAt).toBe('2026-05-21T11:00:00.000Z');
      expect(updated.updatedAt).toBe('2026-05-21T11:05:00.000Z');

      const reread = store.readProject('tutor-match');
      expect(reread).toEqual(updated);
    } finally {
      cleanup();
    }
  });

  test('lists projects filtered by workspace and tolerates index drift', () => {
    const { rootDir, store, cleanup } = makeStore();
    try {
      store.createProject({ projectId: 'tutor-match', workspaceId: 'studio-1', name: 'Tutor Match', oneLineGoal: 'a' });
      store.createProject({ projectId: 'bakery-pos', workspaceId: 'studio-1', name: 'Bakery POS', oneLineGoal: 'b' });
      store.createProject({ projectId: 'wedding-site', workspaceId: 'studio-2', name: 'Wedding Site', oneLineGoal: 'c' });

      // Simulate index drift: append an entry that points at a project whose
      // directory was never written. The store should silently skip it rather
      // than failing the listing for healthy projects.
      writeFileSync(
        path.join(rootDir, 'projects.jsonl'),
        `${readFileSync(path.join(rootDir, 'projects.jsonl'), 'utf-8')}${JSON.stringify({ projectId: 'never-created', workspaceId: 'studio-1', createdAt: '2026-05-21T11:30:00.000Z' })}\n`,
      );

      expect(store.listProjects().map(project => project.projectId)).toEqual([
        'bakery-pos',
        'tutor-match',
        'wedding-site',
      ]);
      expect(store.listProjects('studio-1').map(project => project.projectId)).toEqual([
        'bakery-pos',
        'tutor-match',
      ]);
      expect(listProjectIdsOnDisk(rootDir)).toEqual(['bakery-pos', 'tutor-match', 'wedding-site']);
    } finally {
      cleanup();
    }
  });

  test('clears primaryRunId when patch is null and rejects unknown projects', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createProject({
        projectId: 'tutor-match',
        workspaceId: 'studio-1',
        name: 'Tutor Match',
        oneLineGoal: 'a',
        primaryRunId: 'run-1',
      });
      const cleared = store.updateProject('tutor-match', { primaryRunId: null });
      expect(cleared.primaryRunId).toBeUndefined();

      expect(() => store.updateProject('missing', { name: 'x' })).toThrow("Factory project 'missing' not found");
      expect(() => store.createProject({ projectId: 'tutor-match', workspaceId: 'studio-1', name: 'dup', oneLineGoal: 'x' }))
        .toThrow("Factory project 'tutor-match' already exists");
      expect(() => store.updateProject('tutor-match', { experienceMode: 'fake' as never }))
        .toThrow("Invalid experienceMode 'fake'");
    } finally {
      cleanup();
    }
  });
});

describe('FileFactoryProjectStore run links', () => {
  test('links upsert by runId and survive remove tombstones in order', () => {
    const { rootDir, store, cleanup } = makeStore([
      new Date('2026-05-21T12:00:00.000Z'), // project create
      new Date('2026-05-21T12:01:00.000Z'), // link A first upsert
      new Date('2026-05-21T12:02:00.000Z'), // link B first upsert
      new Date('2026-05-21T12:03:00.000Z'), // link A update
      new Date('2026-05-21T12:04:00.000Z'), // link C upsert + remove
      new Date('2026-05-21T12:05:00.000Z'), // remove
    ]);
    try {
      store.createProject({ projectId: 'tutor-match', workspaceId: 'studio-1', name: 'Tutor Match', oneLineGoal: 'a' });

      const linkA = store.addRunLink('tutor-match', { runId: 'run-a', workflowId: 'review', relationship: 'primary' });
      expect(linkA.createdAt).toBe('2026-05-21T12:01:00.000Z');

      store.addRunLink('tutor-match', { runId: 'run-b', workflowId: 'qa', relationship: 'qa-audit' });
      const linkAUpdated = store.addRunLink('tutor-match', { runId: 'run-a', workflowId: 'review', relationship: 'supporting' });
      expect(linkAUpdated.relationship).toBe('supporting');
      expect(linkAUpdated.createdAt).toBe('2026-05-21T12:01:00.000Z');
      expect(linkAUpdated.updatedAt).toBe('2026-05-21T12:03:00.000Z');

      store.addRunLink('tutor-match', { runId: 'run-c', workflowId: 'ship', relationship: 'ship-readiness' });
      store.removeRunLink('tutor-match', 'run-c');

      const links = store.listRunLinks('tutor-match');
      expect(links.map(link => link.runId)).toEqual(['run-a', 'run-b']);
      expect(links[0].relationship).toBe('supporting');

      const reread = store.readProject('tutor-match');
      expect(reread?.linkedRuns.map(link => link.runId)).toEqual(['run-a', 'run-b']);

      const logPath = path.join(rootDir, 'tutor-match', 'links.jsonl');
      const raw = readFileSync(logPath, 'utf-8').trim().split('\n');
      // Every addRunLink + removeRunLink writes one envelope; no compaction.
      expect(raw).toHaveLength(5);
    } finally {
      cleanup();
    }
  });

  test('rejects unknown relationships and unsafe ids', () => {
    const { store, cleanup } = makeStore();
    try {
      store.createProject({ projectId: 'tutor-match', workspaceId: 'studio-1', name: 'Tutor Match', oneLineGoal: 'a' });
      expect(() => store.addRunLink('tutor-match', { runId: 'run-x', relationship: 'bogus' as never }))
        .toThrow("Unknown factory run link relationship 'bogus'");
      expect(() => store.addRunLink('tutor-match', { runId: '../escape' }))
        .toThrow('Unsafe factory run id');
      expect(() => store.addRunLink('missing-project', { runId: 'run-1' }))
        .toThrow("Factory project 'missing-project' not found");

      // Removing a link that was never recorded is a no-op (idempotent).
      expect(() => store.removeRunLink('tutor-match', 'never-added')).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe('FileFactoryProjectStore implements FactoryProjectCatalog', () => {
  test('drives createFactoryProjectFacade and degrades on missing linked runs', async () => {
    const { rootDir, store, cleanup } = makeStore();
    try {
      store.createWorkspace({ workspaceId: 'studio-1', name: 'Studio One', ownerName: 'Maya' });
      store.createProject({
        projectId: 'tutor-match',
        workspaceId: 'studio-1',
        name: 'Tutor Match',
        oneLineGoal: 'Review the current Tutor Match build',
        experienceMode: 'hands-on',
        cockpitLayer: 'detailed',
        primaryRunId: 'run-review',
      });
      store.addRunLink('tutor-match', { runId: 'run-review', workflowId: 'review', relationship: 'primary' });
      // This link points at a run that the facade cannot find; the wrapper
      // must degrade gracefully rather than crashing the project DTO.
      store.addRunLink('tutor-match', { runId: 'ghost-run', workflowId: 'review', relationship: 'supporting' });

      const reviewStatus: FactoryRunStatusDto = {
        runId: 'run-review',
        workflowId: 'review',
        workflowTitle: 'Structured Review',
        mode: 'review',
        goal: 'Review Tutor Match',
        status: 'running',
        createdAt: '2026-05-21T12:00:00.000Z',
        updatedAt: '2026-05-21T12:15:00.000Z',
        currentPhase: { id: 'diff-review', title: 'Diff Review' },
        progress: { completed: 1, total: 3 },
        completedPhaseIds: ['review-intake'],
        artifacts: [{ id: 'diff-review-artifact', kind: 'review', phaseId: 'diff-review', summary: 'Diff review artifact' }],
        gates: [],
        risks: [],
      };

      const facade = createFactoryProjectFacade({
        factory: {
          async readFactoryRunStatus(runId: string) {
            if (runId === 'run-review') return reviewStatus;
            throw new Error(`Unknown run '${runId}'`);
          },
        },
        catalog: store,
        workflows: [FACTORY_REVIEW_WORKFLOW],
      });

      const workspaces = await facade.listFactoryWorkspaces();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatchObject({
        workspaceId: 'studio-1',
        projectCount: 1,
        resumeProjectId: 'tutor-match',
      });

      const summary = await facade.readFactoryProjectSummary('tutor-match');
      expect(summary).toMatchObject({
        projectId: 'tutor-match',
        workspaceId: 'studio-1',
        activeRunId: 'run-review',
        activeRunStatus: 'running',
        linkedRunIds: ['run-review'],
      });

      // Sanity check the store file layout under the temp rootDir.
      expect(existsSync(path.join(rootDir, 'tutor-match', 'project.json'))).toBe(true);
      expect(existsSync(path.join(rootDir, 'tutor-match', 'links.jsonl'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
