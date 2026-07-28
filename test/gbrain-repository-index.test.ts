import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION,
  classifyRepositoryPath,
  compareReleasedVersions,
  parseReleasedGbrainVersion,
  parseStrictSourceSnapshot,
  runRepositoryIndex,
  summarizeAffectedItems,
  unsafeRepositoryPathForShell,
  verifyCurrentRepositoryIndexReceipt,
  writeRepositorySourceMarker,
  type GbrainSpawnOptions,
  type GbrainSpawnResult,
  type RepositoryIndexResult,
  type RepositoryState,
} from "../lib/gbrain-repository-index";

const ROOT = join(import.meta.dir, "..");
const SYNC = join(ROOT, "bin", "gstack-gbrain-sync.ts");
const tempDirs: string[] = [];

function makeCommittedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gstack-repository-index-"));
  tempDirs.push(repo);
  expect(spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "gstack@test.invalid"], { cwd: repo }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "gstack test"], { cwd: repo }).status).toBe(0);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(0);
  expect(spawnSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo }).status).toBe(0);
  return repo;
}

const ZERO_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function completeChild(
  sourceId: string,
  head: string,
  fromCommit: string | null,
  status: "synced" | "first_sync" | "up_to_date" = "up_to_date",
): Record<string, unknown> {
  return {
    schema_version: 1,
    result_kind: "gbrain_sync",
    status,
    source: { id: sourceId },
    repository: {
      from_commit: fromCommit,
      target_commit: head,
      bookmark_after: head,
      last_successful_strategy: "auto",
    },
    strategy: "auto",
    strategy_changed: false,
    operations: { added: 0, modified: 0, deleted: 0, renamed: 0 },
    affected: {
      total: 0,
      sample_limit: 100,
      sample: [],
      truncated: false,
    },
    affected_digest: ZERO_DIGEST,
    corpus: {
      markdown_planned_or_applied: 0,
      code_pages_before: 0,
      code_pages_after: 0,
      code_deletions_applied: 0,
      image_operations_applied: 0,
      image_pages_after: 0,
      multimodal_enabled: false,
      embedding_status: "deferred",
      extraction_status: "deferred",
      search_ready: false,
    },
  };
}

type SpawnCall = { args: string[]; options?: GbrainSpawnOptions };

function runnerFixture(options: {
  repo: string;
  sourceId?: string;
  version?: string;
  sources?: unknown;
  postSources?: unknown;
  finalSources?: unknown;
  sync?: unknown;
  syncExit?: number;
  afterPostSourceProbe?: (repo: string) => void;
  writeReceipt?: (path: string, receipt: RepositoryIndexResult) => void;
  writeSourceMarker?: (root: string, sourceId: string) => void;
  readRepositoryState?: (root: string) => RepositoryState;
}) {
  const sourceId = options.sourceId ?? "gstack-code-fixture-12345678";
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: options.repo,
    encoding: "utf-8",
  }).stdout.trim();
  const gstackHome = mkdtempSync(join(tmpdir(), "gstack-receipt-home-"));
  tempDirs.push(gstackHome);
  const calls: SpawnCall[] = [];
  let sourceProbeCount = 0;
  const spawnGbrain = (
    args: string[],
    spawnOptions?: GbrainSpawnOptions,
  ): GbrainSpawnResult => {
    calls.push({ args, options: spawnOptions });
    if (args[0] === "--version") {
      return {
        status: 0,
        stdout:
          options.version ??
          `gbrain ${REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION}\n`,
      };
    }
    if (args.join(" ") === "sources list --json") {
      sourceProbeCount++;
      if (sourceProbeCount === 2) {
        options.afterPostSourceProbe?.(options.repo);
      }
      const snapshot =
        sourceProbeCount >= 3 && options.finalSources !== undefined
          ? options.finalSources
          : sourceProbeCount > 1 && options.postSources !== undefined
            ? options.postSources
            : options.sources ?? { sources: [] };
      return {
        status: 0,
        stdout: JSON.stringify(snapshot),
      };
    }
    if (args[0] === "sources" && args[1] === "add") {
      return { status: 0, stdout: "" };
    }
    if (args[0] === "sync") {
      return {
        status: options.syncExit ?? 0,
        stdout:
          typeof options.sync === "string"
            ? options.sync
            : JSON.stringify(
                options.sync ??
                  completeChild(sourceId, head, head, "up_to_date"),
              ),
      };
    }
    throw new Error(`unexpected fake gbrain call: ${args.join(" ")}`);
  };

  return {
    calls,
    gstackHome,
    head,
    sourceId,
    run: (overrides: { clean?: boolean; platform?: NodeJS.Platform } = {}) =>
      runRepositoryIndex({
        root: options.repo,
        sourceId,
        head,
        workingTreeClean: overrides.clean ?? true,
        gstackHome,
        spawnGbrain,
        platform: overrides.platform,
        writeReceipt: options.writeReceipt,
        writeSourceMarker: options.writeSourceMarker,
        readRepositoryState: options.readRepositoryState,
      }),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("repository-index JSON contract", () => {
  test("wrapper dry-run is a no-probe, one-document orchestration preview", () => {
    const repo = makeCommittedRepo();
    const home = mkdtempSync(join(tmpdir(), "gstack-repository-index-home-"));
    tempDirs.push(home);

    const result = spawnSync(
      process.execPath,
      [SYNC, "--dry-run", "--code-only", "--json", "--quiet"],
      {
        cwd: repo,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          GSTACK_HOME: join(home, ".gstack"),
          PATH: "/nonexistent",
        },
      },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      schema_version: 1,
      result_kind: "repository_index",
      status: "preview_ready",
      reason_code: "blocked_until_version_proven",
      state_changed: "none",
      preview_kind: "orchestration_unvalidated",
    });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toBe("");
  });
});

