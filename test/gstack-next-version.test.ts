// Pure-function tests for bin/gstack-next-version.
// Covers the version arithmetic and slot-picking logic. Subprocess paths
// (gh/glab/git) are covered by the integration test at the bottom (skipped
// when the relevant CLI isn't available).

import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVersion,
  fmtVersion,
  bumpVersion,
  cmpVersion,
  pickNextSlot,
  markActiveSiblings,
  resolveVersionPath,
  fetchGitClaimed,
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

describe("resolveVersionPath (monorepo VERSION-path support)", () => {
  test("CLI flag wins over everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "config/VERSION\n");
      expect(resolveVersionPath("flag/path/VERSION", dir)).toBe("flag/path/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".gstack/version-path config is picked up", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "Tinas Second Brain/health-tracker/VERSION\n");
      expect(resolveVersionPath(undefined, dir)).toBe("Tinas Second Brain/health-tracker/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trims whitespace and ignores blank lines after the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "  apps/web/VERSION  \n\n# comment-ish line\n");
      expect(resolveVersionPath(undefined, dir)).toBe("apps/web/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty config file falls back to default VERSION", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "\n");
      expect(resolveVersionPath(undefined, dir)).toBe("VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing config file falls back to default VERSION", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      expect(resolveVersionPath(undefined, dir)).toBe("VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty override string falls back to config/default", () => {
    // Defensive: "" should NOT win over config — only a non-empty CLI arg should.
    const dir = mkdtempSync(join(tmpdir(), "nextver-"));
    try {
      mkdirSync(join(dir, ".gstack"));
      writeFileSync(join(dir, ".gstack", "version-path"), "subproj/VERSION\n");
      expect(resolveVersionPath("", dir)).toBe("subproj/VERSION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Integration smoke — only runs if gh is available and authenticated. Confirms
// the CLI executes end-to-end against real APIs without crashing.
describe("offline output contract (what /ship branches on)", () => {
  // /ship's Step 12 now reads `.fallback` to decide whether the pick is
  // trustworthy when the PR queue is unreachable. That field is therefore
  // load-bearing prose-to-code coupling: if it silently stopped being emitted,
  // /ship would read undefined, treat the run as fully online, and lose the
  // "verify no sibling holds it" prompt. Asserted end-to-end with a stub `gh`
  // that always fails, which is what an expired token or an offline laptop
  // looks like from here.
  test("emits fallback:'git' and still returns a version when gh fails", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "nextver-stubgh-"));
    writeFileSync(join(stubDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const proc = Bun.spawnSync(
      ["bun", "run", "./bin/gstack-next-version", "--base", "main",
       "--bump", "patch", "--current-version", "1.0.0.0", "--workspace-root", "null"],
      { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } },
    );
    rmSync(stubDir, { recursive: true, force: true });
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(out.offline).toBe(true);
    expect(out.fallback).toBe("git");
    // The whole point: degraded queue view, NOT a degraded allocation.
    expect(out.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(out.warnings.join(" ")).toContain("allocated from git");
  }, 30000);

  test("online runs leave fallback null", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", "./bin/gstack-next-version", "--base", "main",
       "--bump", "patch", "--current-version", "1.0.0.0", "--workspace-root", "null"],
    );
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    if (out.offline) return; // no network / no gh auth on this machine: nothing to assert
    expect(out.fallback).toBe(null);
  }, 30000);
});

describe("integration (smoke)", () => {
  // Bumps timeout to 30s — the test spawns a real `bun run` subprocess that
  // does a `gh pr list` against the live GitHub API to inspect claimed slots.
  // Network latency makes 5s tight on developer machines.
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
    expect(parsed).toHaveProperty("version_path", "VERSION"); // default when no config + no flag
  }, 30_000); // Headroom over the 4-5s wall time of the spawned process under load

  test("CLI runs with --version-path and surfaces it in JSON output", async () => {
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
      "null",
      "--version-path",
      "Tinas Second Brain/health-tracker/VERSION",
    ]);
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version_path", "Tinas Second Brain/health-tracker/VERSION");
  }, 30_000);
});

describe("fetchGitClaimed (offline allocation — the anti-duplicate fallback)", () => {
  // Why this exists: when `gh pr list` failed, the util returned
  // `offline:true` with an EMPTY claim set and /ship's instruction was
  // "fall back to local BUMP_LEVEL arithmetic". Local arithmetic cannot see a
  // sibling's claim, so it re-allocated a version an open PR already held.
  // That produced two commits reading v0.1.57.0 on killthebody's main (plus
  // three earlier pairs found in the same audit). Git knows what the API was
  // asked for, so offline now degrades the QUEUE VIEW, not the ALLOCATION.
  function git(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  }

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "nextver-git-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "VERSION"), "0.1.66.0\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "v0.1.66.0 chore: base");
    // A sibling PR branch that already claimed 0.1.67.0, present as a fetched
    // remote-tracking ref — which is the shape a real `git fetch` leaves.
    git(dir, "checkout", "-q", "-b", "sibling");
    writeFileSync(join(dir, "VERSION"), "0.1.67.0\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "v0.1.67.0 feat: sibling claimed this");
    const sha = new TextDecoder().decode(git(dir, "rev-parse", "HEAD").stdout).trim();
    git(dir, "checkout", "-q", "main");
    git(dir, "update-ref", "refs/remotes/origin/sibling", sha);
    git(dir, "update-ref", "refs/remotes/origin/main", "main");
    return dir;
  }

  test("finds a sibling branch's claim from remote-tracking refs", () => {
    const dir = fixture();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      const versions = claims.map((c) => c.version);
      expect(versions).toContain("0.1.67.0");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the sibling's claim is enough to push the pick past it", () => {
    // The end-to-end consequence: with the claim visible, pickNextSlot lands
    // on 0.1.68.0 instead of re-issuing the sibling's 0.1.67.0.
    const dir = fixture();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const claims = fetchGitClaimed("main", "VERSION", []);
      const base = parseVersion("0.1.66.0")!;
      const claimed = claims
        .map((c) => parseVersion(c.version))
        .filter((v): v is [number, number, number, number] => v !== null)
        .filter((v) => cmpVersion(v, base) > 0);
      const { version } = pickNextSlot(base, claimed, "patch");
      expect(fmtVersion(version)).toBe("0.1.68.0");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("also reports versions already shipped on the base", () => {
    // Catches a number that merged and was then re-picked — the VERSION file
    // alone cannot see that, because it only holds the newest value.
    const dir = fixture();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const claims = fetchGitClaimed("main", "VERSION", []);
      const shipped = claims.filter((c) => c.branch.startsWith("(shipped on"));
      expect(shipped.map((c) => c.version)).toContain("0.1.66.0");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("degrades to a warning, never a throw, outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-nogit-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      expect(claims).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
