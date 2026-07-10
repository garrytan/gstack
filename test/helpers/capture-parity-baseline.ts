/**
 * Parity baseline capture — cathedral parity-eval suite primitive.
 *
 * Snapshots the current state of every top-level SKILL.md: byte count, line
 * count, estimated token count, frontmatter description length, eval
 * coverage. The output JSON is the v1.44 baseline that v2 must beat on
 * compression AND match (or exceed) on parity.
 *
 * The numbers quoted in the v2.0.0.0 CHANGELOG numbers table are read
 * from a baseline JSON captured by this script. Never invent baseline
 * numbers; ship them only if they came from a real captureBaseline() run.
 *
 * Usage:
 *   bun run scripts/capture-baseline.ts                    # write default path
 *   bun run scripts/capture-baseline.ts --out PATH         # write custom path
 *   bun run scripts/capture-baseline.ts --tag v1.44.1      # tag the snapshot
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SkillBaselineEntry {
  skill: string;
  skillMdBytes: number;
  skillMdLines: number;
  estTokens: number; // ~4 chars/token heuristic
  tmplBytes: number | null; // null when no .tmpl exists (vendored or non-Claude)
  descriptionLen: number; // bytes in frontmatter description field
  hasGateEval: boolean;
  hasPeriodicEval: boolean;
}

export interface ParityBaseline {
  tag: string;
  capturedAt: string;
  capturedFromCommit: string;
  capturedFromBranch: string;
  totalSkills: number;
  totalCorpusBytes: number;
  estTotalCatalogTokens: number; // sum of all description lengths / 4
  topHeaviest: SkillBaselineEntry[]; // sorted desc by skillMdBytes
  skills: Record<string, SkillBaselineEntry>;
}

export interface CaptureOptions {
  repoRoot: string;
  tag?: string;
}

/** Extract the frontmatter description from a SKILL.md file. Empty string if none. */
function extractDescription(content: string): string {
  if (!content.startsWith('---\n')) return '';
  const fmEnd = content.indexOf('\n---', 4);
  if (fmEnd === -1) return '';
  const frontmatter = content.slice(4, fmEnd);
  const lines = frontmatter.split('\n');
  let inDescription = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.match(/^description:\s*\|?\s*$/)) {
      inDescription = true;
      continue;
    }
    if (line.match(/^description:\s+/)) {
      descLines.push(line.replace(/^description:\s+/, ''));
      inDescription = true;
      continue;
    }
    if (inDescription) {
      if (line.match(/^\w+:\s/)) break;
      descLines.push(line.trim());
    }
  }
  return descLines.join('\n').trim();
}

/** Estimate token count via 4 chars/token. Crude but matches existing budget-regression usage. */
function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

/** Find which top-level directories contain a SKILL.md (skills we capture). */
function discoverSkillDirs(repoRoot: string): string[] {
  const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'docs') continue;
    const skillMd = path.join(repoRoot, e.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) dirs.push(e.name);
  }
  return dirs.sort();
}

/** Check whether a skill has E2E gate / periodic eval coverage by scanning test/. */
function discoverEvalCoverage(repoRoot: string, skills: string[]): {
  gate: Set<string>;
  periodic: Set<string>;
} {
  const gate = new Set<string>();
  const periodic = new Set<string>();
  const testDir = path.join(repoRoot, 'test');
  if (!fs.existsSync(testDir)) return { gate, periodic };
  const testFiles = fs.readdirSync(testDir).filter(f => f.startsWith('skill-e2e-') && f.endsWith('.test.ts'));
  // Try to map each test file to a skill by reading its contents for skill names.
  for (const file of testFiles) {
    const content = fs.readFileSync(path.join(testDir, file), 'utf-8');
    for (const skill of skills) {
      // Match the skill name as a word boundary, also try /skill-name slash form.
      const re = new RegExp(`(/${skill}|['"\`]${skill}['"\`]|skill[s]?[/=:]\\s*['"\`]${skill}['"\`])`);
      if (re.test(content)) {
        // Crude tier inference: if file name contains "regression" / known-periodic markers, classify periodic.
        if (file.includes('chain') || file.includes('multi') || file.includes('idempotency') || file.includes('finding-floor')) {
          periodic.add(skill);
        } else {
          gate.add(skill);
        }
      }
    }
  }
  return { gate, periodic };
}

