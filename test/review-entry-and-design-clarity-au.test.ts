import {expect, test} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {ALL_HOST_CONFIGS} from '../hosts';
import {HOST_PATHS, type TemplateContext} from '../scripts/resolvers/types';
import {generatePreamble} from '../scripts/resolvers/preamble';
import {generatePreambleBash} from '../scripts/resolvers/preamble/generate-preamble-bash';
import {generatePlanModeInfo} from '../scripts/resolvers/preamble/generate-completion-status';
import {generateDesignHardRules} from '../scripts/resolvers/design';
import {E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, selectTests} from './helpers/touchfiles';

const root = path.resolve(import.meta.dir, '..');
const announcement = 'Scope gate: plan mode — auto-selected B (reviewing <target>).';
const section = fs.readFileSync(path.join(root, 'plan-design-review/sections/review-sections.md.tmpl'), 'utf8');
function context(skillName: string, host: typeof ALL_HOST_CONFIGS[number]): TemplateContext {
  return {skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host: host.name,
    paths: HOST_PATHS[host.name]!, preambleTier: 3, interactive: true};
}
function assertScopedEntry(preamble: string) {
  const command = preamble.indexOf('```bash');
  expect(command).toBeGreaterThan(0);
  const entry = preamble.slice(0, command);
  expect(entry).toContain('## Preamble (after scope gate)');
  expect(entry).toContain(announcement);
  expect(entry).toContain('actual selected plan title or path');
  expect(entry).toContain('after this skill loads');
  expect(entry).toContain('a pre-invocation introduction does not count');
  expect(entry).toContain('If the gate asks a question, wait for its answer');
  expect(preamble).not.toContain('## Preamble (run first)');
  expect(preamble).toContain('starting from the Scope gate');
  expect(preamble).not.toContain('starting from Step 0;');
}

test('Design and Eng resolve the existing gate at the first executable preamble in every host', () => {
  for (const host of ALL_HOST_CONFIGS) for (const skill of ['plan-design-review', 'plan-eng-review']) {
    const ctx = context(skill, host);
    assertScopedEntry(generatePreamble(ctx));
    const tmpl = fs.readFileSync(path.join(root, `${skill}/SKILL.md.tmpl`), 'utf8');
    expect(tmpl.indexOf(announcement)).toBeLessThan(tmpl.indexOf('{{PREAMBLE}}'));
    expect(tmpl).toContain('If the user explicitly named a DIFFERENT target');
    expect(tmpl).toContain('If plan mode is indicated but no plan exists yet, ask as normal');
  }
});

test('missing local checkpoint and competing Step 0 entry instructions fail the generation contract', () => {
  const text = generatePreamble(context('plan-design-review', ALL_HOST_CONFIGS[0]!));
  expect(() => assertScopedEntry(text.replace(announcement, ''))).toThrow();
  expect(() => assertScopedEntry(text.replace('## Preamble (after scope gate)', '## Preamble (run first)'))).toThrow();
  expect(() => assertScopedEntry(text.replace('starting from the Scope gate', 'starting from Step 0; then the Scope gate'))).toThrow();
});

test('other skills keep their existing preamble entry and plan-mode starting point', () => {
  for (const host of ALL_HOST_CONFIGS) for (const skill of ['plan-ceo-review', 'plan-devex-review', 'ship', 'review']) {
    const ctx = context(skill, host);
    expect(generatePreambleBash(ctx).startsWith('## Preamble (run first)\n\n```bash')).toBe(true);
    expect(generatePlanModeInfo(ctx)).toContain('starting from Step 0;');
    expect(generatePreambleBash(ctx)).not.toContain('Before the command below');
  }
});

test('hard rules remain inside the scored fourth pass without changing other skills heading levels', () => {
  const host = ALL_HOST_CONFIGS[0]!;
  const rules = generateDesignHardRules(context('plan-design-review', host));
  const rendered = section.replace('{{DESIGN_HARD_RULES}}', rules);
  const start = rendered.indexOf('### Pass 4:');
  const end = rendered.indexOf('### Pass 5:');
  const pass = rendered.slice(start, end);
  expect(pass.indexOf('**Pass 4 evaluation:**')).toBeLessThan(pass.indexOf('#### Design Hard Rules'));
  expect(pass.match(/^### /gm)).toHaveLength(1);
  expect(pass).toContain('An unresolved hard rejection caps this pass below 8');
  expect(pass).toContain('Litmus answers support findings, not a separate numeric score.');
  for (const skill of ['design-review', 'design-consultation', 'design-html']) {
    expect(generateDesignHardRules(context(skill, host)).startsWith('### Design Hard Rules\n')).toBe(true);
  }
});

test('the decision table preserves first approval, inherited approvals, artifact and navigation boundaries', () => {
  const cases = section.slice(section.indexOf('| Situation |'), section.indexOf('{{LEARNINGS_SEARCH}}'));
  expect(cases).toContain('exact fix already has an individual user decision or a preamble-authorized per-issue auto-decision');
  expect(cases).toContain('do not ask again');
  expect(cases).toContain('copied unchanged into a required artifact');
  expect(cases).toContain('it approves no new remedy');
  expect(cases).toContain('no individual decision has approved its fix');
  expect(cases).toContain('even if the input names the gap or DESIGN.md prescribes the exact token');
  expect(cases).toContain('Keep the proposed remedy pending');
  expect(cases).toContain('new tradeoff');
  expect(section).toContain('Scope, focus, setup, and next-step choices approve no remedies.');
  expect(section).toContain('Never edit first and ask afterward.');
  expect(section).toContain('An unapproved violation still needs its first individual decision.');
});

test('scoring and section dependencies are explicit while existing clean and pass thresholds remain', () => {
  expect(section).toContain('use the lowest of the six rated pass scores (1-6)');
  expect(section).toContain('separately before and after approved fixes');
  expect(section).toContain('Pass 7 is unscored');
  expect(section).toContain('If all passes 8+');
  expect(section).toContain('"clean" if overall score 8+ AND 0 unresolved');
  expect(section).toContain('If DESIGN.md is absent, rate the plan\'s explicit token and component specifications');
  expect(section).toContain('do not skip the score or assume alignment');
  expect(section).toContain('Read `~/.claude/skills/gstack/plan-design-review/SKILL.md`');
  expect(section).toContain('Use their existing results; do not restart the review.');
  expect(section).toContain('After Pass 7: offer the mockup update below when applicable, resolve deferred TODO proposals, reconcile approvals, then synthesize tasks and the Completion Summary.');
});

test('new regression and changed preamble sources select all Design and Eng owners', () => {
  for (const map of [E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES]) {
    const affected = selectTests(['plan-design-review/SKILL.md.tmpl', 'plan-eng-review/SKILL.md.tmpl'], map, []).selected;
    expect(selectTests(['test/review-entry-and-design-clarity-au.test.ts'], map, []).selected).toEqual(affected);
    for (const source of ['scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts']) {
      const selected = selectTests([source], map, []).selected;
      for (const owner of affected) expect(selected).toContain(owner);
    }
  }
});
