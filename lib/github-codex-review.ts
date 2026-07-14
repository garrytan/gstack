import { join } from "path";

export type ReviewMode = "off" | "risk" | "always";
export type ReviewStatus =
  | "SKIPPED"
  | "REQUESTED"
  | "ACKNOWLEDGED"
  | "COMPLETED"
  | "TIMEOUT"
  | "BLOCKED"
  | "ERROR";

export type ReviewCommand = "assess" | "status" | "run";

export interface ReviewOptions {
  command: ReviewCommand;
  mode?: ReviewMode;
  prNumber?: number;
  ackTimeoutSeconds?: number;
  completionTimeoutSeconds?: number;
  pollIntervalSeconds?: number;
  noWait?: boolean;
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[];
  url: string;
}

export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
}

export interface Reaction {
  content: string;
  user?: { login?: string | null } | null;
}

export interface PullRequestReview {
  html_url?: string | null;
  commit_id?: string | null;
  user?: { login?: string | null } | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  url: string | null;
  authorLogin: string | null;
  reviewCommit: string | null;
}

export interface ReviewDependencies {
  now(): number;
  sleep(ms: number): Promise<void>;
  loadConfig(key: string): Promise<string>;
  getPullRequest(prNumber?: number, deadlineMs?: number): Promise<PullRequestContext>;
  listComments(pr: PullRequestContext, deadlineMs?: number): Promise<IssueComment[]>;
  listReactions(pr: PullRequestContext, commentId: number, deadlineMs?: number): Promise<Reaction[]>;
  listReviews(pr: PullRequestContext, deadlineMs?: number): Promise<PullRequestReview[]>;
  listReviewThreads(pr: PullRequestContext, deadlineMs?: number): Promise<ReviewThread[]>;
  createComment(pr: PullRequestContext, body: string, deadlineMs?: number): Promise<IssueComment>;
  progress(message: string): void;
}

export interface ReviewResult {
  schema_version: 1;
  status: ReviewStatus;
  blocking: boolean;
  reason: string;
  message: string;
  mode: ReviewMode | null;
  config_source: "default" | "config" | "argument";
  pr: { number: number; head: string; url: string } | null;
  request: { comment_id: number | null; comment_url: string | null; created: boolean };
  timeout_stage: "ack" | "completion" | null;
  unresolved_threads: Array<{ id: string; url: string | null }>;
  warnings: string[];
  elapsed_ms: number;
  exit_code: 0 | 2 | 64 | 70;
}

export interface RiskAssessment {
  required: boolean;
  reason: string;
}

interface Snapshot {
  requestComment: IssueComment | null;
  acknowledged: boolean;
  completed: boolean;
  reviewUrl: string | null;
  unresolvedThreads: ReviewThread[];
}

export class GithubCodexReviewError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubCodexReviewError";
  }
}

export const DEFAULT_ACK_TIMEOUT_SECONDS = 120;
export const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 600;
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

const BOT_LOGIN = "chatgpt-codex-connector";
const DOC_ONLY_PREFIXES = ["docs/", ".github/ISSUE_TEMPLATE/"];
const SENSITIVE_SEGMENTS = new Set([
  "auth",
  "security",
  "permissions",
  "secrets",
  "migrations",
  "migrate",
  "schema",
  "database",
  "db",
  "deploy",
  "infra",
  "infrastructure",
  "terraform",
  "k8s",
  "kubernetes",
]);

export function isCodexBotLogin(login: string | null | undefined): boolean {
  const normalized = (login || "").toLowerCase().replace(/\[bot\]$/, "");
  return normalized === BOT_LOGIN;
}

export function markerFor(head: string): string {
  return `<!-- gstack-github-codex-review head=${head} -->`;
}

function isDocsOnlyPath(file: string): boolean {
  if (DOC_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix))) return true;
  const basename = file.split("/").pop() || file;
  return basename.startsWith("README") || basename.startsWith("CHANGELOG") || file === "VERSION";
}

