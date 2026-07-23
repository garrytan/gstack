/**
 * garygoal-state — the deterministic core of the /garygoal orchestration skill.
 *
 * /garygoal (the SKILL.md template) owns judgment: routing, reading specialist
 * skills, interpreting artifacts. THIS module owns facts: which state
 * transitions are legal, what evidence each completed state requires, which
 * gates are valid at which commit SHA, which gates a diff invalidates, how many
 * repair attempts remain, and whether policy permits a merge. The agent cannot
 * advance the pipeline by prose — only through these validated calls, invoked
 * via bin/gstack-garygoal.
 *
 * Storage: <state root>/projects/<slug>/garygoal/<run-id>/ where <state root>
 * is $GSTACK_HOME when set, else ~/.gstack (skill bash blocks export
 * GSTACK_HOME="$GSTACK_STATE_ROOT" after eval'ing gstack-paths, keeping the
 * two names pointed at the same directory):
 *   run.json       — the whole run record (atomic tmp+rename; schema-versioned)
 *   events.jsonl   — append-only narration (lib/jsonl-store: injection-rejected,
 *                    redact-scanned, tolerant reads)
 * A branch-scoped lock file (.lock-<branch>) prevents two simultaneous runs
 * from fighting over one branch; stale locks from dead pids are reclaimed.
 *
 * Built on lib/jsonl-store.ts + lib/redact-engine.ts — same audited plumbing
 * as the decision/learnings stores, so injection and secret handling never
 * drift between stores.
 */

import { join } from "path";
import { homedir } from "os";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  readFileSync,
  readdirSync,
} from "fs";
import { hasInjection } from "./jsonl-store";
import { scan } from "./redact-engine";

export const SCHEMA_VERSION = 1;

// ─── States ─────────────────────────────────────────────────────────

export type GaryGoalState =
  | "INTAKE"
  | "REPOSITORY_AUDITED"
  | "OBJECTIVE_CONTRACT_WRITTEN"
  | "SPECIFIED"
  | "PLANNED"
  | "IMPLEMENTING"
  | "IMPLEMENTATION_COMPLETE"
  | "CODE_REVIEW"
  | "SECURITY_REVIEW"
  | "DESIGN_REVIEW"
  | "DEVEX_REVIEW"
  | "BROWSER_QA"
  | "PERFORMANCE_REVIEW"
  | "DOCUMENTATION"
  | "SHIPPING"
  | "PR_OPEN"
  | "CI_PENDING"
  | "CI_REPAIR"
  | "REVIEW_PENDING"
  | "REVIEW_REPAIR"
  | "READY_TO_MERGE"
  | "MERGING"
  | "MERGED"
  | "DEPLOYING"
  | "CANARY"
  | "VERIFIED"
  | "ROLLED_BACK"
  | "BLOCKED"
  | "FAILED";

export const GARYGOAL_STATES: readonly GaryGoalState[] = [
  "INTAKE", "REPOSITORY_AUDITED", "OBJECTIVE_CONTRACT_WRITTEN", "SPECIFIED",
  "PLANNED", "IMPLEMENTING", "IMPLEMENTATION_COMPLETE", "CODE_REVIEW",
  "SECURITY_REVIEW", "DESIGN_REVIEW", "DEVEX_REVIEW", "BROWSER_QA",
  "PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "PR_OPEN", "CI_PENDING",
  "CI_REPAIR", "REVIEW_PENDING", "REVIEW_REPAIR", "READY_TO_MERGE", "MERGING",
  "MERGED", "DEPLOYING", "CANARY", "VERIFIED", "ROLLED_BACK", "BLOCKED", "FAILED",
];

/** Terminal: nothing may transition out. */
const TERMINAL_STATES: readonly GaryGoalState[] = ["VERIFIED", "FAILED"];
/** Not offered for --resume (the run reached an end, happy or not). */
const RESUME_EXCLUDED: readonly GaryGoalState[] = ["VERIFIED", "FAILED", "ROLLED_BACK"];

export type RunMode = "plan" | "pr" | "merge" | "repair-pr";

/**
 * Legal transitions. BLOCKED and FAILED are reachable from every non-terminal
 * state (appended at check time, not listed per-row). The review rows form an
 * ordered flow — each review state may advance to any LATER stage or drop back
 * to IMPLEMENTING for a fix loop; it may never skip backwards, so evidence
 * can't be laundered by re-entering an earlier state.
 */
