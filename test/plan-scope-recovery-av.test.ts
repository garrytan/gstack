import {expect, test} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {ALL_HOST_CONFIGS} from '../hosts';
import {generatePreamble} from '../scripts/resolvers/preamble';
import {HOST_PATHS, type TemplateContext} from '../scripts/resolvers/types';
import {nativeSeededPlanSelection} from './helpers/plan-scope-selection';
import {E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, selectTests} from './helpers/touchfiles';
import observedFailures from './fixtures/plan-scope-recovery-av.json';

const skills = ['plan-eng-review', 'plan-design-review'] as const;
const read = (skill: string) => fs.readFileSync(path.join(import.meta.dir, '..', skill, 'SKILL.md.tmpl'), 'utf8');
const recovery = (text: string) => text.split('\n').find(line => line.startsWith('> Before ') && line.includes('publicly identified'))!;

test('the review handoff repairs a missing public declaration without claiming timely compliance', () => {
  for (const skill of skills) {
    const text = read(skill), check = recovery(text);
    expect(check).toBeDefined();
    expect(check).toContain('require resolved scope');
    expect(check).toContain('For plan-mode auto-selection, verify you publicly identified the selected plan for this invocation before review work');
    expect(check).toContain('If missing, send "Scope gate: plan mode — auto-selected B (reviewing <target>)." now');
    expect(check).toContain('do not claim an earlier announcement');
    const start = skill === 'plan-eng-review' ? '### Step 0: Scope Challenge' : '## PRE-REVIEW SYSTEM AUDIT';
    expect(text.indexOf(check)).toBeGreaterThan(text.indexOf('{{PREAMBLE}}'));
    expect(text.indexOf(check)).toBeGreaterThan(text.indexOf(start));
    expect(text.indexOf(check)).toBeLessThan(text.indexOf(skill === 'plan-eng-review' ? 'Before reviewing anything' : 'Before reviewing the plan, gather context'));
  }
});

test('unseeded, explicit-target and early announcement rules remain authoritative on every host', () => {
  for (const skill of skills) {
    const template = read(skill);
    const gate = template.slice(template.indexOf('## Scope gate'), template.indexOf('{{PREAMBLE}}'));
    expect(gate).toContain('After this skill loads, resolve this gate before any tool');
    expect(gate).toContain('Announce plan-mode auto-selection before review tools');
    expect(gate).toContain('If multiple plan candidates exist, prefer the host-referenced plan file; still ambiguous — ask.');
    expect(gate).toContain('If the user explicitly named a DIFFERENT target');
    expect(gate).toContain('If plan mode is indicated but no plan exists yet, ask as normal');
    expect(gate).toContain('When no exception above applied:');
    expect(gate).toContain('First tool call = AskUserQuestion (tool_use). Confirm what to review.');
    expect(gate).toContain('STOP and wait for the answer');
    for (const host of ALL_HOST_CONFIGS) {
      const ctx: TemplateContext = {skillName: skill, tmplPath: `${skill}/SKILL.md.tmpl`, host: host.name,
        paths: HOST_PATHS[host.name]!, preambleTier: 3, interactive: true};
      const expanded = template.replace('{{PREAMBLE}}', generatePreamble(ctx));
      expect(expanded.indexOf('Announce plan-mode auto-selection before review tools')).toBeLessThan(expanded.indexOf('```bash'));
      expect(expanded.indexOf('STOP and wait for the answer')).toBeLessThan(expanded.indexOf('```bash'));
      expect(expanded.indexOf(recovery(template))).toBeGreaterThan(expanded.indexOf('```bash'));
    }
  }
});

test('recorded failures stay intact while fresh unique-draft introductions now bind', () => {
  expect(observedFailures).toHaveLength(4);
  for (const [index, row] of observedFailures.entries()) {
    expect(row.observed.scopeGateAutoSelectObserved).toBe(false);
    expect(nativeSeededPlanSelection(row.transcript as any, row.tools as any, row.opts)).toBe(index !== 0);
    const title = /^#\s+(?:Plan:\s*)?(.+)$/m.exec(row.opts.seed)![1]!;
    const loaded = row.tools.find(tool => tool.kind === 'result')!;
    const timestamp = new Date(Date.parse(loaded.timestamp) + 1).toISOString();
    const message = {sessionId: row.opts.sessionId, timestamp, text: `I'll review "${title}" plan.`};
    const amended = {...row.transcript, assistantMessages: [message]};
    // Explicit synthetic control only: no changed message is paid evidence.
    expect(nativeSeededPlanSelection(amended as any, row.tools as any, row.opts)).toBe(true);
    for (const text of [`> ${message.text}`, `Example:\n${message.text}`, `I'll review "Another plan" plan.`]) {
      expect(nativeSeededPlanSelection({...amended, assistantMessages: [{...message, text}]} as any, row.tools as any, row.opts)).toBe(false);
    }
  }
});

test('regression sources select exactly the union of the two template owners', () => {
  for (const map of [E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES]) {
    const expected = selectTests(skills.map(skill => `${skill}/SKILL.md.tmpl`), map, []).selected;
    for (const file of ['test/plan-scope-recovery-av.test.ts', 'test/fixtures/plan-scope-recovery-av.json']) {
      expect(selectTests([file], map, []).selected).toEqual(expected);
    }
  }
});
