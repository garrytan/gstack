// Pure-function tests for bin/gstack-next-version.
// Covers the version arithmetic and slot-picking logic. Subprocess paths
// (gh/glab/git) are covered by the integration test at the bottom (skipped
// when the relevant CLI isn't available).

import { test, expect, describe } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVersion,
  fmtVersion,
  bumpVersion,
  cmpVersion,
  versionWidth,
  extractVersion,
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

  test("accepts 3-digit semver, padding the micro slot (#2501)", () => {
    // 3-digit repos (a package.json holding plain semver) used to fail parsing
    // outright, which exited this CLI 2 on EVERY run — and since this CLI is
    // the queue-collision check, /ship then fell back to naive local
    // arithmetic and duplicate version slots shipped silently. The pad keeps
    // comparison uniform; versionWidth narrows output back.
    expect(parseVersion("0.99.2")).toEqual([0, 99, 2, 0]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3, 0]);
    expect(versionWidth("0.99.2")).toBe(3);
    expect(versionWidth("1.6.3.0")).toBe(4);
  });

  test("rejects malformed", () => {
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3.4.5")).toBeNull();
    expect(parseVersion("v1.2.3.4")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("1.2.3.x")).toBeNull();
  });
});

describe("3-digit repos keep their width (#2501)", () => {
  test("formatting narrows to the repo's own width", () => {
    expect(fmtVersion([0, 99, 3, 0], 3)).toBe("0.99.3");
    expect(fmtVersion([0, 99, 3, 0], 4)).toBe("0.99.3.0");
    expect(fmtVersion([0, 99, 3, 0])).toBe("0.99.3.0"); // default stays 4-digit
  });

  test("micro is carried out as patch when there is no micro component", () => {
    // /ship auto-picks MICRO by default. Erroring would make it unusable in
    // every 3-digit repo; a no-op would be worse — it would write back the
    // version it started with and claim a slot already taken.
    expect(bumpVersion([0, 99, 2, 0], "micro", 3)).toEqual([0, 99, 3, 0]);
    expect(bumpVersion([0, 99, 2, 0], "patch", 3)).toEqual([0, 99, 3, 0]);
    expect(bumpVersion([0, 99, 2, 3], "micro", 4)).toEqual([0, 99, 2, 4]); // 4-digit unchanged
  });

  test("slot picking stays inside the repo's width", () => {
    const { version } = pickNextSlot([0, 99, 2, 0], [[0, 99, 5, 0]], "patch", 3);
    expect(fmtVersion(version, 3)).toBe("0.99.6");
  });
});

