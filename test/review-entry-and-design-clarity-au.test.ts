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
import { between, compact, expectMentions, expectTokens } from './helpers/prompt-structure';

const root = path.resolve(import.meta.dir, '..');
const announcement = 'Scope gate: plan mode — auto-selected B (reviewing <target>).';
const section = fs.readFileSync(path.join(root, 'plan-design-review/sections/review-sections.md.tmpl'), 'utf8');
function context(skillName: string, host: typeof ALL_HOST_CONFIGS[number]): TemplateContext {
  return {skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host: host.name,
    paths: HOST_PATHS[host.name]!, preambleTier: 3, interactive: true};
}
function assertScopedEntry(preamble: string, planMode = true) {
  const command = preamble.indexOf('```bash');
  expect(command).toBeGreaterThan(0);
  const entry = preamble.slice(0, command);
  expect(entry).toContain('## Preamble (after scope gate)');
  expect(entry).toContain('resolve the Scope gate above');
  expectMentions(entry, [['wait', 'question', 'answer']], 'entry');
  expect(preamble).not.toContain('## Preamble (run first)');
  expect(preamble).not.toContain('starting from Step 0;');
  if (!planMode) {
    expect(preamble).not.toContain('## Skill Invocation During Plan Mode');
    return;
  }
  expect(preamble).toContain('starting from the Scope gate');
}

test('Design and Eng resolve the existing gate at the first executable preamble in every host', () => {
  for (const host of ALL_HOST_CONFIGS) for (const skill of ['plan-design-review', 'plan-eng-review']) {
    const ctx = context(skill, host);
    assertScopedEntry(generatePreamble(ctx), host.capabilities.planMode);
    const tmpl = fs.readFileSync(path.join(root, `${skill}/SKILL.md.tmpl`), 'utf8');
    expect(tmpl.indexOf(announcement)).toBeLessThan(tmpl.indexOf('{{PREAMBLE}}'));
    expect(tmpl).toContain('If the user explicitly named a DIFFERENT target');
    expectMentions(tmpl, [['no', 'indicated', 'exists']], 'tmpl');
  }
});

test('missing local checkpoint and competing Step 0 entry instructions fail the generation contract', () => {
  const text = generatePreamble(context('plan-design-review', ALL_HOST_CONFIGS[0]!));
  expect(() => assertScopedEntry(text.replace('resolve the Scope gate above', ''))).toThrow();
  expect(() => assertScopedEntry(text.replace('## Preamble (after scope gate)', '## Preamble (run first)'))).toThrow();
  expect(() => assertScopedEntry(text.replace('starting from the Scope gate', 'starting from Step 0; then the Scope gate'))).toThrow();
});

