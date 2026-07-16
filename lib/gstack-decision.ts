/**
 * gstack-decision — event-sourced institutional decision memory.
 *
 * decisions.jsonl is an APPEND-ONLY EVENT LOG (not mutable rows): `decide`,
 * `supersede`, and `redact` events. "Active" is COMPUTED — a `decide` whose id is
 * not later referenced by a `supersede`/`redact`. This is the eng-review event-
 * sourcing decision (a mutable `status` field would contradict append-only).
 *
 * Built on lib/jsonl-store.ts (shared injection-reject + atomic append + tolerant
 * read). Free-text fields are injection-checked AND redact-scanned on write
 * (HIGH-tier secret → reject), so a secret never silently persists and resurfaced
 * text can't carry instructions. gbrain is never required — this is the reliable
 * file-only core; semantic recall is a later, optional enhancement.
 */

import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeFileSync, renameSync, existsSync, readFileSync, appendFileSync, statSync, openSync, closeSync, unlinkSync } from "fs";
import { appendJsonl, readJsonl, hasInjection } from "./jsonl-store";
import { scan } from "./redact-engine";

export type DecisionKind = "decide" | "supersede" | "redact";
export type DecisionScope = "repo" | "branch" | "issue";
export type DecisionSource = "user" | "skill" | "agent";

export const DECISION_SCOPES: readonly DecisionScope[] = ["repo", "branch", "issue"];
export const DECISION_SOURCES: readonly DecisionSource[] = ["user", "skill", "agent"];

export interface DecisionEvent {
  id: string;
  kind: DecisionKind;
  decision?: string;
  rationale?: string;
  alternatives_considered?: string;
  /** For supersede/redact: the id of the `decide` event being acted on. */
  supersedes?: string;
  scope: DecisionScope;
  branch?: string;
  issue?: string;
  date: string;
  session?: string;
  source: DecisionSource;
  confidence?: number;
}

export interface ActiveDecision extends DecisionEvent {
  kind: "decide";
}

export interface DecisionPaths {
  log: string;
  snapshot: string;
  archive: string;
}

/** Resolve the per-project decision store paths. Bins pass slug + GSTACK_HOME. */
export function decisionPaths(slug: string, gstackHome?: string): DecisionPaths {
  const home = gstackHome || process.env.GSTACK_HOME || join(homedir(), ".gstack");
  const dir = join(home, "projects", slug || "unknown");
  return {
    log: join(dir, "decisions.jsonl"),
    snapshot: join(dir, "decisions.active.json"),
    archive: join(dir, "decisions.archive.jsonl"),
  };
}

/**
 * Datamark resurfaced decision text so a stored string can't masquerade as
 * instructions or break out of the Context Recovery fence when it lands in agent
 * context (codex hardening #3: resurface = DATA, not instructions). Write-time
 * `hasInjection` is a denylist; this is the render-boundary defense-in-depth that
 * also covers `--all`/snapshot reads and records written before a pattern existed.
 * Neutralizes: control chars, newlines (defensive — events are single-line),
 * code fences, `---` banner sentinels, and `<|role|>` / `</system>` markers.
 */
