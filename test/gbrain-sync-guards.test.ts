import { describe, it, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";

import {
  autopilotLockPath,
  guardCodeSyncReclone,
  guardSourceRemoval,
  removeOrphanedSource,
} from "../bin/gstack-gbrain-sync";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts");
const BUN_BIN = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf-8" }).trim();

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "gbrain-sync-guards-"));
}

function makeShim(
  bindir: string,
  responses: Record<string, { stdout?: string; stderr?: string; exit?: number }>,
): { logPath: string } {
  const shim = join(bindir, "gbrain");
  const logPath = join(bindir, "gbrain.log");
  const cases = Object.entries(responses).map(([key, r]) => {
    const exit = r.exit ?? 0;
    const stdout = (r.stdout || "").replace(/'/g, "'\\''");
    const stderr = (r.stderr || "").replace(/'/g, "'\\''");
    return `  "${key}") printf '%s' '${stdout}'; printf '%s' '${stderr}' >&2; exit ${exit} ;;`;
  }).join("\n");
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${logPath.replace(/'/g, "'\\''")}'
ARGS="$*"
case "$ARGS" in
${cases}
  *) echo "shim: no match for [$ARGS]" >&2; exit 1 ;;
esac
`;
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return { logPath };
}

function envFor(tmp: string, bindir: string): NodeJS.ProcessEnv {
  const home = join(tmp, "home");
  const gstackHome = join(home, ".gstack");
  const gbrainHome = join(home, ".gbrain");
  mkdirSync(gstackHome, { recursive: true });
  mkdirSync(gbrainHome, { recursive: true });
  writeFileSync(
    join(gbrainHome, "config.json"),
    JSON.stringify({ engine: "pglite", database_url: "pglite:///fake" }),
  );
  return {
    ...process.env,
    HOME: home,
    GSTACK_HOME: gstackHome,
    GBRAIN_HOME: gbrainHome,
    PATH: `${bindir}:${process.env.PATH || ""}`,
  };
}

describe("gstack-gbrain-sync destructive guards", () => {
  it("refuses when gbrain autopilot.lock exists before spawning gbrain", () => {
    const tmp = makeTmp();
    const bindir = join(tmp, "bin");
    const repo = join(tmp, "repo");
    mkdirSync(bindir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const { logPath } = makeShim(bindir, {
      "--version": { stdout: "gbrain 0.35.0.0\n" },
    });
    const env = envFor(tmp, bindir);
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });

    const lockPath = autopilotLockPath(env);
    writeFileSync(lockPath, "12345\n");
    const r = spawnSync(BUN_BIN, [SCRIPT, "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: repo,
      env,
    });

    expect(r.status).toBe(1);
    expect(existsSync(logPath)).toBe(false);
    const state = JSON.parse(readFileSync(join(env.GSTACK_HOME!, ".gbrain-sync-state.json"), "utf-8"));
    expect(state.last_stages[0].summary).toContain(lockPath);
    expect(state.last_stages[0].summary).toContain("kill");
    expect(state.last_stages[0].summary).toContain("&& rm");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails closed before removing URL-managed sources outside ~/.gbrain/clones", () => {
    const tmp = makeTmp();
    const bindir = join(tmp, "bin");
    mkdirSync(bindir, { recursive: true });
    const env = envFor(tmp, bindir);
    const localPath = join(tmp, "repo");
    makeShim(bindir, {
      "sources show --json legacy-id": {
        stdout: JSON.stringify({
          id: "legacy-id",
          local_path: localPath,
          config: { remote_url: "https://github.com/example/repo.git" },
        }),
      },
    });

    const result = guardSourceRemoval("legacy-id", env, Date.now());

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.summary).toContain("refusing to remove URL-managed source legacy-id");
    expect(result!.summary).toContain("outside");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("allows URL-managed sources inside ~/.gbrain/clones and removes with --keep-storage", () => {
    const tmp = makeTmp();
    const bindir = join(tmp, "bin");
    mkdirSync(bindir, { recursive: true });
    const env = envFor(tmp, bindir);
    const clonePath = join(env.HOME!, ".gbrain", "clones", "legacy-id");
    mkdirSync(clonePath, { recursive: true });
    const { logPath } = makeShim(bindir, {
      "sources show --json legacy-id": {
        stdout: JSON.stringify({
          id: "legacy-id",
          local_path: clonePath,
          config: { remote_url: "https://github.com/example/repo.git" },
        }),
      },
      "sources remove legacy-id --keep-storage --confirm-destructive": { exit: 0 },
    });

    expect(guardSourceRemoval("legacy-id", env, Date.now())).toBeNull();
    expect(removeOrphanedSource("legacy-id", env)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toContain(
      "sources remove legacy-id --keep-storage --confirm-destructive",
    );
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails closed when sources show returns malformed JSON or exits non-zero", () => {
    const tmp = makeTmp();
    const bindir = join(tmp, "bin");
    mkdirSync(bindir, { recursive: true });
    const env = envFor(tmp, bindir);
    makeShim(bindir, {
      "sources show --json bad-json": { stdout: "{not-json" },
      "sources show --json exits-nonzero": { stderr: "db locked", exit: 2 },
    });

    const badJson = guardSourceRemoval("bad-json", env, Date.now());
    const nonzero = guardSourceRemoval("exits-nonzero", env, Date.now());

    expect(badJson!.ok).toBe(false);
    expect(badJson!.summary).toContain("malformed JSON");
    expect(nonzero!.ok).toBe(false);
    expect(nonzero!.summary).toContain("db locked");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips code sync for new sources with remote_url unless --allow-reclone is set", () => {
    const tmp = makeTmp();
    const bindir = join(tmp, "bin");
    mkdirSync(bindir, { recursive: true });
    const env = envFor(tmp, bindir);
    makeShim(bindir, {
      "sources show --json new-id": {
        stdout: JSON.stringify({
          id: "new-id",
          local_path: join(tmp, "repo"),
          remote_url: "https://github.com/example/repo.git",
        }),
      },
    });

    const denied = guardCodeSyncReclone("new-id", { allowReclone: false }, env, Date.now(), join(tmp, "repo"));
    const allowed = guardCodeSyncReclone("new-id", { allowReclone: true }, env, Date.now(), join(tmp, "repo"));

    expect(denied).not.toBeNull();
    expect(denied!.summary).toContain("skipping gbrain sync --strategy code");
    expect(denied!.summary).toContain("--allow-reclone");
    expect(allowed).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the happy path open when no remote_url is set", () => {
    const tmp = makeTmp();
    const bindir = join(tmp, "bin");
    mkdirSync(bindir, { recursive: true });
    const env = envFor(tmp, bindir);
    makeShim(bindir, {
      "sources show --json new-id": {
        stdout: JSON.stringify({ id: "new-id", local_path: join(tmp, "repo") }),
      },
    });

    expect(guardCodeSyncReclone("new-id", { allowReclone: false }, env, Date.now(), join(tmp, "repo"))).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});
