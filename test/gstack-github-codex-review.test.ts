import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

import {
  assessRisk,
  GithubCodexReviewError,
  isCodexBotLogin,
  markerFor,
  runGithubCodexReview,
  type IssueComment,
  type PullRequestContext,
  type PullRequestReview,
  type Reaction,
  type ReviewDependencies,
  type ReviewThread,
} from "../lib/github-codex-review";

const ROOT = resolve(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "gstack-github-codex-review");
const CONFIG = join(ROOT, "bin", "gstack-config");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function pr(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    owner: "owner",
    repo: "repo",
    number: 7,
    head: "a".repeat(40),
    additions: 30,
    deletions: 10,
    changedFiles: 2,
    files: ["src/app.ts", "test/app.test.ts"],
    url: "https://github.com/owner/repo/pull/7",
    ...overrides,
  };
}

interface FakeState {
  now: number;
  pullRequest: PullRequestContext;
  comments: IssueComment[];
  reactions: Reaction[];
  reviews: PullRequestReview[];
  threads: ReviewThread[];
  createCalls: number;
  getPrCalls: number;
  createErrors: number;
  threadError?: Error;
  onSleep?: (state: FakeState) => void;
}

function fakeDeps(overrides: Partial<FakeState> = {}): { deps: ReviewDependencies; state: FakeState } {
  const state: FakeState = {
    now: 0,
    pullRequest: pr(),
    comments: [],
    reactions: [],
    reviews: [],
    threads: [],
    createCalls: 0,
    getPrCalls: 0,
    createErrors: 0,
    ...overrides,
  };
  const config: Record<string, string> = {
    github_codex_review: "risk",
    github_codex_ack_timeout_seconds: "1",
    github_codex_completion_timeout_seconds: "1",
  };
  const deps: ReviewDependencies = {
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
      state.onSleep?.(state);
    },
    progress: () => undefined,
    loadConfig: async (key) => config[key] || "",
    getPullRequest: async () => {
      state.getPrCalls++;
      return state.pullRequest;
    },
    listComments: async () => [...state.comments],
    listReactions: async () => [...state.reactions],
    listReviews: async () => [...state.reviews],
    listReviewThreads: async () => {
      if (state.threadError) throw state.threadError;
      return [...state.threads];
    },
    createComment: async (_ctx, body) => {
      state.createCalls++;
      if (state.createErrors > 0) {
        state.createErrors--;
        throw new GithubCodexReviewError("github_unavailable", "connection reset");
      }
      const comment = { id: 99, body, html_url: "https://github.com/owner/repo/pull/7#issuecomment-99" };
      state.comments.push(comment);
      return comment;
    },
  };
  return { deps, state };
}

describe("GitHub Codex Review pure rules", () => {
  test("normalizes the connector bot login only", () => {
    expect(isCodexBotLogin("chatgpt-codex-connector")).toBe(true);
    expect(isCodexBotLogin("chatgpt-codex-connector[bot]")).toBe(true);
    expect(isCodexBotLogin("someone-else[bot]")).toBe(false);
  });

  test("risk mode skips docs-only even when the diff is large", () => {
    const result = assessRisk("risk", pr({
      additions: 1_000,
      changedFiles: 20,
      files: ["docs/guide.md", "README.md", "CHANGELOG.md", "VERSION"],
    }));
    expect(result).toEqual({ required: false, reason: "docs_only" });
  });

  test("risk mode triggers on file count, line count, and sensitive paths", () => {
    expect(assessRisk("risk", pr({ changedFiles: 10 })).reason).toBe("changed_files_threshold");
    expect(assessRisk("risk", pr({ additions: 150, deletions: 50 })).reason).toBe("changed_lines_threshold");
    expect(assessRisk("risk", pr({ files: ["src/security/token.ts"] })).reason).toBe("sensitive_path");
    expect(assessRisk("risk", pr()).required).toBe(false);
  });
});