describe("repository-index receipt rebinding", () => {
  test("a verified receipt is accepted only for its live canonical clean HEAD", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: completeChild(sourceId, head, head),
    });
    expect(fixture.run()).toMatchObject({
      exitCode: 0,
      result: {
        status: "verified",
        state_changed: "applied_verified",
      },
    });
    expect(
      verifyCurrentRepositoryIndexReceipt(repo, fixture.gstackHome),
    ).toMatchObject({
      exitCode: 0,
      result: {
        status: "verified",
        state_changed: "applied_verified",
      },
    });

    writeFileSync(join(repo, "README.md"), "# later commit\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "--quiet", "-m", "later"], { cwd: repo })
        .status,
    ).toBe(0);
    expect(
      verifyCurrentRepositoryIndexReceipt(repo, fixture.gstackHome),
    ).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "receipt_stale",
        state_changed: "none",
      },
    });
  });

  test("a receipt from another canonical worktree cannot verify", () => {
    const repo = makeCommittedRepo();
    const otherRepo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: completeChild(sourceId, head, head),
    });
    expect(fixture.run().exitCode).toBe(0);

    expect(
      verifyCurrentRepositoryIndexReceipt(otherRepo, fixture.gstackHome),
    ).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "receipt_stale",
        state_changed: "none",
        evidence: {
          receipt_canonical_path: realpathSync.native(repo),
          live_canonical_path: realpathSync.native(otherRepo),
        },
      },
    });
  });
});