function isSensitivePath(file: string): boolean {
  if (file.startsWith(".github/workflows/")) return true;
  return file.split("/").some((segment) => SENSITIVE_SEGMENTS.has(segment.toLowerCase()));
}

export function assessRisk(mode: ReviewMode, pr: PullRequestContext): RiskAssessment {
  if (mode === "off") return { required: false, reason: "mode_off" };
  if (pr.changedFiles === 0 && pr.additions + pr.deletions === 0) {
    return { required: false, reason: "empty_pr" };
  }
  if (mode === "always") return { required: true, reason: "mode_always" };
  if (pr.files.length > 0 && pr.files.every(isDocsOnlyPath)) {
    return { required: false, reason: "docs_only" };
  }
  if (pr.changedFiles >= 10) return { required: true, reason: "changed_files_threshold" };
  if (pr.additions + pr.deletions >= 200) return { required: true, reason: "changed_lines_threshold" };
  if (pr.files.some(isSensitivePath)) return { required: true, reason: "sensitive_path" };
  return { required: false, reason: "low_risk" };
}

function emptyResult(startedAt: number, source: ReviewResult["config_source"]): ReviewResult {
  return {
    schema_version: 1,
    status: "ERROR",
    blocking: false,
    reason: "uninitialized",
    message: "GitHub Codex Review 状态尚未初始化。",
    mode: null,
    config_source: source,
    pr: null,
    request: { comment_id: null, comment_url: null, created: false },
    timeout_stage: null,
    unresolved_threads: [],
    warnings: [],
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    exit_code: 0,
  };
}

function finish(result: ReviewResult, deps: ReviewDependencies, startedAt: number): ReviewResult {
  result.elapsed_ms = Math.max(0, deps.now() - startedAt);
  return result;
}

function positiveNumber(raw: string, key: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new GithubCodexReviewError("invalid_config", `${key} 必须是正数，当前值为 ${JSON.stringify(raw)}。`);
  }
  return value;
}

