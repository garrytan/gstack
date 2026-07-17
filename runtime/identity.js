import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export function stableId(namespace, value, length = 20) {
  const digest = createHash("sha256")
    .update(`gstack:${namespace}:v2\0`, "utf8")
    .update(String(value), "utf8")
    .digest("hex")
    .slice(0, length);
  return `${namespace}_${digest}`;
}

export async function discoverProjectIdentity(cwd = process.cwd(), options = {}) {
  const absoluteCwd = await canonicalPath(cwd);
  const git = options.git ?? runGit;
  try {
    const [worktreeRootRaw, commonDirRaw, gitDirRaw] = await Promise.all([
      git(["rev-parse", "--show-toplevel"], absoluteCwd),
      git(["rev-parse", "--git-common-dir"], absoluteCwd),
      git(["rev-parse", "--git-dir"], absoluteCwd),
    ]);
    const worktreeRoot = await canonicalPath(resolveGitPath(worktreeRootRaw, absoluteCwd));
    const commonDir = await canonicalPath(resolveGitPath(commonDirRaw, worktreeRoot));
    const gitDir = await canonicalPath(resolveGitPath(gitDirRaw, worktreeRoot));
    return identityFromPaths({ worktreeRoot, commonDir, gitDir, isGit: true });
  } catch (error) {
    if (options.requireGit) throw error;
    if (!isNotGitRepository(error)) throw error;
    return identityFromPaths({
      worktreeRoot: absoluteCwd,
      commonDir: absoluteCwd,
      gitDir: absoluteCwd,
      isGit: false,
    });
  }
}

export function identityFromPaths({ worktreeRoot, commonDir, gitDir, isGit = true }) {
  const resolvedRoot = path.resolve(worktreeRoot);
  const resolvedCommon = path.resolve(commonDir);
  const resolvedGitDir = path.resolve(gitDir);
  const normalizedRoot = normalizeIdentityPath(resolvedRoot);
  const normalizedCommon = normalizeIdentityPath(resolvedCommon);
  const repoId = stableId("repo", normalizedCommon);

  // Linked worktrees have a durable git-dir slot under the common repository.
  // The Git slot is stable when a linked checkout moves and unique within the
  // common repository. Non-Git folders have no slot, so their canonical path
  // remains the identity boundary.
  const gitSlot = path.relative(resolvedCommon, resolvedGitDir) || ".";
  const worktreeId = stableId(
    "worktree",
    isGit ? `${repoId}\0${normalizeIdentityPath(gitSlot)}` : `${repoId}\0${normalizedRoot}`,
  );
  const projectId = stableId("project", `${repoId}\0${worktreeId}`, 24);
  return Object.freeze({
    projectId,
    repoId,
    worktreeId,
    worktreeRoot: resolvedRoot,
    repoCommonDir: resolvedCommon,
    gitDir: resolvedGitDir,
    isGit,
  });
}

function isNotGitRepository(error) {
  if (error?.code === "NOT_GIT") return true;
  const detail = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return (error?.code === 128 || error?.exitCode === 128) && /not a git repository/i.test(detail);
}

async function runGit(args, cwd) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout.replace(/[\r\n]+$/, "");
}

function resolveGitPath(value, cwd) {
  if (!value) throw new Error("git returned an empty path");
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

async function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return absolute;
    throw error;
  }
}

function normalizeIdentityPath(value) {
  let normalized = path.normalize(String(value)).replaceAll(path.sep, "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}
