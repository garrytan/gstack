import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { bashScriptInvocation, gbrainInvocation, windowsShellQuote } from "../lib/gbrain-exec";

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

  // #2471 upgraded the #1731 invariant for the seamed files: gbrain spawns
  // there must build their (cmd, argv, shell) triple via gbrainInvocation()
  // (which owns BOTH the shell flag and cmd.exe quoting), so a direct
  // `spawn*("gbrain"` opener is itself the violation.
  const seamedFiles = ["lib/gbrain-exec.ts", "lib/gbrain-sources.ts"];
  for (const rel of seamedFiles) {
    test(`${rel}: gbrain spawns route through gbrainInvocation (no direct openers)`, () => {
      const src = read(rel);
      const directOpeners = src.match(/(spawnSync|spawn|execFileSync)\(\s*["']gbrain["']/g)?.length ?? 0;
      expect(directOpeners).toBe(0);
      expect(src).toContain("gbrainInvocation(");
    });
  }

  // Not-yet-seamed file: every direct gbrain spawn must still carry the
  // #1731 shell flag. (Migrate to gbrainInvocation when next touched.)
  test("lib/gbrain-local-status.ts: every gbrain spawn has shell:NEEDS_SHELL_ON_WINDOWS", () => {
    const src = read("lib/gbrain-local-status.ts");
    const spawnOpeners = src.match(/(spawnSync|spawn|execFileSync)\("gbrain"/g)?.length ?? 0;
    const shellFlags = src.match(/shell:\s*NEEDS_SHELL_ON_WINDOWS/g)?.length ?? 0;
    expect(spawnOpeners).toBeGreaterThan(0);
    expect(shellFlags).toBeGreaterThanOrEqual(spawnOpeners);
  });

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

// #2471: with `shell: true` on Windows, node/bun JOIN argv into one cmd.exe
// string without quoting — a path with a space (`C:\Users\First Last\repo`)
// splits into two arguments and `gbrain sources add --path` targets the wrong
// directory. The invocation seam quotes every risky argument exactly once.
describe("#2471 gbrain invocation seam quotes for cmd.exe", () => {
  test("safe charset passes through untouched", () => {
    expect(windowsShellQuote("sources")).toBe("sources");
    expect(windowsShellQuote("--json")).toBe("--json");
    expect(windowsShellQuote("C:\\Users\\j\\repo")).toBe("C:\\Users\\j\\repo");
  });

  test("a path with a space is double-quoted", () => {
    expect(windowsShellQuote("C:\\Users\\First Last\\repo")).toBe('"C:\\Users\\First Last\\repo"');
  });

  test("embedded quotes are doubled (cmd.exe escape)", () => {
    expect(windowsShellQuote('we"ird')).toBe('"we""ird"');
  });

  test("empty argument stays a quoted empty string, not vanishing", () => {
    expect(windowsShellQuote("")).toBe('""');
  });

  test("shell metacharacters are wrapped so cmd.exe cannot interpret them", () => {
    for (const bad of ["a b", "a&b", "a|b", "a>b", "a<b", "a^b", "a(b)", "a;b"]) {
      expect(windowsShellQuote(bad).startsWith('"')).toBe(true);
    }
  });

  test("gbrainInvocation on POSIX is a passthrough with shell:false", () => {
    if (process.platform === "win32") return; // the win32 half is the map+quote path above
    const inv = gbrainInvocation(["sources", "add", "id", "--path", "/a dir/with space"]);
    expect(inv).toEqual({ cmd: "gbrain", argv: ["sources", "add", "id", "--path", "/a dir/with space"], shell: false });
  });

  test("no direct un-seamed gbrain spawn remains in gbrain-sources.ts", () => {
    const src = read("lib/gbrain-sources.ts");
    expect(src).not.toMatch(/spawnSync\(\s*["']gbrain["']/);
    expect(src).not.toMatch(/execFileSync\(\s*["']gbrain["']/);
    expect(src).toContain("gbrainInvocation(");
  });
});
