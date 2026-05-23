// Production-readiness smoke runner for the Universe AI Software Factory.
//
// Source of truth: docs/designs/PI_SOFTWARE_FACTORY_BETA_OPERATIONS_SECURITY_CONTRACT.md §B2.1.
//
// Posture rules (mirrored from the contract):
//   - run in caller-provided temp directories only;
//   - never read or write user paths outside the caller's temp dir and the repo source tree;
//   - never read user env vars or echo secret-looking values;
//   - never perform external network or shell-out;
//   - fail closed on missing/broken module surface area;
//   - never use deploy/publish/release vocabulary in messages.
//
// The runner exercises the engine surface area described by §3.2 S1-S11. S11
// (web /health) is intentionally surfaced as `deferred` because no production
// web app exists yet — it is documented as a separate not-ready-until gate, not
// stubbed green.

import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  createFactoryFacade,
  planFactoryRun,
} from './factory';
import { FileFactoryArtifactStore } from './factory-artifact-store';
import { FileFactoryEventStore } from './factory-event-store';
import type { FactoryRuntimeCapabilities } from './factory-capabilities';
import type {
  ArtifactRef,
  CapabilityName,
  FactoryRunState,
  WorkflowSpec,
} from './factory-core';
import {
  FileFactoryProjectStore,
  isSafeFactoryProjectId,
} from './factory-project-store';
import {
  parseQaLogJsonl,
  pendingQaDispatchFromState,
  qaLogEntryToArtifact,
  selectQaCaptureEntry,
  type QaLogEntry,
  type PendingQaDispatch,
} from './factory-qa-capture';
import { FACTORY_QA_WORKFLOW } from './factory-qa-workflow';
import {
  FACTORY_REVIEW_WORKFLOW,
  FACTORY_WORKFLOWS,
} from './factory-review-workflow';
import { FACTORY_SHIP_WORKFLOW } from './factory-ship-workflow';
import {
  FactoryCommandGuardBlockedError,
  createFactoryGuardedCommandRuntime,
  type FactoryGuardedCommandDecisionObservation,
  type SanitizedFactoryGuardDecision,
} from './factory-guarded-runtime';
import {
  createFactoryGuardDenialArtifactDto,
  createFactoryGuardDenialEventDto,
} from './factory-guard-denial';
import {
  buildDistributionManifest,
  isSafeRelativeBundlePath,
  planDistributionBundle,
  planDistributionInstallUpdateDryRun,
  type DistributionManifest,
} from './factory-distribution';

export type FactoryProductionSmokeStatus = 'pass' | 'fail' | 'deferred';

export type FactoryProductionSmokeCheckId =
  | 'S1-module-load'
  | 'S2-facade-plan'
  | 'S3-facade-status'
  | 'S4-facade-list'
  | 'S5-facade-artifact-read'
  | 'S6-project-catalog-roundtrip'
  | 'S7-qa-log-parse'
  | 'S8-qa-recover-fixture'
  | 'S9-guarded-denial-audit'
  | 'S10-distribution-dry-run'
  | 'S11-web-health';

export interface FactoryProductionSmokeCheckResult {
  readonly id: FactoryProductionSmokeCheckId;
  readonly title: string;
  readonly status: FactoryProductionSmokeStatus;
  readonly summary: string;
  readonly details: readonly string[];
  readonly deferredReason?: string;
}

export interface FactoryProductionSmokeSummary {
  /** Overall pass/fail. Deferred checks do NOT contribute to overall pass. */
  readonly status: 'pass' | 'fail';
  /** True iff every non-deferred check returned `pass`. */
  readonly allRequiredPassed: boolean;
  /** True iff at least one check is deferred — overall status can still be 'pass'. */
  readonly hasDeferredGates: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly deferredCount: number;
  readonly checks: readonly FactoryProductionSmokeCheckResult[];
}

export interface FactoryProductionSmokeOptions {
  /**
   * Caller-owned temp directory. The runner creates subdirectories under this
   * path for facade event stores, project catalogs, distribution staging, etc.
   * The caller is responsible for cleaning it up.
   */
  readonly workDir: string;
  /** Override the clock for deterministic timestamps in audit details. */
  readonly now?: () => Date;
}

const CHECK_TITLES: Record<FactoryProductionSmokeCheckId, string> = {
  'S1-module-load': 'Module load',
  'S2-facade-plan': 'Facade plan',
  'S3-facade-status': 'Facade status',
  'S4-facade-list': 'Facade list',
  'S5-facade-artifact-read': 'Facade artifact read',
  'S6-project-catalog-roundtrip': 'Project catalog read/write',
  'S7-qa-log-parse': 'QA log parse',
  'S8-qa-recover-fixture': 'QA recover fixture',
  'S9-guarded-denial-audit': 'Guarded denial audit',
  'S10-distribution-dry-run': 'Distribution dry-run',
  'S11-web-health': 'Web /health',
};

