import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { scanSerializedPage } from "../lib/gstack-memory-helpers";
import { scan } from "../lib/redact-engine";

const script = join(import.meta.dir, "../bin/gstack-memory-ingest.ts");
const homes: string[] = [];

function fixture(mode: string | null = "incremental") {
  const home = mkdtempSync(join(tmpdir(), "transcript-privacy-"));
  homes.push(home);
  const state = join(home, ".gstack");
  const bin = join(home, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  if (mode !== null) writeFileSync(join(state, "config.yaml"), `transcript_ingest_mode: ${mode}\n`);
  const capture = join(home, "capture.json");
  writeFileSync(join(bin, "gbrain"), `#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'fs';
import { join, relative } from 'path';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  if (process.env.REVOKE_AT_HELP) writeFileSync(join(process.env.GSTACK_HOME, 'config.yaml'), 'transcript_ingest_mode: off\\n');
  console.log('  import <dir>'); process.exit(0);
}
if (args[0] === 'import') {
  const pages = [];
  function walk(dir) { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.md')) pages.push({ path, body: readFileSync(path, 'utf8'), mode: statSync(path).mode & 511 }); } }
  walk(args[1]);
  writeFileSync(process.env.CAPTURE, JSON.stringify(pages));
  const cp = join(process.env.HOME, '.gbrain/import-checkpoint.json');
  const completed = !process.env.IGNORE_CHECKPOINT && existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')).completedPaths || [] : [];
  if (process.env.CHECKPOINT_ON_SIGNAL) {
    writeFileSync(join(process.env.HOME, 'importer.pid'), String(process.pid));
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', async () => {
      await Bun.sleep(50);
      mkdirSync(join(process.env.HOME, '.gbrain'), { recursive: true });
      writeFileSync(cp, JSON.stringify({ schema_version: 1, owner: 'gbrain', kind: 'import', dir: args[1], completedPaths: [], timestamp: new Date().toISOString() }));
      clearInterval(timer); process.exit(143);
    });
    await new Promise(() => {});
  }
  if (process.env.SAVE_CHECKPOINT) {
    mkdirSync(join(process.env.HOME, '.gbrain'), { recursive: true });
    writeFileSync(cp, JSON.stringify({ schema_version: 1, owner: 'gbrain', kind: 'import', dir: args[1], completedPaths: [relative(args[1], pages[0].path)], timestamp: new Date().toISOString() }));
    if (process.env.SAVE_AND_WAIT) {
      writeFileSync(join(process.env.HOME, 'importer.pid'), String(process.pid));
      const timer = setInterval(() => {}, 1000);
      process.on('SIGTERM', () => { clearInterval(timer); process.exit(143); });
      await new Promise(() => {});
    }
    process.exit(1);
  }
  if (process.env.REVOKE_AFTER_DISPATCH) writeFileSync(join(process.env.GSTACK_HOME, 'config.yaml'), 'transcript_ingest_mode: off\\n');
  if (process.env.REVOKE_RETRY && args.includes('--include-gitignored')) {
    writeFileSync(join(process.env.GSTACK_HOME, 'config.yaml'), 'transcript_ingest_mode: off\\n');
    console.error('unknown option --include-gitignored'); process.exit(1);
  }
  if (existsSync(cp)) rmSync(cp);
  const failures = process.env.FAIL_ONE ? [{ path: relative(args[1], pages[0].path), error: 'synthetic failure' }] : [];
  console.log(JSON.stringify({ imported: pages.length - completed.length - failures.length, skipped: failures.length, unchanged: 0, errors: failures.length, failures, total_files: pages.length }));
}
`);
  chmodSync(join(bin, "gbrain"), 0o755);
  const env = { ...process.env, HOME: home, GSTACK_HOME: state, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture };
  function session(body = "A useful design conversation", id = "session", timestamp = new Date().toISOString(), cwd = home) {
    const dir = join(home, ".claude/projects/project");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "user", timestamp, cwd, message: { role: "user", content: body } }) + "\n");
    return path;
  }
  function run(args: string[] = [], extra: Record<string, string> = {}, preload?: string) {
    return spawnSync("bun", [...(preload ? ["--preload", preload] : []), script, "--bulk", "--sources", "transcript", "--include-unattributed", ...args], {
      env: { ...env, ...extra }, cwd: home, encoding: "utf8", timeout: 20_000,
    });
  }
  return { home, state, bin, capture, env, session, run };
}