function getGitInfo(repoRoot: string): { commit: string; branch: string } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    return { commit, branch };
  } catch {
    return { commit: 'unknown', branch: 'unknown' };
  }
}

export function captureBaseline(opts: CaptureOptions): ParityBaseline {
  const { repoRoot, tag } = opts;
  const skillDirs = discoverSkillDirs(repoRoot);
  const evalCoverage = discoverEvalCoverage(repoRoot, skillDirs);
  const skills: Record<string, SkillBaselineEntry> = {};
  let totalCorpusBytes = 0;
  let totalDescriptionBytes = 0;
  for (const dir of skillDirs) {
    const skillMdPath = path.join(repoRoot, dir, 'SKILL.md');
    const tmplPath = path.join(repoRoot, dir, 'SKILL.md.tmpl');
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const bytes = Buffer.byteLength(content, 'utf-8');
    const lines = content.split('\n').length;
    const description = extractDescription(content);
    const descriptionLen = Buffer.byteLength(description, 'utf-8');
    const tmplBytes = fs.existsSync(tmplPath)
      ? Buffer.byteLength(fs.readFileSync(tmplPath, 'utf-8'), 'utf-8')
      : null;
    const entry: SkillBaselineEntry = {
      skill: dir,
      skillMdBytes: bytes,
      skillMdLines: lines,
      estTokens: estimateTokens(bytes),
      tmplBytes,
      descriptionLen,
      hasGateEval: evalCoverage.gate.has(dir),
      hasPeriodicEval: evalCoverage.periodic.has(dir),
    };
    skills[dir] = entry;
    totalCorpusBytes += bytes;
    totalDescriptionBytes += descriptionLen;
  }
  const topHeaviest = Object.values(skills)
    .slice()
    .sort((a, b) => b.skillMdBytes - a.skillMdBytes)
    .slice(0, 10);
  const git = getGitInfo(repoRoot);
  return {
    tag: tag ?? 'untagged',
    capturedAt: new Date().toISOString(),
    capturedFromCommit: git.commit,
    capturedFromBranch: git.branch,
    totalSkills: skillDirs.length,
    totalCorpusBytes,
    estTotalCatalogTokens: estimateTokens(totalDescriptionBytes),
    topHeaviest,
    skills,
  };
}

/** Diff two baselines; useful for v2 vs v1.44 deltas. */
export interface BaselineDiff {
  totalCorpusDelta: number;
  totalCorpusDeltaPct: number;
  catalogTokensDelta: number;
  catalogTokensDeltaPct: number;
  perSkill: Array<{
    skill: string;
    beforeBytes: number;
    afterBytes: number;
    deltaBytes: number;
    deltaPct: number;
  }>;
}

export function diffBaselines(before: ParityBaseline, after: ParityBaseline): BaselineDiff {
  const totalCorpusDelta = after.totalCorpusBytes - before.totalCorpusBytes;
  const totalCorpusDeltaPct = before.totalCorpusBytes
    ? (totalCorpusDelta / before.totalCorpusBytes) * 100
    : 0;
  const catalogTokensDelta = after.estTotalCatalogTokens - before.estTotalCatalogTokens;
  const catalogTokensDeltaPct = before.estTotalCatalogTokens
    ? (catalogTokensDelta / before.estTotalCatalogTokens) * 100
    : 0;
  const perSkill: BaselineDiff['perSkill'] = [];
  const allSkills = new Set([...Object.keys(before.skills), ...Object.keys(after.skills)]);
  for (const skill of allSkills) {
    const b = before.skills[skill]?.skillMdBytes ?? 0;
    const a = after.skills[skill]?.skillMdBytes ?? 0;
    perSkill.push({
      skill,
      beforeBytes: b,
      afterBytes: a,
      deltaBytes: a - b,
      deltaPct: b ? ((a - b) / b) * 100 : 0,
    });
  }
  perSkill.sort((x, y) => Math.abs(y.deltaBytes) - Math.abs(x.deltaBytes));
  return {
    totalCorpusDelta,
    totalCorpusDeltaPct,
    catalogTokensDelta,
    catalogTokensDeltaPct,
    perSkill,
  };
}
