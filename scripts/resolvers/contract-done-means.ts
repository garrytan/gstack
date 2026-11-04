/**
 * {{CONTRACT_DONE_MEANS}}: a skill's `contract:` frontmatter block (GST-1088, frozen v1
 * schema) rendered as a short "Done means" list at the top of the body, so the
 * outputs the model reads as required and the block the Stop check reads cannot
 * drift. parseSkillContract is the schema; test/skill-descriptions.test.ts runs it
 * over every template, so a malformed block fails CI instead of failing open.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from './types';
import { getHostConfig } from '../../hosts/index';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const code = (s: string) => '\u0060' + s + '\u0060';

export type ContractItem =
  | { id: string; kind: 'report_labels'; heading: string; labels: string[] }
  | { id: string; kind: 'check_after_last_edit' }
  | { id: string; kind: 'selected_specialists_dispatched'; marker: string }
  | { id: string; kind: 'agent_dispatch'; match: string };

export interface SkillContract {
  version: 1;
  items: ContractItem[];
}

const KIND_FIELDS: Record<ContractItem['kind'], string[]> = {
  report_labels: ['heading', 'labels'],
  check_after_last_edit: [],
  selected_specialists_dispatched: ['marker'],
  agent_dispatch: ['match'],
};

// The resolver and section that render the step each kind checks today. A host that suppresses the resolver, or a loadout that excludes the section, never shows that step, so its items are left out of the list there.
const BACKED_BY: Partial<Record<ContractItem['kind'], { resolver: string; section: string }>> = {
  selected_specialists_dispatched: { resolver: 'REVIEW_ARMY', section: 'review-army' },
  agent_dispatch: { resolver: 'ADVERSARIAL_STEP', section: 'adversarial' },
};

const PLACEHOLDER = /^\[.*\]$|^<.*>$|^\.\.\.$|^(todo|tbd|n\/a)$/i;

function fail(where: string, problem: string): never {
  throw new Error('CONTRACT_INVALID ' + where + ': ' + problem + '. Fix: edit ' + where + ', then bun run gen:skill-docs');
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Validates a parsed `contract:` value against the frozen v1 schema; where names the template in errors. */
export function parseSkillContract(value: unknown, where: string): SkillContract {
  if (!isMap(value)) fail(where, 'contract must be a mapping { version: 1, items: [...] }');
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'items') fail(where, 'contract has unknown key "' + key + '"');
  }
  if (value.version !== 1) fail(where, 'contract version must be 1, got ' + JSON.stringify(value.version));
  if (!Array.isArray(value.items) || value.items.length === 0) fail(where, 'contract items must be a non-empty list');
  const seen = new Set<string>();
  const items = value.items.map((raw: unknown, i: number) => {
    const at = 'items[' + i + ']';
    if (!isMap(raw)) fail(where, at + ' must be a mapping');
    const kind = raw.kind as ContractItem['kind'];
    if (typeof raw.kind !== 'string' || !Object.hasOwn(KIND_FIELDS, kind)) {
      fail(where, at + ' kind ' + JSON.stringify(raw.kind) + ' is not one of ' + Object.keys(KIND_FIELDS).join(', '));
    }
    if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(raw.id)) {
      fail(where, at + ' id must be lowercase kebab-case, got ' + JSON.stringify(raw.id));
    }
    if (seen.has(raw.id)) fail(where, at + ' duplicate id "' + raw.id + '"');
    seen.add(raw.id);
    for (const key of Object.keys(raw)) {
      if (key !== 'id' && key !== 'kind' && !KIND_FIELDS[kind].includes(key)) fail(where, at + ' (' + kind + ') has unknown key "' + key + '"');
    }
    for (const field of KIND_FIELDS[kind]) {
      if (field !== 'labels' && !isText(raw[field])) fail(where, at + ' ' + field + ' must be a non-empty string');
    }
    if (kind === 'report_labels') {
      if (!Array.isArray(raw.labels) || raw.labels.length === 0) fail(where, at + ' labels must be a non-empty list');
      for (const label of raw.labels as unknown[]) {
        if (!isText(label)) fail(where, at + ' labels must be non-empty strings');
        if (PLACEHOLDER.test(label.trim())) fail(where, at + ' label ' + JSON.stringify(label) + ' is a placeholder');
      }
    }
    return raw as ContractItem;
  });
  return { version: 1, items };
}

/** The template's contract, or null without one; required makes a missing block an error. */
export function contractFromTemplate(tmplContent: string, where: string, opts: { required?: boolean } = {}): SkillContract | null {
  const block = tmplContent.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!block || !/^contract:/m.test(block[1])) {
    if (opts.required) fail(where, '{{CONTRACT_DONE_MEANS}} needs a contract block in the frontmatter');
    return null;
  }
  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(block[1]);
  } catch (error) {
    fail(where, 'frontmatter is not valid YAML (' + (error instanceof Error ? error.message : String(error)) + ')');
  }
  return parseSkillContract(isMap(frontmatter) ? frontmatter.contract : undefined, where);
}

const list = (xs: string[]) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

function plainWords(item: ContractItem): string {
  switch (item.kind) {
    case 'report_labels': return 'a ' + code(item.heading) + ' with ' + list(item.labels) + ' filled in (' + code('none: <why>') + ' where the skill\'s own stop rule leaves one empty)';
    case 'check_after_last_edit': return 'a test or repro command run after your last edit';
    case 'selected_specialists_dispatched': return 'the specialist selection printed (' + code(item.marker) + ' ...), then one Agent dispatch per specialist it names (none when a small diff skips them)';
    case 'agent_dispatch': return 'an Agent dispatch for the ' + item.id.replace(/-/g, ' ') + ', its prompt including "' + item.match + '"';
  }
}

/** Whether bin/gstack-skill-contract ships. The PR that adds it flips this, regenerates and re-pins; test/skill-descriptions.test.ts fails while the two disagree. */
export const CONTRACT_CHECKER_SHIPPED = true;

/** The list; checker adds the check and waive commands (run through the host's binDir), which only a tree that ships the checker may mention. */
export function renderDoneMeans(contract: SkillContract, binDir: string, checker = CONTRACT_CHECKER_SHIPPED): string {
  if (contract.items.length === 0) return '';
  return [
    '## Done means',
    '',
    'Finish only when each of these exists (contract v1):',
    '',
    ...contract.items.map(item => '- ' + code(item.id) + ': ' + plainWords(item) + '.'),
    ...(checker ? ['', code(binDir + '/gstack-skill-contract check') + ' reads them from the transcript (docs/skill-routing-and-contracts.md). ' +
      'For an item that truly does not apply, run ' + code(binDir + '/gstack-skill-contract waive <item> --reason "<why>"') + ' (this session only; it counts as a miss).'] : []),
  ].join('\n');
}

export function generateContractDoneMeans(ctx: TemplateContext): string {
  const where = path.relative(ROOT, ctx.tmplPath).split(path.sep).join('/');
  const contract = contractFromTemplate(fs.readFileSync(ctx.tmplPath, 'utf-8'), where, { required: true })!;
  const suppressed = new Set(getHostConfig(ctx.host).suppressedResolvers ?? []);
  const shown = (item: ContractItem) => {
    const backing = BACKED_BY[item.kind];
    return !backing || (!suppressed.has(backing.resolver) && !ctx.modules?.excluded.has('section:' + ctx.skillName + '/' + backing.section));
  };
  return renderDoneMeans({ ...contract, items: contract.items.filter(shown) }, ctx.paths.binDir);
}
