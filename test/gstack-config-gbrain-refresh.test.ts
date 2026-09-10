/**
 * Regression coverage for #1967: Git Bash on Windows can put a native Windows
 * Python first on PATH. That Python cannot open MSYS-style /c/... paths, so
 * gstack-config must not let a Python JSON parse failure mask a valid detection
 * file as local-status: unknown.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const SOURCE_CONFIG = path.join(ROOT, "bin", "gstack-config");

let tmp: string;
let binDir: string;
let home: string;

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function runGbrainRefresh(): { code: number; out: string; err: string } {
  const r = spawnSync(path.join(binDir, "gstack-config"), ["gbrain-refresh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      GSTACK_HOME: home,
      GSTACK_STATE_ROOT: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return { code: r.status ?? 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-refresh-"));
  binDir = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(SOURCE_CONFIG, path.join(binDir, "gstack-config"));
  fs.chmodSync(path.join(binDir, "gstack-config"), 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gstack-config gbrain-refresh", () => {
  test("does not report unknown when PATH python cannot open the detection file", () => {
    writeExecutable(
      path.join(binDir, "gstack-gbrain-detect"),
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"gbrain_on_path":true,"gbrain_local_status":"ok","gbrain_version":"0.35.8.0"}'\n`,
    );
    writeExecutable(
      path.join(binDir, "python3"),
      `#!/usr/bin/env bash\necho "FileNotFoundError: native Windows Python cannot open this MSYS path" >&2\nexit 1\n`,
    );

    const r = runGbrainRefresh();

    expect(r.code).toBe(0);
    expect(r.out).toContain("Detected gbrain v0.35.8.0");
    expect(r.out).not.toContain("local-status: unknown");
  });
});
