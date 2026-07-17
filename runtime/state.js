import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appendJsonLine, atomicWriteJson, readJson, withLock } from "./storage.js";
import { projectPaths } from "./paths.js";
import { discoverProjectIdentity } from "./identity.js";
import { RUNTIME_SCHEMA_VERSION } from "./migrations.js";
import { errorWithCode } from "./errors.js";
import { currentIsoTimestamp as isoNow } from "./time.js";

const PROJECT_DIRECTORIES = ["evidence", "artifacts", "reviews", "checkpoints"];
export const WORKFLOW_STATE_SCHEMA_VERSION = 1;
const WORKFLOW_DEPTHS = new Set(["quick", "standard", "deep"]);
const EVIDENCE_FRESHNESS = new Set(["unknown", "fresh", "stale"]);
const RUN_STATUSES = new Set(["running", "completed"]);
const EFFECT_STATUSES = new Set(["ready", "in_progress", "uncertain", "completed"]);
const MUTATION_AUTHORITIES = new Set([
  "source-defined",
  "report-only",
  "plan-only",
  "design-doc-only",
  "spec-only",
  "spec-and-issue",
  "design-artifacts",
  "fix-safe",
  "fix-safe-after-root-cause",
  "investigate-only",
  "code-generation",
  "commit-push-pr",
  "merge-deploy",
  "deploy",
  "docs-only",
  "profile-only",
  "configuration",
  "installation",
  "safety-policy",
  "state-only",
  "state-dependent",
  "approval-required",
  "none",
]);
const EXTERNAL_EFFECT_AUTHORITIES = new Set([
  // source-defined keeps state written by the pre-metadata GStack 2 runtime
  // resumable; new dispatchers persist their exact authority.
  "source-defined",
  "spec-and-issue",
  "commit-push-pr",
  "merge-deploy",
  "deploy",
  "state-dependent",
  "configuration",
  "installation",
]);
const WORKFLOW_KEYS = new Set([
  "schemaVersion",
  "currentPlanPointer",
  "originalGoal",
  "detourStack",
  "currentWorkflowStage",
  "selectedDepth",
  "mutationAuthority",
  "activeModules",
  "evidenceFreshness",
  "evidenceProvenance",
  "pendingApprovalGates",
]);
const WORKFLOW_TRANSITION_KEYS = new Set([
  "currentPlanPointer",
  "currentWorkflowStage",
  "selectedDepth",
  "mutationAuthority",
  "activeModules",
  "pushDetour",
  "popDetour",
  "evidenceFreshness",
  "addEvidenceProvenance",
  "addApprovalGate",
  "resolveApprovalGate",
]);

export async function initializeProject(home, identity, options = {}) {
  const paths = projectPaths(home, identity.projectId);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  return withLock(paths.lock, async () => {
    for (const name of PROJECT_DIRECTORIES) {
      await fs.mkdir(paths[name], { recursive: true, mode: 0o700 });
    }
    const now = isoNow(options.now);
    let state = await readJson(paths.state, null);
    if (!state) {
      state = {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        revision: 0,
        project: {
          id: identity.projectId,
          repoId: identity.repoId,
          worktreeId: identity.worktreeId,
          worktreeRoot: identity.worktreeRoot,
          repoCommonDir: identity.repoCommonDir,
          isGit: identity.isGit,
        },
        activeRunId: null,
        currentPlan: null,
        runs: Object.create(null),
        createdAt: now,
        updatedAt: now,
      };
      await atomicWriteJson(paths.state, state, { mode: 0o600 });
    } else {
      assertSupportedState(state, paths.state);
      // A registered worktree can move. Its ID intentionally changes when it
      // does; within an existing project, keep display paths fresh.
      state.project = { ...state.project, ...identity, id: identity.projectId };
      await atomicWriteJson(paths.state, state, { mode: 0o600 });
    }
    await ensureJsonl(paths.timeline);
    await ensureJsonl(paths.decisions);
    return { paths, state };
  });
}

export async function currentProject(home, cwd = process.cwd(), options = {}) {
  const identity = await discoverProjectIdentity(cwd, options);
  return initializeProject(home, identity, options);
}

export async function inspectProject(home, identityOrId) {
  const id = typeof identityOrId === "string" ? identityOrId : identityOrId.projectId;
  const paths = projectPaths(home, id);
  const state = await readJson(paths.state, null);
  if (!state) {
    throw errorWithCode(`No state found for project ${id}`, "STATE_NOT_FOUND");
  }
  assertSupportedState(state, paths.state);
  return { paths, state };
}

/**
 * Return the complete durable reconstruction needed to continue one run.
 * This function is intentionally read-only: callers must use resumeRun before
 * changing a non-active run.
 */
