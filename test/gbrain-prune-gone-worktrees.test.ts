/**
 * A6 (#2688): a deleted worktree's gbrain code source is reported once as
 * "path unavailable" and is only removed by the explicit
 * `gstack-gbrain-sync --prune-gone-worktrees`, and only with positive
 * evidence that this machine created it and the worktree is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { decidePrune, trackUnavailableSources, type PruneContext } from "../lib/gbrain-sources";

const SYNC = join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts");

describe("prune decision (unit)", () => {
  const base = (over: Partial<PruneContext> = {}): PruneContext => ({
    unavailable: { "gstack-code-x": { path: "/w/gone", misses: 2, since: "t" } },
    records: { "gstack-code-x": { path: "/w/gone", remote: "github.com/acme/app", git_common_dir: "/repo/.git" } },
    current: null,
    deriveId: (path, remote) => (path === "/w/gone" && remote === "github.com/acme/app" ? "gstack-code-x" : "gstack-code-other"),
    exists: (p) => p === "/repo/.git",
    readableDir: () => true,
    worktreeListed: () => false,
    ...over,
  });

  it("removes only with every proof", () => {
    expect(decidePrune("gstack-code-x", "/w/gone", base()).remove).toBe(true);
  });

  it("keeps a source created on another host (id does not recompute here)", () => {
    const v = decidePrune("gstack-code-x", "/w/gone", base({ deriveId: () => "gstack-code-elsewhere" }));
    expect(v).toEqual({ remove: false, reason: expect.stringContaining("not proven to be this machine's source") });
  });

  it("keeps a source missing on fewer than two consecutive syncs", () => {
    const v = decidePrune("gstack-code-x", "/w/gone", base({ unavailable: { "gstack-code-x": { path: "/w/gone", misses: 1, since: "t" } } }));
    expect(v.reason).toContain("needs 2 consecutive syncs");
  });

  it("keeps a source whose parent directory is unreadable (unmounted volume)", () => {
    expect(decidePrune("gstack-code-x", "/w/gone", base({ readableDir: () => false })).reason).toContain("not readable");
  });

  it("keeps a source whose repository still lists the worktree, or cannot be checked", () => {
    expect(decidePrune("gstack-code-x", "/w/gone", base({ worktreeListed: () => true })).remove).toBe(false);
    expect(decidePrune("gstack-code-x", "/w/gone", base({ worktreeListed: () => null })).remove).toBe(false);
    expect(decidePrune("gstack-code-x", "/w/gone", base({ exists: () => false })).reason).toContain("not available to confirm");
  });

  it("counts consecutive misses and reports each source once", () => {
    const rows = [{ id: "gstack-code-x", local_path: "/w/gone" }, { id: "gstack-code-y", local_path: "/w/here" }, { id: "other", local_path: "/w/gone2" }];
    const exists = (p: string) => p === "/w/here";
    const first = trackUnavailableSources(rows, {}, exists, "t1");
    expect(first.newlyUnavailable).toEqual(["gstack-code-x"]);
    const second = trackUnavailableSources(rows, first.next, exists, "t2");
    expect(second.newlyUnavailable).toEqual([]);
    expect(second.next["gstack-code-x"]).toEqual({ path: "/w/gone", misses: 2, since: "t1" });
    expect(trackUnavailableSources(rows, second.next, () => true, "t3").next).toEqual({});
  });
});

describe("gstack-gbrain-sync with a deleted worktree (CLI)", () => {
  let home = "";
  let env: Record<string, string> = {};
  let repo = "";
  let gone = "";

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "gstack-prune-")));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    repo = join(home, "app");
    gone = join(home, "worktrees", "feature");
    env = {
      HOME: home, GSTACK_HOME: join(home, ".gstack"), PATH: `${bin}:/usr/bin:/bin`, GSTACK_HOSTNAME: "this-host",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...a: string[]) => expect(spawnSync("git", a, { env, cwd: home, timeout: 10_000 }).status).toBe(0);
    git("init", "-q", repo);
    git("-C", repo, "remote", "add", "origin", "https://github.com/acme/app.git");
    git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    mkdirSync(join(home, "worktrees"));
    git("-C", repo, "worktree", "add", "-q", gone);
    git("-C", repo, "worktree", "remove", "--force", gone);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function fakeGbrain(sources: Array<{ id: string; local_path: string }>) {
    writeFileSync(join(home, "bin", "gbrain"), `#!/bin/sh
echo "$*" >> "${home}/gbrain-calls.log"
case "$1 $2" in
  "sources list") echo '${JSON.stringify({ sources: sources.map((s) => ({ ...s, page_count: 3 })) })}' ;;
  "sources remove") exit 0 ;;
  *) exit 1 ;;
esac
`);
    chmodSync(join(home, "bin", "gbrain"), 0o755);
  }
  function sync(args: string[]) {
    const r = spawnSync(process.execPath, [SYNC, ...args], { env, cwd: repo, encoding: "utf-8", timeout: 60_000 });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  }
  async function idFor(path: string, host: string): Promise<string> {
    const r = spawnSync(process.execPath, ["-e", `import { deriveCodeSourceId } from ${JSON.stringify(SYNC)}; console.log(deriveCodeSourceId(${JSON.stringify(path)}, "github.com/acme/app"))`], {
      env: { ...env, GSTACK_HOSTNAME: host }, encoding: "utf-8", timeout: 20_000,
    });
    return r.stdout.trim();
  }

  it("reports the path once, never removes on sync, and prunes only this host's proven source", async () => {
    const mine = await idFor(gone, "this-host");
    const theirs = await idFor(gone, "other-host");
    expect(mine).not.toBe(theirs);
    fakeGbrain([{ id: mine, local_path: gone }, { id: theirs, local_path: gone }]);
    const noStages = ["--no-code", "--no-memory", "--no-brain-sync", "--quiet"];

    const first = sync(noStages);
    expect(first.out).toContain(`gbrain source ${mine}: path unavailable (${gone})`);
    expect(first.out).toContain("--prune-gone-worktrees --dry-run");
    const early = sync(["--prune-gone-worktrees", "--dry-run"]);
    expect(early.out).toContain(`keep ${mine} (${gone}): path missing on 1 sync(s) so far`);

    const second = sync(noStages);
    expect(second.out).not.toContain("path unavailable (");
    const log = () => (existsSync(join(home, "gbrain-calls.log")) ? readFileSync(join(home, "gbrain-calls.log"), "utf8") : "");
    expect(log()).not.toContain("sources remove");

    const dry = sync(["--prune-gone-worktrees", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.out).toContain(`would remove ${mine}`);
    expect(dry.out).toContain(`keep ${theirs}`);
    expect(log()).not.toContain("sources remove");

    const real = sync(["--prune-gone-worktrees"]);
    expect(real.status).toBe(0);
    expect(real.out).toContain(`removed ${mine} ${gone}`);
    expect(log()).toContain(`sources remove ${mine}`);
    expect(log()).not.toContain(`sources remove ${theirs}`);
    expect(readFileSync(join(home, ".gstack", ".gbrain-prune.log"), "utf8")).toContain(`removed ${mine}`);
  });
});
