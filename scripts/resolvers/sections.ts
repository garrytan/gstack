/**
 * Section resolvers (v2 plan T9, Claude-first carve).
 *
 * A carved skill keeps its prose-heavy steps in `<skill>/sections/<id>.md`, read
 * on demand. The SAME template ships to every host, so these resolvers make the
 * carve host-aware:
 *
 *  - on-demand-global: emits Claude's stable global-path Read pointer.
 *  - on-demand-relative: emits a compiled authority command. The adapter owns
 *    selection, installed-manifest verification, observation, and delivery.
 *  - inline: embeds the section body for hosts without delivery plumbing.
 *
 * {{SECTION_INDEX:skill}} renders the situation→section table from the PASSIVE
 * manifest on Claude (empty on other hosts — they have no sections). The manifest
 * is the single source of id/file/title/trigger text (CM2; v2_PLAN.md:663).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHostConfig } from '../../hosts/index';
import type { ResolverFn, TemplateContext } from './types';

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
 * {{SECTION:id}} — pointer on Claude, inline on other hosts.
 * Claude path uses the stable gstack-root install (`{skillRoot}/{skill}/sections/`),
 * which always exists, instead of a naked relative path (Codex outside-voice #7).
 */
export const SECTION: ResolverFn = (ctx: TemplateContext, args?: string[]): string => {
  const id = args?.[0];
  if (!id) throw new Error('{{SECTION:id}} requires a section id');
  const entry = findSection(ctx.skillName, id);

  const delivery = getHostConfig(ctx.host).sectionDelivery;
  if (delivery === 'on-demand-global') {
    const sectionPath = `${ctx.paths.skillRoot}/${ctx.skillName}/sections/${entry.file}`;
    return [
      `> **STOP.** Before ${entry.trigger}, Read \`${sectionPath}\` and execute it`,
      `> in full. Do not work from memory — that section is the source of truth for this step.`,
    ].join('\n');
  }

  if (delivery === 'on-demand-relative') {
    return [
      `> **STOP.** Before ${entry.trigger}, use the verified section returned by the fused`,
      `> \`gstack-execution-plan resolve\` batch. If this is a later conditional stage not present`,
      `> in that decision, invoke exactly one bounded \`gstack-section-delivery resolve --skill ${ctx.skillName} --stage ${entry.id} --json\` batch.`,
      `> Execute only the verified sections returned by that batch through the installed anchor.`,
    ].join('\n');
  }

  // Non-Claude hosts inline the section template content (monolith preserved).
  // Inner {{RESOLVER}} tokens are expanded by the generator's multi-pass resolve.
  const tmplPath = path.join(ROOT, ctx.skillName, 'sections', `${entry.file}.tmpl`);
  return fs.readFileSync(tmplPath, 'utf-8').trimEnd();
};

/**
 * {{SECTION_INDEX:skill}} — situation→section table from the passive manifest.
 * Claude only; other hosts inline everything so an index would be noise.
 */
export const SECTION_INDEX: ResolverFn = (ctx: TemplateContext, args?: string[]): string => {
  if (getHostConfig(ctx.host).sectionDelivery === 'inline') return '';
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
    lines.push(`| ${s.trigger} | \`sections/${s.file}\` |`);
  }
  return lines.join('\n');
};
