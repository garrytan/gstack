import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTmpDir(prefix = "gstack-installer-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmTmpDir(dir: string): void {
  if (!dir.startsWith(os.tmpdir())) {
    throw new Error(`refusing to rm non-tmp path: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function write(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

export function writeSkill(
  dir: string,
  skillDir: string,
  frontmatter: Record<string, string>,
  body = "body",
): string {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fm}\n---\n\n${body}\n`;
  return write(dir, path.join(skillDir, "SKILL.md"), content);
}

export function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

export function initGitRepo(dir: string): void {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}
