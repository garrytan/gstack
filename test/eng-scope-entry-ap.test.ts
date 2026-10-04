import {expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {ALL_HOST_CONFIGS} from '../hosts';
import {HOST_PATHS, type TemplateContext} from '../scripts/resolvers/types';
import {generatePreamble} from '../scripts/resolvers/preamble';
import {generateAskUserFormat} from '../scripts/resolvers/preamble/generate-ask-user-format';
import {generateGBrainContextLoad} from '../scripts/resolvers/gbrain';
import {readWorkflowJudgeInput} from './helpers/workflow-judge-input';
import { expectMentions } from './helpers/prompt-structure';

const template = fs.readFileSync(path.join(import.meta.dir, '../plan-eng-review/SKILL.md.tmpl'), 'utf8');
const scope = template.slice(template.indexOf('## Scope gate'), template.indexOf('## Priority hierarchy'));
const announcement = 'Scope gate: plan mode — auto-selected B (reviewing <target>).';

const menuPrefix = 'Reply with A, B, or C';

test('Eng resolves scope before either executable bootstrap placeholder', () => {
  const gate = template.indexOf('## Scope gate');
  expect(gate).toBeGreaterThan(0);
  expect(template.indexOf(announcement)).toBeGreaterThan(gate);
  expect(template.indexOf(menuPrefix)).toBeGreaterThan(gate);
  for (const token of ['{{PREAMBLE}}', '{{GBRAIN_CONTEXT_LOAD}}']) {
    expect(template.split(token)).toHaveLength(2);
    expect(template.indexOf(announcement)).toBeLessThan(template.indexOf(token));
    expect(template.indexOf(menuPrefix)).toBeLessThan(template.indexOf(token));
  }
  expect(template.indexOf('{{PREAMBLE}}')).toBeLessThan(template.indexOf('{{GBRAIN_CONTEXT_LOAD}}'));
  expect(template.indexOf('{{GBRAIN_CONTEXT_LOAD}}')).toBeLessThan(template.indexOf('### Design Doc Check'));
});

test('every host expands its real bootstrap after the mandatory entry gate', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx: TemplateContext = {skillName: 'plan-eng-review', tmplPath: 'plan-eng-review/SKILL.md.tmpl',
      host: host.name, paths: HOST_PATHS[host.name]!, preambleTier: 3, interactive: true};
    const preamble = generatePreamble(ctx);
    const brain = host.suppressedResolvers?.includes('GBRAIN_CONTEXT_LOAD') ? '' : generateGBrainContextLoad(ctx);
    const expanded = template.replace('{{PREAMBLE}}', preamble).replace('{{GBRAIN_CONTEXT_LOAD}}', brain);
    expect(expanded.indexOf(announcement)).toBeLessThan(expanded.indexOf('## Preamble (after scope gate)'));
    expect(expanded.indexOf(menuPrefix)).toBeLessThan(expanded.indexOf('```bash'));
    expect(expanded.indexOf('```bash')).toBeLessThan(expanded.indexOf('gstack-skill-start', expanded.indexOf('```bash')));
    if (brain) expect(expanded.indexOf(announcement)).toBeLessThan(expanded.indexOf('## Brain Context Load'));
  }
});

