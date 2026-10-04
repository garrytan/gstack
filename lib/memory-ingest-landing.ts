/**
 * Memory ingest landing contract (A1, #2778): write, verify, then stamp.
 *
 * `gbrain import` exits 0 while skipping pages (returned per-file failures,
 * malformed filenames, managed-import `Pending:` receipts), and its failure
 * ledger is written only for git import dirs, so a staged page that never
 * landed used to be stamped ingested and never retried. This module owns:
 *
 *   - the versioned ingest state and its transition table,
 *   - parsing `gbrain import --json` plus its stderr into named failures and
 *     a whole-batch refusal when a failure cannot be named,
 *   - the landing check: one `gbrain list` per source per run for presence,
 *     and `gbrain get --json` (bounded per run) for the
 *     `gstack_content_sha256` frontmatter field gstack writes,
 *   - `--reconcile`: a bounded, resumable re-check of stamped entries,
 *   - the single writer lock and fail-loud state saves.
 *
 * Capability facts (gbrain is installed at latest HEAD, floor 0.20.0):
 * `import --json` reports `failures`/`unchanged`/`malformed_skipped` from
 * 0.48.5.0 and `source_id` from 0.50.1.0; `list`/`get` honor `--source-id`
 * from 0.46.25. Capability is detected by behavior, never by version string.
 * A lookup error or a busy PGLite means "not yet checked", never "absent".
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { dirname } from "path";

// ── State schema ───────────────────────────────────────────────────────────

export const STATE_SCHEMA_VERSION = 2;
/** Source recorded for entries stamped before per-source imports existed. */
export const LEGACY_SOURCE_ID = "default";
export const DEFAULT_GET_CAP = 50;
export const DEFAULT_RECONCILE_LIMIT = 200;
export const BISECT_AFTER_REFUSALS = 3;
export const LIST_LIMIT = 1_000_000;

export type EntryStatus =
  | "staged" // remote-http: written to the publishable staging dir; the brain admin indexes it
  | "imported_unverified" // import reported it landed; presence/content not yet confirmed
  | "ingested" // landing check confirmed it in its recorded source
  | "refused" // stamped earlier, then found absent or different in the brain; re-queued for the next run
  | "quarantined" // isolated as the page that poisons its batch; retried only when the source changes
  | "unrecoverable"; // absent from the brain and its source file is gone

export interface StateEntry {
  mtime_ns: number;
  sha256: string;
  page_slug: string;
  partial?: boolean;
  status: EntryStatus;
  /** gbrain source the page was imported into ("default" for pre-source entries). */
  source_id: string;
  /** Value of the gstack_content_sha256 frontmatter field written into the page. */
  content_sha256?: string;
  /** When the page was last imported (or staged). */
  ingested_at?: string;
  verified_at?: string;
  reason?: string;
}

export interface IngestState {
  schema_version: typeof STATE_SCHEMA_VERSION;
  last_writer: string;
  last_full_walk?: string;
  reconcile?: { pending?: boolean; cursor?: string | null; unchecked_in_sweep?: number };
  /**
   * Whole-batch refusals per source path (the bisect trigger). A page that did
   * not land is never stamped, so the count lives outside `sessions`.
   */
  batch_refusals?: Record<string, number>;
  /** Transcript sources registered by gstack (A4), cached so registration runs once. */
  sources?: Record<string, { repo: string; registered_at: string }>;
  sessions: Record<string, StateEntry>;
}

/**
 * Allowed transitions. "new" is the absence of an entry. Every write goes
 * through setEntry(), which rejects anything not listed here.
 */
export const TRANSITIONS: Record<EntryStatus | "new", readonly EntryStatus[]> = {
  new: ["staged", "imported_unverified", "ingested", "refused", "quarantined"],
  staged: ["staged", "imported_unverified", "ingested", "refused", "quarantined"],
  imported_unverified: ["imported_unverified", "ingested", "refused", "quarantined", "unrecoverable", "staged"],
  ingested: ["ingested", "imported_unverified", "refused", "quarantined", "unrecoverable", "staged"],
  refused: ["staged", "imported_unverified", "ingested", "refused", "quarantined"],
  quarantined: ["staged", "imported_unverified", "ingested", "refused", "quarantined"],
  unrecoverable: ["staged", "imported_unverified", "ingested", "refused", "unrecoverable"],
};