const PROHIBITED_LANGUAGE = ['deployed', 'published', 'released', 'tagged', 'pushed'] as const;

/**
 * Run the Beta 2 production-readiness smoke contract from a clean checkout.
 *
 * Returns a deterministic summary DTO with one result per check. Performs no
 * external shell-out, network, env reads, or writes outside `options.workDir`.
 */
export async function runFactoryProductionSmoke(
  options: FactoryProductionSmokeOptions,
): Promise<FactoryProductionSmokeSummary> {
  assertSafeWorkDir(options.workDir);
  mkdirSync(options.workDir, { recursive: true });

  const now = options.now ?? (() => new Date());
  const checks: FactoryProductionSmokeCheckResult[] = [];

  checks.push(runCheck('S1-module-load', () => checkModuleLoad()));
  checks.push(runCheck('S2-facade-plan', () => checkFacadePlan()));
  checks.push(await runCheckAsync('S3-facade-status', () => checkFacadeStatus(options.workDir, now)));
  checks.push(await runCheckAsync('S4-facade-list', () => checkFacadeList(options.workDir, now)));
  checks.push(await runCheckAsync('S5-facade-artifact-read', () => checkFacadeArtifactRead(options.workDir, now)));
  checks.push(runCheck('S6-project-catalog-roundtrip', () => checkProjectCatalogRoundtrip(options.workDir, now)));
  checks.push(runCheck('S7-qa-log-parse', () => checkQaLogParse()));
  checks.push(runCheck('S8-qa-recover-fixture', () => checkQaRecoverFixture(options.workDir, now)));
  checks.push(await runCheckAsync('S9-guarded-denial-audit', () => checkGuardedDenialAudit()));
  checks.push(runCheck('S10-distribution-dry-run', () => checkDistributionDryRun(options.workDir)));
  checks.push(checkWebHealthDeferred());

  const passCount = checks.filter(c => c.status === 'pass').length;
  const failCount = checks.filter(c => c.status === 'fail').length;
  const deferredCount = checks.filter(c => c.status === 'deferred').length;
  const allRequiredPassed = failCount === 0;
  // Overall status is fail when any non-deferred check failed. Deferred items
  // remain visible separately so callers can refuse to flip a release gate
  // until those gates clear independently.
  const status: 'pass' | 'fail' = allRequiredPassed ? 'pass' : 'fail';

  assertNoProhibitedLanguage(checks);

  return {
    status,
    allRequiredPassed,
    hasDeferredGates: deferredCount > 0,
    passCount,
    failCount,
    deferredCount,
    checks,
  };
}

// ---------------------------------------------------------------------------
// Per-check implementations
// ---------------------------------------------------------------------------

function checkModuleLoad(): CheckBody {
  // Importing this file already pulled every factory-* module through the
  // module loader. Validate that key exports are present and shaped as
  // expected so a future drive-by removal of a symbol surfaces as a smoke
  // fail rather than a runtime surprise.
  const requirements: Array<[string, unknown, string]> = [
    ['planFactoryRun', planFactoryRun, 'function'],
    ['createFactoryFacade', createFactoryFacade, 'function'],
    ['FileFactoryEventStore', FileFactoryEventStore, 'function'],
    ['FileFactoryArtifactStore', FileFactoryArtifactStore, 'function'],
    ['FileFactoryProjectStore', FileFactoryProjectStore, 'function'],
    ['parseQaLogJsonl', parseQaLogJsonl, 'function'],
    ['selectQaCaptureEntry', selectQaCaptureEntry, 'function'],
    ['qaLogEntryToArtifact', qaLogEntryToArtifact, 'function'],
    ['pendingQaDispatchFromState', pendingQaDispatchFromState, 'function'],
    ['createFactoryGuardedCommandRuntime', createFactoryGuardedCommandRuntime, 'function'],
    ['buildDistributionManifest', buildDistributionManifest, 'function'],
    ['planDistributionBundle', planDistributionBundle, 'function'],
    ['planDistributionInstallUpdateDryRun', planDistributionInstallUpdateDryRun, 'function'],
    ['isSafeRelativeBundlePath', isSafeRelativeBundlePath, 'function'],
    ['FACTORY_REVIEW_WORKFLOW', FACTORY_REVIEW_WORKFLOW, 'object'],
    ['FACTORY_QA_WORKFLOW', FACTORY_QA_WORKFLOW, 'object'],
    ['FACTORY_SHIP_WORKFLOW', FACTORY_SHIP_WORKFLOW, 'object'],
    ['FACTORY_WORKFLOWS', FACTORY_WORKFLOWS, 'object'],
  ];

  const details: string[] = [];
  for (const [name, value, expectedType] of requirements) {
    const actual = typeof value;
    if (actual !== expectedType) {
      throw new Error(`expected ${name} to be a ${expectedType}; got ${actual}`);
    }
    details.push(`${name}: ${expectedType}`);
  }

  return {
    summary: `loaded ${requirements.length} factory module exports`,
    details,
  };
}