async function resolveOptions(
  options: ReviewOptions,
  deps: ReviewDependencies,
): Promise<{
  mode: ReviewMode;
  source: ReviewResult["config_source"];
  ackTimeoutSeconds: number;
  completionTimeoutSeconds: number;
  pollIntervalSeconds: number;
}> {
  const source = options.mode ? "argument" : "config";
  const modeRaw = options.mode || (await deps.loadConfig("github_codex_review")) || "off";
  if (modeRaw !== "off" && modeRaw !== "risk" && modeRaw !== "always") {
    throw new GithubCodexReviewError(
      "invalid_config",
      `github_codex_review 值 ${JSON.stringify(modeRaw)} 无效；允许值：off、risk、always。`,
    );
  }
  const ackTimeoutSeconds = options.ackTimeoutSeconds ?? positiveNumber(
    (await deps.loadConfig("github_codex_ack_timeout_seconds")) || String(DEFAULT_ACK_TIMEOUT_SECONDS),
    "github_codex_ack_timeout_seconds",
  );
  const completionTimeoutSeconds = options.completionTimeoutSeconds ?? positiveNumber(
    (await deps.loadConfig("github_codex_completion_timeout_seconds")) || String(DEFAULT_COMPLETION_TIMEOUT_SECONDS),
    "github_codex_completion_timeout_seconds",
  );
  const pollIntervalSeconds = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  for (const [key, value] of [
    ["ack timeout", ackTimeoutSeconds],
    ["completion timeout", completionTimeoutSeconds],
    ["poll interval", pollIntervalSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new GithubCodexReviewError("invalid_argument", `${key} 必须是正数。`);
    }
  }
  return { mode: modeRaw, source, ackTimeoutSeconds, completionTimeoutSeconds, pollIntervalSeconds };
}

async function readSnapshot(
  deps: ReviewDependencies,
  pr: PullRequestContext,
  deadlineMs?: number,
): Promise<Snapshot> {
  const marker = markerFor(pr.head);
  const [comments, reviews] = await Promise.all([
    deps.listComments(pr, deadlineMs),
    deps.listReviews(pr, deadlineMs),
  ]);
  const requestComment = comments.find((comment) => comment.body.includes(marker)) || null;
  const currentReviews = reviews.filter(
    (review) => isCodexBotLogin(review.user?.login) && review.commit_id === pr.head,
  );

  let acknowledged = false;
  let reactionCompleted = false;
  if (requestComment) {
    const reactions = await deps.listReactions(pr, requestComment.id, deadlineMs);
    acknowledged = reactions.some(
      (reaction) => reaction.content === "eyes" && isCodexBotLogin(reaction.user?.login),
    );
    reactionCompleted = reactions.some(
      (reaction) => reaction.content === "+1" && isCodexBotLogin(reaction.user?.login),
    );
  }

  let unresolvedThreads: ReviewThread[] = [];
  if (currentReviews.length > 0) {
    try {
      const threads = await deps.listReviewThreads(pr, deadlineMs);
      unresolvedThreads = threads.filter(
        (thread) =>
          !thread.isResolved &&
          !thread.isOutdated &&
          isCodexBotLogin(thread.authorLogin) &&
          thread.reviewCommit === pr.head,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GithubCodexReviewError(
        "review_threads_unavailable",
        `已找到当前 HEAD 的 Codex Review，但无法确认 review thread 状态：${message}`,
      );
    }
  }

  return {
    requestComment,
    acknowledged,
    completed: reactionCompleted || currentReviews.length > 0,
    reviewUrl: currentReviews[0]?.html_url || null,
    unresolvedThreads,
  };
}

function applySnapshot(result: ReviewResult, snapshot: Snapshot): ReviewResult {
  result.request = {
    comment_id: snapshot.requestComment?.id || null,
    comment_url: snapshot.requestComment?.html_url || null,
    created: result.request.created,
  };
  result.unresolved_threads = snapshot.unresolvedThreads.map((thread) => ({ id: thread.id, url: thread.url }));
  if (snapshot.unresolvedThreads.length > 0) {
    result.status = "BLOCKED";
    result.blocking = true;
    result.reason = "unresolved_current_head_threads";
    result.message = `当前 HEAD 有 ${snapshot.unresolvedThreads.length} 个未解决的 Codex Review thread。`;
    result.exit_code = 2;
  } else if (snapshot.completed) {
    result.status = "COMPLETED";
    result.blocking = false;
    result.reason = "current_head_review_completed";
    result.message = snapshot.reviewUrl
      ? `当前 HEAD 的 Codex Review 已完成：${snapshot.reviewUrl}`
      : "目标机器人已通过 👍 确认当前 HEAD 无建议。";
    result.exit_code = 0;
  } else if (snapshot.acknowledged) {
    result.status = "ACKNOWLEDGED";
    result.reason = "request_acknowledged";
    result.message = "目标机器人已确认收到当前 HEAD 的 Review 请求。";
  } else if (snapshot.requestComment) {
    result.status = "REQUESTED";
    result.reason = "request_pending_ack";
    result.message = "当前 HEAD 已请求 Codex Review，正在等待机器人确认。";
  } else {
    result.status = "SKIPPED";
    result.reason = "not_requested";
    result.message = "当前 HEAD 尚未请求 Codex Review。";
  }
  return result;
}

async function createCommentSafely(
  deps: ReviewDependencies,
  pr: PullRequestContext,
  deadlineMs: number,
): Promise<{ comment: IssueComment; created: boolean }> {
  const marker = markerFor(pr.head);
  const body = `${marker}\n@codex review`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { comment: await deps.createComment(pr, body, deadlineMs), created: true };
    } catch (error) {
      lastError = error;
      const comments = await deps.listComments(pr, deadlineMs);
      const existing = comments.find((comment) => comment.body.includes(marker));
      if (existing) return { comment: existing, created: false };
      if (attempt < 3) {
        const remaining = deadlineMs - deps.now();
        if (remaining <= 0) break;
        await deps.sleep(Math.min(250 * 2 ** (attempt - 1), remaining));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GithubCodexReviewError("comment_create_failed", "无法创建 Codex Review 请求评论。 ");
}

async function sleepUntilNextPoll(
  deps: ReviewDependencies,
  pollIntervalSeconds: number,
  deadlineMs: number,
): Promise<boolean> {
  const remaining = deadlineMs - deps.now();
  if (remaining <= 0) return false;
  await deps.sleep(Math.min(pollIntervalSeconds * 1000, remaining));
  return deps.now() < deadlineMs;
}

function errorResult(
  base: ReviewResult,
  error: unknown,
  deps: ReviewDependencies,
  startedAt: number,
): ReviewResult {
  const known = error instanceof GithubCodexReviewError;
  base.status = "ERROR";
  base.blocking = false;
  base.reason = known ? error.reasonCode : "unexpected_error";
  base.message = known
    ? error.message
    : `GitHub Codex Review 检查失败：${error instanceof Error ? error.message : String(error)}`;
  base.warnings.push(base.message);
  base.exit_code = known && (error.reasonCode === "invalid_argument" || error.reasonCode === "invalid_config") ? 64 : 0;
  return finish(base, deps, startedAt);
}

export async function runGithubCodexReview(
  options: ReviewOptions,
  deps: ReviewDependencies,
): Promise<ReviewResult> {
  const startedAt = deps.now();
  let result = emptyResult(startedAt, options.mode ? "argument" : "config");
  try {
    const resolved = await resolveOptions(options, deps);
    result.mode = resolved.mode;
    result.config_source = resolved.source;
    if (resolved.mode === "off") {
      result.status = "SKIPPED";
      result.reason = "mode_off";
      result.message = "GitHub Codex Review 已关闭；未访问 GitHub，也未创建请求。";
      return finish(result, deps, startedAt);
    }

    const pr = await deps.getPullRequest(options.prNumber);
    result.pr = { number: pr.number, head: pr.head, url: pr.url };
    const assessment = assessRisk(resolved.mode, pr);
    if (!assessment.required) {
      result.status = "SKIPPED";
      result.reason = assessment.reason;
      result.message = assessment.reason === "docs_only"
        ? "该 PR 仅包含文档或版本文件，按 risk 模式跳过云端 Review。"
        : "该 PR 未命中 GitHub Codex Review 风险规则。";
      return finish(result, deps, startedAt);
    }
    if (options.command === "assess") {
      result.status = "REQUESTED";
      result.reason = assessment.reason;
      result.message = "该 PR 命中规则，需要 GitHub Codex Review。";
      return finish(result, deps, startedAt);
    }

    let snapshot = await readSnapshot(deps, pr);
    applySnapshot(result, snapshot);
    if (options.command === "status" || result.status === "BLOCKED" || result.status === "COMPLETED") {
      return finish(result, deps, startedAt);
    }

    if (!snapshot.requestComment) {
      const createDeadline = deps.now() + Math.max(30_000, resolved.pollIntervalSeconds * 1000 * 3);
      deps.progress(`正在为 PR #${pr.number} 的当前 HEAD 请求 GitHub Codex Review...`);
      const created = await createCommentSafely(deps, pr, createDeadline);
      result.request = {
        comment_id: created.comment.id,
        comment_url: created.comment.html_url,
        created: created.created,
      };
      snapshot = { ...snapshot, requestComment: created.comment };
      applySnapshot(result, snapshot);
      result.request.created = created.created;
    }

    if (options.noWait) return finish(result, deps, startedAt);

    if (!snapshot.acknowledged) {
      const ackDeadline = deps.now() + resolved.ackTimeoutSeconds * 1000;
      deps.progress(`已请求 Review；最多等待 ${resolved.ackTimeoutSeconds} 秒取得 ACK...`);
      while (true) {
        snapshot = await readSnapshot(deps, pr, ackDeadline);
        applySnapshot(result, snapshot);
        if (result.status === "BLOCKED" || result.status === "COMPLETED") {
          return finish(result, deps, startedAt);
        }
        if (result.status === "ACKNOWLEDGED") break;
        if (!(await sleepUntilNextPoll(deps, resolved.pollIntervalSeconds, ackDeadline))) {
          result.status = "TIMEOUT";
          result.reason = "ack_timeout";
          result.message = `等待 ${resolved.ackTimeoutSeconds} 秒仍未取得机器人 ACK；继续依赖本地 Review、测试和 CI。`;
          result.timeout_stage = "ack";
          result.warnings.push(result.message);
          return finish(result, deps, startedAt);
        }
      }
    }

    const completionDeadline = deps.now() + resolved.completionTimeoutSeconds * 1000;
    deps.progress(`已取得 ACK；最多再等待 ${resolved.completionTimeoutSeconds} 秒完成 Review...`);
    while (true) {
      snapshot = await readSnapshot(deps, pr, completionDeadline);
      applySnapshot(result, snapshot);
      if (result.status === "BLOCKED" || result.status === "COMPLETED") {
        return finish(result, deps, startedAt);
      }
      if (!(await sleepUntilNextPoll(deps, resolved.pollIntervalSeconds, completionDeadline))) {
        result.status = "TIMEOUT";
        result.reason = "completion_timeout";
        result.message = `取得 ACK 后等待 ${resolved.completionTimeoutSeconds} 秒仍未完成 Review；继续依赖本地 Review、测试和 CI。`;
        result.timeout_stage = "completion";
        result.warnings.push(result.message);
        return finish(result, deps, startedAt);
      }
    }
  } catch (error) {
    return errorResult(result, error, deps, startedAt);
  }
}

interface GhRunResult {
  stdout: string;
  stderr: string;
}

function reasonForGhError(stderr: string): string {
  const lower = stderr.toLowerCase();
  if (lower.includes("authentication") || lower.includes("not logged") || lower.includes("gh auth login")) {
    return "gh_auth_required";
  }
  if (lower.includes("rate limit")) return "github_rate_limited";
  if (lower.includes("could not resolve") || lower.includes("network") || lower.includes("timeout")) {
    return "github_unavailable";
  }
  return "github_api_error";
}

async function executeGh(args: string[], timeoutMs: number): Promise<GhRunResult> {
  const process = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  // Drain both pipes while the child is running. Waiting for exit first can
  // deadlock when a paginated GitHub response fills the OS pipe buffer.
  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
  });
  const outcome = await Promise.race([process.exited.then(() => "exited" as const), timedOut]);
  if (timeout) clearTimeout(timeout);
  if (outcome === "timeout") {
    process.kill(9);
    await process.exited.catch(() => undefined);
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    throw new GithubCodexReviewError("github_unavailable", `gh 调用超过 ${timeoutMs}ms，已终止。`);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (process.exitCode !== 0) {
    const trimmed = stderr.trim() || stdout.trim() || `gh exited ${process.exitCode}`;
    const reason = reasonForGhError(trimmed);
    const fix = reason === "gh_auth_required" ? " 运行：gh auth login。" : " 请检查 GitHub CLI、网络和仓库权限。";
    throw new GithubCodexReviewError(reason, `${trimmed}.${fix}`);
  }
  return { stdout, stderr };
}

async function ghText(
  args: string[],
  deadlineMs?: number,
  attempts = 3,
): Promise<string> {
  const effectiveDeadline = deadlineMs ?? performance.now() + 30_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = effectiveDeadline - performance.now();
    if (remaining <= 0) {
      throw new GithubCodexReviewError("github_unavailable", "GitHub API 调用已达到当前阶段 deadline。 ");
    }
    try {
      return (await executeGh(args, remaining)).stdout;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = Math.min(250 * 2 ** (attempt - 1), Math.max(0, remaining));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function ghJson<T>(args: string[], deadlineMs?: number, attempts = 3): Promise<T> {
  const text = await ghText(args, deadlineMs, attempts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GithubCodexReviewError("github_api_error", `gh 返回了无法解析的 JSON：${text.slice(0, 200)}`);
  }
}

function flattenSlurpedPages<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  if (value.every(Array.isArray)) return value.flat() as T[];
  return value as T[];
}

export function createRealDependencies(): ReviewDependencies {
  const configBin = join(import.meta.dir, "../bin/gstack-config");
  return {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    progress: (message) => console.error(message),
    loadConfig: async (key) => {
      const process = Bun.spawn([configBin, "get", key], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (code !== 0) throw new GithubCodexReviewError("invalid_config", stderr.trim() || `无法读取配置 ${key}`);
      return stdout.trim();
    },
    getPullRequest: async (prNumber, deadlineMs) => {
      const repoView = await ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], deadlineMs);
      const [owner, repo] = repoView.nameWithOwner.split("/");
      if (!owner || !repo) throw new GithubCodexReviewError("pr_not_found", "无法识别当前 GitHub 仓库。 ");
      const prArgs = ["pr", "view"];
      if (prNumber != null) prArgs.push(String(prNumber));
      prArgs.push("--json", "number,headRefOid,additions,deletions,changedFiles,url");
      const info = await ghJson<{
        number: number;
        headRefOid: string;
        additions: number;
        deletions: number;
        changedFiles: number;
        url: string;
      }>(prArgs, deadlineMs);
      const pages = await ghJson<unknown>([
        "api",
        "--paginate",
        "--slurp",
        `repos/${owner}/${repo}/pulls/${info.number}/files?per_page=100`,
      ], deadlineMs);
      const files = flattenSlurpedPages<{ filename?: string }>(pages)
        .map((file) => file.filename || "")
        .filter(Boolean);
      return {
        owner,
        repo,
        number: info.number,
        head: info.headRefOid,
        additions: info.additions,
        deletions: info.deletions,
        changedFiles: info.changedFiles,
        files,
        url: info.url,
      };
    },
    listComments: async (pr, deadlineMs) => {
      const pages = await ghJson<unknown>([
        "api",
        "--paginate",
        "--slurp",
        `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`,
      ], deadlineMs);
      return flattenSlurpedPages<IssueComment>(pages);
    },
    listReactions: async (pr, commentId, deadlineMs) => {
      const pages = await ghJson<unknown>([
        "api",
        "--paginate",
        "--slurp",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${pr.owner}/${pr.repo}/issues/comments/${commentId}/reactions?per_page=100`,
      ], deadlineMs);
      return flattenSlurpedPages<Reaction>(pages);
    },
    listReviews: async (pr, deadlineMs) => {
      const pages = await ghJson<unknown>([
        "api",
        "--paginate",
        "--slurp",
        `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
      ], deadlineMs);
      return flattenSlurpedPages<PullRequestReview>(pages);
    },
    listReviewThreads: async (pr, deadlineMs) => {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){
            reviewThreads(first:100,after:$endCursor){
              nodes{
                id isResolved isOutdated
                comments(first:1){nodes{url author{login} pullRequestReview{commit{oid}}}}
              }
              pageInfo{hasNextPage endCursor}
            }
          }
        }
      }`;
      const pages = await ghJson<Array<{
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  id: string;
                  isResolved: boolean;
                  isOutdated: boolean;
                  comments?: {
                    nodes?: Array<{
                      url?: string | null;
                      author?: { login?: string | null } | null;
                      pullRequestReview?: { commit?: { oid?: string | null } | null } | null;
                    }>;
                  };
                }>;
              };
            };
          };
        };
      }>>([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${pr.owner}`,
        "-F",
        `repo=${pr.repo}`,
        "-F",
        `number=${pr.number}`,
      ], deadlineMs);
      return pages.flatMap((page) => page.data?.repository?.pullRequest?.reviewThreads?.nodes || [])
        .map((thread) => {
          const first = thread.comments?.nodes?.[0];
          return {
            id: thread.id,
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
            url: first?.url || null,
            authorLogin: first?.author?.login || null,
            reviewCommit: first?.pullRequestReview?.commit?.oid || null,
          };
        });
    },
    createComment: async (pr, body, deadlineMs) => ghJson<IssueComment>([
      "api",
      "-X",
      "POST",
      `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
      "-f",
      `body=${body}`,
    ], deadlineMs, 1),
  };
}
