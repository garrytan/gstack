#!/usr/bin/env bun
/** Validate all host renders and the freshness of repository-owned outputs.
 * Optional installed host caches are never read or changed. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { validateSkill, externalHostPathLeaks } from '../test/helpers/skill-parser';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import {
  runGeneration,
  type GeneratedArtifact,
} from './gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');

export interface CheckDiagnostic {
  kind: 'error' | 'invalid' | 'stale' | 'untracked';
  relativePath?: string;
  message: string;
}

/** Match the strict YAML contract used by hosts, rather than accepting fields
 * that merely look present to the generator's extraction regexes. */
export function validateSkillFrontmatter(content: string): string[] {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return ['frontmatter must have opening and closing delimiters'];
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(block[1]);
  } catch (error) {
    return [`frontmatter must be valid YAML: ${error instanceof Error ? error.message : String(error)}`];
  }
  const fields = parsed as Record<string, unknown> | null;
  return ['name', 'description'].flatMap(field =>
    typeof fields?.[field] === 'string' && (fields[field] as string).trim()
      ? [] : [`frontmatter ${field} must be a nonempty string`]);
}

/** Reuse the command/snapshot validator and host smoke-test content rules. */
export function validateGeneratedArtifact(renderRoot: string, artifact: GeneratedArtifact): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = [];
  const invalid = (message: string) => diagnostics.push({ kind: 'invalid', relativePath: artifact.relativePath, message });
  const file = path.join(renderRoot, artifact.relativePath);
  try {
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.trim()) invalid('generated file is empty');
    if (artifact.kind === 'skill') {
      for (const message of validateSkillFrontmatter(content)) invalid(message);
    }
    if (artifact.kind === 'skill' || artifact.kind === 'section') {
      const validation = validateSkill(file);
      for (const command of validation.invalid) invalid(`line ${command.line}: unknown command '${command.command}'`);
      for (const error of validation.snapshotFlagErrors) invalid(`line ${error.command.line}: ${error.error}`);
      if (artifact.host && artifact.host !== 'claude') {
        // Host smoke tests permit legitimate fallback paths in bash examples.
        if (externalHostPathLeaks(content).length) invalid('contains .claude/skills reference outside a bash block');
      }
    }
    if (artifact.kind === 'metadata') {
      for (const field of ['display_name:', 'short_description:', 'default_prompt:', 'allow_implicit_invocation: true']) {
        if (!content.includes(field)) invalid(`metadata is missing ${field}`);
      }
    }
  } catch (error) {
    diagnostics.push({ kind: 'error', relativePath: artifact.relativePath, message: (error as Error).message });
  }
  return diagnostics;
}