function checkFacadePlan(): CheckBody {
  const workflowIds = ['review', 'qa', 'ship'] as const;
  const phaseSpine: Record<(typeof workflowIds)[number], readonly string[]> = {
    review: ['review-intake', 'diff-review', 'review-summary'],
    qa: ['qa-intake', 'qa-execution', 'qa-summary'],
    // Ship workflow has gated readiness/publication/release phases between
    // intake and summary. Plan compilation includes them in 'ship' mode.
    ship: [
      'ship-intake',
      'ship-readiness',
      'ship-publication-readiness',
      'ship-release-gate',
      'ship-summary',
    ],
  };

  const details: string[] = [];
  for (const id of workflowIds) {
    const plan = planFactoryRun(
      {
        workflow: id,
        goal: `Smoke ${id}`,
        cwd: '/tmp/smoke',
        mode: id === 'ship' ? 'ship' : 'review',
        policy: { allowWrites: false, commandSafetyProfile: 'read-only' },
      },
      { makeRunId: () => `smoke-${id}` },
    );
    if (plan.runId !== `smoke-${id}`) {
      throw new Error(`plan for ${id} returned runId='${plan.runId}'`);
    }
    if (plan.workflow !== id) {
      throw new Error(`plan for ${id} returned workflow='${plan.workflow}'`);
    }
    const phases = plan.phases.map(phase => phase.id);
    const expected = phaseSpine[id];
    if (phases.length !== expected.length || phases.some((p, i) => p !== expected[i])) {
      throw new Error(`plan for ${id} produced phases=${JSON.stringify(phases)}; expected ${JSON.stringify(expected)}`);
    }
    details.push(`${id}: ${phases.join(' -> ')}`);
  }

  return {
    summary: `planned ${workflowIds.length} workflow run graphs deterministically`,
    details,
  };
}

async function checkFacadeStatus(workDir: string, now: () => Date): Promise<CheckBody> {
  const { facade, runId, runtime } = await runSyntheticWorkflow(workDir, 'facade-status', now);
  const status = await facade.readFactoryRunStatus(runId);

  if (status.status !== 'completed') throw new Error(`expected completed status; got ${status.status}`);
  if (status.runId !== runId) throw new Error(`status returned runId='${status.runId}'`);
  if (status.progress.completed !== status.progress.total) {
    throw new Error(`expected progress.completed === progress.total; got ${status.progress.completed}/${status.progress.total}`);
  }
  if (runtime.executed.length !== status.progress.total) {
    throw new Error(`runtime executed ${runtime.executed.length} phases; status reports ${status.progress.total}`);
  }
  return {
    summary: `facade status DTO matches reduced run state (${status.progress.total} phases)`,
    details: [
      `runId: ${status.runId}`,
      `phases: ${status.completedPhaseIds.join(', ')}`,
      `artifactCount: ${status.artifacts.length}`,
      `pendingGateCount: ${status.gates.filter(gate => gate.status === 'pending').length}`,
    ],
  };
}

async function checkFacadeList(workDir: string, now: () => Date): Promise<CheckBody> {
  const root = path.join(workDir, 'facade-list');
  mkdirSync(root, { recursive: true });
  const firstRunId = 'smoke-list-1';
  const secondRunId = 'smoke-list-2';

  await runSyntheticWorkflow(workDir, 'facade-list', now, { runId: firstRunId, rootOverride: root });
  await runSyntheticWorkflow(workDir, 'facade-list', now, { runId: secondRunId, rootOverride: root });

  const facade = createFactoryFacade({ runsRoot: root });
  const items = await facade.listFactoryRuns();

  if (items.length !== 2) throw new Error(`expected 2 runs listed; got ${items.length}`);
  const seenIds = new Set(items.map(item => item.runId));
  if (!seenIds.has(firstRunId) || !seenIds.has(secondRunId)) {
    throw new Error(`listed runs missing expected ids: ${JSON.stringify([...seenIds])}`);
  }
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1].updatedAt ?? '';
    const cur = items[i].updatedAt ?? '';
    if (cur > prev) {
      throw new Error('list ordering is not most-recent-first');
    }
  }
  const filtered = await facade.listFactoryRuns({ status: 'completed', limit: 1 });
  if (filtered.length !== 1) throw new Error(`limit=1 returned ${filtered.length} items`);

  return {
    summary: `facade list returned ${items.length} runs in stable most-recent-first order`,
    details: items.map(item => `${item.runId}: ${item.status} (${item.artifactCount} artifacts)`),
  };
}

