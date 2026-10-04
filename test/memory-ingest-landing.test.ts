/**
 * A1 (#2778): memory ingest stamps a page only after confirming it landed.
 *
 * Unit tests drive lib/memory-ingest-landing.ts directly; CLI tests run
 * bin/gstack-memory-ingest.ts against a fake gbrain that keeps a JSON brain
 * and speaks gbrain HEAD's import/list/get shapes (test/helpers/fake-gbrain-brain.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import {
  acquireStateLock,
  checkLanding,
  classifyImport,
  formatReconcileSummary,
  gbrainLookups,
  migrateState,
  reconcile,
  saveStateFile,
  setEntry,
  emptyState,
  type IngestState,
  type LandingLookups,
  type StateEntry,
} from "../lib/memory-ingest-landing";
import { installFakeBrain } from "./helpers/fake-gbrain-brain";
import { expectMentions } from './helpers/prompt-structure';

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

const entry = (over: Partial<StateEntry> = {}): StateEntry => ({
  mtime_ns: 1, sha256: "s", page_slug: "ceo-plans/demo/2026-10-03-a", status: "ingested", source_id: "default", ...over,
});

function lookupsFrom(pages: Record<string, Record<string, string | null>> | null, opts: { busyGet?: boolean } = {}): LandingLookups & { gets: number } {
  const l = {
    gets: 0,
    list: (source: string) => (pages ? new Set(Object.keys(pages[source] ?? {})) : null),
    contentSha: (source: string, slug: string) => {
      l.gets++;
      if (opts.busyGet) return undefined;
      const v = pages?.[source]?.[slug];
      return v === undefined ? undefined : v;
    },
  };
  return l;
}

describe("landing state (unit)", () => {
  it("migrates a schema-1 file: entries become ingested in the legacy default source, reconcile pending", () => {
    const m = migrateState({ schema_version: 1, last_writer: "x", sessions: { "/a.jsonl": { mtime_ns: 5, sha256: "h", ingested_at: "t", page_slug: "p" } } });
    expect(m?.migrated).toBe(true);
    expect(m?.state.schema_version).toBe(2);
    expect(m?.state.sessions["/a.jsonl"]).toMatchObject({ status: "ingested", source_id: "default", page_slug: "p", ingested_at: "t" });
    expect(m?.state.reconcile?.pending).toBe(true);
    expect(migrateState({ schema_version: 999, sessions: {} })).toBeNull();
  });

  it("rejects transitions outside the table", () => {
    const state = emptyState();
    setEntry(state, "/a", entry({ status: "ingested" }));
    setEntry(state, "/a", entry({ status: "unrecoverable" }));
    expect(() => setEntry(state, "/a", entry({ status: "quarantined" }))).toThrow(/illegal transition unrecoverable -> quarantined/);
  });

  it("names HEAD --json failures and treats Pending receipts as counted, not failed", () => {
    const staged = new Set(["a.md", "b.md", "c.md"]);
    const v = classifyImport(
      { imported: 1, skipped: 2, errors: 1, unchanged: 1, failures: [{ path: "b.md", error: "Invalid YAML" }], source_id: "default" },
      "  Skipped b.md: Invalid YAML\n  Pending: c.md was accepted and is still publishing; rerun to confirm it.\n",
      [],
      staged,
    );
    expect([...v.named]).toEqual([["b.md", "Invalid YAML"]]);
    expect(v.refuseAll).toBeUndefined();
  });

  it("reads pre-0.48 stderr failures and refuses the batch when a thrown failure is unnamed", () => {
    const staged = new Set(["a.md", "b.md"]);
    const named = classifyImport({ imported: 1, skipped: 1, errors: 0 }, "  Skipped b.md: too large\n", [], staged);
    expect([...named.named.keys()]).toEqual(["b.md"]);
    expect(named.refuseAll).toBeUndefined();
    const hidden = classifyImport({ imported: 1, skipped: 1, errors: 1 }, "", [], staged);
    expectMentions(hidden.refuseAll, [['not', 'attribute', 'failure']], 'hidden.refuseAll');
    const short = classifyImport({ imported: 0, skipped: 0, errors: 0, total_files: 0 }, "", [], staged);
  });

  it("checks presence per recorded source and content within the get budget", () => {
    const l = lookupsFrom({ default: { "ceo-plans/demo/2026-10-03-a": "abc" } });
    const budget = { gets: 1 };
    expect(checkLanding(entry({ content_sha256: "abc", status: "imported_unverified" }), l, budget)).toBe("ingested");
    expect(checkLanding(entry({ content_sha256: "abc", status: "imported_unverified" }), l, budget)).toBe("unchecked");
    expect(checkLanding(entry({ content_sha256: "zzz" }), l, { gets: 1 })).toBe("mismatch");
    expect(checkLanding(entry({ source_id: "gstack-tx-x" }), l, { gets: 1 })).toBe("absent");
    expect(checkLanding(entry(), lookupsFrom(null), { gets: 1 })).toBe("unchecked");
    expect(checkLanding(entry({ content_sha256: "abc" }), lookupsFrom({ default: { "ceo-plans/demo/2026-10-03-a": "abc" } }, { busyGet: true }), { gets: 1 })).toBe("unchecked");
  });

  it("treats pglite_busy and a list that ignores --source-id as not yet checked", () => {
    const busy = gbrainLookups(() => ({ status: 1, stdout: '{"error":"pglite_busy"}', stderr: "" }));
    expect(busy.list("default")).toBeNull();
    const unscoped = gbrainLookups(() => ({ status: 0, stdout: "a\ttranscript\t2026-10-03\ta\n", stderr: "" }));
    expect(unscoped.list("default")).toBeNull();
    const calls: string[][] = [];
    const scoped = gbrainLookups((a) => {
      calls.push(a);
      return a.includes("gstack-capability-probe-0") ? { status: 1, stdout: "", stderr: "Source not found" } : { status: 0, stdout: "x/y\ttranscript\t2026-10-03\tt\n", stderr: "" };
    });
    expect([...scoped.list("default")!]).toEqual(["x/y"]);
    scoped.list("default");
    expect(calls).toHaveLength(2);
  });
});

describe("reconcile (unit)", () => {
  function state(): IngestState {
    const s = emptyState();
    for (const name of ["a", "b", "c", "d"]) s.sessions[`/t/${name}.jsonl`] = entry({ page_slug: `transcripts/x/${name}` });
    return s;
  }
  const brain = { default: { "transcripts/x/a": null, "transcripts/x/b": null } };

  it("finds legacy default-source entries present and re-queues only missing pages whose file still exists", () => {
    const s = state();
    const sum = reconcile(s, lookupsFrom(brain), { limit: 10, dryRun: false, fileExists: (p) => p !== "/t/d.jsonl" });
    expect(sum).toMatchObject({ checked: 4, present: 2, requeued: 1, unrecoverable: 1, notChecked: 0, complete: true });
    expect(s.sessions["/t/c.jsonl"].status).toBe("refused");
    expect(s.sessions["/t/d.jsonl"].status).toBe("unrecoverable");
    expect(s.reconcile?.pending).toBe(false);
    expect(formatReconcileSummary(sum, false)).toBe("reconcile: checked 4, present 2, re-queued 1, not yet checked 0, unrecoverable 1 (source file gone)");
  });

  it("--dry-run changes nothing; --limit bounds the pass and the next pass resumes; a third pass is a no-op", () => {
    const s = state();
    const before = JSON.stringify(s);
    reconcile(s, lookupsFrom(brain), { limit: 10, dryRun: true, fileExists: () => true });
    expect(JSON.stringify(s)).toBe(before);
    const first = reconcile(s, lookupsFrom(brain), { limit: 2, dryRun: false, fileExists: () => true });
    expect(first).toMatchObject({ checked: 2, complete: false });
    expect(formatReconcileSummary(first, false)).toMatch(/\(run again to continue\)$/);
    const second = reconcile(s, lookupsFrom(brain), { limit: 2, dryRun: false, fileExists: () => true });
    expect(second).toMatchObject({ checked: 2, present: 0, requeued: 2, complete: true });
    const third = reconcile(s, lookupsFrom(brain), { limit: 2, dryRun: false, fileExists: () => true });
    expect(third).toMatchObject({ checked: 2, present: 2, requeued: 0 });
  });

  it("a failed lookup is not yet checked, never absent, and keeps the reconcile pending", () => {
    const s = state();
    const sum = reconcile(s, lookupsFrom(null), { limit: 10, dryRun: false, fileExists: () => true });
    expect(sum).toMatchObject({ checked: 0, notChecked: 4, requeued: 0, complete: false });
    expect(Object.values(s.sessions).every((e) => e.status === "ingested")).toBe(true);
    expect(s.reconcile?.pending).toBe(true);
  });
});

describe("state writers (unit)", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gstack-landing-lock-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("one lock: a live holder blocks, a dead holder's lock is taken over", async () => {
    const lockPath = join(dir, "state.json.lock");
    const sleeper = spawn("sleep", ["30"]);
    try {
      writeFileSync(lockPath, `${sleeper.pid}\n`);
      expect(acquireStateLock(lockPath)).toEqual({ ok: false, holder: sleeper.pid! });
    } finally {
      sleeper.kill("SIGKILL");
    }
    await new Promise((r) => sleeper.on("exit", r));
    const lock = acquireStateLock(lockPath);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a state save failure throws instead of being swallowed", () => {
    const target = join(dir, "state.json");
    mkdirSync(target);
    expect(() => saveStateFile(target, emptyState())).toThrow(/could not save ingest state/);
  });
});

// ── CLI against the fake brain ─────────────────────────────────────────────

describe("gstack-memory-ingest landing check (CLI, fake gbrain)", () => {
  let home = "";
  let gstackHome = "";
  let env: Record<string, string> = {};
  let brain: ReturnType<typeof installFakeBrain>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-landing-"));
    gstackHome = join(home, ".gstack");
    mkdirSync(join(gstackHome, "projects", "demo", "ceo-plans"), { recursive: true });
    brain = installFakeBrain(home);
    env = { HOME: home, GSTACK_HOME: gstackHome, PATH: `${brain.binDir}:/usr/bin:/bin`, TMPDIR: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function plans(...names: string[]): string[] {
    return names.map((n) => {
      const p = join(gstackHome, "projects", "demo", "ceo-plans", `${n}.md`);
      writeFileSync(p, `# Plan ${n}\n\nbody of ${n}\n`);
      return p;
    });
  }
  function run(args: string[] = [], extra: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [SCRIPT, "--sources", "ceo-plan", ...args], {
      env: { ...env, ...extra }, cwd: home, encoding: "utf-8", timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  const statePath = () => join(gstackHome, ".transcript-ingest-state.json");
  const sessions = (): Record<string, StateEntry> => existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")).sessions : {};
  const calls = (): string[][] => existsSync(brain.callLog) ? readFileSync(brain.callLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

  it("stamps verified pages ingested with their recorded source and content hash", () => {
    const [a] = plans("alpha");
    const r = run(["--bulk", "--quiet"]);
    expect(r.status).toBe(0);
    expect(sessions()[a]).toMatchObject({ status: "ingested", source_id: "default" });
    expect(sessions()[a].content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls().some((c) => c[0] === "get" && c.includes("--json"))).toBe(true);
  });

  it("a page gbrain names as failed (exit 1, HEAD failures[]) is left un-stamped and printed under --quiet", () => {
    const [a, b] = plans("alpha", "broken");
    const r = run(["--bulk", "--quiet"], { FAKE_FAIL: "broken" });
    expect(r.stderr).toMatch(/\[memory-ingest\] FAILED ceo-plans\/demo\/\S+broken\.md: Invalid YAML frontmatter/);
    expect(sessions()[a]?.status).toBe("ingested");
    expect(sessions()[b]).toBeUndefined();
    expect(r.status).toBe(0);
  });

  it("pre-0.48 gbrain: a page skipped with exit 0 and only a stderr 'Skipped' line is never stamped (#2778 field case)", () => {
    const [a, b] = plans("alpha", "broken");
    const r = run(["--bulk", "--quiet"], { FAKE_FAIL: "broken", FAKE_OLD_JSON: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/FAILED ceo-plans\/demo\/\S+broken\.md/);
    expect(sessions()[b]).toBeUndefined();
    expect(sessions()[a].source_id).toBe("default");
  });

  it("a Pending receipt (counted unchanged, never stored) is re-queued after the landing check, not stamped ingested", () => {
    const [a, p] = plans("alpha", "pending");
    const r = run(["--bulk", "--quiet"], { FAKE_PENDING: "pending" });
    expect(r.stderr).toMatch(/re-queued ceo-plans\/demo\/\S+pending: not found in gbrain source default after import/);
    expect(sessions()[a].status).toBe("ingested");
    expect(sessions()[p].status).toBe("refused");
    const again = run(["--incremental", "--quiet"]);
    expect(again.status).toBe(0);
    expect(sessions()[p].status).toBe("ingested");
  });

  it("without a usable lookup (list ignores --source-id, or PGLite busy) pages stay imported_unverified and are not re-imported", () => {
    const [a] = plans("alpha");
    expect(run(["--bulk", "--quiet"], { FAKE_LIST_UNSCOPED: "1" }).status).toBe(0);
    expect(sessions()[a].status).toBe("imported_unverified");
    const imports = () => calls().filter((c) => c[0] === "import").length;
    const before = imports();
    expect(run(["--incremental", "--quiet"], { FAKE_BUSY: "1" }).status).toBe(0);
    expect(imports()).toBe(before);
    expect(sessions()[a].status).toBe("imported_unverified");
    expect(run(["--incremental", "--quiet"]).status).toBe(0);
    expect(sessions()[a].status).toBe("ingested");
  });

  it("an unnamed failure refuses the batch; after 3 refusals the batch is bisected and the poison page quarantined", () => {
    const pages = plans("p1", "p2", "poison", "p4");
    for (let i = 1; i <= 2; i++) {
      const r = run(["--bulk", "--quiet"], { FAKE_POISON: "poison" });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/did not attribute to a staged page/);
      expect(Object.keys(sessions())).toHaveLength(0);
    }
    const r = run(["--bulk", "--quiet"], { FAKE_POISON: "poison" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/quarantined ceo-plans\/demo\/\S+poison .*gbrain refuses every batch that contains it/);
    const s = sessions();
    expect(s[pages[2]].status).toBe("quarantined");
    for (const p of [pages[0], pages[1], pages[3]]) expect(s[p].status).toBe("ingested");
    const next = run(["--bulk", "--quiet"], { FAKE_POISON: "poison" });
    expect(next.status).toBe(0);
    expect(sessions()[pages[2]].status).toBe("quarantined");
  });

  it("remote-http mode records pages as staged, never ingested", () => {
    const [a] = plans("alpha");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "http://fixture.invalid/mcp" } } }));
    expect(run(["--bulk", "--quiet"]).status).toBe(0);
    expect(sessions()[a]).toMatchObject({ status: "staged" });
    expect(calls().filter((c) => c[0] === "import")).toHaveLength(0);
  });

  it("--reconcile re-queues a stamped page missing from its recorded source, backs up state, and supports --dry-run and --limit", () => {
    const [a, b] = plans("alpha", "beta");
    writeFileSync(statePath(), JSON.stringify({
      schema_version: 1, last_writer: "gstack-memory-ingest",
      sessions: Object.fromEntries([a, b].map((p) => [p, { mtime_ns: 1, sha256: "old", ingested_at: "2026-09-01T00:00:00Z", page_slug: `ceo-plans/demo/${p.endsWith("alpha.md") ? "x-alpha" : "x-beta"}` }])),
    }));
    writeFileSync(brain.brainFile, JSON.stringify({ sources: { default: { federated: true } }, pages: { default: { "ceo-plans/demo/x-alpha": { sha: null } } } }));
    const dry = run(["--reconcile", "--dry-run"]);
    expect(dry.stderr).toContain("reconcile (dry run): checked 2, present 1, re-queued 1, not yet checked 0");
    expect(JSON.parse(readFileSync(statePath(), "utf8")).schema_version).toBe(1);
    const limited = run(["--reconcile", "--limit", "1"]);
    expect(limited.stderr).toContain("reconcile: checked 1, present 1, re-queued 0, not yet checked 0 (run again to continue)");
    expect(existsSync(`${statePath()}.pre-reconcile.bak`)).toBe(true);
    const rest = run(["--reconcile"]);
    expect(rest.stderr).toContain("reconcile: checked 1, present 0, re-queued 1, not yet checked 0");
    expect(sessions()[b].status).toBe("refused");
    expect(sessions()[a]).toMatchObject({ status: "ingested", source_id: "default" });
  });

  it("--request-reconcile records a pending pass without calling gbrain; the next ingest runs one bounded pass and prints the summary under --quiet", () => {
    const [a] = plans("alpha");
    expect(run(["--bulk", "--quiet"]).status).toBe(0);
    rmSync(brain.callLog, { force: true });
    const req = run(["--request-reconcile", "--quiet"]);
    expect(req.status).toBe(0);
    expect(calls()).toEqual([]);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).reconcile.pending).toBe(true);
    const next = run(["--incremental", "--quiet"]);
    expect(next.stderr).toContain("[memory-ingest] reconcile: checked 1, present 1, re-queued 0, not yet checked 0");
    expect(JSON.parse(readFileSync(statePath(), "utf8")).reconcile.pending).toBe(false);
    expect(sessions()[a].status).toBe("ingested");
  });

  it("a state file that cannot be saved fails the run", () => {
    plans("alpha");
    mkdirSync(statePath());
    const r = run(["--bulk", "--quiet"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not save ingest state/);
  });

  it("a live writer's lock stops a second run before it touches state", () => {
    plans("alpha");
    writeFileSync(`${statePath()}.lock`, `${process.pid}\n`);
    const r = run(["--bulk", "--quiet"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`another memory ingest (pid ${process.pid})`);
    expect(existsSync(statePath())).toBe(false);
    expect(calls().filter((c) => c[0] === "import")).toHaveLength(0);
  });

  it("--help lists --reconcile as a mode", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--help"], { env, encoding: "utf-8", timeout: 20_000 });
    expect(r.stderr).toMatch(/\[--probe\|--incremental\|--bulk\|--reconcile\]/);
    expect(r.stderr).toMatch(/--dry-run/);
    expect(readdirSync(gstackHome).filter((f) => f.startsWith(".staging-ingest-"))).toEqual([]);
  });
});
