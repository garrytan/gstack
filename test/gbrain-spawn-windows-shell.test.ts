import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

// Windows command shims require special PATHEXT/shebang handling. cross-spawn
// supplies that adapter without exposing gbrain arguments to `cmd.exe` through
// Node's shell:true command-string path.
describe("#1731 gbrain spawns use the shell-free Windows adapter", () => {
  test("centralized gbrain execution uses cross-spawn without shell:true", () => {
    const src = read("lib/gbrain-exec.ts");
    expect(src).toContain('import crossSpawn from "cross-spawn"');
    expect(src).not.toMatch(/^\s*shell\s*:/m);
    expect(src.match(/crossSpawn\.sync\("gbrain"/g)?.length).toBe(2);
    expect(src.match(/crossSpawn\("gbrain"/g)?.length).toBe(1);
  });

  test("gbrain source IDs and paths route through the shell-free adapter", () => {
    const src = read("lib/gbrain-sources.ts");
    expect(src).not.toMatch(/(spawnSync|execFileSync)\("gbrain"/);
    expect(src).not.toContain("NEEDS_SHELL_ON_WINDOWS");
    expect(src).toContain("spawnGbrain(addArgs");
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