async function checkFacadeArtifactRead(workDir: string, now: () => Date): Promise<CheckBody> {
  const { facade, runId } = await runSyntheticWorkflow(workDir, 'facade-artifact', now);
  const status = await facade.readFactoryRunStatus(runId);
  if (status.artifacts.length === 0) throw new Error('expected at least one artifact');
  const target = status.artifacts[0];

  const dto = await facade.readFactoryArtifact(runId, target.id);
  if (dto.runId !== runId) throw new Error(`artifact DTO runId='${dto.runId}'`);
  if (dto.artifact.id !== target.id) throw new Error(`artifact DTO id='${dto.artifact.id}'`);
  if (typeof dto.content !== 'string' || dto.content.length === 0) {
    throw new Error('artifact DTO content is not a non-empty string');
  }
  if (typeof dto.createdAt !== 'string') throw new Error('artifact DTO createdAt missing');

  let missingThrew = false;
  try {
    await facade.readFactoryArtifact(runId, 'definitely-not-an-artifact');
  } catch {
    missingThrew = true;
  }
  if (!missingThrew) throw new Error('expected reading a missing artifact to throw');

  return {
    summary: `facade artifact read returns text DTO and fails clearly on missing ids`,
    details: [
      `artifact id: ${target.id}`,
      `content length: ${dto.content.length} bytes`,
    ],
  };
}

function checkProjectCatalogRoundtrip(workDir: string, now: () => Date): CheckBody {
  const root = path.join(workDir, 'project-catalog');
  const store = new FileFactoryProjectStore({ rootDir: root, now });

  const workspaceId = 'smoke-workspace';
  const projectId = 'smoke-project';
  const runId = 'smoke-run';

  store.upsertWorkspace({ workspaceId, name: 'Smoke Workspace' });
  const project = store.createProject({
    projectId,
    workspaceId,
    name: 'Smoke Project',
    oneLineGoal: 'Validate project catalog smoke.',
  });
  if (project.projectId !== projectId) throw new Error('project create returned wrong id');

  const link = store.addRunLink(projectId, { runId, workflowId: 'review', relationship: 'primary' });
  if (link.runId !== runId) throw new Error('addRunLink returned wrong runId');

  const reread = store.readProject(projectId);
  if (!reread) throw new Error('readProject returned null after create');
  if (reread.linkedRuns.length !== 1) throw new Error(`expected 1 linked run; got ${reread.linkedRuns.length}`);

  const listed = store.listProjects(workspaceId).map(p => p.projectId);
  if (listed.length !== 1 || listed[0] !== projectId) {
    throw new Error(`listProjects returned ${JSON.stringify(listed)}`);
  }

  const missing = store.readProject('not-present-project');
  if (missing !== null) throw new Error('readProject for missing id did not degrade to null');

  // Unsafe IDs must be rejected at the catalog boundary, not silently coerced.
  let unsafeThrew = false;
  try {
    store.createProject({
      projectId: '../escape',
      workspaceId,
      name: 'Unsafe',
      oneLineGoal: 'Should never persist.',
    });
  } catch {
    unsafeThrew = true;
  }
  if (!unsafeThrew) throw new Error('expected unsafe projectId to be rejected');
  if (isSafeFactoryProjectId('../escape')) throw new Error('isSafeFactoryProjectId did not reject parent-traversal id');

  return {
    summary: 'project catalog round-trips workspace/project/run-link under a temp dir and rejects unsafe ids',
    details: [
      `workspaceId: ${workspaceId}`,
      `projectId: ${projectId}`,
      `linkedRuns: ${reread.linkedRuns.length}`,
    ],
  };
}

function checkQaLogParse(): CheckBody {
  // Mix valid + malformed lines. Malformed lines should be silently dropped;
  // the parser is fail-closed downstream via no-match selection.
  const dispatch: PendingQaDispatch = {
    runId: 'smoke-qa-1',
    phaseId: 'qa-execution',
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    queuedSkillCommand: '/skill:gstack-qa-only Smoke target',
  };
  const validEntry = {
    skill: 'qa-only',
    timestamp: '2026-01-01T00:00:05.000Z',
    status: 'clean',
    mode: 'audit',
    summary: 'Smoke audit clean',
    target_url: 'http://localhost:0',
    factory_run_id: dispatch.runId,
    passed: 1,
    failed: 0,
  };
  const stale = { ...validEntry, timestamp: '2025-12-31T00:00:00.000Z' };
  const wrongRun = { ...validEntry, factory_run_id: 'other-run' };
  const log = [
    JSON.stringify(validEntry),
    'this line is not json',
    JSON.stringify(stale),
    JSON.stringify(wrongRun),
    '',
  ].join('\n');

  const parsed = parseQaLogJsonl(log);
  if (parsed.length !== 3) throw new Error(`expected 3 parsed entries; got ${parsed.length}`);

  const match = selectQaCaptureEntry(parsed, dispatch);
  if (!match.ok) throw new Error(`expected a single correlated match; got ${match.reason}`);
  if (match.entry.timestamp !== validEntry.timestamp) {
    throw new Error('selected the wrong entry');
  }

  const noMatchDispatch = { ...dispatch, runId: 'smoke-qa-no-match' };
  const noMatch = selectQaCaptureEntry(parsed, noMatchDispatch);
  if (noMatch.ok || noMatch.reason !== 'no-match') {
    throw new Error('expected no-match on wrong run id');
  }

  const ambiguousLog = [JSON.stringify(validEntry), JSON.stringify({ ...validEntry, timestamp: '2026-01-01T00:00:06.000Z' })].join('\n');
  const ambiguousParsed = parseQaLogJsonl(ambiguousLog);
  const ambiguous = selectQaCaptureEntry(ambiguousParsed, dispatch);
  if (ambiguous.ok || ambiguous.reason !== 'ambiguous') {
    throw new Error('expected ambiguous selection on duplicate matches');
  }

  return {
    summary: 'QA log parser drops malformed lines and selects exactly one correlated entry per dispatch',
    details: [
      'malformed line: dropped',
      'wrong run id: no-match',
      'duplicate match: ambiguous',
    ],
  };
}

