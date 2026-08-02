/**
 * Unit tests for lib/gbrain-sources.ts (per /plan-eng-review D3 DRY extraction).
 *
 * The helper shells out to the real `gbrain` CLI. To test idempotency
 * deterministically without a live brain, we put a fake `gbrain` binary on
 * PATH that emits canned `sources list --json` output and records its
 * invocations. The same trick `test/gstack-gbrain-source-wireup.test.ts` uses.
 */

import { describe, it, expect, spyOn } from "bun:test";
import * as childProcess from "child_process";
import { spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  bindRegisteredSourcePath,
  canonicalSourceDirectory,
  canonicalSourceDirectoryPath,
  ensureSourceRegistered,
  probeSource,
  registeredSourceMatchesDirectory,
  sourcePageCount,
  type DirectoryFsOps,
} from "../lib/gbrain-sources";

interface FakeGbrainSetup {
  root: string;
  bindir: string;
  statePath: string;
  logPath: string;
  /**
   * Env to pass to helper calls. Bun's execFileSync does NOT respect runtime
   * mutations of process.env.PATH; we have to pass env explicitly. Production
   * callers leave this unset (inherit process.env) — the helper signature has
   * an optional `env` param specifically for tests.
   */
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Build a temp dir with a fake `gbrain` shell script on PATH. The fake honors:
 *   gbrain sources list --json     → cat $STATE_PATH
 *   gbrain sources add <id> --path <p> [--federated]  → append to state, log
 *   gbrain sources remove <id> --yes                  → drop from state, log
 *   gbrain --version                                  → echo "gbrain 0.25.1"
 * Anything else exits 1.
 */
function makeFakeGbrain(initialState: { sources: Array<{ id: string; local_path?: string; federated?: boolean; page_count?: number }> }): FakeGbrainSetup {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-sources-test-"));
  const bindir = join(tmp, "bin");
  mkdirSync(bindir, { recursive: true });
  const statePath = join(tmp, "state.json");
  const logPath = join(tmp, "calls.log");
  writeFileSync(statePath, JSON.stringify(initialState));
  writeFileSync(logPath, "");

  const fake = `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1 $2" in
  "--version ")
    echo "gbrain 0.25.1"
    exit 0
    ;;
  "sources list")
    cat "${statePath}"
    exit 0
    ;;
  "sources add")
    if [ "\${FAKE_GBRAIN_FAIL_ADD:-}" = "1" ]; then
      echo "simulated add failure" >&2
      exit 9
    fi
    ID="$3"
    shift 3
    PATH_VAL=""
    FED="false"
    while [ $# -gt 0 ]; do
      case "$1" in
        --path) PATH_VAL="$2"; shift 2 ;;
        --federated) FED="true"; shift ;;
        *) shift ;;
      esac
    done
    NEW=$(jq --arg id "$ID" --arg path "$PATH_VAL" --argjson fed "$FED" \
      '.sources += [{id: $id, local_path: $path, federated: $fed, page_count: 0}]' "${statePath}")
    echo "$NEW" > "${statePath}"
    if [ "\${FAKE_GBRAIN_MALFORM_AFTER_ADD:-}" = "1" ]; then
      echo '{"pages":[]}' > "${statePath}"
    fi
    exit 0
    ;;
  "sources remove")
    ID="$3"
    NEW=$(jq --arg id "$ID" '.sources = (.sources | map(select(.id != $id)))' "${statePath}")
    echo "$NEW" > "${statePath}"
    if [ "\${FAKE_GBRAIN_MALFORM_AFTER_REMOVE:-}" = "1" ]; then
      echo '{"pages":[]}' > "${statePath}"
    fi
    exit 0
    ;;
esac
echo "fake gbrain: unknown command: $@" >&2
exit 1
`;
  const fakePath = join(bindir, "gbrain");
  writeFileSync(fakePath, fake);
  chmodSync(fakePath, 0o755);

  // Build the env override we'll pass to helper calls. We do NOT mutate
  // process.env globally because Bun's execFileSync caches PATH at process
  // start; explicit env is the only reliable way to redirect spawn-time PATH.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bindir}:${process.env.PATH || ""}` };

  return {
    root: tmp,
    bindir,
    statePath,
    logPath,
    env,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function makeDirectory(fake: FakeGbrainSetup, name: string): string {
  const path = join(fake.root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function expectNoMutation(fake: FakeGbrainSetup): void {
  const log = readFileSync(fake.logPath, "utf-8");
  expect(log).not.toContain("sources remove");
  expect(log).not.toContain("sources add");
}

function readLog(fake: FakeGbrainSetup): string[] {
  return readFileSync(fake.logPath, "utf-8").trim().split("\n").filter(Boolean);
}

function readMutationLog(fake: FakeGbrainSetup): string[] {
  return readLog(fake).filter((line) => /^sources (?:add|remove)\b/.test(line));
}

function fakeGuardedRemove(
  fake: FakeGbrainSetup,
): (id: string, registeredPath: string, env?: NodeJS.ProcessEnv) => void {
  return (id, _registeredPath, env) => {
    const result = spawnSync(
      "gbrain",
      ["sources", "remove", id, "--confirm-destructive"],
      { encoding: "utf-8", env: env ?? fake.env },
    );
    if (result.status !== 0) {
      throw new Error(
        `guarded test remove failed: ${result.stderr || result.stdout}`,
      );
    }
  };
}

function fakeWindowsFsOps(
  options: {
    links?: Record<string, string>;
    canonical?: Record<string, string>;
    onRealpath?: (path: string) => void;
  } = {},
): DirectoryFsOps {
  const links = options.links ?? {};
  const canonical = options.canonical ?? {};
  return {
    lstat: (path) => ({ isSymbolicLink: () => Object.hasOwn(links, path) }),
    readlink: (path) => links[path],
    realpath: (path) => {
      options.onRealpath?.(path);
      return canonical[path] ?? path;
    },
    stat: (path) => ({
      dev: 1n,
      ino: BigInt([...path].reduce((sum, char) => sum + char.charCodeAt(0), 1)),
      isDirectory: () => true,
    }),
  };
}

describe("probeSource", () => {
  it("returns absent when source id is not in the list", () => {
    const fake = makeFakeGbrain({ sources: [{ id: "other-source", local_path: "/x" }] });
    const state = probeSource("gstack-code-foo", fake.env);
    expect(state.status).toBe("absent");
    expect(state.registered_path).toBeUndefined();
    fake.cleanup();
  });

  it("returns match when source id is registered (path included)", () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "/Users/me/repo" }],
    });
    const state = probeSource("gstack-code-foo", fake.env);
    expect(state.status).toBe("match");
    expect(state.registered_path).toBe("/Users/me/repo");
    fake.cleanup();
  });

  it("accepts an unrelated default source with null local_path", () => {
    const fake = makeFakeGbrain({
      sources: [
        { id: "default-source", local_path: null as unknown as string },
        { id: "gstack-code-foo", local_path: "/Users/me/repo" },
      ],
    });
    const state = probeSource("gstack-code-foo", fake.env);
    expect(state).toEqual({
      status: "match",
      registered_path: "/Users/me/repo",
    });
    fake.cleanup();
  });
});

