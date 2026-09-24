/**
 * Unit tests for bin/gstack-memory-ingest.ts (Lane A).
 *
 * Covers the unit-testable internals: parseTranscriptJsonl (Codex + Claude Code +
 * truncated last line), buildTranscriptPage / buildArtifactPage shape, repoSlug,
 * dateOnly, fileChangedSinceState mtime+sha logic, state file load/save with
 * schema_version backup-on-mismatch.
 *
 * E2E coverage (full --probe / --bulk on real ~/.claude/projects) lives in
 * test/skill-e2e-memory-ingest.test.ts (Lane F).
 *
 * Strategy: we re-import the module under test through bun's runtime and shell
 * out to it for end-to-end mode tests; for the pure helpers, we re-import the
 * source file via dynamic import.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync, chmodSync, readdirSync, symlinkSync, utimesSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

describe("requested secret scanning at the import boundary", () => {
  let home: string;
  let bin: string;
  let env: Record<string, string>;
  const realScanner = process.env.GSTACK_TEST_GITLEAKS;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-scan-"));
    bin = join(home, "bin");
    mkdirSync(bin);
    mkdirSync(join(home, "tmp"));
    env = {
      HOME: home, GSTACK_HOME: join(home, ".gstack"),
      PATH: `${bin}:/usr/bin:/bin`, TMPDIR: join(home, "tmp"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    };
    writeFileSync(join(bin, "gbrain"), `#!${process.execPath}
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync, utimesSync } from 'fs';
import { join, relative } from 'path';
import { spawnSync } from 'child_process';
const args = process.argv.slice(2);
if (process.env.LIMIT_STAGE_WRITES === '1') {
  const reset = spawnSync('/usr/bin/prlimit', ['--pid', String(process.pid), '--fsize=unlimited:unlimited'], { timeout: 10000 });
  if (reset.status !== 0) process.exit(2);
}
if (args[0] === '--help') console.log('  import <dir>');
else if (args[0] === 'doctor') console.log(JSON.stringify({ engine: 'pglite' }));
else if (args[0] === 'import') {
  appendFileSync(join(process.env.HOME, 'imports'), 'import\\n');
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push({ path: relative(args[1], path), body: readFileSync(path, 'utf8') });
    }
  }
  walk(args[1]);
  writeFileSync(join(process.env.HOME, 'imported.json'), JSON.stringify(files));
  if (process.env.SNAPSHOT_STAGE) {
    if (!process.env.SNAPSHOT_STAGE.startsWith(process.env.GSTACK_HOME + '/.staging-ingest-')) process.exit(2);
    cpSync(args[1], process.env.SNAPSHOT_STAGE, { recursive: true });
  }
  if (process.env.APPEND_DURING_IMPORT) {
    const path = realpathSync(process.env.APPEND_DURING_IMPORT);
    if (!path.startsWith(process.env.HOME + '/')) process.exit(2);
    const before = statSync(path);
    appendFileSync(path, process.env.APPEND_RECORD);
    if (process.env.RESTORE_MTIME === '1') utimesSync(path, before.atime, before.mtime);
  }
  if (process.env.REJECT_IMPORT === '1') process.exit(1);
  console.log(JSON.stringify({ status: 'ok', imported: process.env.UNDERCOUNT_IMPORT === '1' ? 0 : files.length, skipped: 0, errors: 0, total_files: files.length }));
}
`, { mode: 0o700 });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function source(text = "ordinary conversation"): string {
    const stamp = new Date().toISOString();
    const dir = join(home, ".codex", "sessions", ...stamp.slice(0, 10).split("-"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-${randomBytes(4).toString("hex")}.jsonl`);
    writeFileSync(path, [
      { type: "session_meta", timestamp: stamp, payload: { id: basename(path), cwd: home } },
      { type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return path;
  }

  function scanner(mode: string): void {
    if (mode === "real") {
      copyFileSync(realScanner!, join(bin, "gitleaks"));
      chmodSync(join(bin, "gitleaks"), 0o700);
      return;
    }
    writeFileSync(join(bin, "gitleaks"), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, statSync, rmSync, realpathSync, utimesSync } from 'fs';
import { dirname, join, relative, isAbsolute } from 'path';
import { spawnSync } from 'child_process';
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('8.30.1'); process.exit(0); }
const input = args[args.indexOf('--source') + 1];
const report = args[args.indexOf('--report-path') + 1];
const mode = ${JSON.stringify(mode)};
const rel = relative(process.env.HOME, report);
if (report !== '/dev/stdout' && (isAbsolute(rel) || rel.startsWith('..'))) process.exit(2);
appendFileSync(join(process.env.HOME, 'scans'), JSON.stringify({ input, report, body: readFileSync(input, 'utf8'), inputMode: statSync(input).mode & 511, dirMode: statSync(dirname(report)).mode & 511, reportMode: statSync(report).mode & 511 }) + '\\n');
if (mode === 'error') process.exit(2);
if (mode === 'timeout') Bun.sleepSync(63000);
if (process.env.APPEND_DURING_SCAN) {
  const path = realpathSync(process.env.APPEND_DURING_SCAN);
  if (!path.startsWith(process.env.HOME + '/')) process.exit(2);
  const before = statSync(path);
  appendFileSync(path, process.env.APPEND_RECORD);
  if (process.env.RESTORE_MTIME === '1') utimesSync(path, before.atime, before.mtime);
}
function emit(text) { if (report === '/dev/stdout') process.stdout.write(text); else writeFileSync(report, text); }
if (mode === 'malformed') emit('{');
else if (mode === 'empty') emit('');
else if (mode === 'null') emit('null');
else if (mode === 'invalid-finding') emit('[{}]');
else if (mode === 'overflow') emit('[]' + ' '.repeat(16 * 1024 * 1024 - 1));
else if (mode === 'ceiling') emit('[]' + ' '.repeat(16 * 1024 * 1024 - 2));
else if (mode === 'missing-report') { if (report === '/dev/stdout') process.exit(2); rmSync(report); }
else {
  const dirty = readFileSync(input, 'utf8').includes('UNSAFE="synthetic"');
  emit(dirty ? JSON.stringify([{ RuleID: 'fixture', Description: 'synthetic marker', StartLine: 1, Secret: 'synthetic' }]) : '[]');
}
if (process.env.LIMIT_STAGE_WRITES === '1') {
  const limit = spawnSync('/usr/bin/prlimit', ['--pid', String(process.ppid), '--fsize=2048:unlimited'], { timeout: 10000 });
  if (limit.status !== 0) process.exit(2);
}
`, { mode: 0o700 });
  }

  function run(args: string[] = [], timeout = 30000) {
    const argv = [SCRIPT, "--include-unattributed", "--sources", "transcript", ...args];
    const limited = env.LIMIT_STAGE_WRITES === "1";
    const r = spawnSync(limited ? "/bin/bash" : process.execPath,
      limited ? ["-c", 'trap "" XFSZ; exec "$@"', "f3-limit", process.execPath, ...argv] : argv, {
      env, cwd: home, encoding: "utf8", timeout,
    });
    expect(r.error).toBeUndefined();
    return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
  }

  function sessions(): Record<string, unknown> {
    const state = join(env.GSTACK_HOME, ".transcript-ingest-state.json");
    return existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).sessions : {};
  }

  function imported(): Array<{ path: string; body: string }> {
    const path = join(home, "imported.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  }

  function resume(body: string, sourcePath?: string): string {
    const dir = join(env.GSTACK_HOME, ".staging-ingest-fixture");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, ".gstack-staging"), "fixture");
    let path = join(dir, "nested", "extra.md");
    if (sourcePath) {
      const meta = JSON.parse(readFileSync(sourcePath, "utf8").split("\n")[0]);
      path = join(dir, "transcripts", "codex", "_unattributed", `${meta.timestamp.slice(0, 10)}-${meta.payload.id.slice(0, 12)}.md`);
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, body);
    env.GSTACK_INGEST_RESUME_DIR = dir;
    return dir;
  }

  function interruptedStage(): string {
    const dir = join(env.GSTACK_HOME, ".staging-ingest-interrupted");
    env.SNAPSHOT_STAGE = dir;
    env.REJECT_IMPORT = "1";
    expect(run(["--scan-secrets"]).status).toBe(1);
    expect(existsSync(dir)).toBe(true);
    expect(sessions()).toEqual({});
    delete env.SNAPSHOT_STAGE;
    delete env.REJECT_IMPORT;
    env.GSTACK_INGEST_RESUME_DIR = dir;
    return dir;
  }

  function appendRecord(): string {
    return JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "late ordinary update" }],
    } }) + "\n";
  }

  describe("snapshot-bound requested scans", () => {
    for (const rejected of [false, true]) {
      it(`accounts only saved pages on interrupted resume (rejected source: ${rejected})`, () => {
        scanner("clean");
        const bad = rejected ? source('UNSAFE="synthetic"') : undefined;
        const clean = source();
        const dir = interruptedStage();
        expect(imported()).toHaveLength(1);
        const result = run(["--scan-secrets"]);
        expect(result.status).toBe(0);
        expect(imported()).toHaveLength(1);
        expect(sessions()[clean]).toBeDefined();
        if (bad) expect(sessions()[bad]).toBeUndefined();
        expect(existsSync(dir)).toBe(false);
        delete env.GSTACK_INGEST_RESUME_DIR;
        rmSync(join(home, "imported.json"));
        const retry = run(["--scan-secrets"]);
        expect(retry.status).toBe(0);
        expect(imported()).toEqual([]);
        if (bad) expect(retry.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
      });
    }

    it("refuses genuine resumed under-accounting without discarding the saved stage", () => {
      scanner("clean");
      const path = source();
      const dir = interruptedStage();
      env.UNDERCOUNT_IMPORT = "1";
      const result = run(["--scan-secrets"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("accounted for 0 of 1 staged page(s)");
      expect(sessions()[path]).toBeUndefined();
      expect(existsSync(dir)).toBe(true);
      delete env.UNDERCOUNT_IMPORT;
      expect(run(["--scan-secrets"]).status).toBe(0);
      expect(sessions()[path]).toBeDefined();
    });

    it("keeps an empty owned stage recoverable and never stamps an unstaged source", () => {
      scanner("clean");
      const path = source();
      const dir = resume("placeholder", path);
      for (const file of readdirSync(dir, { recursive: true })) {
        if (String(file).endsWith(".md")) rmSync(join(dir, String(file)));
      }
      expect(run(["--scan-secrets"]).status).toBe(1);
      expect(sessions()[path]).toBeUndefined();
      expect(imported()).toEqual([]);
      expect(existsSync(dir)).toBe(true);
    });

    it("retains a saved page without importing or stamping a removed source", () => {
      scanner("clean");
      const path = source();
      const dir = interruptedStage();
      rmSync(path);
      rmSync(join(home, "imported.json"));
      expect(run(["--scan-secrets"]).status).toBe(0);
      expect(imported()).toEqual([]);
      expect(sessions()).toEqual({});
      expect(existsSync(dir)).toBe(true);
    });

    it("retains the saved stage when current policy filters every source", () => {
      scanner("clean");
      source();
      const dir = interruptedStage();
      const policy = spawnSync(join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy"), ["set", "_unattributed", "deny"], {
        env, cwd: home, encoding: "utf8", timeout: 10000,
      });
      expect(policy.status).toBe(0);
      rmSync(join(home, "imported.json"));
      expect(run(["--scan-secrets"]).status).toBe(0);
      expect(imported()).toEqual([]);
      expect(sessions()).toEqual({});
      expect(existsSync(dir)).toBe(true);
    });

    for (const resumed of [false, true]) {
      it(`does not stamp an append during ${resumed ? "resumed" : "fresh"} import`, () => {
        scanner("clean");
        const path = source();
        const time = new Date(Math.floor(Date.now() / 1000) * 1000);
        utimesSync(path, time, time);
        const dir = resumed ? interruptedStage() : undefined;
        env.APPEND_DURING_IMPORT = path;
        env.APPEND_RECORD = appendRecord();
        env.RESTORE_MTIME = "1";
        expect(run(["--scan-secrets"]).status).toBe(0);
        expect(statSync(path).mtimeMs).toBe(time.getTime());
        expect(imported().every((page) => !page.body.includes("late ordinary update"))).toBe(true);
        expect(sessions()[path]).toBeUndefined();
        if (dir) expect(existsSync(dir)).toBe(true);
        delete env.APPEND_DURING_IMPORT;
        delete env.GSTACK_INGEST_RESUME_DIR;
        expect(run(["--scan-secrets"]).status).toBe(0);
        expect(imported()[0].body).toContain("late ordinary update");
        expect(sessions()[path]).toMatchObject({
          mtime_ns: time.getTime() * 1e6,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      });
    }

    for (const mode of ["no-write", "remote-http"]) {
      it(`does not stamp an append during the ${mode} scan`, () => {
        scanner("clean");
        const path = source();
        if (mode === "remote-http") writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "http://fixture.invalid/mcp" } } }));
        env.APPEND_DURING_SCAN = path;
        env.APPEND_RECORD = appendRecord();
        const args = mode === "no-write" ? ["--scan-secrets", "--no-write"] : ["--scan-secrets"];
        expect(run(args).status).toBe(0);
        expect(sessions()[path]).toBeUndefined();
        expect(imported()).toEqual([]);
        delete env.APPEND_DURING_SCAN;
        expect(run(args).status).toBe(0);
        expect(sessions()[path]).toBeDefined();
      });
    }

    for (const remote of [false, true]) {
      it(`never stamps a page that failed to stage (remote-http: ${remote})`, () => {
        scanner("clean");
        if (remote) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "http://fixture.invalid/mcp" } } }));
        const dir = join(env.GSTACK_HOME, "projects", "demo", "ceo-plans");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${"p".repeat(245)}.md`);
        writeFileSync(path, "ordinary artifact content");
        const result = run(["--scan-secrets", "--sources", "ceo-plan"]);
        expect(result.stderr).toContain("[stage-error]");
        expect(result.stdout).toMatch(/failed:\s+1/);
        expect(sessions()[path]).toBeUndefined();
        expect(imported()).toEqual([]);
      });

      (process.platform === "linux" ? it : it.skip)(`keeps OS-limited partial writes out of outgoing pages (remote-http: ${remote})`, () => {
        scanner("clean");
        if (remote) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "http://fixture.invalid/mcp" } } }));
        const path = source("ordinary conversation ".repeat(300));
        env.LIMIT_STAGE_WRITES = "1";
        const result = run(["--scan-secrets"]);
        expect(result.stderr).toContain("EFBIG");
        expect(result.stdout).toMatch(/failed:\s+1/);
        expect(imported()).toEqual([]);
        expect(sessions()[path]).toBeUndefined();
        expect(readdirSync(join(home, "tmp"))).toEqual([]);
        expect(readdirSync(env.GSTACK_HOME).filter((p) => p.startsWith(".brain-ingest-write-"))).toEqual([]);
        const outgoing = join(env.GSTACK_HOME, "transcripts");
        if (existsSync(outgoing)) expect(readdirSync(outgoing, { recursive: true }).filter((p) => String(p).endsWith(".md"))).toEqual([]);
        delete env.LIMIT_STAGE_WRITES;
        expect(run(["--scan-secrets"]).status).toBe(0);
        expect(sessions()[path]).toBeDefined();
      });
    }

    it("checks the hash on requested incremental scans even when mtime is unchanged", () => {
      scanner("clean");
      const path = source();
      const time = new Date(Math.floor(Date.now() / 1000) * 1000);
      utimesSync(path, time, time);
      expect(run(["--scan-secrets"]).status).toBe(0);
      writeFileSync(path, readFileSync(path, "utf8") + appendRecord());
      utimesSync(path, time, time);
      expect(run(["--scan-secrets"]).status).toBe(0);
      expect(imported()[0].body).toContain("late ordinary update");
      expect(readFileSync(join(home, "imports"), "utf8").trim().split("\n")).toHaveLength(2);
    });

    it("keeps the no-scan import stamping contract unchanged", () => {
      const path = source();
      env.APPEND_DURING_IMPORT = path;
      env.APPEND_RECORD = appendRecord();
      expect(run().status).toBe(0);
      expect(sessions()[path]).toMatchObject({ sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    });
  });

  it("imports clean pages once in one batch and deduplicates the next run", () => {
    scanner("clean");
    const paths = [source(), source("another ordinary conversation")];
    const r = run(["--scan-secrets"]);
    expect(r.status).toBe(0);
    expect(imported()).toHaveLength(2);
    expect(Object.keys(sessions()).sort()).toEqual(paths.sort());
    expect(run(["--scan-secrets"]).stdout).toMatch(/skipped \(dedup\):\s+2/);
    expect(readFileSync(join(home, "imports"), "utf8").trim().split("\n")).toHaveLength(1);
    const scans = readFileSync(join(home, "scans"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(scans).toHaveLength(2);
    expect(scans.map((s) => s.body).sort()).toEqual(imported().map((p) => p.body).sort());
    for (const scan of scans) {
      expect(scan.dirMode).toBe(0o700);
      expect(scan.reportMode).toBe(0o600);
      expect(scan.inputMode).toBe(0o600);
      expect(existsSync(scan.report)).toBe(false);
      expect(existsSync(scan.input)).toBe(false);
    }
  });

  it("blocks a secret visible only after JSON decoding without recording it", () => {
    scanner("clean");
    const path = source('UNSAFE="synthetic"');
    expect(readFileSync(path, "utf8")).not.toContain('UNSAFE="synthetic"');
    const r = run(["--scan-secrets"]);
    expect(r.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
  });

  for (const mode of ["missing", "error", "malformed", "empty", "null", "invalid-finding", "overflow", "missing-report"]) {
    it(`refuses ${mode} scans and retries after repair`, () => {
      if (mode !== "missing") scanner(mode);
      const path = source();
      const r = run(["--scan-secrets"]);
      expect(r.stderr).toMatch(/secret-scan (missing|error)/);
      expect(imported()).toEqual([]);
      expect(sessions()[path]).toBeUndefined();
      expect(readdirSync(join(home, "tmp"))).toEqual([]);
      scanner("clean");
      expect(run(["--scan-secrets"]).status).toBe(0);
      expect(imported()).toHaveLength(1);
      expect(sessions()[path]).toBeDefined();
    });
  }

  it("ends a detect invocation at its 60-second deadline and retries after repair", () => {
    scanner("timeout");
    const path = source();
    const r = run(["--scan-secrets"], 75000);
    expect(r.stderr).toContain("secret-scan error");
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
    scanner("clean");
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(sessions()[path]).toBeDefined();
  }, 80000);

  it("does not stamp --no-write pages that could not pass the requested scan", () => {
    scanner("error");
    const path = source();
    run(["--scan-secrets", "--no-write"]);
    expect(sessions()[path]).toBeUndefined();
    scanner("clean");
    expect(run(["--scan-secrets", "--no-write"]).status).toBe(0);
    expect(sessions()[path]).toBeDefined();
    expect(imported()).toEqual([]);
  });

  it("accepts a complete clean report exactly at the 16 MiB ceiling", () => {
    scanner("ceiling");
    const path = source();
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported()).toHaveLength(1);
    expect(sessions()[path]).toBeDefined();
  });

  it("scans remote-http pages before persistent staging", () => {
    scanner("clean");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "http://fixture.invalid/mcp" } } }));
    const bad = source('UNSAFE="synthetic"');
    const clean = source();
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported()).toEqual([]);
    expect(sessions()[bad]).toBeUndefined();
    expect(sessions()[clean]).toBeDefined();
    const root = join(env.GSTACK_HOME, "transcripts");
    const pages = readdirSync(root, { recursive: true }).filter((path) => String(path).endsWith(".md"));
    expect(pages).toHaveLength(1);
    expect(readFileSync(join(root, String(pages[0])), "utf8")).toContain("ordinary conversation");
  });

  it("leaves scanning opt-in", () => {
    const path = source('UNSAFE="synthetic"');
    expect(run().status).toBe(0);
    expect(imported()).toHaveLength(1);
    expect(sessions()[path]).toBeDefined();
    expect(existsSync(join(home, "scans"))).toBe(false);
  });

  it("refuses unsafe extra resumed bytes and preserves the stage without success state", () => {
    scanner("clean");
    const path = source();
    const dir = resume('UNSAFE="synthetic"');
    expect(run(["--scan-secrets"]).status).toBe(1);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });

  it("rescans clean resumed bytes and retries a failed scanner without restaging", () => {
    const path = source();
    env.REJECT_IMPORT = "1";
    expect(run().status).toBe(1);
    const stagedBody = imported()[0].body;
    rmSync(join(home, "imported.json"));
    delete env.REJECT_IMPORT;
    const dir = resume(stagedBody, path);
    scanner("error");
    expect(run(["--scan-secrets"]).status).toBe(1);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
    scanner("clean");
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported().map((p) => p.body)).toEqual([stagedBody]);
    expect(sessions()[path]).toBeDefined();
  });

  it("does not stamp changed source bytes that were not scanned or imported on resume", () => {
    scanner("clean");
    const path = source();
    env.REJECT_IMPORT = "1";
    expect(run().status).toBe(1);
    const stagedBody = imported()[0].body;
    delete env.REJECT_IMPORT;
    resume(stagedBody, path);
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    records[1].payload.content[0].text = 'UNSAFE="synthetic"';
    writeFileSync(path, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported().map((p) => p.body)).toEqual([stagedBody]);
    expect(sessions()[path]).toBeUndefined();
    expect(existsSync(env.GSTACK_INGEST_RESUME_DIR)).toBe(true);
    delete env.GSTACK_INGEST_RESUME_DIR;
    rmSync(join(home, "imported.json"));
    expect(run(["--scan-secrets"]).stdout).toMatch(/skipped \(secret-scan\):\s+1/);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
  });

  it("refuses resumed symlinks rather than scanning outside owned staging", () => {
    scanner("clean");
    const path = source();
    const dir = resume("safe page", path);
    const target = join(home, "outside.md");
    writeFileSync(target, "outside content");
    symlinkSync(target, join(dir, "linked.md"));
    expect(run(["--scan-secrets"]).status).toBe(1);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("outside content");
    expect(existsSync(dir)).toBe(true);
  });

  it("retains the already-correct import exit-1 rejection and retry", () => {
    scanner("clean");
    const path = source();
    env.REJECT_IMPORT = "1";
    expect(run(["--scan-secrets"]).status).toBe(1);
    expect(sessions()[path]).toBeUndefined();
    delete env.REJECT_IMPORT;
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(sessions()[path]).toBeDefined();
  });

  (realScanner ? it : it.skip)("real gitleaks 8.30.1 imports clean pages and blocks recognized escaped secrets", () => {
    scanner("real");
    const version = spawnSync(realScanner!, ["version"], { env, timeout: 10000, encoding: "utf8" });
    expect(version.stdout.trim()).toBe("8.30.1");
    const clean = source();
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported()).toHaveLength(1);
    expect(sessions()[clean]).toBeDefined();
    rmSync(join(home, "imported.json"));
    const secret = `LINKEDIN_CLIENT_SECRET="${randomBytes(8).toString("hex")}"`;
    const path = source(secret);
    const report = join(home, "raw-report.json");
    const raw = spawnSync(realScanner!, ["detect", "--no-git", "--source", path, "--report-format", "json", "--report-path", report, "--exit-code", "0"], { env, cwd: home, timeout: 10000, encoding: "utf8" });
    expect(raw.status).toBe(0);
    expect(JSON.parse(readFileSync(report, "utf8"))).toEqual([]);
    const rendered = join(home, "rendered.md");
    writeFileSync(rendered, secret);
    const positive = spawnSync(realScanner!, ["detect", "--no-git", "--source", rendered, "--report-format", "json", "--report-path", report, "--exit-code", "0"], { env, cwd: home, timeout: 10000, encoding: "utf8" });
    expect(positive.status).toBe(0);
    expect(JSON.parse(readFileSync(report, "utf8")).some((finding: { RuleID: string }) => finding.RuleID === "linkedin-client-secret")).toBe(true);
    const r = run(["--scan-secrets"]);
    expect(r.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    expect(r.stderr).not.toContain(secret);
  });

  (realScanner ? it : it.skip)("real scanner config errors remain retryable", () => {
    scanner("real");
    const path = source();
    const config = join(home, "broken.toml");
    writeFileSync(config, "[not-valid");
    env.GITLEAKS_CONFIG = config;
    expect(run(["--scan-secrets"]).stderr).toContain("secret-scan error");
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    delete env.GITLEAKS_CONFIG;
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported()).toHaveLength(1);
    expect(sessions()[path]).toBeDefined();
  });

  (realScanner ? it : it.skip)("real scanner checks unsafe resumed pages, including extra files", () => {
    scanner("real");
    const path = source();
    const secret = `LINKEDIN_CLIENT_SECRET="${randomBytes(8).toString("hex")}"`;
    const dir = resume(secret);
    expect(run(["--scan-secrets"]).status).toBe(1);
    expect(imported()).toEqual([]);
    expect(sessions()[path]).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dir, "nested", "extra.md"), "now clean");
    expect(run(["--scan-secrets"]).status).toBe(0);
    expect(imported().map((p) => p.body)).toEqual(["now clean"]);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestHome(): string {
  return mkdtempSync(join(tmpdir(), "gstack-memory-ingest-"));
}

function runScript(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

function writeClaudeCodeSession(home: string, projectName: string, sessionId: string, content: string): string {
  const projectsDir = join(home, ".claude", "projects", projectName);
  mkdirSync(projectsDir, { recursive: true });
  const file = join(projectsDir, `${sessionId}.jsonl`);
  writeFileSync(file, content, "utf-8");
  return file;
}

function writeCodexSession(home: string, ymd: string, content: string): string {
  const [y, m, d] = ymd.split("-");
  const dir = join(home, ".codex", "sessions", y, m, d);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${Date.now()}.jsonl`);
  writeFileSync(file, content, "utf-8");
  return file;
}

// ── --help and --probe ─────────────────────────────────────────────────────

describe("gstack-memory-ingest CLI", () => {
  it("prints usage on --help and exits 0", () => {
    const r = runScript(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("Usage: gstack-memory-ingest");
    expect(r.stderr).toContain("--probe");
    expect(r.stderr).toContain("--incremental");
    expect(r.stderr).toContain("--bulk");
  });

  it("rejects unknown arguments with exit 1", () => {
    const r = runScript(["--bogus-flag"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown argument: --bogus-flag");
  });

  it("--probe on empty home reports 0 files", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 0");
    rmSync(home, { recursive: true, force: true });
  });

  it("--probe finds Claude Code sessions", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const session = `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"${new Date().toISOString()}","cwd":"/tmp/x"}\n{"type":"assistant","message":{"role":"assistant","content":"hi"},"timestamp":"${new Date().toISOString()}"}\n`;
    writeClaudeCodeSession(home, "tmp-x", "abc123", session);

    const r = runScript(["--probe", "--include-unattributed"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    expect(r.stdout).toContain("transcript");
    rmSync(home, { recursive: true, force: true });
  });

  it("--probe finds Codex sessions", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const session = `{"type":"session_meta","payload":{"id":"sess-xyz","cwd":"/tmp/x","git":{"repository_url":"https://github.com/foo/bar"}},"timestamp":"${today.toISOString()}"}\n`;
    writeCodexSession(home, ymd, session);

    const r = runScript(["--probe", "--include-unattributed"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    rmSync(home, { recursive: true, force: true });
  });

  it("--probe finds gstack artifacts (learnings, eureka, ceo-plan)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(join(gstackHome, "analytics"), { recursive: true });
    mkdirSync(join(gstackHome, "projects", "foo-bar", "ceo-plans"), { recursive: true });

    writeFileSync(join(gstackHome, "analytics", "eureka.jsonl"), '{"insight":"lake first"}\n');
    writeFileSync(join(gstackHome, "projects", "foo-bar", "learnings.jsonl"), '{"key":"a","insight":"b"}\n');
    writeFileSync(join(gstackHome, "projects", "foo-bar", "ceo-plans", "2026-05-01-test.md"), "# Plan\n");

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 3");
    expect(r.stdout).toContain("eureka");
    expect(r.stdout).toContain("learning");
    expect(r.stdout).toContain("ceo-plan");
    rmSync(home, { recursive: true, force: true });
  });

  it("--sources filter limits the walk to specific types", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(join(gstackHome, "analytics"), { recursive: true });
    mkdirSync(join(gstackHome, "projects", "foo", "ceo-plans"), { recursive: true });

    writeFileSync(join(gstackHome, "analytics", "eureka.jsonl"), '{"insight":"x"}\n');
    writeFileSync(join(gstackHome, "projects", "foo", "learnings.jsonl"), '{"key":"a"}\n');

    const r = runScript(["--probe", "--sources", "eureka"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    expect(r.stdout).toContain("eureka");
    expect(r.stdout).not.toContain("learning ");
    rmSync(home, { recursive: true, force: true });
  });

  it("--sources rejects empty list with exit 1", () => {
    const r = runScript(["--probe", "--sources", "bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--sources must include at least one of");
  });
});

// ── State file behavior ────────────────────────────────────────────────────

describe("gstack-memory-ingest state file", () => {
  it("--incremental on empty home creates state file with schema_version: 1", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const r = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(1);
    expect(state.last_writer).toBe("gstack-memory-ingest");
    rmSync(home, { recursive: true, force: true });
  });

  it("backs up state file on schema_version mismatch", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    writeFileSync(statePath, JSON.stringify({ schema_version: 999, sessions: {} }), "utf-8");

    const r = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(existsSync(statePath + ".bak")).toBe(true);

    const fresh = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(fresh.schema_version).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("backs up state file on JSON parse error", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    writeFileSync(statePath, "{ this is not valid json", "utf-8");

    const r = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(existsSync(statePath + ".bak")).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

// ── Security: cwd in transcript JSONL must not reach a shell ─────────────

describe("gstack-memory-ingest security: untrusted cwd cannot trigger shell substitution", () => {
  it("does not invoke /bin/sh when a transcript record contains $() in cwd", () => {
    // Transcript JSONL is an untrusted surface — a record's `.cwd` value
    // can be set by anyone who can write to ~/.claude/projects (cross-machine
    // share, prompt-injection appending to the active session log, etc.).
    // resolveGitRemote() must use execFileSync, not execSync with template
    // interpolation, or `cwd="$(...)"` triggers command substitution under
    // /bin/sh -c on the next ingest run.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const markerDir = mkdtempSync(join(tmpdir(), "gstack-mi-cwd-marker-"));
    const marker = join(markerDir, "PWNED");
    // Plain $(...) — what an attacker would write into a transcript record.
    // execFileSync passes this verbatim to git as a -C argument; execSync
    // (the prior code path) wrapped it in a /bin/sh -c template that ran
    // the substitution.
    const malicious = "$(touch " + marker + ")";

    const record = JSON.stringify({
      type: "user",
      uuid: "11111111-1111-1111-1111-111111111111",
      sessionId: "abc",
      cwd: malicious,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hi" },
    });
    writeClaudeCodeSession(home, "-tmp-target", "abc", record + "\n");

    const r = runScript(["--incremental", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      GSTACK_MEMORY_INGEST_NO_WRITE: "1",
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);

    rmSync(home, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });
});

// ── Transcript parser via re-import of the source module ───────────────────

describe("internal: parseTranscriptJsonl + buildTranscriptPage shape", () => {
  it("parses a Claude Code JSONL session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-mi-parse-"));
    const file = join(dir, "abc123.jsonl");
    const content =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeFileSync(file, content, "utf-8");

    // Re-import via dynamic import is tricky because the script auto-runs main().
    // We instead test via shell invocation: --probe with this file should find 1 transcript.
    const home = makeTestHome();
    const projDir = join(home, ".claude", "projects", "tmp-foo");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "abc123.jsonl"), content, "utf-8");

    const r = runScript(["--probe", "--include-unattributed"], { HOME: home, GSTACK_HOME: join(home, ".gstack") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");

    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("treats a truncated last line as partial (does not crash)", () => {
    const home = makeTestHome();
    const projDir = join(home, ".claude", "projects", "tmp-bar");
    mkdirSync(projDir, { recursive: true });
    // Truncated last line — JSON parse will fail on it
    const content =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/bar"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"this is truncat`; // no closing brace + no newline
    writeFileSync(join(projDir, "trunc.jsonl"), content, "utf-8");

    const r = runScript(["--probe", "--include-unattributed"], { HOME: home, GSTACK_HOME: join(home, ".gstack") });
    // Should not crash; should report 1 transcript
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    rmSync(home, { recursive: true, force: true });
  });
});

// ── --limit shortcut for smoke tests ───────────────────────────────────────

describe("gstack-memory-ingest --limit", () => {
  it("respects --limit by stopping after N writes (mocked via --probe shortcut)", () => {
    // Hermetic home: against the operator's real HOME this walked the whole
    // transcript corpus (and, post policy-parity, batch-checked its real
    // policy store), making a pure arg-parsing assertion slow and flaky.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const r = runScript(["--probe", "--limit", "1"], { HOME: home, GSTACK_HOME: gstackHome });
    // --limit doesn't apply to probe but argument should parse without error
    expect(r.exitCode).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects --limit 0 with exit 1", () => {
    const r = runScript(["--probe", "--limit", "0"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--limit requires a positive integer");
  });
});

// ── Writer regression: batch-import via `gbrain import <dir>` ─────────────

/**
 * Stand up a fake `gbrain` shim on PATH that:
 *  - advertises `import` in `--help` output (gbrainAvailable() passes)
 *  - records `import <dir>` invocations, args, and a sample of staged files
 *  - emits a valid `--json` summary on stdout (status, imported, etc.)
 *  - optionally drops failures to a sync-failures.jsonl path (HOME/.gbrain/)
 *
 * Architecture being verified (post plan-eng-review + Codex outside-voice):
 *  - new code uses `gbrain import <stagingDir> --no-embed --json` ONE time,
 *    not `gbrain put <slug>` per file. The fixture would catch a regression
 *    to the legacy per-file loop because (a) `put` is no longer advertised,
 *    so gbrainAvailable() returns false; (b) we assert the recorded args
 *    include `import` and the dir argument.
 */
