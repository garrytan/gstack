/**
 * Safety contract for the repository-index stage of /sync-gbrain.
 *
 * This module intentionally does not use the legacy source helper. Repository
 * indexing must never repair path drift by removing and re-adding a source:
 * version, one strict source snapshot, canonical path identity, and expected
 * Git state are proven before the first content mutation.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { dirname, isAbsolute, join, resolve } from "path";

export const REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION = "0.42.71.0";
export const REPOSITORY_INDEX_RECOVERY_DOC =
  "docs/repository-index-recovery.md";
export const REPOSITORY_INDEX_RECEIPT = ".gbrain-repository-index-receipt.json";
export const AFFECTED_SAMPLE_LIMIT = 100;

export type ReleasedVersion = readonly [number, number, number, number];

export type RepositoryIndexStatus =
  | "verified"
  | "preview_ready"
  | "incomplete"
  | "refused"
  | "error";

export type RepositoryIndexState =
  | "none"
  | "lock_only"
  | "registry_only"
  | "partial"
  | "applied_unverified"
  | "applied_verified";

export interface RepositoryIndexResult {
  schema_version: 1;
  result_kind: "repository_index";
  status: RepositoryIndexStatus;
  reason_code: string;
  state_changed: RepositoryIndexState;
  preview_kind?: "orchestration_unvalidated";
  evidence: Record<string, unknown>;
  next_command: string | null;
  docs: string;
}

export interface StrictSourceRow {
  readonly id: string;
  readonly local_path: string | null;
  readonly last_commit: string | null;
  readonly last_successful_strategy: "markdown" | "code" | "auto" | null;
}

export type StrictSourceSnapshot =
  | { ok: true; rows: readonly StrictSourceRow[] }
  | { ok: false; error: string };

export type PathIdentity =
  | {
      kind: "equivalent";
      stored_path: string;
      resolved_path: string;
      canonical_path: string;
    }
  | {
      kind: "different";
      stored_path: string;
      resolved_path: string;
      canonical_path: string;
      stored_canonical_path: string;
    }
  | {
      kind: "ambiguous";
      stored_path: string;
      resolved_path: string | null;
      canonical_path: string | null;
      reason: string;
    };

export interface AffectedItem {
  operation: string;
  path: string;
  slug: string;
  from_path?: string;
}

export interface AffectedSummary {
  total: number;
  sample_limit: 100;
  sample: AffectedItem[];
  truncated: boolean;
  sha256: string;
}

export interface GbrainSpawnResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

export interface GbrainSpawnOptions {
  cwd?: string;
  timeout?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface RepositoryIndexRunInput {
  root: string;
  sourceId: string;
  head: string;
  workingTreeClean: boolean;
  gstackHome: string;
  /** Caller environment to copy for every child; never mutated in place. */
  baseEnv?: NodeJS.ProcessEnv;
  spawnGbrain: (
    args: string[],
    options?: GbrainSpawnOptions,
  ) => GbrainSpawnResult;
  platform?: NodeJS.Platform;
  writeReceipt?: (path: string, receipt: RepositoryIndexResult) => void;
  writeSourceMarker?: (root: string, sourceId: string) => void;
  readRepositoryState?: (root: string) => RepositoryState;
  readAttachedSource?: (root: string) => AttachedSourceState;
}

export interface RepositoryIndexRunOutput {
  result: RepositoryIndexResult;
  exitCode: 0 | 1 | 2;
}

export interface RepositoryState {
  head: string | null;
  head_after: string | null;
  stable: boolean;
  clean: boolean;
  porcelain: string | null;
  source_marker_tracked: boolean | null;
}

export interface AttachedSourceState {
  present: boolean;
  sourceId: string | null;
  trustworthy: boolean;
  detail: string | null;
}

