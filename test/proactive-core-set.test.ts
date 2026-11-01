/**
 * The core-set proactive default (GSTA-93 fix 12): the router and every skill's
 * preamble carry the same three-way rule, the one-time prompt offers core, all
 * and off, and the question registry agrees. Negative controls: no surface
 * still describes true as "the default", and the preamble never tells a skill to
 * auto-invoke a non-core skill under core.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import { frontmatterList } from '../lib/skill-triggers';
import { QUESTIONS } from '../scripts/question-registry';
import { generateUpgradeCheck } from '../scripts/resolvers/preamble/generate-upgrade-check';

const ROOT = path.resolve(import.meta.dir, '..');
const CORE = ['/office-hours', '/review', '/qa', '/ship'];
const NON_CORE_SAMPLE = ['/investigate', '/plan-ceo-review', '/design-review', '/retro'];
// The one place the core block may name non-core skills: the rule that says to name them for the user to type.
const TYPE_IT_RULE = 'under `core`, name `/browse` or `/investigate` for the user to type instead of\ninvoking it.';

const routerTmpl = fs.readFileSync(path.join(ROOT, 'SKILL.md.tmpl'), 'utf-8');
const routerOut = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
const skillStart = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), 'utf-8');

describe('proactive core set: the router', () => {
  test('the template names core as the default and lists exactly the four core skills', () => {
    const block = routerTmpl.slice(routerTmpl.indexOf('If `PROACTIVE` is `core` (default)'), routerTmpl.indexOf('If `PROACTIVE` is `all`'));
    expect(block.length).toBeGreaterThan(50);
    for (const skill of CORE) expect(block).toContain(`\`${skill}\``);
    expect(block).toContain(TYPE_IT_RULE);
    for (const skill of NON_CORE_SAMPLE) expect(block.replace(TYPE_IT_RULE, '')).not.toContain(`\`${skill}\``);
    expect(block).toContain('A skill the user names is always invoked');
  });

  test('off and all are spelled with their legacy aliases; true is no longer "the default" (negative control)', () => {
    expect(routerTmpl).toContain('If `PROACTIVE` is `false` or `off`');
    expect(routerTmpl).toContain('If `PROACTIVE` is `all` (or `true`)');
    expect(routerTmpl).not.toMatch(/`PROACTIVE` is `true` \(default\)/);
    expect(routerTmpl).toContain('gstack-config set proactive off');
    expect(routerTmpl).toContain('gstack-config set proactive all');
    expect(routerTmpl).not.toContain('gstack-config set proactive false');
  });

  test('the generated router carries the same rule', () => {
    expect(routerOut).toContain('If `PROACTIVE` is `core` (default)');
    for (const skill of CORE) expect(routerOut).toContain(`\`${skill}\``);
  });
});

describe('proactive core set: every skill preamble', () => {
  const line = generateUpgradeCheck({ paths: { skillRoot: '~/.claude/skills/gstack' } } as never);

  test('the steady-state rule names the four core skills under core, scopes the setting to unasked suggestions, carves out only named skills, and keeps the marker the order test reads', () => {
    expect(line).toMatch(/^If `PROACTIVE` is `off`/);
    expect(line).toContain('`core`: only /office-hours, /review, /qa, /ship');
    expect(line).toContain('`all`: any');
    expect(line).toContain('suggest no skills unasked, nor ask');
    expect(line).toContain('Skills the user names or this one invokes run');
    expect(line.split('\n')[0]).not.toContain('true');
    for (const skill of NON_CORE_SAMPLE) expect(line).not.toContain(skill);
  });

  test('a generated core skill and a generated non-core skill both carry it (it is the same preamble)', () => {
    for (const skill of ['review', 'investigate']) {
      const out = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(out).toContain('`core`: only /office-hours, /review, /qa, /ship');
    }
  });
});

describe('proactive core set: the one-time prompt and the registry', () => {
  test('the prompt offers core (recommended), all and off, and never writes true or false', () => {
    const block = skillStart.slice(skillStart.indexOf('_emit_block proactive-prompt'), skillStart.indexOf('.proactive-prompted"\\`', skillStart.indexOf('_emit_block proactive-prompt')));
    expect(block).toContain('Keep the core four (recommended)');
    expect(block).toContain('gstack-config set proactive core');
    expect(block).toContain('gstack-config set proactive all');
    expect(block).toContain('gstack-config set proactive off');
    expect(block).not.toContain('set proactive true');
    expect(block).not.toContain('set proactive false');
    expect(block).toContain("Turn it off — I'll type /commands myself");
  });

  test('the registry entry matches the prompt options', () => {
    expect(QUESTIONS['preamble-proactive-behavior'].options).toEqual(['core', 'all', 'off']);
  });

  test('the first-run and first-loop tips name only core skills (negative control: no /spec or /investigate tip; the off gating is proven by running the script in proactive-skill-start.test.ts)', () => {
    const tips = skillStart.slice(skillStart.indexOf('if [ "$_ACTIVATED" = "no" ]; then'), skillStart.indexOf('# Routing injection'));
    for (const skill of NON_CORE_SAMPLE.concat(['/spec', '/plan-eng-review'])) expect(tips).not.toContain(skill);
    for (const skill of CORE) expect(tips).toContain(skill);
  });
});

/**
 * Value: protects=every PROACTIVE gate outside the router honors off, the opt-out the
 * router and prompt now write, and the router tells a model that an in-skill handoff is
 * not a suggestion; fails_when=a template gates on the legacy false only, or the
 * carve-out sentence is dropped; why_new=the surfaces table above lists only text that
 * names the core four; the office-hours handoff names non-core next steps by design;
 * seam=none; no_claim=how a model weighs the two instructions (prose, not executed)
 */