function checkQaRecoverFixture(workDir: string, now: () => Date): CheckBody {
  const runId = 'smoke-qa-recover';
  const dispatch: PendingQaDispatch = {
    runId,
    phaseId: 'qa-execution',
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    queuedSkillCommand: '/skill:gstack-qa-only Smoke recover',
  };

  // pendingQaDispatchFromState must surface the same dispatch fields from a
  // reduced run state — exercise that calculation so the recover-side code
  // path is end-to-end covered, not just the parser.
  const state: FactoryRunState = {
    runId,
    status: 'running',
    currentPhaseId: 'qa-execution',
    completedPhaseIds: ['qa-intake'],
    pendingGates: [],
    gateDecisions: [],
    risks: [],
    artifacts: [{
      id: 'qa-execution-dispatch',
      kind: 'qa-report',
      phaseId: 'qa-execution',
      summary: 'Queued QA audit',
      metadata: {
        factoryRunId: runId,
        pendingExternalQa: true,
        dispatchedAt: dispatch.dispatchedAt,
        queuedSkillCommand: dispatch.queuedSkillCommand,
      },
    }],
  };
  const pending = pendingQaDispatchFromState(state);
  if (!pending || pending.runId !== runId) {
    throw new Error('pendingQaDispatchFromState did not derive the dispatch from run state');
  }

  const entry: QaLogEntry = {
    skill: 'qa-only',
    timestamp: '2026-01-01T00:00:10.000Z',
    status: 'clean',
    mode: 'audit',
    summary: 'Recover fixture',
    target_url: 'http://localhost:0',
    factory_run_id: runId,
    passed: 1,
    failed: 0,
  };
  const selection = selectQaCaptureEntry([entry], dispatch);
  if (!selection.ok) throw new Error('recover fixture selection failed');

  const { ref, content } = qaLogEntryToArtifact(runId, selection.entry);
  if (ref.kind !== 'qa-report') throw new Error(`artifact ref kind='${ref.kind}'`);
  if (!content.includes('# Captured GStack QA')) throw new Error('artifact content missing capture header');

  // Persist into a temp artifact store and verify idempotent re-render.
  const root = path.join(workDir, 'qa-recover');
  const artifactStore = new FileFactoryArtifactStore({ rootDir: root, now });
  artifactStore.writeText(runId, ref, content);
  const second = qaLogEntryToArtifact(runId, selection.entry);
  artifactStore.writeText(runId, second.ref, second.content);
  if (second.content !== content) {
    throw new Error('qaLogEntryToArtifact is non-deterministic across repeat recovery');
  }
  const stored = artifactStore.readText(runId, ref.id);
  if (stored.content !== content) throw new Error('persisted artifact content drift');

  return {
    summary: 'QA recover fixture selects, renders, and idempotently persists a single artifact',
    details: [
      `runId: ${runId}`,
      `artifact id: ${ref.id}`,
      `content bytes: ${content.length}`,
    ],
  };
}

