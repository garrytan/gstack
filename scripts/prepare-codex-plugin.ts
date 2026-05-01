import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const agentsSkillsRoot = path.join(repoRoot, '.agents', 'skills');
const runtimeRoot = path.join(agentsSkillsRoot, 'gstack');
const pluginSkillsPath = path.join(repoRoot, 'plugins', 'gstack', 'skills');

function run(command: string[], cwd = repoRoot): void {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureRelativeSymlink(targetPath: string, linkPath: string): void {
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
  const existing = fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined;

  if (existing) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) === relativeTarget) {
      return;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const entries = fs.readdirSync(linkPath);
      if (entries.length > 0) {
        throw new Error(`Refusing to replace non-empty directory: ${path.relative(repoRoot, linkPath)}`);
      }
      fs.rmdirSync(linkPath);
    } else {
      fs.rmSync(linkPath, { force: true, recursive: true });
    }
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(relativeTarget, linkPath);
}

function topLevelSkillDirs(): string[] {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => fs.existsSync(path.join(repoRoot, name, 'SKILL.md')))
    .filter((name) => name !== 'plugins');
}

run(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex']);

fs.mkdirSync(runtimeRoot, { recursive: true });

const runtimeEntries = new Set<string>([
  'bin',
  'browse',
  'design',
  'extension',
  'review',
  'qa',
  'make-pdf',
  'ETHOS.md',
  'VERSION',
  ...topLevelSkillDirs(),
]);

for (const entry of runtimeEntries) {
  const source = path.join(repoRoot, entry);
  if (!fs.existsSync(source)) continue;
  const dest = path.join(runtimeRoot, entry);
  if (entry === 'SKILL.md' || entry === 'agents') continue;
  ensureRelativeSymlink(source, dest);
}

ensureRelativeSymlink(agentsSkillsRoot, pluginSkillsPath);
