import fs from "node:fs";
import path from "node:path";

export interface ClaudeSettings {
  disabledSkills?: string[];
  [key: string]: unknown;
}

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "settings.local.json");
}

export function readSettings(repoRoot: string): ClaudeSettings {
  const p = settingsPath(repoRoot);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

export function writeSettings(repoRoot: string, settings: ClaudeSettings): void {
  const p = settingsPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export function disableSkill(repoRoot: string, skillName: string): boolean {
  const s = readSettings(repoRoot);
  const current = new Set(s.disabledSkills ?? []);
  if (current.has(skillName)) return false;
  current.add(skillName);
  s.disabledSkills = [...current].sort();
  writeSettings(repoRoot, s);
  return true;
}

export function enableSkill(repoRoot: string, skillName: string): boolean {
  const s = readSettings(repoRoot);
  if (!s.disabledSkills || s.disabledSkills.length === 0) return false;
  const before = s.disabledSkills.length;
  s.disabledSkills = s.disabledSkills.filter((n) => n !== skillName);
  if (s.disabledSkills.length === before) return false;
  if (s.disabledSkills.length === 0) delete s.disabledSkills;
  writeSettings(repoRoot, s);
  return true;
}

export function listDisabledSkills(repoRoot: string): string[] {
  return readSettings(repoRoot).disabledSkills ?? [];
}