async function checkGuardedDenialAudit(): Promise<CheckBody> {
  const audit: SanitizedFactoryGuardDecision[] = [];
  const runtime = createFactoryGuardedCommandRuntime<string>({
    executeCommand: () => {
      // executeCommand must never run for denied commands.
      throw new Error('guarded runtime invoked executeCommand for a denied request');
    },
    onCommandDecision: (obs: FactoryGuardedCommandDecisionObservation) => {
      audit.push(obs.sanitized);
    },
  });

  if (!runtime.guardActive) throw new Error('expected guardActive=true for default runtime');
  if (!runtime.availableCapabilities.includes('safe-command-guard')) {
    throw new Error('expected safe-command-guard capability to be advertised');
  }

  const denialCommands = [
    'rm -rf /',
    'git push --force',
    'cat .env',
  ];

  const details: string[] = [];
  for (const command of denialCommands) {
    let threw: unknown = null;
    try {
      await runtime.executeCommand({
        command,
        cwd: '/tmp/smoke',
        workspaceRoot: '/tmp/smoke',
        profile: 'non-destructive-write',
      });
    } catch (error) {
      threw = error;
    }
    if (!(threw instanceof FactoryCommandGuardBlockedError)) {
      throw new Error(`guard did not block command '${command}'`);
    }
    if (threw.decision.allowed) throw new Error(`guard returned allowed=true for '${command}'`);
    details.push(`${command} -> blocked (${threw.decision.matchedRuleId ?? 'unknown-rule'})`);
  }

  if (audit.length !== denialCommands.length) {
    throw new Error(`expected ${denialCommands.length} audit entries; got ${audit.length}`);
  }
  for (let i = 0; i < audit.length; i += 1) {
    const sanitized = audit[i];
    const command = denialCommands[i];
    if (sanitized.allowed) throw new Error(`audit entry ${i} reported allowed=true`);
    if (sanitized.severity !== 'block') throw new Error(`audit entry ${i} severity='${sanitized.severity}'`);
    if (typeof sanitized.commandDigest !== 'string' || sanitized.commandDigest.length === 0) {
      throw new Error(`audit entry ${i} missing commandDigest`);
    }
    if (sanitized.commandHead && command.includes(sanitized.commandHead) === false) {
      // commandHead is the first token's last path segment; should be the
      // executable name for these fixtures, not the full command string.
      throw new Error(`audit entry ${i} commandHead='${sanitized.commandHead}' is not a prefix token of '${command}'`);
    }
    // The sanitized audit must never carry the raw destructive args (`-rf /`,
    // `--force`, `.env`). The digest is the only handle to the original.
    const audited = JSON.stringify(sanitized);
    if (audited.includes('-rf') || audited.includes('--force') || audited.includes('.env')) {
      throw new Error(`audit entry ${i} leaked raw command tokens: ${audited}`);
    }
  }

  const eventDtos = audit.map((denial, i) => createFactoryGuardDenialEventDto({
    runId: 'smoke-guard-denial-run',
    phaseId: 'qa-execution',
    workflowId: 'qa-fix',
    denial,
    occurredAt: new Date(1_700_000_000_000 + i).toISOString(),
  }));
  const artifactDto = createFactoryGuardDenialArtifactDto({
    runId: 'smoke-guard-denial-run',
    phaseId: 'qa-execution',
    workflowId: 'qa-fix',
    denials: audit,
    createdAt: new Date(1_700_000_000_100).toISOString(),
  });
  if (artifactDto.summary.total !== denialCommands.length || artifactDto.summary.blocked !== denialCommands.length) {
    throw new Error('guard denial artifact summary count mismatch');
  }
  for (let i = 0; i < eventDtos.length; i += 1) {
    const serialized = JSON.stringify(eventDtos[i]);
    const command = denialCommands[i] ?? '';
    if (serialized.includes(command)) {
      throw new Error(`guard denial event ${i} leaked raw command text`);
    }
  }

  return {
    summary: `guard blocked ${denialCommands.length} denial commands and emitted sanitized audit records`,
    details,
  };
}