describe('proactive core set: in-skill handoffs', () => {
  test('the office-hours next-review handoff honors off as well as false, and its render carries it', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'office-hours', 'sections', 'design-and-handoff.md.tmpl'), 'utf-8');
    const gate = tmpl.match(/\*\*If `PROACTIVE` is [^\n]*do NOT auto-launch/)?.[0] ?? '';
    expect(gate).toContain('`false` or `off`');
    const out = fs.readFileSync(path.join(ROOT, 'office-hours', 'sections', 'design-and-handoff.md'), 'utf-8');
    expect(out).toMatch(/If `PROACTIVE` is `false` or `off`[^\n]*do NOT auto-launch/);
  });

  test('the router says a step inside a running skill is part of that skill, not a suggestion', () => {
    expect(routerTmpl.replace(/\s+/g, ' ')).toContain('a step inside a skill that is already running (a handoff, a review gate, a subagent it dispatches) is part of that skill, not a suggestion');
  });
});

/**
 * Value: protects=the core four and the three proactive values agree across
 * the config header, the default table, the router, the preamble, the one-time
 * prompt and the docs; fails_when=the core set or a value name changes on one
 * surface only; why_new=the tests above pin the template, preamble and prompt
 * options but not the docs, nor the skill names the prompt and header speak;
 * seam=none; no_claim=none beyond protects (static text, no model run)
 */
