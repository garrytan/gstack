import fs from "node:fs";
import path from "node:path";
import type { InstallPaths } from "./paths.js";
import { skillCommandList } from "./skills.js";

const BEGIN_MARKER = "<!-- gstack:begin -->";
const END_MARKER = "<!-- gstack:end -->";

export function buildGstackBlock(paths: InstallPaths): string {
  const skills = skillCommandList(paths);
  const skillsLine =
    skills.length > 0
      ? `Available skills: ${skills.join(", ")}.`
      : "Available skills: (run `gstack list` to view)";

  return [
    BEGIN_MARKER,
    "## gstack",
    "",
    "Use the `/browse` skill from gstack for all web browsing, deployment verification,",
    "and QA. Never use `mcp__claude-in-chrome__*` tools — they are slow and unreliable.",
    "",
    skillsLine,
    "",
    "Run `npx @garrytan/gstack upgrade` to update. See https://github.com/garrytan/gstack.",
    END_MARKER,
    "",
  ].join("\n");
}

export interface ClaudeMdResult {
  action: "created" | "updated" | "inserted" | "unchanged";
  targetPath: string;
}

export function upsertClaudeMd(
  targetPath: string,
  block: string,
): ClaudeMdResult {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let existing = "";
  const existed = fs.existsSync(targetPath);
  if (existed) existing = fs.readFileSync(targetPath, "utf-8");

  if (existing.includes(BEGIN_MARKER) && existing.includes(END_MARKER)) {
    const before = existing.slice(0, existing.indexOf(BEGIN_MARKER));
    const afterStart = existing.indexOf(END_MARKER) + END_MARKER.length;
    const after = existing.slice(afterStart).replace(/^\n/, "");
    const next = before + block + (after.length > 0 ? "\n" + after : "");
    if (next === existing) return { action: "unchanged", targetPath };
    fs.writeFileSync(targetPath, next, "utf-8");
    return { action: "updated", targetPath };
  }

  if (!existed) {
    fs.writeFileSync(targetPath, block, "utf-8");
    return { action: "created", targetPath };
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(targetPath, existing + sep + block, "utf-8");
  return { action: "inserted", targetPath };
}

export function removeGstackBlock(targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) return false;
  const existing = fs.readFileSync(targetPath, "utf-8");
  if (!existing.includes(BEGIN_MARKER)) return false;
  const before = existing.slice(0, existing.indexOf(BEGIN_MARKER)).replace(/\n+$/, "");
  const afterStart = existing.indexOf(END_MARKER) + END_MARKER.length;
  const after = existing.slice(afterStart).replace(/^\n+/, "");
  const next = [before, after].filter(Boolean).join("\n\n") + "\n";
  fs.writeFileSync(targetPath, next, "utf-8");
  return true;
}
