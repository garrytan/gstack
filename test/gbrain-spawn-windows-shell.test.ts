import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { bashScriptInvocation } from "../lib/gbrain-exec";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

// #1731 tripwire. Windows can't spawn the `gbrain` shim (gbrain.cmd) or the bash
// shebang script gstack-brain-sync without a shell; the fix gates `shell: true`
// behind NEEDS_SHELL_ON_WINDOWS. These static checks fail CI if a refactor adds
// a gbrain/brain-sync child spawn without the Windows shell flag, since macOS/
// Linux CI can't exercise the Windows path at runtime.
describe("#1731 gbrain spawns carry the Windows shell flag", () => {
  test("NEEDS_SHELL_ON_WINDOWS is platform-gated in gbrain-exec.ts", () => {
    const src = read("lib/gbrain-exec.ts");
    expect(src).toMatch(/export const NEEDS_SHELL_ON_WINDOWS\s*=\s*process\.platform === "win32"/);
  });

  // Every direct `gbrain` child spawn in these files must be matched by a
  // shell:NEEDS_SHELL_ON_WINDOWS flag. Count openers vs flags as a cheap,
  // refactor-resistant invariant.
  const gbrainSpawnFiles = [
    "lib/gbrain-exec.ts",
    "lib/gbrain-sources.ts",
    "lib/gbrain-local-status.ts",
  ];
  for (const rel of gbrainSpawnFiles) {
    test(`${rel}: every gbrain spawn has shell:NEEDS_SHELL_ON_WINDOWS`, () => {
      const src = read(rel);
      const spawnOpeners = src.match(/(spawnSync|spawn|execFileSync)\("gbrain"/g)?.length ?? 0;
      const shellFlags = src.match(/shell:\s*NEEDS_SHELL_ON_WINDOWS/g)?.length ?? 0;
      expect(spawnOpeners).toBeGreaterThan(0);
      expect(shellFlags).toBeGreaterThanOrEqual(spawnOpeners);
    });
  }

  // NOT the brain-sync script. `shell: true` is right for the gbrain.cmd shim
  // and wrong for a bash shebang script: cmd.exe resolves .cmd/.bat via PATHEXT
  // and has no concept of a shebang, so gstack-brain-sync came back as "is not
  // recognized as an internal or external command" on EVERY Windows run. It
  // needs an interpreter, not a shell — see bashScriptInvocation.
  test("orchestrator invokes brain-sync through bash, never a raw spawn", () => {
    const src = read("bin/gstack-gbrain-sync.ts");
    expect(src).toMatch(/bashScriptInvocation\(brainSyncPath, \["--discover-new"\]\)/);
    expect(src).toMatch(/bashScriptInvocation\(brainSyncPath, \["--once"\]\)/);
    // The old shape must not come back: it fails silently-ish on Windows.
    expect(src).not.toMatch(/spawnSync\(brainSyncPath,/);
    expect(src).not.toMatch(/spawnSync\(brainSyncPath,[\s\S]*?shell:\s*NEEDS_SHELL_ON_WINDOWS/);
  });
});

describe("bashScriptInvocation", () => {
  const WIN_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

  test("POSIX execs the script directly, no interpreter needed", () => {
    const inv = bashScriptInvocation("/home/u/.claude/skills/gstack/bin/gstack-brain-sync", ["--once"], {
      platform: "linux",
    });
    expect(inv).toEqual({
      cmd: "/home/u/.claude/skills/gstack/bin/gstack-brain-sync",
      argv: ["--once"],
      shell: false,
    });
  });

  test("Windows routes through Git bash with the script as argv[0]", () => {
    const inv = bashScriptInvocation("C:\\Users\\u\\.claude\\skills\\gstack\\bin\\gstack-brain-sync", ["--once"], {
      platform: "win32",
      exists: (p) => p === WIN_BASH,
      env: {},
    });
    expect(inv?.cmd).toBe(WIN_BASH);
    expect(inv?.argv[1]).toBe("--once");
  });

  test("Windows forward-slashes the script path", () => {
    // bash treats backslashes as escapes, so a verbatim Windows path loses its
    // separators and the script is never found.
    const inv = bashScriptInvocation("C:\\Users\\u\\bin\\gstack-brain-sync", [], {
      platform: "win32",
      exists: (p) => p === WIN_BASH,
      env: {},
    });
    expect(inv?.argv[0]).toBe("C:/Users/u/bin/gstack-brain-sync");
    expect(inv?.argv[0]).not.toContain("\\");
  });

  test("never asks for a shell — cmd.exe is what broke this", () => {
    const inv = bashScriptInvocation("C:\\x\\gstack-brain-sync", [], {
      platform: "win32",
      exists: (p) => p === WIN_BASH,
      env: {},
    });
    expect(inv?.shell).toBe(false);
  });

  test("GSTACK_BASH overrides the search for unusual installs", () => {
    const custom = "D:\\tools\\git\\bin\\bash.exe";
    const inv = bashScriptInvocation("C:\\x\\gstack-brain-sync", [], {
      platform: "win32",
      exists: (p) => p === custom || p === WIN_BASH,
      env: { GSTACK_BASH: custom },
    });
    expect(inv?.cmd).toBe(custom);
  });

  test("returns null when Windows has no bash, so the caller can say why", () => {
    const inv = bashScriptInvocation("C:\\x\\gstack-brain-sync", [], {
      platform: "win32",
      exists: () => false,
      env: {},
    });
    expect(inv).toBeNull();
  });
});
