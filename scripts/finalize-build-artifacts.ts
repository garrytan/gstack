#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const VERSION_FILES = [
  'browse/dist/.version',
  'design/dist/.version',
  'make-pdf/dist/.version',
] as const;

const EXECUTABLES = [
  'browse/dist/browse',
  'browse/dist/find-browse',
  'design/dist/design',
  'make-pdf/dist/pdf',
  'bin/gstack-global-discover',
] as const;

export function readGitRevision(root = process.cwd()): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0) return '';
  return result.stdout.trim();
}

export function writeVersionFiles(root: string, revision: string): string[] {
  const written: string[] = [];
  for (const relativePath of VERSION_FILES) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, revision ? `${revision}\n` : '');
    written.push(relativePath);
  }
  return written;
}

export function markExecutables(root: string): string[] {
  const marked: string[] = [];
  for (const relativePath of EXECUTABLES) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;

    const mode = fs.statSync(absolutePath).mode;
    fs.chmodSync(absolutePath, mode | 0o755);
    marked.push(relativePath);
  }
  return marked;
}

export function cleanupBunBuildArtifacts(root: string): string[] {
  const removed: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (!/^\..*\.bun-build$/.test(entry)) continue;

    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

export function finalizeBuildArtifacts(root = process.cwd(), revision = readGitRevision(root)) {
  return {
    revision,
    versionFiles: writeVersionFiles(root, revision),
    executables: markExecutables(root),
    removedArtifacts: cleanupBunBuildArtifacts(root),
  };
}

if (import.meta.main) {
  const result = finalizeBuildArtifacts();
  process.stderr.write(
    `Finalized build artifacts: ${result.versionFiles.length} version files, ` +
      `${result.executables.length} executables, ${result.removedArtifacts.length} cleanup artifacts.\n`
  );
}
