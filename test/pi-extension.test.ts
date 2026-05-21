import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import piGstack from '../.pi/extensions/pi-gstack/index';
import { compileRunPlan, type WorkflowSpec } from '../lib/factory-core';
import { FileFactoryEventStore } from '../lib/factory-event-store';
import { FACTORY_REVIEW_WORKFLOW, FACTORY_WORKFLOWS } from '../lib/factory-review-workflow';
import { factoryRunsRoot } from '../lib/pi-runtime-adapter';

const ROOT = path.resolve(import.meta.dir, '..');

const GATED_WORKFLOW: WorkflowSpec = {
  id: 'gated-review',
  title: 'Gated Review',
  description: 'Review behind a gate.',
  phases: [{
    id: 'review',
    title: 'Review',
    role: { id: 'reviewer', title: 'Reviewer' },
    objective: 'Review after approval.',
    gates: [{ id: 'approve-review', title: 'Approve review', description: 'Approve running review.', kind: 'human-decision', failClosed: true }],
    outputs: [{ id: 'review', kind: 'review', description: 'Review output.' }],
  }],
};

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

function installProjectBrowseRuntime(projectRoot: string): void {
  const browsePath = path.join(projectRoot, '.pi', 'skills', 'gstack', 'browse', 'dist', 'browse');
  mkdirSync(path.dirname(browsePath), { recursive: true });
  writeFileSync(browsePath, '#!/usr/bin/env sh\necho "test browse:$1"\n');
  chmodSync(browsePath, 0o755);
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

function capturedArtifact(projectRoot: string, runId: string, idPrefix: string): { readonly id: string; readonly metadata: any; readonly content: string } {
  const artifactsDir = path.join(factoryRunsRoot(projectRoot), runId, 'artifacts');
  const id = readdirSync(artifactsDir)
    .filter(entry => entry.startsWith(idPrefix) && entry.endsWith('.json'))
    .map(entry => path.basename(entry, '.json'))[0];
  if (!id) throw new Error(`Missing captured artifact with prefix ${idPrefix}`);
  const metadata = JSON.parse(readFileSync(path.join(artifactsDir, `${id}.json`), 'utf-8'));
  return { id, metadata, content: readFileSync(path.join(artifactsDir, `${id}.md`), 'utf-8') };
}

function capturedArtifactCount(projectRoot: string, runId: string, idPrefix: string): number {
  const artifactsDir = path.join(factoryRunsRoot(projectRoot), runId, 'artifacts');
  return readdirSync(artifactsDir)
    .filter(entry => entry.startsWith(idPrefix) && entry.endsWith('.json'))
    .length;
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

function qaLogPath(projectRoot: string, gstackHome: string): string {
  const slug = path.basename(projectRoot).replace(/[^a-zA-Z0-9._-]/g, '') || 'project';
  const branchResult = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
  const rawBranch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() : '';
  const branch = rawBranch.replace(/[^a-zA-Z0-9._-]/g, '') || 'unknown';
  return path.join(gstackHome, 'projects', slug, `${branch}-qa.jsonl`);
}

function writeQaLog(projectRoot: string, gstackHome: string, entries: readonly Record<string, unknown>[]): void {
  const logPath = qaLogPath(projectRoot, gstackHome);
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');
}

function qaDispatchMetadata(projectRoot: string, runId: string): Record<string, unknown> {
  const metadata = JSON.parse(readFileSync(path.join(factoryRunsRoot(projectRoot), runId, 'artifacts', 'qa-execution-dispatch.json'), 'utf-8'));
  return metadata.ref.metadata;
}

function qaEntryAfterDispatch(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dispatchedAt = String(metadata.dispatchedAt);
  return {
    skill: 'qa-only',
    timestamp: new Date(Date.parse(dispatchedAt) + 1_000).toISOString(),
    status: 'issues_found',
    mode: 'audit',
    summary: '1 must-fix found',
    target_url: 'http://localhost:8200',
    target_environment: 'local',
    authenticated_as: 'test parent account',
    passed: 4,
    failed: 1,
    must_fix: 1,
    issues_found: 1,
    scenarios: [
      { name: 'Parent books a 60-min slot', result: 'fail', severity: 'must-fix', evidence: ['screenshots/issue-001-result.png'] },
    ],
    screenshots: [{ uri: 'screenshots/issue-001-result.png', caption: 'Booking accepts a past date (FAIL)' }],
    trace_steps: [{ timestamp: '00:12', detail: 'Past date accepted (unexpected)' }],
    factory_run_id: metadata.factoryRunId,
    ...overrides,
  };
}

function qaRunIdFromLastNotification(notifications: readonly Notification[]): string {
  return notifications.at(-1)!.message.match(/Factory QA audit running: ([^ ]+)/)![1];
}

describe('Pi gstack extension wiring', () => {
  test('registers gstack slash aliases and forwards to generated Pi skills', async () => {
    const { sent, commands } = registerPiGstack();

    expect([...commands.keys()]).toEqual(['office-hours', 'autoplan', 'review', 'qa', 'ship', 'factory-review', 'factory-qa', 'factory-complete-review', 'factory-complete-qa', 'factory-recover-review', 'factory-recover-qa', 'factory-status', 'factory-list', 'factory-gates', 'factory-decide']);

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
        expect(notifications.at(-1)?.message).toContain('Status: paused');
        expect(notifications.at(-1)?.message).toContain('Current phase: diff-review');
        expect(notifications.at(-1)?.message).toContain('Completed phases: review-intake');
        expect(notifications.at(-1)?.message).toContain('Artifacts:');
        expect(notifications.at(-1)?.message).toContain('Pending external review:');
        expect(notifications.at(-1)?.message).toContain(`- factoryRunId: ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Status is inspect-only; use an explicit recovery/completion command to mutate this run.');
        expect(notifications.at(-1)?.message).toContain('Recovery hint:');
        expect(notifications.at(-1)?.message).toContain(`Summary next action: /factory-recover-review ${runId}`);

        await commands.get('factory-list')!.handler('', {
          cwd: tempDir,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)?.message).toContain('Factory runs:');
        expect(notifications.at(-1)?.message).toContain(`${runId}: workflow=review (Structured Review), status=paused, current=diff-review`);
        expect(notifications.at(-1)?.message).toContain(`next=/factory-recover-review ${runId} or /factory-complete-review ${runId} <summary>`);

        await commands.get('factory-complete-review')!.handler(`${runId} no blocking findings`, {
          cwd: tempDir,
          isIdle: () => false,
          ui: notifyInto(notifications),
        });
        expect(notifications.at(-1)).toEqual({ message: `Factory review completed: ${runId} (4 artifact(s)).`, level: 'info' });
        const manualArtifact = capturedArtifact(tempDir, runId, 'diff-review-captured-');
        expect(manualArtifact.content).toContain('no blocking findings');
        expect(manualArtifact.metadata.ref.metadata).toMatchObject({
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

  test('starts and completes opt-in structured factory QA runs with manual fallback', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-'));

    try {
      initCommittedRepo(tempDir);
      installProjectBrowseRuntime(tempDir);
      const { sent, notifications, commands } = registerPiGstack();

      await commands.get('factory-qa')!.handler('QA http://localhost:8200', {
        cwd: tempDir,
        isIdle: () => false,
        ui: notifyInto(notifications),
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].message).toMatch(/^\/skill:gstack-qa-only QA http:\/\/localhost:8200/);
      expect(sent[0].message).toContain('Factory QA audit safety contract:');
      expect(sent[0].message).toContain('Do not edit repository files or apply fixes.');
      expect(sent[0].message).toContain('factory_run_id: qa-qa-http-localhost-8200-');
      expect(sent[0].options).toEqual({ deliverAs: 'followUp' });
      expect(notifications.at(-1)?.message).toMatch(/^Factory QA audit running: qa-qa-http-localhost-8200-/);

      const runId = notifications.at(-1)!.message.match(/Factory QA audit running: ([^ ]+)/)![1];
      const runsDir = path.join(tempDir, '.gstack', 'factory', 'runs');
      expect(readFileSync(path.join(runsDir, runId, 'artifacts', 'qa-intake-dispatch.md'), 'utf-8')).toContain('Factory QA Intake');
      expect(readFileSync(path.join(runsDir, runId, 'artifacts', 'qa-execution-dispatch.md'), 'utf-8')).toContain('Status: pending durable gstack QA log capture, with /factory-complete-qa as manual fallback.');

      await commands.get('factory-status')!.handler(runId, {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });
      expect(notifications.at(-1)?.message).toContain(`Factory run ${runId}`);
      expect(notifications.at(-1)?.message).toContain('Status: paused');
      expect(notifications.at(-1)?.message).toContain('Current phase: qa-execution');
      expect(notifications.at(-1)?.message).toContain('Pending external QA:');
      expect(notifications.at(-1)?.message).toContain('- mode: audit-only; /factory-qa does not edit repository files or apply fixes.');
      expect(notifications.at(-1)?.message).toContain('Status is inspect-only; use an explicit recovery/completion command to mutate this run.');
      expect(notifications.at(-1)?.message).toContain(`Next action: /factory-recover-qa ${runId} after the generated QA logs Phase persist output, or /factory-complete-qa ${runId} <summary> as fallback`);
      expect(notifications.at(-1)?.message).toContain(`Summary next action: /factory-recover-qa ${runId} or /factory-complete-qa ${runId} <summary>`);
      expect(notifications.at(-1)?.message).toContain('Recovery hint:');

      await commands.get('factory-complete-qa')!.handler(`${runId} no browser regressions`, {
        cwd: tempDir,
        isIdle: () => false,
        ui: notifyInto(notifications),
      });
      expect(notifications.at(-1)?.message).toContain(`Factory QA completed: ${runId}`);
      expect(capturedArtifact(tempDir, runId, 'qa-execution-captured-').content).toContain('no browser regressions');
      const state = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) }).readState(runId);
      expect(state.status).toBe('completed');
      expect(state.completedPhaseIds).toEqual(['qa-intake', 'qa-execution', 'qa-summary']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('factory-status distinguishes persisted QA fix runs from audit-only QA', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-fix-status-'));

    try {
      git(tempDir, ['init']);
      const qaFixWorkflow = FACTORY_WORKFLOWS.find(workflow => workflow.id === 'qa-fix')!;
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const plan = compileRunPlan(qaFixWorkflow, {
        workflow: 'qa-fix',
        goal: 'QA and fix http://localhost:8200',
        cwd: tempDir,
        mode: 'review',
        policy: { allowBrowser: true, allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      }, 'run-qa-fix-status');
      store.append('run-qa-fix-status', { type: 'run_started', runId: 'run-qa-fix-status', plan });
      store.append('run-qa-fix-status', { type: 'phase_started', runId: 'run-qa-fix-status', phaseId: 'qa-execution' });
      store.append('run-qa-fix-status', {
        type: 'artifact_created',
        runId: 'run-qa-fix-status',
        artifact: {
          id: 'qa-execution-dispatch',
          kind: 'qa-report',
          phaseId: 'qa-execution',
          summary: 'Queued QA fix',
          metadata: { factoryRunId: 'run-qa-fix-status', pendingExternalQa: true, pendingExternalWork: true, queuedSkillCommand: '/skill:gstack-qa QA and fix http://localhost:8200', dispatchedAt: '2026-01-01T00:00:00.000Z' },
        },
      });

      await commands.get('factory-status')!.handler('run-qa-fix-status', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)?.message).toContain('Workflow: qa-fix (Structured QA Fix)');
      expect(notifications.at(-1)?.message).toContain('- mode: QA fix; safe local writes were approved for this run.');
      expect(notifications.at(-1)?.message).not.toContain('audit-only; /factory-qa does not edit repository files');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses to complete QA runs that have not reached pending capture', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-interrupted-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const plan = compileRunPlan(FACTORY_WORKFLOWS.find(workflow => workflow.id === 'qa')!, {
        workflow: 'qa',
        goal: 'QA http://localhost:8200',
        cwd: tempDir,
        mode: 'review',
        policy: { allowBrowser: true, allowWrites: false },
      }, 'run-qa-interrupted');
      store.append('run-qa-interrupted', { type: 'run_started', runId: 'run-qa-interrupted', plan });
      store.append('run-qa-interrupted', { type: 'phase_started', runId: 'run-qa-interrupted', phaseId: 'qa-execution' });

      await commands.get('factory-complete-qa')!.handler('run-qa-interrupted no regressions', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)).toEqual({
        message: 'Factory run run-qa-interrupted is not waiting for qa-execution output.',
        level: 'warning',
      });
      expect(store.readState('run-qa-interrupted').status).toBe('running');
      expect(store.readState('run-qa-interrupted').completedPhaseIds).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses duplicate manual QA completion after the first capture commits', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-duplicate-'));

    try {
      initCommittedRepo(tempDir);
      installProjectBrowseRuntime(tempDir);
      const { notifications, commands } = registerPiGstack();
      const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

      await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
      const runId = notifications.at(-1)!.message.match(/Factory QA audit running: ([^ ]+)/)![1];

      await commands.get('factory-complete-qa')!.handler(`${runId} first QA capture`, ctx);
      expect(notifications.at(-1)?.message).toContain(`Factory QA completed: ${runId}`);
      const firstCapture = capturedArtifact(tempDir, runId, 'qa-execution-captured-');
      expect(firstCapture.content).toContain('first QA capture');

      await commands.get('factory-complete-qa')!.handler(`${runId} stale second QA capture`, ctx);
      expect(notifications.at(-1)).toEqual({
        message: `Factory run ${runId} is not waiting for qa-execution output.`,
        level: 'warning',
      });
      expect(capturedArtifact(tempDir, runId, 'qa-execution-captured-').id).toBe(firstCapture.id);
      expect(capturedArtifact(tempDir, runId, 'qa-execution-captured-').content).toContain('first QA capture');
      expect(capturedArtifact(tempDir, runId, 'qa-execution-captured-').content).not.toContain('stale second QA capture');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('does not expose write-capable structured factory QA fix without a safe command guard', async () => {
    const { commands } = registerPiGstack();
    expect(commands.has('factory-qa-fix')).toBe(false);
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
        expect(capturedArtifact(tempDir, runId, 'diff-review-captured-').content).toContain('src/a.ts:1:test');
        expect(readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf-8')).toContain('run_completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('factory-status stays read-only when a matching review log appears after dispatch', async () => {
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

        expect(notifications.some(notification => notification.message === `Factory review auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(false);
        expect(notifications.at(-1)?.level).toBe('info');
        expect(notifications.at(-1)?.message).toContain(`Factory run ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Status: paused');
        expect(notifications.at(-1)?.message).toContain('Current phase: diff-review');
        expect(notifications.at(-1)?.message).toContain(`Next action: /factory-recover-review ${runId}`);
        expect(new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) }).readState(runId).status).toBe('running');

        await commands.get('factory-recover-review')!.handler(runId, ctx);
        expect(notifications.some(notification => notification.message === `Factory review auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(true);
        expect(notifications.at(-1)?.message).toContain('Status: completed');
        expect(notifications.at(-1)?.message).toContain('diff-review-captured-');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('repeated factory-recover-review does not duplicate captured review artifacts or completions', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-recover-idempotent-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);
        writeReviewLog(tempDir, gstackHome, [reviewEntryAfterDispatch(dispatchMetadata(tempDir, runId))]);

        await commands.get('factory-recover-review')!.handler(runId, ctx);
        expect(notifications.some(notification => notification.message === `Factory review auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(true);
        const firstCapture = capturedArtifact(tempDir, runId, 'diff-review-captured-');
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        const firstEventLog = readFileSync(path.join(factoryRunsRoot(tempDir), runId, 'events.jsonl'), 'utf-8');
        expect(store.readState(runId).status).toBe('completed');
        expect(capturedArtifactCount(tempDir, runId, 'diff-review-captured-')).toBe(1);

        await commands.get('factory-recover-review')!.handler(runId, ctx);

        expect(capturedArtifactCount(tempDir, runId, 'diff-review-captured-')).toBe(1);
        expect(capturedArtifact(tempDir, runId, 'diff-review-captured-').id).toBe(firstCapture.id);
        expect(readFileSync(path.join(factoryRunsRoot(tempDir), runId, 'events.jsonl'), 'utf-8')).toBe(firstEventLog);
        expect(store.readState(runId).status).toBe('completed');
        expect(notifications.at(-1)?.message).toContain('Status: completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('factory-recover-review recovers a targeted run while other review runs remain pending', async () => {
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

        await commands.get('factory-recover-review')!.handler(secondRunId, ctx);

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

  test('factory-recover-qa captures a pending factory QA from a durable QA log', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-recover-'));

      try {
        initCommittedRepo(tempDir);
        installProjectBrowseRuntime(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
        const runId = qaRunIdFromLastNotification(notifications);
        const metadata = qaDispatchMetadata(tempDir, runId);
        expect(metadata.factoryRunId).toBe(runId);
        writeQaLog(tempDir, gstackHome, [qaEntryAfterDispatch(metadata)]);

        await commands.get('factory-recover-qa')!.handler(runId, ctx);

        expect(notifications.some(notification => notification.message === `Factory QA auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(true);
        expect(notifications.at(-1)?.message).toContain(`Factory run ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Status: completed');
        const capture = capturedArtifact(tempDir, runId, 'qa-execution-captured-');
        expect(capture.content).toContain('Captured GStack QA');
        expect(capture.content).toContain('Browser QA audit — no code changes.');
        expect(capture.content).toContain('Booking accepts a past date (FAIL)');
        expect(capture.metadata.ref.metadata).toMatchObject({
          capturedFrom: 'gstack-qa-log',
          qaMode: 'audit',
        });
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(runId).status).toBe('completed');
        expect(store.readState(runId).completedPhaseIds).toEqual(['qa-intake', 'qa-execution', 'qa-summary']);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('repeated factory-recover-qa does not duplicate captured QA artifacts or completions', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-recover-idempotent-'));

      try {
        initCommittedRepo(tempDir);
        installProjectBrowseRuntime(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
        const runId = qaRunIdFromLastNotification(notifications);
        writeQaLog(tempDir, gstackHome, [qaEntryAfterDispatch(qaDispatchMetadata(tempDir, runId))]);

        await commands.get('factory-recover-qa')!.handler(runId, ctx);
        expect(notifications.some(notification => notification.message === `Factory QA auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(true);
        const firstCapture = capturedArtifact(tempDir, runId, 'qa-execution-captured-');
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        const firstEventLog = readFileSync(path.join(factoryRunsRoot(tempDir), runId, 'events.jsonl'), 'utf-8');
        expect(store.readState(runId).status).toBe('completed');
        expect(capturedArtifactCount(tempDir, runId, 'qa-execution-captured-')).toBe(1);

        await commands.get('factory-recover-qa')!.handler(runId, ctx);

        expect(capturedArtifactCount(tempDir, runId, 'qa-execution-captured-')).toBe(1);
        expect(capturedArtifact(tempDir, runId, 'qa-execution-captured-').id).toBe(firstCapture.id);
        expect(readFileSync(path.join(factoryRunsRoot(tempDir), runId, 'events.jsonl'), 'utf-8')).toBe(firstEventLog);
        expect(store.readState(runId).status).toBe('completed');
        expect(notifications.at(-1)?.message).toContain('Status: completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('ambiguous multiple matching QA log entries leave the factory QA run pending', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-ambiguous-'));

      try {
        initCommittedRepo(tempDir);
        installProjectBrowseRuntime(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
        const runId = qaRunIdFromLastNotification(notifications);
        const metadata = qaDispatchMetadata(tempDir, runId);
        writeQaLog(tempDir, gstackHome, [
          qaEntryAfterDispatch(metadata),
          qaEntryAfterDispatch(metadata, { timestamp: new Date(Date.parse(String(metadata.dispatchedAt)) + 2_000).toISOString() }),
        ]);

        await commands.get('factory-recover-qa')!.handler(runId, ctx);

        expect(notifications.some(notification => notification.message === `Factory QA auto-capture skipped for ${runId}: multiple matching correlated QA log entries appeared after dispatch. Use /factory-complete-qa as the fallback.`)).toBe(true);
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        const state = store.readState(runId);
        expect(state.status).toBe('running');
        expect(state.currentPhaseId).toBe('qa-execution');
        expect(state.completedPhaseIds).toEqual(['qa-intake']);

        await commands.get('factory-complete-qa')!.handler(`${runId} manually captured after ambiguity`, ctx);
        expect(notifications.at(-1)).toEqual({ message: `Factory QA completed: ${runId} (4 artifact(s)).`, level: 'info' });
        expect(store.readState(runId).status).toBe('completed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('QA log with missing or wrong factory correlation leaves factory-recover-qa pending', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-no-correlation-'));

      try {
        initCommittedRepo(tempDir);
        installProjectBrowseRuntime(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
        const runId = qaRunIdFromLastNotification(notifications);
        const metadata = qaDispatchMetadata(tempDir, runId);
        writeQaLog(tempDir, gstackHome, [
          qaEntryAfterDispatch(metadata, { factory_run_id: undefined }),
          qaEntryAfterDispatch(metadata, { factory_run_id: 'other-run' }),
        ]);

        await commands.get('factory-recover-qa')!.handler(runId, ctx);

        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(runId).status).toBe('running');
        expect(store.readState(runId).currentPhaseId).toBe('qa-execution');
        expect(capturedArtifactCount(tempDir, runId, 'qa-execution-captured-')).toBe(0);
        expect(notifications.at(-1)?.message).toContain(`Factory run ${runId}`);
        expect(notifications.at(-1)?.message).toContain('Status: paused');
        expect(notifications.at(-1)?.message).toContain('Pending external QA:');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('factory-recover-qa with missing or empty run id surfaces an error and does not mutate runs', async () => {
    await withTempGstackEnv(async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-bad-runid-'));

      try {
        initCommittedRepo(tempDir);
        installProjectBrowseRuntime(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
        const runId = qaRunIdFromLastNotification(notifications);

        await commands.get('factory-recover-qa')!.handler('', ctx);
        expect(notifications.at(-1)).toEqual({ message: 'factory-recover-qa requires a run id', level: 'error' });

        await commands.get('factory-recover-qa')!.handler('missing-run', ctx);
        expect(notifications.at(-1)).toEqual({ message: 'Factory run missing-run not found in this project.', level: 'warning' });

        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(runId).status).toBe('running');
        expect(store.readState(runId).currentPhaseId).toBe('qa-execution');
        expect(capturedArtifactCount(tempDir, runId, 'qa-execution-captured-')).toBe(0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('factory-recover-qa never registers or exposes /factory-qa-fix', async () => {
    const { commands } = registerPiGstack();
    expect(commands.has('factory-recover-qa')).toBe(true);
    expect(commands.has('factory-qa-fix')).toBe(false);
  });

  test('agent_end auto-captures a pending factory QA run alongside review auto-capture', async () => {
    await withTempGstackEnv(async ({ gstackHome }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-qa-agent-end-'));

      try {
        initCommittedRepo(tempDir);
        installProjectBrowseRuntime(tempDir);
        const { notifications, commands, events } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-qa')!.handler('QA http://localhost:8200', ctx);
        const runId = qaRunIdFromLastNotification(notifications);
        writeQaLog(tempDir, gstackHome, [qaEntryAfterDispatch(qaDispatchMetadata(tempDir, runId))]);

        await events.get('agent_end')!({}, ctx);

        expect(notifications.some(notification => notification.message === `Factory QA auto-captured: ${runId} (4 artifact(s), status=completed).`)).toBe(true);
        const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
        expect(store.readState(runId).status).toBe('completed');
        expect(capturedArtifactCount(tempDir, runId, 'qa-execution-captured-')).toBe(1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  test('gstack_browser prefers active project browse runtime when no trusted runtime is installed', async () => {
    const oldHome = process.env.HOME;
    const oldGstackBrowse = process.env.GSTACK_BROWSE;
    const { tools } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-project-browse-'));
    const tempHome = mkdtempSync(path.join(tmpdir(), 'gstack-project-browse-home-'));

    try {
      process.env.HOME = tempHome;
      delete process.env.GSTACK_BROWSE;
      const browsePath = path.join(tempDir, '.pi', 'skills', 'gstack', 'browse', 'dist', 'browse');
      mkdirSync(path.dirname(browsePath), { recursive: true });
      writeFileSync(browsePath, '#!/usr/bin/env sh\necho "project browse:$1"\n');
      chmodSync(browsePath, 0o755);
      const browserTool = tools.find(tool => tool.name === 'gstack_browser')!;

      const result = await browserTool.execute('tool-1', { command: 'snapshot' }, undefined, undefined, { cwd: tempDir });
      expect((result as any).content[0].text).toBe('project browse:snapshot');
      expect((result as any).details.browseBinary).toBe(browsePath);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldGstackBrowse === undefined) delete process.env.GSTACK_BROWSE;
      else process.env.GSTACK_BROWSE = oldGstackBrowse;
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('factory-status does not render untrusted event artifact paths', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-status-path-'));

    try {
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const plan = compileRunPlan(FACTORY_REVIEW_WORKFLOW, {
        workflow: 'review',
        goal: 'Review current changes',
        cwd: tempDir,
        mode: 'review',
        policy: { allowWrites: true },
      }, 'run-untrusted-path');
      store.append('run-untrusted-path', { type: 'run_started', runId: 'run-untrusted-path', plan });
      store.append('run-untrusted-path', {
        type: 'artifact_created',
        runId: 'run-untrusted-path',
        artifact: { id: 'untrusted', kind: 'review', phaseId: 'review-intake', summary: 'Untrusted path artifact', path: '/tmp/untrusted-event-path' },
      });
      store.append('run-untrusted-path', {
        type: 'artifact_created',
        runId: 'run-untrusted-path',
        artifact: { id: 'untrusted-uri', kind: 'review', phaseId: 'review-intake', summary: 'Untrusted URI artifact', uri: 'https://attacker.example/artifact' },
      });

      await commands.get('factory-status')!.handler('run-untrusted-path', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });
      expect(notifications.at(-1)?.message).toContain('Factory run run-untrusted-path');
      expect(notifications.at(-1)?.message).toContain('- untrusted: (no path) — Untrusted path artifact');
      expect(notifications.at(-1)?.message).toContain('- untrusted-uri: (no path) — Untrusted URI artifact');
      expect(notifications.at(-1)?.message).not.toContain('/tmp/untrusted-event-path');
      expect(notifications.at(-1)?.message).not.toContain('https://attacker.example/artifact');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('factory-status labels ship workflow output as readiness-only', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-ship-status-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const shipWorkflow = FACTORY_WORKFLOWS.find(workflow => workflow.id === 'ship')!;
      const plan = compileRunPlan(shipWorkflow, {
        workflow: 'ship',
        goal: 'Verify release readiness',
        cwd: tempDir,
        mode: 'ship',
        policy: { allowNetwork: true },
      }, 'run-ship-status');
      store.append('run-ship-status', { type: 'run_started', runId: 'run-ship-status', plan });

      await commands.get('factory-status')!.handler('run-ship-status', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)?.message).toContain('Workflow: ship (Structured Ship Readiness)');
      expect(notifications.at(-1)?.message).toContain('Ship readiness note: this workflow verifies readiness only; it does not tag, publish, push, or deploy.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('factory-decide can reject ship-readiness gates without interactive question capability', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-ship-reject-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const shipWorkflow = FACTORY_WORKFLOWS.find(workflow => workflow.id === 'ship')!;
      const plan = compileRunPlan(shipWorkflow, {
        workflow: 'ship',
        goal: 'Verify release readiness',
        cwd: tempDir,
        mode: 'ship',
        policy: { allowNetwork: true },
      }, 'run-ship-reject-pi');
      store.append('run-ship-reject-pi', { type: 'run_started', runId: 'run-ship-reject-pi', plan });
      const request = store.append('run-ship-reject-pi', {
        type: 'gate_requested',
        runId: 'run-ship-reject-pi',
        gate: { id: 'review-status-clean', phaseId: 'ship-readiness', title: 'Review status clean', description: 'Confirm review state.', options: ['approve', 'reject', 'cancel'], recommendation: 'reject' },
      });

      await commands.get('factory-decide')!.handler(`run-ship-reject-pi review-status-clean ${request.sequence} reject not ready`, {
        cwd: tempDir,
        isIdle: () => false,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)?.message).toContain('Factory gate reject: review-status-clean. Run run-ship-reject-pi status=cancelled.');
      expect(store.readState('run-ship-reject-pi').status).toBe('cancelled');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('factory-decide refuses ship-readiness approval until a ship-capable runtime exists', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-ship-approve-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const shipWorkflow = FACTORY_WORKFLOWS.find(workflow => workflow.id === 'ship')!;
      const plan = compileRunPlan(shipWorkflow, {
        workflow: 'ship',
        goal: 'Verify release readiness',
        cwd: tempDir,
        mode: 'ship',
        policy: { allowNetwork: true },
      }, 'run-ship-approve-pi');
      store.append('run-ship-approve-pi', { type: 'run_started', runId: 'run-ship-approve-pi', plan });
      const request = store.append('run-ship-approve-pi', {
        type: 'gate_requested',
        runId: 'run-ship-approve-pi',
        gate: { id: 'review-status-clean', phaseId: 'ship-readiness', title: 'Review status clean', description: 'Confirm review state.', options: ['approve', 'reject', 'cancel'], recommendation: 'reject' },
      });

      await commands.get('factory-decide')!.handler(`run-ship-approve-pi review-status-clean ${request.sequence} approve looks ready`, {
        cwd: tempDir,
        isIdle: () => false,
        ui: notifyInto(notifications),
      });

      expect(notifications.at(-1)).toEqual({
        message: 'Factory run run-ship-approve-pi uses ship readiness; approving ship gates requires a ship-capable runtime, which this Pi adapter does not expose yet.',
        level: 'warning',
      });
      expect(store.readState('run-ship-approve-pi').status).toBe('running');
      expect(store.readState('run-ship-approve-pi').pendingGates.map(gate => gate.id)).toEqual(['review-status-clean']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('lists and decides factory gates through Pi commands', async () => {
    const notifications: Notification[] = [];
    const { commands } = registerPiGstack();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-gates-'));

    try {
      git(tempDir, ['init']);
      const store = new FileFactoryEventStore({ rootDir: factoryRunsRoot(tempDir) });
      const plan = compileRunPlan(GATED_WORKFLOW, {
        workflow: 'gated-review',
        goal: 'Review current changes',
        cwd: tempDir,
        mode: 'review',
        policy: { allowWrites: true },
      }, 'run-gated-pi');
      store.append('run-gated-pi', { type: 'run_started', runId: 'run-gated-pi', plan });
      store.append('run-gated-pi', {
        type: 'gate_requested',
        runId: 'run-gated-pi',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.', options: ['approve', 'cancel'], recommendation: 'approve' },
      });

      await commands.get('factory-status')!.handler('run-gated-pi', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });
      expect(notifications.at(-1)?.message).toContain('Status: paused');
      expect(notifications.at(-1)?.message).toContain('Pending gates:');
      expect(notifications.at(-1)?.message).toContain('Next action: /factory-gates run-gated-pi');

      await commands.get('factory-gates')!.handler('run-gated-pi', {
        cwd: tempDir,
        ui: notifyInto(notifications),
      });
      expect(notifications.at(-1)?.message).toContain('Pending gates are listed first. Use the shown requestSequence; stale decisions are rejected.');
      expect(notifications.at(-1)?.message).toContain('approve-review: status=pending');
      expect(notifications.at(-1)?.message).toContain('requestSequence=2');
      expect(notifications.at(-1)?.message).toContain('allowed=approve|cancel');
      expect(notifications.at(-1)?.message).toContain('next=/factory-decide run-gated-pi approve-review 2 <approve|cancel> [reason]');

      await commands.get('factory-decide')!.handler('run-gated-pi approve-review 2 approve looks safe', {
        cwd: tempDir,
        isIdle: () => false,
        ui: notifyInto(notifications),
      });
      expect(notifications.at(-1)?.message).toContain('Factory gate approve: approve-review. Run run-gated-pi status=completed.');
      expect(store.readState('run-gated-pi').status).toBe('completed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  test('refuses duplicate manual review completion after the first capture commits', async () => {
    await withTempGstackEnv(async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-review-duplicate-'));

      try {
        initCommittedRepo(tempDir);
        const { notifications, commands } = registerPiGstack();
        const ctx = { cwd: tempDir, isIdle: () => false, ui: notifyInto(notifications) };

        await commands.get('factory-review')!.handler('review current changes', ctx);
        const runId = runIdFromLastNotification(notifications);

        await commands.get('factory-complete-review')!.handler(`${runId} first manual review`, ctx);
        expect(notifications.at(-1)).toEqual({ message: `Factory review completed: ${runId} (4 artifact(s)).`, level: 'info' });
        const firstCapture = capturedArtifact(tempDir, runId, 'diff-review-captured-');
        expect(firstCapture.content).toContain('first manual review');

        await commands.get('factory-complete-review')!.handler(`${runId} stale second manual review`, ctx);

        expect(notifications.at(-1)).toEqual({
          message: `Factory run ${runId} is not waiting for diff-review output.`,
          level: 'warning',
        });
        expect(capturedArtifactCount(tempDir, runId, 'diff-review-captured-')).toBe(1);
        expect(capturedArtifact(tempDir, runId, 'diff-review-captured-').id).toBe(firstCapture.id);
        expect(capturedArtifact(tempDir, runId, 'diff-review-captured-').content).toContain('first manual review');
        expect(capturedArtifact(tempDir, runId, 'diff-review-captured-').content).not.toContain('stale second manual review');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
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