export function setEntry(state: IngestState, path: string, next: StateEntry): void {
  const from: EntryStatus | "new" = state.sessions[path]?.status ?? "new";
  if (!TRANSITIONS[from].includes(next.status)) {
    throw new Error(`ingest state: illegal transition ${from} -> ${next.status} for ${path}`);
  }
  state.sessions[path] = next;
}

/** Entries whose page is not considered landed are re-prepared every run. */
export function isRetryable(entry: StateEntry | undefined): boolean {
  return !entry || entry.status === "refused";
}

export function emptyState(): IngestState {
  return { schema_version: STATE_SCHEMA_VERSION, last_writer: "gstack-memory-ingest", sessions: {} };
}

/**
 * Migrate a parsed state file. Schema 1 entries were stamped without any
 * landing check and without a source, so they become `ingested` in the
 * legacy `default` source and a reconcile pass is marked pending.
 */
export function migrateState(raw: unknown): { state: IngestState; migrated: boolean } | null {
  const r = raw as { schema_version?: unknown; sessions?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.sessions !== "object" || r.sessions === null) return null;
  if (r.schema_version === STATE_SCHEMA_VERSION) return { state: r as IngestState, migrated: false };
  if (r.schema_version !== 1) return null;
  const v1 = r as { last_writer?: string; last_full_walk?: string; sessions: Record<string, Record<string, unknown>> };
  const state: IngestState = {
    ...emptyState(),
    last_full_walk: v1.last_full_walk,
    reconcile: { pending: true, cursor: null, unchecked_in_sweep: 0 },
  };
  for (const [path, e] of Object.entries(v1.sessions)) {
    if (!e || typeof e !== "object") continue;
    state.sessions[path] = {
      mtime_ns: Number(e.mtime_ns) || 0,
      sha256: String(e.sha256 ?? ""),
      page_slug: String(e.page_slug ?? ""),
      ...(e.partial ? { partial: true } : {}),
      status: "ingested",
      source_id: LEGACY_SOURCE_ID,
      ...(typeof e.ingested_at === "string" ? { ingested_at: e.ingested_at } : {}),
    };
  }
  return { state, migrated: true };
}

export type LoadedState =
  | { kind: "ok"; state: IngestState; migrated: boolean }
  | { kind: "absent"; state: IngestState }
  | { kind: "unreadable"; state: IngestState; backup: string | null; reason: string };

/** Load the state file. An unreadable or unknown file is backed up, never silently reused. */
export function loadStateFile(path: string): LoadedState {
  if (!existsSync(path)) return { kind: "absent", state: emptyState() };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "unreadable", state: emptyState(), backup: null, reason: (err as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", state: emptyState(), backup: backupStateFile(path, `${path}.bak`), reason: "corrupt JSON" };
  }
  const migrated = migrateState(parsed);
  if (!migrated) {
    const v = (parsed as { schema_version?: unknown } | null)?.schema_version;
    return { kind: "unreadable", state: emptyState(), backup: backupStateFile(path, `${path}.bak`), reason: `unknown schema_version ${String(v)}` };
  }
  return { kind: "ok", ...migrated };
}

/** Atomic save. Throws on failure: a run whose state could not be saved has failed. */
export function saveStateFile(path: string, state: IngestState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw new Error(`could not save ingest state ${path}: ${(err as Error).message}`);
  }
}

export function backupStateFile(path: string, dest: string): string | null {
  if (!existsSync(path)) return null;
  try {
    copyFileSync(path, dest);
    return dest;
  } catch {
    return null;
  }
}

