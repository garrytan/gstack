/**
 * Credential-free boundary contract for the hidden GBrain `--strategy auto`
 * surface used by /sync-gbrain.
 *
 * Runs only when a supported local GBrain CLI is installed. The sandbox uses
 * PGLite with embeddings and extraction disabled, so the test makes no network
 * calls and never touches the user's configured brain.
 */

import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync, type SpawnSyncReturns } from "child_process";

import { repositorySyncEnv } from "../bin/gstack-gbrain-sync";

const MIN_GBRAIN = [0, 41, 38, 0] as const;
const gbrainPath = spawnSync("which", ["gbrain"], { encoding: "utf-8" }).stdout.trim();
const versionText = gbrainPath
  ? spawnSync(gbrainPath, ["--version"], { encoding: "utf-8" }).stdout.trim()
  : "";
const installedVersion = versionText.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? [];

function versionAtLeast(actual: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const delta = (actual[i] ?? 0) - minimum[i];
    if (delta !== 0) return delta > 0;
  }
  return true;
}

const shouldRun = Boolean(gbrainPath) && versionAtLeast(installedVersion, MIN_GBRAIN);
if (!shouldRun) {
  console.log(
    `[gbrain-sync-auto-pglite-integration] SKIP: requires gbrain >= ${MIN_GBRAIN.join(".")}; ` +
      `found ${versionText || "no CLI"}`,
  );
}

interface Sandbox {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function hermeticGbrainEnv(root: string, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep only process-launch/runtime basics. In particular, do not inherit
  // database overrides or provider credentials from the developer/CI host.
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "PATHEXT",
  ]) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  env.HOME = root;
  env.GBRAIN_HOME = join(root, "gbrain-home");
  env.GBRAIN_INIT_SKIP_EMBED_CHECK = "1";
  env.GBRAIN_SKIP_STARTUP_HOOKS = "1";
  env.NODE_ENV = "test";
  env.NO_COLOR = "1";
  return env;
}

function hermeticGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...hermeticGbrainEnv(root),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "GBrain contract",
    GIT_AUTHOR_EMAIL: "gbrain-contract@example.invalid",
    GIT_COMMITTER_NAME: "GBrain contract",
    GIT_COMMITTER_EMAIL: "gbrain-contract@example.invalid",
  };
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "gbrain-auto-contract-"));
  const repo = join(root, "fixture-repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });

  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n\nDocs contract marker v1.\n");
  writeFileSync(
    join(repo, "src", "feature.ts"),
    "export function docsAwareSentinel(): string { return 'code-v1'; }\n",
  );
  // Valid 1×1 PNG. It is admitted only when GBrain's existing multimodal
  // switch is enabled; --no-embed keeps the test credential-free.
  writeFileSync(
    join(repo, "diagram.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const gitEnv = hermeticGitEnv(root);
  expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv }).status).toBe(0);
  expect(spawnSync("git", ["add", "."], { cwd: repo, env: gitEnv }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-q", "-m", "fixture v1"], { cwd: repo, env: gitEnv }).status).toBe(0);

  const env = hermeticGbrainEnv(root);

  return {
    root,
    repo,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(
  sandbox: Sandbox,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(gbrainPath, args, {
    cwd: sandbox.root,
    env: { ...sandbox.env, ...extraEnv },
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    console.error(`gbrain ${args.join(" ")} failed (${result.status})`);
    console.error(result.stdout || "");
    console.error(result.stderr || "");
  }
  return result;
}

function commit(sandbox: Sandbox, message: string): void {
  const gitEnv = hermeticGitEnv(sandbox.root);
  expect(spawnSync("git", ["add", "."], { cwd: sandbox.repo, env: gitEnv }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-q", "-m", message], { cwd: sandbox.repo, env: gitEnv }).status).toBe(0);
}

function addSource(sandbox: Sandbox, sourceId: string, sourcePath = sandbox.repo): void {
  const result = run(sandbox, ["sources", "add", sourceId, "--path", sourcePath, "--federated"]);
  expect(result.status).toBe(0);
}

function syncSource(
  sandbox: Sandbox,
  sourceId: string,
  strategy: "code" | "auto",
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  const result = run(
    sandbox,
    [
      "sync",
      "--strategy",
      strategy,
      "--source",
      sourceId,
      "--no-pull",
      "--no-embed",
      "--no-extract",
    ],
    extraEnv,
  );
  expect(result.status).toBe(0);
  expect(`${result.stdout || ""}\n${result.stderr || ""}`).toMatch(
    /Already up to date\.|Synced .+:|First sync complete\./,
  );
}

function sourcePageCount(sandbox: Sandbox, sourceId: string): number {
  const result = run(sandbox, ["sources", "list", "--json"]);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout || "null") as {
    sources?: Array<{ id: string; page_count?: number }>;
  } | Array<{ id: string; page_count?: number }>;
  const sources = Array.isArray(parsed) ? parsed : parsed.sources ?? [];
  const source = sources.find((entry) => entry.id === sourceId);
  expect(source).toBeTruthy();
  return source?.page_count ?? -1;
}

describe.skipIf(!shouldRun)("gbrain --strategy auto PGLite contract", () => {
  test(
    "admits docs + code, preserves the other kind on one-kind deltas, and enforces image + same-HEAD boundaries",
    () => {
      const sandbox = makeSandbox();
      try {
        const init = run(sandbox, ["init", "--pglite", "--json", "--no-embedding"]);
        expect(init.status).toBe(0);
        expect(sandbox.env.DATABASE_URL).toBeUndefined();
        expect(sandbox.env.GBRAIN_DATABASE_URL).toBeUndefined();
        expect(sandbox.env.GBRAIN_DIRECT_DATABASE_URL).toBeUndefined();
        expect(sandbox.env.OPENAI_API_KEY).toBeUndefined();
        expect(sandbox.env.GBRAIN_SKIP_STARTUP_HOOKS).toBe("1");
        expect(sandbox.env.NODE_ENV).toBe("test");

        // Multimodal off: the mixed first sync admits one Markdown and one code
        // file, but not the PNG.
        addSource(sandbox, "contract-auto-off");
        syncSource(sandbox, "contract-auto-off", "auto");
        expect(sourcePageCount(sandbox, "contract-auto-off")).toBe(2);

        // Docs-only delta must not remove the existing code page.
        writeFileSync(join(sandbox.repo, "docs", "guide.md"), "# Guide\n\nDocs contract marker v2.\n");
        commit(sandbox, "docs v2");
        syncSource(sandbox, "contract-auto-off", "auto");
        expect(sourcePageCount(sandbox, "contract-auto-off")).toBe(2);

        // Code-only delta must not remove the existing Markdown page.
        writeFileSync(
          join(sandbox.repo, "src", "feature.ts"),
          "export function docsAwareSentinel(): string { return 'code-v2'; }\n",
        );
        commit(sandbox, "code v2");
        syncSource(sandbox, "contract-auto-off", "auto");
        expect(sourcePageCount(sandbox, "contract-auto-off")).toBe(2);

        // A code-only source with a healthy same-HEAD anchor does not backfill
        // historical Markdown merely because the next command selects auto.
        const switchRepo = join(sandbox.root, "strategy-switch-repo");
        cpSync(sandbox.repo, switchRepo, { recursive: true });
        addSource(sandbox, "contract-strategy-switch", switchRepo);
        syncSource(sandbox, "contract-strategy-switch", "code");
        expect(sourcePageCount(sandbox, "contract-strategy-switch")).toBe(1);
        syncSource(sandbox, "contract-strategy-switch", "auto");
        expect(sourcePageCount(sandbox, "contract-strategy-switch")).toBe(1);

        // Even when the user's wider environment enables multimodal imports,
        // the repository path forces the unsafe image gate off. GBrain 0.42.57
        // otherwise writes the image page to `default` instead of this source.
        const multimodalRepo = join(sandbox.root, "multimodal-repo");
        cpSync(sandbox.repo, multimodalRepo, { recursive: true });
        addSource(sandbox, "contract-multimodal-bounded", multimodalRepo);
        const defaultPagesBefore = sourcePageCount(sandbox, "default");
        const boundedEnv = repositorySyncEnv({ GBRAIN_EMBEDDING_MULTIMODAL: "true" });
        expect(boundedEnv.GBRAIN_EMBEDDING_MULTIMODAL).toBe("false");
        syncSource(sandbox, "contract-multimodal-bounded", "auto", boundedEnv);
        const multimodalPageCount = sourcePageCount(sandbox, "contract-multimodal-bounded");
        expect(multimodalPageCount).toBe(2);
        // The known upstream failure leaves the selected source at 2 while
        // leaking the image page into `default`, so selected-source count
        // alone is insufficient evidence for this boundary.
        expect(sourcePageCount(sandbox, "default")).toBe(defaultPagesBefore);
      } finally {
        sandbox.cleanup();
      }
    },
    120_000,
  );
});