export function datamark(text: string): string {
  const ZWSP = "\u200b"; // zero-width space: breaks token recognition, near-invisible
  return text
    // strip C0/C1 control chars + Unicode line terminators (U+0085/2028/2029 render as
    // newlines in many tokenizers/markdown; "strip newlines" must cover them)
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ")
    .replace(/`{3,}/g, "'''") // neutralize markdown code fences
    .replace(/-{3,}/g, "\u2014") // neutralize `---` banner sentinels (em dash)
    .replace(/<\|/g, `<${ZWSP}|`) // neutralize <|im_start|>-style chat markers
    .replace(/\|>/g, `|${ZWSP}>`)
    .replace(/<(\/?)(system|user|assistant|tool)>/gi, `<${ZWSP}$1$2>`) // neutralize role tags
    // neutralize chat turn-prefixes (Human:/Assistant:/System:/User:) — defeat the
    // angle-tag pass and are Claude's native turn delimiters
    .replace(/\b(human|assistant|system|user)(\s*):/gi, `$1${ZWSP}$2:`);
}

export type ValidateResult =
  | { ok: true; event: DecisionEvent }
  | { ok: false; error: string };

/**
 * Validate + stamp a `decide` event. Rejects (no silent persist) on:
 *  - missing/empty decision text or invalid scope/source,
 *  - injection-like content in any free-text field (datamark-on-write),
 *  - a HIGH-tier secret (redact engine) in any free-text field.
 */
export function validateDecide(input: Partial<DecisionEvent>): ValidateResult {
  if (!input.decision || typeof input.decision !== "string" || !input.decision.trim()) {
    return { ok: false, error: "decision text is required" };
  }
  const scope = input.scope ?? "repo";
  if (!DECISION_SCOPES.includes(scope)) {
    return { ok: false, error: `invalid scope "${scope}"; must be ${DECISION_SCOPES.join("|")}` };
  }
  const source = input.source ?? "agent";
  if (!DECISION_SOURCES.includes(source)) {
    return { ok: false, error: `invalid source "${source}"; must be ${DECISION_SOURCES.join("|")}` };
  }
  if (input.confidence !== undefined) {
    const c = Number(input.confidence);
    if (!Number.isInteger(c) || c < 1 || c > 10) {
      return { ok: false, error: "confidence must be integer 1-10" };
    }
  }

  // Scan ALL stored free-text — incl. branch/issue, which are surfaced (and emitted raw
  // via --json), so they must not carry secrets or injection either (Codex finding).
  const freeText = [input.decision, input.rationale, input.alternatives_considered, input.branch, input.issue]
    .filter((s): s is string => typeof s === "string")
    .join("\n");

  if (hasInjection(freeText)) {
    return { ok: false, error: "decision contains instruction-like content (injection), rejected" };
  }
  const redacted = scan(freeText);
  if (redacted.counts.HIGH > 0) {
    return {
      ok: false,
      error: `decision contains a HIGH-tier secret (${redacted.counts.HIGH} finding(s)); rotate + remove it, do not log secrets`,
    };
  }
  // MEDIUM = PII / credential-shaped content. The taxonomy says "confirm via
  // AskUserQuestion", but this store is NON-INTERACTIVE and syncs cross-machine,
  // so there is no confirm path — fail closed rather than silently persist + sync a
  // secret that later resurfaces into agent context.
  if (redacted.counts.MEDIUM > 0) {
    return {
      ok: false,
      error: `decision contains MEDIUM-tier sensitive content (${redacted.counts.MEDIUM} finding(s): PII or credential-shaped). This store is non-interactive and syncs across machines, so it fails closed — remove or rephrase the value before logging.`,
    };
  }

  const event: DecisionEvent = {
    id: input.id || randomUUID(),
    kind: "decide",
    decision: input.decision.trim(),
    rationale: input.rationale,
    alternatives_considered: input.alternatives_considered,
    scope,
    branch: input.branch || undefined,
    issue: input.issue || undefined,
    date: input.date || new Date().toISOString(),
    session: input.session,
    source,
    confidence: input.confidence === undefined ? undefined : Number(input.confidence),
  };
  return { ok: true, event };
}

/** Build a supersede/redact event referencing an existing decide-event id. */
export function makeRefEvent(kind: "supersede" | "redact", targetId: string, opts: { session?: string; source?: DecisionSource } = {}): DecisionEvent {
  return {
    id: randomUUID(),
    kind,
    supersedes: targetId,
    scope: "repo",
    date: new Date().toISOString(),
    session: opts.session,
    source: opts.source ?? "agent",
  };
}

/**
 * Compute the ACTIVE decisions: `decide` events whose id is NOT referenced by any
 * later `supersede`/`redact`. Dangling refs (supersede/redact pointing at an id
 * that has no `decide`) are tolerated — ignored, never thrown. Returned in date
 * order (oldest first).
 */
export function computeActive(events: DecisionEvent[]): ActiveDecision[] {
  const retired = new Set<string>();
  for (const e of events) {
    if ((e.kind === "supersede" || e.kind === "redact") && e.supersedes) {
      retired.add(e.supersedes); // dangling target id is harmless — just a no-op
    }
  }
  return events
    .filter((e): e is ActiveDecision => e.kind === "decide" && !retired.has(e.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Scope filter for resurfacing: repo-scoped decisions always apply; branch-scoped
 * only when the branch matches the current context; issue-scoped only when the
 * issue matches. (Recency != relevance — callers filter by scope, not just date.)
 */
export function filterByScope(active: ActiveDecision[], ctx: { branch?: string; issue?: string }): ActiveDecision[] {
  return active.filter((d) => {
    if (d.scope === "repo") return true;
    if (d.scope === "branch") return !!ctx.branch && d.branch === ctx.branch;
    if (d.scope === "issue") return !!ctx.issue && d.issue === ctx.issue;
    return false; // unknown/garbage scope: fail conservative, don't leak into every context
  });
}

/** Append a validated event atomically (single-line, concurrency-safe). */
export function appendEvent(paths: DecisionPaths, event: DecisionEvent): void {
  appendJsonl(paths.log, event);
}

/** Read all events tolerantly (skips malformed/partial-tail lines). */
export function readEvents(paths: DecisionPaths): DecisionEvent[] {
  return readJsonl<DecisionEvent>(paths.log);
}

/**
 * Write the bounded active snapshot (`decisions.active.json`) atomically. Context
 * Recovery and search read THIS, not the full history — session start stays
 * O(active), not O(history).
 */
export function writeSnapshot(paths: DecisionPaths, active: ActiveDecision[]): void {
  const tmp = `${paths.snapshot}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(active), "utf-8");
  renameSync(tmp, paths.snapshot);
}

