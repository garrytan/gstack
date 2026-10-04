/**
 * A4 (#2140): transcripts import into their originating repository's own
 * gbrain source, registered machine-local and non-federated before the first
 * import; transcripts with no repository never reach the default or a
 * federated source, and stay on the machine when the brain is remote.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { installFakeBrain } from "./helpers/fake-gbrain-brain";
import { transcriptSourceId } from "../bin/gstack-memory-ingest";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

describe("memory ingest: per-repository transcript sources (A4)", () => {
  let home = "";
  let gstackHome = "";
  let env: Record<string, string> = {};
  let brain: ReturnType<typeof installFakeBrain>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-tx-sources-"));
    gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    brain = installFakeBrain(home);
    env = {
      HOME: home, GSTACK_HOME: gstackHome, PATH: `${brain.binDir}:/usr/bin:/bin`, TMPDIR: home,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function repo(name: string): string {
    const dir = join(home, "repos", name);
    mkdirSync(dir, { recursive: true });
    for (const args of [["init", "-q", dir], ["-C", dir, "remote", "add", "origin", `https://github.com/acme/${name}.git`]]) {
      expect(spawnSync("git", args, { env, timeout: 10_000 }).status).toBe(0);
    }
    return dir;
  }
  function session(id: string, cwd: string): string {
    const dir = join(home, ".claude", "projects", "p");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const ts = new Date().toISOString();
    writeFileSync(path,
      JSON.stringify({ type: "user", message: { role: "user", content: `hello from ${id}` }, timestamp: ts, cwd }) + "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: ts }) + "\n");
    return path;
  }
  function run(args: string[]) {
    const r = spawnSync(process.execPath, [SCRIPT, "--sources", "transcript", ...args], { env, cwd: home, encoding: "utf-8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  const sessions = () => JSON.parse(readFileSync(join(gstackHome, ".transcript-ingest-state.json"), "utf8")).sessions;
  const calls = (): string[][] => existsSync(brain.callLog) ? readFileSync(brain.callLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const fakeBrain = () => JSON.parse(readFileSync(brain.brainFile, "utf8"));

  it("a bulk run across three repositories registers three non-federated sources and imports each one sequentially", () => {
    const paths = ["alpha", "beta", "gamma"].map((n) => session(`${n}00000000001`, repo(n)));
    const r = run(["--bulk", "--quiet"]);
    expect(r.status).toBe(0);
    const ids = ["alpha", "beta", "gamma"].map((n) => transcriptSourceId(`github.com/acme/${n}`));
    expect(new Set(ids).size).toBe(3);
    const log = calls();
    for (const id of ids) {
      const add = log.findIndex((c) => c[0] === "sources" && c[1] === "add" && c[2] === id);
      const imp = log.findIndex((c) => c[0] === "import" && c.includes("--source-id") && c[c.indexOf("--source-id") + 1] === id);
      expect(add).toBeGreaterThan(-1);
      expect(log[add]).toContain("--no-federated");
      expect(imp).toBeGreaterThan(add);
      expect(fakeBrain().sources[id].federated).toBe(false);
    }
    expect(log.filter((c) => c[0] === "import")).toHaveLength(3);
    expect(log.some((c) => c[0] === "import" && !c.includes("--source-id"))).toBe(false);
    const s = sessions();
    paths.forEach((p, i) => expect(s[p]).toMatchObject({ status: "ingested", source_id: ids[i] }));
    expect(Object.keys(fakeBrain().pages.default ?? {})).toEqual([]);
    // Registration is cached: a second run with new pages adds no source.
    session("alpha00000000002", join(home, "repos", "alpha"));
    rmSync(brain.callLog);
    expect(run(["--incremental", "--quiet"]).status).toBe(0);
    expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
  });

  it("--include-unattributed sends repo-less transcripts only to the machine-local unattributed source", () => {
    const loose = session("loose0000001", join(home, "not-a-repo"));
    expect(run(["--bulk", "--quiet"]).status).toBe(0);
    expect(calls().some((c) => c[0] === "import")).toBe(false);
    expect(run(["--bulk", "--quiet", "--include-unattributed"]).status).toBe(0);
    expect(sessions()[loose]).toMatchObject({ status: "ingested", source_id: "gstack-transcripts-unattributed" });
    expect(fakeBrain().sources["gstack-transcripts-unattributed"].federated).toBe(false);
    expect(Object.keys(fakeBrain().pages.default ?? {})).toEqual([]);
  });

  it("refuses unattributed transcripts for a remote (Postgres) brain while attributed ones import", () => {
    mkdirSync(join(home, ".gbrain"), { recursive: true });
    writeFileSync(join(home, ".gbrain", "config.json"), JSON.stringify({ engine: "postgres", database_url: ["postgresql://u", "p@db.example.com/brain"].join(":") }));
    const loose = session("loose0000001", join(home, "not-a-repo"));
    const kept = session("alpha0000001", repo("alpha"));
    const r = run(["--bulk", "--quiet", "--include-unattributed"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("kept 1 unattributed transcript(s) on this machine: the brain is remote");
    expect(sessions()[loose]).toBeUndefined();
    expect(sessions()[kept].status).toBe("ingested");
    expect(fakeBrain().sources["gstack-transcripts-unattributed"]).toBeUndefined();
  });

  it("a transcript stamped before this release keeps its default source when it changes, so no duplicate appears", () => {
    const path = session("legacy000001", repo("alpha"));
    writeFileSync(join(gstackHome, ".transcript-ingest-state.json"), JSON.stringify({
      schema_version: 1, last_writer: "gstack-memory-ingest",
      sessions: { [path]: { mtime_ns: 1, sha256: "old", ingested_at: "2026-09-01T00:00:00Z", page_slug: "transcripts/claude-code/acme-alpha/old" } },
    }));
    expect(run(["--incremental", "--quiet"]).status).toBe(0);
    const imports = calls().filter((c) => c[0] === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]).not.toContain("--source-id");
    expect(sessions()[path]).toMatchObject({ status: "ingested", source_id: "default" });
    expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
  });

  it("when gbrain cannot register sources the partition stays local, unstamped, and the run says why", () => {
    const path = session("alpha0000001", repo("alpha"));
    const r = spawnSync(process.execPath, [SCRIPT, "--sources", "transcript", "--bulk", "--quiet"], {
      env: { ...env, FAKE_NO_SOURCES: "1" }, cwd: home, encoding: "utf-8", timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/kept 1 transcript page\(s\) for github\.com\/acme\/alpha on this machine: could not register gbrain source gstack-transcripts-\S+/);
    expect(calls().some((c) => c[0] === "import")).toBe(false);
    expect(sessions()[path]).toBeUndefined();
  });
});
