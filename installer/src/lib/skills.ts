import fs from "node:fs";
import path from "node:path";
import type { InstallPaths } from "./paths.js";

export interface Skill {
  dirName: string;
  skillName: string;
  description: string | null;
  path: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "docs",
  "scripts",
  "test",
  "bin",
  "lib",
  "browse",
  "design",
  "make-pdf",
  "extension",
  "hosts",
  "contrib",
  "benchmark-models",
  "model-overlays",
  "openclaw",
  "supabase",
  ".github",
  ".agents",
  ".claude",
  ".factory",
  ".opencode",
  ".codex",
  ".kiro",
  "docs",
  "agents",
]);

function parseFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const fm = content.slice(3, end);
  const result: { name?: string; description?: string } = {};
  const lines = fm.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    let value = m[2].trim();

    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const isFolded = value.startsWith(">");
      const collected: string[] = [];
      let j = i + 1;
      let indent = -1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === "") {
          collected.push("");
          j++;
          continue;
        }
        const leading = next.match(/^(\s+)/);
        const width = leading ? leading[1].length : 0;
        if (width === 0) break;
        if (indent === -1) indent = width;
        if (width < indent) break;
        collected.push(next.slice(indent));
        j++;
      }
      i = j - 1;
      value = isFolded
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}

export function scanSkills(paths: InstallPaths): Skill[] {
  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.gstackDir);
  } catch {
    return [];
  }
  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const dir = path.join(paths.gstackDir, entry);
    const skillPath = path.join(dir, "SKILL.md");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (!fs.existsSync(skillPath)) continue;

    let fm: { name?: string; description?: string } = {};
    try {
      const content = fs.readFileSync(skillPath, "utf-8");
      fm = parseFrontmatter(content);
    } catch {
      // ignore
    }

    skills.push({
      dirName: entry,
      skillName: fm.name ?? entry,
      description: fm.description ?? null,
      path: dir,
    });
  }
  return skills;
}

export function skillCommandList(paths: InstallPaths): string[] {
  return scanSkills(paths).map((s) => `/${s.skillName}`);
}