/** Read the bounded active snapshot. Returns [] if missing/corrupt (caller may rebuild). */
export function readSnapshot(paths: DecisionPaths): ActiveDecision[] {
  if (!existsSync(paths.snapshot)) return [];
  try {
    const v = JSON.parse(readFileSync(paths.snapshot, "utf-8"));
    return Array.isArray(v) ? (v as ActiveDecision[]) : [];
  } catch {
    return [];
  }
}

/** Recompute active from the event log and refresh the snapshot. Returns active. */
export function rebuildSnapshot(paths: DecisionPaths): ActiveDecision[] {
  const active = computeActive(readEvents(paths));
  writeSnapshot(paths, active);
  return active;
}

export interface CompactResult {
  activeCount: number;
  /** superseded decisions moved to the archive (history kept). */
  archivedCount: number;
  /** redacted decisions DROPPED entirely (expunged, NOT archived). */
  expungedCount: number;
  /** true when compaction was skipped to avoid clobbering a concurrent writer/compactor. */
  skipped?: boolean;
}

/**
 * Compact the event log to the active set.
 *  - active decisions → kept in `decisions.jsonl`,
 *  - superseded decisions → appended to `decisions.archive.jsonl` (history),
 *  - REDACTED decisions → expunged (dropped, NOT archived) — that's redact's job:
 *    a `redact` is how an accidentally-captured secret leaves the store for good.
 *
 * Concurrency: appends are lock-free (O_APPEND), but compact is a read-modify-rewrite
 * that would clobber an append landing in its window. Two guards: (1) an O_EXCL lock
 * file serializes compactions (no double-archive / tmp tear); (2) the log size is
 * re-checked immediately before the destructive write — if an append landed since the
 * read, compact ABORTS untouched (returns skipped) so no decision is ever lost. The
 * caller re-runs. Atomic rewrite (tmp + rename); refreshes the snapshot.
 */
export function compact(paths: DecisionPaths): CompactResult {
  const lockPath = `${paths.log}.compact.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx"); // O_EXCL|O_CREAT — throws EEXIST if a compact holds it
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { activeCount: computeActive(readEvents(paths)).length, archivedCount: 0, expungedCount: 0, skipped: true };
    }
    throw err;
  }
  try {
    const sizeBefore = existsSync(paths.log) ? statSync(paths.log).size : 0;
    const events = readEvents(paths);
    const active = computeActive(events);
    const activeIds = new Set(active.map((d) => d.id));
    const redactedIds = new Set(
      events.filter((e) => e.kind === "redact" && e.supersedes).map((e) => e.supersedes as string),
    );
    // Superseded = a decide that's neither active nor redacted. Archive these for history.
    const superseded = events.filter(
      (e): e is DecisionEvent => e.kind === "decide" && !activeIds.has(e.id) && !redactedIds.has(e.id),
    );

    // Append-race guard: if the log grew/changed since we read it, an append landed —
    // rewriting now would drop it. Abort untouched; the caller re-runs.
    const sizeNow = existsSync(paths.log) ? statSync(paths.log).size : 0;
    if (sizeNow !== sizeBefore) {
      return { activeCount: active.length, archivedCount: 0, expungedCount: 0, skipped: true };
    }

    // One batched append (not one open/write/close per event) — matches the atomic
    // batched rewrite of the active log below and shrinks the mid-compact crash window.
    if (superseded.length) {
      appendFileSync(paths.archive, superseded.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    }

    const tmp = `${paths.log}.tmp.${process.pid}`;
    writeFileSync(tmp, active.map((d) => JSON.stringify(d)).join("\n") + (active.length ? "\n" : ""), "utf-8");
    renameSync(tmp, paths.log);
    writeSnapshot(paths, active);

    return { activeCount: active.length, archivedCount: superseded.length, expungedCount: redactedIds.size };
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // best-effort lock cleanup; a leftover lock only blocks the NEXT compact, which re-runs
    }
  }
}
