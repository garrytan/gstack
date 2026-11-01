/**
 * Shared-preamble hoist (#3199, GSTA-96).
 *
 * Tier 2+ skills used to inline the whole preamble (~27K chars) in every
 * SKILL.md, so each invocation paid for it again. Its skill-independent
 * sections now render once per host into `sections/preamble.md` beside each
 * tier 2+ SKILL.md. The SKILL.md keeps a pointer to that file and every
 * preamble section whose text is this skill's own: the start command, any
 * section that names the skill or has a skill-specific variant, and tier 3's
 * additions. The pointer asks for a Read unless this skill's own earlier Read
 * of that file, headed by its id, is still in context, so a session loads it
 * once and text that merely carries the id never stands in for it.
 *
 * A section is hoisted only when this skill's render of it is byte-identical
 * to the shared render, so no skill's instructions change; they move.
 * Tier 1 skills keep their short preamble inline.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { TemplateContext } from './types';
import { preambleSections } from './preamble';
import { generateUnattendedPreamble, isUnattended } from './unattended';

/** A skill name no generator special-cases; a section that mentions it names the skill. */
const SHARED_SKILL = 'gstack-shared-preamble';
const SHARED_TIER = 2;
export const SHARED_PREAMBLE_FILE = 'preamble.md';

export function hoistsPreamble(ctx: TemplateContext): boolean {
  return (ctx.preambleTier ?? 0) >= SHARED_TIER;
}

/** Split rendered markdown at headings of one level (`## ` or `### `) outside code fences. */
function splitSections(text: string, marker = '## '): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const [, delimiter, info] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !info.trim()) fence = null;
    } else if (!fence && line.startsWith(marker) && current.some(l => l.trim())) {
      sections.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some(l => l.trim())) sections.push(current.join('\n').trim());
  return sections;
}

function sharedSections(ctx: TemplateContext): string[] {
  const canonical = preambleSections({ ...ctx, skillName: SHARED_SKILL, preambleTier: SHARED_TIER, interactive: undefined });
  // A unit without its own heading stays inline: in the shared file it would read as part of the
  // section above it, which a skill may replace.
  return canonical.flatMap(part => splitSections(part)).filter(section => section.startsWith('## ') && !section.includes(SHARED_SKILL));
}

function sharedId(ctx: TemplateContext, shared: string[]): string {
  return createHash('sha256').update(`${ctx.installRoot ?? ''}\n${shared.join('\n\n')}`).digest('hex').slice(0, 12);
}

const headingOf = (section: string) => section.split('\n', 1)[0]!;

/**
 * A skill-specific variant of a shared section, cut down to the `### `
 * subsections that differ plus any it adds after the shared ones, when it
 * keeps the shared heading, intro and subsection headings in order.
 * Otherwise the whole section stays inline.
 */
function variantSubsections(own: string, shared: string): string | null {
  const ownParts = splitSections(own, '### ');
  const sharedParts = splitSections(shared, '### ');
  if (ownParts.length < 2 || ownParts.length < sharedParts.length || ownParts[0] !== sharedParts[0]) return null;
  if (sharedParts.some((part, i) => headingOf(part) !== headingOf(ownParts[i]!))) return null;
  const changed = ownParts.slice(1, sharedParts.length).filter((part, i) => part !== sharedParts[i + 1]);
  const added = ownParts.slice(sharedParts.length);
  if (changed.length === 0 && added.length === 0) return null;
  const note = added.length
    ? 'Only these subsections replace the shared ones or, under a new heading, add to its end; the rest of this section is shared.'
    : 'Only these subsections replace the shared ones; the rest of this section is shared.';
  return [`${headingOf(own)}\n\n${note}`, ...changed, ...added].join('\n\n');
}

/** Where the installed SKILL.md finds its copy of the shared file. */
function sharedPath(ctx: TemplateContext): string {
  if (ctx.host === 'claude') return `\`${ctx.paths.skillRoot}/${path.basename(path.dirname(ctx.tmplPath))}/sections/${SHARED_PREAMBLE_FILE}\``;
  const installed = ctx.skillName.startsWith('gstack-') ? ctx.skillName : `gstack-${ctx.skillName}`;
  return `\`sections/${SHARED_PREAMBLE_FILE}\` relative to the installed \`${installed}\` SKILL.md directory`;
}

/** {{PREAMBLE}}: the full preamble for tier 1, else the pointer plus this skill's own sections. */
export function generateSkillPreamble(ctx: TemplateContext): string {
  if (isUnattended(ctx)) return generateUnattendedPreamble(ctx);
  const own = preambleSections(ctx);
  if (!hoistsPreamble(ctx)) return own.join('\n\n');
  const shared = sharedSections(ctx);
  const hoisted = new Set(shared);
  const sharedByHeading = new Map(shared.map(section => [headingOf(section), section]));
  const inline = own.flatMap(part => splitSections(part)).filter(section => !hoisted.has(section)).map(section => {
    const base = sharedByHeading.get(headingOf(section));
    return (base && variantSubsections(section, base)) ?? section;
  });
  const pointer = `## Shared preamble (load first)

This skill follows gstack shared preamble \`${sharedId(ctx, shared)}\` (AskUserQuestion format, voice, writing, completeness and completion rules). If your Read of that file, headed by this id, is still in context, do not read it again; otherwise Read ${sharedPath(ctx)} in full before the command below. A section or subsection here with a shared heading replaces the shared one.`;
  return [pointer, ...inline].join('\n\n');
}

/** Body of `sections/preamble.md` for a tier 2+ skill; identical for every such skill on a host. */
export function generateSharedPreambleFile(ctx: TemplateContext): string {
  const shared = sharedSections(ctx);
  return `# gstack shared preamble ${sharedId(ctx, shared)}

${shared.join('\n\n')}
`;
}