describe("GitHub Codex Review state machine", () => {
  test("off mode does not access GitHub", async () => {
    const { deps, state } = fakeDeps();
    const result = await runGithubCodexReview({ command: "run", mode: "off" }, deps);
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toBe("mode_off");
    expect(state.getPrCalls).toBe(0);
    expect(state.createCalls).toBe(0);
  });

  test("assess reports a high-risk PR without creating a comment", async () => {
    const { deps, state } = fakeDeps({ pullRequest: pr({ files: ["src/auth/login.ts"] }) });
    const result = await runGithubCodexReview({ command: "assess", mode: "risk" }, deps);
    expect(result.status).toBe("REQUESTED");
    expect(result.reason).toBe("sensitive_path");
    expect(state.createCalls).toBe(0);
  });

  test("sequential reruns reuse the current-head marker", async () => {
    const head = "b".repeat(40);
    const existing = {
      id: 3,
      body: `${markerFor(head)}\n@codex review`,
      html_url: "https://github.com/owner/repo/pull/7#issuecomment-3",
    };
    const { deps, state } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      comments: [existing],
    });
    const result = await runGithubCodexReview({ command: "run", mode: "risk", noWait: true }, deps);
    expect(result.status).toBe("REQUESTED");
    expect(result.request.comment_id).toBe(3);
    expect(state.createCalls).toBe(0);
  });

  test("ignores user reactions and accepts bot ACK", async () => {
    const head = "c".repeat(40);
    const { deps } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      comments: [{ id: 4, body: markerFor(head), html_url: "comment" }],
      reactions: [
        { content: "eyes", user: { login: "human" } },
        { content: "eyes", user: { login: "chatgpt-codex-connector[bot]" } },
      ],
    });
    const result = await runGithubCodexReview({ command: "status", mode: "risk" }, deps);
    expect(result.status).toBe("ACKNOWLEDGED");
  });

  test("completion evidence wins even if ACK was never observed", async () => {
    const head = "d".repeat(40);
    const { deps } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      reviews: [{ user: { login: "chatgpt-codex-connector" }, commit_id: head, html_url: "review" }],
    });
    const result = await runGithubCodexReview({ command: "run", mode: "risk" }, deps);
    expect(result.status).toBe("COMPLETED");
    expect(result.timeout_stage).toBeNull();
  });

  test("old-head reviews are ignored and a new request is created", async () => {
    const head = "e".repeat(40);
    const { deps, state } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      reviews: [{ user: { login: "chatgpt-codex-connector" }, commit_id: "old", html_url: "old" }],
    });
    const result = await runGithubCodexReview({ command: "run", mode: "risk", noWait: true }, deps);
    expect(result.status).toBe("REQUESTED");
    expect(result.request.created).toBe(true);
    expect(state.createCalls).toBe(1);
  });

  test("unresolved current-head connector threads block", async () => {
    const head = "f".repeat(40);
    const { deps } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      reviews: [{ user: { login: "chatgpt-codex-connector" }, commit_id: head, html_url: "review" }],
      threads: [{
        id: "T1",
        isResolved: false,
        isOutdated: false,
        url: "thread",
        authorLogin: "chatgpt-codex-connector[bot]",
        reviewCommit: head,
      }],
    });
    const result = await runGithubCodexReview({ command: "status", mode: "risk" }, deps);
    expect(result.status).toBe("BLOCKED");
    expect(result.exit_code).toBe(2);
    expect(result.unresolved_threads).toEqual([{ id: "T1", url: "thread" }]);
  });

  test("thread lookup failure never masquerades as completed", async () => {
    const head = "1".repeat(40);
    const { deps } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      reviews: [{ user: { login: "chatgpt-codex-connector" }, commit_id: head }],
      threadError: new Error("graphql unavailable"),
    });
    const result = await runGithubCodexReview({ command: "status", mode: "risk" }, deps);
    expect(result.status).toBe("ERROR");
    expect(result.reason).toBe("review_threads_unavailable");
    expect(result.exit_code).toBe(0);
  });

  test("unknown POST result is read back before retrying", async () => {
    const head = "2".repeat(40);
    const { deps, state } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      createErrors: 1,
    });
    const originalList = deps.listComments;
    let reads = 0;
    deps.listComments = async (...args) => {
      reads++;
      if (state.createCalls === 1 && state.comments.length === 0) {
        state.comments.push({ id: 5, body: markerFor(head), html_url: "server-created" });
      }
      return originalList(...args);
    };
    const result = await runGithubCodexReview({ command: "run", mode: "risk", noWait: true }, deps);
    expect(result.request.comment_id).toBe(5);
    expect(result.request.created).toBe(false);
    expect(state.createCalls).toBe(1);
    expect(reads).toBeGreaterThan(0);
  });

  test("ACK timeout is bounded and non-blocking", async () => {
    const { deps, state } = fakeDeps({ pullRequest: pr({ files: ["src/auth/login.ts"] }) });
    const result = await runGithubCodexReview({
      command: "run",
      mode: "risk",
      ackTimeoutSeconds: 1,
      completionTimeoutSeconds: 1,
      pollIntervalSeconds: 1,
    }, deps);
    expect(result.status).toBe("TIMEOUT");
    expect(result.timeout_stage).toBe("ack");
    expect(result.exit_code).toBe(0);
    expect(state.now).toBe(1_000);
  });

  test("completion timeout starts after ACK", async () => {
    const head = "3".repeat(40);
    const { deps, state } = fakeDeps({
      pullRequest: pr({ head, files: ["src/auth/login.ts"] }),
      comments: [{ id: 6, body: markerFor(head), html_url: "comment" }],
      reactions: [{ content: "eyes", user: { login: "chatgpt-codex-connector" } }],
    });
    const result = await runGithubCodexReview({
      command: "run",
      mode: "risk",
      ackTimeoutSeconds: 1,
      completionTimeoutSeconds: 1,
      pollIntervalSeconds: 1,
    }, deps);
    expect(result.status).toBe("TIMEOUT");
    expect(result.timeout_stage).toBe("completion");
    expect(state.now).toBe(1_000);
  });
});

