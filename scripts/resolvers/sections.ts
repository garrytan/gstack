/**
 * Section resolvers (v2 plan T9, Claude-first carve).
 *
 * A carved skill keeps its prose-heavy steps in `<skill>/sections/<id>.md`, read
 * on demand. The SAME template ships to every host, so these resolvers make the
 * carve host-aware:
 *
 *  - On CLAUDE and for QA on every host: {{SECTION:id}} emits a STOP-Read pointer to the generated section
 *    file (the skeleton), and the section .md is generated + installed separately.
 *  - Other skills on external hosts: {{SECTION:id}} INLINES the section template's content,
 *    so external hosts keep the full monolith ship skill (no section files, no
 *    host-portable-path problem). Inlined content keeps its own {{RESOLVER}}
 *    tokens, which the generator's multi-pass resolve expands.
 *
 * {{SECTION_INDEX:skill}} renders the situation→section table from the PASSIVE
 * manifest for lazy skills (empty for inlined skills). The manifest
 * is the single source of id/file/title/trigger text (CM2; v2_PLAN.md:663).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Host, ResolverFn, TemplateContext } from './types';

const ROOT = path.resolve(import.meta.dir, '..', '..');

export const QA_ASSET_BLOCKER = 'If missing or unreadable, report a QA setup blocker and its affected probes as blocked; continue other safe probes (independent functional/static checks). Missing/unreadable assets block required QA.';

/** Skills carved on every host: QA (portable assets) and those whose external
 * render would exceed SKILL_BYTE_CEILING inlined (C4, #2777). */
const CARVED_ON_EVERY_HOST = ['qa', 'qa-only', 'ship', 'plan-ceo-review'];

/** Hosts read at most this many UTF-8 bytes of one SKILL.md (~40K tokens). */
export const SKILL_BYTE_CEILING = 160_000;

export function usesLazySections(host: Host, skill: string): boolean {
  return host === 'claude' || CARVED_ON_EVERY_HOST.includes(skill);
}

/**
 * External hosts: a template's literal `~/.claude/skills/gstack/<skill>/sections/<file>`
 * reference arrives here as `$GSTACK_ROOT/...` or `~/<globalRoot>/...`, and external
 * runtime roots have no section trees. For a carved skill, point it at the installed copy;
 * for this skill's own section inlined by {{SECTION}}, point at the inlined text.
 */
export function rewriteCarvedSectionRefs(content: string, ctx: TemplateContext): string {
  if (ctx.host === 'claude') return content;
  // The root arrives as $GSTACK_ROOT or as the host's literal ~/<globalRoot> (path rewrites).
  return content.replace(/`(?:\$GSTACK_ROOT|~\/[\w./-]*?skills\/gstack)\/([a-z0-9-]+)\/sections\/([A-Za-z0-9._-]+)`/g, (match, skill: string, file: string) => {
    if (!fs.existsSync(path.join(ROOT, skill, 'sections', `${file}.tmpl`))) return match;
    if (usesLazySections(ctx.host, skill)) return `\`sections/${file}\` relative to the installed \`gstack-${skill}\` SKILL.md directory`;
    const entry = loadManifest(skill).sections.find(e => e.file === file);
    const inlined = skill === ctx.skillName && entry && fs.readFileSync(path.join(ROOT, skill, 'SKILL.md.tmpl'), 'utf-8').includes(`{{SECTION:${entry.id}}}`);
    return inlined ? `the \`${file.replace(/\.md$/, '')}\` section inlined in this SKILL.md` : match;
  });
}

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
 * Pointer to a carved section file. Claude keeps its global-root path; QA and
 * every external host point relative to the installed skill directory, because
 * external runtime roots (`$GSTACK_ROOT`) carry no `<skill>/sections/` tree
 * while setup links or copies whole skill directories.
 */
export function sectionPath(ctx: TemplateContext, skill: string, id: string): string {
  const entry = findSection(skill, id);
  if (ctx.host !== 'claude' || skill === 'qa' || skill === 'qa-only') {
    fs.accessSync(path.join(ROOT, skill, 'sections', `${entry.file}.tmpl`), fs.constants.R_OK);
    const installedName = ctx.host === 'claude' ? `\`${skill}\`/\`gstack-${skill}\`` : `\`${skill.startsWith('gstack-') ? skill : `gstack-${skill}`}\``;
    return `\`sections/${entry.file}\` relative to the installed ${installedName} SKILL.md directory`;
  }
  return `\`${ctx.paths.skillRoot}/${skill}/sections/${entry.file}\``;
}

/**
 * {{SECTION:id}} — installed-file pointer for QA; otherwise Claude pointers
 * and external inline content retain their existing behavior.
 */
export const SECTION: ResolverFn = (ctx: TemplateContext, args?: string[]): string => {
  const id = args?.[0];
  if (!id) throw new Error('{{SECTION:id}} requires a section id');
  const entry = findSection(ctx.skillName, id);

  if (usesLazySections(ctx.host, ctx.skillName)) {
    if (ctx.skillName === 'qa' || ctx.skillName === 'qa-only') {
      return [
        `> **STOP.** Before ${entry.trigger}, Read ${sectionPath(ctx, ctx.skillName, id)} in full and follow it.`,
        '> Use this host\'s installed path, never the product working directory or another host\'s assets.',
        `> ${QA_ASSET_BLOCKER}`,
      ].join('\n');
    }
    return [
      `> **STOP.** Before ${entry.trigger}, Read ${sectionPath(ctx, ctx.skillName, id)} and execute it`,
      `> in full. Do not work from memory — that section is the source of truth for this step.`,
    ].join('\n');
  }

  // Non-Claude hosts inline the section template content (monolith preserved).
  // Inner {{RESOLVER}} tokens are expanded by the generator's multi-pass resolve.
  const tmplPath = path.join(ROOT, ctx.skillName, 'sections', `${entry.file}.tmpl`);
  return fs.readFileSync(tmplPath, 'utf-8').trimEnd();
};

/**
 * {{SECTION_INDEX:skill}} — situation→section table from the passive manifest.
 * Lazy skills only; an index would be noise for inlined skills.
 */
export const SECTION_INDEX: ResolverFn = (ctx: TemplateContext, args?: string[]): string => {
  const skill = args?.[0] ?? ctx.skillName;
  if (!usesLazySections(ctx.host, skill)) return '';
  const manifest = loadManifest(skill);
  const lines: string[] = [
    '## Section index — Read each section when its situation applies',
    '',
    ...(skill === 'qa' || skill === 'qa-only'
      ? ['Read sections in full when directed; do not work from memory.']
      : ['This skill is a decision-tree skeleton. The steps below point to on-demand',
        'sections. Read a section in full before doing its step; do not work from memory.']),
    '',
    '| When | Read this section |',
    '|------|-------------------|',
  ];
  for (const s of manifest.sections) {
    const reference = skill === 'qa' || skill === 'qa-only' ? sectionPath(ctx, skill, s.id) : `\`sections/${s.file}\``;
    if (skill === 'review' && s.id === 'review-army') {
      lines.push(`| Select surfaces and read QA methods | Inline in [Step 4](#step-4-critical-pass-core-review); setup and probes run in Step 4.7 |`);
    }
    lines.push(`| ${s.trigger} | ${reference} |`);
    if (skill === 'ship' && s.id === 'review-army') {
      lines.push(`| exploratory QA before Fix-First (Step 9.2.1) | Use the QA Read directive in ${reference} |`);
    }
  }
  return lines.join('\n');
};
