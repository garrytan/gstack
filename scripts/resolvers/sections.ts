/**
 * Section resolvers (v2 plan T9 carve).
 *
 * A carved skill keeps its prose-heavy steps in `<skill>/sections/<id>.md`, read
 * on demand. The SAME template ships to every host, so these resolvers make the
 * carve host-aware:
 *
 *  - On CLAUDE: SECTION:id emits a STOP-Read pointer to the generated section
 *    file under the nested monorepo install ({skillRoot}/{skill}/sections/).
 *  - On GROK-BUILD: same pointer mode, but paths use the flat Grok package layout
 *    (~/.grok/skills/gstack-{skill}/sections/). Section files are generated into
 *    each package's sections/ dir and ride along with package install.
 *  - On every OTHER host: SECTION placeholders INLINE the section template content,
 *    so those hosts keep the full monolith skill (no section files, no
 *    host-portable-path problem). Inlined content keeps its own resolver tokens,
 *    which the generator's multi-pass resolve expands.
 *
 * SECTION_INDEX renders the situation-to-section table from the PASSIVE
 * manifest on pointer hosts (empty when sections are inlined). The manifest
 * is the single source of id/file/title/trigger text (CM2; v2_PLAN.md:663).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Host, ResolverFn, TemplateContext } from './types';

const ROOT = path.resolve(import.meta.dir, '..', '..');

interface SectionEntry {
  id: string;
  file: string;
  title: string;
  trigger: string;
}
interface SectionManifest {
  skill: string;
  sections: SectionEntry[];
}

/** Hosts that load carved sections on demand (not monolith-inline). */
export function hostUsesSectionPointers(host: Host | string): boolean {
  return host === 'claude' || host === 'grok-build';
}

/**
 * External package dir name for flat hosts (gstack-ship, gstack-upgrade, …).
 * Mirrors gen-skill-docs externalSkillName for skill dirs.
 */
export function externalSkillPackageName(skillName: string): string {
  if (skillName === '.' || skillName === '' || skillName === 'gstack') return 'gstack';
  if (skillName.startsWith('gstack-')) return skillName;
  return `gstack-${skillName}`;
}

function loadManifest(skill: string): SectionManifest {
  const p = path.join(ROOT, skill, 'sections', 'manifest.json');
  const raw = fs.readFileSync(p, 'utf-8');
  return JSON.parse(raw) as SectionManifest;
}

function findSection(skill: string, id: string): SectionEntry {
  const entry = loadManifest(skill).sections.find(s => s.id === id);
  if (!entry) {
    throw new Error(`{{SECTION:${id}}} — no section "${id}" in ${skill}/sections/manifest.json`);
  }
  return entry;
}

/**
 * Absolute-style path the agent should Read for a section file.
 * Claude: nested monorepo install under skillRoot.
 * Grok: flat package next to the thin runtime root.
 */
export function sectionPointerPath(
  host: Host | string,
  skillName: string,
  sectionFile: string,
  skillRoot: string,
): string {
  if (host === 'grok-build') {
    const pkg = externalSkillPackageName(skillName);
    return `~/.grok/skills/${pkg}/sections/${sectionFile}`;
  }
  // Claude (and any future nested-install pointer host)
  return `${skillRoot}/${skillName}/sections/${sectionFile}`;
}

function stopReadDirective(sectionPath: string, trigger: string): string {
  return [
    `> **STOP.** Before ${trigger}, Read \`${sectionPath}\` and execute it`,
    `> in full. Do not work from memory — that section is the source of truth for this step.`,
  ].join('\n');
}

/**
 * SECTION:id — pointer on Claude/Grok, inline on other hosts.
 */
export const SECTION: ResolverFn = (ctx: TemplateContext, args?: string[]): string => {
  const id = args?.[0];
  if (!id) throw new Error('{{SECTION:id}} requires a section id');
  const entry = findSection(ctx.skillName, id);

  if (hostUsesSectionPointers(ctx.host)) {
    const sectionPath = sectionPointerPath(ctx.host, ctx.skillName, entry.file, ctx.paths.skillRoot);
    return stopReadDirective(sectionPath, entry.trigger);
  }

  // Non-pointer hosts inline the section template content (monolith preserved).
  // Inner {{RESOLVER}} tokens are expanded by the generator's multi-pass resolve.
  const tmplPath = path.join(ROOT, ctx.skillName, 'sections', `${entry.file}.tmpl`);
  return fs.readFileSync(tmplPath, 'utf-8').trimEnd();
};

/**
 * SECTION_INDEX — situation-to-section table from the passive manifest.
 * Pointer hosts only; inline hosts have no separate section files.
 */
export const SECTION_INDEX: ResolverFn = (ctx: TemplateContext, args?: string[]): string => {
  if (!hostUsesSectionPointers(ctx.host)) return '';
  const skill = args?.[0] ?? ctx.skillName;
  const manifest = loadManifest(skill);
  const lines: string[] = [
    '## Section index — Read each section when its situation applies',
    '',
    'This skill is a decision-tree skeleton. The steps below point to on-demand',
    'sections. Read a section in full before doing its step; do not work from memory.',
    '',
    '| When | Read this section |',
    '|------|-------------------|',
  ];
  for (const s of manifest.sections) {
    const sectionPath = sectionPointerPath(ctx.host, skill, s.file, ctx.paths.skillRoot);
    // Table shows the resolvable path (Grok: full ~/.grok/...; Claude: short sections/)
    const display =
      ctx.host === 'grok-build' ? `\`${sectionPath}\`` : `\`sections/${s.file}\``;
    lines.push(`| ${s.trigger} | ${display} |`);
  }
  return lines.join('\n');
};
