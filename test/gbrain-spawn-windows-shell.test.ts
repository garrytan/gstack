import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

// #1731 + DEV-206 tripwire. Bash helpers still need a shell on Windows, but
// gbrain itself must resolve to Bun's direct executable shim so argv values
// (notably worktree paths containing spaces) never pass through cmd.exe.
describe("Windows gbrain spawns preserve structural argv", () => {
  test("NEEDS_SHELL_ON_WINDOWS is platform-gated in gbrain-exec.ts", () => {
    const src = read("lib/gbrain-exec.ts");
    expect(src).toMatch(/export const NEEDS_SHELL_ON_WINDOWS\s*=\s*process\.platform === "win32"/);
  });

  test("gbrain-exec resolves a direct executable and disables shell parsing", () => {
    const src = read("lib/gbrain-exec.ts");
    expect(src).toContain('Bun.which("gbrain"');
    expect(src).toContain("planGbrainSpawn");
    expect(src).toContain("return { command, args: [...args], shell: false }");
    expect(src).not.toMatch(/(spawnSync|spawn|execFileSync)\("gbrain"/);
  });

  test("gbrain-sources routes registration through the structural helper", () => {
    const src = read("lib/gbrain-sources.ts");
    expect(src).toContain("spawnGbrain(addArgs");
    expect(src).toContain('spawnGbrain(["sources", "remove"');
    expect(src).not.toContain('spawnSync("gbrain"');
  });

  test("orchestrator brain-sync spawns carry the Windows shell flag", () => {
    const src = read("bin/gstack-gbrain-sync.ts");
    const brainSyncSpawns = src.match(/spawnSync\(brainSyncPath,/g)?.length ?? 0;
    expect(brainSyncSpawns).toBe(2);
    // Both spawnSync(brainSyncPath, ...) blocks must include the shell flag.
    const withShell = src.match(/spawnSync\(brainSyncPath,[\s\S]*?shell:\s*NEEDS_SHELL_ON_WINDOWS/g)?.length ?? 0;
    expect(withShell).toBe(2);
  });
});