export async function inspectRun(home, projectId, runId) {
  validateRunId(runId);
  const { paths, state } = await inspectProject(home, projectId);
  const run = Object.hasOwn(state.runs, runId) ? state.runs[runId] : null;
  if (!run) throw errorWithCode(`Run not found: ${runId}`, "RUN_NOT_FOUND");
  return {
    paths,
    state,
    run,
    reconstruction: workflowReconstruction(state, run),
  };
}

export async function updateProjectState(home, projectId, mutator, options = {}) {
  const paths = projectPaths(home, projectId);
  return withLock(paths.lock, async () => {
    const state = await readJson(paths.state);
    assertSupportedState(state, paths.state);
    const result = await mutator(state);
    assertSupportedState(state, paths.state);
    state.revision = Number(state.revision ?? 0) + 1;
    state.updatedAt = isoNow(options.now);
    await atomicWriteJson(paths.state, state, { mode: 0o600 });
    return { state, result };
  }, options.lock);
}

export async function beginRun(home, projectId, command, options = {}) {
  const runId = options.runId ?? `run_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`;
  validateRunId(runId);
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  const { state, result } = await updateWithEvent(paths, async (state) => {
    if (Object.hasOwn(state.runs, runId)) {
      throw errorWithCode(`Run already exists: ${runId}`, "RUN_EXISTS");
    }
    const workflow = createWorkflowState(command, options, now);
    state.runs[runId] = {
      id: runId,
      command: String(command ?? "unknown"),
      status: "running",
      workflow,
      effects: Object.create(null),
      startedAt: now,
      updatedAt: now,
      resumeCount: 0,
    };
    state.activeRunId = runId;
    state.currentPlan = currentPlanProjection(runId, workflow, now);
    return {
      result: state.runs[runId],
      event: { type: "run.started", runId, command: state.runs[runId].command, at: now },
    };
  }, options);
  return { state, run: result, reconstruction: workflowReconstruction(state, result) };
}

export async function resumeRun(home, projectId, runId, options = {}) {
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  const { state, result } = await updateWithEvent(paths, async (state) => {
    const selected = runId ?? state.activeRunId ?? newestIncompleteRun(state);
    if (selected) validateRunId(selected);
    const run = selected && Object.hasOwn(state.runs, selected) ? state.runs[selected] : null;
    if (!run) {
      throw errorWithCode(selected ? `Run not found: ${selected}` : "No resumable run found", "RUN_NOT_FOUND");
    }
    if (run.status === "completed") {
      throw errorWithCode(`Run is already complete: ${run.id}`, "RUN_COMPLETED");
    }
    for (const effect of Object.values(run.effects ?? {})) {
      if (effect.status === "in_progress") {
        effect.status = "uncertain";
        effect.uncertainAt = now;
        effect.reason = "runtime stopped after effect was claimed; reconcile before retrying";
      }
    }
    run.status = "running";
    run.resumeCount = Number(run.resumeCount ?? 0) + 1;
    run.resumedAt = now;
    run.updatedAt = now;
    state.activeRunId = run.id;
    state.currentPlan = currentPlanProjection(run.id, run.workflow, now);
    return {
      result: run,
      event: { type: "run.resumed", runId: run.id, resumeCount: run.resumeCount, at: now },
    };
  }, options);
  return { state, run: result, reconstruction: workflowReconstruction(state, result) };
}

export async function completeRun(home, projectId, runId, options = {}) {
  validateRunId(runId);
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  const { state, result } = await updateWithEvent(paths, async (state) => {
    const run = Object.hasOwn(state.runs, runId) ? state.runs[runId] : null;
    if (!run) throw errorWithCode(`Run not found: ${runId}`, "RUN_NOT_FOUND");
    const unresolved = Object.values(run.effects ?? {}).filter((effect) =>
      ["ready", "in_progress", "uncertain"].includes(effect.status));
    if (unresolved.length && !options.allowUncertain) {
      throw errorWithCode("Run has unresolved external effects", "EFFECTS_UNCERTAIN");
    }
    if (run.workflow.pendingApprovalGates.length) {
      throw errorWithCode("Run has pending approval gates", "APPROVAL_GATES_PENDING");
    }
    run.status = "completed";
    run.completedAt = now;
    run.updatedAt = now;
    if (state.activeRunId === runId) {
      state.activeRunId = null;
      state.currentPlan = null;
    }
    return {
      result: run,
      event: { type: "run.completed", runId, at: now },
    };
  }, options);
  return { state, run: result, reconstruction: workflowReconstruction(state, result) };
}

/**
 * Apply an explicit workflow transition under the same project lock used for
 * external-effect claims. The original goal is deliberately not patchable.
 */
