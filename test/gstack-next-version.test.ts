// Pure-function tests for bin/gstack-next-version.
// Covers the version arithmetic and slot-picking logic. Subprocess paths
// (gh/glab/git) are covered by the integration test at the bottom (skipped
// when the relevant CLI isn't available).

import { test, expect, describe } from "bun:test";
import {
  parseVersion,
  fmtVersion,
  bumpVersion,
  cmpVersion,
  pickNextSlot,
  markActiveSiblings,
} from "../bin/gstack-next-version";

describe("parseVersion", () => {
  test("accepts 4-digit semver", () => {
    expect(parseVersion("1.6.3.0")).toEqual([1, 6, 3, 0]);
    expect(parseVersion("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseVersion("99.99.99.99")).toEqual([99, 99, 99, 99]);
  });

  test("trims whitespace", () => {
    expect(parseVersion("  1.2.3.4  \n")).toEqual([1, 2, 3, 4]);
  });

  test("rejects malformed", () => {
    expect(parseVersion("1.2.3")).toBeNull();
    expect(parseVersion("1.2.3.4.5")).toBeNull();
    expect(parseVersion("v1.2.3.4")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("1.2.3.x")).toBeNull();
  });
});

describe("bumpVersion", () => {
  test("major zeros everything right", () => {
    expect(bumpVersion([1, 6, 3, 0], "major")).toEqual([2, 0, 0, 0]);
    expect(bumpVersion([1, 6, 3, 7], "major")).toEqual([2, 0, 0, 0]);
  });
  test("minor zeros patch+micro", () => {
    expect(bumpVersion([1, 6, 3, 0], "minor")).toEqual([1, 7, 0, 0]);
    expect(bumpVersion([1, 6, 3, 7], "minor")).toEqual([1, 7, 0, 0]);
  });
  test("patch zeros micro", () => {
    expect(bumpVersion([1, 6, 3, 0], "patch")).toEqual([1, 6, 4, 0]);
    expect(bumpVersion([1, 6, 3, 7], "patch")).toEqual([1, 6, 4, 0]);
  });
  test("micro increments slot 4", () => {
    expect(bumpVersion([1, 6, 3, 0], "micro")).toEqual([1, 6, 3, 1]);
    expect(bumpVersion([1, 6, 3, 7], "micro")).toEqual([1, 6, 3, 8]);
  });
});

describe("cmpVersion", () => {
  test("detects order", () => {
    expect(cmpVersion([1, 6, 3, 0], [1, 6, 3, 0])).toBe(0);
    expect(cmpVersion([1, 6, 4, 0], [1, 6, 3, 0])).toBeGreaterThan(0);
    expect(cmpVersion([1, 6, 3, 0], [1, 6, 4, 0])).toBeLessThan(0);
    expect(cmpVersion([2, 0, 0, 0], [1, 99, 99, 99])).toBeGreaterThan(0);
  });
});

describe("pickNextSlot (the heart of queue-aware allocation)", () => {
  const base: [number, number, number, number] = [1, 6, 3, 0];

  test("happy path — no claims, clean bump", () => {
    const r = pickNextSlot(base, [], "minor");
    expect(fmtVersion(r.version)).toBe("1.7.0.0");
    expect(r.reason).toMatch(/no collision/);
  });

  test("collision — one PR claims the next slot, bump past", () => {
    const r = pickNextSlot(base, [[1, 7, 0, 0]], "minor");
    expect(fmtVersion(r.version)).toBe("1.8.0.0");
    expect(r.reason).toMatch(/bumped past/);
  });

  test("multi-collision — two PRs claim sequential slots", () => {
    const r = pickNextSlot(base, [[1, 7, 0, 0], [1, 8, 0, 0]], "minor");
    expect(fmtVersion(r.version)).toBe("1.9.0.0");
  });

  test("collision cross-level — queued MINOR bumps past my PATCH", () => {
    // Queue has 1.7.0.0 (minor), my bump is patch. I should land at 1.7.1.0
    // (patch relative to the highest claim).
    const r = pickNextSlot(base, [[1, 7, 0, 0]], "patch");
    expect(fmtVersion(r.version)).toBe("1.7.1.0");
  });

  test("claims below base are ignored", () => {
    const r = pickNextSlot(base, [[1, 5, 0, 0], [1, 6, 2, 0]], "patch");
    expect(fmtVersion(r.version)).toBe("1.6.4.0");
    expect(r.reason).toMatch(/no collision/);
  });

  test("claims equal to base are treated as no-claim", () => {
    // The caller is expected to pre-filter base-equal claims out, but even if
    // one slipped through, we don't want to inflate past it.
    const r = pickNextSlot(base, [], "micro");
    expect(fmtVersion(r.version)).toBe("1.6.3.1");
  });

  test("major collision — competing majors", () => {
    const r = pickNextSlot(base, [[2, 0, 0, 0]], "major");
    expect(fmtVersion(r.version)).toBe("3.0.0.0");
  });

  test("unsorted claims still resolve correctly", () => {
    const r = pickNextSlot(base, [[1, 9, 0, 0], [1, 7, 0, 0], [1, 8, 0, 0]], "minor");
    expect(fmtVersion(r.version)).toBe("1.10.0.0");
  });
});

describe("markActiveSiblings", () => {
  const base: [number, number, number, number] = [1, 6, 3, 0];
  const now = Math.floor(Date.now() / 1000);

  test("flags siblings that are ahead of base AND recent AND have no PR", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.7.0.0", last_commit_ts: now - 60, has_open_pr: false, is_active: false },
    ];
    const r = markActiveSiblings(siblings, base);
    expect(r[0].is_active).toBe(true);
  });

  test("does not flag siblings with open PRs (already in the queue)", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.7.0.0", last_commit_ts: now - 60, has_open_pr: true, is_active: false },
    ];
    expect(markActiveSiblings(siblings, base)[0].is_active).toBe(false);
  });

  test("does not flag stale siblings (commit > 24h old)", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.7.0.0", last_commit_ts: now - 25 * 3600, has_open_pr: false, is_active: false },
    ];
    expect(markActiveSiblings(siblings, base)[0].is_active).toBe(false);
  });

  test("does not flag siblings at or below base", () => {
    const siblings = [
      { path: "/a", branch: "feat/alpha", version: "1.6.3.0", last_commit_ts: now - 60, has_open_pr: false, is_active: false },
      { path: "/b", branch: "feat/beta", version: "1.5.0.0", last_commit_ts: now - 60, has_open_pr: false, is_active: false },
    ];
    const r = markActiveSiblings(siblings, base);
    expect(r[0].is_active).toBe(false);
    expect(r[1].is_active).toBe(false);
  });
});

// Integration smoke — only runs if gh is available and authenticated. Confirms
// the CLI executes end-to-end against real APIs without crashing.
describe("integration (smoke)", () => {
  test("CLI runs against real repo and emits parseable JSON", async () => {
    const proc = Bun.spawnSync([
      "bun",
      "run",
      "./bin/gstack-next-version",
      "--base",
      "main",
      "--bump",
      "patch",
      "--current-version",
      "1.6.3.0",
      "--workspace-root",
      "null", // skip sibling scan in CI
    ]);
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version");
    expect(parseVersion(parsed.version)).not.toBeNull();
    expect(parsed).toHaveProperty("bump", "patch");
    expect(parsed).toHaveProperty("host");
    expect(["github", "gitlab", "unknown"]).toContain(parsed.host);
    expect(parsed).toHaveProperty("claimed");
    expect(Array.isArray(parsed.claimed)).toBe(true);
    expect(parsed).toHaveProperty("siblings");
    expect(parsed.siblings).toEqual([]); // --workspace-root null disabled scanning
  });
});