const TRANSITIONS: Record<GaryGoalState, readonly GaryGoalState[]> = {
  INTAKE: ["REPOSITORY_AUDITED"],
  REPOSITORY_AUDITED: ["OBJECTIVE_CONTRACT_WRITTEN"],
  OBJECTIVE_CONTRACT_WRITTEN: ["SPECIFIED", "PLANNED"],
  SPECIFIED: ["PLANNED"],
  PLANNED: ["IMPLEMENTING"],
  IMPLEMENTING: ["IMPLEMENTATION_COMPLETE"],
  IMPLEMENTATION_COMPLETE: ["CODE_REVIEW"],
  CODE_REVIEW: ["SECURITY_REVIEW", "DESIGN_REVIEW", "DEVEX_REVIEW", "BROWSER_QA", "PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "IMPLEMENTING"],
  SECURITY_REVIEW: ["DESIGN_REVIEW", "DEVEX_REVIEW", "BROWSER_QA", "PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "IMPLEMENTING"],
  DESIGN_REVIEW: ["DEVEX_REVIEW", "BROWSER_QA", "PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "IMPLEMENTING"],
  DEVEX_REVIEW: ["BROWSER_QA", "PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "IMPLEMENTING"],
  BROWSER_QA: ["PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "IMPLEMENTING"],
  PERFORMANCE_REVIEW: ["DOCUMENTATION", "SHIPPING", "IMPLEMENTING"],
  DOCUMENTATION: ["SHIPPING"],
  SHIPPING: ["PR_OPEN", "CODE_REVIEW", "IMPLEMENTING"],
  PR_OPEN: ["CI_PENDING"],
  CI_PENDING: ["CI_REPAIR", "REVIEW_PENDING"],
  CI_REPAIR: ["CI_PENDING"],
  REVIEW_PENDING: ["REVIEW_REPAIR", "READY_TO_MERGE"],
  REVIEW_REPAIR: ["CI_PENDING", "REVIEW_PENDING"],
  READY_TO_MERGE: ["MERGING", "CI_PENDING"],
  MERGING: ["MERGED"],
  MERGED: ["DEPLOYING"],
  DEPLOYING: ["CANARY"],
  CANARY: ["VERIFIED", "ROLLED_BACK"],
  ROLLED_BACK: [],
  BLOCKED: [], // resume target validated against blocked_from in transition()
  VERIFIED: [],
  FAILED: [],
};

export type TransitionCheck = { ok: true } | { ok: false; error: string };

/**
 * Pure state-pair check. The repair-pr entry jump (REPOSITORY_AUDITED →
 * PR_OPEN) is only legal in repair-pr mode — a normal goal run must earn its
 * PR through SHIPPING. BLOCKED resume targets need run context; use
 * transition() for that.
 */
export function validateTransition(from: GaryGoalState, to: GaryGoalState, mode: RunMode): TransitionCheck {
  if (TERMINAL_STATES.includes(from)) {
    return { ok: false, error: `${from} is terminal — no further transitions` };
  }
  if (from === "BLOCKED") {
    if (to === "FAILED") return { ok: true };
    return { ok: false, error: "BLOCKED resumes only to the state it blocked from (validated by transition()) or FAILED" };
  }
  if (to === "BLOCKED" || to === "FAILED") return { ok: true };
  let allowed = [...TRANSITIONS[from]];
  if (mode === "repair-pr" && from === "REPOSITORY_AUDITED") allowed.push("PR_OPEN");
  // Merging and deploying are merge-authority operations. A pr/plan-mode run
  // must never be able to walk itself into MERGING through the state machine —
  // the mode gate lives HERE, not only in the advisory merge-check.
  if (mode !== "merge" && mode !== "repair-pr") {
    allowed = allowed.filter((s) => s !== "MERGING" && s !== "DEPLOYING");
  }
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    error: `illegal transition ${from} → ${to}; allowed from ${from}: ${allowed.join(", ") || "(none)"}, BLOCKED, FAILED`,
  };
}

// ─── Evidence requirements ──────────────────────────────────────────

export type Evidence = Record<string, unknown>;

interface EvidenceRule {
  key: string;
  /** Human hint appended to the error when the check fails. */
  hint: string;
  check: (v: unknown) => boolean;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isSha = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v);
const isSha256 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/**
 * What each state demands before it can be entered. "Done because the agent
 * said so" is exactly the failure mode this table exists to prevent — every
 * completed state carries verifiable evidence.
 */
const EVIDENCE_REQUIREMENTS: Partial<Record<GaryGoalState, readonly EvidenceRule[]>> = {
  OBJECTIVE_CONTRACT_WRITTEN: [
    { key: "contract_path", hint: "path to objective-contract.md", check: isNonEmptyString },
  ],
  SPECIFIED: [
    { key: "spec_path", hint: "path or URL of the spec artifact", check: isNonEmptyString },
  ],
  PLANNED: [
    { key: "plan_path", hint: "path of the approved plan", check: isNonEmptyString },
    { key: "plan_sha256", hint: "sha256 of the approved plan file", check: isSha256 },
  ],
  IMPLEMENTATION_COMPLETE: [
    { key: "tests_command", hint: "the test command that was run", check: isNonEmptyString },
    { key: "tests_status", hint: '"pass" required', check: (v) => v === "pass" },
  ],
  CODE_REVIEW: [
    { key: "artifact", hint: "review artifact path or ledger ref", check: isNonEmptyString },
    { key: "commit", hint: "commit SHA the review covered", check: isSha },
  ],
  SECURITY_REVIEW: [
    { key: "artifact", hint: "security report path", check: isNonEmptyString },
    { key: "commit", hint: "commit SHA the audit covered", check: isSha },
    { key: "verdict", hint: '"clean" or "accepted" (explicitly accepted advisories)', check: (v) => v === "clean" || v === "accepted" },
  ],
  DESIGN_REVIEW: [
    { key: "artifact", hint: "design review artifact path", check: isNonEmptyString },
    { key: "commit", hint: "commit SHA reviewed", check: isSha },
  ],
  DEVEX_REVIEW: [
    { key: "artifact", hint: "DX review artifact path", check: isNonEmptyString },
    { key: "commit", hint: "commit SHA reviewed", check: isSha },
  ],
  BROWSER_QA: [
    { key: "artifact", hint: "QA report path", check: isNonEmptyString },
    { key: "commit", hint: "commit SHA tested", check: isSha },
    { key: "url", hint: "URL exercised", check: isNonEmptyString },
  ],
  PERFORMANCE_REVIEW: [
    { key: "artifact", hint: "benchmark report path", check: isNonEmptyString },
    { key: "commit", hint: "commit SHA measured", check: isSha },
  ],
  PR_OPEN: [
    { key: "pr_number", hint: "real PR number", check: (v) => Number.isInteger(v) && (v as number) > 0 },
    { key: "pr_url", hint: "PR URL", check: isNonEmptyString },
    { key: "base_branch", hint: "PR base branch", check: isNonEmptyString },
    { key: "head_branch", hint: "PR head branch", check: isNonEmptyString },
    { key: "head_sha", hint: "PR head SHA", check: isSha },
  ],
  READY_TO_MERGE: [
    { key: "ci_status", hint: 'required checks must be "passing"', check: (v) => v === "passing" },
    { key: "review_state", hint: "current review state", check: isNonEmptyString },
    { key: "unresolved_threads", hint: "must be 0", check: (v) => v === 0 },
    { key: "head_sha", hint: "PR head SHA the checks ran against", check: isSha },
  ],
  MERGING: [
    { key: "merge_check", hint: '"allowed" — the verdict from gstack-garygoal merge-check', check: (v) => v === "allowed" },
    { key: "head_sha", hint: "the head SHA merge-check approved (must match READY_TO_MERGE)", check: isSha },
  ],
  MERGED: [
    { key: "merge_sha", hint: "merge commit SHA", check: isSha },
  ],
  CANARY: [],
  VERIFIED: [
    { key: "deployed_sha", hint: "SHA verified running in production", check: isSha },
    { key: "prod_url", hint: "production URL checked", check: isNonEmptyString },
    { key: "canary_status", hint: '"HEALTHY" required', check: (v) => v === "HEALTHY" },
  ],
  ROLLED_BACK: [
    { key: "reason", hint: "what failed and what was rolled back", check: isNonEmptyString },
  ],
  BLOCKED: [
    { key: "reason", hint: "why the run is blocked", check: isNonEmptyString },
  ],
  FAILED: [
    { key: "reason", hint: "why the run failed", check: isNonEmptyString },
  ],
};

function checkEvidence(state: GaryGoalState, evidence: Evidence): string[] {
  const rules = EVIDENCE_REQUIREMENTS[state] ?? [];
  return rules
    .filter((r) => !r.check(evidence[r.key]))
    .map((r) => `${state} requires evidence "${r.key}" (${r.hint})`);
}

// ─── Run record ─────────────────────────────────────────────────────

export type GateStatus = "pass" | "fail";

export interface GateRecord {
  status: GateStatus;
  sha: string;
  artifact?: string;
  recorded_at: string;
  invalidated?: { at: string; reason: string };
}

export type GateName =
  | "tests"
  | "code_review"
  | "security_review"
  | "design_review"
  | "devex_review"
  | "browser_qa"
  | "performance"
  | "docs"
  | "plan_complete"
  | "merge_readiness";

export const GARYGOAL_GATES: readonly GateName[] = [
  "tests", "code_review", "security_review", "design_review", "devex_review",
  "browser_qa", "performance", "docs", "plan_complete", "merge_readiness",
];

export type GateLedger = Partial<Record<GateName, GateRecord>>;

export interface RunBudgets {
  /** Per-failing-check CI repair attempts (distinct root-cause hypotheses). */
  ci_repair: Record<string, number>;
  review_repair_cycles: number;
  ship_reruns: number;
}

export interface GaryGoalRun {
  schema_version: number;
  run_id: string;
  slug: string;
  branch: string;
  mode: RunMode;
  objective: string;
  state: GaryGoalState;
  /** Set while state === BLOCKED: the state to resume into. */
  blocked_from?: GaryGoalState;
  /**
   * Set when the run reached its per-mode designed endpoint (READY_TO_MERGE
   * in pr mode, PLANNED in plan mode, MERGED without deploy). Endpoint runs
   * are done-but-not-terminal: excluded from --resume auto-pickup so a new
   * objective on the same branch never resumes a finished run, yet still
   * loadable by explicit run-id for inspection.
   */
  endpoint_reached?: boolean;
  state_evidence: Partial<Record<GaryGoalState, Evidence>>;
  gates: GateLedger;
  budgets: RunBudgets;
  pr_number?: number;
  created_at: string;
  updated_at: string;
}

export interface NewRunInput {
  runId: string;
  slug: string;
  branch: string;
  mode: RunMode;
  objective: string;
  createdAt?: string;
}

export function newRun(input: NewRunInput): GaryGoalRun {
  const at = input.createdAt ?? new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    run_id: input.runId,
    slug: input.slug,
    branch: input.branch,
    mode: input.mode,
    objective: input.objective,
    state: "INTAKE",
    state_evidence: {},
    gates: {},
    budgets: { ci_repair: {}, review_repair_cycles: 0, ship_reruns: 0 },
    created_at: at,
    updated_at: at,
  };
}

export type TransitionResult = { ok: true; run: GaryGoalRun } | { ok: false; error: string };

/**
 * Validate and apply a state transition, returning a NEW run (input untouched).
 * Entering BLOCKED records blocked_from; resuming out of BLOCKED may only
 * target that state (evidence re-validation is skipped on resume — the work
 * continues where it stopped; fresh evidence is demanded when the run next
 * COMPLETES a state, not when it re-enters one).
 */
export function transition(run: GaryGoalRun, to: GaryGoalState, evidence: Evidence): TransitionResult {
  if (TERMINAL_STATES.includes(run.state)) {
    return { ok: false, error: `${run.state} is terminal — no further transitions` };
  }
  let resumeFromBlocked = false;
  if (run.state === "BLOCKED") {
    if (to !== "FAILED" && to !== run.blocked_from) {
      return {
        ok: false,
        error: `BLOCKED run resumes only to ${run.blocked_from ?? "(unknown)"} or FAILED, not ${to}`,
      };
    }
    resumeFromBlocked = to === run.blocked_from;
  } else {
    const v = validateTransition(run.state, to, run.mode);
    if (!v.ok) return v;
  }
  if (!resumeFromBlocked) {
    const missing = checkEvidence(to, evidence);
    if (missing.length > 0) return { ok: false, error: missing.join("; ") };
  }
  // MERGING must carry the exact head SHA that READY_TO_MERGE evidenced —
  // a SHA that moved between the gate and the merge is the classic race.
  if (to === "MERGING") {
    const gatedSha = run.state_evidence.READY_TO_MERGE?.head_sha;
    if (typeof gatedSha !== "string" || String(evidence.head_sha).toLowerCase() !== gatedSha.toLowerCase()) {
      return { ok: false, error: "MERGING head_sha must match the head SHA recorded at READY_TO_MERGE — re-run the readiness gate for the current head" };
    }
  }
  // Evidence persists into run.json and re-enters agent context on resume and
  // in status output — same write-path posture as events: injection and
  // secret-shaped free text are rejected, never stored. The walk is DEEP
  // (nested arrays/objects included); pure-hex values (commit SHAs, plan
  // hashes) are structured identifiers, not free text.
  const freeText = collectFreeText(evidence).join("\n");
  if (freeText.length > 0) {
    const safe = validateEventText(freeText);
    if (!safe.ok) return { ok: false, error: `evidence rejected: ${safe.error}` };
  }
  return {
    ok: true,
    run: {
      ...run,
      state: to,
      blocked_from: to === "BLOCKED" ? run.state : undefined,
      // Resuming out of BLOCKED must not wipe the evidence the state was
      // originally entered with — the final report is built from it.
      state_evidence: resumeFromBlocked
        ? run.state_evidence
        : { ...run.state_evidence, [to]: evidence },
      updated_at: new Date().toISOString(),
    },
  };
}

/** Every string in a value tree except pure-hex identifiers. */
function collectFreeText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!/^[0-9a-f]{7,64}$/i.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectFreeText(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectFreeText(v, out);
  }
  return out;
}

// ─── Gate ledger ────────────────────────────────────────────────────

export interface RecordGateInput {
  status: GateStatus;
  sha: string;
  artifact?: string;
}

/** Record a gate result tied to the commit SHA it validated. Returns a new ledger. */
export function recordGate(gates: GateLedger, name: GateName, input: RecordGateInput): GateLedger {
  return {
    ...gates,
    [name]: {
      status: input.status,
      sha: input.sha,
      artifact: input.artifact,
      recorded_at: new Date().toISOString(),
    },
  };
}

/** A gate is valid only if it passed, is not invalidated, and covered exactly headSha. */
export function gateValid(gates: GateLedger, name: GateName, headSha: string): boolean {
  const g = gates[name];
  return !!g && g.status === "pass" && !g.invalidated && g.sha.toLowerCase() === headSha.toLowerCase();
}

// ─── Change classification + invalidation matrix ────────────────────

export type ChangeCategory =
  | "docs"
  | "frontend"
  | "backend"
  | "tests_only"
  | "auth"
  | "migration"
  | "deps"
  | "ci"
  | "other";

const DEP_FILES =
  /(^|\/)(package\.json|bun\.lock|yarn\.lock|package-lock\.json|pnpm-lock\.yaml|Gemfile(\.lock)?|requirements[^/]*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock))$/i;
const TEST_FILE = /((^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$)/i;
const MIGRATION_FILE = /((^|\/)migrations?\/|(^|\/)schema\.(sql|rb|prisma)$)/i;
const AUTH_FILE = /(auth|login|signin|session|permission|rbac|entitle|paywall|subscri|password|oauth|token)/i;
/** Next.js-style server route dirs that would otherwise match the frontend rule. */
const API_ROUTE_FILE = /(^|\/)(pages\/api|app\/api)\//i;
const FRONTEND_FILE = /(\.(css|scss|sass|less|tsx|jsx|vue|svelte|html|astro)$|(^|\/)(components|views|pages|styles|layouts|public)\/)/i;
const BACKEND_FILE = /\.(ts|js|mjs|cjs|py|rb|go|rs|java|kt|php|ex|exs|c|cc|cpp|sql|sh)$/i;
const CI_FILE = /(^\.(github|circleci)\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)bitrise\.yml$|(^|\/)Jenkinsfile$)/i;
const DOC_FILE = /(\.(md|mdx|rst)$|^docs\/)/i;

/**
 * Classify one changed path. First match wins within the mutually-exclusive
 * base kinds (tests/deps/ci/docs/migration); `auth` is additive because an
 * auth-touching file is ALSO frontend or backend.
 */
function classifyOne(file: string): ChangeCategory[] {
  const cats: ChangeCategory[] = [];
  if (AUTH_FILE.test(file) && !DOC_FILE.test(file) && !CI_FILE.test(file)) cats.push("auth");
  if (TEST_FILE.test(file)) return [...cats, "tests_only"];
  if (DEP_FILES.test(file)) return [...cats, "deps"];
  if (CI_FILE.test(file)) return [...cats, "ci"];
  if (MIGRATION_FILE.test(file)) return [...cats, "migration"];
  if (DOC_FILE.test(file)) return [...cats, "docs"];
  if (API_ROUTE_FILE.test(file)) return [...cats, "backend"]; // pages/api is server logic, not frontend
  if (FRONTEND_FILE.test(file)) return [...cats, "frontend"];
  if (BACKEND_FILE.test(file)) return [...cats, "backend"];
  return [...cats, "other"];
}

/** Union of categories across every changed path. */
export function classifyPaths(files: readonly string[]): Set<ChangeCategory> {
  const out = new Set<ChangeCategory>();
  for (const f of files) for (const c of classifyOne(f)) out.add(c);
  return out;
}

/**
 * The deterministic invalidation matrix. Documented rules (mirrored in
 * docs/designs/GARYGOAL.md and pinned by tests):
 *  - docs-only        → docs (+ final merge check) — browser QA survives
 *  - frontend/CSS     → design review, browser QA, tests — NOT security review
 *  - backend          → tests, code review
 *  - tests-only       → test evidence only — visual evidence survives
 *  - auth/authz       → tests, security review, browser QA, code review
 *  - migrations       → tests, security review, code review
 *  - deps / CI config → tests, security review
 *  - anything at all  → merge_readiness (the PR-head-SHA final check)
 */
const INVALIDATION: Record<ChangeCategory, readonly GateName[]> = {
  docs: ["docs"],
  frontend: ["design_review", "browser_qa", "tests"],
  backend: ["tests", "code_review"],
  tests_only: ["tests"],
  auth: ["tests", "security_review", "browser_qa", "code_review"],
  migration: ["tests", "security_review", "code_review"],
  deps: ["tests", "security_review"],
  ci: ["tests", "security_review"],
  other: ["tests", "code_review"],
};

/** Gates invalidated by a change spanning `categories`. Empty change → nothing. */
export function invalidationFor(categories: ReadonlySet<ChangeCategory>): GateName[] {
  if (categories.size === 0) return [];
  const out = new Set<GateName>(["merge_readiness"]);
  for (const c of categories) for (const g of INVALIDATION[c]) out.add(g);
  return GARYGOAL_GATES.filter((g) => out.has(g));
}

export interface InvalidationContext {
  reason: string;
}

/** Clear exactly the gates the diff invalidates, recording why. Returns a new ledger. */
export function applyInvalidation(gates: GateLedger, files: readonly string[], ctx: InvalidationContext): GateLedger {
  const hit = new Set(invalidationFor(classifyPaths(files)));
  const at = new Date().toISOString();
  const out: GateLedger = {};
  for (const [name, record] of Object.entries(gates) as [GateName, GateRecord][]) {
    out[name] = hit.has(name) && !record.invalidated
      ? { ...record, invalidated: { at, reason: ctx.reason } }
      : record;
  }
  return out;
}

// ─── Budgets ────────────────────────────────────────────────────────

export type BudgetKind = "ci_repair" | "review_repair" | "ship_rerun";

export interface SpendBudgetOpts {
  cap: number;
  /** Required for ci_repair — the failing check the hypothesis targets. */
  key?: string;
}

export type BudgetResult = { ok: true; run: GaryGoalRun } | { ok: false; error: string };

/**
 * Spend one attempt from a bounded repair budget. At the cap the spend FAILS —
 * the caller must transition to BLOCKED with an investigation report instead
 * of looping. This is the infinite-repair-loop backstop.
 */
export function spendBudget(run: GaryGoalRun, kind: BudgetKind, opts: SpendBudgetOpts): BudgetResult {
  // A NaN/zero/negative cap would make `spent >= cap` never true — an
  // unlimited budget by typo. Fail closed instead.
  if (!Number.isInteger(opts.cap) || opts.cap <= 0) {
    return { ok: false, error: `invalid budget cap "${String(opts.cap)}" — must be a positive integer (fail closed, not unlimited)` };
  }
  if (kind === "ci_repair") {
    if (!opts.key) return { ok: false, error: "ci_repair budget requires the failing check name (key)" };
    const spent = run.budgets.ci_repair[opts.key] ?? 0;
    if (spent >= opts.cap) {
      return {
        ok: false,
        error: `ci_repair budget exhausted for check "${opts.key}" (${spent}/${opts.cap} hypotheses) — enter BLOCKED with an investigation report`,
      };
    }
    return {
      ok: true,
      run: {
        ...run,
        budgets: { ...run.budgets, ci_repair: { ...run.budgets.ci_repair, [opts.key]: spent + 1 } },
        updated_at: new Date().toISOString(),
      },
    };
  }
  const field = kind === "review_repair" ? "review_repair_cycles" : "ship_reruns";
  const spent = run.budgets[field];
  if (spent >= opts.cap) {
    return { ok: false, error: `${kind} budget exhausted (${spent}/${opts.cap}) — enter BLOCKED` };
  }
  return {
    ok: true,
    run: {
      ...run,
      budgets: { ...run.budgets, [field]: spent + 1 },
      updated_at: new Date().toISOString(),
    },
  };
}

// ─── Merge policy ───────────────────────────────────────────────────

export interface GaryGoalPolicy {
  default_mode: "plan" | "pr" | "merge";
  autonomous_merge: boolean;
  deploy_after_merge: boolean;
  require_canary: boolean;
  max_ci_repair_attempts: number;
  max_review_repair_cycles: number;
  rollback_on_canary_failure: boolean;
}

const POLICY_DEFAULTS: GaryGoalPolicy = {
  default_mode: "pr",
  autonomous_merge: false,
  deploy_after_merge: false,
  require_canary: true,
  max_ci_repair_attempts: 3,
  max_review_repair_cycles: 3,
  rollback_on_canary_failure: true,
};

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function parseIntOr(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Policy from flat gstack-config keys (garygoal_*). Unset/garbled keys fall
 * back to the safe defaults above — autonomous merge is OFF unless the repo
 * explicitly says otherwise.
 */
export function parsePolicy(config: Record<string, string>): GaryGoalPolicy {
  const mode = config.garygoal_default_mode;
  return {
    default_mode: mode === "plan" || mode === "merge" ? mode : POLICY_DEFAULTS.default_mode,
    autonomous_merge: parseBool(config.garygoal_autonomous_merge, POLICY_DEFAULTS.autonomous_merge),
    deploy_after_merge: parseBool(config.garygoal_deploy_after_merge, POLICY_DEFAULTS.deploy_after_merge),
    require_canary: parseBool(config.garygoal_require_canary, POLICY_DEFAULTS.require_canary),
    max_ci_repair_attempts: parseIntOr(config.garygoal_max_ci_repair_attempts, POLICY_DEFAULTS.max_ci_repair_attempts),
    max_review_repair_cycles: parseIntOr(config.garygoal_max_review_repair_cycles, POLICY_DEFAULTS.max_review_repair_cycles),
    rollback_on_canary_failure: parseBool(config.garygoal_rollback_on_canary_failure, POLICY_DEFAULTS.rollback_on_canary_failure),
  };
}

/** Core gates every run must evidence regardless of routing. */
const ALWAYS_REQUIRED_GATES: readonly GateName[] = [
  "tests", "code_review", "plan_complete", "docs", "merge_readiness",
];

/**
 * Review gates a change's diff makes MANDATORY regardless of what the routing
 * step chose to run. The routing prose can be talked out of `/cso` by injected
 * content ("just a typo fix"); this table cannot. Mirrors the sensitive-
 * touchpoint list in the skill template.
 */
const REQUIRED_FOR_CHANGE: Partial<Record<ChangeCategory, readonly GateName[]>> = {
  auth: ["security_review", "browser_qa"],
  migration: ["security_review"],
  deps: ["security_review"],
  ci: ["security_review"],
  frontend: ["design_review", "browser_qa"],
};

/** Gates the diff itself makes mandatory for merge, beyond the always-required core. */
export function requiredGatesForChange(files: readonly string[]): GateName[] {
  const out = new Set<GateName>();
  for (const c of classifyPaths(files)) {
    for (const g of REQUIRED_FOR_CHANGE[c] ?? []) out.add(g);
  }
  return GARYGOAL_GATES.filter((g) => out.has(g));
}

export interface LiveMergeChecks {
  ci_status: "passing" | "failing" | "pending";
  unresolved_threads: number;
  approvals_ok: boolean;
  branch_protection_ok: boolean;
  merge_conflicts: boolean;
  head_sha: string;
}

export interface MergeVerdict {
  allowed: boolean;
  reasons: string[];
}

/**
 * The hard merge gate. Required gates = the always-required core PLUS any gate
 * the routing recorded (a conditional gate becomes mandatory the moment it
 * enters the ledger — invalidation cannot un-require it). Every reason is
 * reported; nothing short-circuits, so the caller sees the full blocker list.
 */
export interface MergeCheckOpts {
  /** Changed paths of the full PR diff — derives mandatory review gates. */
  diffFiles?: readonly string[];
}

export function mergeAllowed(
  policy: GaryGoalPolicy,
  mode: RunMode,
  gates: GateLedger,
  headSha: string,
  live: LiveMergeChecks,
  opts: MergeCheckOpts = {},
): MergeVerdict {
  const reasons: string[] = [];
  if (mode !== "merge") reasons.push(`mode is "${mode}" — merging requires explicit --merge`);
  if (!policy.autonomous_merge) reasons.push("repository policy: garygoal_autonomous_merge is false");
  const required = new Set<GateName>([
    ...ALWAYS_REQUIRED_GATES,
    ...(Object.keys(gates) as GateName[]),
    ...requiredGatesForChange(opts.diffFiles ?? []),
  ]);
  for (const g of GARYGOAL_GATES) {
    if (!required.has(g)) continue;
    if (!gateValid(gates, g, headSha)) {
      const rec = gates[g];
      const why = !rec
        ? "never recorded"
        : rec.invalidated
          ? `invalidated (${rec.invalidated.reason})`
          : rec.status !== "pass"
            ? "failed"
            : `recorded at ${rec.sha.slice(0, 7)}, head is ${headSha.slice(0, 7)}`;
      reasons.push(`gate ${g}: ${why}`);
    }
  }
  if (live.ci_status !== "passing") reasons.push(`required CI is ${live.ci_status}`);
  if (live.unresolved_threads > 0) reasons.push(`${live.unresolved_threads} unresolved review thread(s)`);
  if (!live.approvals_ok) reasons.push("required approvals missing");
  if (!live.branch_protection_ok) reasons.push("branch protection would be violated — never bypass it");
  if (live.merge_conflicts) reasons.push("merge conflicts exist");
  if (live.head_sha.toLowerCase() !== headSha.toLowerCase()) reasons.push(`live head ${live.head_sha.slice(0, 7)} differs from gated head ${headSha.slice(0, 7)}`);
  return { allowed: reasons.length === 0, reasons };
}

// ─── Argument parsing ───────────────────────────────────────────────

export type ParseMode = "default" | "plan" | "pr" | "merge" | "resume" | "status" | "repair-pr";

export type ParsedArgs =
  | { ok: true; mode: ParseMode; objective: string; runId?: string; prNumber?: number }
  | { ok: false; error: string };

const MODE_FLAGS = ["--plan", "--pr", "--merge"] as const;
const KNOWN_FLAGS = [...MODE_FLAGS, "--resume", "--status", "--repair-pr"] as const;

/** Deterministic /garygoal argument parser. Never guesses on conflict or typo. */
export function parseGaryGoalArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  const unknown = tokens.find((t) => t.startsWith("--") && !(KNOWN_FLAGS as readonly string[]).includes(t));
  if (unknown) {
    return { ok: false, error: `unknown flag ${unknown}; valid flags: ${KNOWN_FLAGS.join(", ")}` };
  }
  const modeFlags = MODE_FLAGS.filter((f) => tokens.includes(f));
  if (modeFlags.length > 1) {
    return { ok: false, error: `conflicting mode flags: ${modeFlags.join(" and ")} — pick one` };
  }
  // Mode flags make no sense alongside the run-management forms — refuse
  // rather than silently dropping one of them.
  for (const mgmt of ["--resume", "--status", "--repair-pr"]) {
    if (tokens.includes(mgmt) && modeFlags.length > 0) {
      return { ok: false, error: `${mgmt} cannot be combined with ${modeFlags[0]}` };
    }
  }
  const rest = [...tokens];
  const take = (flag: string): boolean => {
    const i = rest.indexOf(flag);
    if (i < 0) return false;
    rest.splice(i, 1);
    return true;
  };

  if (take("--status")) {
    return { ok: true, mode: "status", objective: "" };
  }
  if (tokens.includes("--resume")) {
    const i = rest.indexOf("--resume");
    rest.splice(i, 1);
    const next = rest[i];
    if (next !== undefined && !/^\d{8}-\d{6}-[a-z0-9]+$/i.test(next)) {
      return { ok: false, error: `--resume takes an optional run-id (yyyymmdd-hhmmss-xxxx); got "${next}"` };
    }
    const runId = next;
    if (runId) rest.splice(i, 1);
    return { ok: true, mode: "resume", objective: "", runId };
  }
  if (tokens.includes("--repair-pr")) {
    const i = rest.indexOf("--repair-pr");
    const next = rest[i + 1];
    const prNumber = next === undefined ? NaN : Number.parseInt(next, 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0 || String(prNumber) !== next) {
      return { ok: false, error: "--repair-pr requires a positive integer PR number, e.g. /garygoal --repair-pr 417" };
    }
    rest.splice(i, 2);
    return { ok: true, mode: "repair-pr", objective: rest.join(" "), prNumber };
  }

  let mode: ParseMode = "default";
  if (take("--plan")) mode = "plan";
  else if (take("--pr")) mode = "pr";
  else if (take("--merge")) mode = "merge";

  const objective = rest.join(" ").trim();
  if (objective.length === 0) {
    return { ok: false, error: "an objective is required, e.g. /garygoal Build the feature described in docs/spec.md" };
  }
  return { ok: true, mode, objective };
}

// ─── Event text safety ──────────────────────────────────────────────

export type EventTextCheck = { ok: true } | { ok: false; error: string };

/**
 * Gate free text before it persists to run state. Same fail-closed posture as
 * the decision store: injection-like content is rejected (it would replay into
 * a future agent's context on resume), HIGH secrets are rejected outright, and
 * MEDIUM (PII / credential-shaped) is rejected too because this store is
 * non-interactive — there is no confirm path.
 */
export function validateEventText(text: string): EventTextCheck {
  if (hasInjection(text)) {
    return { ok: false, error: "event text contains instruction-like content (injection), rejected" };
  }
  const r = scan(text);
  if (r.counts.HIGH > 0) {
    return { ok: false, error: `event text contains a HIGH-tier secret (${r.counts.HIGH} finding(s)) — never persist secrets to run state` };
  }
  if (r.counts.MEDIUM > 0) {
    return { ok: false, error: `event text contains MEDIUM-tier sensitive content (${r.counts.MEDIUM} finding(s)) — remove or rephrase before logging` };
  }
  return { ok: true };
}

// ─── Run store (persistence, locks, resume) ─────────────────────────

export interface RunPaths {
  dir: string;
  runJson: string;
  events: string;
  gateResults: string;
}

function stateHome(home?: string): string {
  return home ?? process.env.GSTACK_HOME ?? join(homedir(), ".gstack");
}

/**
 * Same character class bin/gstack-slug enforces. Applied at the path layer so
 * a caller-supplied --slug can never traverse outside projects/ (e.g.
 * "../../escape" collapses to "....escape", one directory level).
 */
function sanitizeSlug(slug: string): string {
  const s = slug.replace(/[^a-zA-Z0-9._-]/g, "");
  return s.length > 0 ? s : "unknown";
}

function garygoalRoot(slug: string, home?: string): string {
  return join(stateHome(home), "projects", sanitizeSlug(slug), "garygoal");
}

/**
 * Atomic write that cannot be redirected: the tmp file is opened with O_EXCL
 * (refuses to follow a pre-planted symlink, same posture as the lock file)
 * and carries a random suffix so the name is not predictable from the pid.
 */
export function atomicWriteFile(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, content, "utf-8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function runPaths(slug: string, runId: string, home?: string): RunPaths {
  const dir = join(garygoalRoot(slug, home), runId);
  return {
    dir,
    runJson: join(dir, "run.json"),
    events: join(dir, "events.jsonl"),
    gateResults: join(dir, "gate-results.json"),
  };
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export interface LockContext {
  slug: string;
  branch: string;
  home?: string;
}

export type LockResult = { ok: true } | { ok: false; error: string };

function lockPath(ctx: LockContext): string {
  return join(garygoalRoot(ctx.slug, ctx.home), `.lock-${sanitizeBranch(ctx.branch)}`);
}

function pidAlive(pid: number): boolean {
  // pid 0 / negative signal process GROUPS and never throw — a lock claiming
  // them would be immortal (DoS). Non-positive pids are stale by definition.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; anything else (ESRCH, ERANGE) = not alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockHolder {
  run_id?: string;
  pid?: number;
  at?: string;
}

/** The current branch-lock holder, or null when no lock file exists / it's torn. */
export function lockHolder(ctx: LockContext): LockHolder | null {
  try {
    return JSON.parse(readFileSync(lockPath(ctx), "utf-8")) as LockHolder;
  } catch {
    return null;
  }
}

/**
 * O_EXCL branch lock so two simultaneous garygoal runs can't fight over one
 * branch. A lock held by a dead pid (crashed session) is reclaimed; a lock
 * held by a live pid is respected — the second run must be refused, never
 * silently multiplexed.
 *
 * ownerPid: the LONG-LIVED process anchoring the run — the orchestrating
 * agent session ($PPID inside a skill bash block), NOT this short-lived CLI
 * process. A lock anchored to the CLI pid would be stale milliseconds later
 * and the mutual exclusion would be a no-op.
 *
 * Stale reclaim is an atomic STEAL via rename: only one contender's rename
 * succeeds, so two reclaimers can never both end up holding the lock.
 */
export function acquireRunLock(ctx: LockContext, runId: string, ownerPid?: number): LockResult {
  const path = lockPath(ctx);
  mkdirSync(garygoalRoot(ctx.slug, ctx.home), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify({ run_id: runId, pid: ownerPid ?? process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: LockHolder = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // Unparsable lock = torn write from a dead process; treat as stale.
      }
      const self = ownerPid ?? process.pid;
      if (typeof holder.pid === "number" && pidAlive(holder.pid) && holder.pid !== self) {
        return {
          ok: false,
          error: `branch lock held by run ${holder.run_id ?? "(unknown)"} (pid ${holder.pid}) — another garygoal run is active on ${ctx.branch}; resume it or wait`,
        };
      }
      // holder.pid === self: the same orchestrating session supersedes its own
      // lock (crashed run, fresh init after --abandon-incomplete). Cross-run
      // protection within the session comes from the incomplete-run guard.
      // Atomic steal: rename the stale lock aside. If another contender got
      // there first, the rename throws ENOENT and the next loop iteration
      // sees whatever fresh lock the winner created.
      const stole = `${path}.stale.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      try {
        renameSync(path, stole);
        unlinkSync(stole);
      } catch {
        // Lost the steal race — loop and re-evaluate the fresh lock.
      }
    }
  }
  return { ok: false, error: "could not acquire branch lock after stale-lock reclaim" };
}

export function releaseRunLock(ctx: LockContext): void {
  try {
    unlinkSync(lockPath(ctx));
  } catch {
    // Already gone — releasing an unheld lock is a no-op, not an error.
  }
}

export type LoadResult = { ok: true; run: GaryGoalRun } | { ok: false; error: string };

/**
 * Load + validate a run record. Unknown schema versions and corrupt JSON fail
 * safely — a state file we can't fully understand must never be "repaired" by
 * guessing.
 */
export function loadRun(runJsonPath: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(runJsonPath, "utf-8");
  } catch {
    return { ok: false, error: `run.json not readable at ${runJsonPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `run.json is corrupt (invalid JSON) at ${runJsonPath} — refusing to guess; restore from events.jsonl or start a new run` };
  }
  const run = parsed as Partial<GaryGoalRun>;
  if (run.schema_version !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: `run.json schema version ${String(run.schema_version)} is not supported (expected ${SCHEMA_VERSION}) — upgrade gstack or start a new run; refusing to guess`,
    };
  }
  if (!run.state || !GARYGOAL_STATES.includes(run.state)) {
    return { ok: false, error: `run.json has unknown state "${String(run.state)}" — refusing to guess` };
  }
  if (!isNonEmptyString(run.run_id) || !isNonEmptyString(run.branch) || !isNonEmptyString(run.slug)) {
    return { ok: false, error: "run.json is missing run_id/slug/branch — refusing to guess" };
  }
  if (!run.mode || !["plan", "pr", "merge", "repair-pr"].includes(run.mode)) {
    return { ok: false, error: `run.json has unknown mode "${String(run.mode)}" — refusing to guess` };
  }
  // Structural shape checks — a truncated/hand-edited run.json must refuse to
  // load here, not explode with a TypeError three commands later.
  const b = run.budgets as Partial<RunBudgets> | undefined;
  if (!b || typeof b !== "object" || typeof b.ci_repair !== "object" || b.ci_repair === null
      || typeof b.review_repair_cycles !== "number" || typeof b.ship_reruns !== "number") {
    return { ok: false, error: "run.json budgets are malformed — refusing to guess" };
  }
  if (typeof run.gates !== "object" || run.gates === null || typeof run.state_evidence !== "object" || run.state_evidence === null) {
    return { ok: false, error: "run.json gates/state_evidence are malformed — refusing to guess" };
  }
  return { ok: true, run: run as GaryGoalRun };
}

/** Atomic O_EXCL write (tmp + rename) so a crash mid-save never tears run.json. */
export function saveRun(runJsonPath: string, run: GaryGoalRun): void {
  atomicWriteFile(runJsonPath, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
}

export interface InitRunInput {
  slug: string;
  branch: string;
  mode: RunMode;
  objective: string;
  home?: string;
  runId?: string;
  createdAt?: string;
  /** Long-lived orchestrating-session pid to anchor the branch lock to. */
  ownerPid?: number;
  /**
   * Mark any existing incomplete runs on this branch endpoint_reached before
   * starting fresh. Without this, init REFUSES while an incomplete run exists —
   * otherwise exhausted budgets could be laundered by re-initing. The abandon
   * is explicit and visible in the audit trail.
   */
  abandonIncomplete?: boolean;
}

export type InitResult = { ok: true; run: GaryGoalRun } | { ok: false; error: string };

function genRunId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${rand}`;
}

/** Create the run directory, run.json, and events.jsonl; hold the branch lock. */
export function initRun(input: InitRunInput): InitResult {
  // The objective is stored verbatim and resurfaced into agent context on
  // every resume/status — reject injection-shaped or secret-bearing text at
  // the door rather than laundering it through run.json.
  const objectiveSafe = validateEventText(input.objective);
  if (!objectiveSafe.ok) {
    return { ok: false, error: `objective rejected: ${objectiveSafe.error} — rephrase the objective` };
  }
  // Budget-laundering guard: a branch with an incomplete run gets RESUMED,
  // not twinned — a fresh init would reset every repair budget to zero.
  const existing = listRuns(input.slug, input.home).filter(
    (r) => r.branch === input.branch && !RESUME_EXCLUDED.includes(r.state) && !r.endpoint_reached,
  );
  if (existing.length > 0 && !input.abandonIncomplete) {
    return {
      ok: false,
      error: `incomplete run(s) exist for branch ${input.branch}: ${existing.map((r) => r.run_id).join(", ")} — resume with --resume, or pass --abandon-incomplete to explicitly abandon them and start fresh`,
    };
  }
  if (existing.length > 0 && input.abandonIncomplete) {
    for (const r of existing) {
      const p = runPaths(input.slug, r.run_id, input.home);
      saveRun(p.runJson, markEndpointReached(r));
    }
  }
  const runId = input.runId ?? genRunId();
  const lock = acquireRunLock({ slug: input.slug, branch: input.branch, home: input.home }, runId, input.ownerPid);
  if (!lock.ok) return lock;
  const run = newRun({
    runId,
    slug: input.slug,
    branch: input.branch,
    mode: input.mode,
    objective: input.objective,
    createdAt: input.createdAt,
  });
  const paths = runPaths(input.slug, runId, input.home);
  mkdirSync(paths.dir, { recursive: true });
  saveRun(paths.runJson, run);
  if (!existsSync(paths.events)) {
    try {
      closeSync(openSync(paths.events, "ax")); // O_EXCL create — never follows a planted symlink
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return { ok: true, run };
}

/** All parseable runs for a project, oldest first. Corrupt runs are skipped. */
export function listRuns(slug: string, home?: string): GaryGoalRun[] {
  const root = garygoalRoot(slug, home);
  if (!existsSync(root)) return [];
  const out: GaryGoalRun[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    const loaded = loadRun(join(root, entry, "run.json"));
    if (loaded.ok) out.push(loaded.run);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export type ResumeResult = { ok: true; run: GaryGoalRun } | { ok: false; error: string };

/**
 * The run --resume picks up: exactly one incomplete run for this branch. Zero
 * → nothing to resume. More than one → the caller must pass an explicit
 * run-id; guessing between concurrent histories is how state gets corrupted.
 */
/** Stamp a run as having reached its per-mode endpoint. Returns a new run. */
export function markEndpointReached(run: GaryGoalRun): GaryGoalRun {
  return { ...run, endpoint_reached: true, updated_at: new Date().toISOString() };
}

export function latestIncompleteRun(slug: string, branch: string, home?: string): ResumeResult {
  const candidates = listRuns(slug, home).filter(
    (r) => r.branch === branch && !RESUME_EXCLUDED.includes(r.state) && !r.endpoint_reached,
  );
  if (candidates.length === 0) {
    return { ok: false, error: `no incomplete garygoal runs for branch ${branch}` };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: `multiple incomplete runs for branch ${branch} — pass an explicit run-id: ${candidates.map((r) => r.run_id).join(", ")}`,
    };
  }
  return { ok: true, run: candidates[0] };
}
