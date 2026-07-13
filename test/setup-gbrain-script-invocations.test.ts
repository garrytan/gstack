import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const template = readFileSync(
  join(import.meta.dir, "..", "setup-gbrain", "SKILL.md.tmpl"),
  "utf-8",
);

describe("setup-gbrain script invocations", () => {
  test("runs the TypeScript transcript probe through Bun", () => {
    expect(template).toContain(
      "bun run ~/.claude/skills/gstack/bin/gstack-memory-ingest.ts --probe",
    );
  });

  test("runs the TypeScript full sync through Bun", () => {
    expect(template).toContain(
      "bun run ~/.claude/skills/gstack/bin/gstack-gbrain-sync.ts --full --no-brain-sync",
    );
  });
});
