import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const INIT = fs.readFileSync(path.join(ROOT, "bin", "gstack-artifacts-init"), "utf-8");

/** Pull a quoted heredoc body out of gstack-artifacts-init by target filename. */
function heredoc(target: string): string {
  const re = new RegExp(`cat > "\\$GSTACK_HOME/${target}" <<'EOF'\\n([\\s\\S]*?)\\nEOF\\n`);
  const m = INIT.match(re);
  if (!m) throw new Error(`heredoc for ${target} not found in gstack-artifacts-init`);
  return m[1];
}

/** fnmatch.fnmatchcase semantics, as compute_paths_to_stage applies them:
 *  `*` does not cross a path separator. */
function globToRe(g: string): RegExp {
  return new RegExp("^" + g.split("*").map((s) => s.replace(/[.]/g, "[.]")).join("[^/]*") + "$");
}

const DECISION_PATHS = [
  "projects/acme-widget/decisions.jsonl",
  "projects/acme-widget/decisions.active.json",
  "projects/acme-widget/decisions.archive.jsonl",
];

/**
 * gstack-decision-log:40 enqueues projects/<slug>/decisions.jsonl after EVERY write,
 * but no managed glob matched it, so compute_paths_to_stage rejected all of them at
 * its "must match at least one allowlist glob" check. The writer and the syncer
 * disagreed silently: turning artifacts sync on backed up learnings, plans, designs
 * and timelines -- everything EXCEPT the durable decision ledger -- and nothing
 * anywhere reported a miss, because a dropped path prints exactly what a synced one
 * does when the queue is otherwise empty.
 *
 * Source-level rather than end-to-end: gstack-artifacts-init.test.ts drives the real
 * script through #!/bin/bash shims and a colon-separated PATH, so it cannot run on
 * Windows -- which is the platform where this bug bit.
 */
describe("the artifacts allowlist covers the decision store", () => {
  const globs = heredoc("\\.brain-allowlist")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  test("every decisions.* path matches at least one allowlist glob", () => {
    for (const p of DECISION_PATHS) {
      expect({ p, matched: globs.some((g) => globToRe(g).test(p)) }).toEqual({ p, matched: true });
    }
  });

  test("decisions.* are class artifact, so they sync in artifacts-only mode too", () => {
    const map = JSON.parse(heredoc("\\.brain-privacy-map\\.json"));
    for (const p of DECISION_PATHS) {
      const hit = map.find((e: { pattern: string; class: string }) => globToRe(e.pattern).test(p));
      expect({ p, cls: hit?.class }).toEqual({ p, cls: "artifact" });
    }
  });

  test("the allowlist still ends with the user-additions marker", () => {
    // Additions below it survive re-init; a glob added above would be silently
    // overwritten the next time gstack-artifacts-init runs.
    expect(heredoc("\\.brain-allowlist").trimEnd()).toMatch(/# ---- USER ADDITIONS BELOW ----/);
  });
});
