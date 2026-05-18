import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import piGstack from '../.pi/extensions/pi-gstack/index';
import { compileRunPlan } from '../lib/factory-core';
import { FileFactoryEventStore } from '../lib/factory-event-store';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';
import { factoryRunsRoot } from '../lib/pi-runtime-adapter';

const ROOT = path.resolve(import.meta.dir, '..');

type CommandDefinition = { handler: (args: string, ctx: any) => Promise<void> };
type Notification = { message: string; level: string };

function registerPiGstack() {
  const sent: Array<{ message: string; options?: unknown }> = [];
  const notifications: Notification[] = [];
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];

  piGstack({
    on(name: string, handler: (...args: any[]) => unknown) {
      events.set(name, handler);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.push(tool);
    },
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options });
    },
  });

  return { sent, notifications, commands, events, tools };
}

function notifyInto(notifications: Notification[]) {
  return {
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
  };
}

async function withTempGstackEnv<T>(action: (env: { home: string; gstackHome: string }) => Promise<T>): Promise<T> {
  const oldHome = process.env.HOME;
  const oldGstackHome = process.env.GSTACK_HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'gstack-pi-home-'));
  const gstackHome = path.join(home, '.gstack');
  try {
    process.env.HOME = home;
    process.env.GSTACK_HOME = gstackHome;
    return await action({ home, gstackHome });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldGstackHome === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = oldGstackHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function initCommittedRepo(projectRoot: string): string {
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'pi-extension-test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Pi Extension Test']);
  git(projectRoot, ['checkout', '-b', 'pi-test']);
  writeFileSync(path.join(projectRoot, 'README.md'), '# test repo\n');
  git(projectRoot, ['add', 'README.md']);
  git(projectRoot, ['commit', '-m', 'Initial commit']);
  return git(projectRoot, ['rev-parse', '--short', 'HEAD']);
}

function reviewLogPath(projectRoot: string, gstackHome: string): string {
  const slug = path.basename(projectRoot).replace(/[^a-zA-Z0-9._-]/g, '') || 'project';
  const branchResult = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
  const rawBranch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() : '';
  const branch = rawBranch.replace(/[^a-zA-Z0-9._-]/g, '') || 'unknown';
  return path.join(gstackHome, 'projects', slug, `${branch}-reviews.jsonl`);
}

function writeReviewLog(projectRoot: string, gstackHome: string, entries: readonly Record<string, unknown>[]): void {
  const logPath = reviewLogPath(projectRoot, gstackHome);
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');
}

function runIdFromLastNotification(notifications: readonly Notification[]): string {
  return notifications.at(-1)!.message.match(/Factory review running: ([^ ]+)/)![1];
}

function dispatchMetadata(projectRoot: string, runId: string): Record<string, unknown> {
  const metadata = JSON.parse(readFileSync(path.join(factoryRunsRoot(projectRoot), runId, 'artifacts', 'diff-review-dispatch.json'), 'utf-8'));
  return metadata.ref.metadata;
}

function reviewEntryAfterDispatch(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dispatchedAt = String(metadata.dispatchedAt);
  return {
    skill: 'review',
    timestamp: new Date(Date.parse(dispatchedAt) + 1_000).toISOString(),
    status: 'clean',
    issues_found: 0,
    critical: 0,
    informational: 0,
    quality_score: 10,
    specialists: {},
    findings: [],
    commit: metadata.commit,
    factory_run_id: metadata.factoryRunId,
    ...overrides,
  };
}