// ── Single writer lock ─────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One lock for every state writer (ingest, reconcile, the reconcile-pending
 * flag). A lock left by a dead process is taken over.
 */
export function acquireStateLock(lockPath: string): { ok: true; release: () => void } | { ok: false; holder: number } {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return {
        ok: true,
        release: () => {
          try {
            if (readFileSync(lockPath, "utf-8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
          } catch {}
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (pidAlive(holder) && holder !== process.pid) return { ok: false, holder };
      rmSync(lockPath, { force: true });
    }
  }
  return { ok: false, holder: -1 };
}

// ── gbrain import result ───────────────────────────────────────────────────

export interface ImportReport {
  status?: string;
  imported?: number;
  skipped?: number;
  errors?: number;
  unchanged?: number;
  malformed_skipped?: number;
  failures?: Array<{ path?: unknown; error?: unknown }>;
  source_id?: string;
  total_files?: number;
}

/** The `--json` summary object on the last JSON line, or null when absent. */
export function parseImportReport(stdout: string): ImportReport | null {
  const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "imported" in parsed) return parsed as ImportReport;
    } catch {}
  }
  return null;
}

/**
 * Per-file failures gbrain prints on stderr: `  Skipped <rel>: <err>` for a
 * failure importFile returns (printed every time), `  Warning: skipped <rel>:
 * <err>` for a thrown one (only the first 5 per error class), and
 * `  Skipped (malformed filename — rename to import): <rel>`.
 */
export function parseStderrFailures(stderr: string): Array<{ path: string; error: string; thrown: boolean }> {
  const out: Array<{ path: string; error: string; thrown: boolean }> = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m = line.match(/^\s+Warning: skipped (\S+): (.*)$/);
    if (m) { out.push({ path: m[1], error: m[2], thrown: true }); continue; }
    m = line.match(/^\s+Skipped \(malformed filename[^)]*\): (.*)$/);
    if (m) { out.push({ path: m[1].trim(), error: "malformed filename", thrown: false }); continue; }
    m = line.match(/^\s+Skipped (\S+): (.*)$/);
    if (m) out.push({ path: m[1], error: m[2], thrown: false });
  }
  return out;
}

export interface BatchVerdict {
  /** Staged rel path → gbrain's error, for every failure gbrain named. */
  named: Map<string, string>;
  /** Set when a failure cannot be attributed to a page: the whole batch is refused. */
  refuseAll?: string;
}

/**
 * Decide which staged pages failed. Named failures come from `--json`
 * `failures`, stderr and the sync-failures ledger. Any failure that cannot
 * be named (gbrain stops printing thrown failures after 5 per class, or a
 * staged page was never collected) refuses the whole batch.
 */
export function classifyImport(
  report: ImportReport,
  stderr: string,
  ledgerPaths: Iterable<string>,
  staged: ReadonlySet<string>,
  /** Files gbrain should account for when it differs from the mapped pages (a resumed stage). */
  stagedTotal: number = staged.size,
): BatchVerdict {
  const named = new Map<string, string>();
  const unmapped: string[] = [];
  const note = (path: string, error: string) => {
    if (staged.has(path)) {
      if (!named.has(path)) named.set(path, error);
    } else if (!unmapped.includes(path)) unmapped.push(path);
  };
  const jsonFailures = Array.isArray(report.failures) ? report.failures : null;
  for (const f of jsonFailures ?? []) {
    if (typeof f?.path === "string") note(f.path, String(f.error ?? "unknown error"));
  }
  const stderrFailures = parseStderrFailures(stderr);
  for (const f of stderrFailures) note(f.path, f.error);
  // The ledger is shared by every gbrain process, so only entries naming a
  // page of this batch count; it is complete for the run when present.
  let ledgerCount = 0;
  for (const p of ledgerPaths) {
    if (!staged.has(p)) continue;
    ledgerCount++;
    if (!named.has(p)) named.set(p, "recorded in ~/.gbrain/sync-failures.jsonl");
  }

  const errors = report.errors ?? 0;
  // With `failures` (gbrain >= 0.48.5.0) every error is listed there; before
  // that, `errors` counted thrown failures, named by "Warning: skipped" lines
  // (the first 5 per class) or by the ledger for git import dirs.
  const namedErrors = jsonFailures
    ? jsonFailures.length
    : Math.max(stderrFailures.filter((f) => f.thrown).length, ledgerCount);
  const hidden = Math.max(0, errors - namedErrors);
  const accounted = (report.imported ?? 0) + (report.skipped ?? 0);
  const expected = stagedTotal - named.size;
  let refuseAll: string | undefined;
  if (accounted < expected) {
    refuseAll =
      `gbrain import accounted for ${accounted} of ${expected} staged page(s) ` +
      `(imported=${report.imported ?? 0}, skipped=${report.skipped ?? 0})` +
      (report.total_files !== undefined ? `; gbrain collected ${report.total_files} file(s)` : "");
  } else if (hidden > 0 || unmapped.length > 0) {
    refuseAll =
      `gbrain reported ${hidden + unmapped.length} failure(s) it did not attribute to a staged page` +
      (unmapped.length > 0 ? ` (${unmapped.slice(0, 5).join(", ")})` : "");
  }
  return { named, ...(refuseAll ? { refuseAll } : {}) };
}