describe('proactive core set: every surface names the same four skills and three values', () => {
  const configSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-config'), 'utf-8');
  const promptAt = skillStart.indexOf('_emit_block proactive-prompt');
  const docsSkills = fs.readFileSync(path.join(ROOT, 'docs', 'skills.md'), 'utf-8');
  const docsSkillsAt = docsSkills.indexOf('## Proactive skill suggestions');
  const surfaces: Record<string, string> = {
    'bin/gstack-config header': configSrc.slice(configSrc.indexOf('# proactive:'), configSrc.indexOf('# routing_declined:')),
    'bin/gstack-config lookup_default': configSrc.slice(configSrc.indexOf('lookup_default()')).match(/^\s*proactive\).*$/m)?.[0] ?? '',
    'SKILL.md.tmpl core block': routerTmpl.slice(routerTmpl.indexOf('If `PROACTIVE` is `core` (default)'), routerTmpl.indexOf('If `PROACTIVE` is `all`')).replace(TYPE_IT_RULE, ''),
    'preamble rule': generateUpgradeCheck({ paths: { skillRoot: '~/.claude/skills/gstack' } } as never),
    'gstack-skill-start prompt': skillStart.slice(promptAt, skillStart.indexOf('.proactive-prompted"\\`', promptAt)),
    'docs/proactive.md': fs.readFileSync(path.join(ROOT, 'docs', 'proactive.md'), 'utf-8'),
    'docs/skills.md section': docsSkills.slice(docsSkillsAt, docsSkills.indexOf('\n## ', docsSkillsAt + 1)),
  };

  test.each(Object.entries(surfaces))('%s names the core four and no sampled non-core skill', (name, text) => {
    expect(text.length, name).toBeGreaterThan(20);
    for (const skill of CORE) expect(text, `${name} lacks ${skill}`).toContain(skill);
    for (const skill of NON_CORE_SAMPLE) expect(text, `${name} names ${skill}`).not.toContain(skill);
  });

  test('the docs and the config header spell the three values, and the router names the restore-default command', () => {
    for (const name of ['docs/proactive.md', 'docs/skills.md section', 'bin/gstack-config header']) {
      for (const value of ['core', 'all', 'off']) expect(surfaces[name], `${name} lacks ${value}`).toMatch(new RegExp(`\\b${value}\\b`));
    }
    expect(surfaces['docs/proactive.md']).toContain('`true` and `false`');
    for (const value of ['all', 'off', 'core']) expect(surfaces['docs/proactive.md']).toContain(`gstack-config set proactive ${value}`);
    expect(routerTmpl.replace(/\s+/g, ' ')).toContain('`gstack-config set proactive core` restores the default');
  });
});

/**
 * Value: protects=the four core skills, the ones gstack routes by plain speech
 * under the core default, carry their own `triggers:` phrases where hosts read
 * them: at least one in the Claude catalog one-liner, every one in the full
 * description other hosts keep, and no core one-liner phrase in another
 * skill's one-liner; fails_when=a core lead or description loses its trigger
 * phrases, or a trigger phrase also matches another skill's catalog entry;
 * why_new=#2118: `triggers:` was metadata no host reads, and no test tied it
 * to a description; seam=none; no_claim=how a host ranks or picks skills
 * (static text, no model run)
 */
describe('proactive core set: core skills carry their trigger phrases (#2118)', () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  const description = (md: string): string => {
    const fm = md.slice(0, md.indexOf('\n---', 4));
    const block = fm.match(/^description:\s*\|\s*\n((?:[ \t]+.*\n|\n)+)/m)?.[1];
    return norm(block ?? fm.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, '') ?? '');
  };
  const skillDirs = fs.readdirSync(ROOT).filter(dir => fs.existsSync(path.join(ROOT, dir, 'SKILL.md.tmpl')) && fs.existsSync(path.join(ROOT, dir, 'SKILL.md')));
  const catalog = Object.fromEntries(skillDirs.map(dir => [dir, description(fs.readFileSync(path.join(ROOT, dir, 'SKILL.md'), 'utf-8'))]));

  test.each(CORE.map(s => s.slice(1)))('%s: every trigger phrase is in its full description, and one is in its catalog one-liner that no other one-liner carries', (skill) => {
    const tmpl = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md.tmpl'), 'utf-8');
    const triggers = frontmatterList(tmpl, 'triggers').map(norm);
    expect(triggers.length).toBeGreaterThan(0);
    const full = description(tmpl);
    for (const phrase of triggers) expect(full, `${skill} full description lacks "${phrase}"`).toContain(phrase);
    const inCatalog = triggers.filter(phrase => catalog[skill].includes(phrase));
    expect(inCatalog.length, `${skill} one-liner "${catalog[skill]}" carries none of ${triggers.join(', ')}`).toBeGreaterThan(0);
    for (const phrase of inCatalog) {
      const others = skillDirs.filter(dir => dir !== skill && catalog[dir].includes(phrase));
      expect(others, `"${phrase}" also in`).toEqual([]);
    }
  });
});