function checkDistributionDryRun(workDir: string): CheckBody {
  const sourceRoot = path.join(workDir, 'distribution', 'src');
  const bundleRoot = path.join(workDir, 'distribution', 'staged-bundle-fixture');
  const outputDir = path.join(workDir, 'distribution', 'out');
  const freshInstallRoot = path.join(workDir, 'distribution', 'fresh-install-root');
  const updateInstallRoot = path.join(workDir, 'distribution', 'managed-install-root');

  // Plant tiny source and staged-bundle fixture trees. No real package is
  // installed; we only exercise the dry-run plan paths.
  plantFixtureFile(sourceRoot, '.pi/extensions/pi-gstack/index.ts', '// fixture extension\n');
  plantFixtureFile(sourceRoot, '.pi/skills/gstack-review/SKILL.md', '# fixture review skill\n');
  plantFixtureFile(sourceRoot, 'ETHOS.md', 'fixture ethos\n');
  plantFixtureFile(bundleRoot, 'extensions/gstack/index.ts', '// fixture extension\n');
  plantFixtureFile(bundleRoot, 'skills/gstack-review/SKILL.md', '# fixture review skill\n');
  plantFixtureFile(bundleRoot, 'skills/gstack/ETHOS.md', 'fixture ethos\n');

  const manifest: DistributionManifest = buildDistributionManifest({
    bundleVersion: '0.0.0-smoke',
    builtAt: '2026-01-01T00:00:00.000Z',
    compatibility: { host: 'pi' },
    extensionFiles: [{
      sourcePath: '.pi/extensions/pi-gstack/index.ts',
      bundlePath: 'extensions/gstack/index.ts',
      installPath: 'extensions/gstack/index.ts',
      required: true,
    }],
    generatedSkillFiles: [{
      sourcePath: '.pi/skills/gstack-review/SKILL.md',
      bundlePath: 'skills/gstack-review/SKILL.md',
      installPath: 'skills/gstack-review/SKILL.md',
      required: true,
    }],
    runtimeSidecars: [{
      sourcePath: 'ETHOS.md',
      bundlePath: 'skills/gstack/ETHOS.md',
      installPath: 'skills/gstack/ETHOS.md',
      required: true,
    }],
  });

  const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });
  if (!plan.validation.ok) {
    throw new Error(`distribution validation failed: missing ${plan.validation.missingRequired.map(i => i.sourcePath).join(', ')}`);
  }
  if (plan.conflicts.length !== 0) {
    throw new Error(`unexpected conflicts in dry-run plan: ${plan.conflicts.map(c => c.bundlePath).join(', ')}`);
  }
  if (plan.totalFiles !== manifest.files.length) {
    throw new Error(`plan reports ${plan.totalFiles} files; expected ${manifest.files.length}`);
  }

  const installPlan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot: freshInstallRoot });
  if (!installPlan.ok || installPlan.summary.createCount !== manifest.files.length) {
    throw new Error(`install dry-run did not plan a clean first install: ${JSON.stringify(installPlan.summary)}`);
  }

  plantFixtureFile(updateInstallRoot, 'skills/gstack-review/SKILL.md', '# fixture review skill\n');
  plantFixtureFile(updateInstallRoot, 'skills/gstack/ETHOS.md', 'old fixture ethos\n');
  plantFixtureFile(updateInstallRoot, 'skills/gstack-old/SKILL.md', '# old skill\n');
  const currentManifest = buildDistributionManifest({
    bundleVersion: '0.0.0-old-smoke',
    builtAt: '2025-12-31T00:00:00.000Z',
    compatibility: { host: 'pi' },
    generatedSkillFiles: [
      { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: 'skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
      { sourcePath: '.pi/skills/gstack-old/SKILL.md', bundlePath: 'skills/gstack-old/SKILL.md', installPath: 'skills/gstack-old/SKILL.md', required: true },
    ],
    runtimeSidecars: [{
      sourcePath: 'ETHOS.md',
      bundlePath: 'skills/gstack/ETHOS.md',
      installPath: 'skills/gstack/ETHOS.md',
      required: true,
    }],
  });
  const updatePlan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot: updateInstallRoot, currentManifest });
  if (!updatePlan.ok) {
    throw new Error(`update dry-run reported conflicts: ${updatePlan.conflicts.map(c => `${c.reason}:${c.installPath}`).join(', ')}`);
  }
  if (updatePlan.summary.createCount !== 1 || updatePlan.summary.updateCount !== 1 || updatePlan.summary.keepCount !== 1 || updatePlan.summary.removeCount !== 1) {
    throw new Error(`update dry-run summary mismatch: ${JSON.stringify(updatePlan.summary)}`);
  }

  // Refuse unsafe relative paths up front.
  if (isSafeRelativeBundlePath('../escape.md')) {
    throw new Error('isSafeRelativeBundlePath accepted a parent-traversal path');
  }

  return {
    summary: `distribution dry-run validated ${plan.totalFiles} files (${plan.totalBytes} bytes), first install, and managed update without installing or publishing`,
    details: [
      ...plan.entries.map(entry => `${entry.category}:${entry.bundlePath} (${entry.sizeBytes} bytes)`),
      `install dry-run: create=${installPlan.summary.createCount}, bytes=${installPlan.summary.bytesToWrite}`,
      `update dry-run: create=${updatePlan.summary.createCount}, update=${updatePlan.summary.updateCount}, keep=${updatePlan.summary.keepCount}, remove=${updatePlan.summary.removeCount}`,
    ],
  };
}

function checkWebHealthDeferred(): FactoryProductionSmokeCheckResult {
  // S11 is intentionally not stubbed green. The Beta 2 contract documents
  // this gate as a separate not-ready-until item that cannot be satisfied
  // from inside the smoke runner — a real production web app must exist
  // first. Surface it as `deferred` so callers can refuse to flip a Beta 2
  // release gate even when the rest of smoke passes.
  return {
    id: 'S11-web-health',
    title: CHECK_TITLES['S11-web-health'],
    status: 'deferred',
    summary: 'Web /health gate is deferred — production web app does not exist yet.',
    details: [
      'Reference: docs/designs/PI_SOFTWARE_FACTORY_BETA_OPERATIONS_SECURITY_CONTRACT.md §3.2 S11.',
      'Deferred until an approved web stack ships /health with no secrets in the response body.',
    ],
    deferredReason: 'No production web app exists. Stubbing /health would be a false safety claim per §3.2/§3.4.',
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface CheckBody {
  readonly summary: string;
  readonly details?: readonly string[];
}

function runCheck(
  id: FactoryProductionSmokeCheckId,
  body: () => CheckBody,
): FactoryProductionSmokeCheckResult {
  try {
    const result = body();
    return {
      id,
      title: CHECK_TITLES[id],
      status: 'pass',
      summary: result.summary,
      details: result.details ?? [],
    };
  } catch (error) {
    return failResult(id, error);
  }
}

async function runCheckAsync(
  id: FactoryProductionSmokeCheckId,
  body: () => Promise<CheckBody>,
): Promise<FactoryProductionSmokeCheckResult> {
  try {
    const result = await body();
    return {
      id,
      title: CHECK_TITLES[id],
      status: 'pass',
      summary: result.summary,
      details: result.details ?? [],
    };
  } catch (error) {
    return failResult(id, error);
  }
}

function failResult(id: FactoryProductionSmokeCheckId, error: unknown): FactoryProductionSmokeCheckResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    title: CHECK_TITLES[id],
    status: 'fail',
    summary: `Smoke check ${id} failed: ${message}`,
    details: [message],
  };
}

