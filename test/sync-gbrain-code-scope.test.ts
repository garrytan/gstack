/**
 * /sync-gbrain Step 3.5 offered a `--dream` call-graph build for any source
 * with pages, including one that holds no code pages (synced with gbrain's
 * default markdown strategy), where a build cannot help. On gbrain >= 0.60,
 * `code-def` for an impossible symbol answers `.status` (`ready` /
 * `out_of_scope`); probed live against gbrain 0.60.96. Runs the template's own
 * block against a stub gbrain; older gbrain or a probe error keeps the old
 * behavior (`unknown`).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const TEMPLATE = join(import.meta.dir, "..", "sync-gbrain", "SKILL.md.tmpl");
const SRC = "gstack-code-app-1a2b3c4d";
const block = () => {
  const blocks = [...readFileSync(TEMPLATE, "utf-8").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
  return blocks.find((b) => b.includes('echo "code scope for $SOURCE_ID'))!;
};

describe("sync-gbrain Step 3.5 code-scope probe", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-code-scope-"));
    const capDir = join(home, ".claude", "skills", "gstack", "bin");
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, "gstack-gbrain-read-capability.ts"), `console.log(JSON.stringify({ status: "source", source_id: ${JSON.stringify(SRC)} }));\n`);
    mkdirSync(join(home, "bin"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function scope(codeDef: string, exit = 0): string {
    writeFileSync(join(home, "code-def.out"), codeDef);
    writeFileSync(join(home, "bin", "gbrain"), `#!/bin/sh
case "$1" in
  doctor) echo '{"checks":[]}' ;;
  code-def) [ "$4" = "${SRC}" ] || exit 9; cat "${join(home, "code-def.out")}"; exit ${exit} ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const bunDir = process.execPath.replace(/\/[^/]+$/, "");
    const r = spawnSync("bash", ["-c", block()], { env: { HOME: home, PATH: `${join(home, "bin")}:${bunDir}:/usr/bin:/bin` }, encoding: "utf-8", timeout: 30_000 });
    return (r.stdout || "").trim().split("\n").find((l) => l.startsWith("code scope for"))!;
  }

  it("a source holding code reports ready (log lines before the JSON are skipped)", () => {
    expect(scope(`[code-def] resolving\n{\n  "status": "ready",\n  "count": 0\n}\n`)).toBe(`code scope for ${SRC}: ready`);
  });
  it("a markdown-only source reports out_of_scope", () => {
    expect(scope(`{"status":"out_of_scope","count":0}\n`)).toBe(`code scope for ${SRC}: out_of_scope`);
  });
  it("gbrain below 0.60 (no status field) stays unknown, so the offer is unchanged", () => {
    expect(scope(`{"count":0,"results":[]}\n`)).toBe(`code scope for ${SRC}: unknown`);
  });
  it("a probe error stays unknown", () => {
    expect(scope("error: no such source\n", 1)).toBe(`code scope for ${SRC}: unknown`);
  });
  it("the offer is gated on the probe: out_of_scope reports the cause instead of asking", () => {
    const tmpl = readFileSync(TEMPLATE, "utf-8");
    expect(tmpl).toContain("If `CODE_SCOPE == out_of_scope`, do not offer a build");
    expect(tmpl).toContain("If `CYCLE == never` AND `CODE_SCOPE` is `ready` or `unknown`");
  });
});
