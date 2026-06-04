import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(ROOT, "browse", "src", "cli.ts");

function readCodeOnly(): string {
  return fs.readFileSync(CLI, "utf-8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// #1835 tripwire. On Windows, detached child_process.spawn allocates a
// console window unless windowsHide:true is set. These static checks fail CI
// if any detached spawn path in cli.ts drops the Windows no-window flag.
describe("#1835 detached browse spawns hide Windows consoles", () => {
  test("Windows Node launcher spawn carries windowsHide:true", () => {
    const src = readCodeOnly();
    expect(src).toMatch(/spawn\(process\.execPath,[\s\S]{0,500}detached:\s*true[\s\S]{0,100}windowsHide:\s*true/);
  });

  test("non-Windows server nodeSpawn carries windowsHide:true", () => {
    const src = readCodeOnly();
    expect(src).toMatch(/nodeSpawn\('bun',[\s\S]{0,500}detached:\s*true[\s\S]{0,100}windowsHide:\s*true/);
  });

  test("every detached spawn site in cli.ts carries windowsHide:true", () => {
    const src = readCodeOnly();
    const detachedSpawns = src.match(/detached:\s*true/g)?.length ?? 0;
    const windowsHideFlags = src.match(/windowsHide:\s*true/g)?.length ?? 0;
    expect(detachedSpawns).toBeGreaterThan(0);
    expect(windowsHideFlags).toBeGreaterThanOrEqual(detachedSpawns);
  });
});
