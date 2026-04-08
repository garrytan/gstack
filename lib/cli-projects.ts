/**
 * CLI for inspecting gstack project artifacts.
 *
 * Commands:
 *   gstack projects ls     — list all projects with artifact summary
 *   gstack projects show   — detailed view of one project
 *   gstack projects clean  — interactive cleanup of E2E garbage
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectsDir } from './util';

interface ManifestEntry {
  type: string;
  path: string;
  skill: string;
  branch: string;
  ts: string;
}

interface ProjectSummary {
  slug: string;
  totalSize: number;
  lastModified: Date;
  artifactCounts: Record<string, number>;
  manifestEntries: ManifestEntry[];
  isEEGarbage: boolean;
}

const E2E_GARBAGE_PATTERNS = [/^skill-e2e-/, /^test-project/];

/** List all projects in ~/.gstack/projects/ with artifact summaries. */
export function listProjects(): ProjectSummary[] {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const projectDir = path.join(projectsDir, slug);

    const isEEGarbage = E2E_GARBAGE_PATTERNS.some(p => p.test(slug));
    const manifest = readManifest(projectDir);
    const counts = countArtifacts(projectDir);
    const { size, lastMod } = dirStats(projectDir);

    projects.push({
      slug,
      totalSize: size,
      lastModified: lastMod,
      artifactCounts: counts,
      manifestEntries: manifest,
      isEEGarbage,
    });
  }

  // Sort by last modified, most recent first
  projects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return projects;
}

/** Show detailed view of a single project. */
export function showProject(slug: string): ProjectSummary | null {
  const projectDir = getProjectsDir(slug);
  if (!fs.existsSync(projectDir)) return null;

  const manifest = readManifest(projectDir);
  const counts = countArtifacts(projectDir);
  const { size, lastMod } = dirStats(projectDir);
  const isEEGarbage = E2E_GARBAGE_PATTERNS.some(p => p.test(slug));

  return {
    slug,
    totalSize: size,
    lastModified: lastMod,
    artifactCounts: counts,
    manifestEntries: manifest,
    isEEGarbage,
  };
}

/** Format project list for CLI output. */
export function formatProjectList(projects: ProjectSummary[]): string {
  if (projects.length === 0) return 'No projects found in ~/.gstack/projects/';

  const lines: string[] = [];
  for (const p of projects) {
    const totalArtifacts = Object.values(p.artifactCounts).reduce((a, b) => a + b, 0);
    const sizeStr = formatSize(p.totalSize);
    const agoStr = formatTimeAgo(p.lastModified);
    const garbageFlag = p.isEEGarbage ? '  \u26A0\uFE0F  E2E garbage' : '';

    lines.push(
      `${p.slug.padEnd(30)} ${String(totalArtifacts).padStart(3)} artifacts  ${sizeStr.padStart(6)}  (last: ${agoStr})${garbageFlag}`,
    );

    if (!p.isEEGarbage && totalArtifacts > 0) {
      const parts: string[] = [];
      for (const [dir, count] of Object.entries(p.artifactCounts)) {
        if (count > 0) parts.push(`${dir}: ${count}`);
      }
      if (parts.length > 0) {
        lines.push(`  ${parts.join('  ')}`);
      }
    }
  }

  return lines.join('\n');
}

/** Format detailed project view. */
export function formatProjectDetail(project: ProjectSummary): string {
  const lines: string[] = [];
  lines.push(`# ${project.slug}`);
  lines.push(`Size: ${formatSize(project.totalSize)}  Last modified: ${project.lastModified.toISOString().slice(0, 16)}`);
  lines.push('');

  for (const [dir, count] of Object.entries(project.artifactCounts)) {
    lines.push(`${dir}/: ${count} files`);
  }

  if (project.manifestEntries.length > 0) {
    lines.push('');
    lines.push('## Recent artifacts (from manifest)');
    const recent = project.manifestEntries.slice(0, 10);
    for (const e of recent) {
      lines.push(`  ${e.ts.slice(0, 16)}  ${e.type.padEnd(14)}  ${e.path}  (${e.skill})`);
    }
  }

  return lines.join('\n');
}

// --- Helpers ---

function readManifest(projectDir: string): ManifestEntry[] {
  const manifestPath = path.join(projectDir, '.manifest.jsonl');
  if (!fs.existsSync(manifestPath)) return [];

  try {
    const lines = fs.readFileSync(manifestPath, 'utf-8').trim().split('\n');
    return lines
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as ManifestEntry)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  } catch {
    return [];
  }
}

function countArtifacts(projectDir: string): Record<string, number> {
  const subdirs = ['reviews', 'plans', 'reports', 'retros', 'brainstorm'];
  const counts: Record<string, number> = {};

  for (const sub of subdirs) {
    const dir = path.join(projectDir, sub);
    try {
      const files = fs.readdirSync(dir);
      counts[sub] = files.filter(f => !f.startsWith('.')).length;
    } catch {
      counts[sub] = 0;
    }
  }

  return counts;
}

function dirStats(dir: string): { size: number; lastMod: Date } {
  let totalSize = 0;
  let lastMod = new Date(0);

  function walk(d: string) {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          try {
            const stat = fs.statSync(full);
            totalSize += stat.size;
            if (stat.mtime > lastMod) lastMod = stat.mtime;
          } catch { /* skip unreadable files */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(dir);
  return { size: totalSize, lastMod };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- CLI entry point ---

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'ls':
    case 'list':
    case undefined: {
      const projects = listProjects();
      console.log(formatProjectList(projects));
      break;
    }
    case 'show': {
      const slug = args[0];
      if (!slug) {
        console.error('Usage: gstack projects show <slug>');
        process.exit(1);
      }
      const project = showProject(slug);
      if (!project) {
        console.error(`Project not found: ${slug}`);
        process.exit(1);
      }
      console.log(formatProjectDetail(project));
      break;
    }
    case 'clean': {
      const projects = listProjects();
      const garbage = projects.filter(p => p.isEEGarbage);
      if (garbage.length === 0) {
        console.log('No E2E garbage found.');
      } else {
        console.log(`Found ${garbage.length} E2E garbage directories:`);
        for (const p of garbage) {
          console.log(`  ${p.slug}  ${formatSize(p.totalSize)}`);
        }
        console.log('\nRun with --apply to delete them.');
        if (args.includes('--apply')) {
          for (const p of garbage) {
            const dir = getProjectsDir(p.slug);
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`  Deleted: ${p.slug}`);
          }
        }
      }
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: gstack projects [ls|show|clean]');
      process.exit(1);
  }
}
