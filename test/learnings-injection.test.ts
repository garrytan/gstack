import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const SCRIPT = path.join(import.meta.dir, "..", "bin", "gstack-learnings-search");

describe("gstack-learnings-search injection prevention", () => {
  const script = readFileSync(SCRIPT, "utf-8");

  test("no shell interpolation inside bun -e string", () => {
    // Extract the bun -e block (everything between `bun -e "` and the closing `"`)
    const bunBlock = script.slice(script.indexOf('bun -e "'));

    // Should NOT contain ${VAR} patterns (shell interpolation)
    // These are RCE vectors: a malicious learnings entry with '; rm -rf / ;' in the
    // query field would execute arbitrary commands via shell interpolation.
    const shellInterpolations = bunBlock.match(/'\$\{[A-Z_]+\}'/g) || [];
    const bareInterpolations = bunBlock.match(/\$\{[A-Z_]+\}/g) || [];

    // Filter out any that are inside process.env references (those are safe)
    const unsafeInterpolations = [
      ...shellInterpolations,
      ...bareInterpolations,
    ].filter((m) => !m.includes("process.env"));

    expect(unsafeInterpolations).toEqual([]);
  });

  test("uses process.env for all user-controlled values", () => {
    const bunBlock = script.slice(script.indexOf('bun -e "'));

    // Must use process.env for TYPE, QUERY, LIMIT.
    // SLUG and CROSS are no longer threaded as env vars inside the bun
    // block since PR #1619 — current vs cross-project rows are now
    // distinguished by inline tags in the piped input (`current\t<line>`
    // vs `cross\t<line>`), removing the need for env-var filters inside
    // the bun block. CROSS is still set on the bash command line (it
    // controls whether the cross-project find runs at all), but the bun
    // block reads the tag, not the env var.
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_TYPE");
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_QUERY");
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_LIMIT");
  });

  test("env vars are set on the bun command line", () => {
    // The env vars must be passed to bun, not just set in the shell.
    // SLUG removed by PR #1619 — see above.
    expect(script).toContain("GSTACK_SEARCH_TYPE=");
    expect(script).toContain("GSTACK_SEARCH_QUERY=");
    expect(script).toContain("GSTACK_SEARCH_LIMIT=");
    expect(script).toContain("GSTACK_SEARCH_CROSS=");
  });

  test("current vs cross-project rows distinguished by inline tags, not SLUG env (#1619)", () => {
    const bunBlock = script.slice(script.indexOf('bun -e "'));
    // The bun block must inspect the per-line tag to mark cross-project rows.
    // The current shape emits `current\t<json>` or `cross\t<json>` from the
    // upstream pipe (via emit_tagged_file). Inside the bun block, the script
    // parses out the leading tag and sets a per-entry flag.
    expect(bunBlock).toMatch(/sourceTag|tabIndex|crossProject/);
  });
});