describe("repository-index safety helpers", () => {
  test("skill and recovery docs consume only a live-bound receipt with exact corpus fields", () => {
    for (const relative of [
      "sync-gbrain/SKILL.md.tmpl",
      "sync-gbrain/SKILL.md",
      "docs/repository-index-recovery.md",
    ]) {
      const text = readFileSync(join(ROOT, relative), "utf-8");
      expect(text).toContain("image_operations_applied");
      expect(text).not.toMatch(/`image_operations(?:\s*==|:)/);
    }
    for (const relative of [
      "sync-gbrain/SKILL.md.tmpl",
      "sync-gbrain/SKILL.md",
    ]) {
      const text = readFileSync(join(ROOT, relative), "utf-8");
      expect(text).toContain("--verify-receipt --json");
      expect(text).toContain(
        "command exits nonzero, STOP on that current result",
      );
      expect(text).toMatch(
        /do not claim a\s+repository GREEN from historical evidence/,
      );
    }
  });

  test("released-version parsing is strict and compares all four fields", () => {
    expect(parseReleasedGbrainVersion("gbrain 0.42.70.0\n")).toEqual([
      0, 42, 70, 0,
    ]);
    expect(parseReleasedGbrainVersion("0.42.70.1")).toEqual([0, 42, 70, 1]);
    for (const invalid of [
      "0.42.70",
      "v0.42.70.0",
      "gbrain 0.42.70.0-beta.1",
      "gbrain 0.42.70.0+build",
      "version 0.42.70.0",
      "gbrain 0.42.70.0 extra",
    ]) {
      expect(parseReleasedGbrainVersion(invalid)).toBeNull();
    }
    expect(
      compareReleasedVersions([0, 42, 69, 99], [0, 42, 70, 0]),
    ).toBe(-1);
    expect(
      compareReleasedVersions([0, 42, 70, 0], [0, 42, 70, 0]),
    ).toBe(0);
    expect(
      compareReleasedVersions([0, 42, 70, 1], [0, 42, 70, 0]),
    ).toBe(1);
  });

  test("strict source snapshots accept only complete unique bare/wrapped rows", () => {
    const row = {
      id: "source-a",
      local_path: ".",
      last_commit: "a".repeat(40),
      last_successful_strategy: "auto",
    };
    const bare = parseStrictSourceSnapshot([row]);
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.rows).toEqual([row]);
      expect(Object.isFrozen(bare.rows)).toBe(true);
      expect(Object.isFrozen(bare.rows[0])).toBe(true);
    }
    expect(parseStrictSourceSnapshot({ sources: [row] }).ok).toBe(true);
    const withUnrelatedNullPath = parseStrictSourceSnapshot({
      sources: [
        {
          id: "default",
          local_path: null,
          last_commit: null,
          last_successful_strategy: null,
        },
        row,
      ],
    });
    expect(withUnrelatedNullPath.ok).toBe(true);

    for (const invalid of [
      null,
      {},
      { sources: [], extra: true },
      { sources: [null] },
      { sources: [{ id: "source-a" }] },
      { sources: [{ id: "source-a", local_path: 7 }] },
      {
        sources: [
          row,
          {
            id: "source-a",
            local_path: "/other",
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
      {
        sources: [
          {
            id: "source-a",
            local_path: ".",
            last_commit: "not-a-sha",
            last_successful_strategy: null,
          },
        ],
      },
      {
        sources: [
          {
            id: "source-a",
            local_path: ".",
            last_commit: null,
            last_successful_strategy: "future-strategy",
          },
        ],
      },
    ]) {
      expect(parseStrictSourceSnapshot(invalid).ok).toBe(false);
    }
  });

  test("path identity recognizes relative, absolute, and symlink aliases", () => {
    const repo = makeCommittedRepo();
    const parent = mkdtempSync(join(tmpdir(), "gstack-path-identity-"));
    tempDirs.push(parent);
    const alias = join(parent, "repo-alias");
    const other = join(parent, "other");
    const file = join(parent, "not-a-directory");
    symlinkSync(repo, alias, "dir");
    mkdirSync(other);
    writeFileSync(file, "not a directory");

    expect(classifyRepositoryPath(".", repo).kind).toBe("equivalent");
    expect(classifyRepositoryPath(repo, repo).kind).toBe("equivalent");
    expect(classifyRepositoryPath(alias, repo).kind).toBe("equivalent");
    expect(classifyRepositoryPath(other, repo).kind).toBe("different");
    expect(classifyRepositoryPath(file, repo).kind).toBe("ambiguous");
    expect(
      classifyRepositoryPath(join(parent, "missing"), repo).kind,
    ).toBe("ambiguous");
  });

  test("Windows shell transport refuses metacharacters without changing POSIX", () => {
    expect(unsafeRepositoryPathForShell("C:\\safe-repo", "win32")).toBe(false);
    for (const unsafe of [
      " ",
      "\t",
      "&",
      "|",
      "^",
      "%",
      "!",
      "(",
      ")",
      "\"",
      "\r",
      "\n",
    ]) {
      expect(
        unsafeRepositoryPathForShell(`C:\\repo${unsafe}sentinel`, "win32"),
      ).toBe(true);
    }
    expect(
      unsafeRepositoryPathForShell("/tmp/repo&ordinary-on-posix", "darwin"),
    ).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "wrapper-owned marker replacement never follows a raced symlink",
    () => {
      const repo = makeCommittedRepo();
      const outside = mkdtempSync(join(tmpdir(), "gstack-marker-target-"));
      tempDirs.push(outside);
      const target = join(outside, "sentinel");
      writeFileSync(target, "do not overwrite\n");
      const sourceId = "gstack-code-fixture-12345678";
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }).stdout.trim();
      const source = {
        id: sourceId,
        local_path: repo,
        last_commit: head,
        last_successful_strategy: "auto",
      };
      const fixture = runnerFixture({
        repo,
        sourceId,
        sources: { sources: [source] },
        sync: completeChild(sourceId, head, head),
        afterPostSourceProbe: (root) =>
          symlinkSync(target, join(root, ".gbrain-source")),
      });

      expect(fixture.run()).toMatchObject({
        exitCode: 0,
        result: {
          status: "verified",
          state_changed: "applied_verified",
        },
      });
      expect(readFileSync(target, "utf-8")).toBe("do not overwrite\n");
      expect(lstatSync(join(repo, ".gbrain-source")).isSymbolicLink()).toBe(
        false,
      );
      expect(readFileSync(join(repo, ".gbrain-source"), "utf-8")).toBe(
        `${sourceId}\n`,
      );
    },
  );

  test("wrapper-owned marker attachment fails closed on a directory target", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: completeChild(sourceId, head, head),
      afterPostSourceProbe: (root) =>
        mkdirSync(join(root, ".gbrain-source")),
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        reason_code: "verification_failed",
        state_changed: "applied_unverified",
        evidence: { failing_step: "source_attach" },
      },
    });
    expect(lstatSync(join(repo, ".gbrain-source")).isDirectory()).toBe(true);
  });

  test("affected evidence is canonical, stable, and capped at 100 rows", () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      operation: "modify",
      path: `docs/${String(index).padStart(3, "0")}.md`,
      slug: `doc-${index}`,
    }));
    const forward = summarizeAffectedItems(items);
    const reverse = summarizeAffectedItems([...items].reverse());
    expect(forward.total).toBe(101);
    expect(forward.sample).toHaveLength(100);
    expect(forward.truncated).toBe(true);
    expect(forward.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reverse).toEqual(forward);
    const changedOutsideSample = summarizeAffectedItems([
      ...items.slice(0, 100),
      { ...items[100], slug: "changed-outside-sample" },
    ]);
    expect(changedOutsideSample.sample).toEqual(forward.sample);
    expect(changedOutsideSample.sha256).not.toBe(forward.sha256);
  });

  test("affected digest matches the literal schema-1 byte contract", () => {
    const summary = summarizeAffectedItems([
      {
        operation: "rename",
        path: "docs/new.md",
        slug: "new",
        from_path: "docs/old.md",
      },
      {
        operation: "add",
        path: "CLAUDE.md",
        slug: "claude",
      },
    ]);

    // SHA-256("add\tCLAUDE.md\tclaude\nrename\tdocs/new.md\tnew\n").
    // from_path is intentionally descriptive and excluded from the digest.
    expect(summary.sha256).toBe(
      "068cf732646c90f64f94e2d26324cbd21f0707b2e802c43ea80607bd1af43b87",
    );
  });

  test("affected evidence sorts by UTF-8 bytes, not UTF-16 code units", () => {
    const supplementary = "docs/\u{10000}.md";
    const privateUse = "docs/\uE000.md";
    const summary = summarizeAffectedItems([
      { operation: "modify", path: supplementary, slug: "supplementary" },
      { operation: "modify", path: privateUse, slug: "private-use" },
    ]);

    expect(summary.sample.map((item) => item.path)).toEqual([
      privateUse,
      supplementary,
    ]);
  });

  test("affected evidence rejects past-tense operation aliases", () => {
    for (const operation of ["added", "modified", "deleted", "renamed"]) {
      expect(() =>
        summarizeAffectedItems([
          { operation, path: "docs/example.md", slug: "example" },
        ]),
      ).toThrow(/canonical repository-relative paths/);
    }
  });
});

describe("repository-index orchestration", () => {
  test("old versions refuse before the source snapshot", () => {
    const repo = makeCommittedRepo();
    const fixture = runnerFixture({ repo, version: "gbrain 0.42.69.99" });
    const output = fixture.run();

    expect(output.exitCode).toBe(1);
    expect(output.result).toMatchObject({
      status: "refused",
      reason_code: "unsupported_version",
      state_changed: "none",
    });
    expect(fixture.calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  test("an absent source is registered once and stops at registry_only", () => {
    const repo = makeCommittedRepo();
    const fixture = runnerFixture({ repo, sources: { sources: [] } });
    const output = fixture.run();

    expect(output.exitCode).toBe(2);
    expect(output.result).toMatchObject({
      status: "incomplete",
      reason_code: "source_registered",
      state_changed: "registry_only",
    });
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
      [
        "sources",
        "add",
        fixture.sourceId,
        "--path",
        realpathSync.native(repo),
        "--federated",
      ],
    ]);
  });

  test("an absent id never registers over an equivalent path owned by another source", () => {
    const repo = makeCommittedRepo();
    const fixture = runnerFixture({
      repo,
      sources: {
        sources: [
          {
            id: "already-indexed-here",
            local_path: repo,
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
    });
    const output = fixture.run();

    expect(output).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "source_path_ambiguous",
        state_changed: "none",
      },
    });
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
    ]);
  });

  test("an existing id still refuses ambiguous duplicate path ownership", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: {
        sources: [
          {
            id: sourceId,
            local_path: repo,
            last_commit: head,
            last_successful_strategy: "auto",
          },
          {
            id: "duplicate-owner",
            local_path: ".",
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "source_path_ambiguous",
        state_changed: "none",
      },
    });
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
    ]);
  });

  test("equivalent source runs exact expected-state argv/env and writes receipt", () => {
    const repo = makeCommittedRepo();
    const receipts: RepositoryIndexResult[] = [];
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: {
        sources: [
          {
            id: sourceId,
            local_path: ".",
            last_commit: head,
            last_successful_strategy: "auto",
          },
        ],
      },
      sync: completeChild(sourceId, head, head),
      writeReceipt: (_path, receipt) => receipts.push(receipt),
    });
    const inherited = process.env.GBRAIN_EMBEDDING_MULTIMODAL;
    const output = fixture.run();

    expect(output.exitCode).toBe(0);
    expect(output.result).toMatchObject({
      status: "verified",
      reason_code: "up_to_date",
      state_changed: "applied_verified",
    });
    expect(receipts).toHaveLength(1);
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
      [
        "sync",
        "--strategy",
        "auto",
        "--source",
        sourceId,
        "--repo",
        realpathSync.native(repo),
        "--no-pull",
        "--expected-target",
        head,
        "--expected-bookmark",
        head,
        "--require-clean",
        "--json",
      ],
      ["sources", "list", "--json"],
      ["sources", "list", "--json"],
    ]);
    expect(
      fixture.calls[2].options?.baseEnv?.GBRAIN_EMBEDDING_MULTIMODAL,
    ).toBe("false");
    for (const call of fixture.calls) {
      expect(call.options?.baseEnv?.GBRAIN_EMBEDDING_MULTIMODAL).toBe("false");
    }
    expect(process.env.GBRAIN_EMBEDDING_MULTIMODAL).toBe(inherited);
    expect(readFileSync(join(repo, ".gbrain-source"), "utf-8")).toBe(
      `${sourceId}\n`,
    );
    expect(
      spawnSync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repo, encoding: "utf-8" },
      ).stdout,
    ).toBe("");
    expect(
      spawnSync("git", ["ls-files"], {
        cwd: repo,
        encoding: "utf-8",
      }).stdout.trim(),
    ).toBe("README.md");
    const excludePath = spawnSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: repo, encoding: "utf-8" },
    ).stdout.trim();
    expect(readFileSync(join(repo, excludePath), "utf-8")).toContain(
      ".gbrain-source",
    );
  });

  test("a null bookmark is passed as none for first_sync", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const initialSource = {
      id: sourceId,
      local_path: repo,
      last_commit: null,
      last_successful_strategy: null,
    };
    const completedSource = {
      ...initialSource,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [initialSource] },
      postSources: { sources: [completedSource] },
      sync: completeChild(sourceId, head, null, "first_sync"),
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 0,
      result: {
        status: "verified",
        state_changed: "applied_verified",
      },
    });
    const syncArgs = fixture.calls.find((call) => call.args[0] === "sync")?.args;
    expect(syncArgs).toEqual([
      "sync",
      "--strategy",
      "auto",
      "--source",
      sourceId,
      "--repo",
      realpathSync.native(repo),
      "--no-pull",
      "--expected-target",
      head,
      "--expected-bookmark",
      "none",
      "--require-clean",
      "--json",
    ]);
  });

  test("dirty input omits require-clean but can never produce GREEN", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    writeFileSync(join(repo, "dirty.md"), "uncommitted\n");
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: completeChild(sourceId, head, head),
    });

    expect(fixture.run({ clean: false })).toMatchObject({
      exitCode: 1,
      result: {
        status: "error",
        reason_code: "verification_failed",
        state_changed: "applied_unverified",
      },
    });
    const syncArgs = fixture.calls.find((call) => call.args[0] === "sync")?.args;
    expect(syncArgs).not.toContain("--require-clean");
    expect(syncArgs?.at(-1)).toBe("--json");
  });

  test("a matching untracked source marker is locally excluded before retry", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    writeFileSync(join(repo, ".gbrain-source"), `${sourceId}\n`);
    chmodSync(join(repo, ".gbrain-source"), 0o644);
    expect(
      spawnSync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repo, encoding: "utf-8" },
      ).stdout,
    ).toContain(".gbrain-source");
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: completeChild(sourceId, head, head),
    });

    expect(fixture.run({ clean: false })).toMatchObject({
      exitCode: 0,
      result: {
        status: "verified",
        state_changed: "applied_verified",
      },
    });
    const syncArgs = fixture.calls.find((call) => call.args[0] === "sync")?.args;
    expect(syncArgs).toContain("--require-clean");
    expect(
      spawnSync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repo, encoding: "utf-8" },
    ).stdout,
    ).toBe("");
  });

  test("a durable pre-sync exclude change cannot be reported as state none", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    writeFileSync(join(repo, ".gbrain-source"), `${sourceId}\n`);
    chmodSync(join(repo, ".gbrain-source"), 0o644);
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const refusedChild = {
      schema_version: 1,
      result_kind: "gbrain_sync_error",
      status: "refused",
      reason_code: "source_changed",
      state_changed: "none",
      problem: "source changed",
      observed: null,
      required: "stable source",
      next_action: "retry",
    };

    const changed = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: refusedChild,
      syncExit: 1,
    }).run({ clean: false });
    expect(changed).toMatchObject({
      exitCode: 1,
      result: {
        reason_code: "source_changed",
        state_changed: "partial",
      },
    });

    const excludeRelative = spawnSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: repo, encoding: "utf-8" },
    ).stdout.trim();
    const excludePath = join(repo, excludeRelative);
    expect(readFileSync(excludePath, "utf-8")).toContain(".gbrain-source");

    const unchanged = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: refusedChild,
      syncExit: 1,
    }).run({ clean: false });
    expect(unchanged).toMatchObject({
      exitCode: 1,
      result: {
        reason_code: "source_changed",
        state_changed: "none",
      },
    });
  });

  test.skipIf(process.platform === "win32")(
    "a group-writable 0660 source marker is refused before sync",
    () => {
      const repo = makeCommittedRepo();
      const sourceId = "gstack-code-fixture-12345678";
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }).stdout.trim();
      writeFileSync(join(repo, ".gbrain-source"), `${sourceId}\n`);
      chmodSync(join(repo, ".gbrain-source"), 0o660);
      const fixture = runnerFixture({
        repo,
        sourceId,
        sources: {
          sources: [
            {
              id: sourceId,
              local_path: repo,
              last_commit: head,
              last_successful_strategy: "auto",
            },
          ],
        },
        sync: completeChild(sourceId, head, head),
      });

      expect(fixture.run({ clean: false })).toMatchObject({
        exitCode: 1,
        result: {
          status: "refused",
          reason_code: "verification_failed",
          state_changed: "none",
          evidence: {
            failing_step: "pre_sync_source_marker",
            attached_source: {
              present: true,
              trustworthy: false,
              detail: ".gbrain-source is group- or world-writable",
            },
          },
        },
      });
      expect(fixture.calls.some((call) => call.args[0] === "sync")).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a symlinked source marker is refused without following its target",
    () => {
      const repo = makeCommittedRepo();
      const sourceId = "gstack-code-fixture-12345678";
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }).stdout.trim();
      const markerTarget = join(repo, ".gbrain-source-target");
      writeFileSync(markerTarget, `${sourceId}\n`);
      chmodSync(markerTarget, 0o644);
      symlinkSync(markerTarget, join(repo, ".gbrain-source"));
      const fixture = runnerFixture({
        repo,
        sourceId,
        sources: {
          sources: [
            {
              id: sourceId,
              local_path: repo,
              last_commit: head,
              last_successful_strategy: "auto",
            },
          ],
        },
        sync: completeChild(sourceId, head, head),
      });

      expect(fixture.run({ clean: false })).toMatchObject({
        exitCode: 1,
        result: {
          status: "refused",
          reason_code: "verification_failed",
          state_changed: "none",
          evidence: {
            failing_step: "pre_sync_source_marker",
            attached_source: {
              present: true,
              trustworthy: false,
            },
          },
        },
      });
      expect(readFileSync(markerTarget, "utf-8")).toBe(`${sourceId}\n`);
      expect(fixture.calls.some((call) => call.args[0] === "sync")).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "the local git exclude writer refuses a symlink without changing its target",
    () => {
      const repo = makeCommittedRepo();
      const sourceId = "gstack-code-fixture-12345678";
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }).stdout.trim();
      writeFileSync(join(repo, ".gbrain-source"), `${sourceId}\n`);
      chmodSync(join(repo, ".gbrain-source"), 0o644);
      const rawExcludePath = spawnSync(
        "git",
        ["rev-parse", "--git-path", "info/exclude"],
        { cwd: repo, encoding: "utf-8" },
      ).stdout.trim();
      const excludePath = join(repo, rawExcludePath);
      const excludeTarget = join(repo, "exclude-target");
      writeFileSync(excludeTarget, "sentinel\n");
      rmSync(excludePath);
      symlinkSync(excludeTarget, excludePath);
      const fixture = runnerFixture({
        repo,
        sourceId,
        sources: {
          sources: [
            {
              id: sourceId,
              local_path: repo,
              last_commit: head,
              last_successful_strategy: "auto",
            },
          ],
        },
        sync: completeChild(sourceId, head, head),
      });

      expect(fixture.run({ clean: false })).toMatchObject({
        exitCode: 1,
        result: {
          status: "error",
          reason_code: "verification_failed",
          state_changed: "none",
          evidence: {
            failing_step: "source_marker_exclude",
          },
        },
      });
      expect(lstatSync(excludePath).isSymbolicLink()).toBe(true);
      expect(readFileSync(excludeTarget, "utf-8")).toBe("sentinel\n");
      expect(fixture.calls.some((call) => call.args[0] === "sync")).toBe(false);
    },
  );

  test("a tracked source marker can never produce a trusted receipt", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    writeFileSync(join(repo, ".gbrain-source"), `${sourceId}\n`);
    expect(
      spawnSync("git", ["add", ".gbrain-source"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["commit", "--quiet", "-m", "track unsafe marker"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      sync: completeChild(sourceId, head, head),
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "repository_state_invalid",
        state_changed: "none",
      },
    });
    expect(fixture.calls.some((call) => call.args[0] === "sync")).toBe(false);
  });

  test.each(["tracked", "untracked"] as const)(
    "an oversized %s source marker is rejected before sync",
    (kind) => {
      const repo = makeCommittedRepo();
      const sourceId = "gstack-code-fixture-12345678";
      writeFileSync(join(repo, ".gbrain-source"), `${"a".repeat(35)}\n`);
      chmodSync(join(repo, ".gbrain-source"), 0o644);
      if (kind === "tracked") {
        expect(
          spawnSync("git", ["add", ".gbrain-source"], { cwd: repo }).status,
        ).toBe(0);
        expect(
          spawnSync("git", ["commit", "--quiet", "-m", "track oversized marker"], {
            cwd: repo,
          }).status,
        ).toBe(0);
      }
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }).stdout.trim();
      const fixture = runnerFixture({
        repo,
        sourceId,
        sources: {
          sources: [
            {
              id: sourceId,
              local_path: repo,
              last_commit: head,
              last_successful_strategy: "auto",
            },
          ],
        },
        sync: completeChild(sourceId, head, head),
      });

      expect(fixture.run({ clean: kind === "tracked" })).toMatchObject({
        exitCode: 1,
        result: {
          status: "refused",
          reason_code: "verification_failed",
          state_changed: "none",
          evidence: {
            attached_source: {
              trustworthy: false,
              detail: ".gbrain-source exceeds 34 bytes",
            },
          },
        },
      });
      expect(fixture.calls.some((call) => call.args[0] === "sync")).toBe(false);
    },
  );

  test("partial and malformed child results never attach", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const partial = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: {
        schema_version: 1,
        result_kind: "gbrain_sync",
        status: "partial",
      },
    });
    expect(partial.run().result).toMatchObject({
      reason_code: "sync_partial",
      state_changed: "partial",
    });
    expect(partial.calls.some((call) => call.args[1] === "attach")).toBe(false);

    const malformed = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: "{\"schema_version\":1}\ntrailing",
    });
    expect(malformed.run().result).toMatchObject({
      reason_code: "source_result_invalid",
      state_changed: "applied_unverified",
    });
    expect(malformed.calls.some((call) => call.args[1] === "attach")).toBe(
      false,
    );
  });

  test("up_to_date with mutation evidence can never verify", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const child = completeChild(sourceId, head, head, "up_to_date");
    const item = {
      operation: "add",
      path: "src/new.ts",
      slug: "src/new",
    };
    child.operations = { added: 1, modified: 0, deleted: 0, renamed: 0 };
    child.affected = {
      total: 1,
      sample_limit: 100,
      sample: [item],
      truncated: false,
    };
    child.affected_digest = createHash("sha256")
      .update("add\tsrc/new.ts\tsrc/new\n")
      .digest("hex");

    const fixture = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
    });
    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        status: "error",
        reason_code: "source_result_invalid",
        state_changed: "applied_unverified",
      },
    });
    expect(fixture.calls.some((call) => call.args[1] === "attach")).toBe(false);
  });

  test("incomplete, nullable, or contradictory corpus receipts never verify", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const valid = completeChild(sourceId, head, head);
    const validCorpus = {
      ...((valid.corpus as Record<string, unknown>) ?? {}),
    };
    const invalidCorpora: Record<string, unknown>[] = [
      {
        ...validCorpus,
        code_pages_after: null,
      },
      {
        ...validCorpus,
        embedding_status: "unknown",
      },
      {
        ...validCorpus,
        search_ready: true,
      },
      {
        ...validCorpus,
        embedding_status: "complete",
        extraction_status: "complete",
        search_ready: false,
      },
      {
        ...validCorpus,
        unexpected_future_field: 1,
      },
      Object.fromEntries(
        Object.entries(validCorpus).filter(
          ([key]) => key !== "markdown_planned_or_applied",
        ),
      ),
    ];

    for (const corpus of invalidCorpora) {
      const child = { ...valid, corpus };
      const fixture = runnerFixture({
        repo,
        sourceId,
        sources,
        sync: child,
      });
      expect(fixture.run()).toMatchObject({
        exitCode: 1,
        result: {
          status: "error",
          reason_code: "source_result_invalid",
          state_changed: "applied_unverified",
        },
      });
      expect(fixture.calls.some((call) => call.args[1] === "attach")).toBe(
        false,
      );
    }
  });

  test("a complete semantic receipt may claim search readiness", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const child = completeChild(sourceId, head, head);
    child.corpus = {
      ...(child.corpus as Record<string, unknown>),
      embedding_status: "complete",
      extraction_status: "complete",
      search_ready: true,
    };

    expect(
      runnerFixture({ repo, sourceId, sources, sync: child }).run(),
    ).toMatchObject({
      exitCode: 0,
      result: {
        status: "verified",
        state_changed: "applied_verified",
        evidence: {
          corpus: {
            embedding_status: "complete",
            extraction_status: "complete",
            search_ready: true,
          },
        },
      },
    });
  });

  test("complete affected samples bind their digest and operation shape", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const childWithItem = (
      item: Record<string, unknown>,
      digest = createHash("sha256")
        .update(`${item.operation}\t${item.path}\t${item.slug}\n`)
        .digest("hex"),
    ) => {
      const child = completeChild(sourceId, head, head, "synced");
      const operation = item.operation;
      child.operations = {
        added: operation === "add" ? 1 : 0,
        modified: operation === "modify" ? 1 : 0,
        deleted: operation === "delete" ? 1 : 0,
        renamed: operation === "rename" ? 1 : 0,
      };
      child.affected = {
        total: 1,
        sample_limit: 100,
        sample: [item],
        truncated: false,
      };
      child.affected_digest = digest;
      return child;
    };

    const validItem = {
      operation: "add",
      path: "docs/example.md",
      slug: "example",
    };
    expect(
      runnerFixture({
        repo,
        sourceId,
        sources,
        sync: childWithItem(validItem),
      }).run(),
    ).toMatchObject({
      exitCode: 0,
      result: { status: "verified", state_changed: "applied_verified" },
    });

    const invalidChildren = [
      childWithItem(validItem, "0".repeat(64)),
      {
        ...childWithItem({
          operation: "delete",
          path: "docs/example.md",
          slug: "example",
        }),
        operations: { added: 1, modified: 0, deleted: 0, renamed: 0 },
      },
      childWithItem({
        operation: "rename",
        path: "docs/new.md",
        slug: "new",
      }),
      childWithItem({
        operation: "rename",
        path: "docs/new.md",
        slug: "new",
        from_path: 7,
      }),
      childWithItem({
        operation: "add",
        path: "docs/example.md",
        slug: "example",
        from_path: "docs/old.md",
      }),
      childWithItem(
        {
          operation: "add",
          path: "docs\\example.md",
          slug: "example",
        },
        createHash("sha256")
          .update("add\tdocs/example.md\texample\n")
          .digest("hex"),
      ),
      childWithItem({
        operation: "modify",
        path: "docs/\0example.md",
        slug: "example",
      }),
      childWithItem({
        operation: "delete",
        path: "docs/example.md",
        slug: "example\u001b",
      }),
      childWithItem({
        operation: "rename",
        path: "docs/new.md",
        slug: "new",
        from_path: "docs/old\u007f.md",
      }),
    ];

    for (const sync of invalidChildren) {
      const fixture = runnerFixture({ repo, sourceId, sources, sync });
      expect(fixture.run()).toMatchObject({
        exitCode: 1,
        result: {
          reason_code: "source_result_invalid",
          state_changed: "applied_unverified",
        },
      });
      expect(fixture.calls.some((call) => call.args[1] === "attach")).toBe(
        false,
      );
    }
  });

  test("attach and receipt failures remain applied_unverified", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const child = completeChild(sourceId, head, head);

    const attachFailure = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
      writeSourceMarker: () => {
        throw new Error("source marker is not writable");
      },
    }).run();
    expect(attachFailure.result).toMatchObject({
      reason_code: "verification_failed",
      state_changed: "applied_unverified",
      evidence: { failing_step: "source_attach" },
    });

    const receiptFailure = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
      writeReceipt: () => {
        throw new Error("read-only receipt directory");
      },
    }).run();
    expect(receiptFailure.result).toMatchObject({
      reason_code: "verification_failed",
      state_changed: "applied_unverified",
      evidence: { failing_step: "receipt_write" },
    });
  });

  test("a post-sync source with no path fails verification before attach", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      postSources: {
        sources: [{ ...source, local_path: null }],
      },
      sync: completeChild(sourceId, head, head),
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        reason_code: "verification_failed",
        state_changed: "applied_unverified",
        evidence: { failing_step: "post_sync_source_snapshot" },
      },
    });
    expect(fixture.calls.some((call) => call.args[1] === "attach")).toBe(false);
  });

  test("duplicate path ownership appearing after sync blocks attach", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      postSources: {
        sources: [
          source,
          {
            id: "late-duplicate-owner",
            local_path: ".",
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
      sync: completeChild(sourceId, head, head),
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        reason_code: "verification_failed",
        state_changed: "applied_unverified",
        evidence: { failing_step: "post_sync_source_snapshot" },
      },
    });
    expect(fixture.calls.some((call) => call.args[1] === "attach")).toBe(false);
  });

  test("a source rebind after marker attachment blocks the trusted receipt", () => {
    const repo = makeCommittedRepo();
    const other = mkdtempSync(join(tmpdir(), "gstack-final-source-other-"));
    tempDirs.push(other);
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const source = {
      id: sourceId,
      local_path: repo,
      last_commit: head,
      last_successful_strategy: "auto",
    };
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: { sources: [source] },
      postSources: { sources: [source] },
      finalSources: {
        sources: [{ ...source, local_path: other }],
      },
      sync: completeChild(sourceId, head, head),
    });

    expect(fixture.run()).toMatchObject({
      exitCode: 1,
      result: {
        reason_code: "verification_failed",
        state_changed: "applied_unverified",
        evidence: { failing_step: "post_attach_source_snapshot" },
      },
    });
    expect(
      fixture.calls.filter(
        (call) => call.args.join(" ") === "sources list --json",
      ),
    ).toHaveLength(3);
  });

  test("post-attach pin or Git drift prevents a trusted receipt", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const child = completeChild(sourceId, head, head);

    const wrongPin = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
      writeSourceMarker: (root) =>
        writeRepositorySourceMarker(root, "different-source"),
    }).run();
    expect(wrongPin.result).toMatchObject({
      reason_code: "verification_failed",
      state_changed: "applied_unverified",
      evidence: { failing_step: "post_attach_repository_state" },
    });
    writeFileSync(join(repo, ".gbrain-source"), `${sourceId}\n`);
    chmodSync(join(repo, ".gbrain-source"), 0o644);

    const drift = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
      writeSourceMarker: (root, id) => {
        writeRepositorySourceMarker(root, id);
        writeFileSync(join(root, "drift.md"), "changed\n");
      },
    }).run();
    expect(drift.result).toMatchObject({
      reason_code: "verification_failed",
      state_changed: "applied_unverified",
      evidence: { failing_step: "post_attach_repository_state" },
    });
    rmSync(join(repo, "drift.md"));

    const untrustedPin = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
      writeSourceMarker: (root, id) => {
        writeRepositorySourceMarker(root, id);
        chmodSync(join(root, ".gbrain-source"), 0o666);
      },
    }).run();
    expect(untrustedPin.result).toMatchObject({
      reason_code: "verification_failed",
      state_changed: "applied_unverified",
      evidence: { failing_step: "post_attach_repository_state" },
    });
    chmodSync(join(repo, ".gbrain-source"), 0o644);

    const unstableHead = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: child,
      readRepositoryState: () => ({
        head,
        head_after: "b".repeat(40),
        stable: false,
        clean: true,
        porcelain: "",
        source_marker_tracked: false,
      }),
    }).run();
    expect(unstableHead.result).toMatchObject({
      reason_code: "verification_failed",
      state_changed: "applied_unverified",
      evidence: { failing_step: "post_attach_repository_state" },
    });
  });

  test("typed GBrain refusals preserve reason, state, and retry exit", () => {
    const repo = makeCommittedRepo();
    const sourceId = "gstack-code-fixture-12345678";
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).stdout.trim();
    const sources = {
      sources: [
        {
          id: sourceId,
          local_path: repo,
          last_commit: head,
          last_successful_strategy: "auto",
        },
      ],
    };
    const childError = (
      reasonCode: string,
      stateChanged: "none" | "lock_only" | "partial",
      status: "refused" | "error" = "refused",
    ) => ({
      schema_version: 1,
      result_kind: "gbrain_sync_error",
      status,
      reason_code: reasonCode,
      state_changed: stateChanged,
      problem: reasonCode,
      observed: null,
      required: "safe preconditions",
      next_action: "retry",
    });

    for (const reasonCode of [
      "source_changed",
      "target_changed",
      "bookmark_changed",
      "working_tree_dirty",
      "managed_clone_missing",
      "dry_run_modifier_conflict",
      "embedding_credentials_missing",
      "cost_gate_stopped",
    ]) {
      const refused = runnerFixture({
        repo,
        sourceId,
        sources,
        sync: childError(reasonCode, "none"),
        syncExit: 1,
      }).run();
      expect(refused).toMatchObject({
        exitCode: 1,
        result: {
          status: "refused",
          reason_code: reasonCode,
          state_changed: "none",
        },
      });
    }

    const lockBusy = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: childError("lock_busy", "none"),
      syncExit: 1,
    }).run();
    expect(lockBusy).toMatchObject({
      exitCode: 2,
      result: {
        status: "incomplete",
        reason_code: "lock_busy",
        state_changed: "none",
      },
    });

    const releaseFailed = runnerFixture({
      repo,
      sourceId,
      sources,
      sync: childError("lock_release_failed", "lock_only", "error"),
      syncExit: 1,
    }).run();
    expect(releaseFailed).toMatchObject({
      exitCode: 1,
      result: {
        status: "error",
        reason_code: "lock_release_failed",
        state_changed: "lock_only",
      },
    });

    for (const [status, stateChanged] of [
      ["refused", "none"],
      ["error", "none"],
      ["error", "partial"],
    ] as const) {
      const planFailed = runnerFixture({
        repo,
        sourceId,
        sources,
        sync: childError("plan_failed", stateChanged, status),
        syncExit: 1,
      }).run();
      expect(planFailed).toMatchObject({
        exitCode: 1,
        result: {
          status,
          reason_code: "plan_failed",
          state_changed: stateChanged,
        },
      });
    }

    for (const invalid of [
      childError("source_changed", "partial", "error"),
      childError("lock_release_failed", "none", "refused"),
      childError("plan_failed", "partial", "refused"),
    ]) {
      expect(
        runnerFixture({
          repo,
          sourceId,
          sources,
          sync: invalid,
          syncExit: 1,
        }).run(),
      ).toMatchObject({
        exitCode: 1,
        result: {
          status: "error",
          reason_code: "source_result_invalid",
          state_changed: "partial",
        },
      });
    }
  });

  test("different or ambiguous source paths never remove and re-add", () => {
    const repo = makeCommittedRepo();
    const other = mkdtempSync(join(tmpdir(), "gstack-other-source-"));
    tempDirs.push(other);
    const sourceId = "gstack-code-fixture-12345678";
    const fixture = runnerFixture({
      repo,
      sourceId,
      sources: {
        sources: [
          {
            id: sourceId,
            local_path: other,
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
    });
    const output = fixture.run();

    expect(output.result).toMatchObject({
      reason_code: "source_path_different",
      state_changed: "none",
    });
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
    ]);

    const nullPath = runnerFixture({
      repo,
      sourceId,
      sources: {
        sources: [
          {
            id: sourceId,
            local_path: null,
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
    });
    expect(nullPath.run().result).toMatchObject({
      reason_code: "source_path_ambiguous",
      state_changed: "none",
    });
    expect(nullPath.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
    ]);
  });

  test("Windows safety is rechecked after canonicalizing a safe alias", () => {
    const parent = mkdtempSync(join(tmpdir(), "gstack-canonical-shell-"));
    tempDirs.push(parent);
    const target = join(parent, "bad&target");
    const alias = join(parent, "safe-alias");
    mkdirSync(target);
    expect(
      spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: target })
        .status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "gstack@test.invalid"], {
        cwd: target,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "gstack test"], {
        cwd: target,
      }).status,
    ).toBe(0);
    writeFileSync(join(target, "README.md"), "# fixture\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: target }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "--quiet", "-m", "fixture"], {
        cwd: target,
      }).status,
    ).toBe(0);
    symlinkSync(target, alias, "dir");
    const sourceId = "gstack-code-fixture-12345678";
    const fixture = runnerFixture({
      repo: alias,
      sourceId,
      sources: {
        sources: [
          {
            id: sourceId,
            local_path: alias,
            last_commit: null,
            last_successful_strategy: null,
          },
        ],
      },
    });

    expect(fixture.run({ platform: "win32" })).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "unsupported_path",
        state_changed: "none",
      },
    });
    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
    ]);

    const absent = runnerFixture({
      repo: alias,
      sourceId,
      sources: { sources: [] },
    });
    expect(absent.run({ platform: "win32" })).toMatchObject({
      exitCode: 1,
      result: {
        status: "refused",
        reason_code: "unsupported_path",
        state_changed: "none",
      },
    });
    expect(absent.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["sources", "list", "--json"],
    ]);
  });
});
