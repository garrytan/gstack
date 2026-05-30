/**
 * Regression pin: scripts/resolvers/gbrain.ts must emit `gbrain put <slug>`
 * (the v0.18+ subcommand), never the renamed `gbrain put_page`. The resolver
 * output ships into every generated SKILL.md file as user-facing
 * copy-paste instructions; using the old subcommand teaches every
 * gstack user to invoke a command that no longer exists.
 *
 * Two checks:
 *   1. Resolver source: scripts/resolvers/gbrain.ts has no `put_page`
 *      tokens in active strings (comments OK — one annotated reference
 *      explains the rename for future contributors).
 *   2. Generated SKILL.md: every tracked SKILL.md file is free of
 *      `gbrain put_page`. Run `bun run gen:skill-docs` if this fails.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const REPO_ROOT = join(import.meta.dir, "..");
const RESOLVER_PATH = join(REPO_ROOT, "scripts", "resolvers", "gbrain.ts");

function stripComments(src: string): string {
  // Strip block comments first (may span newlines, may contain `//`).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(/\/\/[^\n]*/g, "");
}

function listTrackedSkillMd(): string[] {
  const out = execFileSync("git", ["ls-files", "*SKILL.md"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

describe("scripts/resolvers/gbrain.ts — no `gbrain put_page` CLI subcommand in emitted instructions (regression for #1346)", () => {
  it("resolver source ships only `gbrain put` CLI instructions, not the renamed `gbrain put_page`", () => {
    // We're guarding against the v0.18 CLI subcommand rename
    // (`gbrain put_page <slug>` → `gbrain put <slug>`). The MCP op
    // `mcp__gbrain__put_page` is a legitimately separate identifier (the
    // MCP-layer write op, unrelated to the CLI rename) and may still
    // appear in resolver output as a fallback reference for the
    // calibration-take write-back path. So check the CLI subcommand
    // shape specifically: `gbrain put_page` with a space.
    const src = readFileSync(RESOLVER_PATH, "utf-8");
    const stripped = stripComments(src);
    expect(stripped).not.toContain("gbrain put_page");
  });

  it("every tracked SKILL.md file is free of the renamed gbrain put_page subcommand", () => {
    const files = listTrackedSkillMd();
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(join(REPO_ROOT, f), "utf-8");
      if (content.includes("gbrain put_page")) {
        offenders.push(f);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Generated SKILL.md files still reference 'gbrain put_page'. ` +
          `Run 'bun run gen:skill-docs' to regenerate after editing ` +
          `scripts/resolvers/gbrain.ts. Offenders:\n  - ${offenders.join("\n  - ")}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});
