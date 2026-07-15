import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectAutopilot, gbrainHome } from "../lib/gbrain-guards";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gbrain-guard-win-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("gbrain autopilot locks on Windows-safe paths", () => {
  test("current GBRAIN_HOME parent semantics resolve to the nested state directory", () => {
    const root = tempRoot();
    const state = join(root, ".gbrain");
    mkdirSync(state);
    const lock = join(state, "autopilot.lock");
    writeFileSync(lock, String(process.pid));

    expect(gbrainHome({ ...process.env, GBRAIN_HOME: root })).toBe(state);
    const result = detectAutopilot(
      { ...process.env, GBRAIN_HOME: root },
      { processRunning: () => false },
    );
    expect(result.active).toBe(true);
    expect(result.signal).toContain(lock);
  });

  test("legacy GBRAIN_HOME lock and pid files remain affirmative signals", () => {
    for (const name of ["autopilot.lock", "autopilot.pid"]) {
      const root = tempRoot();
      const legacy = join(root, name);
      writeFileSync(legacy, String(process.pid));

      const result = detectAutopilot(
        { ...process.env, GBRAIN_HOME: root },
        { processRunning: () => false },
      );
      expect(result.active).toBe(true);
      expect(result.signal).toContain(legacy);
    }
  });
});
