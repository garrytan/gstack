import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

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

  test("orchestrator brain-sync spawns carry the Windows shell flag", () => {
    const src = read("bin/gstack-gbrain-sync.ts");
    const brainSyncSpawns = src.match(/spawnSync\(brainSyncPath,/g)?.length ?? 0;
    expect(brainSyncSpawns).toBe(2);
    // Both spawnSync(brainSyncPath, ...) blocks must include the shell flag.
    const withShell = src.match(/spawnSync\(brainSyncPath,[\s\S]*?shell:\s*NEEDS_SHELL_ON_WINDOWS/g)?.length ?? 0;
    expect(withShell).toBe(2);
  });
});