export async function updateRunWorkflow(home, projectId, runId, transition, options = {}) {
  validateRunId(runId);
  validateWorkflowTransition(transition);
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  const { state, result } = await updateWithEvent(paths, async (state) => {
    const run = Object.hasOwn(state.runs, runId) ? state.runs[runId] : null;
    if (!run) throw errorWithCode(`Run not found: ${runId}`, "RUN_NOT_FOUND");
    if (run.status === "completed") throw errorWithCode(`Run is already complete: ${runId}`, "RUN_COMPLETED");
    if (state.activeRunId !== runId) {
      throw errorWithCode(`Run is not active; resume it before updating: ${runId}`, "RUN_NOT_ACTIVE");
    }

    const changes = applyWorkflowTransition(run.workflow, transition, now);
    run.updatedAt = now;
    state.currentPlan = currentPlanProjection(runId, run.workflow, now);
    return {
      result: run,
      event: { type: "run.workflow_updated", runId, changes, at: now },
    };
  }, options);
  return {
    state,
    run: result,
    reconstruction: workflowReconstruction(state, result),
  };
}

/**
 * Execute an external side effect at most once from gstack's perspective.
 *
 * A durable claim is written before execute() is called. If the process dies
 * after the external system accepts the action, resume marks that claim
 * uncertain and will not call execute() again. The stable idempotencyKey should
 * also be passed to APIs that support native idempotency.
 */
export async function runExternalEffect(home, projectId, runId, effectKey, execute, options = {}) {
  validateRunId(runId);
  validateEffectKey(effectKey);
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  const claimed = await updateWithEvent(paths, async (state) => {
    const run = Object.hasOwn(state.runs, runId) ? state.runs[runId] : null;
    if (!run) throw errorWithCode(`Run not found: ${runId}`, "RUN_NOT_FOUND");
    if (run.status === "completed") throw errorWithCode(`Run is already complete: ${runId}`, "RUN_COMPLETED");
    if (state.activeRunId !== runId) {
      throw errorWithCode(`Run is not active; resume it before an external effect: ${runId}`, "RUN_NOT_ACTIVE");
    }
    if (run.workflow.pendingApprovalGates.length) {
      throw errorWithCode("Resolve pending approval gates before external effects", "APPROVAL_REQUIRED");
    }
    if (!EXTERNAL_EFFECT_AUTHORITIES.has(run.workflow.mutationAuthority)) {
      throw errorWithCode(
        `Mutation authority ${run.workflow.mutationAuthority} does not permit external effects`,
        "MUTATION_NOT_AUTHORIZED",
      );
    }
    run.effects = normalizeRecord(run.effects, validateEffectKey, "effects");
    const existing = Object.hasOwn(run.effects, effectKey) ? run.effects[effectKey] : null;
    if (existing?.status === "completed") {
      return { result: { action: "completed", effect: existing } };
    }
    if (existing && ["in_progress", "uncertain"].includes(existing.status)) {
      existing.status = "uncertain";
      existing.uncertainAt ??= now;
      return { result: { action: "uncertain", effect: existing } };
    }
    const effect = {
      key: effectKey,
      status: "in_progress",
      idempotencyKey: existing?.idempotencyKey ?? stableIdempotencyKey(projectId, runId, effectKey),
      attempts: Number(existing?.attempts ?? 0) + 1,
      claimedAt: now,
    };
    run.effects[effectKey] = effect;
    run.updatedAt = now;
    return {
      result: { action: "execute", effect },
      event: { type: "effect.claimed", runId, effectKey, idempotencyKey: effect.idempotencyKey, at: now },
    };
  }, options);

  if (claimed.result.action === "completed") {
    return { status: "completed", repeated: true, result: claimed.result.effect.result, idempotencyKey: claimed.result.effect.idempotencyKey };
  }
  if (claimed.result.action === "uncertain") {
    return {
      status: "uncertain",
      repeated: false,
      idempotencyKey: claimed.result.effect.idempotencyKey,
      reason: "Effect was already claimed; reconcile it explicitly before retrying",
    };
  }

  const effect = claimed.result.effect;
  try {
    const result = await execute({ idempotencyKey: effect.idempotencyKey, effectKey, runId });
    await completeExternalEffect(home, projectId, runId, effectKey, result, options);
    return { status: "completed", repeated: false, result, idempotencyKey: effect.idempotencyKey };
  } catch (cause) {
    await markEffectUncertain(home, projectId, runId, effectKey, cause, options).catch(() => {});
    const error = new Error(`External effect ${effectKey} may have occurred; refusing automatic retry`, { cause });
    error.code = "EXTERNAL_EFFECT_UNCERTAIN";
    error.idempotencyKey = effect.idempotencyKey;
    throw error;
  }
}

export async function completeExternalEffect(home, projectId, runId, effectKey, result, options = {}) {
  validateRunId(runId);
  validateEffectKey(effectKey);
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  return updateWithEvent(paths, async (state) => {
    const effect = ownedEffect(state, runId, effectKey);
    if (!effect) throw errorWithCode(`Effect not found: ${effectKey}`, "EFFECT_NOT_FOUND");
    if (effect.status !== "in_progress") {
      throw errorWithCode(`Effect is not in progress: ${effectKey}`, "EFFECT_NOT_IN_PROGRESS");
    }
    effect.status = "completed";
    effect.completedAt = now;
    effect.result = jsonSafe(result);
    delete effect.reason;
    return {
      result: effect,
      event: { type: "effect.completed", runId, effectKey, at: now },
    };
  }, options);
}