describe("ensureSourceRegistered", () => {
  it("fails closed on a malformed registry shape without mutation", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    writeFileSync(fake.statePath, JSON.stringify({ pages: [] }));

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/unknown JSON shape/);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("adds source when absent, returns changed=true", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const result = await ensureSourceRegistered("gstack-code-foo", repo, {
      federated: true,
      env: fake.env,
    });
    const canonicalRepo = realpathSync(repo);
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe("match");
    expect(result.state.registered_path).toBe(canonicalRepo);

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).toContain(
      `sources add gstack-code-foo --path ${canonicalRepo} --federated`,
    );
    expect(log).not.toContain("sources remove");
    fake.cleanup();
  });

  it("persists the validated canonical directory when the expected path is relative", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const previousCwd = process.cwd();

    try {
      process.chdir(fake.root);
      const result = await ensureSourceRegistered("gstack-code-foo", "repo", {
        env: fake.env,
      });
      expect(result).toEqual({
        changed: true,
        state: { status: "match", registered_path: realpathSync(repo) },
      });
      expect(readMutationLog(fake)).toEqual([
        `sources add gstack-code-foo --path ${realpathSync(repo)}`,
      ]);
    } finally {
      process.chdir(previousCwd);
      fake.cleanup();
    }
  });

  it("binds a drift repair to the validated symlink target", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const target = makeDirectory(fake, "new-path");
    const alias = join(fake.root, "new-path-alias");
    symlinkSync(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      }),
    );

    const result = await ensureSourceRegistered("gstack-code-foo", alias, {
      env: fake.env,
      removeSource: fakeGuardedRemove(fake),
    });
    const canonicalTarget = realpathSync(target);

    expect(result.state).toEqual({
      status: "match",
      registered_path: canonicalTarget,
    });
    expect(readMutationLog(fake)).toEqual([
      "sources remove gstack-code-foo --confirm-destructive",
      `sources add gstack-code-foo --path ${canonicalTarget}`,
    ]);
    fake.cleanup();
  });

  it("is a no-op when source is already at the correct path, returns changed=false", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: repo }],
    }));
    const result = await ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env });
    expect(result.changed).toBe(false);
    expect(result.state.status).toBe("match");

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).toContain("sources list --json");
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("resolves a relative expected path from the caller's working directory", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const previousCwd = process.cwd();
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: repo }],
    }));

    try {
      process.chdir(fake.root);
      const result = await ensureSourceRegistered("gstack-code-foo", "repo", { env: fake.env });
      expect(result.changed).toBe(false);
      expect(result.state).toEqual({ status: "match", registered_path: repo });
      expectNoMutation(fake);
    } finally {
      process.chdir(previousCwd);
      fake.cleanup();
    }
  });

  it("treats stored dot as the expected repository without re-registering", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "." }],
    });
    const repo = makeDirectory(fake, "repo");

    const result = await ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env });

    expect(result).toEqual({
      changed: false,
      state: { status: "match", registered_path: "." },
    });
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("treats a symlink or junction and its real directory as the same source", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const alias = join(fake.root, "repo-alias");
    symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: alias }],
    }));

    const result = await ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env });

    expect(result.changed).toBe(false);
    expect(result.state).toEqual({ status: "match", registered_path: alias });
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("fails closed on a POSIX backslash filename this Bun runtime cannot canonicalize", async () => {
    if (process.platform === "win32") return;
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, String.raw`foo\bar`);
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: repo }],
      }),
    );

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(
      /POSIX backslash filename component.*cannot canonicalize safely/,
    );
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("accepts a common relative symlink target whose parent traversal is leading", async () => {
    if (process.platform === "win32") return;
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const aliases = makeDirectory(fake, "aliases");
    const alias = join(aliases, "repo");
    symlinkSync("../repo", alias, "dir");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: alias }],
      }),
    );

    const result = await ensureSourceRegistered("gstack-code-foo", repo, {
      env: fake.env,
    });

    expect(result.changed).toBe(false);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a registered path after more than 40 real symbolic-link hops", async () => {
    if (process.platform === "win32") return;
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const links = Array.from({ length: 41 }, (_, index) =>
      join(fake.root, `hop-${index}`),
    );

    try {
      for (let index = 0; index < links.length - 1; index += 1) {
        symlinkSync(`hop-${index + 1}`, links[index], "dir");
      }
      symlinkSync(repo, links.at(-1)!, "dir");
      writeFileSync(
        fake.statePath,
        JSON.stringify({
          sources: [{ id: "gstack-code-foo", local_path: links[0] }],
        }),
      );

      await expect(
        ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
      ).rejects.toThrow(/exceeds 40 symbolic-link hops/);
      expectNoMutation(fake);
    } finally {
      fake.cleanup();
    }
  });

  it("rejects a real symbolic-link cycle before mutation", async () => {
    if (process.platform === "win32") return;
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const first = join(fake.root, "cycle-a");
    const second = join(fake.root, "cycle-b");

    try {
      symlinkSync("cycle-b", first, "dir");
      symlinkSync("cycle-a", second, "dir");
      writeFileSync(
        fake.statePath,
        JSON.stringify({
          sources: [{ id: "gstack-code-foo", local_path: first }],
        }),
      );

      await expect(
        ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
      ).rejects.toThrow(/contains a symbolic-link cycle/);
      expectNoMutation(fake);
    } finally {
      fake.cleanup();
    }
  });

  it("accepts a local Windows junction only after a no-follow link inspection", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: String.raw`C:\alias` }],
    });
    const expected = String.raw`C:\repo`;
    const alias = String.raw`C:\alias`;
    const fsOps = fakeWindowsFsOps({
      links: { [alias]: String.raw`\\?\C:\repo` },
      canonical: { [alias]: expected },
    });

    const result = await ensureSourceRegistered("gstack-code-foo", expected, {
      env: fake.env,
      platform: "win32",
      fsOps,
    });

    expect(result.changed).toBe(false);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("does not conflate case-distinct Windows link targets into a false cycle", async () => {
    const expected = String.raw`C:\Repo`;
    const alias = String.raw`C:\Alias`;
    const upperTarget = String.raw`C:\Foo\B`;
    const lowerTarget = String.raw`C:\foo\b`;
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: alias }],
    });
    const fsOps = fakeWindowsFsOps({
      links: {
        [alias]: upperTarget,
        [upperTarget]: lowerTarget,
      },
      canonical: { [lowerTarget]: expected },
    });

    const result = await ensureSourceRegistered("gstack-code-foo", expected, {
      env: fake.env,
      platform: "win32",
      fsOps,
    });

    expect(result.changed).toBe(false);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a Windows junction to UNC before realpath follows it", async () => {
    const alias = String.raw`C:\repo\alias`;
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: alias }],
    });
    let realpathCalls = 0;
    const fsOps = fakeWindowsFsOps({
      links: { [alias]: String.raw`\\attacker.invalid\share` },
      onRealpath: () => {
        realpathCalls += 1;
      },
    });

    await expect(
      ensureSourceRegistered("gstack-code-foo", String.raw`C:\repo`, {
        env: fake.env,
        platform: "win32",
        fsOps,
      }),
    ).rejects.toThrow(
      /link target.*remote or device path namespace.*before filesystem access/,
    );

    expect(realpathCalls).toBe(1); // trusted expected root only
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a nested link/.. target before it can hide another link", async () => {
    const alias = String.raw`C:\Repo\alias`;
    const hiddenLink = String.raw`C:\Repo\link`;
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: alias }],
    });
    let hiddenLinkInspections = 0;
    const base = fakeWindowsFsOps({
      links: {
        [alias]: String.raw`link\..`,
        [hiddenLink]: String.raw`\\attacker.invalid\share`,
      },
    });
    const fsOps: DirectoryFsOps = {
      ...base,
      lstat: (path) => {
        if (path === hiddenLink) hiddenLinkInspections += 1;
        return base.lstat(path);
      },
    };

    await expect(
      ensureSourceRegistered("gstack-code-foo", String.raw`C:\Repo`, {
        env: fake.env,
        platform: "win32",
        fsOps,
      }),
    ).rejects.toThrow(
      /link target.*parent traversal after a path component.*before filesystem access/,
    );

    expect(hiddenLinkInspections).toBe(0);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects an untrusted Windows path on another drive before filesystem access", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: String.raw`Z:\repo` }],
    });
    let lstatCalls = 0;
    const base = fakeWindowsFsOps();
    const fsOps: DirectoryFsOps = {
      ...base,
      lstat: (path) => {
        lstatCalls += 1;
        return base.lstat(path);
      },
    };

    await expect(
      ensureSourceRegistered("gstack-code-foo", String.raw`C:\repo`, {
        env: fake.env,
        platform: "win32",
        fsOps,
      }),
    ).rejects.toThrow(/different filesystem root.*before filesystem access/);

    expect(lstatCalls).toBe(0);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("preserves an exact Windows no-op source under a path with spaces", async () => {
    const repo = String.raw`C:\Users\Jane Doe\repo`;
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: repo }],
    });

    const result = await ensureSourceRegistered("gstack-code-foo", repo, {
      env: fake.env,
      platform: "win32",
      fsOps: fakeWindowsFsOps(),
    });

    expect(result.changed).toBe(false);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("uses filesystem identity for paths that differ only by case", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const upper = makeDirectory(fake, "CaseRepo");
    const lower = makeDirectory(fake, "caserepo");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: upper }],
      }),
    );

    const upperStat = statSync(upper, { bigint: true });
    const lowerStat = statSync(lower, { bigint: true });
    const sameIdentity =
      upperStat.ino !== 0n && lowerStat.ino !== 0n
        ? upperStat.dev === lowerStat.dev && upperStat.ino === lowerStat.ino
        : realpathSync(upper) === realpathSync(lower);
    const result = await ensureSourceRegistered("gstack-code-foo", lower, {
      env: fake.env,
      removeSource: fakeGuardedRemove(fake),
    });

    expect(result.changed).toBe(!sameIdentity);
    if (sameIdentity) {
      expectNoMutation(fake);
    } else {
      expect(readMutationLog(fake)).toEqual([
        "sources remove gstack-code-foo --confirm-destructive",
        `sources add gstack-code-foo --path ${realpathSync(lower)}`,
      ]);
    }
    fake.cleanup();
  });

  it("recreates source when path differs (gbrain has no `sources update`), returns changed=true", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const newPath = makeDirectory(fake, "new-path");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: oldPath }],
    }));
    const result = await ensureSourceRegistered("gstack-code-foo", newPath, {
      federated: true,
      env: fake.env,
      removeSource: fakeGuardedRemove(fake),
    });
    const canonicalNewPath = realpathSync(newPath);
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe("match");
    expect(result.state.registered_path).toBe(canonicalNewPath);

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).toContain(
      "sources remove gstack-code-foo --confirm-destructive",
    );
    expect(log).toContain(
      `sources add gstack-code-foo --path ${canonicalNewPath} --federated`,
    );
    expect(log.indexOf("sources remove")).toBeLessThan(
      log.indexOf("sources add"),
    );
    fake.cleanup();
  });

  it("refuses true drift before removal when no guarded policy is provided", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const newPath = makeDirectory(fake, "new-path");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      }),
    );

    await expect(
      ensureSourceRegistered("gstack-code-foo", newPath, { env: fake.env }),
    ).rejects.toThrow(
      /no guarded removal policy was provided.*registration unchanged/,
    );

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("reports a guarded-remove refusal without starting the replacement add", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const newPath = makeDirectory(fake, "new-path");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      }),
    );

    try {
      await expect(
        ensureSourceRegistered("gstack-code-foo", newPath, {
          env: fake.env,
          removeSource: () => {
            throw new Error("owner guard refused removal");
          },
        }),
      ).rejects.toThrow(
        /guarded path-drift remove.*owner guard refused removal.*state may have changed/,
      );

      expect(readMutationLog(fake)).toEqual([]);
      expect(JSON.parse(readFileSync(fake.statePath, "utf-8"))).toEqual({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      });
    } finally {
      fake.cleanup();
    }
  });

  it("fails closed when a guarded remove returns but the source row remains", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const newPath = makeDirectory(fake, "new-path");
    const phases: string[] = [];
    let removeCalls = 0;
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      }),
    );

    try {
      await expect(
        ensureSourceRegistered("gstack-code-foo", newPath, {
          env: fake.env,
          removeSource: () => {
            removeCalls += 1;
          },
          beforeMutation: (phase) => phases.push(phase),
        }),
      ).rejects.toThrow(/returned without removing the validated source/);

      expect(removeCalls).toBe(1);
      expect(phases).toEqual(["before-remove"]);
      expect(readMutationLog(fake)).toEqual([]);
      expect(JSON.parse(readFileSync(fake.statePath, "utf-8"))).toEqual({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      });
    } finally {
      fake.cleanup();
    }
  });

  it("reports partial state when add fails after guarded drift removal", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const newPath = makeDirectory(fake, "new-path");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      }),
    );

    await expect(
      ensureSourceRegistered("gstack-code-foo", newPath, {
        env: { ...fake.env, FAKE_GBRAIN_FAIL_ADD: "1" },
        removeSource: fakeGuardedRemove(fake),
      }),
    ).rejects.toThrow(
      /previous drifted registration was already removed.*absent or ambiguous/,
    );

    expect(readMutationLog(fake)).toEqual([
      "sources remove gstack-code-foo --confirm-destructive",
      `sources add gstack-code-foo --path ${realpathSync(newPath)}`,
    ]);
    fake.cleanup();
  });

  it("reports a spawn exception before an absent source add can start", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const spawn = spyOn(childProcess, "spawnSync").mockImplementation(() => {
      throw new Error("simulated spawn exception");
    });

    try {
      await expect(
        ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
      ).rejects.toThrow(
        /failed to start: simulated spawn exception.*may not have been registered/i,
      );
      expectNoMutation(fake);
    } finally {
      spawn.mockRestore();
      fake.cleanup();
    }
  });

  it("reports that the old row was removed when the post-remove registry read is malformed", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const old = makeDirectory(fake, "old");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: old }],
      }),
    );

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, {
        env: { ...fake.env, FAKE_GBRAIN_MALFORM_AFTER_REMOVE: "1" },
        removeSource: fakeGuardedRemove(fake),
      }),
    ).rejects.toThrow(
      /old registration was already removed.*could not be confirmed.*absent or ambiguous/,
    );
    expect(readMutationLog(fake)).toEqual([
      "sources remove gstack-code-foo --confirm-destructive",
    ]);
    fake.cleanup();
  });

  it("reports an unconfirmed persisted state when add succeeds but the registry read is malformed", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, {
        env: { ...fake.env, FAKE_GBRAIN_MALFORM_AFTER_ADD: "1" },
      }),
    ).rejects.toThrow(
      /returned success.*persisted state could not be confirmed.*ambiguous/,
    );
    expect(readMutationLog(fake)).toEqual([
      `sources add gstack-code-foo --path ${realpathSync(repo)}`,
    ]);
    fake.cleanup();
  });

  it("when reregister_on_drift=false and source is at different path, returns changed=false", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const newPath = makeDirectory(fake, "new-path");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: oldPath }],
    }));
    const result = await ensureSourceRegistered("gstack-code-foo", newPath, {
      reregister_on_drift: false,
      env: fake.env,
    });
    expect(result.changed).toBe(false);
    expect(result.state.status).toBe("drift");
    expect(result.state.registered_path).toBe(oldPath);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("fails before mutation when a Windows add path needs unsafe shell transport", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = String.raw`C:\Users\Jane Doe\repo`;

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, {
        env: fake.env,
        platform: "win32",
        fsOps: fakeWindowsFsOps(),
      }),
    ).rejects.toThrow(/unsafe for the current Windows GBrain shell transport/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("revalidates directory identity immediately before destructive drift repair", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const oldPath = makeDirectory(fake, "old-path");
    const expected = makeDirectory(fake, "expected");
    const moved = join(fake.root, "expected-before-replacement");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: oldPath }],
      }),
    );

    await expect(
      ensureSourceRegistered("gstack-code-foo", expected, {
        env: fake.env,
        removeSource: fakeGuardedRemove(fake),
        beforeMutation: (phase) => {
          if (phase !== "before-remove") return;
          renameSync(expected, moved);
          mkdirSync(expected);
        },
      }),
    ).rejects.toThrow(/changed after validation/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a caller-captured expected identity after the path is replaced", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const captured = canonicalSourceDirectory(repo);
    const moved = join(fake.root, "repo-before-replacement");
    renameSync(repo, moved);
    mkdirSync(repo);

    try {
      await expect(
        ensureSourceRegistered("gstack-code-foo", repo, {
          env: fake.env,
          expected_identity: captured,
        }),
      ).rejects.toThrow(
        /changed after caller validation: directory identity changed.*registration unchanged/,
      );
      expectNoMutation(fake);
    } finally {
      fake.cleanup();
    }
  });

  it("fails visibly when the validated directory changes after add", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const expected = makeDirectory(fake, "expected");
    const canonicalExpected = realpathSync(expected);
    const moved = join(fake.root, "expected-before-replacement");

    await expect(
      ensureSourceRegistered("gstack-code-foo", expected, {
        env: fake.env,
        beforeMutation: (phase) => {
          if (phase !== "after-add") return;
          renameSync(expected, moved);
          mkdirSync(expected);
        },
      }),
    ).rejects.toThrow(/changed after validation/);

    expect(readMutationLog(fake)).toEqual([
      `sources add gstack-code-foo --path ${canonicalExpected}`,
    ]);
    fake.cleanup();
  });

  it("fails closed when the filesystem cannot provide a stable identity token", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = String.raw`C:\repo`;
    let device = 1n;
    const base = fakeWindowsFsOps();
    const fsOps: DirectoryFsOps = {
      ...base,
      stat: () => ({
        dev: device,
        ino: 0n,
        isDirectory: () => true,
      }),
    };

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, {
        env: fake.env,
        platform: "win32",
        fsOps,
        beforeMutation: (phase) => {
          if (phase === "before-add") device = 2n;
        },
      }),
    ).rejects.toThrow(/stable directory identity is unavailable/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("fails visibly when a successful add does not persist the validated source row", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const expected = makeDirectory(fake, "expected");

    await expect(
      ensureSourceRegistered("gstack-code-foo", expected, {
        env: fake.env,
        beforeMutation: (phase) => {
          if (phase === "after-add") {
            writeFileSync(fake.statePath, JSON.stringify({ sources: [] }));
          }
        },
      }),
    ).rejects.toThrow(/did not persist the validated path/);

    expect(readMutationLog(fake)).toEqual([
      `sources add gstack-code-foo --path ${realpathSync(expected)}`,
    ]);
    fake.cleanup();
  });

  it("rejects a missing expected directory before adding an absent source", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const missing = join(fake.root, "missing-repo");

    await expect(
      ensureSourceRegistered("gstack-code-foo", missing, { env: fake.env }),
    ).rejects.toThrow(/expected source path.*source registration unchanged.*rerun \/sync-gbrain/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a non-directory expected path before adding an absent source", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const file = join(fake.root, "repo.txt");
    writeFileSync(file, "not a directory");

    await expect(
      ensureSourceRegistered("gstack-code-foo", file, { env: fake.env }),
    ).rejects.toThrow(/expected source path.*not a directory.*source registration unchanged/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("names the stored path when the expected path is invalid and leaves registration unchanged", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const registered = makeDirectory(fake, "registered-repo");
    const missingExpected = join(fake.root, "missing-expected-repo");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: registered }],
    }));

    await expect(
      ensureSourceRegistered("gstack-code-foo", missingExpected, { env: fake.env }),
    ).rejects.toThrow(
      new RegExp(`expected source path.*${registered}.*${missingExpected}.*source registration unchanged`),
    );

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a missing registered directory before remove or add", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const missingRegistered = join(fake.root, "missing-registered-repo");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: missingRegistered }],
    }));

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/registered source path.*source registration unchanged.*sources list --json.*rerun \/sync-gbrain/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects an empty registered path before remove or add", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "" }],
    });
    const repo = makeDirectory(fake, "repo");

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/registered source path.*is missing or empty.*source registration unchanged/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a missing registered path before remove or add", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo" }],
    });
    const repo = makeDirectory(fake, "repo");

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/registered source path.*expected root.*missing or empty.*source registration unchanged/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a non-string registered path before remove or add", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: 42 as unknown as string }],
    });
    const repo = makeDirectory(fake, "repo");

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/source row with a non-string local_path/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a registered regular file before remove or add", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const file = join(fake.root, "registered.txt");
    writeFileSync(file, "not a directory");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: file }],
    }));

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/registered source path.*not a directory.*source registration unchanged/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a broken registered symlink before remove or add", async () => {
    if (process.platform === "win32") return;
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    const broken = join(fake.root, "broken-alias");
    symlinkSync(join(fake.root, "missing-target"), broken, "dir");
    writeFileSync(fake.statePath, JSON.stringify({
      sources: [{ id: "gstack-code-foo", local_path: broken }],
    }));

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/registered source path.*source registration unchanged/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a stored relative path that escapes the expected repository", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");
    makeDirectory(fake, "outside");
    writeFileSync(
      fake.statePath,
      JSON.stringify({
        sources: [{ id: "gstack-code-foo", local_path: "../outside" }],
      }),
    );

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/parent traversal.*before filesystem access/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects a Windows case-variant sibling escape before filesystem access", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: String.raw`..\repo` }],
    });
    let lstatCalls = 0;
    const base = fakeWindowsFsOps();
    const fsOps: DirectoryFsOps = {
      ...base,
      lstat: (path) => {
        lstatCalls += 1;
        return base.lstat(path);
      },
    };

    await expect(
      ensureSourceRegistered("gstack-code-foo", String.raw`C:\Repo`, {
        env: fake.env,
        platform: "win32",
        fsOps,
      }),
    ).rejects.toThrow(/parent traversal.*before filesystem access/);

    expect(lstatCalls).toBe(0);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects POSIX link/.. before collapsing the link target", async () => {
    if (process.platform === "win32") return;
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "link/.." }],
    });
    const repo = makeDirectory(fake, "repo");
    const outside = makeDirectory(fake, "outside");
    symlinkSync(outside, join(repo, "link"), "dir");

    await expect(
      ensureSourceRegistered("gstack-code-foo", repo, { env: fake.env }),
    ).rejects.toThrow(/link\/\.\..*parent traversal.*before filesystem access/);

    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects Windows junction/.. before inspecting a UNC target", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: String.raw`link\..` }],
    });
    let lstatCalls = 0;
    let registeredRealpathCalls = 0;
    const base = fakeWindowsFsOps({
      links: {
        [String.raw`C:\Repo\link`]: String.raw`\\attacker.invalid\share`,
      },
      onRealpath: (path) => {
        if (path !== String.raw`C:\Repo`) registeredRealpathCalls += 1;
      },
    });
    const fsOps: DirectoryFsOps = {
      ...base,
      lstat: (path) => {
        lstatCalls += 1;
        return base.lstat(path);
      },
    };

    await expect(
      ensureSourceRegistered("gstack-code-foo", String.raw`C:\Repo`, {
        env: fake.env,
        platform: "win32",
        fsOps,
      }),
    ).rejects.toThrow(/parent traversal.*before filesystem access/);

    expect(lstatCalls).toBe(0);
    expect(registeredRealpathCalls).toBe(0);
    expectNoMutation(fake);
    fake.cleanup();
  });

  it("rejects unsafe source ids before invoking GBrain", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const repo = makeDirectory(fake, "repo");

    await expect(
      ensureSourceRegistered("bad&id", repo, { env: fake.env }),
    ).rejects.toThrow(/source id.*unsafe or invalid/);

    expect(readLog(fake)).toEqual([]);
    fake.cleanup();
  });
});