describe("gstack-config contract", () => {
  test("exposes safe defaults", () => {
    const home = tempDir("gstack-codex-config-");
    const env = { ...process.env, GSTACK_HOME: home, HOME: home };
    expect(spawnSync(CONFIG, ["get", "github_codex_review"], { env, encoding: "utf8" }).stdout).toBe("off");
    expect(spawnSync(CONFIG, ["get", "github_codex_ack_timeout_seconds"], { env, encoding: "utf8" }).stdout).toBe("120");
    expect(spawnSync(CONFIG, ["get", "github_codex_completion_timeout_seconds"], { env, encoding: "utf8" }).stdout).toBe("600");
  });

  test("rejects invalid quota-affecting values without overwriting", () => {
    const home = tempDir("gstack-codex-config-");
    const env = { ...process.env, GSTACK_HOME: home, HOME: home };
    expect(spawnSync(CONFIG, ["set", "github_codex_review", "risk"], { env }).status).toBe(0);
    expect(spawnSync(CONFIG, ["set", "github_codex_review", "sometimes"], { env }).status).not.toBe(0);
    expect(spawnSync(CONFIG, ["get", "github_codex_review"], { env, encoding: "utf8" }).stdout).toBe("risk");
    expect(spawnSync(CONFIG, ["set", "github_codex_ack_timeout_seconds", "0"], { env }).status).not.toBe(0);
    expect(spawnSync(CONFIG, ["get", "github_codex_ack_timeout_seconds"], { env, encoding: "utf8" }).stdout).toBe("120");
  });
});

describe("land-and-deploy generation contract", () => {
  test("template and generated Claude skill contain the bounded helper gate", () => {
    for (const file of ["land-and-deploy/SKILL.md.tmpl", "land-and-deploy/SKILL.md"]) {
      const content = readFileSync(join(ROOT, file), "utf8");
      expect(content).toContain("3.5a-ter: GitHub Codex Review (opt-in, bounded)");
      expect(content).toContain('"$GSTACK_BIN/gstack-github-codex-review" run');
      expect(content).not.toContain("~/.claude/skills/gstack/bin/gstack-github-codex-review");
      expect(content).toContain("BLOCKED");
      expect(content).toContain("TIMEOUT");
    }
  });
});

