/**
 * Trigger-first skill wording for harness listings (GSTA-135 skill use).
 *
 * Frozen rule, built only from each skill's own frontmatter, and the trigger
 * part always comes first:
 * - Router lines (lib/harness-register.ts, 160 chars): the description's own
 *   trigger sentence (its first sentence that starts "Use when", "Use to",
 *   "Use for", ...), followed by the description's first sentence when both
 *   fit. A description with no trigger sentence (the catalog-trimmed Claude
 *   render) uses the triggers list below instead.
 * - Hermes descriptions (scripts/gen-skill-docs.ts, hosts/hermes.ts): a lead
 *   of at most 57 chars, the part Hermes's skills index shows: "Use for: "
 *   and the skill's `triggers:` list in frontmatter order, as many whole
 *   entries as fit; without triggers, the trigger sentence (or first
 *   sentence) cut at a word. The description's own trigger sentence, which
 *   the list repeats, is dropped, so a render does not grow.
 */

const TRIGGER_SENTENCE = /^Use (when|whenever|to|for|after|before|on|if)\b/;

export const normalizeDescription = (description: string) => description.replace(/\s*\(gstack\)\s*$/, '').replace(/\s+/g, ' ').trim();

export const sentences = (description: string): string[] => normalizeDescription(description).split(/(?<=[.!?])\s+/).filter(Boolean);

/** Cuts at the last word boundary that leaves room for "...". */
export function cutWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return (space > max / 3 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '') + '...';
}

/** The description's own trigger sentence, or ''. */
export const triggerSentence = (description: string) => sentences(description).find(s => TRIGGER_SENTENCE.test(s)) ?? '';

/** "Use for: a, b, c." from a skill's triggers list, as many whole entries as fit in max chars ('' without triggers). */
export function triggerList(triggers: string[], max: number): string {
  const items = triggers.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!items.length) return '';
  let lead = 'Use for: ' + items[0] + '.';
  for (const t of items.slice(1)) {
    const next = lead.slice(0, -1) + ', ' + t + '.';
    if (next.length > max) break;
    lead = next;
  }
  return cutWords(lead, max);
}

/** A trigger-first lead of at most max chars: the triggers list, else the trigger sentence or first sentence cut at a word. */
export function triggerLead(description: string, triggers: string[], max: number): string {
  return triggerList(triggers, max) || cutWords(triggerSentence(description) || sentences(description)[0] || '', max);
}

/** A description led by triggerLead on its own first line; the description's trigger sentence is dropped when the lead comes from the triggers list, which that sentence repeats. */
export function withTriggerLead(description: string, triggers: string[], max: number): string {
  const lead = triggerLead(description, triggers, max);
  const sentence = triggerSentence(description);
  if (!sentence || !triggerList(triggers, max)) return lead + '\n' + description;
  const tag = /\(gstack\)\s*$/.test(description) ? ' (gstack)' : '';
  return lead + '\n' + sentences(description).filter(s => s !== sentence).join(' ') + tag;
}

/** A router line of at most max chars: the trigger part first, then the description's first sentence when both fit. */
export function routerLine(description: string, triggers: string[], max = 160): string {
  const first = sentences(description)[0] ?? '';
  const trigger = triggerSentence(description) || triggerList(triggers, max);
  if (!trigger) return cutWords(first, max);
  const both = trigger + ' ' + first;
  return first && first !== trigger && both.length <= max ? both : cutWords(trigger, max);
}

/** The values of a YAML block list field (`field:` then `  - value` lines) in a SKILL.md's frontmatter. */
export function frontmatterList(md: string, field: string): string[] {
  const fm = md.startsWith('---\n') ? md.slice(4, md.indexOf('\n---', 4)) : '';
  const lines = fm.split('\n');
  const i = lines.findIndex(l => l.trimEnd() === field + ':');
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^\s*-\s+(.*)$/.exec(l);
    if (!m) break;
    out.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}
