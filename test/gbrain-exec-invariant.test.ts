/**
 * Static-source invariant: every gbrain CLI invocation in the hot-path
 * sync code MUST route through `lib/gbrain-exec.ts` (or accept env via
 * the existing `lib/gbrain-sources.ts` opts surface). A future contributor
 * who adds a `spawnSync("gbrain", ...)` call directly in
 * `bin/gstack-gbrain-sync.ts` or `bin/gstack-memory-ingest.ts` silently
 * regresses the DATABASE_URL fix from #1508 + codex review #7 — gbrain's
 * dotenv autoload pulls a host project's `.env.local` value instead of
 * gbrain's own config.
 *
 * This test reads each source file directly and asserts zero direct
 * `spawnSync("gbrain"`, `spawn("gbrain"`, `execFileSync("gbrain"`, or
 * `execSync(...gbrain` matches. Bun runs TS directly so there is no
 * compiled artifact to grep — the .ts source is the truth.
 *
 * The check is intentionally narrow: only the two files where the bug
 * actually hurts users are guarded. Other gbrain spawn sites
 * (`lib/gbrain-sources.ts`, `lib/gbrain-local-status.ts`,
 * `lib/gstack-memory-helpers.ts`, `bin/gstack-brain-context-load.ts`)
 * either already accept env from callers or run probes that don't need
 * DATABASE_URL. Expanding the invariant to those files is a follow-up.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

const GUARDED_FILES = [
  "bin/gstack-gbrain-sync.ts",
  "bin/gstack-memory-ingest.ts",
];

// Patterns that would bypass lib/gbrain-exec.ts. Match the literal `"gbrain"`
// as the first argument since these helpers are the failure mode.
const BANNED_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'spawnSync("gbrain", ...)', regex: /spawnSync\s*\(\s*["']gbrain["']/g },
  { name: 'spawn("gbrain", ...)', regex: /\bspawn\s*\(\s*["']gbrain["']/g },
  { name: 'execFileSync("gbrain", ...)', regex: /execFileSync\s*\(\s*["']gbrain["']/g },
  { name: 'execSync("...gbrain...")', regex: /execSync\s*\(\s*["'`][^"'`]*\bgbrain\b/g },
];

describe("gbrain-exec invariant", () => {
  for (const relpath of GUARDED_FILES) {
    it(`${relpath} routes every gbrain spawn through lib/gbrain-exec.ts`, () => {
      const source = readFileSync(join(ROOT, relpath), "utf-8");
      // Strip block comments and line comments before scanning — a
      // documentation reference like `// spawnSync("gbrain", ...)` in a
      // comment shouldn't trip the invariant. The strip is approximate
      // (sufficient for the patterns we care about); production code
      // should match cleanly.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      for (const { name, regex } of BANNED_PATTERNS) {
        const matches = stripped.match(regex) || [];
        if (matches.length > 0) {
          // Find the line numbers to make the failure actionable.
          const lines = stripped.split("\n");
          const hits: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (new RegExp(regex.source).test(lines[i])) {
              hits.push(`  ${relpath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
          throw new Error(
            `Found ${matches.length} direct gbrain invocation(s) in ${relpath} matching \`${name}\`:\n${hits.join("\n")}\n\n`
            + `Route every gbrain spawn through \`spawnGbrain\`/\`execGbrainJson\`/\`execGbrainText\` `
            + `in lib/gbrain-exec.ts so DATABASE_URL is seeded from gbrain's config.`,
          );
        }
      }

      // Positive assertion: the file should import from lib/gbrain-exec.
      expect(source).toMatch(/from\s+["']\.\.\/lib\/gbrain-exec["']/);
    });
  }
});