export async function markEffectNotApplied(home, projectId, runId, effectKey, options = {}) {
  validateRunId(runId);
  validateEffectKey(effectKey);
  const paths = projectPaths(home, projectId);
  return updateWithEvent(paths, async (state) => {
    const effect = ownedEffect(state, runId, effectKey);
    if (!effect) throw errorWithCode(`Effect not found: ${effectKey}`, "EFFECT_NOT_FOUND");
    if (effect.status !== "uncertain") {
      throw errorWithCode(`Only an uncertain effect can be reconciled as not applied: ${effectKey}`, "EFFECT_NOT_UNCERTAIN");
    }
    effect.status = "ready";
    effect.reconciledAt = isoNow(options.now);
    effect.reason = "caller confirmed the external action did not occur";
    return {
      result: effect,
      event: { type: "effect.reconciled_not_applied", runId, effectKey, at: effect.reconciledAt },
    };
  }, options);
}

export async function markEffectApplied(home, projectId, runId, effectKey, evidence, options = {}) {
  validateRunId(runId);
  validateEffectKey(effectKey);
  if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 500 || /[\r\n\0]/.test(evidence)) {
    throw new TypeError("A compact, single-line external evidence reference is required");
  }
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  return updateWithEvent(paths, async (state) => {
    const effect = ownedEffect(state, runId, effectKey);
    if (!effect) throw errorWithCode(`Effect not found: ${effectKey}`, "EFFECT_NOT_FOUND");
    if (effect.status !== "uncertain") {
      throw errorWithCode(`Only an uncertain effect can be reconciled as applied: ${effectKey}`, "EFFECT_NOT_UNCERTAIN");
    }
    effect.status = "completed";
    effect.completedAt = now;
    effect.reconciledAt = now;
    effect.result = { reconciled: true, evidence: evidence.trim() };
    effect.reason = "external inspection confirmed the action occurred";
    return {
      result: effect,
      event: { type: "effect.reconciled_applied", runId, effectKey, evidence: evidence.trim(), at: now },
    };
  }, options);
}

export async function appendDecision(home, projectId, decision, options = {}) {
  const paths = projectPaths(home, projectId);
  return withLock(paths.lock, async () => {
    const record = { ...jsonSafe(decision), id: randomUUID(), at: isoNow(options.now) };
    await appendJsonLine(paths.decisions, record, { mode: 0o600 });
    return record;
  });
}

async function markEffectUncertain(home, projectId, runId, effectKey, cause, options) {
  const paths = projectPaths(home, projectId);
  const now = isoNow(options.now);
  return updateWithEvent(paths, async (state) => {
    const effect = ownedEffect(state, runId, effectKey);
    if (!effect) throw errorWithCode(`Effect not found: ${effectKey}`, "EFFECT_NOT_FOUND");
    effect.status = "uncertain";
    effect.uncertainAt = now;
    effect.reason = String(cause?.message ?? cause ?? "unknown external error").slice(0, 500);
    return {
      result: effect,
      event: { type: "effect.uncertain", runId, effectKey, at: now },
    };
  }, options);
}

async function updateWithEvent(paths, mutator, options = {}) {
  return withLock(paths.lock, async () => {
    const state = await readJson(paths.state);
    assertSupportedState(state, paths.state);
    const mutation = await mutator(state);
    assertSupportedState(state, paths.state);
    state.revision = Number(state.revision ?? 0) + 1;
    state.updatedAt = isoNow(options.now);
    await atomicWriteJson(paths.state, state, { mode: 0o600 });
    if (mutation.event) await appendJsonLine(paths.timeline, mutation.event, { mode: 0o600 });
    return { state, result: mutation.result };
  }, options.lock);
}