const SHA_40 = /^[0-9a-f]{40}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SOURCE_MARKER_MAX_BYTES = 34;
const CHILD_TERMINAL_STATUSES = new Set([
  "synced",
  "first_sync",
  "up_to_date",
]);
const CHILD_INCOMPLETE_STATUSES = new Set([
  "partial",
  "blocked_by_failures",
]);
const AFFECTED_OPERATIONS = new Set([
  "add",
  "modify",
  "delete",
  "rename",
]);
const CHILD_ERROR_REASONS = new Set([
  "source_changed",
  "target_changed",
  "bookmark_changed",
  "working_tree_dirty",
  "managed_clone_missing",
  "plan_failed",
  "dry_run_modifier_conflict",
  "lock_busy",
  "lock_release_failed",
  "embedding_credentials_missing",
  "cost_gate_stopped",
]);
const CORPUS_RECEIPT_FIELDS = [
  "code_deletions_applied",
  "code_pages_after",
  "code_pages_before",
  "embedding_status",
  "extraction_status",
  "image_operations_applied",
  "image_pages_after",
  "markdown_planned_or_applied",
  "multimodal_enabled",
  "search_ready",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCorpusReceipt(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const corpusKeys = Object.keys(value).sort();
  if (
    corpusKeys.length !== CORPUS_RECEIPT_FIELDS.length ||
    corpusKeys.some(
      (key, index) => key !== CORPUS_RECEIPT_FIELDS[index],
    )
  ) {
    return false;
  }
  return (
    nonNegativeInteger(value.markdown_planned_or_applied) &&
    nonNegativeInteger(value.code_pages_before) &&
    nonNegativeInteger(value.code_pages_after) &&
    nonNegativeInteger(value.code_deletions_applied) &&
    value.image_operations_applied === 0 &&
    nonNegativeInteger(value.image_pages_after) &&
    value.multimodal_enabled === false &&
    (value.embedding_status === "deferred" ||
      value.embedding_status === "complete") &&
    (value.extraction_status === "deferred" ||
      value.extraction_status === "complete") &&
    typeof value.search_ready === "boolean" &&
    value.search_ready ===
      (value.embedding_status === "complete" &&
        value.extraction_status === "complete")
  );
}

function validChildErrorTuple(
  reasonCode: string,
  status: unknown,
  stateChanged: unknown,
): boolean {
  if (!CHILD_ERROR_REASONS.has(reasonCode)) return false;
  if (reasonCode === "lock_release_failed") {
    return status === "error" && stateChanged === "lock_only";
  }
  if (reasonCode === "plan_failed") {
    return (
      (status === "refused" && stateChanged === "none") ||
      (status === "error" &&
        (stateChanged === "none" || stateChanged === "partial"))
    );
  }
  return status === "refused" && stateChanged === "none";
}

function repositoryResult(
  status: RepositoryIndexStatus,
  reasonCode: string,
  stateChanged: RepositoryIndexState,
  evidence: Record<string, unknown>,
  nextCommand: string | null = null,
): RepositoryIndexResult {
  return {
    schema_version: 1,
    result_kind: "repository_index",
    status,
    reason_code: reasonCode,
    state_changed: stateChanged,
    evidence,
    next_command: nextCommand,
    docs: REPOSITORY_INDEX_RECOVERY_DOC,
  };
}

/**
 * Parse the released gbrain form only: four numeric components, optionally
 * preceded by the CLI's documented `gbrain ` label. Prerelease/build suffixes,
 * `v` prefixes, prose, and missing components are rejected.
 */
export function parseReleasedGbrainVersion(
  raw: string,
): ReleasedVersion | null {
  const match = raw
    .trim()
    .match(/^(?:gbrain )?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return null;
  }
  return parts as unknown as ReleasedVersion;
}

export function compareReleasedVersions(
  left: ReleasedVersion,
  right: ReleasedVersion,
): -1 | 0 | 1 {
  for (let index = 0; index < 4; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function isReleasedVersionAtLeast(
  detected: string,
  required: string = REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
): boolean {
  const detectedVersion = parseReleasedGbrainVersion(detected);
  const requiredVersion = parseReleasedGbrainVersion(required);
  return (
    detectedVersion !== null &&
    requiredVersion !== null &&
    compareReleasedVersions(detectedVersion, requiredVersion) >= 0
  );
}

/**
 * Accept only the two released `sources list --json` containers and a unique,
 * complete row set. A malformed row cannot be reinterpreted as source absence.
 */
export function parseStrictSourceSnapshot(
  raw: unknown,
): StrictSourceSnapshot {
  let candidate: unknown;
  if (Array.isArray(raw)) {
    candidate = raw;
  } else if (
    isRecord(raw) &&
    Object.keys(raw).length === 1 &&
    Array.isArray(raw.sources)
  ) {
    candidate = raw.sources;
  } else {
    return {
      ok: false,
      error: "expected a bare source array or exact {sources:[...]} wrapper",
    };
  }

  const rows: StrictSourceRow[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < candidate.length; index++) {
    const row = candidate[index];
    if (!isRecord(row)) {
      return { ok: false, error: `source row ${index} is not an object` };
    }
    if (typeof row.id !== "string" || row.id.trim() === "") {
      return { ok: false, error: `source row ${index} has no valid id` };
    }
    if (
      row.local_path !== null &&
      (typeof row.local_path !== "string" ||
        row.local_path.trim() === "")
    ) {
      return {
        ok: false,
        error: `source row ${index} has no valid local_path`,
      };
    }
    if (!Object.hasOwn(row, "last_commit")) {
      return {
        ok: false,
        error: `source row ${index} has no last_commit evidence`,
      };
    }
    if (ids.has(row.id)) {
      return { ok: false, error: `duplicate source id: ${row.id}` };
    }
    if (
      row.last_commit !== undefined &&
      row.last_commit !== null &&
      (typeof row.last_commit !== "string" ||
        !SHA_40.test(row.last_commit))
    ) {
      return {
        ok: false,
        error: `source row ${index} has an invalid last_commit`,
      };
    }
    if (!Object.hasOwn(row, "last_successful_strategy")) {
      return {
        ok: false,
        error: `source row ${index} has no last_successful_strategy evidence`,
      };
    }
    if (
      row.last_successful_strategy !== null &&
      row.last_successful_strategy !== "markdown" &&
      row.last_successful_strategy !== "code" &&
      row.last_successful_strategy !== "auto"
    ) {
      return {
        ok: false,
        error: `source row ${index} has an invalid last_successful_strategy`,
      };
    }
    ids.add(row.id);
    rows.push(
      Object.freeze({
        id: row.id,
        local_path: row.local_path as string | null,
        last_commit:
          typeof row.last_commit === "string" ? row.last_commit : null,
        last_successful_strategy:
          row.last_successful_strategy as
            | "markdown"
            | "code"
            | "auto"
            | null,
      }),
    );
  }

  return { ok: true, rows: Object.freeze(rows) };
}

/**
 * Resolve relative stored paths against the proven repository root, then use
 * filesystem canonical identity so `.`, absolute spellings, and symlinks can
 * compare equal without rewriting source registration.
 */
export function classifyRepositoryPath(
  storedPath: string,
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
): PathIdentity {
  const resolvedStored = isAbsolute(storedPath)
    ? resolve(storedPath)
    : resolve(repositoryRoot, storedPath);
  let canonicalRoot: string;
  try {
    if (!statSync(repositoryRoot).isDirectory()) {
      return {
        kind: "ambiguous",
        stored_path: storedPath,
        resolved_path: resolvedStored,
        canonical_path: null,
        reason: "repository root is not a directory",
      };
    }
    canonicalRoot = realpathSync.native(repositoryRoot);
  } catch (error) {
    return {
      kind: "ambiguous",
      stored_path: storedPath,
      resolved_path: resolvedStored,
      canonical_path: null,
      reason: `repository root cannot be canonicalized: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let canonicalStored: string;
  try {
    if (!statSync(resolvedStored).isDirectory()) {
      return {
        kind: "ambiguous",
        stored_path: storedPath,
        resolved_path: resolvedStored,
        canonical_path: canonicalRoot,
        reason: "stored source path is not a directory",
      };
    }
    canonicalStored = realpathSync.native(resolvedStored);
  } catch (error) {
    return {
      kind: "ambiguous",
      stored_path: storedPath,
      resolved_path: resolvedStored,
      canonical_path: canonicalRoot,
      reason: `stored source path cannot be canonicalized: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const compare = (value: string) =>
    platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (compare(canonicalStored) === compare(canonicalRoot)) {
    return {
      kind: "equivalent",
      stored_path: storedPath,
      resolved_path: resolvedStored,
      canonical_path: canonicalRoot,
    };
  }
  return {
    kind: "different",
    stored_path: storedPath,
    resolved_path: resolvedStored,
    canonical_path: canonicalRoot,
    stored_canonical_path: canonicalStored,
  };
}

function equivalentSourceOwnerIds(
  rows: readonly StrictSourceRow[],
  repositoryRoot: string,
  platform: NodeJS.Platform,
): string[] {
  return rows
    .filter((row) => row.local_path !== null)
    .filter(
      (row) =>
        classifyRepositoryPath(
          row.local_path!,
          repositoryRoot,
          platform,
        ).kind === "equivalent",
    )
    .map((row) => row.id)
    .sort();
}

/**
 * gbrain currently needs shell:true on Windows for its .cmd launcher. Until
 * that transport is replaced, refuse repository roots containing whitespace
 * (which shell:true splits) or cmd.exe metacharacters instead of pretending
 * the child received an exact argv.
 */
export function unsafeRepositoryPathForShell(
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "win32" &&
    /[\s&|^%!()"'<>\r\n]/.test(repositoryRoot)
  );
}

function canonicalAffectedItem(
  item: AffectedItem,
  strictPosixInput = false,
): AffectedItem | null {
  const controlCharacter = /[\u0000-\u001f\u007f]/u;
  if (
    !AFFECTED_OPERATIONS.has(item.operation) ||
    typeof item.path !== "string" ||
    typeof item.slug !== "string" ||
    item.slug.length === 0 ||
    controlCharacter.test(item.path) ||
    controlCharacter.test(item.slug) ||
    (strictPosixInput &&
      (item.path.includes("\\") ||
        item.slug.includes("\\") ||
        item.from_path?.includes("\\") === true))
  ) {
    return null;
  }
  const path = item.path.replaceAll("\\", "/");
  const fromPath =
    item.from_path === undefined
      ? undefined
      : item.from_path.replaceAll("\\", "/");
  const invalidPath = (value: string) =>
    value.length === 0 ||
    controlCharacter.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..");
  if (
    invalidPath(path) ||
    (fromPath !== undefined && invalidPath(fromPath))
  ) {
    return null;
  }
  return {
    operation: item.operation,
    path,
    slug: item.slug,
    ...(fromPath === undefined ? {} : { from_path: fromPath }),
  };
}

function affectedTuple(item: AffectedItem): string {
  return `${item.operation}\t${item.path}\t${item.slug}`;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf-8"), Buffer.from(right, "utf-8"));
}

export function summarizeAffectedItems(
  items: readonly AffectedItem[],
): AffectedSummary {
  const canonical = items.map(canonicalAffectedItem);
  if (canonical.some((item) => item === null)) {
    throw new Error("affected items must use canonical repository-relative paths");
  }
  const sorted = (canonical as AffectedItem[]).sort((left, right) =>
    bytewiseCompare(affectedTuple(left), affectedTuple(right)),
  );
  const serialized = sorted.map((item) => `${affectedTuple(item)}\n`).join("");
  return {
    total: sorted.length,
    sample_limit: AFFECTED_SAMPLE_LIMIT,
    sample: sorted.slice(0, AFFECTED_SAMPLE_LIMIT),
    truncated: sorted.length > AFFECTED_SAMPLE_LIMIT,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function orchestrationPreviewResult(): RepositoryIndexResult {
  return {
    ...repositoryResult(
      "preview_ready",
      "blocked_until_version_proven",
      "none",
      {
        gbrain_contacted: false,
        compatibility_proven: false,
        required_gbrain_version:
          REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
      },
      "gbrain --version",
    ),
    preview_kind: "orchestration_unvalidated",
  };
}

function parseJsonDocument(stdout: string): unknown | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

interface ValidatedChildResult {
  status: "synced" | "first_sync" | "up_to_date";
  fromCommit: string | null;
  bookmarkAfter: string;
  operations: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
  };
  affected: {
    total: number;
    sample_limit: number;
    sample: AffectedItem[];
    truncated: boolean;
  };
  affectedDigest: string;
  corpus: {
    markdown_planned_or_applied: number;
    code_pages_before: number;
    code_pages_after: number;
    code_deletions_applied: number;
    image_operations_applied: 0;
    image_pages_after: number;
    multimodal_enabled: false;
    embedding_status: "deferred" | "complete";
    extraction_status: "deferred" | "complete";
    search_ready: boolean;
  };
}

type ChildVerdict =
  | { kind: "complete"; value: ValidatedChildResult }
  | {
      kind: "incomplete";
      reason: "sync_partial" | "sync_blocked" | "sync_failed";
      state: RepositoryIndexState;
    }
  | {
      kind: "child_error";
      reasonCode: string;
      state: RepositoryIndexState;
      status: "incomplete" | "refused" | "error";
      exitCode: 1 | 2;
      problem: string | null;
      nextAction: string | null;
    }
  | { kind: "invalid"; detail: string };

function validateChildResult(
  raw: unknown,
  expected: {
    sourceId: string;
    head: string;
    bookmarkBefore: string | null;
  },
): ChildVerdict {
  if (!isRecord(raw) || raw.schema_version !== 1) {
    return { kind: "invalid", detail: "missing schema_version 1" };
  }
  if (raw.result_kind === "gbrain_sync_error") {
    const childStates = new Set<RepositoryIndexState>([
      "none",
      "lock_only",
      "partial",
    ]);
    if (
      (raw.status === "refused" || raw.status === "error") &&
      typeof raw.reason_code === "string" &&
      typeof raw.state_changed === "string" &&
      childStates.has(raw.state_changed as RepositoryIndexState) &&
      validChildErrorTuple(
        raw.reason_code,
        raw.status,
        raw.state_changed,
      )
    ) {
      const state = raw.state_changed as RepositoryIndexState;
      return {
        kind: "child_error",
        reasonCode: raw.reason_code,
        state,
        status:
          raw.reason_code === "lock_busy"
            ? "incomplete"
            : raw.reason_code === "lock_release_failed"
              ? "error"
              : raw.status,
        exitCode: raw.reason_code === "lock_busy" ? 2 : 1,
        problem: typeof raw.problem === "string" ? raw.problem : null,
        nextAction:
          typeof raw.next_action === "string" ? raw.next_action : null,
      };
    }
    return { kind: "invalid", detail: "malformed gbrain_sync_error" };
  }
  if (
    raw.result_kind !== "gbrain_sync" ||
    typeof raw.status !== "string"
  ) {
    return { kind: "invalid", detail: "wrong child result kind or status" };
  }
  if (CHILD_INCOMPLETE_STATUSES.has(raw.status)) {
    return {
      kind: "incomplete",
      reason:
        raw.status === "blocked_by_failures"
          ? "sync_blocked"
          : "sync_partial",
      state: "partial",
    };
  }
  if (!CHILD_TERMINAL_STATUSES.has(raw.status)) {
    return { kind: "invalid", detail: `unknown child status: ${raw.status}` };
  }
  if (
    !isRecord(raw.source) ||
    raw.source.id !== expected.sourceId ||
    !isRecord(raw.repository) ||
    raw.repository.from_commit !== expected.bookmarkBefore ||
    raw.repository.target_commit !== expected.head ||
    raw.repository.bookmark_after !== expected.head ||
    raw.repository.last_successful_strategy !== "auto" ||
    raw.strategy !== "auto"
  ) {
    return {
      kind: "invalid",
      detail: "child source, commit, bookmark, or strategy evidence mismatched",
    };
  }
  if (!isRecord(raw.operations)) {
    return { kind: "invalid", detail: "missing operation counts" };
  }
  const operations = {
    added: raw.operations.added,
    modified: raw.operations.modified,
    deleted: raw.operations.deleted,
    renamed: raw.operations.renamed,
  };
  if (!Object.values(operations).every(nonNegativeInteger)) {
    return { kind: "invalid", detail: "invalid operation counts" };
  }
  if (
    raw.status === "up_to_date" &&
    Object.values(operations).some((count) => count !== 0)
  ) {
    return {
      kind: "invalid",
      detail: "up_to_date cannot report content mutations",
    };
  }
  if (
    !isRecord(raw.affected) ||
    !nonNegativeInteger(raw.affected.total) ||
    raw.affected.sample_limit !== AFFECTED_SAMPLE_LIMIT ||
    !Array.isArray(raw.affected.sample) ||
    typeof raw.affected.truncated !== "boolean" ||
    typeof raw.affected_digest !== "string" ||
    !SHA_256.test(raw.affected_digest)
  ) {
    return { kind: "invalid", detail: "invalid bounded affected evidence" };
  }
  const expectedTotal =
    operations.added +
    operations.modified +
    operations.deleted +
    operations.renamed;
  if (
    raw.affected.total !== expectedTotal ||
    raw.affected.sample.length !==
      Math.min(raw.affected.total, AFFECTED_SAMPLE_LIMIT) ||
    raw.affected.truncated !==
      (raw.affected.total > AFFECTED_SAMPLE_LIMIT)
  ) {
    return {
      kind: "invalid",
      detail: "affected totals or truncation do not match operation counts",
    };
  }
  const sample: AffectedItem[] = [];
  for (const value of raw.affected.sample) {
    if (!isRecord(value)) {
      return { kind: "invalid", detail: "affected sample row is not an object" };
    }
    const operation =
      typeof value.operation === "string" ? value.operation : "";
    const hasFromPath = Object.hasOwn(value, "from_path");
    if (
      (operation === "rename" && typeof value.from_path !== "string") ||
      (operation !== "rename" && hasFromPath)
    ) {
      return {
        kind: "invalid",
        detail: "affected from_path does not match the operation kind",
      };
    }
    const item = canonicalAffectedItem(
      {
        operation,
        path: typeof value.path === "string" ? value.path : "",
        slug: typeof value.slug === "string" ? value.slug : "",
        ...(typeof value.from_path === "string"
          ? { from_path: value.from_path }
          : {}),
      },
      true,
    );
    if (!item) {
      return { kind: "invalid", detail: "affected sample row is invalid" };
    }
    sample.push(item);
  }
  const sortedSample = [...sample].sort((left, right) =>
    bytewiseCompare(affectedTuple(left), affectedTuple(right)),
  );
  if (
    sample.some(
      (item, index) => affectedTuple(item) !== affectedTuple(sortedSample[index]),
    )
  ) {
    return { kind: "invalid", detail: "affected sample is not canonical" };
  }
  if (
    raw.affected.truncated === false &&
    summarizeAffectedItems(sample).sha256 !== raw.affected_digest
  ) {
    return {
      kind: "invalid",
      detail: "affected digest does not match the complete sample",
    };
  }
  const sampleCounts = {
    added: sample.filter((item) => item.operation === "add").length,
    modified: sample.filter((item) => item.operation === "modify").length,
    deleted: sample.filter((item) => item.operation === "delete").length,
    renamed: sample.filter((item) => item.operation === "rename").length,
  };
  const countKeys = Object.keys(sampleCounts) as Array<
    keyof typeof sampleCounts
  >;
  if (
    countKeys.some((key) =>
      raw.affected.truncated
        ? sampleCounts[key] > operations[key]
        : sampleCounts[key] !== operations[key],
    )
  ) {
    return {
      kind: "invalid",
      detail: "affected sample kinds do not match operation counts",
    };
  }
  if (!validCorpusReceipt(raw.corpus)) {
    return {
      kind: "invalid",
      detail: "corpus receipt values are incomplete or contradictory",
    };
  }

  return {
    kind: "complete",
    value: {
      status: raw.status as ValidatedChildResult["status"],
      fromCommit: raw.repository.from_commit as string | null,
      bookmarkAfter: raw.repository.bookmark_after as string,
      operations: operations as ValidatedChildResult["operations"],
      affected: {
        total: raw.affected.total,
        sample_limit: raw.affected.sample_limit,
        sample,
        truncated: raw.affected.truncated,
      },
      affectedDigest: raw.affected_digest,
      corpus: raw.corpus as unknown as ValidatedChildResult["corpus"],
    },
  };
}

export function writeRepositoryIndexReceipt(
  path: string,
  receipt: RepositoryIndexResult,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort: the original receipt was never replaced.
    }
    throw error;
  }
}

function readCurrentRepositoryState(root: string): RepositoryState {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const status = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  const trackedMarker = spawnSync(
    "git",
    ["ls-files", "--", ".gbrain-source"],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  const headAfter = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const porcelain =
    status.status === 0 ? (status.stdout || "").trim() : null;
  const headText =
    head.status === 0 ? (head.stdout || "").trim() : null;
  const headAfterText =
    headAfter.status === 0 ? (headAfter.stdout || "").trim() : null;
  return {
    head: headText,
    head_after: headAfterText,
    stable: headText !== null && headText === headAfterText,
    clean: porcelain === "",
    porcelain,
    source_marker_tracked:
      trackedMarker.status === 0
        ? (trackedMarker.stdout || "").trim() !== ""
        : null,
  };
}

function readCurrentAttachedSource(root: string): AttachedSourceState {
  const path = join(root, ".gbrain-source");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return {
        present: true,
        sourceId: null,
        trustworthy: false,
        detail: ".gbrain-source is not a regular file",
      };
    }
    if (
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid() &&
      stat.uid !== 0
    ) {
      return {
        present: true,
        sourceId: null,
        trustworthy: false,
        detail: ".gbrain-source is not owned by the current user or root",
      };
    }
    if (
      typeof process.getuid === "function" &&
      (stat.mode & 0o022) !== 0
    ) {
      return {
        present: true,
        sourceId: null,
        trustworthy: false,
        detail: ".gbrain-source is group- or world-writable",
      };
    }
    if (stat.size > SOURCE_MARKER_MAX_BYTES) {
      return {
        present: true,
        sourceId: null,
        trustworthy: false,
        detail: `.gbrain-source exceeds ${SOURCE_MARKER_MAX_BYTES} bytes`,
      };
    }
    const marker = readFileSync(descriptor, "utf-8");
    const sourceId = marker.endsWith("\r\n")
      ? marker.slice(0, -2)
      : marker.endsWith("\n")
        ? marker.slice(0, -1)
        : marker;
    if (!SOURCE_ID.test(sourceId)) {
      return {
        present: true,
        sourceId: null,
        trustworthy: false,
        detail: ".gbrain-source does not contain one canonical source id",
      };
    }
    return {
      present: true,
      sourceId,
      trustworthy: true,
      detail: null,
    };
  } catch (error) {
    const missing =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      present: !missing,
      sourceId: null,
      trustworthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Replace `.gbrain-source` without ever opening the destination for writing.
 *
 * GBrain's historical `sources attach` implementation used a truncating
 * write, so a symlink introduced after the wrapper's preflight could redirect
 * that write outside the repository. A same-directory exclusive temporary
 * file plus rename replaces the directory entry itself (including a symlink)
 * and never follows its target.
 */
export function writeRepositorySourceMarker(
  root: string,
  sourceId: string,
): void {
  if (!SOURCE_ID.test(sourceId)) {
    throw new Error("source id is not canonical");
  }
  const canonicalRoot = realpathSync.native(root);
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new Error("repository root is not a directory");
  }

  const markerPath = join(canonicalRoot, ".gbrain-source");
  const temporaryPath = join(
    canonicalRoot,
    `.gbrain-source.tmp.${process.pid}.${randomBytes(12).toString("hex")}`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const temporaryStat = fstatSync(descriptor);
    if (!temporaryStat.isFile()) {
      throw new Error("temporary source marker is not a regular file");
    }
    writeFileSync(descriptor, `${sourceId}\n`, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, markerPath);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort: an exclusive temporary file is never the trusted marker.
    }
    throw error;
  }
}

function ensureLocalSourceMarkerExclude(
  root: string,
):
  | { ok: true; path: string; changed: boolean }
  | { ok: false; detail: string } {
  const commonDirProbe = spawnSync(
    "git",
    ["rev-parse", "--git-common-dir"],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (commonDirProbe.status !== 0) {
    return {
      ok: false,
      detail: (commonDirProbe.stderr || "git common directory unavailable").trim(),
    };
  }

  try {
    const rawCommonDir = (commonDirProbe.stdout || "").trim();
    if (!rawCommonDir) {
      return { ok: false, detail: "git common directory was empty" };
    }
    const commonDir = realpathSync.native(
      isAbsolute(rawCommonDir)
        ? rawCommonDir
        : resolve(root, rawCommonDir),
    );
    const infoDir = join(commonDir, "info");
    mkdirSync(infoDir, { recursive: true });
    if (realpathSync.native(infoDir) !== infoDir) {
      return {
        ok: false,
        detail: "git info directory did not preserve canonical identity",
      };
    }
    const excludePath = join(infoDir, "exclude");
    let excludeDescriptor: number | null = null;
    try {
      try {
        excludeDescriptor = openSync(
          excludePath,
          fsConstants.O_RDWR |
            fsConstants.O_APPEND |
            fsConstants.O_NOFOLLOW,
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
        ) {
          throw error;
        }
        excludeDescriptor = openSync(
          excludePath,
          fsConstants.O_RDWR |
            fsConstants.O_APPEND |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
      }
      const stat = fstatSync(excludeDescriptor);
      if (!stat.isFile()) {
        return {
          ok: false,
          detail: "git info/exclude is not a regular file",
        };
      }
      if (
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid() &&
        stat.uid !== 0
      ) {
        return {
          ok: false,
          detail: "git info/exclude is not owned by the current user or root",
        };
      }
      if (
        typeof process.getuid === "function" &&
        (stat.mode & 0o022) !== 0
      ) {
        return {
          ok: false,
          detail: "git info/exclude is group- or world-writable",
        };
      }
      const existing = readFileSync(excludeDescriptor, "utf-8");
      if (
        existing
          .split("\n")
          .some((line) => line.trim() === ".gbrain-source")
      ) {
        return { ok: true, path: excludePath, changed: false };
      }
      appendFileSync(
        excludeDescriptor,
        `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}.gbrain-source\n`,
        "utf-8",
      );
      return { ok: true, path: excludePath, changed: true };
    } finally {
      if (excludeDescriptor !== null) closeSync(excludeDescriptor);
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function receiptVerificationFailure(
  reasonCode: "receipt_missing" | "receipt_invalid" | "receipt_stale",
  evidence: Record<string, unknown>,
): RepositoryIndexRunOutput {
  return {
    result: repositoryResult(
      reasonCode === "receipt_invalid" ? "error" : "refused",
      reasonCode,
      "none",
      evidence,
      "gstack-gbrain-sync --code-only --json",
    ),
    exitCode: 1,
  };
}

function readRepositoryIndexReceipt(path: string): unknown {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("receipt is not a regular file");
    }
    if (
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid() &&
      stat.uid !== 0
    ) {
      throw new Error("receipt is not owned by the current user or root");
    }
    if (
      typeof process.getuid === "function" &&
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("receipt is group- or world-writable");
    }
    if (stat.size > 1024 * 1024) {
      throw new Error("receipt exceeds 1 MiB");
    }
    return JSON.parse(readFileSync(descriptor, "utf-8"));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Rebind the persisted GREEN receipt to the repository that is live now.
 *
 * The receipt path is global to GSTACK_HOME and successful runs intentionally
 * leave prior evidence in place. Consumers must therefore prove that the
 * receipt belongs to this canonical root, source marker, and current clean
 * full HEAD instead of trusting its internally consistent historical fields.
 */
export function verifyCurrentRepositoryIndexReceipt(
  root: string,
  gstackHome: string,
): RepositoryIndexRunOutput {
  const receiptPath = join(gstackHome, REPOSITORY_INDEX_RECEIPT);
  let raw: unknown;
  try {
    raw = readRepositoryIndexReceipt(receiptPath);
  } catch (error) {
    const missing =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    return receiptVerificationFailure(
      missing ? "receipt_missing" : "receipt_invalid",
      {
        receipt_path: receiptPath,
        detail: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.result_kind !== "repository_index" ||
    raw.status !== "verified" ||
    (raw.reason_code !== "verified" && raw.reason_code !== "up_to_date") ||
    raw.state_changed !== "applied_verified" ||
    raw.next_command !== null ||
    raw.docs !== REPOSITORY_INDEX_RECOVERY_DOC ||
    !isRecord(raw.evidence)
  ) {
    return receiptVerificationFailure("receipt_invalid", {
      receipt_path: receiptPath,
      detail: "receipt envelope is not a schema-1 verified result",
    });
  }

  const evidence = raw.evidence;
  const source = evidence.source;
  const repository = evidence.repository;
  const sync = evidence.sync;
  const verification = evidence.verification;
  const corpus = evidence.corpus;
  if (
    typeof evidence.gbrain_version !== "string" ||
    !isReleasedVersionAtLeast(evidence.gbrain_version) ||
    evidence.required_gbrain_version !==
      REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION ||
    !isRecord(source) ||
    typeof source.id !== "string" ||
    !SOURCE_ID.test(source.id) ||
    typeof source.canonical_path !== "string" ||
    source.path_identity !== "equivalent" ||
    !isRecord(repository) ||
    typeof repository.git_head !== "string" ||
    !SHA_40.test(repository.git_head) ||
    repository.target_commit !== repository.git_head ||
    repository.bookmark_after !== repository.git_head ||
    repository.last_successful_strategy !== "auto" ||
    repository.working_tree_clean !== true ||
    !isRecord(sync) ||
    !CHILD_TERMINAL_STATUSES.has(String(sync.terminal_status)) ||
    sync.strategy !== "auto" ||
    !nonNegativeInteger(sync.added) ||
    !nonNegativeInteger(sync.modified) ||
    !nonNegativeInteger(sync.deleted) ||
    !nonNegativeInteger(sync.renamed) ||
    !isRecord(sync.affected) ||
    !nonNegativeInteger(sync.affected.total) ||
    sync.affected.sample_limit !== AFFECTED_SAMPLE_LIMIT ||
    !Array.isArray(sync.affected.sample) ||
    typeof sync.affected.truncated !== "boolean" ||
    typeof sync.affected.sha256 !== "string" ||
    !SHA_256.test(sync.affected.sha256) ||
    !validCorpusReceipt(corpus) ||
    !isRecord(verification) ||
    verification.source_path_matches !== true ||
    verification.bookmark_matches_clean_head !== true ||
    verification.attached_source_matches !== true ||
    verification.trusted !== true
  ) {
    return receiptVerificationFailure("receipt_invalid", {
      receipt_path: receiptPath,
      detail: "receipt evidence is incomplete or contradictory",
    });
  }

  const operationTotal =
    (sync.added as number) +
    (sync.modified as number) +
    (sync.deleted as number) +
    (sync.renamed as number);
  if (
    sync.affected.total !== operationTotal ||
    sync.affected.sample.length !==
      Math.min(operationTotal, AFFECTED_SAMPLE_LIMIT) ||
    sync.affected.truncated !==
      (operationTotal > AFFECTED_SAMPLE_LIMIT)
  ) {
    return receiptVerificationFailure("receipt_invalid", {
      receipt_path: receiptPath,
      detail: "receipt affected summary does not match operation counts",
    });
  }

  const receiptSample: AffectedItem[] = [];
  for (const row of sync.affected.sample) {
    if (!isRecord(row)) {
      return receiptVerificationFailure("receipt_invalid", {
        receipt_path: receiptPath,
        detail: "receipt affected sample contains a non-object row",
      });
    }
    const item = canonicalAffectedItem(
      {
        operation:
          typeof row.operation === "string" ? row.operation : "",
        path: typeof row.path === "string" ? row.path : "",
        slug: typeof row.slug === "string" ? row.slug : "",
        ...(typeof row.from_path === "string"
          ? { from_path: row.from_path }
          : {}),
      },
      true,
    );
    if (
      !item ||
      (item.operation === "rename") !==
        Object.hasOwn(row, "from_path")
    ) {
      return receiptVerificationFailure("receipt_invalid", {
        receipt_path: receiptPath,
        detail: "receipt affected sample row is invalid",
      });
    }
    receiptSample.push(item);
  }
  const canonicalSample = [...receiptSample].sort((left, right) =>
    bytewiseCompare(affectedTuple(left), affectedTuple(right)),
  );
  if (
    receiptSample.some(
      (item, index) =>
        affectedTuple(item) !== affectedTuple(canonicalSample[index]),
    ) ||
    (!sync.affected.truncated &&
      summarizeAffectedItems(receiptSample).sha256 !==
        sync.affected.sha256)
  ) {
    return receiptVerificationFailure("receipt_invalid", {
      receipt_path: receiptPath,
      detail: "receipt affected sample or digest is not canonical",
    });
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch (error) {
    return receiptVerificationFailure("receipt_stale", {
      receipt_path: receiptPath,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const liveRepository = readCurrentRepositoryState(canonicalRoot);
  const attachedSource = readCurrentAttachedSource(canonicalRoot);
  if (
    source.canonical_path !== canonicalRoot ||
    liveRepository.head !== repository.git_head ||
    liveRepository.head_after !== repository.git_head ||
    !liveRepository.stable ||
    !liveRepository.clean ||
    liveRepository.source_marker_tracked !== false ||
    !attachedSource.trustworthy ||
    attachedSource.sourceId !== source.id
  ) {
    return receiptVerificationFailure("receipt_stale", {
      receipt_path: receiptPath,
      receipt_source_id: source.id,
      receipt_canonical_path: source.canonical_path,
      receipt_git_head: repository.git_head,
      live_canonical_path: canonicalRoot,
      live_repository: liveRepository,
      attached_source: attachedSource,
    });
  }

  return {
    result: raw as unknown as RepositoryIndexResult,
    exitCode: 0,
  };
}

function childErrorOutput(
  child: Extract<ChildVerdict, { kind: "child_error" }>,
  sourceId: string,
  head: string,
): RepositoryIndexRunOutput {
  return {
    result: repositoryResult(
      child.status,
      child.reasonCode,
      child.state,
      {
        source_id: sourceId,
        git_head: head,
        child_problem: child.problem,
      },
      child.nextAction,
    ),
    exitCode: child.exitCode,
  };
}

/**
 * Execute the repository-index transaction after the wrapper lifecycle lock is
 * held and Git root/HEAD/cleanliness are captured.
 */
export function runRepositoryIndex(
  input: RepositoryIndexRunInput,
): RepositoryIndexRunOutput {
  const gbrainEnv: NodeJS.ProcessEnv = {
    ...(input.baseEnv ?? process.env),
    GBRAIN_EMBEDDING_MULTIMODAL: "false",
  };
  const requiredVersion = parseReleasedGbrainVersion(
    REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
  );
  if (!requiredVersion) {
    return {
      result: repositoryResult(
        "error",
        "unsupported_version",
        "none",
        { required_gbrain_version: REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION },
      ),
      exitCode: 1,
    };
  }
  if (!SHA_40.test(input.head)) {
    return {
      result: repositoryResult(
        "refused",
        "repository_state_invalid",
        "none",
        { git_head: input.head },
      ),
      exitCode: 1,
    };
  }
  if (
    unsafeRepositoryPathForShell(
      input.root,
      input.platform ?? process.platform,
    )
  ) {
    return {
      result: repositoryResult(
        "refused",
        "unsupported_path",
        "none",
        { repository_root: input.root },
      ),
      exitCode: 1,
    };
  }

  const versionProbe = input.spawnGbrain(["--version"], {
    timeout: 10_000,
    baseEnv: gbrainEnv,
  });
  const detectedText = (versionProbe.stdout || "").trim();
  const detectedVersion =
    versionProbe.status === 0
      ? parseReleasedGbrainVersion(detectedText)
      : null;
  if (
    !detectedVersion ||
    compareReleasedVersions(detectedVersion, requiredVersion) < 0
  ) {
    return {
      result: repositoryResult(
        "refused",
        "unsupported_version",
        "none",
        {
          detected_gbrain_version: detectedText || null,
          required_gbrain_version:
            REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
        },
        "gbrain --version",
      ),
      exitCode: 1,
    };
  }

  const sourceProbe = input.spawnGbrain(["sources", "list", "--json"], {
    timeout: 30_000,
    baseEnv: gbrainEnv,
  });
  const sourceRaw =
    sourceProbe.status === 0
      ? parseJsonDocument(sourceProbe.stdout || "")
      : null;
  const sourceSnapshot =
    sourceRaw === null ? null : parseStrictSourceSnapshot(sourceRaw);
  if (!sourceSnapshot || !sourceSnapshot.ok) {
    return {
      result: repositoryResult(
        "error",
        "source_probe_failed",
        "none",
        {
          detail:
            sourceSnapshot && !sourceSnapshot.ok
              ? sourceSnapshot.error
              : (sourceProbe.stderr || "sources list did not return one JSON document")
                  .trim(),
        },
        "gbrain sources list --json",
      ),
      exitCode: 1,
    };
  }

  const source = sourceSnapshot.rows.find(
    (row) => row.id === input.sourceId,
  );
  if (!source) {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync.native(input.root);
    } catch (error) {
      return {
        result: repositoryResult(
          "refused",
          "source_path_ambiguous",
          "none",
          {
            repository_root: input.root,
            detail: error instanceof Error ? error.message : String(error),
          },
        ),
        exitCode: 1,
      };
    }
    if (
      unsafeRepositoryPathForShell(
        canonicalRoot,
        input.platform ?? process.platform,
      )
    ) {
      return {
        result: repositoryResult(
          "refused",
          "unsupported_path",
          "none",
          {
            repository_root: input.root,
            canonical_path: canonicalRoot,
          },
        ),
        exitCode: 1,
      };
    }
    const registrationRepositoryState =
      readCurrentRepositoryState(canonicalRoot);
    if (
      registrationRepositoryState.head !== input.head ||
      registrationRepositoryState.head_after !== input.head ||
      !registrationRepositoryState.stable ||
      registrationRepositoryState.source_marker_tracked !== false
    ) {
      return {
        result: repositoryResult(
          "refused",
          "repository_state_invalid",
          "none",
          {
            failing_step: "source_registration_repository_state",
            expected_head: input.head,
            repository_state: registrationRepositoryState,
          },
        ),
        exitCode: 1,
      };
    }
    const equivalentOwners = equivalentSourceOwnerIds(
      sourceSnapshot.rows,
      canonicalRoot,
      input.platform ?? process.platform,
    );
    if (equivalentOwners.length > 0) {
      return {
        result: repositoryResult(
          "refused",
          "source_path_ambiguous",
          "none",
          {
            source_id: input.sourceId,
            canonical_path: canonicalRoot,
            existing_source_ids: equivalentOwners,
          },
          "gbrain sources list --json",
        ),
        exitCode: 1,
      };
    }
    const registration = input.spawnGbrain(
      [
        "sources",
        "add",
        input.sourceId,
        "--path",
        canonicalRoot,
        "--federated",
      ],
      { cwd: canonicalRoot, timeout: 30_000, baseEnv: gbrainEnv },
    );
    if (registration.status !== 0) {
      return {
        result: repositoryResult(
          "error",
          "source_registration_failed",
          "partial",
          {
            source_id: input.sourceId,
            repository_root: input.root,
            detail: (registration.stderr || registration.stdout || "").trim(),
          },
        ),
        exitCode: 1,
      };
    }
    return {
      result: repositoryResult(
        "incomplete",
        "source_registered",
        "registry_only",
          {
            source_id: input.sourceId,
            canonical_path: canonicalRoot,
          required_gbrain_version:
            REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
        },
        "gstack-gbrain-sync --code-only --json",
      ),
      exitCode: 2,
    };
  }

  if (source.local_path === null) {
    return {
      result: repositoryResult(
        "refused",
        "source_path_ambiguous",
        "none",
        {
          source_id: input.sourceId,
          stored_path: null,
          detail: "the matching source has no local_path",
        },
        "gbrain sources list --json",
      ),
      exitCode: 1,
    };
  }

  const pathIdentity = classifyRepositoryPath(
    source.local_path,
    input.root,
    input.platform ?? process.platform,
  );
  if (pathIdentity.kind !== "equivalent") {
    return {
      result: repositoryResult(
        "refused",
        pathIdentity.kind === "different"
          ? "source_path_different"
          : "source_path_ambiguous",
        "none",
        {
          source_id: input.sourceId,
          path_identity: pathIdentity,
        },
        "gbrain sources list --json",
      ),
      exitCode: 1,
    };
  }
  if (
    unsafeRepositoryPathForShell(
      pathIdentity.canonical_path,
      input.platform ?? process.platform,
    )
  ) {
    return {
      result: repositoryResult(
        "refused",
        "unsupported_path",
        "none",
        {
          repository_root: input.root,
          canonical_path: pathIdentity.canonical_path,
        },
      ),
      exitCode: 1,
    };
  }
  const equivalentOwners = equivalentSourceOwnerIds(
    sourceSnapshot.rows,
    pathIdentity.canonical_path,
    input.platform ?? process.platform,
  );
  if (
    equivalentOwners.length !== 1 ||
    equivalentOwners[0] !== input.sourceId
  ) {
    return {
      result: repositoryResult(
        "refused",
        "source_path_ambiguous",
        "none",
        {
          source_id: input.sourceId,
          canonical_path: pathIdentity.canonical_path,
          existing_source_ids: equivalentOwners,
        },
        "gbrain sources list --json",
      ),
      exitCode: 1,
    };
  }

  const attachedBeforeSync = readCurrentAttachedSource(
    pathIdentity.canonical_path,
  );
  let localExcludeBeforeSync:
    | { ok: true; path: string; changed: boolean }
    | undefined;
  const stateAfterPreSyncMetadata = (
    state: RepositoryIndexState,
  ): RepositoryIndexState =>
    state === "none" && localExcludeBeforeSync?.changed === true
      ? "partial"
      : state;
  if (attachedBeforeSync.present) {
    if (
      !attachedBeforeSync.trustworthy ||
      attachedBeforeSync.sourceId !== input.sourceId
    ) {
      return {
        result: repositoryResult(
          "refused",
          "verification_failed",
          "none",
          {
            failing_step: "pre_sync_source_marker",
            source_id: input.sourceId,
            attached_source: attachedBeforeSync,
          },
        ),
        exitCode: 1,
      };
    }
    if (!input.workingTreeClean) {
      const exclude = ensureLocalSourceMarkerExclude(
        pathIdentity.canonical_path,
      );
      if (!exclude.ok) {
        return {
          result: repositoryResult(
            "error",
            "verification_failed",
            "none",
            {
              failing_step: "source_marker_exclude",
              source_id: input.sourceId,
              detail: exclude.detail,
            },
          ),
          exitCode: 1,
        };
      }
      localExcludeBeforeSync = exclude;
    }
  }
  const preRepositoryState = readCurrentRepositoryState(
    pathIdentity.canonical_path,
  );
  if (
    preRepositoryState.head !== input.head ||
    preRepositoryState.head_after !== input.head ||
    !preRepositoryState.stable ||
    preRepositoryState.source_marker_tracked !== false
  ) {
    return {
      result: repositoryResult(
        "refused",
        "repository_state_invalid",
        stateAfterPreSyncMetadata("none"),
        {
          failing_step: "pre_sync_repository_state",
          expected_head: input.head,
          repository_state: preRepositoryState,
        },
      ),
      exitCode: 1,
    };
  }
  const workingTreeCleanBeforeSync = preRepositoryState.clean;

  const expectedBookmark = source.last_commit ?? "none";
  const syncArgs = [
    "sync",
    "--strategy",
    "auto",
    "--source",
    input.sourceId,
    "--repo",
    pathIdentity.canonical_path,
    "--no-pull",
    "--expected-target",
    input.head,
    "--expected-bookmark",
    expectedBookmark,
  ];
  if (workingTreeCleanBeforeSync) syncArgs.push("--require-clean");
  syncArgs.push("--json");

  const sync = input.spawnGbrain(syncArgs, {
    cwd: pathIdentity.canonical_path,
    timeout: 35 * 60 * 1000,
    baseEnv: gbrainEnv,
  });
  const childRaw = parseJsonDocument(sync.stdout || "");
  if (sync.status !== 0) {
    if (childRaw !== null) {
      const refused = validateChildResult(childRaw, {
        sourceId: input.sourceId,
        head: input.head,
        bookmarkBefore: source.last_commit,
      });
      if (refused.kind === "incomplete") {
        return {
          result: repositoryResult(
            "incomplete",
            refused.reason,
            refused.state,
            {
              source_id: input.sourceId,
              git_head: input.head,
              child_exit: sync.status,
            },
          ),
          exitCode: refused.reason === "sync_blocked" ? 2 : 1,
        };
      }
      if (refused.kind === "child_error") {
        return childErrorOutput(
          {
            ...refused,
            state: stateAfterPreSyncMetadata(refused.state),
          },
          input.sourceId,
          input.head,
        );
      }
      if (refused.kind === "invalid") {
        return {
          result: repositoryResult(
            "error",
            "source_result_invalid",
            "partial",
            {
              source_id: input.sourceId,
              git_head: input.head,
              child_exit: sync.status,
              detail: refused.detail,
            },
          ),
          exitCode: 1,
        };
      }
    }
    return {
      result: repositoryResult(
        "error",
        "sync_failed",
        "partial",
        {
          source_id: input.sourceId,
          git_head: input.head,
          child_exit: sync.status,
          child_stderr: (sync.stderr || "").trim(),
        },
      ),
      exitCode: 1,
    };
  }
  if (childRaw === null) {
    return {
      result: repositoryResult(
        "error",
        "source_result_invalid",
        "applied_unverified",
        {
          source_id: input.sourceId,
          detail: "child stdout was not exactly one JSON document",
        },
      ),
      exitCode: 1,
    };
  }
  const child = validateChildResult(childRaw, {
    sourceId: input.sourceId,
    head: input.head,
    bookmarkBefore: source.last_commit,
  });
  if (child.kind === "incomplete") {
    return {
      result: repositoryResult(
        "incomplete",
        child.reason,
        child.state,
        {
          source_id: input.sourceId,
          git_head: input.head,
        },
      ),
      exitCode: 1,
    };
  }
  if (child.kind === "child_error") {
    return childErrorOutput(
      {
        ...child,
        state: stateAfterPreSyncMetadata(child.state),
      },
      input.sourceId,
      input.head,
    );
  }
  if (child.kind === "invalid") {
    return {
      result: repositoryResult(
        "error",
        "source_result_invalid",
        "applied_unverified",
        {
          source_id: input.sourceId,
          detail: child.detail,
        },
      ),
      exitCode: 1,
    };
  }

  const postSourceProbe = input.spawnGbrain(
    ["sources", "list", "--json"],
    { timeout: 30_000, baseEnv: gbrainEnv },
  );
  const postSourceRaw =
    postSourceProbe.status === 0
      ? parseJsonDocument(postSourceProbe.stdout || "")
      : null;
  const postSnapshot =
    postSourceRaw === null
      ? null
      : parseStrictSourceSnapshot(postSourceRaw);
  const postSource =
    postSnapshot?.ok === true
      ? postSnapshot.rows.find((row) => row.id === input.sourceId)
      : undefined;
  const postEquivalentOwners =
    postSnapshot?.ok === true
      ? equivalentSourceOwnerIds(
          postSnapshot.rows,
          input.root,
          input.platform ?? process.platform,
        )
      : [];
  const postPathIdentity = postSource?.local_path
    ? classifyRepositoryPath(
        postSource.local_path,
        input.root,
        input.platform ?? process.platform,
      )
    : null;
  if (
    !postSource ||
    postEquivalentOwners.length !== 1 ||
    postEquivalentOwners[0] !== input.sourceId ||
    postPathIdentity?.kind !== "equivalent" ||
    postSource.last_commit !== input.head ||
    postSource.last_successful_strategy !== "auto"
  ) {
    return {
      result: repositoryResult(
        "error",
        "verification_failed",
        "applied_unverified",
        {
          failing_step: "post_sync_source_snapshot",
          source_id: input.sourceId,
          existing_source_ids: postEquivalentOwners,
          git_head: input.head,
          detail:
            postSnapshot && !postSnapshot.ok
              ? postSnapshot.error
              : (postSourceProbe.stderr || "").trim(),
        },
      ),
      exitCode: 1,
    };
  }

  try {
    (input.writeSourceMarker ?? writeRepositorySourceMarker)(
      pathIdentity.canonical_path,
      input.sourceId,
    );
  } catch (error) {
    return {
      result: repositoryResult(
        "error",
        "verification_failed",
        "applied_unverified",
        {
          failing_step: "source_attach",
          source_id: input.sourceId,
          git_head: input.head,
          detail: error instanceof Error ? error.message : String(error),
        },
      ),
      exitCode: 1,
    };
  }
  const localExclude =
    localExcludeBeforeSync ??
    ensureLocalSourceMarkerExclude(pathIdentity.canonical_path);
  if (!localExclude.ok) {
    return {
      result: repositoryResult(
        "error",
        "verification_failed",
        "applied_unverified",
        {
          failing_step: "source_marker_exclude",
          source_id: input.sourceId,
          git_head: input.head,
          detail: localExclude.detail,
        },
      ),
      exitCode: 1,
    };
  }
  const postRepositoryState = (
    input.readRepositoryState ?? readCurrentRepositoryState
  )(pathIdentity.canonical_path);
  const attachedSource = (
    input.readAttachedSource ?? readCurrentAttachedSource
  )(pathIdentity.canonical_path);
  if (
    !workingTreeCleanBeforeSync ||
    postRepositoryState.head !== input.head ||
    postRepositoryState.head_after !== input.head ||
    !postRepositoryState.stable ||
    !postRepositoryState.clean ||
    postRepositoryState.source_marker_tracked !== false ||
    !attachedSource.trustworthy ||
    attachedSource.sourceId !== input.sourceId
  ) {
    return {
      result: repositoryResult(
        "error",
        "verification_failed",
        "applied_unverified",
        {
          failing_step: "post_attach_repository_state",
          source_id: input.sourceId,
          git_head: input.head,
          working_tree_clean_before_apply: workingTreeCleanBeforeSync,
          post_repository_state: postRepositoryState,
          attached_source: attachedSource,
        },
      ),
      exitCode: 1,
    };
  }

  const finalSourceProbe = input.spawnGbrain(
    ["sources", "list", "--json"],
    { timeout: 30_000, baseEnv: gbrainEnv },
  );
  const finalSourceRaw =
    finalSourceProbe.status === 0
      ? parseJsonDocument(finalSourceProbe.stdout || "")
      : null;
  const finalSnapshot =
    finalSourceRaw === null
      ? null
      : parseStrictSourceSnapshot(finalSourceRaw);
  const finalSource =
    finalSnapshot?.ok === true
      ? finalSnapshot.rows.find((row) => row.id === input.sourceId)
      : undefined;
  const finalEquivalentOwners =
    finalSnapshot?.ok === true
      ? equivalentSourceOwnerIds(
          finalSnapshot.rows,
          pathIdentity.canonical_path,
          input.platform ?? process.platform,
        )
      : [];
  const finalPathIdentity = finalSource?.local_path
    ? classifyRepositoryPath(
        finalSource.local_path,
        pathIdentity.canonical_path,
        input.platform ?? process.platform,
      )
    : null;
  if (
    !finalSource ||
    finalEquivalentOwners.length !== 1 ||
    finalEquivalentOwners[0] !== input.sourceId ||
    finalPathIdentity?.kind !== "equivalent" ||
    finalSource.last_commit !== input.head ||
    finalSource.last_successful_strategy !== "auto"
  ) {
    return {
      result: repositoryResult(
        "error",
        "verification_failed",
        "applied_unverified",
        {
          failing_step: "post_attach_source_snapshot",
          source_id: input.sourceId,
          existing_source_ids: finalEquivalentOwners,
          git_head: input.head,
          detail:
            finalSnapshot && !finalSnapshot.ok
              ? finalSnapshot.error
              : (finalSourceProbe.stderr || "").trim(),
        },
      ),
      exitCode: 1,
    };
  }

  const verified = repositoryResult(
    "verified",
    child.value.status === "up_to_date" ? "up_to_date" : "verified",
    "applied_verified",
    {
      verification_scope: "content_sync",
      gbrain_version: detectedText,
      required_gbrain_version:
        REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
      source: {
        id: input.sourceId,
        stored_path: finalSource.local_path,
        canonical_path: pathIdentity.canonical_path,
        path_identity: "equivalent",
      },
      repository: {
        git_head: postRepositoryState.head,
        working_tree_clean: postRepositoryState.clean,
        bookmark_before: source.last_commit,
        target_commit: input.head,
        bookmark_after: child.value.bookmarkAfter,
        last_successful_strategy: "auto",
      },
      sync: {
        terminal_status: child.value.status,
        strategy: "auto",
        ...child.value.operations,
        affected: {
          ...child.value.affected,
          sha256: child.value.affectedDigest,
        },
      },
      corpus: child.value.corpus,
      verification: {
        source_path_matches: true,
        bookmark_matches_clean_head: true,
        attached_source_matches: true,
        local_exclude_path: localExclude.path,
        trusted: true,
      },
    },
  );
  const receiptPath = join(input.gstackHome, REPOSITORY_INDEX_RECEIPT);
  try {
    (input.writeReceipt ?? writeRepositoryIndexReceipt)(
      receiptPath,
      verified,
    );
  } catch (error) {
    return {
      result: repositoryResult(
        "error",
        "verification_failed",
        "applied_unverified",
        {
          failing_step: "receipt_write",
          source_id: input.sourceId,
          git_head: input.head,
          receipt_path: receiptPath,
          detail: error instanceof Error ? error.message : String(error),
        },
      ),
      exitCode: 1,
    };
  }

  return { result: verified, exitCode: 0 };
}

export function renderRepositoryIndexResult(
  result: RepositoryIndexResult,
): string {
  if (result.status === "preview_ready") {
    return [
      "ORCHESTRATION PREVIEW — unvalidated",
      "GBrain was not contacted.",
      "No engine/source/path/content compatibility was proven.",
      `Required GBrain: >= ${REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION}`,
      "Prerequisites:",
      "  1. gbrain --version",
      "  2. gbrain sources list --json",
      "  3. Stop if version, source, path, or bookmark cannot be proven.",
      `Command state: ${result.reason_code}`,
      `Fallback: use repository files and rg`,
      `Docs: ${result.docs}`,
    ].join("\n");
  }

  const problems: Record<string, string> = {
    lock_busy: "Another repository-index lifecycle currently owns the wrapper lock.",
    unsupported_version:
      "The installed GBrain release cannot prove the repository-index safety contract.",
    source_probe_failed:
      "The registered-source snapshot was unavailable, malformed, or ambiguous.",
    source_registered:
      "The source was registered safely, but no content plan was applied.",
    source_path_different:
      "The source id is registered to a different canonical directory.",
    source_path_ambiguous:
      "The stored source path cannot be proven equivalent to this repository.",
    unsupported_path:
      "The repository path is unsafe for the current Windows shell transport.",
    sync_partial:
      "GBrain reported a partial repository-index application.",
    sync_blocked:
      "GBrain refused or blocked the repository-index application.",
    sync_failed:
      "GBrain did not produce a trustworthy completed repository-index result.",
    source_result_invalid:
      "GBrain output did not match the one-document schema-1 completion contract.",
    receipt_missing:
      "No persisted repository-index receipt is available for this worktree.",
    receipt_invalid:
      "The persisted repository-index receipt is malformed or untrusted.",
    receipt_stale:
      "The persisted receipt does not match this live canonical worktree and clean full HEAD.",
    verification_failed:
      "Content may have been applied, but a required postcondition did not verify.",
    verified:
      "The repository index was applied and verified against the current clean HEAD.",
    up_to_date:
      "The repository index already matched the current clean HEAD and verified.",
  };
  const requirements: Record<string, string> = {
    unsupported_version: `A strict released version >= ${REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION}.`,
    source_probe_failed:
      "One valid unique sources snapshot with id, local_path, last_commit, and strategy evidence.",
    source_registered:
      "A second invocation after registration so expected bookmark state can be planned.",
    source_path_different:
      "Canonical filesystem identity; no automatic remove/re-add recovery.",
    source_path_ambiguous:
      "An existing readable directory canonically identical to the Git root.",
    unsupported_path:
      "A Windows repository path without whitespace or cmd.exe metacharacters until shell transport is replaced.",
    sync_partial:
      "A terminal synced, first_sync, or up_to_date child result.",
    sync_blocked:
      "Satisfied expected root, target, bookmark, and source-lock preconditions.",
    sync_failed:
      "A terminal child result with exact expected-state evidence.",
    source_result_invalid:
      "Exactly one schema-1 gbrain_sync JSON document and a recognized status.",
    receipt_missing:
      "A successful current repository-index invocation before receipt verification.",
    receipt_invalid:
      "A trusted schema-1 receipt written atomically by the repository-index wrapper.",
    receipt_stale:
      "Exact equality with the live canonical root, attached source, clean full HEAD, and receipt evidence.",
    verification_failed:
      "Post-sync source bookmark/strategy, attach, clean HEAD, and atomic receipt must all verify.",
  };
  const stateExplanations: Record<RepositoryIndexState, string> = {
    none: "No durable repository-index state was changed by this invocation.",
    lock_only:
      "Only transient lifecycle-lock state may have changed; no content was applied.",
    registry_only:
      "Only source registration changed; sync and attach were not attempted.",
    partial:
      "Repository-index support metadata or content may have changed, but full completion was not proven.",
    applied_unverified:
      "Index work may be complete, but no trusted GREEN receipt can be claimed.",
    applied_verified:
      "Index work, source marker, clean-HEAD bookmark, and receipt all verified.",
  };
  return [
    `${result.status === "verified" ? "OK" : "ERROR"} [${result.reason_code}]`,
    `Problem: ${problems[result.reason_code] ?? "The repository-index contract did not complete."}`,
    `Observed: ${JSON.stringify(result.evidence)}`,
    `Required: ${requirements[result.reason_code] ?? "All repository-index safety and verification invariants."}`,
    `State changed: ${result.state_changed}`,
    `State explanation: ${stateExplanations[result.state_changed]}`,
    `Next command: ${result.next_command ?? "none — owner review required"}`,
    "Fallback: use repository files and rg",
    `Docs: ${result.docs}`,
  ].join("\n");
}