function git(root: string, args: string[], input?: string, accepted = [0]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf-8', input, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status === null || !accepted.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

/** Git refuses to check paths beneath an installed symlink. Evaluate the
 * expected generated tree in an empty worktree view, retaining the repository's
 * Git excludes and applicable source .gitignore rules. Never follow cache links
 * while finding those rules, and never change the render or source checkout. */
function ignoredGeneratedPaths(repoRoot: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const view = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ignore-check-'));
  try {
    const gitDir = git(repoRoot, ['rev-parse', '--absolute-git-dir']).trim();
    const excludesFile = git(repoRoot, ['config', '--path', '--get', 'core.excludesFile'], undefined, [0, 1]).trim();
    const directories = new Map<string, boolean>([['', true]]);
    for (const file of paths) {
      let dir = '';
      for (const segment of file.split('/').slice(0, -1)) {
        dir = dir ? `${dir}/${segment}` : segment;
        if (!directories.has(dir)) {
          try {
            directories.set(dir, fs.lstatSync(path.join(repoRoot, dir)).isDirectory());
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            directories.set(dir, false);
          }
        }
        if (!directories.get(dir)) break;
      }
    }
    for (const [dir, reachable] of directories) {
      if (!reachable) continue;
      const source = path.join(repoRoot, dir, '.gitignore');
      try {
        // Git also ignores symlinked .gitignore files.
        if (!fs.lstatSync(source).isFile()) continue;
        const destination = path.join(view, dir, '.gitignore');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return new Set(git(view, ['--git-dir', gitDir, '--work-tree', view,
      ...(excludesFile ? ['-c', `core.excludesFile=${path.resolve(repoRoot, excludesFile)}`] : []),
      'check-ignore', '--no-index', '-z', '--stdin'], `${paths.join('\0')}\0`, [0, 1]).split('\0').filter(Boolean));
  } finally {
    fs.rmSync(view, { recursive: true, force: true });
  }
}

/** Compare only generated targets: unrelated dirty files cannot fail this check.
 * An expected nonignored output must also be tracked, catching new skills whose
 * generated file was never committed. Tracked files win over ignore rules. */
export function checkGeneratedFreshness(repoRoot: string, renderRoot: string, artifacts: GeneratedArtifact[]): { checked: number; diagnostics: CheckDiagnostic[] } {
  const diagnostics: CheckDiagnostic[] = [];
  let checked = 0;
  try {
    const tracked = new Set(git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean));
    const untracked = artifacts.map(a => a.relativePath).filter(file => !tracked.has(file));
    const ignored = ignoredGeneratedPaths(repoRoot, untracked);
    for (const artifact of artifacts) {
      const { relativePath } = artifact;
      if (!tracked.has(relativePath)) {
        if (!ignored.has(relativePath)) {
          diagnostics.push({ kind: 'untracked', relativePath, message: 'generated output is not tracked; regenerate and add it to git' });
        }
        continue;
      }
      checked++;
      try {
        const generated = fs.readFileSync(path.join(renderRoot, relativePath));
        const existing = fs.readFileSync(path.join(repoRoot, relativePath));
        if (!generated.equals(existing)) diagnostics.push({ kind: 'stale', relativePath, message: 'generated output differs from the tracked file' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          diagnostics.push({ kind: 'stale', relativePath, message: 'generated or tracked output is missing' });
        } else {
          diagnostics.push({ kind: 'error', relativePath, message: (error as Error).message });
        }
      }
    }
  } catch (error) {
    diagnostics.push({ kind: 'error', message: (error as Error).message });
  }
  return { checked, diagnostics };
}

export async function main(): Promise<number> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-check-'));
  try {
    console.log('Generating all hosts into scratch with canonical settings...');
    const result = await runGeneration({ host: 'all', outputRoot: scratch, contentLinkRoot: null });
    for (const diagnostic of result.diagnostics) {
      console.log(`${diagnostic.kind.toUpperCase()}: ${diagnostic.host ? `${diagnostic.host}: ` : ''}${diagnostic.message}`);
    }
    if (result.exitCode !== 0) {
      console.error('Generation failed; freshness and content checks require a complete render.');
      return 1;
    }

    const diagnostics = result.artifacts.flatMap(artifact => validateGeneratedArtifact(scratch, artifact));
    for (const host of ALL_HOST_CONFIGS) {
      const skills = result.artifacts.filter(a => a.host === host.name && a.kind === 'skill').length;
      console.log(`  ${host.displayName}: ${skills} generated skills checked`);
    }
    const freshness = checkGeneratedFreshness(ROOT, scratch, result.artifacts);
    diagnostics.push(...freshness.diagnostics);
    for (const diagnostic of diagnostics) {
      console.error(`${diagnostic.kind.toUpperCase()}: ${diagnostic.relativePath ? `${diagnostic.relativePath}: ` : ''}${diagnostic.message}`);
    }
    console.log(`\nChecked ${result.artifacts.length} generated artifacts; ${freshness.checked} tracked outputs compared.`);
    if (diagnostics.some(d => d.kind === 'stale' || d.kind === 'untracked')) {
      console.error('Run: bun run gen:skill-docs --host all, then commit the generated outputs.');
    }
    return diagnostics.length ? 1 : 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  void main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