describe("canonicalSourceDirectoryPath", () => {
  it("rejects UNC and device namespaces before filesystem access", () => {
    for (const unsafe of [
      String.raw`\\attacker.invalid\share`,
      String.raw`\\?\C:\repo`,
      String.raw`\\.\PhysicalDrive0`,
      "//attacker.invalid/share",
    ]) {
      expect(() => canonicalSourceDirectoryPath(unsafe, "win32")).toThrow(
        /remote or device path namespace.*before filesystem access/,
      );
    }
  });

  it("rejects ambiguous Windows-relative paths before filesystem access", () => {
    for (const unsafe of [String.raw`C:repo`, String.raw`\repo`]) {
      expect(() => canonicalSourceDirectoryPath(unsafe, "win32")).toThrow(
        /drive-relative or root-relative.*before filesystem access/,
      );
    }
  });

  it("allows a Windows path with spaces when it is used as an OS-level cwd", () => {
    const repo = String.raw`C:\Users\Jane Doe\repo`;
    expect(
      canonicalSourceDirectoryPath(repo, "win32", fakeWindowsFsOps()),
    ).toBe(repo);
  });
});

describe("bindRegisteredSourcePath", () => {
  it("uses an explicit canonical override for an equivalent POSIX symlink", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "gbrain-binding-"));
    const repo = join(root, "repo");
    const alias = join(root, "alias");
    mkdirSync(repo);
    symlinkSync(repo, alias, "dir");
    try {
      const expected = canonicalSourceDirectory(repo);
      expect(bindRegisteredSourcePath(alias, expected)).toEqual({
        canonicalPath: realpathSync(repo),
        useExplicitPath: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for an unsafe Windows absolute alias", () => {
    const expectedPath = String.raw`C:\Users\Jane Doe\repo`;
    const alias = String.raw`C:\Users\Jane Doe\alias`;
    const fsOps = fakeWindowsFsOps({ canonical: { [alias]: expectedPath } });
    const expected = canonicalSourceDirectory(expectedPath, "win32", fsOps);

    expect(() =>
      bindRegisteredSourcePath(alias, expected, "win32", fsOps),
    ).toThrow(
      /alias.*unsafe for the current Windows GBrain shell transport.*rebindable alias/,
    );
  });

  it("uses cwd for a stored dot under an unsafe Windows canonical path", () => {
    const expectedPath = String.raw`C:\Users\Jane Doe\repo`;
    const fsOps = fakeWindowsFsOps({
      canonical: { [expectedPath]: expectedPath },
    });
    const expected = canonicalSourceDirectory(expectedPath, "win32", fsOps);

    expect(bindRegisteredSourcePath(".", expected, "win32", fsOps)).toEqual({
      canonicalPath: expectedPath,
      useExplicitPath: false,
    });
  });

  it("compares Windows case variants by filesystem identity", () => {
    const expectedPath = String.raw`C:\Repo`;
    const storedPath = String.raw`C:\repo`;
    const fsOps = fakeWindowsFsOps({
      canonical: { [storedPath]: expectedPath },
    });
    const expected = canonicalSourceDirectory(expectedPath, "win32", fsOps);

    expect(
      registeredSourceMatchesDirectory(storedPath, expected, "win32", fsOps),
    ).toBe(true);
  });

  it("can require stable identity before a legacy source-id mutation", () => {
    const repo = String.raw`C:\repo`;
    const fsOps: DirectoryFsOps = {
      ...fakeWindowsFsOps(),
      stat: () => ({ dev: 1n, ino: 0n, isDirectory: () => true }),
    };
    const expected = canonicalSourceDirectory(repo, "win32", fsOps);

    expect(
      registeredSourceMatchesDirectory(repo, expected, "win32", fsOps),
    ).toBe(true);
    expect(
      registeredSourceMatchesDirectory(repo, expected, "win32", fsOps, true),
    ).toBe(false);
  });
});

describe("sourcePageCount", () => {
  it("returns the page_count when the source is registered", () => {
    const fake = makeFakeGbrain({
      sources: [
        { id: "gstack-code-foo", local_path: "/x", page_count: 1247 },
        { id: "other-source", local_path: "/y", page_count: 99 },
      ],
    });
    expect(sourcePageCount("gstack-code-foo", fake.env)).toBe(1247);
    expect(sourcePageCount("other-source", fake.env)).toBe(99);
    fake.cleanup();
  });

  it("returns null when the source is absent", () => {
    const fake = makeFakeGbrain({ sources: [{ id: "other", local_path: "/x", page_count: 5 }] });
    expect(sourcePageCount("missing", fake.env)).toBeNull();
    fake.cleanup();
  });

  it("returns null when page_count is missing from the source object", () => {
    const fake = makeFakeGbrain({ sources: [{ id: "no-count", local_path: "/x" } as { id: string; local_path: string }] });
    expect(sourcePageCount("no-count", fake.env)).toBeNull();
    fake.cleanup();
  });
});
