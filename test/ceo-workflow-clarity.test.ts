import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWorkflowJudgeInput } from './helpers/workflow-judge-input';
import { expectMentions } from './helpers/prompt-structure';

const root = resolve(import.meta.dir, '..');
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const sources = [
  {
    label: 'templates',
    main: readFileSync(resolve(root, 'plan-ceo-review/SKILL.md.tmpl'), 'utf8'),
    section: readFileSync(resolve(root, 'plan-ceo-review/sections/review-sections.md.tmpl'), 'utf8'),
  },
  {
    label: 'actual judge bundle',
    ...(() => {
      const input = readWorkflowJudgeInput({
        root,
        skillPath: 'plan-ceo-review/SKILL.md',
        startMarker: '## Step 0: Nuclear Scope Challenge',
        endMarker: '## Review Sections',
      });
      return {
        main: input.files.find(file => file.kind === 'entrypoint')!.content,
        section: input.files.find(file => file.path === 'plan-ceo-review/sections/review-sections.md')!.content,
      };
    })(),
  },
];

const ordered = (text: string, anchors: string[]) => {
  const positions = anchors.map(anchor => text.indexOf(anchor));
  expect(positions.every(position => position >= 0), `missing one of ${JSON.stringify(anchors)}`).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
};

for (const source of sources) describe(`CEO clarity routing — ${source.label}`, () => {
  const main = compact(source.main);
  const section = compact(source.section);
  const decisions = main.split('### 0D.')[1]!.split('### 0E.')[0]!;
  const mode = main.split('### 0E.')[1]!.split('### 0F.')[0]!;

  test('decision statuses keep pending work unapproved and settle only on exact authority', () => {
    ordered(main, ['**Required choice:**', '**Pending:**', '**Settled:**']);
    expect(main).toMatch(/\*\*Pending:\*\* unapproved/i);
    expect(main).toMatch(/\*\*Settled:\*\*[^*]*a recommendation does not/i);
  });

  test('admin menus return locally while plan decisions run the full approval cycle', () => {
    ordered(decisions, ['**Admin question:**', '**Plan decision:**', '**1. Check sources', '**2. Record the pending choice.**', '**3. Compare and save', '**Pre-question checkpoint:**', '**4. Ask, record the answer', '**Post-answer checkpoint:**']);
    expectMentions(decisions, [['no', 'approves', 'changes']], 'decisions');
    expectMentions(decisions, [['not', 'selection', 'returns']], 'decisions');
    expectMentions(decisions.split('**4. Ask')[1]!.split('**Post-answer checkpoint:**')[0], [['stop', 'actual', 'answer']], 'section');
  });

  test('a mode change waits for an answer and selecting a mode approves nothing', () => {
    const change = mode.split('**Mode change:**')[1]!.split('Selecting a mode')[0]!;
    expectMentions(change, [['ask', 'answered', 'pause']], 'change');
    expectMentions(mode, [['does not', 'selecting', 'approve']], 'mode');
    expect(mode).toContain('| SCOPE EXPANSION / SELECTIVE EXPANSION | 0F → 0G → 0H (including its spec review loop) → 0I |');
    expect(mode).toContain('| HOLD SCOPE | 0G → 0I |');
    expect(mode).toContain('| SCOPE REDUCTION | 0G |');
  });

  test('scope limits and mode recommendations keep their numeric thresholds and route order', () => {
    expect(main).toMatch(/excluding unchanged reuse/i);
    expect(main).toMatch(/neither count approves changes/i);
    ordered(mode, ['For >15 planned changed files', 'If categories overlap or are unclear', 'Otherwise: a new product/system']);
    expect(mode).toMatch(/>15 planned changed files, recommend SCOPE REDUCTION/);
  });

  test('coverage scoring keeps its scale and the completion fraction keeps its format', () => {
    expect(decisions).toContain('**Same work, different coverage:**');
    expect(decisions).toContain('10 = all edge cases, 7 = happy path, 3 = shortcut');
    expectMentions(decisions, [['does not', 'checkpoints', 'approval']], 'decisions');
    expectMentions(section, [['only', 'reopened', 'choice']], 'section');
    expect(section).toContain('Report X/Y, or `N/A` when Y is zero');
  });

  test('section findings check reopening evidence before reusing prior answers', () => {
    const gate = section.split('**Resolve.**')[1]!.split('**Apply.**')[0]!;
    ordered(gate, ['1. This section needs a new choice', '2. An exact prior answer covers it', '3. A non-blocking choice belongs to a later section']);
    expectMentions(gate, [['no', 'selects', 'again']], 'gate');
    const sections = source.section.match(/^### Section \d+:/gm)!.length;
    expect(sections).toBeGreaterThan(0);
    expect(source.section.match(/\*\*Decision gate\.\*\*/g)).toHaveLength(sections);
  });

  test('Section 1 publishes current dispositions, not a second initial mode handoff', () => {
    const opening = section.split('### Section 1: Architecture Review')[1]!.split('Evaluate and diagram:')[0]!;
    expect(opening).toContain('**Current scope**');
    expectMentions(opening, [['do not', 'another', 'handoff']], 'opening');
  });
});
