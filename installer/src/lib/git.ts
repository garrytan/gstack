import fs from "node:fs";
import { runOrThrow, run } from "./exec.js";
import { GSTACK_REPO_URL, GSTACK_REPO_BRANCH, type InstallPaths } from "./paths.js";

export async function cloneGstack(paths: InstallPaths): Promise<void> {
  fs.mkdirSync(paths.claudeSkillsDir, { recursive: true });
  await runOrThrow(
    "git",
    [
      "clone",
      "--single-branch",
      "--depth",
      "1",
      "--branch",
      GSTACK_REPO_BRANCH,
      GSTACK_REPO_URL,
      paths.gstackDir,
    ],
    { stream: true },
  );
}

export async function pullGstack(paths: InstallPaths): Promise<void> {
  await runOrThrow("git", ["-C", paths.gstackDir, "fetch", "--depth", "1", "origin", GSTACK_REPO_BRANCH], {
    stream: true,
  });
  await runOrThrow(
    "git",
    ["-C", paths.gstackDir, "reset", "--hard", `origin/${GSTACK_REPO_BRANCH}`],
    { stream: true },
  );
}

export async function getInstalledCommit(paths: InstallPaths): Promise<string | null> {
  const r = await run("git", ["-C", paths.gstackDir, "rev-parse", "--short", "HEAD"]);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

export async function currentRepoToplevel(cwd: string): Promise<string | null> {
  const r = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}