describe("real CLI with mock gh", () => {
  test("finds a current-head marker on a later REST page", () => {
    const home = tempDir("gstack-codex-cli-");
    const fakeBin = tempDir("gstack-codex-gh-");
    const head = "4".repeat(40);
    const script = `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"owner/repo"}' ;;
  "pr view") echo '{"number":7,"headRefOid":"${head}","additions":20,"deletions":10,"changedFiles":1,"url":"https://github.com/owner/repo/pull/7"}' ;;
  "api --paginate")
    case "$*" in
      *pulls/7/files*) echo '[[{"filename":"src/auth/login.ts"}]]' ;;
      *issues/7/comments*) echo '[[ ],[{"id":8,"body":"${markerFor(head)}\\n@codex review","html_url":"comment-8"}]]' ;;
      *issues/comments/8/reactions*) echo '[[]]' ;;
      *pulls/7/reviews*) echo '[[]]' ;;
      *) echo '[[]]' ;;
    esac
    ;;
  *) echo "unexpected gh args: $*" >&2; exit 1 ;;
esac
`;
    const gh = join(fakeBin, "gh");
    writeFileSync(gh, script, { mode: 0o755 });
    const env = {
      ...process.env,
      HOME: home,
      GSTACK_HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    const result = spawnSync(BIN, ["status", "--mode", "risk", "--pr", "7"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("REQUESTED");
    expect(parsed.request.comment_id).toBe(8);
  });

  test("invalid CLI arguments still emit one JSON document", () => {
    const result = spawnSync(BIN, ["status", "--mode", "invalid"], { encoding: "utf8" });
    expect(result.status).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("ERROR");
    expect(parsed.reason).toBe("invalid_argument");
  });

  test("drains a GitHub response larger than the child-process pipe buffer", () => {
    const home = tempDir("gstack-codex-cli-");
    const fakeBin = tempDir("gstack-codex-gh-");
    const head = "5".repeat(40);
    const script = `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"owner/repo"}' ;;
  "pr view") echo '{"number":7,"headRefOid":"${head}","additions":20,"deletions":10,"changedFiles":1,"url":"https://github.com/owner/repo/pull/7"}' ;;
  "api --paginate")
    case "$*" in
      *pulls/7/files*) echo '[[{"filename":"src/auth/login.ts"}]]' ;;
      *issues/7/comments*)
        printf '[['
        for i in $(seq 1 2000); do
          [ "$i" -gt 1 ] && printf ','
          printf '{"id":%s,"body":"%0100d","html_url":"comment-%s"}' "$i" 0 "$i"
        done
        printf ']]\\n'
        ;;
      *pulls/7/reviews*) echo '[[]]' ;;
      *) echo '[[]]' ;;
    esac
    ;;
  *) echo "unexpected gh args: $*" >&2; exit 1 ;;
esac
`;
    const gh = join(fakeBin, "gh");
    writeFileSync(gh, script, { mode: 0o755 });
    const env = {
      ...process.env,
      HOME: home,
      GSTACK_HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    const result = spawnSync(BIN, ["status", "--mode", "risk", "--pr", "7"], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("SKIPPED");
  });

  test("finds an unresolved connector thread on a later GraphQL page", () => {
    const home = tempDir("gstack-codex-cli-");
    const fakeBin = tempDir("gstack-codex-gh-");
    const head = "6".repeat(40);
    const script = `#!/bin/bash
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"owner/repo"}' ;;
  "pr view") echo '{"number":7,"headRefOid":"${head}","additions":20,"deletions":10,"changedFiles":1,"url":"https://github.com/owner/repo/pull/7"}' ;;
  "api --paginate")
    case "$*" in
      *pulls/7/files*) echo '[[{"filename":"src/auth/login.ts"}]]' ;;
      *issues/7/comments*) echo '[[]]' ;;
      *pulls/7/reviews*) echo '[[{"user":{"login":"chatgpt-codex-connector[bot]"},"commit_id":"${head}","html_url":"review"}]]' ;;
      *) echo '[[]]' ;;
    esac
    ;;
  "api graphql")
    echo '[{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}},{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"THREAD_2","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"url":"thread-2","author":{"login":"chatgpt-codex-connector[bot]"},"pullRequestReview":{"commit":{"oid":"${head}"}}}]}}]}}}}}]'
    ;;
  *) echo "unexpected gh args: $*" >&2; exit 1 ;;
esac
`;
    const gh = join(fakeBin, "gh");
    writeFileSync(gh, script, { mode: 0o755 });
    const env = {
      ...process.env,
      HOME: home,
      GSTACK_HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    const result = spawnSync(BIN, ["status", "--mode", "risk", "--pr", "7"], { env, encoding: "utf8" });
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("BLOCKED");
    expect(parsed.unresolved_threads).toEqual([{ id: "THREAD_2", url: "thread-2" }]);
  });
});
