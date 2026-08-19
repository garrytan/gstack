import fs from "node:fs";
import path from "node:path";
import type { InstallPaths } from "./paths.js";

const HOST_SKILL_DIRS = [
  ".claude/skills",
  ".codex/skills",
  ".factory/skills",
  ".config/opencode/skills",
  ".kiro/skills",
];

export interface CleanupResult {
  removedSymlinks: string[];
  removedDirs: string[];
  gstackDirRemoved: boolean;
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function linkPointsInto(linkPath: string, targetDir: string): boolean {
  try {
    const dest = fs.readlinkSync(linkPath);
    const absDest = path.isAbsolute(dest) ? dest : path.resolve(path.dirname(linkPath), dest);
    const realDest = realpathSafe(absDest);
    const realTarget = realpathSafe(targetDir);
    return (
      absDest === targetDir ||
      absDest.startsWith(targetDir + path.sep) ||
      realDest === realTarget ||
      realDest.startsWith(realTarget + path.sep)
    );
  } catch {
    return false;
  }
}

function directoryReferencesGstack(dirPath: string, gstackDir: string): boolean {
  const skillMd = path.join(dirPath, "SKILL.md");
  try {
    const stat = fs.lstatSync(skillMd);
    if (!stat.isSymbolicLink()) return false;
    return linkPointsInto(skillMd, gstackDir);
  } catch {
    return false;
  }
}

export function cleanupHostSymlinks(paths: InstallPaths): CleanupResult {
  const result: CleanupResult = {
    removedSymlinks: [],
    removedDirs: [],
    gstackDirRemoved: false,
  };

  for (const rel of HOST_SKILL_DIRS) {
    const dir = path.join(paths.home, rel);
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (linkPointsInto(full, paths.gstackDir)) {
          try {
            fs.unlinkSync(full);
            result.removedSymlinks.push(full);
          } catch {
            // ignore
          }
        }
      } else if (stat.isDirectory()) {
        if (directoryReferencesGstack(full, paths.gstackDir)) {
          try {
            fs.rmSync(full, { recursive: true, force: true });
            result.removedDirs.push(full);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return result;
}

export function removeGstackInstall(paths: InstallPaths): boolean {
  if (!fs.existsSync(paths.gstackDir)) return false;
  fs.rmSync(paths.gstackDir, { recursive: true, force: true });
  return true;
}

export function projectGstackArtifacts(repoRoot: string): string[] {
  const found: string[] = [];
  const gstackRefs = [
    path.join(repoRoot, ".claude", "skills", "gstack"),
    path.join(repoRoot, ".claude", "hooks", "check-gstack.sh"),
    path.join(repoRoot, ".claude", "hooks", "gstack-session-update"),
    path.join(repoRoot, ".gstack"),
  ];
  for (const p of gstackRefs) {
    if (fs.existsSync(p)) found.push(p);
  }
  return found;
}

interface SettingsHook {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

interface SettingsShape {
  hooks?: {
    PreToolUse?: SettingsHook[];
    SessionStart?: SettingsHook[];
    [key: string]: SettingsHook[] | undefined;
  };
  [key: string]: unknown;
}

export function scrubSettingsJson(settingsPath: string): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  let settings: SettingsShape;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return false;
  }
  if (!settings.hooks) return false;

  let changed = false;
  for (const phase of Object.keys(settings.hooks)) {
    const entries = settings.hooks[phase];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => {
      const cmds = entry.hooks ?? [];
      return !cmds.some((h) => {
        const cmd = h.command ?? "";
        return cmd.includes("check-gstack") || cmd.includes("gstack-session-update");
      });
    });
    if (filtered.length !== entries.length) {
      changed = true;
      if (filtered.length === 0) {
        delete settings.hooks[phase];
      } else {
        settings.hooks[phase] = filtered;
      }
    }
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
  return changed;
}