// ── Landing check ──────────────────────────────────────────────────────────

export type GbrainRun = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** The slug gbrain stores for a staged path (gbrain core/sync.ts slugifyPath). */
export function gbrainSlug(slug: string): string {
  return slug
    .replace(/\.mdx?$/i, "")
    .split("/")
    .map((seg) =>
      seg
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .normalize("NFC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}.\s_-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean)
    .join("/");
}

export interface LandingLookups {
  /** Presence per source: slug set, or null when the lookup failed (not yet checked). */
  list(sourceId: string): Set<string> | null;
  /** The page's gstack_content_sha256, null when absent from the page, undefined when the lookup failed. */
  contentSha(sourceId: string, slug: string): string | null | undefined;
}

/**
 * gbrain-backed lookups with a per-run list cache. `list --source-id` is
 * probed once with an id that cannot exist: a gbrain that ignores the flag
 * answers it, and its unscoped listing cannot prove absence from a source.
 */
export function gbrainLookups(run: GbrainRun): LandingLookups {
  const cache = new Map<string, Set<string> | null>();
  let scoped: boolean | null = null;
  return {
    list(sourceId) {
      if (cache.has(sourceId)) return cache.get(sourceId)!;
      if (scoped === null) scoped = run(["list", "--source-id", "gstack-capability-probe-0", "--limit", "1"]).status !== 0;
      let slugs: Set<string> | null = null;
      if (scoped) {
        const r = run(["list", "--source-id", sourceId, "--limit", String(LIST_LIMIT), "--sort", "slug"]);
        if (r.status === 0 && !r.stdout.trimStart().startsWith("{")) {
          slugs = new Set();
          for (const line of r.stdout.split("\n")) {
            const slug = line.split("\t")[0]?.trim();
            if (slug && line.includes("\t")) slugs.add(slug);
          }
        }
      }
      cache.set(sourceId, slugs);
      return slugs;
    },
    contentSha(sourceId, slug) {
      const r = run(["get", slug, "--source-id", sourceId, "--json"]);
      if (r.status !== 0) return undefined;
      try {
        const page = JSON.parse(r.stdout) as { slug?: string; frontmatter?: Record<string, unknown> };
        if (!page || typeof page !== "object" || typeof page.slug !== "string") return undefined;
        const v = page.frontmatter?.gstack_content_sha256;
        return typeof v === "string" ? v : null;
      } catch {
        return undefined;
      }
    },
  };
}

export type LandingOutcome = "ingested" | "absent" | "mismatch" | "unchecked";

/**
 * Check one entry against its recorded source. Presence comes from the
 * source's list; content is checked with `get` while `budget.gets` lasts.
 * Entries without a content hash (stamped before this release) are
 * confirmed by presence alone.
 */
export function checkLanding(entry: StateEntry, lookups: LandingLookups, budget: { gets: number }): LandingOutcome {
  const slugs = lookups.list(entry.source_id);
  if (!slugs) return "unchecked";
  const slug = gbrainSlug(entry.page_slug);
  if (!slugs.has(slug)) return "absent";
  if (!entry.content_sha256) return "ingested";
  if (budget.gets <= 0) return "unchecked";
  budget.gets--;
  const sha = lookups.contentSha(entry.source_id, slug);
  if (sha === undefined) return "unchecked";
  return sha === entry.content_sha256 ? "ingested" : "mismatch";
}

// ── Reconcile ──────────────────────────────────────────────────────────────

export interface ReconcileSummary {
  checked: number;
  present: number;
  requeued: number;
  notChecked: number;
  unrecoverable: number;
  /** True when this pass finished a full sweep with nothing left unchecked. */
  complete: boolean;
}

/**
 * Re-check up to `limit` stamped entries (resuming after the stored cursor)
 * against their recorded source. A page missing from its source is
 * re-queued when its transcript still exists, otherwise counted
 * unrecoverable; pages are never moved between sources. A dry run computes
 * the same summary without changing state.
 */
export function reconcile(
  state: IngestState,
  lookups: LandingLookups,
  opts: { limit: number; dryRun: boolean; fileExists: (path: string) => boolean; getCap?: number },
): ReconcileSummary {
  const rec = state.reconcile ?? {};
  const cursor = rec.cursor ?? null;
  const eligible = Object.keys(state.sessions)
    .filter((p) => ["ingested", "imported_unverified"].includes(state.sessions[p].status))
    .sort();
  const pending = eligible.filter((p) => cursor === null || p > cursor);
  const batch = pending.slice(0, opts.limit);
  const budget = { gets: opts.getCap ?? DEFAULT_GET_CAP };
  const s: ReconcileSummary = { checked: 0, present: 0, requeued: 0, notChecked: 0, unrecoverable: 0, complete: false };
  const now = new Date().toISOString();
  for (const path of batch) {
    const entry = state.sessions[path];
    const outcome = checkLanding(entry, lookups, budget);
    if (outcome === "unchecked") {
      s.notChecked++;
      continue;
    }
    s.checked++;
    if (outcome === "ingested") {
      s.present++;
      if (!opts.dryRun && entry.status !== "ingested") setEntry(state, path, { ...entry, status: "ingested", verified_at: now });
      continue;
    }
    const exists = opts.fileExists(path);
    if (exists) s.requeued++;
    else s.unrecoverable++;
    if (opts.dryRun) continue;
    setEntry(state, path, exists
      ? { ...entry, status: "refused", reason: outcome === "absent" ? `absent from source ${entry.source_id} (reconcile)` : "content differs from the staged page (reconcile)" }
      : { ...entry, status: "unrecoverable", reason: `absent from source ${entry.source_id} and the source file is gone` });
  }
  const sweepDone = batch.length === pending.length;
  const unchecked = (rec.unchecked_in_sweep ?? 0) + s.notChecked;
  s.complete = sweepDone && unchecked === 0;
  if (!opts.dryRun) {
    state.reconcile = sweepDone
      ? { pending: !s.complete, cursor: null, unchecked_in_sweep: 0 }
      : { pending: true, cursor: batch[batch.length - 1] ?? cursor, unchecked_in_sweep: unchecked };
  }
  return s;
}

export function formatReconcileSummary(s: ReconcileSummary, dryRun: boolean): string {
  return (
    `reconcile${dryRun ? " (dry run)" : ""}: checked ${s.checked}, present ${s.present}, ` +
    `re-queued ${s.requeued}, not yet checked ${s.notChecked}` +
    (s.unrecoverable > 0 ? `, unrecoverable ${s.unrecoverable} (source file gone)` : "") +
    (s.complete ? "" : " (run again to continue)")
  );
}