test('entry binds a current target and delays bootstrap until scope resolves', () => {
  const flat = scope.replace(/\s+/g, ' ');
  expect(flat).toMatch(/first tool call = AskUserQuestion/i);
  expect(scope.match(/\*\*Startup sequence\*\*/g)).toHaveLength(1);
  const startup = scope.slice(scope.indexOf('**Startup sequence**'), scope.indexOf('{{PREAMBLE}}'));
  const order = ['after target selection', 'Preamble', 'Context Recovery', 'Brain Context',
    'web-research readiness', 'Design Doc Check', 'Prerequisite Skill Offer', 'Review preparation'].map(step => startup.indexOf(step));
  expect(order.every(position => position >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(startup).toContain('**Engineering review → Step 0**');
  expect(startup).not.toContain('Read `sections/review-sections.md` in full');
  const entry = template.slice(template.indexOf('## Engineering review'), template.indexOf('## Section self-check'));
  expect(entry.split('{{SECTION:review-sections}}')).toHaveLength(2);
  expect(entry.indexOf('require resolved scope')).toBeLessThan(entry.indexOf('{{SECTION:review-sections}}'));
  expect(entry.indexOf('**Complexity gate:**')).toBeLessThan(entry.indexOf('{{SECTION:review-sections}}'));
});

test('plan selection exceptions and the unseeded stop remain explicit', () => {
  const flat = scope.replace(/\s+/g, ' ');
  expectMentions(flat, [['does not', 'documents', 'results']], 'flat');
  expect(flat).toMatch(/still ambiguous — ask/i);
  expect(flat).toMatch(/explicitly named a different target/i);
  expectMentions(flat, [['no', 'exists', 'normal']], 'flat');
  expectMentions(flat, [['stop', 'plain', 'prose']], 'flat');
  expectMentions(flat, [['do not', 'resend', 'wait']], 'flat');
  expect(scope).toContain('A) The current branch diff — the work in progress on this branch.\nB) A plan or design doc I\'ll paste or point you to.\nC) A specific file, directory, or path.');
  expect(scope).toContain(menuPrefix);
  expectMentions(flat, [['stop', 'answer', 'wait']], 'flat');
});

test('Eng alone defers canonical question rules until scope and keeps one counter across later stages', () => {
  const exception = 'For the initial Scope gate, use its selector algorithm instead of this format and routing. Everything below applies only after target selection.';
  const continuous = 'D-numbering: exclude the initial target menu. Start `D1` at the first later brief; increment through preamble, prerequisite, inline /office-hours, preparation, complexity and review. Never reset between stages or on return. This is a model-maintained counter.';
  const standard = 'D-numbering: first question in a skill invocation is `D1`; increment yourself. This is a model-level instruction, not a runtime counter.';
  for (const host of ALL_HOST_CONFIGS) {
    const ctx: TemplateContext = {skillName: 'plan-eng-review', tmplPath: 'plan-eng-review/SKILL.md.tmpl',
      host: host.name, paths: HOST_PATHS[host.name]!};
    const format = generateAskUserFormat(ctx);
    expect(format.split(exception)).toHaveLength(2);
    expect(format.indexOf(exception)).toBeLessThan(format.indexOf('Branch on the skill-start STATUS lines'));
    expect(format.split(continuous)).toHaveLength(2);
    expect(format).not.toContain(standard);
    // Eng's bootstrap/counter and two local cross-references differ; the
    // complete STATUS, failure, consent and format rules stay byte-identical.
    expect(format).not.toContain('Spawned session block');
    expect(format).not.toContain('**Spawned session** block');
    expect(format).toContain('at every decision point under this rule');
    expect(format).toContain('follow Tool resolution item 1: auto-choose');
    expect(format.replace(exception + '\n\n', '').replace(continuous, standard)
      .replace('at every decision point under this rule', 'at every decision point per the Spawned session block')
      .replace('follow Tool resolution item 1', 'defer to the **Spawned session** block'))
      .toBe(generateAskUserFormat({...ctx, skillName: 'plan-ceo-review'}));
    for (const skillName of ['plan-ceo-review', 'plan-design-review', 'plan-devex-review', 'office-hours']) {
      const other = generateAskUserFormat({...ctx, skillName});
      expect(other).toContain(standard);
      expect(other).not.toContain(exception);
      expect(other).not.toContain(continuous);
    }
  }
});
test('the full evaluated bundle routes startup into ordered preparation before scope analysis', () => {
  const input = readWorkflowJudgeInput({root:path.join(import.meta.dir, '..'), skillPath:'plan-eng-review/SKILL.md',
    startMarker:'# Plan Review Mode', endMarker:null});
  expect(input.files.map(file=>file.kind)).toEqual(['entrypoint','section']);
  const entry = input.files[0]!.content, section = input.files[1]!.content;
  const startup = entry.slice(entry.indexOf('**Startup sequence**'), entry.indexOf('## Preamble'));
  expect(startup).toContain('full section Read → **Review preparation** → **Scope Challenge**');
  const preparation = section.slice(section.indexOf('## Review preparation'));
  const stages = ['## Review record and write policy', '## Prior Learnings',
    '## Retrospective learning', '## Confidence Calibration', '## Decision procedure',
    '## Scope Challenge', '## Review Sections'];
  const positions = stages.map(stage=>preparation.indexOf(stage));
  expect(positions.every(position=>position>=0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a,b)=>a-b));
  expect(entry.indexOf('**Format precedence:**')).toBeLessThan(entry.indexOf('## Preamble'));
  expect(entry.slice(entry.indexOf('## Plan Status Footer'))).not.toContain('**Format precedence:**');
  const requiredPath = '~/.claude/skills/gstack/plan-eng-review/sections/review-sections.md';
  expect(entry.slice(entry.indexOf('## Engineering review'),entry.indexOf('## Section self-check'))).toContain(`Read \`${requiredPath}\``);
  expect(entry.slice(entry.indexOf('## Section self-check'))).toContain(`Read \`${requiredPath}\``);
  const policy = section.slice(section.indexOf('## Review record and write policy'), section.indexOf('## Prior Learnings'));
  expectMentions(policy.replace(/\s+/g, ' '), [['no', 'permission', 'authorizes']], 'policy.replace(/\s+/g,  )');
  expect(policy).toContain('| QA Test Plan and task JSONL | Discovery paths below | Present each completely as **not persisted** and continue. |');
  expect(policy).toContain('| Best-effort metadata/learning logs | Helper-defined locations | Skip forbidden writes; otherwise keep their best-effort behavior. |');
  const finish = section.slice(section.indexOf('## Required outputs'), section.indexOf('### Output reference'));
  expect(finish.replace(/\s+/g, ' ')).toMatch(/required log is forbidden, show fields as not persisted and take \*\*Blocked outcome\*\*/i);
  const log = section.slice(section.indexOf('## Review Log'), section.indexOf('## Next Steps'));
  expect(log).toContain("' || exit $?");
  expect(log).toContain("' 2>/dev/null || true");
});

test('both complexity paths join findings at the same thresholds', () => {
  const section = fs.readFileSync(path.join(import.meta.dir, '../plan-eng-review/sections/review-sections.md.tmpl'),'utf8');
  const challenge = section.slice(section.indexOf('## Scope Challenge'),section.indexOf('## Review Sections'));
  const stages = ['### A. Assess the target', '### B. Resolve complexity selectors', '### C. Resolve findings', '1. Present numbered Scope Challenge findings'];
  const positions = stages.map(stage => challenge.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const flat = challenge.replace(/\s+/g, ' ');
  expectMentions(flat, [['stop', 'classes/services', 'section']], 'flat');
  expect(section.replace(/\s+/g, ' ')).toMatch(/unreadable or unverifiable records use \*\*Recovery routing\*\*/i);
});

test('calibration keeps its future hook but no shipped source enables the absent gate', () => {
  const root = path.join(import.meta.dir, '..');
  const section = fs.readFileSync(path.join(root, 'plan-eng-review/sections/review-sections.md.tmpl'),'utf8');
  expect(section.split('{{BRAIN_WRITE_BACK}}')).toHaveLength(2);
  expect(section.indexOf('{{LEARNINGS_LOG}}')).toBeLessThan(section.indexOf('**Calibration gate status:**'));
  const note = section.slice(section.indexOf('**Calibration gate status:**'),section.indexOf('{{BRAIN_WRITE_BACK}}'));
  expect(note).toMatch(/never set it yourself/i);
  const mentions: string[] = [];
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'bin', 'lib', 'scripts'], {cwd: root, encoding: 'utf8', timeout: 30_000})
    .split('\0').filter(Boolean);
  for (const rel of tracked) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (text.includes('BRAIN_CALIBRATION_WRITEBACK')) mentions.push(rel);
    expect(text, `${rel} must not set BRAIN_CALIBRATION_WRITEBACK`).not.toMatch(/BRAIN_CALIBRATION_WRITEBACK[=:]\s*\S|export BRAIN_CALIBRATION_WRITEBACK/);
  }
  expect(mentions).toEqual(['scripts/resolvers/gbrain.ts']);
});