async function ensureJsonl(file) {
  try {
    const handle = await fs.open(file, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await fs.chmod(file, 0o600);
}

function newestIncompleteRun(state) {
  return Object.values(state.runs ?? {})
    .filter((run) => run.status !== "completed")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.id ?? null;
}

function assertSupportedState(state, file) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error(`Invalid state file: ${file}`);
  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
    throw new Error(`Invalid state schema in ${file}`);
  }
  if (state.schemaVersion > RUNTIME_SCHEMA_VERSION) {
    throw errorWithCode(`State schema is newer than this runtime: ${file}`, "STATE_NEWER_THAN_RUNTIME");
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error(`Invalid state revision in ${file}`);
  state.runs = normalizeRecord(state.runs, validateRunId, "runs");
  for (const [runId, run] of Object.entries(state.runs)) {
    if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error(`Invalid run record in ${file}`);
    run.effects = normalizeRecord(run.effects, validateEffectKey, "effects");
    if (run.id !== runId) throw new Error(`Run key/id mismatch in ${file}`);
    if (!RUN_STATUSES.has(run.status)) throw new Error(`Invalid run status in ${file}`);
    validateCompactLine(run.command, "run command", 128);
    validateIso(run.startedAt, "run start timestamp");
    validateIso(run.updatedAt, "run update timestamp");
    if (!Number.isInteger(run.resumeCount) || run.resumeCount < 0) throw new Error(`Invalid resume count in ${file}`);
    if (run.status === "completed") validateIso(run.completedAt, "run completion timestamp");
    if (run.workflow == null) {
      // Runs written by the first GStack 2 runtime are upgraded in memory and
      // become durable on the next locked mutation. This preserves resume
      // without treating missing metadata as trustworthy caller input.
      run.workflow = createWorkflowState(run.command, {
        currentWorkflowStage: run.status === "completed" ? "completed" : "initialized",
      }, validIsoOrNow(run.updatedAt));
    }
    validateWorkflowState(run.workflow, `run ${runId} in ${file}`);
    for (const [effectKey, effect] of Object.entries(run.effects)) {
      if (!effect || typeof effect !== "object" || effect.key !== effectKey) {
        throw new Error(`Effect key/id mismatch in ${file}`);
      }
      if (!EFFECT_STATUSES.has(effect.status)) throw new Error(`Invalid effect status in ${file}`);
      if (typeof effect.idempotencyKey !== "string" || !/^gstack_[0-9a-f]{64}$/.test(effect.idempotencyKey)) {
        throw new Error(`Invalid effect idempotency key in ${file}`);
      }
      if (!Number.isInteger(effect.attempts) || effect.attempts < 1) {
        throw new Error(`Invalid effect attempt count in ${file}`);
      }
      validateIso(effect.claimedAt, "effect claim timestamp");
      if (effect.status === "completed") validateIso(effect.completedAt, "effect completion timestamp");
      if (effect.status === "uncertain") validateIso(effect.uncertainAt, "effect uncertainty timestamp");
      if (effect.status === "ready") validateIso(effect.reconciledAt, "effect reconciliation timestamp");
    }
  }
  if (state.activeRunId != null) {
    validateRunId(state.activeRunId);
    if (!Object.hasOwn(state.runs, state.activeRunId)) {
      throw new Error(`Active run does not exist in ${file}`);
    }
    if (state.runs[state.activeRunId].status !== "running") {
      throw new Error(`Active run is not running in ${file}`);
    }
  }
  if (state.currentPlan === undefined) {
    const active = state.activeRunId == null ? null : state.runs[state.activeRunId];
    state.currentPlan = active
      ? currentPlanProjection(active.id, active.workflow, validIsoOrNow(active.updatedAt))
      : null;
  }
  validateCurrentPlanProjection(state, file);
}

function createWorkflowState(command, options, now) {
  const requestedFreshness = typeof options.evidenceFreshness === "string"
    ? options.evidenceFreshness
    : options.evidenceFreshness?.status ?? "unknown";
  const workflow = {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    currentPlanPointer: options.currentPlanPointer == null ? null : options.currentPlanPointer.trim(),
    originalGoal: options.originalGoal ?? String(command ?? "unknown"),
    detourStack: options.detourStack ?? [],
    currentWorkflowStage: options.currentWorkflowStage ?? "initialized",
    selectedDepth: options.selectedDepth ?? "standard",
    mutationAuthority: options.mutationAuthority ?? "source-defined",
    activeModules: options.activeModules ?? [],
    evidenceFreshness: {
      status: requestedFreshness,
      assessedAt: requestedFreshness === "unknown" ? null : now,
    },
    evidenceProvenance: options.evidenceProvenance ?? [],
    pendingApprovalGates: options.pendingApprovalGates ?? [],
  };
  // Normalize generated timestamps for initial metadata before validation.
  workflow.detourStack = workflow.detourStack.map((detour) => ({
    ...detour,
    fromStage: detour?.fromStage ?? workflow.currentWorkflowStage,
    enteredAt: now,
  }));
  workflow.evidenceProvenance = workflow.evidenceProvenance.map((entry) => ({
    ...entry,
    capturedAt: entry?.capturedAt ?? now,
    recordedAt: now,
  }));
  workflow.pendingApprovalGates = workflow.pendingApprovalGates.map((gate) => ({
    ...gate,
    requestedAt: now,
  }));
  validateWorkflowState(workflow, "new workflow");
  return workflow;
}

function validateWorkflowState(workflow, label) {
  assertPlainRecord(workflow, label, WORKFLOW_KEYS);
  if (workflow.schemaVersion !== WORKFLOW_STATE_SCHEMA_VERSION) {
    throw errorWithCode(`Unsupported workflow schema in ${label}`, "WORKFLOW_SCHEMA_UNSUPPORTED");
  }
  validateOptionalPointer(workflow.currentPlanPointer);
  validateGoal(workflow.originalGoal, "original goal");
  if (!Array.isArray(workflow.detourStack) || workflow.detourStack.length > 64) {
    throw new TypeError(`Invalid detour stack in ${label}`);
  }
  for (const detour of workflow.detourStack) validateDetour(detour);
  validateWorkflowToken(workflow.currentWorkflowStage, "workflow stage");
  if (!WORKFLOW_DEPTHS.has(workflow.selectedDepth)) throw new TypeError("Invalid selected depth");
  validateMutationAuthority(workflow.mutationAuthority);
  validateModuleList(workflow.activeModules);
  validateEvidenceFreshness(workflow.evidenceFreshness);
  if (!Array.isArray(workflow.evidenceProvenance) || workflow.evidenceProvenance.length > 512) {
    throw new TypeError(`Invalid evidence provenance in ${label}`);
  }
  for (const entry of workflow.evidenceProvenance) validateEvidenceProvenance(entry);
  if (workflow.evidenceFreshness.status === "fresh" && workflow.evidenceProvenance.length === 0) {
    throw new TypeError("Fresh evidence requires provenance");
  }
  if (!Array.isArray(workflow.pendingApprovalGates) || workflow.pendingApprovalGates.length > 64) {
    throw new TypeError(`Invalid pending approval gates in ${label}`);
  }
  const gateIds = new Set();
  for (const gate of workflow.pendingApprovalGates) {
    validateApprovalGate(gate);
    if (gateIds.has(gate.id)) throw new TypeError(`Duplicate approval gate: ${gate.id}`);
    gateIds.add(gate.id);
  }
}

function validateWorkflowTransition(transition) {
  assertPlainRecord(transition, "workflow transition", WORKFLOW_TRANSITION_KEYS);
  if (Object.keys(transition).length === 0) throw new TypeError("Workflow transition cannot be empty");
  if (Object.hasOwn(transition, "currentPlanPointer")) validateOptionalPointer(transition.currentPlanPointer);
  if (Object.hasOwn(transition, "currentWorkflowStage")) {
    validateWorkflowToken(transition.currentWorkflowStage, "workflow stage");
  }
  if (Object.hasOwn(transition, "selectedDepth") && !WORKFLOW_DEPTHS.has(transition.selectedDepth)) {
    throw new TypeError("Invalid selected depth");
  }
  if (Object.hasOwn(transition, "mutationAuthority")) {
    validateMutationAuthority(transition.mutationAuthority);
  }
  if (Object.hasOwn(transition, "activeModules")) validateModuleList(transition.activeModules);
  if (Object.hasOwn(transition, "pushDetour")) validateGoal(transition.pushDetour, "detour goal");
  if (Object.hasOwn(transition, "popDetour") && transition.popDetour !== true) {
    throw new TypeError("popDetour must be true");
  }
  if (Object.hasOwn(transition, "pushDetour") && Object.hasOwn(transition, "popDetour")) {
    throw new TypeError("Cannot push and pop a detour in one transition");
  }
  if (Object.hasOwn(transition, "evidenceFreshness") && !EVIDENCE_FRESHNESS.has(transition.evidenceFreshness)) {
    throw new TypeError("Invalid evidence freshness");
  }
  if (Object.hasOwn(transition, "addEvidenceProvenance")) {
    validateEvidenceProvenanceInput(transition.addEvidenceProvenance);
  }
  if (Object.hasOwn(transition, "addApprovalGate")) validateApprovalGateInput(transition.addApprovalGate);
  if (Object.hasOwn(transition, "resolveApprovalGate")) validateStateKey(transition.resolveApprovalGate, "approval gate id");
  if (Object.hasOwn(transition, "addApprovalGate") && Object.hasOwn(transition, "resolveApprovalGate") &&
      transition.addApprovalGate.id === transition.resolveApprovalGate) {
    throw new TypeError("Cannot add and resolve the same approval gate in one transition");
  }
}

function applyWorkflowTransition(workflow, transition, now) {
  const changes = [];
  const previousStage = workflow.currentWorkflowStage;
  if (Object.hasOwn(transition, "currentPlanPointer")) {
    workflow.currentPlanPointer = transition.currentPlanPointer == null ? null : transition.currentPlanPointer.trim();
    changes.push("currentPlanPointer");
  }
  if (Object.hasOwn(transition, "currentWorkflowStage")) {
    workflow.currentWorkflowStage = transition.currentWorkflowStage;
    changes.push("currentWorkflowStage");
  }
  if (Object.hasOwn(transition, "selectedDepth")) {
    workflow.selectedDepth = transition.selectedDepth;
    changes.push("selectedDepth");
  }
  if (Object.hasOwn(transition, "mutationAuthority")) {
    workflow.mutationAuthority = transition.mutationAuthority;
    changes.push("mutationAuthority");
  }
  if (Object.hasOwn(transition, "activeModules")) {
    workflow.activeModules = [...new Set(transition.activeModules)];
    changes.push("activeModules");
  }
  if (Object.hasOwn(transition, "pushDetour")) {
    workflow.detourStack.push({
      goal: transition.pushDetour.trim(),
      fromStage: previousStage,
      enteredAt: now,
    });
    changes.push("detourStack.push");
  }
  if (transition.popDetour === true) {
    if (workflow.detourStack.length === 0) throw errorWithCode("No detour is available to pop", "DETOUR_STACK_EMPTY");
    workflow.detourStack.pop();
    changes.push("detourStack.pop");
  }
  if (Object.hasOwn(transition, "addEvidenceProvenance")) {
    const input = transition.addEvidenceProvenance;
    workflow.evidenceProvenance.push({
      source: input.source,
      reference: input.reference.trim(),
      capturedAt: input.capturedAt ?? now,
      recordedAt: now,
    });
    if (!Object.hasOwn(transition, "evidenceFreshness")) {
      workflow.evidenceFreshness = { status: "unknown", assessedAt: null };
    }
    changes.push("evidenceProvenance.add");
  }
  if (Object.hasOwn(transition, "evidenceFreshness")) {
    if (transition.evidenceFreshness === "fresh" && workflow.evidenceProvenance.length === 0) {
      throw new TypeError("Fresh evidence requires provenance");
    }
    workflow.evidenceFreshness = { status: transition.evidenceFreshness, assessedAt: now };
    changes.push("evidenceFreshness");
  }
  if (Object.hasOwn(transition, "addApprovalGate")) {
    const input = transition.addApprovalGate;
    if (workflow.pendingApprovalGates.some((gate) => gate.id === input.id)) {
      throw errorWithCode(`Approval gate already exists: ${input.id}`, "APPROVAL_GATE_EXISTS");
    }
    workflow.pendingApprovalGates.push({
      id: input.id,
      summary: input.summary.trim(),
      requestedAt: now,
    });
    changes.push("pendingApprovalGates.add");
  }
  if (Object.hasOwn(transition, "resolveApprovalGate")) {
    const index = workflow.pendingApprovalGates.findIndex((gate) => gate.id === transition.resolveApprovalGate);
    if (index === -1) {
      throw errorWithCode(`Approval gate not found: ${transition.resolveApprovalGate}`, "APPROVAL_GATE_NOT_FOUND");
    }
    workflow.pendingApprovalGates.splice(index, 1);
    changes.push("pendingApprovalGates.resolve");
  }
  validateWorkflowState(workflow, "updated workflow");
  return changes;
}

function workflowReconstruction(state, run) {
  const currentDetour = run.workflow.detourStack.at(-1);
  return {
    runId: run.id,
    status: run.status,
    isActive: state.activeRunId === run.id,
    currentPlan: state.activeRunId === run.id ? state.currentPlan : currentPlanProjection(run.id, run.workflow, run.updatedAt),
    currentPlanPointer: run.workflow.currentPlanPointer,
    originalGoal: run.workflow.originalGoal,
    currentGoal: currentDetour?.goal ?? run.workflow.originalGoal,
    detourStack: run.workflow.detourStack,
    currentWorkflowStage: run.workflow.currentWorkflowStage,
    selectedDepth: run.workflow.selectedDepth,
    mutationAuthority: run.workflow.mutationAuthority,
    activeModules: run.workflow.activeModules,
    evidenceFreshness: run.workflow.evidenceFreshness,
    evidenceProvenance: run.workflow.evidenceProvenance,
    pendingApprovalGates: run.workflow.pendingApprovalGates,
    effects: run.effects,
  };
}

function currentPlanProjection(runId, workflow, at) {
  return workflow.currentPlanPointer == null
    ? null
    : { runId, pointer: workflow.currentPlanPointer, updatedAt: validIsoOrNow(at) };
}

function validateCurrentPlanProjection(state, file) {
  if (state.currentPlan == null) {
    const active = state.activeRunId == null ? null : state.runs[state.activeRunId];
    if (active?.workflow.currentPlanPointer != null) {
      throw new Error(`Current plan projection is missing in ${file}`);
    }
    return;
  }
  assertPlainRecord(state.currentPlan, `current plan in ${file}`, new Set(["runId", "pointer", "updatedAt"]));
  validateRunId(state.currentPlan.runId);
  validateOptionalPointer(state.currentPlan.pointer, false);
  validateIso(state.currentPlan.updatedAt, "current plan timestamp");
  if (state.activeRunId !== state.currentPlan.runId || !Object.hasOwn(state.runs, state.currentPlan.runId)) {
    throw new Error(`Current plan is not owned by the active run in ${file}`);
  }
  if (state.runs[state.currentPlan.runId].workflow.currentPlanPointer !== state.currentPlan.pointer) {
    throw new Error(`Current plan projection is inconsistent in ${file}`);
  }
}

function validateDetour(detour) {
  assertPlainRecord(detour, "detour", new Set(["goal", "fromStage", "enteredAt"]));
  validateGoal(detour.goal, "detour goal");
  validateWorkflowToken(detour.fromStage, "detour source stage");
  validateIso(detour.enteredAt, "detour timestamp");
}

function validateEvidenceFreshness(value) {
  assertPlainRecord(value, "evidence freshness", new Set(["status", "assessedAt"]));
  if (!EVIDENCE_FRESHNESS.has(value.status)) throw new TypeError("Invalid evidence freshness");
  if (value.assessedAt != null) validateIso(value.assessedAt, "evidence assessment timestamp");
  if (value.status !== "unknown" && value.assessedAt == null) {
    throw new TypeError("Assessed evidence freshness requires a timestamp");
  }
}

function validateEvidenceProvenanceInput(entry) {
  assertPlainRecord(entry, "evidence provenance input", new Set(["source", "reference", "capturedAt"]));
  validateWorkflowToken(entry.source, "evidence source");
  validateCompactLine(entry.reference, "evidence reference", 2_048);
  if (entry.capturedAt != null) validateIso(entry.capturedAt, "evidence capture timestamp");
}

function validateEvidenceProvenance(entry) {
  assertPlainRecord(entry, "evidence provenance", new Set(["source", "reference", "capturedAt", "recordedAt"]));
  validateWorkflowToken(entry.source, "evidence source");
  validateCompactLine(entry.reference, "evidence reference", 2_048);
  validateIso(entry.capturedAt, "evidence capture timestamp");
  validateIso(entry.recordedAt, "evidence record timestamp");
}

function validateApprovalGateInput(gate) {
  assertPlainRecord(gate, "approval gate input", new Set(["id", "summary"]));
  validateStateKey(gate.id, "approval gate id");
  validateGoal(gate.summary, "approval gate summary", 2_048);
}

function validateApprovalGate(gate) {
  assertPlainRecord(gate, "approval gate", new Set(["id", "summary", "requestedAt"]));
  validateStateKey(gate.id, "approval gate id");
  validateGoal(gate.summary, "approval gate summary", 2_048);
  validateIso(gate.requestedAt, "approval gate timestamp");
}

function validateModuleList(modules) {
  if (!Array.isArray(modules) || modules.length > 64) throw new TypeError("Invalid active modules");
  const seen = new Set();
  for (const moduleName of modules) {
    validateStateKey(moduleName, "active module");
    if (seen.has(moduleName)) throw new TypeError(`Duplicate active module: ${moduleName}`);
    seen.add(moduleName);
  }
}

function validateOptionalPointer(value, nullable = true) {
  if (nullable && value == null) return;
  validateCompactLine(value, "current plan pointer", 2_048);
}

function validateWorkflowToken(value, label) {
  validateStateKey(value, label);
}

function validateMutationAuthority(value) {
  validateWorkflowToken(value, "mutation authority");
  if (!MUTATION_AUTHORITIES.has(value)) throw new TypeError("Unsupported mutation authority");
}

function validateGoal(value, label, max = 20_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function validateCompactLine(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function validateIso(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function validIsoOrNow(value) {
  try {
    validateIso(value, "timestamp");
    return value;
  } catch {
    return new Date().toISOString();
  }
}

function assertPlainRecord(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Invalid ${label}`);
  }
  for (const key of Object.keys(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !allowedKeys.has(key)) {
      throw new TypeError(`Unknown ${label} field: ${key}`);
    }
  }
}

function normalizeRecord(value, validateKey, label) {
  if (value == null) return Object.create(null);
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${label} record`);
  const normalized = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    validateKey(key);
    normalized[key] = child;
  }
  return normalized;
}

function ownedEffect(state, runId, effectKey) {
  const run = Object.hasOwn(state.runs ?? {}, runId) ? state.runs[runId] : null;
  if (!run || !Object.hasOwn(run.effects ?? {}, effectKey)) return null;
  return run.effects[effectKey];
}

function validateRunId(value) {
  validateStateKey(value, "run id");
}

function validateEffectKey(value) {
  validateStateKey(value, "external effect key");
}

function validateStateKey(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ||
      ["__proto__", "prototype", "constructor"].includes(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function stableIdempotencyKey(projectId, runId, effectKey) {
  const digest = createHash("sha256")
    .update(String(projectId)).update("\0")
    .update(runId).update("\0")
    .update(effectKey)
    .digest("hex");
  return `gstack_${digest}`;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