interface SyntheticRunResult {
  readonly facade: ReturnType<typeof createFactoryFacade>;
  readonly runId: string;
  readonly rootDir: string;
  readonly runtime: SmokeFakeRuntime;
}

interface SmokeFakeRuntime extends FactoryRuntimeCapabilities {
  readonly executed: string[];
}

const SMOKE_WORKFLOW: WorkflowSpec = Object.freeze({
  id: 'smoke-synthetic',
  title: 'Smoke Synthetic',
  description: 'Synthetic workflow used only by the production smoke runner.',
  requiredCapabilities: ['artifact-store'],
  phases: [
    {
      id: 'smoke-intake',
      title: 'Smoke Intake',
      role: { id: 'smoke-intake', title: 'Smoke Intake' },
      objective: 'Synthetic intake phase for smoke.',
      requiredCapabilities: ['artifact-store'],
      outputs: [{ id: 'smoke-intake-output', kind: 'plan', description: 'Smoke intake output.' }],
      modes: ['review'],
    },
    {
      id: 'smoke-summary',
      title: 'Smoke Summary',
      role: { id: 'smoke-summary', title: 'Smoke Summary' },
      objective: 'Synthetic summary phase for smoke.',
      requiredCapabilities: ['artifact-store'],
      outputs: [{ id: 'smoke-summary-output', kind: 'review', description: 'Smoke summary output.' }],
      modes: ['review'],
    },
  ],
});

async function runSyntheticWorkflow(
  workDir: string,
  scope: string,
  now: () => Date,
  options: { runId?: string; rootOverride?: string } = {},
): Promise<SyntheticRunResult> {
  const rootDir = options.rootOverride ?? path.join(workDir, scope);
  mkdirSync(rootDir, { recursive: true });

  const capabilities: CapabilityName[] = ['agent-session', 'artifact-store', 'git'];
  const artifactStore = new FileFactoryArtifactStore({ rootDir, now });
  const executed: string[] = [];
  const runtime: SmokeFakeRuntime = {
    executed,
    availableCapabilities: capabilities,
    executePhase({ phase, plan }) {
      executed.push(phase.id);
      const artifact: ArtifactRef = {
        id: `${phase.id}-artifact`,
        kind: phase.expectedArtifacts[0]?.kind ?? 'review',
        phaseId: phase.id,
        summary: `${phase.id} artifact`,
      };
      const ref = artifactStore.writeText(plan.runId, artifact, `${phase.id} complete`);
      return {
        summary: `${phase.id} complete`,
        artifacts: [ref],
      };
    },
  };

  const runId = options.runId ?? `smoke-${scope}-run`;
  const facade = createFactoryFacade({
    runsRoot: rootDir,
    workflows: [SMOKE_WORKFLOW],
    runtime,
    makeRunId: () => runId,
  });

  await facade.runFactoryWorkflow({
    workflow: SMOKE_WORKFLOW.id,
    goal: `Smoke ${scope}`,
    cwd: rootDir,
    mode: 'review',
    policy: { allowWrites: false, commandSafetyProfile: 'read-only' },
  });

  return { facade, runId, rootDir, runtime };
}

function plantFixtureFile(rootDir: string, relPath: string, content: string): void {
  const abs = path.join(rootDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function assertSafeWorkDir(workDir: string): void {
  if (typeof workDir !== 'string' || workDir.length === 0) {
    throw new Error('Factory production smoke requires an absolute workDir');
  }
  if (!path.isAbsolute(workDir)) {
    throw new Error(`Factory production smoke workDir must be absolute; got '${workDir}'`);
  }
}

function assertNoProhibitedLanguage(checks: readonly FactoryProductionSmokeCheckResult[]): void {
  // §3.4: smoke output must never imply release vocabulary. Guard the runner's
  // own messages so we cannot regress this rule silently.
  for (const check of checks) {
    const corpus = [check.summary, ...(check.details ?? []), check.deferredReason ?? ''].join('\n').toLowerCase();
    for (const banned of PROHIBITED_LANGUAGE) {
      // 'pushed' is permitted in operational vocabulary outside ship-readiness.
      // Smoke summaries should avoid all five anyway; this loop enforces that.
      if (corpus.includes(banned)) {
        throw new Error(`Factory smoke check ${check.id} emitted prohibited release vocabulary '${banned}'`);
      }
    }
  }
}
