import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const UPDATE_CHECK = join(ROOT, "bin", "gstack-update-check");

const cleanupDirs: string[] = [];

function sh(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function makeInstallPair() {
  const tmp = mkdtempSync(join(tmpdir(), "gstack-update-check-"));
  cleanupDirs.push(tmp);

  const origin = join(tmp, "origin");
  const install = join(tmp, "install");
  const state = join(tmp, "state");
  mkdirSync(origin, { recursive: true });
  mkdirSync(join(origin, "bin"), { recursive: true });
  mkdirSync(state, { recursive: true });

  writeFileSync(join(origin, "VERSION"), "1.0.0\n");
  writeFileSync(join(origin, "bin", "gstack-config"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(origin, "bin", "gstack-config"), 0o755);

  sh(["git", "init", "-q", "-b", "main"], origin);
  sh(["git", "add", "VERSION", "bin/gstack-config"], origin);
  sh(["git", "commit", "-q", "-m", "initial"], origin);
  sh(["git", "clone", "-q", origin, install], tmp);

  writeFileSync(join(origin, "VERSION"), "1.0.1\n");
  sh(["git", "add", "VERSION"], origin);
  sh(["git", "commit", "-q", "-m", "release 1.0.1"], origin);

  return { tmp, origin, install, state };
}

function runUpdateCheck(repo: ReturnType<typeof makeInstallPair>, args: string[]) {
  return spawnSync("bash", [UPDATE_CHECK, ...args], {
    cwd: repo.install,
    encoding: "utf-8",
    timeout: 10_000,
    env: {
      ...process.env,
      GSTACK_DIR: repo.install,
      GSTACK_STATE_DIR: repo.state,
      GSTACK_REMOTE_URL: `file://${join(repo.origin, "VERSION")}`,
    },
  });
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gstack-update-check --apply", () => {
  test("report-only check leaves the install unchanged", () => {
    const repo = makeInstallPair();
    const result = runUpdateCheck(repo, ["--force"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("UPGRADE_AVAILABLE 1.0.0 1.0.1");
    expect(readFileSync(join(repo.install, "VERSION"), "utf-8").trim()).toBe("1.0.0");
  });

  test("fast-forwards the install and writes the just-upgraded marker", () => {
    const repo = makeInstallPair();
    const result = runUpdateCheck(repo, ["--force", "--apply"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("UPGRADED 1.0.0 1.0.1");
    expect(readFileSync(join(repo.install, "VERSION"), "utf-8").trim()).toBe("1.0.1");
    expect(readFileSync(join(repo.state, "just-upgraded-from"), "utf-8").trim()).toBe("1.0.0");
    expect(existsSync(join(repo.state, "last-update-check"))).toBe(false);
  });
});