test('other skills keep their existing preamble entry and plan-mode starting point', () => {
  for (const host of ALL_HOST_CONFIGS) for (const skill of ['plan-ceo-review', 'plan-devex-review', 'ship', 'review']) {
    const ctx = context(skill, host);
    const entry = generatePreambleBash(ctx);
    if (host.name === 'claude') expect(entry).toStartWith(`## Preamble (run first)\n\n!\`${ctx.paths.binDir}/gstack-skill-load start --skill "${skill}"`);
    else expect(entry.startsWith('## Preamble (run first)\n\n```bash')).toBe(true);
    if (host.capabilities.planMode) expect(generatePlanModeInfo(ctx)).toContain('starting from Step 0;');
    else expect(generatePlanModeInfo(ctx)).toBe('');
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
  expectMentions(pass, [['not', 'findings', 'separate']], 'pass');
  for (const skill of ['design-review', 'design-consultation', 'design-html']) {
    expect(generateDesignHardRules(context(skill, host)).startsWith('### Design Hard Rules\n')).toBe(true);
  }
});

test('the decision table preserves first approval, inherited approvals, artifact and navigation boundaries', () => {
  const cases = section.slice(section.indexOf('| Situation |'), section.indexOf('{{LEARNINGS_SEARCH}}'));
  expect(cases).toContain('do not ask again');
  expect(cases).toContain('copied unchanged into a required artifact');
  expect(cases).toContain('it approves no new remedy');
  expectMentions(cases, [['no', 'individual', 'decision']], 'cases');
  expect(cases).toContain('even if the input names the gap or DESIGN.md prescribes the exact token');
  expect(cases).toContain('Keep the proposed remedy pending');
  expect(cases).toContain('new tradeoff');
  expectMentions(section, [['no', 'next-step', 'remedies']], 'section');
  expectMentions(section, [['never', 'afterward', 'first']], 'section');
});

test('scoring and section dependencies are explicit while existing clean and pass thresholds remain', () => {
  expectMentions(section, [['before', 'separately', 'approved']], 'section');
  expect(section).toContain('Pass 7 is unscored');
  expect(section).toContain('After Read-back, if all passes 8+');
  expect(section).toContain('"clean" if overall score 8+ AND 0 unresolved');
  expect(section).toContain('If DESIGN.md is absent, rate the plan\'s explicit token and component specifications');
  expectMentions(section, [['do not', 'alignment', 'assume']], 'section');
  expect(section).toContain('Read `~/.claude/skills/gstack/plan-design-review/SKILL.md`');
  expectMentions(section, [['do not', 'existing', 'results']], 'section');
  expect(section).toContain('After Pass 7: offer the mockup update below when applicable, resolve deferred TODO proposals, reconcile approvals, then synthesize tasks and the Completion Summary.');
});

test('the design Completion Summary is its own section above the report, so the next review\'s rewrite keeps it (#3219)', () => {
  const rendered = fs.readFileSync(path.join(root, 'plan-design-review/sections/review-sections.md'), 'utf8');
  const summary = compact(between(rendered, '### Completion Summary', '**Overall design score:**'));
  expect(summary).toContain('its own `## Design Review Completion Summary` section');
  expectMentions(summary, [['above', 'terminal', 'GSTACK REVIEW REPORT']], 'summary placement');
  expectMentions(summary, [['never', 'inside', 'regenerates everything']], 'summary placement');
  expect(compact(rendered)).toContain('through either the next \\`## \\` heading or end of file');
  const nextReviewRewrite = (plan: string) =>
    plan.replace(/^## GSTACK REVIEW REPORT\n[\s\S]*?(?=^## |(?![\s\S]))/m, '') + '## GSTACK REVIEW REPORT\n| Eng Review | CLEAR |\n';
  const report = '## GSTACK REVIEW REPORT\n| Design Review | ISSUES OPEN |\n';
  const box = 'Pass 1  (Info Arch)  | 4/10 → 8/10 after fixes\n';
  expect(nextReviewRewrite(`# Plan\n\n## Design Review Completion Summary\n${box}\n${report}`)).toContain(box);
  expect(nextReviewRewrite(`# Plan\n\n${report}\n### Completion Summary\n${box}`)).not.toContain(box);
});

test('the DX Scorecard is its own section above the report, so the next review\'s rewrite keeps it (#3219)', () => {
  const rendered = fs.readFileSync(path.join(root, 'plan-devex-review/sections/review-sections.md'), 'utf8');
  const scorecard = compact(between(rendered, '### DX Scorecard', 'DX PLAN REVIEW'));
  expect(scorecard).toContain('its own `## DX Review Scorecard` section');
  expectMentions(scorecard, [['above', 'terminal', 'GSTACK REVIEW REPORT']], 'scorecard placement');
  expectMentions(scorecard, [['never', 'inside', 'regenerates everything']], 'scorecard placement');
});

test('new regression and changed preamble sources select all Design and Eng owners', () => {
  for (const map of [E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES]) {
    const affected = selectTests(['plan-design-review/SKILL.md.tmpl', 'plan-eng-review/SKILL.md.tmpl'], map, []).selected;
    for (const source of ['scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts']) {
      const selected = selectTests([source], map, []).selected;
      for (const owner of affected) expect(selected).toContain(owner);
    }
  }
});

test('design-review captures code tokens before universal principles and reuses them in target mockups', () => {
  const skill = fs.readFileSync(path.join(root, 'design-review/SKILL.md'), 'utf8');
  const capture = between(skill, '**Capture the project\'s design system:**', '## Phase 1');
  expectTokens(capture, ['`tailwind.config.*`', '`:root`'], 'design-system capture');
  expectMentions(compact(capture), [['universal', 'only', 'neither', 'code tokens']], 'design-system capture');
  const mockup = compact(between(skill, '### 8a.5. Target Mockup', '### 8b.'));
  expectMentions(mockup, [['brief', 'reuses', 'captured', 'colors', 'fonts']], 'target mockup');
  expectMentions(mockup, [['never', 'new palette', 'already has one']], 'target mockup');
});