function pendingSnapshot(f: ReturnType<typeof fixture>): string {
  f.session("Older snapshot payload", "first");
  f.session("Second snapshot payload", "second");
  const result = f.run([], { SAVE_CHECKPOINT: "1" });
  expect(result.status).toBe(1);
  const cp = JSON.parse(readFileSync(join(f.home, ".gbrain/import-checkpoint.json"), "utf8"));
  expect(existsSync(cp.dir)).toBe(true);
  rmSync(f.capture);
  return cp.dir;
}

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("transcript privacy at the actual ingest entrypoint", () => {
  for (const choice of [undefined, "", "Z", "--probe"]) {
    it(`rejects missing or invalid enrollment ${JSON.stringify(choice)} without dispatch or state changes`, () => {
      const f = fixture();
      f.session();
      const config = readFileSync(join(f.state, "config.yaml"), "utf8");
      const result = f.run(choice === undefined ? ["--enroll"] : ["--enroll", choice]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--enroll requires");
      expect(existsSync(f.capture)).toBe(false);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
      expect(readFileSync(join(f.state, "config.yaml"), "utf8")).toBe(config);
    });
  }

  for (const mode of [null, "off", "bogus"]) {
    it(`does not dispatch or stamp when consent is ${mode ?? "unset"}`, () => {
      const f = fixture(mode);
      f.session();
      const result = f.run();
      expect(result.status).toBe(0);
      expect(existsSync(f.capture)).toBe(false);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
    });
  }

  it("imports clean pages using exact private serialized bytes", () => {
    const f = fixture();
    f.session();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const pages = JSON.parse(readFileSync(f.capture, "utf8"));
    expect(pages).toHaveLength(1);
    expect(pages[0].body).toContain("type: transcript");
    expect(pages[0].body).toContain("A useful design conversation");
    expect(pages[0].mode).toBe(0o600);
  });

  it("holds a rendered HIGH finding by default without stamping or exposing it", () => {
    const f = fixture();
    const marker = "ghp_" + "q9Xk3M2v8Bt5W4r6Z7c1D0sQaLhNfUjYePzR";
    f.session(`token = "${marker}"`);
    const result = f.run();
    expect(result.status).toBe(0);
    expect(existsSync(f.capture)).toBe(false);
    expect(result.stdout).toContain("skipped (secret-scan): 1");
    expect(result.stdout + result.stderr).not.toContain(marker);
    const stateFile = join(f.state, ".transcript-ingest-state.json");
    expect(existsSync(stateFile) ? Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).sessions) : []).toHaveLength(0);
  });

  it("probe leaves corrupt dedup and legacy policy bytes untouched", () => {
    const f = fixture("off");
    f.session();
    writeFileSync(join(f.state, ".transcript-ingest-state.json"), "broken-state");
    writeFileSync(join(f.state, "gbrain-repo-policy.json"), JSON.stringify({ "github.com/example/project": "allow" }));
    const before = readdirSync(f.state).sort();
    const result = f.run(["--probe"]);
    expect(result.status).toBe(0);
    expect(existsSync(f.capture)).toBe(false);
    expect(readdirSync(f.state).sort()).toEqual(before);
    expect(readFileSync(join(f.state, ".transcript-ingest-state.json"), "utf8")).toBe("broken-state");
    expect(result.stdout).toContain("Policy-eligible transcripts: 0");
  });

  for (const [name, body] of [["MEDIUM", "Reach Alice at alice@private-company.invalid"], ["frontmatter", "ordinary text"]]) {
    it(`holds ${name} findings and accepts a later clean retry`, () => {
      const f = fixture();
      const id = name === "frontmatter" ? "ghp_" + "q9Xk3M2v8Bt5W4r6Z7c1D0sQaLhNfUjYePzR" : "session";
      const source = f.session(body, id);
      const result = f.run(["--incremental"], { GSTACK_MEMORY_INGEST_SCAN_SECRETS: "0" });
      expect(result.status).toBe(0);
      expect(existsSync(f.capture)).toBe(false);
      expect(result.stdout).toContain("skipped (secret-scan): 1");
      rmSync(source);
      f.session("Clean retry", "clean");
      expect(f.run().status).toBe(0);
      expect(JSON.parse(readFileSync(f.capture, "utf8"))).toHaveLength(1);
    });
  }

  it("fails closed when the shared scanner throws or returns a malformed result", () => {
    for (const impl of ["throw new Error('synthetic')", "return {};"]) {
      const f = fixture();
      f.session();
      const preload = join(f.home, "scanner.ts");
      writeFileSync(preload, `import { mock } from 'bun:test'; mock.module(${JSON.stringify(join(import.meta.dir, "../lib/redact-engine.ts"))}, () => ({ scan: () => { ${impl} } }));`);
      const result = f.run([], {}, preload);
      expect(result.status).toBe(1);
      expect(existsSync(f.capture)).toBe(false);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
    }
  });

  it("bounds serialized inputs and keeps malformed UTF-8 fail closed", () => {
    expect(scanSerializedPage("").ok).toBe(false);
    expect(scanSerializedPage(Buffer.from([0xff])).ok).toBe(false);
    expect(scanSerializedPage("z".repeat(1024 * 1024 + 1)).reason).toContain("1 MiB");
    const low = "TODO(owner) keep useful context";
    const warn = "```codex-review\nfound your_aws_key " + "AKIA" + "IOSFODNN7EXAMPLE in code\n```";
    expect(scan(low).counts.LOW).toBeGreaterThan(0);
    expect(scanSerializedPage(low).ok).toBe(true);
    expect(scanSerializedPage(warn).ok).toBe(true);
  });

  it("rechecks consent after availability probing and before retry dispatch", () => {
    for (const at of ["REVOKE_AT_HELP", "REVOKE_RETRY"]) {
      const f = fixture();
      f.session();
      const result = f.run([], { [at]: "1" });
      expect(result.status).toBe(1);
      if (at === "REVOKE_AT_HELP") expect(existsSync(f.capture)).toBe(false);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
      expect(result.stderr).toContain("consent disabled before dispatch");
    }
  });

  it("does not claim to recall in-flight bytes; off blocks the next batch", () => {
    const f = fixture();
    f.session();
    expect(f.run([], { REVOKE_AFTER_DISPATCH: "1" }).status).toBe(0);
    expect(existsSync(f.capture)).toBe(true);
    rmSync(f.capture);
    f.session("A later conversation", "later");
    expect(f.run().status).toBe(0);
    expect(existsSync(f.capture)).toBe(false);
  });

  it("resumes the old snapshot with empty current prep and counts completed paths", () => {
    const f = fixture();
    const dir = pendingSnapshot(f);
    rmSync(join(f.home, ".claude/projects"), { recursive: true });
    const result = f.run(["--incremental"]);
    expect(result.status, result.stderr).toBe(0);
    const pages = JSON.parse(readFileSync(f.capture, "utf8"));
    expect(pages).toHaveLength(2);
    expect(pages.some((p: any) => p.body.includes("Older snapshot payload"))).toBe(true);
    expect(result.stdout).toMatch(/written:\s+2/);
    expect(existsSync(dir)).toBe(false);
  });

  it("accepts supported managed import accounting that revalidates the whole safe snapshot", () => {
    const f = fixture();
    pendingSnapshot(f);
    rmSync(join(f.home, ".claude/projects"), { recursive: true });
    const result = f.run([], { IGNORE_CHECKPOINT: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/written:\s+2/);
  });

  it("SIGTERM stops the active importer and preserves its owned checkpoint without stamps", async () => {
    const f = fixture();
    f.session();
    const child = spawn("bun", [script, "--bulk", "--sources", "transcript", "--include-unattributed"], {
      cwd: f.home, env: { ...f.env, SAVE_CHECKPOINT: "1", SAVE_AND_WAIT: "1" }, stdio: "ignore",
    });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const pidFile = join(f.home, "importer.pid");
    try {
      for (let attempt = 0; attempt < 300 && !existsSync(pidFile); attempt++) await Bun.sleep(10);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGTERM");
      expect(await exit).toBe(143);
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt++) {
        try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; }
      }
      expect(alive).toBe(false);
      const cp = JSON.parse(readFileSync(join(f.home, ".gbrain/import-checkpoint.json"), "utf8"));
      expect(existsSync(cp.dir)).toBe(true);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
      expect(existsSync(join(f.state, ".memory-ingest.lock"))).toBe(false);
    } finally {
      if (!child.killed) child.kill("SIGTERM");
    }
  }, 10_000);

  it("SIGTERM drains a late checkpoint writer before releasing the lock and retaining the snapshot", async () => {
    const f = fixture();
    f.session();
    const child = spawn("bun", [script, "--bulk", "--sources", "transcript", "--include-unattributed"], {
      cwd: f.home, env: { ...f.env, CHECKPOINT_ON_SIGNAL: "1" }, stdio: "ignore",
    });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const pidFile = join(f.home, "importer.pid");
    try {
      for (let attempt = 0; attempt < 300 && !existsSync(pidFile); attempt++) await Bun.sleep(10);
      expect(existsSync(pidFile)).toBe(true);
      expect(existsSync(join(f.home, ".gbrain/import-checkpoint.json"))).toBe(false);
      const pid = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGTERM");
      await Bun.sleep(10);
      expect(existsSync(join(f.state, ".memory-ingest.lock"))).toBe(true);
      expect(await exit).toBe(143);
      expect(() => process.kill(pid, 0)).toThrow();
      const cp = JSON.parse(readFileSync(join(f.home, ".gbrain/import-checkpoint.json"), "utf8"));
      expect(existsSync(cp.dir)).toBe(true);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
      expect(existsSync(join(f.state, ".memory-ingest.lock"))).toBe(false);
      expect(f.run().status).toBe(0);
    } finally {
      if (!child.killed) child.kill("SIGTERM");
    }
  }, 10_000);

  for (const damage of ["type", "source_path", "git_remote", "start_time", "quoted-type", "parse-error"]) {
    it(`holds ${damage} snapshot metadata without dispatch, stamps or content diagnostics`, () => {
      const f = fixture();
      const dir = pendingSnapshot(f);
      const cpPath = join(f.home, ".gbrain/import-checkpoint.json");
      const cpBefore = readFileSync(cpPath, "utf8");
      const manifestPath = join(dir, ".gstack-pages.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const pagePath = join(dir, manifest[0].slug + ".md");
      if (damage === "type") {
        manifest[0].type = "learning";
        manifest[0].source_path = join(f.state, "learning.md");
        writeFileSync(join(f.state, "config.yaml"), "transcript_ingest_mode: off\n");
      }
      if (damage === "source_path") manifest[0].source_path = join(f.home, ".claude/projects/project/unknown.jsonl");
      if (damage === "git_remote") manifest[0].git_remote = "github.com/another/project";
      if (damage === "start_time") manifest[0].start_time = "2000-01-01T00:00:00Z";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      if (damage === "quoted-type") {
        writeFileSync(pagePath, readFileSync(pagePath, "utf8").replace("type: transcript", 'type: learning\n"type": transcript'));
        rmSync(manifestPath);
        writeFileSync(join(f.state, "config.yaml"), "transcript_ingest_mode: off\n");
      }
      if (damage === "parse-error") writeFileSync(manifestPath, "SYNTHETIC_PRIVATE_IDENTIFIER");
      if (damage !== "quoted-type" && damage !== "parse-error") {
        expect(manifest[0].rendered_sha256).toBe(createHash("sha256").update(readFileSync(pagePath)).digest("hex"));
      }
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checkpoint held");
      expect(result.stderr + result.stdout).not.toContain("SYNTHETIC_PRIVATE_IDENTIFIER");
      expect(existsSync(f.capture)).toBe(false);
      expect(readFileSync(cpPath, "utf8")).toBe(cpBefore);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
    });
  }

  for (const damage of ["secret", "extra", "link", "legacy", "off"]) {
    it(`holds an unsafe ${damage} checkpoint without replacing it`, () => {
      const f = fixture();
      const dir = pendingSnapshot(f);
      const cpPath = join(f.home, ".gbrain/import-checkpoint.json");
      const cp = JSON.parse(readFileSync(cpPath, "utf8"));
      if (damage === "secret") writeFileSync(join(dir, cp.completedPaths[0]), "ghp_" + "q9Xk3M2v8Bt5W4r6Z7c1D0sQaLhNfUjYePzR");
      if (damage === "extra") writeFileSync(join(dir, "unexpected.txt"), "extra");
      if (damage === "link") symlinkSync(join(f.home, ".claude/projects"), join(dir, "link"));
      if (damage === "legacy") writeFileSync(cpPath, JSON.stringify({ dir, processedIndex: 0, totalFiles: 2 }));
      if (damage === "off") writeFileSync(join(f.state, "config.yaml"), "transcript_ingest_mode: off\n");
      const before = readFileSync(cpPath, "utf8");
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checkpoint held");
      expect(existsSync(f.capture)).toBe(false);
      expect(existsSync(dir)).toBe(true);
      expect(readFileSync(cpPath, "utf8")).toBe(before);
      expect(existsSync(join(f.state, ".transcript-ingest-state.json"))).toBe(false);
    });
  }

  it("uses per-file import failures without falsely stamping a rejected page", () => {
    const f = fixture();
    f.session("Clean first", "first");
    f.session("Clean second", "second");
    const result = f.run([], { FAIL_ONE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/written:\s+1/);
    const state = JSON.parse(readFileSync(join(f.state, ".transcript-ingest-state.json"), "utf8"));
    expect(Object.keys(state.sessions)).toHaveLength(1);
    expect(f.run(["--incremental"]).status).toBe(0);
    expect(JSON.parse(readFileSync(f.capture, "utf8"))).toHaveLength(1);
  });

  it("remote HTTP staging uses the same byte gate and never invokes local import", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "http://127.0.0.1:1" } } }));
    f.session("Clean remote page", "clean");
    f.session("ghp_" + "q9Xk3M2v8Bt5W4r6Z7c1D0sQaLhNfUjYePzR", "held");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.capture)).toBe(false);
    expect(result.stdout).toMatch(/written:\s+1/);
    expect(result.stdout).toContain("skipped (secret-scan): 1");
    expect(readdirSync(join(f.state, "transcripts"))).toHaveLength(1);
  });

  for (const [choice, expected] of [["A", 2], ["B", 3], ["C", 3], ["D", 1], ["E", 0]] as const) {
    it(`enrollment ${choice} enforces its actual repository/history scope`, () => {
      const f = fixture("off");
      const other = join(f.home, "other");
      mkdirSync(other);
      for (const [cwd, remote] of [[f.home, "https://github.com/example/current.git"], [other, "https://github.com/example/other.git"]]) {
        expect(spawnSync("git", ["init", "-q"], { cwd, timeout: 10_000 }).status).toBe(0);
        expect(spawnSync("git", ["remote", "add", "origin", remote], { cwd, timeout: 10_000 }).status).toBe(0);
      }
      f.session("Recent current", "recent", new Date(Date.now() - 1000).toISOString());
      f.session("Old current", "old", new Date(Date.now() - 120 * 86400_000).toISOString());
      f.session("Recent other", "other", new Date().toISOString(), other);
      const enrolled = f.run(["--enroll", choice]);
      expect(enrolled.status, enrolled.stderr).toBe(0);
      expect(existsSync(f.capture)).toBe(false);
      f.session("New current", "new", new Date(Date.now() + 1000).toISOString());
      const result = f.run(["--all-history"]);
      expect(result.status, result.stderr).toBe(0);
      const pages = existsSync(f.capture) ? JSON.parse(readFileSync(f.capture, "utf8")) : [];
      expect(pages).toHaveLength(expected);
      expect(readFileSync(join(f.state, "config.yaml"), "utf8")).toContain(choice === "E" ? "off" : "incremental");
    });
  }

  it("curated artifacts retain independent policy while transcripts are off", () => {
    const f = fixture("off");
    f.session();
    mkdirSync(join(f.state, "analytics"));
    writeFileSync(join(f.state, "analytics/eureka.jsonl"), '{"insight":"A curated learning"}\n');
    const result = f.run(["--sources", "transcript,eureka"]);
    expect(result.status, result.stderr).toBe(0);
    const pages = JSON.parse(readFileSync(f.capture, "utf8"));
    expect(pages).toHaveLength(1);
    expect(pages[0].body).toContain("type: eureka");
  });
});
