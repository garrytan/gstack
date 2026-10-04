/**
 * B9 (#2918 residual): /sync-gbrain Step 3.5 read CYCLE from
 * `gbrain doctor --json --fast`, which skips the DB checks that carry
 * cycle_freshness, so it always printed "unknown". This runs the template's
 * own bash block against a stub gbrain that behaves like real gbrain
 * (`--fast` omits cycle_freshness; a failing check makes doctor exit 1).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const TEMPLATE = join(import.meta.dir, "..", "sync-gbrain", "SKILL.md.tmpl");
const SRC = "gstack-code-app-1a2b3c4d";

function cycleBlock(): string {
  const tmpl = readFileSync(TEMPLATE, "utf-8");
  const blocks = [...tmpl.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.find((b) => b.includes('echo "call graph for $SOURCE_ID'));
  if (!block) throw new Error("cycle block not found in sync-gbrain/SKILL.md.tmpl");
  return block;
}

describe("sync-gbrain Step 3.5 cycle freshness block (B9)", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-cycle-block-"));
    const capDir = join(home, ".claude", "skills", "gstack", "bin");
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, "gstack-gbrain-read-capability.ts"), `console.log(JSON.stringify({ status: "source", source_id: ${JSON.stringify(SRC)} }));\n`);
    mkdirSync(join(home, "bin"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function run(fullReport: object | null, exitCode = 0): string {
    writeFileSync(join(home, "report.json"), JSON.stringify(fullReport ?? { checks: [{ name: "connection", status: "ok" }] }));
    writeFileSync(join(home, "bin", "gbrain"), `#!/bin/sh
case "$*" in
  "doctor --json --fast") echo '{"checks":[{"name":"connection","status":"ok"}]}' ;;
  "doctor --json --scope=brain") cat "${join(home, "report.json")}"; exit ${exitCode} ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const bunDir = process.execPath.replace(/\/[^/]+$/, "");
    const r = spawnSync("bash", ["-c", cycleBlock()], {
      env: { HOME: home, PATH: `${join(home, "bin")}:${bunDir}:/usr/bin:/bin` },
      encoding: "utf-8",
      timeout: 30_000,
    });
    return (r.stdout || "").trim();
  }

  it("reports never when this source never completed a cycle (doctor exits 1 on the failing check)", () => {
    const out = run({ checks: [{ name: "cycle_freshness", status: "fail", message: `Source '${SRC}' has never completed a full cycle; Source 'x' last cycled 30h ago. Run gbrain dream.` }] }, 1);
    expect(out).toBe(`call graph for ${SRC}: never`);
  });

  it("reports completed when cycle_freshness is ok", () => {
    expect(run({ checks: [{ name: "cycle_freshness", status: "ok", message: "All 2 federated source(s) cycled recently" }] })).toBe(`call graph for ${SRC}: completed`);
  });

  it("says the installed gbrain does not expose cycle_freshness when the check is absent", () => {
    expect(run(null)).toBe(`call graph for ${SRC}: unknown: installed gbrain does not expose cycle_freshness`);
  });
});