function installFakeGbrain(
  home: string,
  opts: { failingPaths?: string[]; collectNothing?: boolean } = {},
): { binDir: string; logFile: string; argsFile: string; stagingListFile: string } {
  const binDir = join(home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(home, "gbrain-calls.log");
  const argsFile = join(home, "gbrain-args.log");
  const stagingListFile = join(home, "gbrain-staging-list.log");
  // Bash-side: when failingPaths is set, append matching JSONL entries to
  // ~/.gbrain/sync-failures.jsonl so D7's readNewFailures can read them.
  const failingList = (opts.failingPaths || []).join("|");
  const script = `#!/usr/bin/env bash
set -euo pipefail
LOG="${logFile}"
ARGS_LOG="${argsFile}"
STAGING_LIST="${stagingListFile}"
FAILING_LIST="${failingList}"
case "\${1:-}" in
  --help|-h)
    cat <<EOF
Usage: gbrain <command> [options]

Commands:
  import <dir>         Import markdown directory (batch, content-addressed)
  search <query>       Keyword search across pages
  ask <question>       Hybrid semantic + keyword query
EOF
    exit 0
    ;;
  import)
    DIR="\${2:-}"
    NO_EMBED=0
    JSON=0
    shift 2 || true
    for arg in "\$@"; do
      case "\$arg" in
        --no-embed) NO_EMBED=1 ;;
        --json) JSON=1 ;;
      esac
    done
    echo "import \$DIR" >> "\$LOG"
    {
      echo "dir=\$DIR no_embed=\$NO_EMBED json=\$JSON"
    } >> "\$ARGS_LOG"
    # Capture file tree from staging dir for assertion-on-shape later.
    if [ -d "\$DIR" ]; then
      ( cd "\$DIR" && find . -type f | sort ) > "\$STAGING_LIST" 2>/dev/null || true
    fi
    # If failingPaths configured, drop fake entries to sync-failures.jsonl
    # (mtime byte-offset snapshot lets the ingest's readNewFailures pick them up).
    if [ -n "\$FAILING_LIST" ]; then
      mkdir -p "\${HOME}/.gbrain"
      IFS='|' read -ra FAIL_PATHS <<< "\$FAILING_LIST"
      for p in "\${FAIL_PATHS[@]}"; do
        echo "{\\"path\\":\\"\$p\\",\\"error\\":\\"File too large\\",\\"code\\":\\"FILE_TOO_LARGE\\",\\"commit\\":\\"\\",\\"ts\\":\\"2026-05-09T22:00:00Z\\"}" >> "\${HOME}/.gbrain/sync-failures.jsonl"
      done
    fi
    # Count files in staging dir for the imported count.
    if [ -d "\$DIR" ]; then
      TOTAL=\$(find "\$DIR" -name "*.md" -type f | wc -l | tr -d ' ')
    else
      TOTAL=0
    fi
    # collectNothing: simulate gbrain walking the staging dir and finding
    # nothing — the real-world shape when .gitignore hides every staged file
    # from collect_files. Crucially this writes NO sync-failures.jsonl entry,
    # because there is no per-file failure: gbrain never saw the files.
    if [ "${opts.collectNothing ? "1" : "0"}" = "1" ]; then
      TOTAL=0
    fi
    ERRORS=0
    if [ -n "\$FAILING_LIST" ]; then
      ERRORS=\$(echo "\$FAILING_LIST" | tr '|' '\\n' | wc -l | tr -d ' ')
    fi
    IMPORTED=\$((TOTAL - ERRORS))
    if [ \$JSON -eq 1 ]; then
      echo "{\\"status\\":\\"success\\",\\"duration_s\\":0.1,\\"imported\\":\$IMPORTED,\\"skipped\\":0,\\"errors\\":\$ERRORS,\\"chunks\\":\$IMPORTED,\\"total_files\\":\$TOTAL}"
    fi
    exit 0
    ;;
  put|put_page|put-page)
    # If new ingest code ever regresses to per-file puts, fail loudly so the
    # test signals a real architectural regression.
    echo "Unexpected legacy command: \$1" >&2
    exit 99
    ;;
  *)
    echo "Unknown command: \${1:-<empty>}" >&2
    exit 2
    ;;
esac
`;
  const binPath = join(binDir, "gbrain");
  writeFileSync(binPath, script, "utf-8");
  chmodSync(binPath, 0o755);
  return { binDir, logFile, argsFile, stagingListFile };
}

/**
 * Fake gitleaks for the --scan-secrets tests; returns its bin dir. `detect`
 * reports one finding when the CONTENT of the scanned file contains `marker`
 * (fixed-string), `[]` otherwise — so a test controls which bytes count as a
 * secret. `failDetect` exits non-zero like a crashed or misconfigured
 * gitleaks (scanner "error"); `failProbe` fails `gitleaks version`, which the
 * probe treats as absent (scanner "missing").
 */
function installFakeGitleaks(
  home: string,
  opts: { marker?: string; failDetect?: boolean; failProbe?: boolean },
): string {
  const binDir = join(home, "fake-gitleaks-bin");
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bash
if [ "\${1:-}" = "version" ]; then exit ${opts.failProbe ? 1 : 0}; fi
${opts.failDetect ? 'echo "fake gitleaks: scan failed" >&2; exit 2' : ""}
SRC=""
REPORT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SRC="$2"; shift 2 ;;
    --report-path) REPORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if grep -qF -- '${opts.marker ?? "no-marker-configured"}' "$SRC"; then
  echo '[{"RuleID":"fake-rule","Description":"fake finding","StartLine":1,"Match":"REDACTED","Secret":"AKIAFAKEFAKEFAKE12345"}]' > "$REPORT"
else
  echo '[]' > "$REPORT"
fi
exit 0
`;
  writeFileSync(join(binDir, "gitleaks"), script, "utf-8");
  chmodSync(join(binDir, "gitleaks"), 0o755);
  return binDir;
}

describe("gstack-memory-ingest writer (gbrain v0.20+ batch `import` interface)", () => {
  it("probes the gbrain executable directly instead of shelling through command -v", () => {
    const source = readFileSync(SCRIPT, "utf-8");

    expect(source).not.toContain('command -v gbrain');
    // v1.40.0.0: probe routes through lib/gbrain-exec.ts's execGbrainText helper
    // (codex review #4 — centralized gbrain spawn surface). Pre-v1.40 the call
    // was a direct `execFileSync("gbrain", ["--help"], ...)` inline.
    expect(source).toContain('execGbrainText(["--help"]');
  });

  it("invokes `gbrain import <dir> --no-embed --json` exactly once with hierarchical staging", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile, argsFile, stagingListFile } = installFakeGbrain(home);

    // Single Claude Code session fixture. --include-unattributed lets it
    // write even though there's no resolvable git remote in /tmp.
    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "abc123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(logFile)).toBe(true);

    // Verify gbrain was called exactly ONCE with import, not per-file put.
    const calls = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^import\s+\/.+\/\.staging-ingest-\d+-\d+$/);

    // Verify args: --no-embed and --json both present.
    const argDump = readFileSync(argsFile, "utf-8");
    expect(argDump).toMatch(/no_embed=1/);
    expect(argDump).toMatch(/json=1/);

    // D1 regression: staged file lives in a slug-shaped subdirectory tree
    // ("transcripts/claude-code/_unattributed/..."), not flat at the staging
    // dir root. If writeStaged ever regresses to flat layout, this fails.
    const stagedList = readFileSync(stagingListFile, "utf-8");
    expect(stagedList).toMatch(/^\.\/transcripts\/claude-code\/.+\.md$/m);
  });

  // #2353: buildTranscriptPage stored the RAW resolved remote ("" when
  // unresolvable) while the frontmatter wrote the normalized "_unattributed".
  // The policy filter fast-paths !p.git_remote, so under --include-unattributed
  // a `_unattributed → deny` policy never applied to exactly the pages it
  // names. Uses the REAL bin/gstack-gbrain-repo-policy (resolved by the client
  // relative to lib/, and seeded here through its own `set` verb) — a fake
  // echoing tiers would pass on both sides of the fix.
  it("a deny policy keyed _unattributed applies to unattributable transcripts (#2353)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile } = installFakeGbrain(home);

    const POLICY = join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");
    const seeded = spawnSync("bash", [POLICY, "set", "_unattributed", "deny"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(seeded.status).toBe(0);
    expect(existsSync(join(gstackHome, "gbrain-repo-policy.json"))).toBe(true);

    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "abc123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    // The only candidate page is policy-denied, so nothing may reach gbrain:
    // pre-fix, the "" remote bypassed the filter and gbrain import ran.
    expect(r.exitCode).toBe(0);
    expect(existsSync(logFile)).toBe(false);
  });

  // Silent-data-loss regression: gbrain accepts the import call, exits 0, and
  // reports imported=0 because collect_files found nothing in the staging dir
  // (real-world cause: gstack-artifacts-init writes `.gitignore = "*"` into
  // $GSTACK_HOME, and `gbrain import` honours .gitignore, so every file staged
  // under $GSTACK_HOME is invisible to it).
  //
  // No per-file failure is written to sync-failures.jsonl — gbrain never SAW
  // the files — so readNewFailures returns empty. Before the reconciliation
  // check, that made a total loss indistinguishable from success: every
  // prepared file got state-recorded as ingested and the pass reported
  // "N written". State then said "done", so no later run ever retried.
  it("refuses to advance state when gbrain imports fewer pages than were staged", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile } = installFakeGbrain(home, { collectNothing: true });

    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "abc123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    // gbrain WAS called — this is not a "gbrain missing" path.
    expect(existsSync(logFile)).toBe(true);

    // The pass must not claim success.
    expect(r.stderr).toMatch(/\[memory-ingest\] ERR:.*accounted for 0 of 1 staged page/);
    expect(r.stderr).toMatch(/Refusing to advance state/);
    expect(r.stdout).not.toMatch(/written:\s+1/);

    // The critical assertion: state must NOT mark the session ingested, or the
    // next run skips it forever and the transcript is lost silently.
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(Object.keys(state.sessions || {}).length).toBe(0);
    }
  });

  // Originally landed in v1.32.0.0 (PR #1411) on the per-file `gbrain put`
  // path. Postgres rejects 0x00 in UTF-8 text columns. Some Claude Code
  // transcripts contain NUL inside user-pasted content or tool output. The
  // renderPageBody helper strips them so the staged .md never carries them
  // into gbrain. Adapted for the batch architecture: we read the staged file
  // contents instead of fake-gbrain stdin.
  it("strips NUL bytes from the staged body before gbrain import", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Shim that copies staging dir into stagingCopy so we can inspect the
    // exact bytes that would have been fed to gbrain.
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const stagingCopy = join(home, "staging-copy");
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Usage: gbrain <command>"; echo "Commands:"; echo "  import <dir>   Import"; exit 0 ;;
  import)
    DIR="\${2:-}"
    cp -R "\$DIR" "${stagingCopy}" 2>/dev/null || true
    if [[ " \$* " == *" --json "* ]]; then
      echo '{"status":"success","duration_s":0.1,"imported":1,"skipped":0,"errors":0,"chunks":1,"total_files":1}'
    fi
    exit 0 ;;
  *) echo "unknown"; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    // Pasted content with embedded NUL bytes in a few shapes:
    //  - inline mid-token: abc\x00def
    //  - at start of a line
    //  - at end of a line
    //  - back-to-back run
    const dirty =
      `abc\x00def hello\x00\x00world\nleading\x00line\nline-trailing\x00\nclean line\n`;
    const session =
      `{"type":"user","message":{"role":"user","content":${JSON.stringify(dirty)}},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/nul-test"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"ok"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-nul-test", "nul123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(stagingCopy)).toBe(true);
    const findMd = spawnSync("find", [stagingCopy, "-name", "*.md", "-type", "f"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    const mdPaths = (findMd.stdout || "").trim().split("\n").filter(Boolean);
    expect(mdPaths.length).toBeGreaterThan(0);
    const body = readFileSync(mdPaths[0], "utf-8");

    // The body that gbrain will read MUST NOT contain any 0x00 byte.
    expect(body.includes("\x00")).toBe(false);
    // But the surrounding content should survive intact — we strip NUL only.
    expect(body).toContain("abcdef");
    expect(body).toContain("helloworld");
    expect(body).toContain("leadingline");
    expect(body).toContain("line-trailing");
    expect(body).toContain("clean line");

    rmSync(home, { recursive: true, force: true });
  });

  it("injects title/type/tags into the staged page's YAML frontmatter", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // This shim sleeps long enough to let us read the staging dir mid-run.
    // Easier path: intercept by copying the staging dir before gbrain exits.
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const stagingCopy = join(home, "staging-copy");
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Usage: gbrain <command>"; echo "Commands:"; echo "  import <dir>   Import"; exit 0 ;;
  import)
    DIR="\${2:-}"
    cp -R "\$DIR" "${stagingCopy}" 2>/dev/null || true
    # Emit valid --json output
    if [[ " \$* " == *" --json "* ]]; then
      echo '{"status":"success","duration_s":0.1,"imported":1,"skipped":0,"errors":0,"chunks":1,"total_files":1}'
    fi
    exit 0 ;;
  *) echo "unknown"; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"hello"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "abc123", session);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(stagingCopy)).toBe(true);

    // Find the staged .md file; assert frontmatter has title/type/tags.
    // (The exact slug path varies with the staging dir generation, so we
    // walk to find a .md and read its head.)
    const findMd = spawnSync("find", [stagingCopy, "-name", "*.md", "-type", "f"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    const mdPaths = (findMd.stdout || "").trim().split("\n").filter(Boolean);
    expect(mdPaths.length).toBeGreaterThan(0);
    const body = readFileSync(mdPaths[0], "utf-8");
    expect(body).toContain("---");
    expect(body).toMatch(/title:\s/);
    expect(body).toMatch(/type:\s+transcript/);
    expect(body).toMatch(/tags:/);

    rmSync(home, { recursive: true, force: true });
  });

  it("D7: files listed in ~/.gbrain/sync-failures.jsonl are NOT recorded in state", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Write TWO sessions so we can verify one lands and the other doesn't.
    const sessionA =
      `{"type":"user","message":{"role":"user","content":"a"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"a"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    const sessionB =
      `{"type":"user","message":{"role":"user","content":"b"},"timestamp":"2026-05-02T00:00:00Z","cwd":"/tmp/bar"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"b"},"timestamp":"2026-05-02T00:00:01Z"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "aaaa", sessionA);
    writeClaudeCodeSession(home, "tmp-bar", "bbbb", sessionB);

    // Configure fake gbrain to "fail" the second session's staged path.
    // The staging-dir-relative path is "transcripts/claude-code/...bbbb.md"
    // (Codex sessions take a different prefix). We use a wildcard via the
    // last segment matching the session id.
    // The fake matches a literal path against the staging-list it captures,
    // but since we can't know the exact path ahead of time, we let the
    // ingest run once normally, inspect the staging list, then set HOME
    // .gbrain/sync-failures.jsonl manually. Simpler: cause the SHA-id
    // session-id segment to be in the failing list directly — gbrain's
    // failure record uses the staging-relative path.
    // Easiest: write a sync-failures.jsonl pre-existing that we OVERWRITE
    // after the ingest starts. To keep this deterministic without timing,
    // we run a passthrough fake that itself writes the failure entry.
    const binDir = join(home, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Usage: gbrain"; echo "Commands:"; echo "  import <dir>   Import"; exit 0 ;;
  import)
    DIR="\${2:-}"
    # Pick the SECOND .md found in the staging dir and mark it failed in
    # ~/.gbrain/sync-failures.jsonl using the dir-relative path. The first
    # one lands cleanly.
    mkdir -p "\${HOME}/.gbrain"
    REL=\$(cd "\$DIR" && find . -name "*.md" -type f | sed 's|^\\./||' | sort | tail -1)
    if [ -n "\$REL" ]; then
      echo "{\\"path\\":\\"\$REL\\",\\"error\\":\\"File too large\\",\\"code\\":\\"FILE_TOO_LARGE\\",\\"commit\\":\\"\\",\\"ts\\":\\"2026-05-09T22:00:00Z\\"}" >> "\${HOME}/.gbrain/sync-failures.jsonl"
    fi
    if [[ " \$* " == *" --json "* ]]; then
      echo '{"status":"success","duration_s":0.1,"imported":1,"skipped":0,"errors":1,"chunks":1,"total_files":2}'
    fi
    exit 0 ;;
  *) echo "unknown"; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    const r = runScript(["--bulk", "--include-unattributed", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });
    expect(r.exitCode).toBe(0);

    // State file should have exactly 1 session entry (the non-failed one).
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    const sessionPaths = Object.keys(state.sessions || {});
    expect(sessionPaths.length).toBe(1);

    rmSync(home, { recursive: true, force: true });
  });

  it("emits ERR with system_error and exits non-zero when gbrain CLI is missing the `import` subcommand", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Fake gbrain that advertises ONLY `put` (legacy) — no `import`.
    const binDir = join(home, "legacy-bin");
    mkdirSync(binDir, { recursive: true });
    const script = `#!/usr/bin/env bash
case "\${1:-}" in
  --help|-h) echo "Commands:"; echo "  put <slug>    Write a page (legacy)"; exit 0 ;;
  *) echo "Unknown command: \$1" >&2; exit 2 ;;
esac
`;
    const binPath = join(binDir, "gbrain");
    writeFileSync(binPath, script, "utf-8");
    chmodSync(binPath, 0o755);

    const session =
      `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/bar"}\n`;
    writeClaudeCodeSession(home, "tmp-bar", "def456", session);

    const r = runScript(["--bulk", "--include-unattributed"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    // D6: system_error sets non-zero exit; orchestrator marks ERR.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\[memory-ingest\] ERR:.*missing `import` subcommand|gbrain CLI not in PATH/);

    rmSync(home, { recursive: true, force: true });
  });

  it("--scan-secrets opt-in: skips files with gitleaks findings, lets clean files through", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir } = installFakeGbrain(home);

    // Fake gitleaks: reports a finding for any scanned page containing
    // "dirty", clean for everything else. The fake-gbrain shim doesn't
    // interfere — gitleaks is invoked from preparePages before staging.
    const fakeGitleaksDir = installFakeGitleaks(home, { marker: "dirty" });

    // Two sessions: one "clean", one "dirty" (its message text is "dirty",
    // so its rendered page draws a finding from the fake gitleaks).
    const sessionA =
      `{"type":"user","message":{"role":"user","content":"clean"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n`;
    const sessionB =
      `{"type":"user","message":{"role":"user","content":"dirty"},"timestamp":"2026-05-02T00:00:00Z","cwd":"/tmp/bar"}\n`;
    writeClaudeCodeSession(home, "tmp-foo", "cleansess123", sessionA);
    // Force the path to contain the "dirty" marker.
    writeClaudeCodeSession(home, "tmp-dirty-bar", "dirtysess456", sessionB);

    // Run with --scan-secrets enabled. Combine the fake gitleaks bin
    // before fake-gbrain in PATH so both shims resolve.
    const r = runScript(["--bulk", "--include-unattributed", "--scan-secrets"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${fakeGitleaksDir}:${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    // Bulk report shows skipped (secret-scan) >= 1
    expect(r.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
    // Stderr from the secret-scan match path (printed when !quiet) includes the dirty path's basename.
    // Match generously: any occurrence of "secret-scan match" line.
    expect(r.stderr + r.stdout).toMatch(/secret-scan match/);

    rmSync(home, { recursive: true, force: true });
  });

  // The scan used to run on the raw .jsonl. gitleaks' assignment rules don't
  // match across a JSON-escaped quote, so a quoted secret in a transcript
  // (`KEY=\"v\"` on disk) scanned clean, then was imported as `KEY="v"`, the
  // form the rules do match (seen on real Codex sessions: pages flagged
  // linkedin-client-secret / generic-api-key whose .jsonl had scanned clean).
  // The fake flags only the unescaped form, as real gitleaks does.
  it("--scan-secrets scans the rendered page, not the raw .jsonl", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, stagingListFile } = installFakeGbrain(home);
    const marker = 'SYNTHETIC_TOKEN="';
    const fakeGitleaksDir = installFakeGitleaks(home, { marker });

    const ts = "2026-05-03T00:00:00Z";
    const codexFile = writeCodexSession(
      home,
      "2026-05-03",
      [
        { timestamp: ts, type: "session_meta", payload: { id: "sess-escaped", cwd: "/tmp/codex-app" } },
        {
          timestamp: ts,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `wire up auth:\n${marker}not-a-real-value"` }],
          },
        },
      ].map((rec) => JSON.stringify(rec)).join("\n") + "\n",
    );
    // Premise: on disk the quote is escaped, so the raw file has no marker.
    expect(readFileSync(codexFile, "utf-8")).not.toContain(marker);
    writeClaudeCodeSession(
      home,
      "tmp-foo",
      "cleansess123",
      `{"type":"user","message":{"role":"user","content":"clean"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n`,
    );

    const r = runScript(["--bulk", "--include-unattributed", "--scan-secrets"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${fakeGitleaksDir}:${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
    expect(r.stderr).toMatch(/\[secret-scan match\] .*\/\.codex\/sessions\/.+\.jsonl/);
    // Only the clean session reached gbrain import.
    const staged = readFileSync(stagingListFile, "utf-8");
    expect(staged).toMatch(/^\.\/transcripts\/claude-code\/.+\.md$/m);
    expect(staged).not.toContain("transcripts/codex/");

    rmSync(home, { recursive: true, force: true });
  });

  // "Could not scan" comes back as an empty findings list with scanner
  // "error" (gitleaks exited non-zero, overflowed the 16MB maxBuffer on a
  // file with many findings, or printed an unparseable report) or "missing"
  // (absent, unusable, or too slow to answer). The gate used to skip only on
  // scanner "gitleaks" with findings, so both let files in unscanned.
  for (const [label, opts, scanner] of [
    ["gitleaks fails mid-scan", { failDetect: true }, "error"],
    ["gitleaks is unusable", { failProbe: true }, "missing"],
  ] as const) {
    it(`--scan-secrets fails closed when ${label} (scanner ${scanner})`, () => {
      const home = makeTestHome();
      const gstackHome = join(home, ".gstack");
      mkdirSync(gstackHome, { recursive: true });
      const { binDir, logFile } = installFakeGbrain(home);
      const fakeGitleaksDir = installFakeGitleaks(home, opts);
      writeClaudeCodeSession(
        home,
        "tmp-foo",
        "cleansess123",
        `{"type":"user","message":{"role":"user","content":"clean"},"timestamp":"2026-05-01T00:00:00Z","cwd":"/tmp/foo"}\n`,
      );

      const r = runScript(["--bulk", "--include-unattributed", "--scan-secrets"], {
        HOME: home,
        GSTACK_HOME: gstackHome,
        PATH: `${fakeGitleaksDir}:${binDir}:${process.env.PATH || ""}`,
      });

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/written:\s+0/);
      expect(r.stdout).toMatch(/skipped \(secret-scan\):\s+1/);
      expect(r.stderr).toContain(`[secret-scan ${scanner}]`);
      // Nothing was prepared, so gbrain import never ran.
      expect(existsSync(logFile)).toBe(false);

      rmSync(home, { recursive: true, force: true });
    });
  }
});