describe('Pi gstack extension wiring', () => {
  test('registers gstack slash aliases and forwards to generated Pi skills', async () => {
    const { sent, commands } = registerPiGstack();

    expect([...commands.keys()]).toEqual(['office-hours', 'autoplan', 'review', 'qa', 'ship', 'factory-review', 'factory-complete-review', 'factory-status', 'factory-list']);

    await commands.get('review')!.handler('check this diff', {
      isIdle: () => true,
      ui: { notify() {} },
    });
    expect(sent.at(-1)).toEqual({ message: '/skill:gstack-review check this diff', options: undefined });

    await commands.get('qa')!.handler('http://localhost:8200', {
      isIdle: () => false,
      ui: { notify() {} },
    });
    expect(sent.at(-1)).toEqual({ message: '/skill:gstack-qa http://localhost:8200', options: { deliverAs: 'followUp' } });
  });

  test('starts and inspects opt-in structured factory review runs, with manual completion fallback', async () => {
    await withTempGstackEnv(async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-review-'));

      try {
        initCommittedRepo(tempDir);
        const { sent, notifications, commands } = registerPiGstack();

        await commands.get('factory-review')!.handler('review current changes', {
          cwd: tempDir,
          isIdle: () => false,
          ui: notifyInto(notifications),
        });

        expect(sent).toHaveLength(1);
        expect(sent[0].message).toMatch(/^\/skill:gstack-review review current changes/);
        expect(sent[0].message).toContain('factory_run_id: review-review-current-changes-');
        expect(sent[0].options).toEqual({ deliverAs: 'followUp' });
        expect(notifications.at(-1)?.message).toMatch(/^Factory review running: review-review-current-changes-/);

        const runsDir = path.join(tempDir, '.gstack', 'factory', 'runs');
        const runId = runIdFromLastNotification(notifications);
        const eventLog = readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf-8');
        expect(eventLog).toContain('artifact_created');
        expect(eventLog).not.toContain('run_completed');
        expect(readFileSync(path.join(runsDir, runId, 'artifacts', 'review-intake-dispatch.md'), 'utf-8')).toContain('Factory Review Intake');
        expect(readFileSync(path.join(runsDir, runId, 'artifacts', 'diff-review-dispatch.md'), 'utf-8')).toContain('Status: pending durable gstack review log capture.');
        expect(dispatchMetadata(tempDir, runId)).toMatchObject({
          factoryRunId: runId,
          pendingExternalReview: true,
          queuedSkillCommand: sent[0].message,
        });
        expect(typeof dispatchMetadata(tempDir, runId).dispatchedAt).toBe('string');
        expect(typeof dispatchMetadata(tempDir, runId).commit).toBe('string');

        await commands.get('factory-status')!.handler(runId, {
          cwd: tempDir,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)?.level).toBe('info');
        expect(notifications.at(-1)?.message).toContain(`Factory run ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Status: running');
        expect(notifications.at(-1)?.message).toContain('Current phase: diff-review');
        expect(notifications.at(-1)?.message).toContain('Completed phases: review-intake');
        expect(notifications.at(-1)?.message).toContain('Artifacts:');
        expect(notifications.at(-1)?.message).toContain('Pending external review:');
        expect(notifications.at(-1)?.message).toContain(`- factoryRunId: ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Recovery hint:');

        await commands.get('factory-list')!.handler('', {
          cwd: tempDir,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)?.message).toContain('Factory runs:');
        expect(notifications.at(-1)?.message).toContain(`${runId}: status=running, current=diff-review`);

        await commands.get('factory-complete-review')!.handler(`${runId} no blocking findings`, {
          cwd: tempDir,
          isIdle: () => false,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)).toEqual({ message: `Factory review completed: ${runId} (4 artifact(s)).`, level: 'info' });
        expect(readFileSync(path.join(runsDir, runId, 'artifacts', 'diff-review-captured.md'), 'utf-8')).toContain('no blocking findings');
        const manualArtifact = JSON.parse(readFileSync(path.join(runsDir, runId, 'artifacts', 'diff-review-captured.json'), 'utf-8'));
        expect(manualArtifact.ref.metadata).toMatchObject({
          capturedFrom: 'manual-fallback',
          factoryRunId: runId,
          dispatchCommit: dispatchMetadata(tempDir, runId).commit,
          dispatchedAt: dispatchMetadata(tempDir, runId).dispatchedAt,
          queuedSkillCommand: sent[0].message,
        });
        expect(readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf-8')).toContain('run_completed');

        await commands.get('factory-status')!.handler('../bad', {
          cwd: tempDir,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)?.level).toBe('error');

        await commands.get('factory-status')!.handler('missing-run', {
          cwd: tempDir,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)).toEqual({ message: 'Factory run missing-run not found in this project.', level: 'warning' });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('auto-captures a pending factory review from a durable review log on agent_end', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-auto-'));

      try {
        const commit = initCommittedRepo(tempDir);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        const metadata = dispatchMetadata(tempDir, runId);
        expect(metadata.commit).toBe(commit);
        writeReviewLog(tempDir, gstackHome, [reviewEntryAfterDispatch(metadata, {
          status: 'issues_found',
          issues_found: 1,
          critical: 0,
          informational: 1,
          quality_score: 8.5,
          findings: [{ fingerprint: 'src/a.ts:1:test', severity: 'INFORMATIONAL', action: 'skipped' }],
        })]);

        await events.get('agent_end')!({}, ctx);

        expect(notifications.at(-1)).toEqual({
          message: `Factory review auto-captured: ${runId} (4 artifact(s), status=completed).`,
          level: 'info',
        });
        const runsDir = path.join(tempDir, '.gstack', 'factory', 'runs');
        expect(readFileSync(path.join(runsDir, runId, 'artifacts', 'diff-review-captured.md'), 'utf-8')).toContain('src/a.ts:1:test');
        expect(readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf-8')).toContain('run_completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('factory-status lazily recovers when a matching review log appears after dispatch', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-status-recover-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        writeReviewLog(tempDir, gstackHome, [reviewEntryAfterDispatch(dispatchMetadata(tempDir, runId))]);

        await commands.get('factory-status')!.handler(runId, ctx);

        expect(notifications.some(notification => notification.message === `Factory review auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(true);
        expect(notifications.at(-1)?.level).toBe('info');
        expect(notifications.at(-1)?.message).toContain(`Factory run ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Status: completed');
        expect(notifications.at(-1)?.message).toContain('Current phase: none');
        expect(notifications.at(-1)?.message).toContain('Completed phases: review-intake, diff-review, review-summary');
        expect(notifications.at(-1)?.message).toContain('diff-review-captured');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('factory-status recovers a targeted run while other review runs remain pending', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-status-target-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review auth changes', ctx);
        const firstRunId = runIdFromLastNotification(notifications);
        await commands.get('factory-review')!.handler('review billing changes', ctx);
        const secondRunId = runIdFromLastNotification(notifications);
        const corruptRunDir = path.join(factoryRunsRoot(tempDir), 'corrupt-run');
        mkdirSync(corruptRunDir, { recursive: true });
        writeFileSync(path.join(corruptRunDir, 'events.jsonl'), 'not-json\n', 'utf-8');
        writeReviewLog(tempDir, gstackHome, [reviewEntryAfterDispatch(dispatchMetadata(tempDir, secondRunId))]);

        await commands.get('factory-status')!.handler(secondRunId, ctx);

        expect(notifications.some(notification => notification.message === `Factory review auto-captured: ${secondRunId} (4 artifact(s), status=completed).`)).toBe(true);
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(firstRunId).status).toBe('running');
        expect(store.readState(firstRunId).currentPhaseId).toBe('diff-review');
        expect(store.readState(secondRunId).status).toBe('completed');
        expect(notifications.at(-1)?.message).toContain(`Factory run ${secondRunId}`);
        expect(notifications.at(-1)?.message).toContain('Status: completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('ambiguous multiple matching review log entries leave the factory run pending', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-ambiguous-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        const metadata = dispatchMetadata(tempDir, runId);
        writeReviewLog(tempDir, gstackHome, [
          reviewEntryAfterDispatch(metadata),
          reviewEntryAfterDispatch(metadata, { timestamp: new Date(Date.parse(String(metadata.dispatchedAt)) + 2_000).toISOString() }),
        ]);

        await events.get('agent_end')!({}, ctx);

        expect(notifications.at(-1)?.message).toContain(`Factory review auto-capture skipped for ${runId}: multiple matching correlated review log entries appeared after dispatch`);
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        const state = store.readState(runId);
        expect(state.status).toBe('running');
        expect(state.currentPhaseId).toBe('diff-review');
        expect(state.completedPhaseIds).toEqual(['review-intake']);

        await commands.get('factory-complete-review')!.handler(`${runId} manually reviewed after ambiguity`, ctx);
        expect(notifications.at(-1)).toEqual({ message: `Factory review completed: ${runId} (4 artifact(s)).`, level: 'info' });
        expect(store.readState(runId).status).toBe('completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('multiple pending factory review runs capture only the correlated match and still allow manual fallback', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-multiple-pending-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review auth changes', ctx);
        const firstRunId = runIdFromLastNotification(notifications);
        await commands.get('factory-review')!.handler('review billing changes', ctx);
        const secondRunId = runIdFromLastNotification(notifications);
        writeReviewLog(tempDir, gstackHome, [reviewEntryAfterDispatch(dispatchMetadata(tempDir, secondRunId))]);

        await events.get('agent_end')!({}, ctx);

        expect(notifications.at(-1)).toEqual({
          message: `Factory review auto-captured: ${secondRunId} (4 artifact(s), status=completed).`,
          level: 'info',
        });
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(firstRunId).status).toBe('running');
        expect(store.readState(secondRunId).status).toBe('completed');

        await commands.get('factory-complete-review')!.handler(`${firstRunId} manually reviewed after no-match`, ctx);

        expect(notifications.at(-1)).toEqual({ message: `Factory review completed: ${firstRunId} (4 artifact(s)).`, level: 'info' });
        expect(store.readState(firstRunId).status).toBe('completed');
        expect(store.readState(secondRunId).status).toBe('completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('missing review log leaves a pending factory run unchanged', async () => {
    await withTempGstackEnv(async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-missing-log-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        await events.get('agent_end')!({}, ctx);

        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        const state = store.readState(runId);
        expect(state.status).toBe('running');
        expect(state.currentPhaseId).toBe('diff-review');
        expect(notifications.at(-1)?.message).toMatch(/^Factory review running:/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('review log with missing or wrong factory correlation leaves auto-capture pending', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-no-correlation-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        const metadata = dispatchMetadata(tempDir, runId);
        writeReviewLog(tempDir, gstackHome, [
          reviewEntryAfterDispatch(metadata, { factory_run_id: undefined }),
          reviewEntryAfterDispatch(metadata, { factory_run_id: 'other-run' }),
        ]);

        await events.get('agent_end')!({}, ctx);

        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(runId).status).toBe('running');
        expect(store.readState(runId).currentPhaseId).toBe('diff-review');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('missing dispatch commit leaves auto-capture pending even if a review log appears', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-no-head-'));

      try {
        git(tempDir, ['init']);
        git(tempDir, ['checkout', '-b', 'pi-test']);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        const metadata = dispatchMetadata(tempDir, runId);
        expect(metadata.commit).toBeUndefined();
        writeReviewLog(tempDir, gstackHome, [reviewEntryAfterDispatch(metadata)]);

        await events.get('agent_end')!({}, ctx);

        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        const state = store.readState(runId);
        expect(state.status).toBe('running');
        expect(state.currentPhaseId).toBe('diff-review');
        expect(readFileSync(path.join(factoryRunsRoot(tempDir), runId, 'events.jsonl'), 'utf-8')).not.toContain('run_completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('refuses to complete review runs that have not reached pending capture', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-interrupted-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const plan = compileRunPlan(FACTORY_REVIEW_WORKFLOW, {
        workflow: 'review',
        goal: 'Review current changes',
        cwd: tempDir,
        mode: 'review',
        policy: { allowWrites: true },
      }, 'run-interrupted');
      store.append('run-interrupted', { type: 'run_started', runId: 'run-interrupted', plan });
      store.append('run-interrupted', { type: 'phase_started', runId: 'run-interrupted', phaseId: 'diff-review' });

      await commands.get('factory-complete-review')!.handler('run-interrupted no findings', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)).toEqual({
        message: 'Factory run run-interrupted is not waiting for diff-review output.',
        level: 'warning',
      });
      expect(store.readState('run-interrupted').status).toBe('running');
      expect(store.readState('run-interrupted').completedPhaseIds).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses manual fallback when dispatch metadata does not match the run', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-invalid-dispatch-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const plan = compileRunPlan(FACTORY_REVIEW_WORKFLOW, {
        workflow: 'review',
        goal: 'Review current changes',
        cwd: tempDir,
        mode: 'review',
        policy: { allowWrites: true },
      }, 'run-invalid-dispatch');
      store.append('run-invalid-dispatch', { type: 'run_started', runId: 'run-invalid-dispatch', plan });
      store.append('run-invalid-dispatch', { type: 'phase_started', runId: 'run-invalid-dispatch', phaseId: 'diff-review' });
      store.append('run-invalid-dispatch', {
        type: 'artifact_created',
        runId: 'run-invalid-dispatch',
        artifact: {
          id: 'diff-review-dispatch',
          kind: 'review',
          phaseId: 'diff-review',
          summary: 'Queued review',
          metadata: { factoryRunId: 'other-run', pendingExternalReview: true },
        },
      });

      await commands.get('factory-complete-review')!.handler('run-invalid-dispatch no findings', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)).toEqual({
        message: 'Factory run run-invalid-dispatch has invalid diff-review dispatch metadata.',
        level: 'warning',
      });
      expect(store.readState('run-invalid-dispatch').status).toBe('running');
      expect(store.readState('run-invalid-dispatch').completedPhaseIds).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('blocks structured factory review outside git repositories', async () => {
    const { sent, notifications, commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-no-git-'));

    try {
      await commands.get('factory-review')!.handler('review current changes', {
        cwd: tempDir,
        isIdle: () => false,
        ui: notifyInto(notifications),
      });

      expect(sent).toEqual([]);
      expect(notifications.at(-1)?.message).toContain('Factory review blocked');
      expect(notifications.at(-1)?.message).toContain('missing capabilities=git');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('registers generated skill discovery hook and fail-closed custom tools', async () => {
    const { events, tools } = registerPiGstack();

    expect(events.has('resources_discover')).toBe(true);
    const discovered = await events.get('resources_discover')!();
    const generatedSkillsDir = path.join(ROOT, '.pi', 'skills');
    if (existsSync(generatedSkillsDir)) {
      expect(discovered).toEqual({ skillPaths: [generatedSkillsDir] });
    } else {
      expect(discovered).toBeUndefined();
    }

    const browserTool = tools.find(tool => tool.name === 'gstack_browser');
    expect(browserTool).toBeDefined();
    await expect(browserTool!.execute('tool-browser', { command: 'snapshot; rm -rf /' }, undefined, undefined, {})).rejects.toThrow(
      'command must be a browse command name',
    );

    const oldHome = process.env.HOME;
    const oldGstackBrowse = process.env.GSTACK_BROWSE;
    const oldGstackPort = process.env.GSTACK_PORT;
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-browser-tool-'));
    const tempHome = mkdtempSync(path.join(tmpdir(), 'gstack-browser-home-'));
    try {
      const projectBrowseDir = path.join(tempDir, '.pi', 'skills', 'gstack', 'browse', 'dist');
      const projectBrowse = path.join(projectBrowseDir, 'browse');
      mkdirSync(projectBrowseDir, { recursive: true });
      writeFileSync(projectBrowse, '#!/usr/bin/env bash\necho "project-browse:$*"\n');
      chmodSync(projectBrowse, 0o755);

      const trustedBrowseDir = path.join(tempHome, '.pi', 'agent', 'skills', 'gstack', 'browse', 'dist');
      const trustedBrowse = path.join(trustedBrowseDir, 'browse');
      mkdirSync(trustedBrowseDir, { recursive: true });
      writeFileSync(trustedBrowse, '#!/usr/bin/env bash\necho "trusted-browse:$*"\necho "state:$BROWSE_STATE_FILE"\necho "port:${GSTACK_PORT:-unset}"\n');
      chmodSync(trustedBrowse, 0o755);

      process.env.HOME = tempHome;
      delete process.env.GSTACK_BROWSE;
      process.env.GSTACK_PORT = '9999';

      const browserResult = await browserTool!.execute('tool-browser', { command: 'snapshot', args: ['-i'] }, undefined, undefined, { cwd: tempDir });
      expect(browserResult).toEqual({
        content: [{ type: 'text', text: `trusted-browse:snapshot -i\nstate:${path.join(tempDir, '.gstack', 'browse.json')}\nport:unset` }],
        details: {
          command: 'snapshot',
          args: ['-i'],
          exitCode: 0,
          signal: null,
          browseBinary: trustedBrowse,
        },
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldGstackBrowse === undefined) delete process.env.GSTACK_BROWSE;
      else process.env.GSTACK_BROWSE = oldGstackBrowse;
      if (oldGstackPort === undefined) delete process.env.GSTACK_PORT;
      else process.env.GSTACK_PORT = oldGstackPort;
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }

    const questionTool = tools.find(tool => tool.name === 'ask_user_question');
    expect(questionTool).toBeDefined();

    await expect(questionTool!.execute('tool-1', { question: 'Ship it?' }, undefined, undefined, { hasUI: false })).rejects.toThrow(
      'requires interactive Pi UI',
    );
  });
});