describe("extractVersion (#2501)", () => {
  test("reads .version when the version-path is a package.json", () => {
    const pkg = JSON.stringify({ name: "frontend", version: "0.99.2", private: true });
    expect(extractVersion(pkg, "frontend/package.json")).toBe("0.99.2");
    expect(extractVersion(pkg, "deep/nested/package.json")).toBe("0.99.2");
  });

  test("reads raw text for a plain VERSION file", () => {
    expect(extractVersion("1.6.3.0\n", "VERSION")).toBe("1.6.3.0");
    expect(extractVersion("  1.6.3.0  ", "version/CURRENT")).toBe("1.6.3.0");
  });

  test("a JSON path that isn't valid JSON yields empty, not garbage", () => {
    // The old readers ran a package.json through a whitespace strip and handed
    // the caller '{"name":"frontend",...' as if it were a version. Empty lets
    // callers fall back loudly.
    expect(extractVersion("{ not json", "package.json")).toBe("");
    expect(extractVersion(JSON.stringify({ name: "x" }), "package.json")).toBe("");
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

// Fixture-repo coverage for the default-base detection chain in parseArgs:
// origin/HEAD symbolic-ref → origin/main probe → origin/master probe →
// literal "main". No --base and no --current-version are passed, so the
// detected base is observable through base_version: each fixture branch
// carries a distinct VERSION and readBaseVersion does
// `git show origin/<detected-base>:VERSION`.
describe("default-base detection (no --base)", () => {
  const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-next-version");
  // Point git at a nonexistent global/system config so operator settings
  // (init.defaultBranch, commit.gpgsign, hooks, ...) can't leak into fixtures.
  const noCfg = join(mkdtempSync(join(tmpdir(), "nextver-gitcfg-")), "empty");
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: noCfg,
    GIT_CONFIG_SYSTEM: noCfg,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
  }

  // Origin repo whose branches each hold a distinct VERSION, plus a clone
  // (the clone is the repo the CLI runs in).
  function makeClone(branches: Array<[name: string, version: string]>): { root: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "nextver-base-"));
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", branches[0][0]);
    for (let i = 0; i < branches.length; i++) {
      const [name, version] = branches[i];
      if (i > 0) git(origin, "checkout", "-q", "-b", name);
      writeFileSync(join(origin, "VERSION"), `${version}\n`);
      git(origin, "add", "VERSION");
      git(origin, "commit", "-q", "--no-gpg-sign", "-m", `VERSION ${version}`);
    }
    git(root, "clone", "-q", "origin", "clone");
    return { root, clone: join(root, "clone") };
  }

  function runWithoutBase(cwd: string): { exitCode: number; parsed: any } {
    const proc = Bun.spawnSync(
      ["bun", "run", SCRIPT, "--bump", "patch", "--workspace-root", "null"],
      { cwd, timeout: 30_000 },
    );
    const out = new TextDecoder().decode(proc.stdout);
    return { exitCode: proc.exitCode, parsed: JSON.parse(out) };
  }

  test("origin/HEAD symbolic-ref wins — resolves trunk even though origin/main exists", () => {
    const { root, clone } = makeClone([["main", "1.1.1.1"], ["trunk", "2.2.2.2"]]);
    try {
      git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
      const { exitCode, parsed } = runWithoutBase(clone);
      expect(exitCode).toBe(0);
      // trunk's VERSION, not main's — the rev-parse probes never ran.
      expect(parsed.base_version).toBe("2.2.2.2");
      expect(parsed.version).toBe("2.2.3.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("no origin/HEAD, no origin/main: the origin/master probe resolves master", () => {
    const { root, clone } = makeClone([["master", "3.3.3.3"]]);
    try {
      // Plain clones that never ran `git remote set-head` have no origin/HEAD.
      git(clone, "remote", "set-head", "origin", "--delete");
      const { exitCode, parsed } = runWithoutBase(clone);
      expect(exitCode).toBe(0);
      // Read at origin/master. The "main" literal fallback would have warned
      // and assumed 0.0.0.0 instead.
      expect(parsed.base_version).toBe("3.3.3.3");
      expect(parsed.version).toBe("3.3.4.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("neither origin/HEAD nor main/master: falls back to the 'main' literal", () => {
    const { root, clone } = makeClone([["develop", "4.4.4.4"]]);
    try {
      git(clone, "remote", "set-head", "origin", "--delete");
      const { exitCode, parsed } = runWithoutBase(clone);
      expect(exitCode).toBe(0);
      // base = literal "main"; origin/main doesn't exist, so readBaseVersion
      // warns and assumes 0.0.0.0 — which pins WHICH base the fallback chose.
      expect(parsed.base_version).toBe("0.0.0.0");
      expect(parsed.warnings.join("\n")).toContain("origin/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// Integration smoke — only runs if gh is available and authenticated. Confirms
// the CLI executes end-to-end against real APIs without crashing.
describe("offline output contract (what /ship branches on, #2545)", () => {
  // /ship's Step 12 reads `.fallback` to decide whether the pick is
  // trustworthy when the PR queue is unreachable. That field is therefore
  // load-bearing prose-to-code coupling: if it silently stopped being emitted,
  // /ship would read undefined, treat the run as fully online, and lose the
  // "verify no sibling holds it" prompt.
  //
  // Both tests run the CLI in a LOCAL FIXTURE repo, never the checkout it
  // lives in: in the real checkout the git fallback does a live
  // `ls-remote origin` and reads the real branch census, which made this test
  // depend on the operator's network — and on a shallow CI clone it fetched
  // the remote's every branch (the shard-deadline hang fixed alongside this).
  const NEXTVER = join(import.meta.dir, "..", "bin", "gstack-next-version");

  function fixtureRepo(): { root: string; work: string } {
    const root = mkdtempSync(join(tmpdir(), "nextver-contract-"));
    // detectHost() sniffs "github.com" in the origin URL STRING before any
    // gh/glab auth probe — a bare origin at a path containing github.com
    // pins host:"github" identically on every machine (an auth-probe
    // fallthrough once made this test pass via glab locally and read
    // host:"unknown" on CI) while keeping ls-remote/fetch fully local.
    const bare = join(root, "github.com", "origin.git");
    mkdirSync(bare, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare], { timeout: 30_000 });
    const work = join(root, "work");
    mkdirSync(work);
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: work, timeout: 30_000 });
    git("init", "-q", "-b", "main");
    writeFileSync(join(work, "VERSION"), "1.0.0.0\n");
    git("add", "-A");
    git("commit", "-qm", "v1.0.0.0 chore: base");
    git("remote", "add", "origin", bare);
    git("push", "-q", "origin", "main");
    return { root, work };
  }

  test("emits fallback:'git' and still returns a version when gh fails", async () => {
    // Stub `gh` always fails — what an expired token or an offline laptop
    // looks like from here. No origin remote → ls-remote fails fast and the
    // allocation comes from local refs, never the network.
    const stubDir = mkdtempSync(join(tmpdir(), "nextver-stubgh-"));
    const { root, work } = fixtureRepo();
    writeFileSync(join(stubDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const proc = Bun.spawnSync(
      ["bun", "run", NEXTVER, "--base", "main",
       "--bump", "patch", "--current-version", "1.0.0.0", "--workspace-root", "null"],
      { cwd: work, env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }, timeout: 30_000 },
    );
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(out.host).toBe("github"); // pinned by the fixture's URL sniff, not auth probes
    expect(out.offline).toBe(true);
    expect(out.fallback).toBe("git");
    // The whole point: degraded queue view, NOT a degraded allocation.
    expect(out.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(out.warnings.join(" ")).toContain("allocated from git");
  }, 30000);

  test("online runs leave fallback null", async () => {
    // Stub `gh` SUCCEEDS (empty PR queue) — the online path asserted
    // deterministically instead of only when the operator happens to be
    // authed. Before this stub the test silently no-opped on CI.
    const stubDir = mkdtempSync(join(tmpdir(), "nextver-stubgh-ok-"));
    const { root, work } = fixtureRepo();
    writeFileSync(
      join(stubDir, "gh"),
      '#!/bin/sh\ncase "$1" in\n  pr) echo "[]" ;;\n  repo) echo "testowner" ;;\n  *) exit 0 ;;\nesac\n',
      { mode: 0o755 },
    );
    const proc = Bun.spawnSync(
      ["bun", "run", NEXTVER, "--base", "main",
       "--bump", "patch", "--current-version", "1.0.0.0", "--workspace-root", "null"],
      { cwd: work, env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }, timeout: 30_000 },
    );
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(out.host).toBe("github"); // pinned by the fixture's URL sniff, not auth probes
    expect(out.offline).toBe(false);
    expect(out.fallback).toBe(null);
    expect(out.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  }, 30000);
});

describe("fetchGitClaimed (offline allocation — the anti-duplicate fallback, #2545)", () => {
  // Why this exists: when `gh pr list` failed, the util returned
  // `offline:true` with an EMPTY claim set and /ship's instruction was
  // "fall back to local BUMP_LEVEL arithmetic". Local arithmetic cannot see a
  // sibling's claim, so it re-allocated a version an open PR already held.
  // That produced two commits reading v0.1.57.0 on a downstream repo's main
  // (plus three earlier pairs found in the same audit). Git knows what the API
  // was asked for, so offline now degrades the QUEUE VIEW, not the ALLOCATION.
  function git(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, timeout: 30_000 });
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

  test("reads a JSON version-path on remote refs and keeps the branch's own width", () => {
    // A sibling repo pinned to frontend/package.json (#2501): its claim is the
    // JSON .version, not the whitespace-stripped file bytes.
    const dir = mkdtempSync(join(tmpdir(), "nextver-gitjson-"));
    const cwd = process.cwd();
    try {
      git(dir, "init", "-q", "-b", "main");
      mkdirSync(join(dir, "frontend"), { recursive: true });
      writeFileSync(join(dir, "frontend", "package.json"), JSON.stringify({ name: "f", version: "0.99.2" }, null, 2) + "\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");
      git(dir, "checkout", "-q", "-b", "sibling");
      writeFileSync(join(dir, "frontend", "package.json"), JSON.stringify({ name: "f", version: "0.99.3" }, null, 2) + "\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "sibling claim");
      const sha = new TextDecoder().decode(git(dir, "rev-parse", "HEAD").stdout).trim();
      git(dir, "checkout", "-q", "main");
      git(dir, "update-ref", "refs/remotes/origin/sibling", sha);
      process.chdir(dir);
      const claims = fetchGitClaimed("main", "frontend/package.json", []);
      expect(claims.map((c) => c.version)).toContain("0.99.3");
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

describe("fetchGitClaimed — non-mutating live remote query (ls-remote first)", () => {
  // The degraded git-fallback used to count EVERY remote-tracking ref on EVERY
  // remote: branches deleted on origin (stale local refs) and an unrelated
  // `upstream` remote's branches all inflated the claim set, pushing the
  // allocation past the real queue. `git ls-remote --heads origin` returns the
  // remote's LIVE branch list with zero local mutation — a path/file remote
  // answers it offline, which is exactly what these fixtures use.
  function git(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, timeout: 30_000 });
  }

  // Local origin with: main (0.1.66.0), sibling (0.1.67.0, live claim), and
  // dead (0.1.98.0) — deleted on origin AFTER the clone, so the clone keeps a
  // stale refs/remotes/origin/dead. Plus a second remote's stale claim ref.
  function liveFixture(): { root: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "nextver-lsremote-"));
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "VERSION"), "0.1.66.0\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v0.1.66.0 chore: base");
    git(origin, "checkout", "-q", "-b", "sibling");
    writeFileSync(join(origin, "VERSION"), "0.1.67.0\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v0.1.67.0 feat: sibling claimed this");
    git(origin, "checkout", "-q", "-b", "dead");
    writeFileSync(join(origin, "VERSION"), "0.1.98.0\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v0.1.98.0 feat: deleted later");
    git(origin, "checkout", "-q", "main");
    const clone = join(root, "clone");
    git(root, "clone", "-q", origin, clone);
    // Deleted on the REMOTE after the clone — the stale local ref survives.
    git(origin, "branch", "-qD", "dead");
    // A second remote carrying a stale claim branch: must never be counted.
    git(clone, "checkout", "-q", "-b", "tmp-upstream");
    writeFileSync(join(clone, "VERSION"), "0.1.99.0\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "v0.1.99.0 upstream stale claim");
    const upSha = new TextDecoder().decode(git(clone, "rev-parse", "HEAD").stdout).trim();
    git(clone, "checkout", "-q", "main");
    git(clone, "branch", "-qD", "tmp-upstream");
    git(clone, "update-ref", "refs/remotes/upstream/stale", upSha);
    return { root, clone };
  }

  test("live path: only branches that exist on origin RIGHT NOW are claims", () => {
    const { root, clone } = liveFixture();
    const cwd = process.cwd();
    try {
      process.chdir(clone);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      const versions = claims.map((c) => c.version);
      expect(versions).toContain("0.1.67.0"); // live sibling claim
      expect(versions).not.toContain("0.1.98.0"); // deleted on origin — stale local ref ignored
      expect(versions).not.toContain("0.1.99.0"); // second remote's refs are not our queue
      // The live path emits no staleness warning.
      expect(warnings.join(" ")).not.toContain("ls-remote");
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("zero local mutation: the stale remote-tracking ref survives the query", () => {
    // ls-remote reads the remote without fetch/prune — an allocator run must
    // never rewrite local refs as a side effect.
    const { root, clone } = liveFixture();
    const cwd = process.cwd();
    try {
      process.chdir(clone);
      fetchGitClaimed("main", "VERSION", []);
      const ref = git(clone, "rev-parse", "--verify", "-q", "refs/remotes/origin/dead");
      expect(ref.exitCode).toBe(0);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fallback: ls-remote failure uses LOCAL refs/remotes/origin only, with a staleness warning", () => {
    // No origin remote configured at all — ls-remote must fail, and the
    // fallback must scan refs/remotes/origin ONLY (never other remotes).
    const dir = mkdtempSync(join(tmpdir(), "nextver-lsfallback-"));
    const cwd = process.cwd();
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "VERSION"), "0.1.66.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.66.0 chore: base");
      git(dir, "checkout", "-q", "-b", "sibling");
      writeFileSync(join(dir, "VERSION"), "0.1.67.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.67.0 feat: sibling claimed this");
      const sibSha = new TextDecoder().decode(git(dir, "rev-parse", "HEAD").stdout).trim();
      git(dir, "checkout", "-q", "-b", "stale2");
      writeFileSync(join(dir, "VERSION"), "0.1.99.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.99.0 upstream stale claim");
      const upSha = new TextDecoder().decode(git(dir, "rev-parse", "HEAD").stdout).trim();
      git(dir, "checkout", "-q", "main");
      git(dir, "update-ref", "refs/remotes/origin/sibling", sibSha);
      git(dir, "update-ref", "refs/remotes/upstream/stale", upSha);

      process.chdir(dir);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      const versions = claims.map((c) => c.version);
      expect(versions).toContain("0.1.67.0"); // origin's local snapshot still counts
      expect(versions).not.toContain("0.1.99.0"); // upstream remote is ignored
      expect(warnings.join(" ")).toContain("stale local refs/remotes/origin");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchGitClaimed — unfetched live claims (G2: ls-remote advertises SHAs without objects)", () => {
  // `git ls-remote` lists a branch's tip sha without transferring objects, so
  // a branch pushed AFTER the last local fetch has no local object and both
  // VERSION reads fail. The old `continue` silently dropped that LIVE claim —
  // the exact duplicate-allocation this fallback exists to prevent.
  function git(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, timeout: 30_000 });
  }

  function cloneFixture(): { root: string; origin: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "nextver-unfetched-"));
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "VERSION"), "0.1.66.0\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v0.1.66.0 chore: base");
    const clone = join(root, "clone");
    git(root, "clone", "-q", origin, clone);
    return { root, origin, clone };
  }

  test("a claim branch pushed after the last local fetch is read via a targeted fetch", () => {
    const { root, origin, clone } = cloneFixture();
    const cwd = process.cwd();
    try {
      // The claim lands on origin AFTER the clone — its objects are absent
      // locally, so `git show <sha>:VERSION` and the remote-tracking read
      // both fail until the targeted fetch runs.
      git(origin, "checkout", "-q", "-b", "late-claim");
      writeFileSync(join(origin, "VERSION"), "0.1.70.0\n");
      git(origin, "add", "-A");
      git(origin, "commit", "-qm", "v0.1.70.0 feat: late claim");
      git(origin, "checkout", "-q", "main");

      process.chdir(clone);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      expect(claims.map((c) => c.version)).toContain("0.1.70.0");
      expect(warnings.join(" ")).not.toContain("UNKNOWN claim");
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MANY unfetched claim branches resolve with ONE batched fetch, not a per-branch crawl", () => {
    // The per-branch fetch loop this replaces ground a shallow CI clone
    // against a busy remote for minutes (dozens of sequential network
    // fetches). The network budget must stay one round trip no matter how
    // many branches are missing — pinned by counting `git fetch` spawns
    // through a PATH shim.
    const { root, origin, clone } = cloneFixture();
    const cwd = process.cwd();
    const oldPath = process.env.PATH;
    const shimDir = mkdtempSync(join(tmpdir(), "nextver-gitshim-"));
    try {
      for (const v of ["0.1.70.0", "0.1.71.0", "0.1.72.0"]) {
        git(origin, "checkout", "-q", "-b", `late-${v.replace(/\./g, "-")}`);
        writeFileSync(join(origin, "VERSION"), `${v}\n`);
        git(origin, "add", "-A");
        git(origin, "commit", "-qm", `v${v} feat: late claim`);
        git(origin, "checkout", "-q", "main");
      }

      const realGit = Bun.which("git");
      const spawnLog = join(shimDir, "spawns.log");
      writeFileSync(
        join(shimDir, "git"),
        `#!/bin/sh\necho "$@" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );

      process.chdir(clone);
      process.env.PATH = `${shimDir}:${oldPath}`;
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      process.env.PATH = oldPath;

      const versions = claims.map((c) => c.version);
      expect(versions).toContain("0.1.70.0");
      expect(versions).toContain("0.1.71.0");
      expect(versions).toContain("0.1.72.0");
      expect(warnings.join(" ")).not.toContain("UNKNOWN claim");
      const fetches = readFileSync(spawnLog, "utf-8")
        .split("\n")
        .filter((l) => l.startsWith("fetch "));
      expect(fetches.length).toBe(1);
      for (const v of ["0-1-70-0", "0-1-71-0", "0-1-72-0"]) {
        expect(fetches[0]).toContain(`refs/heads/late-${v}`);
      }
    } finally {
      process.env.PATH = oldPath;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test("one unservable ref does not poison the batch — live claims still resolve, the ghost warns", () => {
    // A dangling sha fails the WHOLE batched transfer, so the still-missing
    // refs get a bounded per-branch retry: the real claim must come through
    // and only the ghost surfaces as UNKNOWN.
    const { root, origin, clone } = cloneFixture();
    const cwd = process.cwd();
    try {
      git(origin, "checkout", "-q", "-b", "late-claim");
      writeFileSync(join(origin, "VERSION"), "0.1.70.0\n");
      git(origin, "add", "-A");
      git(origin, "commit", "-qm", "v0.1.70.0 feat: late claim");
      git(origin, "checkout", "-q", "main");
      writeFileSync(
        join(origin, ".git", "refs", "heads", "ghost"),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      );

      process.chdir(clone);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      expect(claims.map((c) => c.version)).toContain("0.1.70.0");
      const joined = warnings.join(" ");
      expect(joined).toContain("origin/ghost");
      expect(joined).toContain("UNKNOWN claim");
      expect(joined).not.toContain("late-claim");
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a claim STILL unreadable after the fetch surfaces as an UNKNOWN-claim warning, never silence", () => {
    const { root, origin, clone } = cloneFixture();
    const cwd = process.cwd();
    try {
      // A ref origin advertises but cannot serve: dangling sha written
      // straight into refs/. ls-remote lists it; every local read fails, the
      // targeted fetch fails ("not our ref"), and the object never appears.
      writeFileSync(
        join(origin, ".git", "refs", "heads", "ghost"),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      );

      process.chdir(clone);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      expect(claims.map((c) => c.branch)).not.toContain("origin/ghost");
      const joined = warnings.join(" ");
      expect(joined).toContain("origin/ghost");
      expect(joined).toContain("UNKNOWN claim");
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live branch that simply carries no VERSION file is not a claim and not an UNKNOWN warning", () => {
    const { root, origin, clone } = cloneFixture();
    const cwd = process.cwd();
    try {
      // Branch exists BEFORE the clone (objects local), VERSION deleted on it:
      // the read fails because the PATH is absent, not the object. Old
      // semantics (skip quietly) must hold — no phantom UNKNOWN noise.
      git(origin, "checkout", "-q", "-b", "docs-only");
      git(origin, "rm", "-q", "VERSION");
      git(origin, "commit", "-qm", "docs: no version file");
      git(origin, "checkout", "-q", "main");
      git(clone, "fetch", "-q", "origin");

      process.chdir(clone);
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      expect(claims.map((c) => c.branch)).not.toContain("origin/docs-only");
      expect(warnings.join(" ")).not.toContain("docs-only");
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("width pinned on failed base read (3-digit repos)", () => {
  // readBaseVersion used to return a literal "0.0.0.0" when origin/<base> was
  // unreadable — a 4-digit string, which flipped versionWidth() to 4 and
  // handed a 3-digit repo a 4-digit slot its tooling can't read back (#2501's
  // width class, resurfacing through the failure path). The zero base is now
  // shaped by the LOCAL version file's width.
  const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-next-version");

  test("a 3-digit repo keeps 3-digit allocation when origin/<base> is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-width3-"));
    const stubDir = mkdtempSync(join(tmpdir(), "nextver-width3-stub-"));
    try {
      // gh/glab stubs fail → host unknown → git fallback; no origin remote →
      // the base read fails too, which is the path under test.
      writeFileSync(join(stubDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      writeFileSync(join(stubDir, "glab"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir, timeout: 30_000 });
      writeFileSync(join(dir, "VERSION"), "0.99.2\n");
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir, timeout: 30_000 });
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir, timeout: 30_000 });

      const proc = Bun.spawnSync(
        ["bun", "run", SCRIPT, "--base", "main", "--bump", "patch", "--workspace-root", "null"],
        { cwd: dir, env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }, timeout: 30_000 },
      );
      const out = JSON.parse(new TextDecoder().decode(proc.stdout));
      // Zero base at the repo's OWN width — never "0.0.0.0" in a 3-digit repo.
      expect(out.base_version).toBe("0.0.0");
      expect(out.version).toBe("0.0.1"); // 3-digit allocation, not 0.0.1.0
      expect(out.warnings.join(" ")).not.toContain("0.0.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 30_000);
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
    ], { timeout: 30_000 });
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
    ], { timeout: 30_000 });
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version_path", "Tinas Second Brain/health-tracker/VERSION");
  }, 30_000);
});

describe("fetchGitClaimed — laundered ls-remote (exit 0, empty output) is never trusted", () => {
  // Some sandbox git wrappers launder exit codes: `git ls-remote --heads origin`
  // exits 0 with EMPTY output even when no origin exists (observed on the
  // Conductor /conductor/bin/git shim). Without the originConfigured guard,
  // that empty "success" reads as a live queue with zero claims — the exact
  // duplicate-allocation bug the guard closes. On healthy hosts the guarded
  // and unguarded paths are indistinguishable (ls-remote genuinely fails), so
  // only a laundering shim can pin the guard against reverts.
  test("no origin + shim that lies: claims still come from local refs, with the staleness warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "nextver-launder-"));
    const stubDir = join(dir, "stub-bin");
    mkdirSync(stubDir);
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    writeFileSync(
      join(stubDir, "git"),
      `#!/bin/sh\nif [ "$1" = "ls-remote" ]; then exit 0; fi\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(stubDir, "git"), 0o755);

    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, timeout: 30_000 });

    const cwd = process.cwd();
    const oldPath = process.env.PATH;
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "VERSION"), "0.1.66.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.66.0 chore: base");
      git(dir, "checkout", "-q", "-b", "sibling");
      writeFileSync(join(dir, "VERSION"), "0.1.67.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.67.0 feat: sibling claimed this");
      const sibSha = new TextDecoder().decode(git(dir, "rev-parse", "HEAD").stdout).trim();
      git(dir, "checkout", "-q", "main");
      git(dir, "update-ref", "refs/remotes/origin/sibling", sibSha);

      process.chdir(dir);
      process.env.PATH = `${stubDir}:${oldPath}`;
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      const versions = claims.map((c) => c.version);
      // The empty exit-0 probe must NOT be believed as "live queue is empty":
      expect(versions).toContain("0.1.67.0");
      expect(warnings.join(" ")).toContain("stale local refs/remotes/origin");
    } finally {
      process.env.PATH = oldPath;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("origin CONFIGURED + shim that lies: a zero-head exit-0 probe is distrusted, not read as an empty queue", () => {
    // The normal Conductor worktree state: origin IS configured, but the
    // laundering shim makes a failed ls-remote exit 0 with empty stdout. A
    // configured origin that advertises zero heads is contradictory (every
    // reachable remote advertises at least its default branch), so the
    // allocator must fall back to local refs with the laundering warning.
    const dir = mkdtempSync(join(tmpdir(), "nextver-launder-cfg-"));
    const stubDir = join(dir, "stub-bin");
    mkdirSync(stubDir);
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    writeFileSync(
      join(stubDir, "git"),
      `#!/bin/sh\nif [ "$1" = "ls-remote" ]; then exit 0; fi\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(stubDir, "git"), 0o755);

    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, timeout: 30_000 });

    const cwd = process.cwd();
    const oldPath = process.env.PATH;
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "VERSION"), "0.1.66.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.66.0 chore: base");
      git(dir, "checkout", "-q", "-b", "sibling");
      writeFileSync(join(dir, "VERSION"), "0.1.67.0\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "v0.1.67.0 feat: sibling claimed this");
      const sibSha = new TextDecoder().decode(git(dir, "rev-parse", "HEAD").stdout).trim();
      git(dir, "checkout", "-q", "main");
      git(dir, "update-ref", "refs/remotes/origin/sibling", sibSha);
      // Configured origin (unreachable path — the shim intercepts before git tries it).
      git(dir, "remote", "add", "origin", "/nonexistent/laundered-origin.git");

      process.chdir(dir);
      process.env.PATH = `${stubDir}:${oldPath}`;
      const warnings: string[] = [];
      const claims = fetchGitClaimed("main", "VERSION", warnings);
      const versions = claims.map((c) => c.version);
      expect(versions).toContain("0.1.67.0");
      expect(warnings.join(" ")).toContain("advertised zero heads");
    } finally {
      process.env.PATH = oldPath;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