// #2105: current Codex rollout records are
// { type: 'response_item', payload: { type: 'message', role, content: [...] } }
// — the legacy payload.message branch never fired on them, so every Codex
// session imported as an empty shell (message_count: 0, 243/243 on the
// reporting machine).
describe("#2105 codex response_item rollout shape", () => {
  it("extracts messages from response_item records", async () => {
    const { parseTranscriptJsonl } = await import("../bin/gstack-memory-ingest");
    const dir = mkdtempSync(join(tmpdir(), "ingest-2105-"));
    const file = join(dir, "rollout-2026-06-01.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/tmp/x" }, timestamp: "2026-06-01T00:00:00Z" }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello human" }] } }),
      // Non-message response_items must not count as messages.
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [] } }),
    ].join("\n") + "\n");

    const parsed = parseTranscriptJsonl(file)!;
    expect(parsed).not.toBeNull();
    expect(parsed.agent).toBe("codex");
    expect(parsed.message_count).toBe(2);
    expect(parsed.body).toContain("## User\n\nhello codex");
    expect(parsed.body).toContain("## Assistant\n\nhello human");
    rmSync(dir, { recursive: true, force: true });
  });

  it("legacy payload.message shape still parses", async () => {
    const { parseTranscriptJsonl } = await import("../bin/gstack-memory-ingest");
    const dir = mkdtempSync(join(tmpdir(), "ingest-2105-legacy-"));
    const file = join(dir, "rollout-legacy.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { id: "s2", cwd: "/tmp/y" }, timestamp: "2026-06-01T00:00:00Z" }),
      JSON.stringify({ payload: { message: { role: "user", content: "old shape" } } }),
    ].join("\n") + "\n");

    const parsed = parseTranscriptJsonl(file)!;
    expect(parsed.message_count).toBe(1);
    expect(parsed.body).toContain("## User\n\nold shape");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── #2394: --probe counts post-attribution, matching what --bulk would write ─

describe("#2394: probe applies the same attribution gate as prepare", () => {
  function makeAttributableCwd(home: string): string {
    const repo = join(home, "work", "attributable-repo");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf-8", timeout: 30_000 });
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/foo/bar.git"], { encoding: "utf-8", timeout: 30_000 });
    return repo;
  }

  function writeMixedCorpus(home: string): void {
    const attributableCwd = makeAttributableCwd(home);
    const ts = new Date().toISOString();
    writeClaudeCodeSession(
      home, "work-attributable", "attr1",
      `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"${ts}","cwd":"${attributableCwd.replace(/\\/g, "\\\\")}"}\n`,
    );
    writeClaudeCodeSession(
      home, "tmp-nowhere", "unattr1",
      `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"${ts}","cwd":"${join(home, "not-a-repo").replace(/\\/g, "\\\\")}"}\n`,
    );
    mkdirSync(join(home, "not-a-repo"), { recursive: true });
  }

  it("probe reports post-attribution counts and names what it skipped", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    writeMixedCorpus(home);

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    // Post-attribution: only the transcript whose cwd resolves to a remote.
    expect(r.stdout).toContain("Total files in window: 1");
    // The excluded remainder is visible, never silent.
    expect(r.stdout).toContain("Skipped (unattributed): 1");
    rmSync(home, { recursive: true, force: true });
  });

  it("--include-unattributed restores raw counts", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    writeMixedCorpus(home);

    const r = runScript(["--probe", "--include-unattributed"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 2");
    rmSync(home, { recursive: true, force: true });
  });

  it("parity: probe post-attribution count equals what prepare actually processes", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    writeMixedCorpus(home);

    const probe = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(probe.exitCode).toBe(0);
    const probeNew = Number((probe.stdout.match(/New \(never ingested\):\s+(\d+)/) || [])[1]);
    expect(probeNew).toBe(1);

    // Same stage on the ingest side: the transcripts that reach the import
    // step (written + failed) are exactly the ones that passed the shared
    // attribution gate in preparePages. No gbrain is configured in this
    // hermetic env, so the attributable transcript FAILS at import — that is
    // fine: parity is a prepare-stage invariant (probe post-attribution ==
    // prepare post-attribution), deliberately NOT == final written (#2394).
    const inc = runScript(["--incremental", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    const m = inc.stderr.match(/(\d+) written, (\d+) failed/) || inc.stdout.match(/(\d+) written, (\d+) failed/);
    expect(m).not.toBeNull();
    const reachedImport = Number(m![1]) + Number(m![2]);
    expect(reachedImport).toBe(probeNew);
    rmSync(home, { recursive: true, force: true });
  });

  it("a multi-MB transcript is still classified correctly (bounded probe read)", () => {
    // The probe reads a BOUNDED 256KB prefix, never the whole file (plan C7).
    // The cwd sits on the first line; >1MB of filler follows. Classification
    // must come out attributable — and stay cheap on real multi-MB corpora.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const attributableCwd = join(home, "work", "attributable-repo");
    mkdirSync(attributableCwd, { recursive: true });
    spawnSync("git", ["-C", attributableCwd, "init", "-q"], { encoding: "utf-8", timeout: 30_000 });
    spawnSync("git", ["-C", attributableCwd, "remote", "add", "origin", "https://github.com/foo/bar.git"], { encoding: "utf-8", timeout: 30_000 });

    const ts = new Date().toISOString();
    const cwdLine = `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"${ts}","cwd":"${attributableCwd.replace(/\\/g, "\\\\")}"}\n`;
    const filler = `{"type":"assistant","message":{"role":"assistant","content":"${"x".repeat(1000)}"}}\n`;
    const body = cwdLine + filler.repeat(1100); // > 1MB after the cwd line
    expect(body.length).toBeGreaterThan(1024 * 1024);
    writeClaudeCodeSession(home, "work-attributable", "big1", body);

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    expect(r.stdout).not.toContain("Skipped (unattributed)");
    rmSync(home, { recursive: true, force: true });
  });

  it("Codex format: session_meta cwd attributes the transcript in the probe", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const attributableCwd = makeAttributableCwd(home);
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const session = `{"type":"session_meta","payload":{"id":"sess-meta-cwd","cwd":"${attributableCwd.replace(/\\/g, "\\\\")}"},"timestamp":"${today.toISOString()}"}\n`;
    writeCodexSession(home, ymd, session);

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 1");
    expect(r.stdout).not.toContain("Skipped (unattributed)");
    rmSync(home, { recursive: true, force: true });
  });

  it("parity: a Codex cwd appearing only on a LATER record is unattributed in probe AND prepare", () => {
    // parseTranscriptJsonl reads Codex cwd from the session_meta FIRST record
    // ONLY. The probe mirrors those exact rules — the pre-fix probe scanned
    // every line for any cwd and DIVERGED on this shape (probe said
    // attributable, prepare said not).
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const attributableCwd = makeAttributableCwd(home);
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const session =
      `{"type":"session_meta","payload":{"id":"sess-late-cwd"},"timestamp":"${today.toISOString()}"}\n` +
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"hi"}]},"cwd":"${attributableCwd.replace(/\\/g, "\\\\")}"}\n`;
    writeCodexSession(home, ymd, session);

    const probe = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout).toContain("Total files in window: 0");
    expect(probe.stdout).toContain("Skipped (unattributed): 1");

    // Prepare agrees: nothing reaches the import stage (written + failed = 0)
    // and the skip is attributed to the same gate.
    const inc = runScript(["--incremental"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(inc.exitCode).toBe(0);
    const written = Number((inc.stdout.match(/written:\s+(\d+)/) || [])[1]);
    const failed = Number((inc.stdout.match(/failed:\s+(\d+)/) || [])[1]);
    const unattrib = Number((inc.stdout.match(/skipped \(unattrib\):\s+(\d+)/) || [])[1]);
    expect(written + failed).toBe(0);
    expect(unattrib).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });
});

// ── #2392: transcript ingest honors the per-remote trust policy ─────────────
//
// The same store the code-import gate honors (bin/gstack-gbrain-sync.ts):
// tier `deny` and `read-only` transcripts are skipped with their own counters;
// a store that EXISTS but can't be read is a hard error before any writes
// (never a silent bypass of a set policy); no store at all = zero policy work.
// The policy store is seeded through the REAL bin/gstack-gbrain-repo-policy
// script (its `set` verb owns the file schema + URL normalization).

describe("#2392: transcript ingest honors per-remote trust policy", () => {
  const POLICY_BIN = join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");

  /** Attributable temp git repo whose origin points at `remoteUrl`. */
  function makeRepoWithRemote(home: string, name: string, remoteUrl: string): string {
    const repo = join(home, "work", name);
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf-8", timeout: 30_000 });
    spawnSync("git", ["-C", repo, "remote", "add", "origin", remoteUrl], { encoding: "utf-8", timeout: 30_000 });
    return repo;
  }

  function writeSessionForRepo(home: string, projectName: string, sessionId: string, cwd: string): void {
    const record = JSON.stringify({
      type: "user",
      message: { role: "user", content: `hello from ${sessionId}` },
      timestamp: new Date().toISOString(),
      cwd,
    });
    writeClaudeCodeSession(home, projectName, sessionId, record + "\n");
  }

  function setPolicy(gstackHome: string, url: string, tier: string): void {
    const r = spawnSync(POLICY_BIN, ["set", url, tier], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
  }

  function stateSessions(gstackHome: string): string[] {
    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    if (!existsSync(statePath)) return [];
    return Object.keys(JSON.parse(readFileSync(statePath, "utf-8")).sessions || {});
  }

  it("(a) deny remote's transcript is skipped and counted as skipped_policy_deny", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile } = installFakeGbrain(home);

    const denyCwd = makeRepoWithRemote(home, "denied", "https://github.com/denyme/denied.git");
    const okCwd = makeRepoWithRemote(home, "allowed", "https://github.com/okorg/okrepo.git");
    writeSessionForRepo(home, "work-denied", "denysess1", denyCwd);
    writeSessionForRepo(home, "work-allowed", "oksess1", okCwd);
    setPolicy(gstackHome, "https://github.com/denyme/denied.git", "deny");

    const r = runScript(["--bulk", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/written:\s+1/);
    expect(r.stdout).toMatch(/skipped \(policy deny\):\s+1/);
    expect(r.stdout).not.toMatch(/skipped \(policy read-only\)/);

    // Only the allowed session was imported + state-recorded.
    expect(existsSync(logFile)).toBe(true);
    const sessions = stateSessions(gstackHome);
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toContain("oksess1");

    rmSync(home, { recursive: true, force: true });
  });

  it("(b) read-only remote's transcript is skipped and counted as skipped_policy_readonly", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir } = installFakeGbrain(home);

    const roCwd = makeRepoWithRemote(home, "readonly", "https://github.com/roorg/rorepo.git");
    const okCwd = makeRepoWithRemote(home, "allowed", "https://github.com/okorg/okrepo.git");
    writeSessionForRepo(home, "work-readonly", "rosess1", roCwd);
    writeSessionForRepo(home, "work-allowed", "oksess1", okCwd);
    setPolicy(gstackHome, "https://github.com/roorg/rorepo.git", "read-only");

    const r = runScript(["--bulk", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/written:\s+1/);
    expect(r.stdout).toMatch(/skipped \(policy read-only\):\s+1/);
    const sessions = stateSessions(gstackHome);
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toContain("oksess1");

    rmSync(home, { recursive: true, force: true });
  });

  it("(c) read-write remote's transcript is ingested (reaches gbrain import)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile } = installFakeGbrain(home);

    const rwCwd = makeRepoWithRemote(home, "readwrite", "https://github.com/rworg/rwrepo.git");
    writeSessionForRepo(home, "work-readwrite", "rwsess1", rwCwd);
    setPolicy(gstackHome, "https://github.com/rworg/rwrepo.git", "read-write");

    const r = runScript(["--bulk", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/written:\s+1/);
    expect(r.stdout).not.toMatch(/skipped \(policy/);
    // gbrain import ran exactly once — the page reached the import stage.
    const calls = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    expect(calls.length).toBe(1);
    expect(stateSessions(gstackHome).length).toBe(1);

    rmSync(home, { recursive: true, force: true });
  });

  it("(d) corrupted store: hard error before any writes, message names recovery", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir, logFile } = installFakeGbrain(home);

    const cwd = makeRepoWithRemote(home, "somerepo", "https://github.com/some/repo.git");
    writeSessionForRepo(home, "work-somerepo", "somesess1", cwd);
    // Corrupt store — the batch verb refuses (exit 2), the client classifies
    // `unreadable`, and ingest must abort rather than bypass a set policy.
    writeFileSync(join(gstackHome, "gbrain-repo-policy.json"), "not valid json{", "utf-8");

    const r = runScript(["--bulk", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/\[memory-ingest\] ERR:.*repo policy store exists/);
    expect(r.stderr).toContain("gstack-gbrain-repo-policy list");
    expect(r.stderr).toContain("/setup-gbrain");
    // Nothing written: no gbrain import call, no state file, store untouched.
    expect(existsSync(logFile)).toBe(false);
    expect(stateSessions(gstackHome).length).toBe(0);
    expect(readFileSync(join(gstackHome, "gbrain-repo-policy.json"), "utf-8")).toBe("not valid json{");

    rmSync(home, { recursive: true, force: true });
  });

  it("(e) no store at all: no policy filtering, transcript ingests normally", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir } = installFakeGbrain(home);

    const cwd = makeRepoWithRemote(home, "freerepo", "https://github.com/free/repo.git");
    writeSessionForRepo(home, "work-freerepo", "freesess1", cwd);

    const r = runScript(["--bulk", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/written:\s+1/);
    expect(r.stdout).not.toMatch(/skipped \(policy/);
    expect(stateSessions(gstackHome).length).toBe(1);

    rmSync(home, { recursive: true, force: true });
  });

  it("(f) probe policy parity: a denied remote's transcript lands in skipped_policy_deny, not new_count", () => {
    // --probe used to count policy-denied transcripts as ingestible (it only
    // applied attribution), so its numbers overstated what --bulk would write.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const denyCwd = makeRepoWithRemote(home, "denied", "https://github.com/denyme/denied.git");
    writeSessionForRepo(home, "work-denied", "denysess1", denyCwd);
    setPolicy(gstackHome, "https://github.com/denyme/denied.git", "deny");

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 0");
    expect(r.stdout).toMatch(/New \(never ingested\):\s+0/);
    expect(r.stdout).toMatch(/Skipped \(policy deny\):\s+1/);
    expect(r.stdout).not.toMatch(/Skipped \(policy read-only\)/);
    rmSync(home, { recursive: true, force: true });
  });

  it("(g) probe policy parity: a read-only remote's transcript lands in skipped_policy_readonly", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const roCwd = makeRepoWithRemote(home, "readonly", "https://github.com/roorg/rorepo.git");
    writeSessionForRepo(home, "work-readonly", "rosess1", roCwd);
    setPolicy(gstackHome, "https://github.com/roorg/rorepo.git", "read-only");

    const r = runScript(["--probe"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Total files in window: 0");
    expect(r.stdout).toMatch(/Skipped \(policy read-only\):\s+1/);
    rmSync(home, { recursive: true, force: true });
  });

  it("(h) --limit counts policy-PERMITTED pages only: a denied-first corpus still writes the allowed page", () => {
    // Walk order is deterministic here: Claude Code projects are walked
    // BEFORE Codex sessions (walkAllSources), so the DENIED transcript is
    // prepared first. Pre-fix, --limit 1 was applied to the unfiltered
    // prepared array — the denied record consumed the limit and the permitted
    // one starved (written: 0).
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const { binDir } = installFakeGbrain(home);

    const denyCwd = makeRepoWithRemote(home, "denied", "https://github.com/denyme/denied.git");
    writeSessionForRepo(home, "work-denied", "denysess1", denyCwd); // Claude Code: walked first
    const okCwd = makeRepoWithRemote(home, "allowed", "https://github.com/okorg/okrepo.git");
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    writeCodexSession(
      home, ymd,
      `{"type":"session_meta","payload":{"id":"oksess-codex","cwd":"${okCwd.replace(/\\/g, "\\\\")}"},"timestamp":"${today.toISOString()}"}\n`,
    );
    setPolicy(gstackHome, "https://github.com/denyme/denied.git", "deny");

    const r = runScript(["--bulk", "--quiet", "--limit", "1"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/written:\s+1/);
    expect(r.stdout).toMatch(/skipped \(policy deny\):\s+1/);
    // The page that landed is the PERMITTED one (the Codex session), not
    // whichever record happened to be walked first.
    const sessions = stateSessions(gstackHome);
    expect(sessions.length).toBe(1);
    expect(sessions[0]).toContain("rollout-");

    rmSync(home, { recursive: true, force: true });
  });

  it("artifacts are never policy-filtered, even when their project's remote is denied", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(join(gstackHome, "projects", "denyme-denied"), { recursive: true });
    const { binDir } = installFakeGbrain(home);

    // A learning artifact under a project slug matching a denied remote —
    // the policy is keyed by git remote, which artifacts don't have.
    writeFileSync(join(gstackHome, "projects", "denyme-denied", "learnings.jsonl"), '{"key":"a","insight":"b"}\n');
    setPolicy(gstackHome, "https://github.com/denyme/denied.git", "deny");

    const r = runScript(["--bulk", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
      PATH: `${binDir}:${process.env.PATH || ""}`,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/written:\s+1/);
    expect(r.stdout).not.toMatch(/skipped \(policy/);

    rmSync(home, { recursive: true, force: true });
  });
});
