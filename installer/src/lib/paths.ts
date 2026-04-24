import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const GSTACK_REPO_URL = "https://github.com/garrytan/gstack.git";
export const GSTACK_REPO_BRANCH = "main";

export interface InstallPaths {
  home: string;
  claudeDir: string;
  claudeSkillsDir: string;
  gstackDir: string;
  gstackStateDir: string;
  claudeMd: string;
}

export function resolveInstallPaths(): InstallPaths {
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  return {
    home,
    claudeDir,
    claudeSkillsDir: path.join(claudeDir, "skills"),
    gstackDir: path.join(claudeDir, "skills", "gstack"),
    gstackStateDir: path.join(home, ".gstack"),
    claudeMd: path.join(claudeDir, "CLAUDE.md"),
  };
}

export function resolveProjectInstallPaths(projectDir: string): InstallPaths {
  const home = os.homedir();
  const claudeDir = path.join(projectDir, ".claude");
  return {
    home,
    claudeDir,
    claudeSkillsDir: path.join(claudeDir, "skills"),
    gstackDir: path.join(claudeDir, "skills", "gstack"),
    gstackStateDir: path.join(home, ".gstack"),
    claudeMd: path.join(projectDir, "CLAUDE.md"),
  };
}

export function findLocalInstall(startDir: string): InstallPaths | null {
  let cur = path.resolve(startDir);
  while (true) {
    const candidate = path.join(cur, ".claude", "skills", "gstack");
    if (fs.existsSync(candidate)) {
      return resolveProjectInstallPaths(cur);
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export interface ResolvedInstall {
  paths: InstallPaths;
  mode: "global" | "project-local" | "none";
}

export function resolveActiveInstall(cwd: string = process.cwd()): ResolvedInstall {
  const globalPaths = resolveInstallPaths();
  if (isInstalled(globalPaths)) return { paths: globalPaths, mode: "global" };
  const local = findLocalInstall(cwd);
  if (local && isInstalled(local)) return { paths: local, mode: "project-local" };
  return { paths: globalPaths, mode: "none" };
}

export function isInstalled(paths: InstallPaths): boolean {
  try {
    const stat = fs.lstatSync(paths.gstackDir);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function readVersion(paths: InstallPaths): string | null {
  try {
    const versionPath = path.join(paths.gstackDir, "VERSION");
    return fs.readFileSync(versionPath, "utf-8").trim();
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export function findGitRoot(dir: string): string | null {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
