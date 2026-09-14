import { describe, test, expect } from "bun:test";
import fs from "fs";
import path from "path";

// Static-grep tripwire for #1771. The Responses API rejects pairing a
// `gpt-4o` orchestrator with `image_generation` tool spec'd as
// `model: "gpt-image-2"` (400). `gpt-image-2` is only valid under a
// `gpt-5` orchestrator; with `gpt-4o` the tool must omit the `model`
// field (defaults to `gpt-image-1`).
//
// Regression history: v1.43.2.0 (commit 66f3a180, 2026-05-21) added
// `model: "gpt-image-2"` next to the existing `model: "gpt-4o"`
// orchestrator across variants / iterate / evolve, taking all five
// `design` subcommands (`generate`, `variants`, `iterate`, `evolve`,
// `/design-shotgun`) offline with a generic
// `400 invalid_request_error`. This tripwire fails CI if any
// `design/src/*.ts` file reintroduces the unsupported pairing.
//
// To re-enable `gpt-image-2`, the orchestrator must also be bumped to
// `gpt-5` in the SAME diff — the tripwire allows that because the
// `gpt-4o` literal is no longer present alongside the `gpt-image-2`
// literal at that point.

const DESIGN_SRC = path.join(import.meta.dir, "..", "src");
const FORBIDDEN_TOOL_MODEL = `model: "gpt-image-2"`;
const ORCHESTRATOR_GPT_4O = `model: "gpt-4o"`;

describe("design image-generation tool/orchestrator pairing (#1771)", () => {
  const sources = fs
    .readdirSync(DESIGN_SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(DESIGN_SRC, f));

  for (const source of sources) {
    const rel = path.relative(path.join(import.meta.dir, ".."), source);
    test(`${rel} must not pair gpt-4o orchestrator with gpt-image-2 tool`, () => {
      const body = fs.readFileSync(source, "utf-8");
      const hasForbiddenTool = body.includes(FORBIDDEN_TOOL_MODEL);
      const hasGpt4o = body.includes(ORCHESTRATOR_GPT_4O);
      // Forbidden pairing = both literals present in the same module.
      // Either-or alone is fine: a module that only uses gpt-4o is
      // OK (default tool model is gpt-image-1); a module that only
      // uses gpt-image-2 with a non-gpt-4o orchestrator (e.g.
      // gpt-5) is OK.
      expect(
        hasForbiddenTool && hasGpt4o,
        `${rel} pairs a gpt-4o orchestrator with image_generation`
          + ` tool model gpt-image-2; that combination 400s on the`
          + ` Responses API. Drop the tool's "model" field (defaults`
          + ` to gpt-image-1, works under gpt-4o) or bump the`
          + ` orchestrator off gpt-4o.`,
      ).toBe(false);
    });
  }
});
