#!/usr/bin/env bun
/**
 * Skill context budget reporter.
 *
 * Measures eager discovery cost (frontmatter descriptions and catalog lines)
 * separately from execution cost (generated SKILL.md body size and preamble).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { discoverTemplates } from './discover-skills';

const ROOT = path.resolve(import.meta.dir, '..');

export const SKILL_CONTEXT_BUDGETS = {
  descriptionTargetChars: 180,
  descriptionHardChars: 360,
  eagerCatalogTargetChars: 12_000,
  skillTargetBytes: 50_000,
  skillHardBytes: 160_000,
  preambleTargetBytesForTier2Plus: 22_000,
} as const;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.gstack',
]);

export interface FrontmatterInfo {
  name: string;
  description: string;
  preambleTier?: number;
  bodyStart: number;
}

export interface SkillBudgetEntry {
  path: string;
  name: string;
  description: string;
  descriptionChars: number;
  bytes: number;
  lines: number;
  approxTokens: number;
  preambleTier?: number;
  preambleBytes?: number;
  hidden: boolean;
  host?: string;
  generated: boolean;
}

export interface TemplateDescriptionEntry {
  path: string;
  name: string;
  description: string;
  descriptionChars: number;
  changed: boolean;
}

export interface HostBudgetSummary {
  host: string;
  path: string;
  exists: boolean;
  count: number;
  bytes: number;
  approxTokens: number;
}

export interface SkillContextBudgetReport {
  root: string;
  visibleSkills: SkillBudgetEntry[];
  hiddenHostSkills: SkillBudgetEntry[];
  templateDescriptions: TemplateDescriptionEntry[];
  hostSummaries: HostBudgetSummary[];
  parseErrors: Array<{ path: string; message: string }>;
  eagerCatalog: {
    chars: number;
    approxTokens: number;
    lines: string[];
  };
  totals: {
    visibleBytes: number;
    visibleLines: number;
    visibleApproxTokens: number;
    visibleDescriptionChars: number;
    visibleDescriptionApproxTokens: number;
    hiddenHostBytes: number;
    hiddenHostApproxTokens: number;
  };
}

export interface BudgetFinding {
  level: 'warning' | 'error';
  code: string;
  path?: string;
  message: string;
}

export interface BudgetEvaluation {
  warnings: BudgetFinding[];
  errors: BudgetFinding[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function approxTokens(charsOrBytes: number): number {
  return Math.ceil(charsOrBytes / 4);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function frontmatterEnd(content: string): number {
  if (!content.startsWith('---\n')) return -1;
  return content.indexOf('\n---', 4);
}

function extractFrontmatterField(frontmatter: string, field: string): string {
  const lines = frontmatter.split('\n');
  const fieldPattern = new RegExp(`^${field}:\\s*(.*)$`);

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(fieldPattern);
    if (!match) continue;

    const rest = match[1].trim();
    if (rest && rest !== '|' && rest !== '>') {
      return rest.replace(/^['"]|['"]$/g, '');
    }

    const blockLines: string[] = [];
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex++) {
      const line = lines[blockIndex];
      if (line.trim() !== '' && !/^\s/.test(line)) break;
      blockLines.push(line.replace(/^  /, ''));
    }
    return blockLines.join('\n').trim();
  }

  return '';
}

export function parseSkillFrontmatter(content: string, relPath: string): FrontmatterInfo {
  const fmEnd = frontmatterEnd(content);
  if (fmEnd === -1) {
    throw new Error(`${relPath} is missing YAML frontmatter`);
  }

  const frontmatter = content.slice(4, fmEnd);
  const name = extractFrontmatterField(frontmatter, 'name');
  const description = extractFrontmatterField(frontmatter, 'description');
  const tierRaw = extractFrontmatterField(frontmatter, 'preamble-tier');
  const preambleTier = tierRaw ? Number.parseInt(tierRaw, 10) : undefined;

  if (!name) throw new Error(`${relPath} frontmatter is missing name`);
  if (!description) throw new Error(`${relPath} frontmatter is missing description`);

  return {
    name,
    description,
    preambleTier: Number.isFinite(preambleTier) ? preambleTier : undefined,
    bodyStart: fmEnd + '\n---'.length,
  };
}

function estimatePreambleBytes(content: string, bodyStart: number, preambleTier?: number): number | undefined {
  if (!preambleTier || preambleTier < 2) return undefined;

  const body = content.slice(bodyStart);
  let inFence = false;
  let offset = 0;

  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence && line.startsWith('# ')) {
      return byteLength(body.slice(0, offset));
    }
    offset += line.length + 1;
  }

  return undefined;
}

function shouldSkipDir(name: string, includeHidden: boolean): boolean {
  if (SKIP_DIRS.has(name)) return true;
  if (!includeHidden && name.startsWith('.')) return true;
  return false;
}

function walkSkillFiles(root: string, includeHidden: boolean): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, includeHidden)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }

      if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  }

  walk(root);
  return results.sort();
}

function collectChangedTemplates(root: string): Set<string> {
  const changed = new Set<string>();
  const commands: string[][] = [
    ['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD', '--', '*.tmpl'],
    ['ls-files', '--others', '--exclude-standard', '--', '*.tmpl'],
  ];

  for (const args of commands) {
    try {
      const output = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) changed.add(trimmed);
      }
    } catch {
      // Non-git checkouts still get absolute limits and parser checks.
    }
  }

  return changed;
}

function skillEntryFromFile(
  root: string,
  relPath: string,
  hidden: boolean,
  host: string | undefined,
  parseErrors: Array<{ path: string; message: string }>,
): SkillBudgetEntry | null {
  const fullPath = path.join(root, relPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const stats = fs.statSync(fullPath);

  try {
    const frontmatter = parseSkillFrontmatter(content, relPath);
    return {
      path: relPath,
      name: frontmatter.name,
      description: frontmatter.description,
      descriptionChars: frontmatter.description.length,
      bytes: stats.size,
      lines: content.split('\n').length,
      approxTokens: approxTokens(stats.size),
      preambleTier: frontmatter.preambleTier,
      preambleBytes: estimatePreambleBytes(content, frontmatter.bodyStart, frontmatter.preambleTier),
      hidden,
      host,
      generated: content.includes('AUTO-GENERATED from SKILL.md.tmpl'),
    };
  } catch (err) {
    parseErrors.push({ path: relPath, message: (err as Error).message });
    return null;
  }
}

function hostSkillFiles(root: string, hostSubdir: string): string[] {
  const hostRoot = path.join(root, hostSubdir, 'skills');
  if (!fs.existsSync(hostRoot)) return [];

  const rootRealPath = fs.realpathSync(root);
  try {
    if (fs.realpathSync(hostRoot) === rootRealPath) return [];
  } catch {
    return [];
  }

  return walkSkillFiles(hostRoot, true)
    .map(rel => path.join(hostSubdir, 'skills', rel))
    .sort();
}

export function collectSkillContextBudget(root: string = ROOT): SkillContextBudgetReport {
  const parseErrors: Array<{ path: string; message: string }> = [];
  const visibleSkills = walkSkillFiles(root, false)
    .map(rel => skillEntryFromFile(root, rel, false, undefined, parseErrors))
    .filter((entry): entry is SkillBudgetEntry => entry !== null);

  const hiddenHostSkills: SkillBudgetEntry[] = [];
  const hostSummaries: HostBudgetSummary[] = [];

  for (const hostConfig of ALL_HOST_CONFIGS) {
    const relHostDir = path.join(hostConfig.hostSubdir, 'skills');
    const files = hostSkillFiles(root, hostConfig.hostSubdir);
    const entries = files
      .map(rel => skillEntryFromFile(root, rel, true, hostConfig.name, parseErrors))
      .filter((entry): entry is SkillBudgetEntry => entry !== null);

    hiddenHostSkills.push(...entries);
    hostSummaries.push({
      host: hostConfig.name,
      path: relHostDir,
      exists: fs.existsSync(path.join(root, relHostDir)),
      count: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      approxTokens: entries.reduce((sum, entry) => sum + entry.approxTokens, 0),
    });
  }

  const changedTemplates = collectChangedTemplates(root);
  const templateDescriptions = discoverTemplates(root).map(({ tmpl }) => {
    const content = fs.readFileSync(path.join(root, tmpl), 'utf8');
    try {
      const frontmatter = parseSkillFrontmatter(content, tmpl);
      return {
        path: tmpl,
        name: frontmatter.name,
        description: frontmatter.description,
        descriptionChars: frontmatter.description.length,
        changed: changedTemplates.has(tmpl),
      };
    } catch (err) {
      parseErrors.push({ path: tmpl, message: (err as Error).message });
      return {
        path: tmpl,
        name: '',
        description: '',
        descriptionChars: 0,
        changed: changedTemplates.has(tmpl),
      };
    }
  });

  const catalogLines = visibleSkills.map(entry =>
    `${entry.name}: ${collapseWhitespace(entry.description)} (${entry.path})`
  );
  const catalogChars = catalogLines.reduce((sum, line) => sum + line.length + 1, 0);

  return {
    root,
    visibleSkills,
    hiddenHostSkills,
    templateDescriptions,
    hostSummaries,
    parseErrors,
    eagerCatalog: {
      chars: catalogChars,
      approxTokens: approxTokens(catalogChars),
      lines: catalogLines,
    },
    totals: {
      visibleBytes: visibleSkills.reduce((sum, entry) => sum + entry.bytes, 0),
      visibleLines: visibleSkills.reduce((sum, entry) => sum + entry.lines, 0),
      visibleApproxTokens: visibleSkills.reduce((sum, entry) => sum + entry.approxTokens, 0),
      visibleDescriptionChars: visibleSkills.reduce((sum, entry) => sum + entry.descriptionChars, 0),
      visibleDescriptionApproxTokens: approxTokens(
        visibleSkills.reduce((sum, entry) => sum + entry.descriptionChars, 0),
      ),
      hiddenHostBytes: hiddenHostSkills.reduce((sum, entry) => sum + entry.bytes, 0),
      hiddenHostApproxTokens: hiddenHostSkills.reduce((sum, entry) => sum + entry.approxTokens, 0),
    },
  };
}

export function evaluateSkillContextBudget(report: SkillContextBudgetReport): BudgetEvaluation {
  const warnings: BudgetFinding[] = [];
  const errors: BudgetFinding[] = [];
  const allSkillEntries = [...report.visibleSkills, ...report.hiddenHostSkills];

  for (const parseError of report.parseErrors) {
    errors.push({
      level: 'error',
      code: 'frontmatter-parse',
      path: parseError.path,
      message: parseError.message,
    });
  }

  for (const entry of allSkillEntries) {
    if (entry.bytes > SKILL_CONTEXT_BUDGETS.skillHardBytes) {
      errors.push({
        level: 'error',
        code: 'skill-hard-ceiling',
        path: entry.path,
        message: `${entry.path} is ${formatBytes(entry.bytes)}, above ${formatBytes(SKILL_CONTEXT_BUDGETS.skillHardBytes)}`,
      });
    } else if (entry.bytes > SKILL_CONTEXT_BUDGETS.skillTargetBytes) {
      warnings.push({
        level: 'warning',
        code: 'skill-target',
        path: entry.path,
        message: `${entry.path} is ${formatBytes(entry.bytes)}, above target ${formatBytes(SKILL_CONTEXT_BUDGETS.skillTargetBytes)}`,
      });
    }

    if (entry.descriptionChars > SKILL_CONTEXT_BUDGETS.descriptionTargetChars) {
      warnings.push({
        level: 'warning',
        code: 'description-target',
        path: entry.path,
        message: `${entry.path} description is ${entry.descriptionChars} chars, target ${SKILL_CONTEXT_BUDGETS.descriptionTargetChars}`,
      });
    }

    if (
      entry.preambleTier !== undefined &&
      entry.preambleTier >= 2 &&
      entry.preambleBytes !== undefined &&
      entry.preambleBytes > SKILL_CONTEXT_BUDGETS.preambleTargetBytesForTier2Plus
    ) {
      warnings.push({
        level: 'warning',
        code: 'preamble-target',
        path: entry.path,
        message: `${entry.path} tier ${entry.preambleTier} preamble is ${formatBytes(entry.preambleBytes)}, target ${formatBytes(SKILL_CONTEXT_BUDGETS.preambleTargetBytesForTier2Plus)}`,
      });
    }

    if (entry.hidden) {
      warnings.push({
        level: 'warning',
        code: 'hidden-host-skill',
        path: entry.path,
        message: `${entry.path} is a generated host skill under ${entry.host ?? 'unknown host'} output`,
      });
    }
  }

  for (const template of report.templateDescriptions) {
    if (template.changed && template.descriptionChars > SKILL_CONTEXT_BUDGETS.descriptionHardChars) {
      errors.push({
        level: 'error',
        code: 'changed-template-description-hard-limit',
        path: template.path,
        message: `${template.path} changed description is ${template.descriptionChars} chars, above ${SKILL_CONTEXT_BUDGETS.descriptionHardChars}`,
      });
    }
  }

  if (report.eagerCatalog.chars > SKILL_CONTEXT_BUDGETS.eagerCatalogTargetChars) {
    warnings.push({
      level: 'warning',
      code: 'eager-catalog-target',
      message: `eager catalog estimate is ${report.eagerCatalog.chars} chars, target ${SKILL_CONTEXT_BUDGETS.eagerCatalogTargetChars}`,
    });
  }

  return { warnings, errors };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function topBy<T>(items: T[], pick: (item: T) => number, limit: number): T[] {
  return [...items].sort((a, b) => pick(b) - pick(a)).slice(0, limit);
}

export function summarizeSkillContextBudget(report: SkillContextBudgetReport): Record<string, unknown> {
  return {
    visible_skills: report.visibleSkills.length,
    visible_bytes: report.totals.visibleBytes,
    visible_approx_tokens: report.totals.visibleApproxTokens,
    visible_description_chars: report.totals.visibleDescriptionChars,
    visible_description_approx_tokens: report.totals.visibleDescriptionApproxTokens,
    eager_catalog_chars: report.eagerCatalog.chars,
    eager_catalog_approx_tokens: report.eagerCatalog.approxTokens,
    hidden_host_skills: report.hiddenHostSkills.length,
    hidden_host_bytes: report.totals.hiddenHostBytes,
    hidden_host_approx_tokens: report.totals.hiddenHostApproxTokens,
    largest_skills: topBy(report.visibleSkills, entry => entry.bytes, 10).map(entry => ({
      path: entry.path,
      bytes: entry.bytes,
      approx_tokens: entry.approxTokens,
    })),
    largest_descriptions: topBy(report.visibleSkills, entry => entry.descriptionChars, 10).map(entry => ({
      path: entry.path,
      chars: entry.descriptionChars,
    })),
    hosts: report.hostSummaries,
  };
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  return rows
    .map(row => row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
    .join('\n');
}

export function renderSkillContextBudgetReport(
  report: SkillContextBudgetReport,
  evaluation: BudgetEvaluation = evaluateSkillContextBudget(report),
): string {
  const largestSkills = topBy(report.visibleSkills, entry => entry.bytes, 10);
  const largestDescriptions = topBy(report.visibleSkills, entry => entry.descriptionChars, 10);
  const hostRows = report.hostSummaries
    .filter(host => host.exists || host.count > 0)
    .map(host => [host.host, host.path, String(host.count), formatBytes(host.bytes), `~${host.approxTokens}`]);

  const sections = [
    'Skill Context Budget',
    '',
    `Visible skills: ${report.visibleSkills.length}`,
    `Visible bytes: ${formatBytes(report.totals.visibleBytes)} (~${report.totals.visibleApproxTokens} tokens)`,
    `Visible description chars: ${report.totals.visibleDescriptionChars} (~${report.totals.visibleDescriptionApproxTokens} tokens)`,
    `Eager catalog estimate: ${report.eagerCatalog.chars} chars (~${report.eagerCatalog.approxTokens} tokens)`,
    `Hidden host duplicate bytes: ${formatBytes(report.totals.hiddenHostBytes)} (~${report.totals.hiddenHostApproxTokens} tokens)`,
    '',
    'Largest skills:',
    table([
      ['path', 'bytes', 'tokens', 'lines'],
      ...largestSkills.map(entry => [entry.path, formatBytes(entry.bytes), `~${entry.approxTokens}`, String(entry.lines)]),
    ]),
    '',
    'Largest descriptions:',
    table([
      ['path', 'chars'],
      ...largestDescriptions.map(entry => [entry.path, String(entry.descriptionChars)]),
    ]),
  ];

  if (hostRows.length > 0) {
    sections.push('', 'Host generated outputs:', table([
      ['host', 'path', 'skills', 'bytes', 'tokens'],
      ...hostRows,
    ]));
  }

  if (evaluation.errors.length > 0) {
    sections.push('', 'Errors:', ...evaluation.errors.map(error =>
      `- [${error.code}] ${error.path ? `${error.path}: ` : ''}${error.message}`
    ));
  }

  if (evaluation.warnings.length > 0) {
    sections.push('', 'Warnings:', ...evaluation.warnings.map(warning =>
      `- [${warning.code}] ${warning.path ? `${warning.path}: ` : ''}${warning.message}`
    ));
  }

  sections.push('', 'JSON summary:', JSON.stringify(summarizeSkillContextBudget(report), null, 2));
  return sections.join('\n');
}

function printUsageAndExit(): never {
  console.error('Usage: bun run scripts/skill-context-budget.ts [--report|--check]');
  process.exit(2);
}

if (import.meta.main) {
  const mode = process.argv.includes('--check')
    ? 'check'
    : process.argv.includes('--report') || process.argv.length <= 2
      ? 'report'
      : 'unknown';

  if (mode === 'unknown') printUsageAndExit();

  const report = collectSkillContextBudget(ROOT);
  const evaluation = evaluateSkillContextBudget(report);
  console.log(renderSkillContextBudgetReport(report, evaluation));

  if (mode === 'check' && evaluation.errors.length > 0) {
    process.exit(1);
  }
}
