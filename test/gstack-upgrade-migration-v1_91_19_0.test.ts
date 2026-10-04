/**
 * v1.91.19.0 migration:
 * step 1 records a pending memory-ingest reconcile (A1) without calling gbrain.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const MIGRATION = path.join(ROOT, "gstack-upgrade", "migrations", "v1.91.19.0.sh");

let home: string;
let gstackHome: string;
let bin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mig-v1.91.19-"));
  gstackHome = path.join(home, ".gstack");
  bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gbrain"), `#!/bin/sh\necho "$@" >> "${home}/gbrain-calls.log"\nexit 1\n`, { mode: 0o755 });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function gitIsolation() {
  return { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
}

function run() {
  const r = spawnSync("bash", [MIGRATION], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GSTACK_HOME: gstackHome, ...gitIsolation() },
    encoding: "utf-8",
    cwd: home,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describe("v1.91.19.0 migration: memory reconcile pending (A1)", () => {
  test("marks a reconcile pending on an existing ingest state and never calls gbrain", () => {
    fs.mkdirSync(gstackHome, { recursive: true });
    const statePath = path.join(gstackHome, ".transcript-ingest-state.json");
    fs.writeFileSync(statePath, JSON.stringify({
      schema_version: 1, last_writer: "gstack-memory-ingest",
      sessions: { "/t/a.jsonl": { mtime_ns: 1, sha256: "h", ingested_at: "2026-09-01T00:00:00Z", page_slug: "transcripts/x/a" } },
    }));
    const first = run();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("reconcile pending");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(2);
    expect(state.reconcile.pending).toBe(true);
    expect(state.sessions["/t/a.jsonl"]).toMatchObject({ status: "ingested", source_id: "default" });
    expect(run().code).toBe(0);
    expect(fs.existsSync(path.join(home, "gbrain-calls.log"))).toBe(false);
  });

  test("is a no-op without an ingest state", () => {
    expect(run().code).toBe(0);
    expect(fs.existsSync(path.join(gstackHome, ".transcript-ingest-state.json"))).toBe(false);
  });
});

describe("v1.91.19.0 migration: artifacts remote repair (A8, #1437)", () => {
  const NEW = "https://github.com/acme/gstack-artifacts-dev";
  const OLD = "https://github.com/acme/gstack-brain-dev";
  function gh(views: string[]) {
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${home}/gh-calls.log"
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") for r in ${views.join(" ")}; do [ "$3" = "$r" ] && exit 0; done; exit 1 ;;
esac
exit 1
`, { mode: 0o755 });
  }
  const remote = () => fs.readFileSync(path.join(home, ".gstack-artifacts-remote.txt"), "utf-8").trim();
  const ghCalls = () => (fs.existsSync(path.join(home, "gh-calls.log")) ? fs.readFileSync(path.join(home, "gh-calls.log"), "utf-8") : "");

  test("restores the old URL (file and state-root origin) when only the old repo exists", () => {
    fs.writeFileSync(path.join(home, ".gstack-artifacts-remote.txt"), NEW + "\n");
    fs.mkdirSync(gstackHome, { recursive: true });
    for (const a of [["init", "-q", gstackHome], ["-C", gstackHome, "remote", "add", "origin", NEW]]) {
      expect(spawnSync("git", a, { timeout: 10_000, env: { ...process.env, ...gitIsolation() } }).status).toBe(0);
    }
    gh(["acme/gstack-brain-dev"]);
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`artifacts remote: restored ${OLD}`);
    expect(remote()).toBe(OLD);
    expect(spawnSync("git", ["-C", gstackHome, "remote", "get-url", "origin"], { encoding: "utf-8", timeout: 10_000, env: { ...process.env, ...gitIsolation() } }).stdout.trim()).toBe(OLD);
    expect(run().stdout).not.toContain("restored");
  });

  test("leaves a remote alone when the renamed repo exists", () => {
    fs.writeFileSync(path.join(home, ".gstack-artifacts-remote.txt"), NEW + "\n");
    gh(["acme/gstack-artifacts-dev", "acme/gstack-brain-dev"]);
    expect(run().code).toBe(0);
    expect(remote()).toBe(NEW);
  });

  test("without a signed-in gh, says so and changes nothing", () => {
    fs.writeFileSync(path.join(home, ".gstack-artifacts-remote.txt"), NEW + "\n");
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("could not confirm acme/gstack-artifacts-dev exists");
    expect(remote()).toBe(NEW);
  });

  test("never calls gh when the remote does not name a gstack-artifacts repo", () => {
    fs.writeFileSync(path.join(home, ".gstack-artifacts-remote.txt"), OLD + "\n");
    gh([]);
    expect(run().code).toBe(0);
    expect(ghCalls()).toBe("");
    expect(remote()).toBe(OLD);
  });
});
