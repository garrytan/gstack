import { describe, expect, test } from 'bun:test';
import { ASK_QUESTIONS_HEADING, ENG_REVIEW_EXCERPT, readWorkflowExcerpt } from './helpers/workflow-excerpt';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { expectMentions } from './helpers/prompt-structure';

function expectOutsideReviewControlFlow(text: string, promptHeading: string): void {
  const ceo = text.includes('**Record the disabled outcome:**');
  const markers = [ceo ? '**Record the disabled outcome:**' : '**Disabled is a terminal branch', promptHeading, '**If `CODEX_MODE: ready`', '\n**Native fallback —'];
  const indices = markers.map(marker => text.indexOf(marker));
  expect(indices.every(index => index >= 0)).toBe(true);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
  const disabled = text.slice(indices[0], indices[1]);
  if (ceo) {
    expect(disabled).toContain('"outside_status":"disabled"');
    expectMentions(disabled.replace(/\s+/g, ' '), [['without', 'invocation', 'agent/task']], 'section');
    expect(disabled).toContain('_DISABLED_REVIEW_MODE=');
    expect(disabled).toContain('if [ "$_DISABLED_REVIEW_MODE" = disabled ]');
  } else {
    expect(disabled).toContain('persist `outside_status: disabled`');
    expect(disabled.replace(/\s+/g, ' ')).toMatch(/do not construct a (?:review prompt|challenge), invoke an outside CLI, dispatch an Agent\/Task fallback/i);
  }
  expect(text.slice(indices[1], indices[2])).toContain('(skip only on `disabled`)');

  const fallback = text.slice(indices[3]);
  if (text.includes('**Outcome routing:**')) {
    expectMentions(fallback.replace(/\s+/g, ' '), [['no', 'immediately', 'replacement']], 'section');
  } else if (ceo) {
    expectMentions(fallback.replace(/\s+/g, ' '), [['do not', 'fallback', 'bounded']], 'section');
  } else {
    expectMentions(fallback, [['never', 'disabled', 'fallback']], 'fallback');
  }
  const dispatch = fallback.indexOf('Dispatch via the Agent tool');
  expect(dispatch).toBeGreaterThan(0);
  const recheck = fallback.slice(0, dispatch).replace(/\s+/g, ' ');
  if (ceo) {
    expectMentions(recheck, [['before', 'immediately', 'preflight']], 'recheck');
    expect(recheck).toMatch(/`CODEX_MODE: disabled`, return to \*\*Record the disabled outcome\*\* without dispatching/i);
  } else if (!text.includes('**Outcome routing:**')) {
    expectMentions(recheck, [['before', 'immediately', 'dispatching']], 'recheck');
    expect(recheck).toContain('`CODEX_MODE: disabled`, finish this section with `outside_status: disabled`;');
    expect(recheck).toMatch(/do not dispatch/i);
  }
  expectMentions(fallback, [['not', 'availability/native', 'completion']], 'fallback');
}

describe('workflow judge excerpts', () => {
  test('expands ship sections in execution order, not alphabetical order', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    const headings = ['## Step 3:', '## Step 4:', '## Step 7:', '## Step 8:', '## Step 9:', '## Step 10:', '## Step 11:', '## Step 11.5:', '## Step 12:', '## Step 13:', '## Step 14:'];
    const indices = headings.map(heading => text.indexOf(heading));
    expect(indices.every(index => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('ship uses project-native commands and never jumps over mandatory gates', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    expect(text).toContain('**Project-native path:**');
    expect(text).not.toMatch(/skipping evals[^\n]*Step 9/);
    const reviewAndTriage = text.slice(text.indexOf('## Step 9:'), text.indexOf('## Step 11:'));
    expect(reviewAndTriage.match(/continue to Step 12/i)).toBeNull();
    expect(text).not.toContain('Steps 4-6:');
    expect(text).toContain('`baseVersion` as `BASE_VERSION`');
    expect(text).not.toContain('GIT_SEQUENCE_EDITOR');
    expect(text).not.toContain("--exec 'true'");
    expect(text).not.toContain('-X ours');
    expect(text).toContain('````text\nYou are running a ship-workflow');
  });

  test('ship review shortcuts retain dedup and fixes repeat the whole review cycle', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    const flat = text.replace(/\s+/g, ' ');
    expect(text).toContain('## Step 9.4: Fix-First and persistence');
    const cycle = flat.slice(flat.indexOf('specialists (9.1)'));
    const order = ['(9.1)', '(9.2)', '(9.2.1)', '(9.3)', '(9.4)'].map(step => cycle.indexOf(step));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(flat).toContain('**Fixes applied below the cap:** Insert Step 5, affected Steps 6–8 and all of Step 9 before the pending Step 10');
    const audit = text.slice(text.indexOf('## Step 7:'), text.indexOf('## Step 8:'));
    expect(audit).not.toContain('Scope Challenge');
    expect(flat).toContain('VERIFY_RESULT stays fail');
  });

  test('ship excerpt preserves readable detours, audit fallback and final input decisions', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules').replace(/\s+/g, ' ');
    expect(text).toContain('`5 → 6 → 7 → 8 → 9 → 10 → 11 → 11.5`');
    expectMentions(text, [['must', 'snapshots', 'three']], 'text');
    expectMentions(text, [['does not', 'failed', 'probes']], 'text');
    expectMentions(text, [['does not', 'coverage', 'bypass']], 'text');
    expectMentions(text, [['only', 'completion', 'audit']], 'text');
    expect(text).toContain('Step 8.1');
    expect(text).toMatch(/Step 9 QA still runs/i);
    expect(text).not.toContain('Every listed change below is metadata:');
    expect(text).not.toContain('No plan file found:** Skip entirely');
  });

  test('a sliced section is not appended again with its generated header', () => {
    const text = readWorkflowExcerpt('plan-design-review/SKILL.md', '## Review Sections', ASK_QUESTIONS_HEADING);
    expect(text.match(/## Review Sections/g)).toHaveLength(1);
    expect(text).not.toMatch(ASK_QUESTIONS_HEADING);
    expect(text).not.toContain('AUTO-GENERATED');
  });

  test('ship publishes existing PRs only after shared body composition and scan', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    const publish = text.slice(text.indexOf('## Step 19:'), text.indexOf('## Step 20:'));
    const compose = publish.indexOf('PR_BODY_FILE=$(mktemp');
    const scan = publish.indexOf('gstack-redact --from-file "$PR_BODY_FILE"');
    const edit = publish.indexOf('gh pr edit --body-file');
    expect(compose).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(compose);
    expect(edit).toBeGreaterThan(scan);
    expect(publish.indexOf('Print the existing URL')).toBeGreaterThan(edit);
    expect(text).not.toContain('Phase 8e.5');
    expectMentions(text, [['never', 'create', 'commit']], 'text');
    const review = text.slice(text.indexOf('## Step 9:'), text.indexOf('## Step 10:'));
    expect(review.indexOf('## Confidence Calibration')).toBeLessThan(review.indexOf('1. Read'));
    const flat = review.replace(/\s+/g, ' ');
    expect(flat).toContain('**No edits in this pass:**');
    expectMentions(flat, [['only', 'continue', 'clears']], 'flat');
    expect(flat).toMatch(/\*\*Dispatched reviewer output missing:\*\* stop\b/i);
    expect(flat).toMatch(/\*\*Third fixing cycle reached \(`CYCLES >= 3`\):\*\* stop\b[^.]*`converged:false`/i);
    expectMentions(flat, [['do not', 'fourth', 'fixing']], 'flat');
    expectMentions(flat, [['block', 'failed/unavailable', 'continuation']], 'flat');
  });

  test('ship approval gates stay outside the subagent prompts', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    for (const [step, next, gate] of [[7, 8, '**7. Coverage gate:**'], [8, 9, '### Gate Logic']] as const) {
      const section = text.slice(text.indexOf(`## Step ${step}:`), text.indexOf(`## Step ${next}:`));
      const prompt = section.match(/````text\n([\s\S]*?)\n````/)![1];
      expect(prompt).not.toContain(gate);
      expect(prompt).not.toContain('Use AskUserQuestion:');
      expect(prompt).not.toContain('commit as');
      expect(section.indexOf(gate)).toBeGreaterThan(section.indexOf('\n````\n'));
    }
    expect(text).toContain('"partial":N,"not_done":N');
    expect(text).toContain('"intentionally dropped"');
  });

  test('expands a body before the end marker in the skeleton', () => {
    const text = readWorkflowExcerpt('document-release/SKILL.md', '# Document Release:', '## Important Rules');
    expect(text).toContain('## Step 2:');
    expect(text).toContain('## Step 9:');
  });

  test('documentation review precedes publication and keeps changelog protection', () => {
    const text = readWorkflowExcerpt('document-release/SKILL.md', '# Document Release:', '## Important Rules');
    expect(text).toContain('DOC_DIFF_BASE=$(git merge-base origin/<base> HEAD 2>/dev/null || git merge-base <base> HEAD) || exit 1');
    const reviewStart = text.indexOf('## Codex Documentation Review');
    const commit = text.indexOf('## Step 9:');
    expect(reviewStart).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(reviewStart);
    const review = text.slice(reviewStart, commit);
    expectOutsideReviewControlFlow(review, '**Construct the doc-review prompt**');
    for (const token of ['`status: unavailable`', '`outside_status: unavailable`', '`source: none`']) expect(review).toContain(token);
    expect(review).toMatch(/AskUserQuestion once/i);
    expect(review).toMatch(/on A or per-finding approvals/i);
    expect(text).toContain('Step 9 then commits');
    expect(text).toMatch(/needs?\s+attention,?\s+not\s+replacement/i);
    expect(text).not.toContain('Flag and rewrite');
    expect(text).toMatch(/if VERSION is absent, use the completion date only/i);
  });

  test('Eng preparation and decision procedure precede the four review sections', async () => {
    const { marked } = await import('marked');
    const { skillPath, startMarker, endMarker } = ENG_REVIEW_EXCERPT;
    const eng = readWorkflowExcerpt(skillPath, startMarker, endMarker);
    const stages = ['## Review preparation', '## Retrospective learning', '## Confidence Calibration', '## Decision procedure',
      '### Prepare an unanswered choice', '## Scope Challenge', '### A. Assess the target',
      '### B. Resolve complexity selectors', '### C. Resolve findings', '## Review Sections',
      '### 1. Architecture review', '### 2. Code quality review', '### 3. Test review', '### 4. Performance review']
      .map(heading => eng.indexOf(heading));
    expect(stages.every(index => index >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(eng.match(/^## Decision procedure$/gm)).toHaveLength(1);
    const procedure = eng.slice(eng.indexOf('## Decision procedure'), eng.indexOf('## Scope Challenge'));
    const headings = marked.lexer(procedure).filter(token => token.type === 'heading' && token.depth === 3);
    expect(headings.map(token => token.text)).toEqual(['Prepare an unanswered choice', 'Send once and wait', 'Record the answer']);
    expect(procedure).toContain("**Pending-record checkpoint.**");
    expect(procedure).toContain('### Send once and wait');
    expect(procedure).toContain("### Record the answer");
    const outputs = ['### TODOS.md updates', '## Approval readiness', '## Required outputs', '## Implementation Tasks',
      '### Unresolved decisions', '### Completion summary', '## Plan File Review Report',
      '### Write to the report file', '## Review Log'].map(heading => eng.indexOf(heading));
    expect(outputs.every(index => index > stages[stages.length - 1]!)).toBe(true);
    expect(outputs).toEqual([...outputs].sort((a, b) => a - b));
  });

  test('CEO mode handoff precedes its route and spec review stays within persistence', () => {
    const ceo = readWorkflowExcerpt('plan-ceo-review/SKILL.md', '## Step 0: Nuclear Scope Challenge', '## Review Sections');
    const positions = ['### 0D.', '### 0E. Mode Selection', '**Mode handoff:**',
      'Follow the selected mode\'s route:', '### 0F.', '### 0G. Mode-Specific Analysis',
      '### 0H.', '#### Spec Review Loop', '### 0I. Temporal Interrogation']
      .map(heading => ceo.indexOf(heading));
    expect(positions.every(index => index >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const persistence = ceo.slice(positions[6], positions[8]);
    expect(persistence.match(/^#### Spec Review Loop$/gm)).toHaveLength(1);
    expect(persistence).not.toMatch(/^## Spec Review Loop$/m);
    expect(ceo.slice(positions[2], positions[3])).toContain('Auto-decided review mode → <selected mode> (your preference)');
    expect(ceo.slice(positions[2], positions[3])).toContain('Mode: <selected mode>; approved decisions: <rows or none>');
  });

  test('CEO Step 0 headings follow their sequential execution labels', () => {
    const ceo = readWorkflowExcerpt('plan-ceo-review/SKILL.md', '## Step 0: Nuclear Scope Challenge', '## Review Sections');
    const labels = [...ceo.matchAll(/^### (0[A-Z](?:-[A-Za-z]+)?)\. /gm)].map(match => match[1]);
    expect(labels).toEqual(['0A', '0B', '0C', '0D', '0E', '0F', '0G', '0H', '0I']);
  });

  test('CEO capture locates Mode Selection by name for current and frozen skill copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-semantic-capture-'));
    const helper = join(import.meta.dir, 'helpers', 'auq-sdk-capture.ts');
    const runner = join(import.meta.dir, 'helpers', 'agent-sdk-runner.ts');
    const script = join(dir, 'capture.ts');
    writeFileSync(script, `import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const calls = [];
mock.module(${JSON.stringify(runner)}, () => ({resolveClaudeBinary:()=>'/fixture/claude',runAgentSdkTest: async options => {
  calls.push(options);
  void options.canUseTool('AskUserQuestion', {questions:[{header:'Mode',question:'captured mode choice',
    options:['SCOPE EXPANSION','SELECTIVE EXPANSION','HOLD SCOPE','SCOPE REDUCTION'].map(label=>({label,description:''}))}]},
    {toolUseID:'native-mode',signal:options.signal});
  options.signal.throwIfAborted();
  throw Error('capture failed to stop before answering');
}}));
const {captureModeSelectionAuq, verboseSkill} = await import(${JSON.stringify(helper)});
const current = fs.readFileSync(${JSON.stringify(join(import.meta.dir, '..', 'plan-ceo-review', 'SKILL.md'))}, 'utf8');
const results = [];
for (const [variant, skill] of [['current', current], ['frozen', verboseSkill()]]) {
  const planDir = path.join(${JSON.stringify(dir)}, variant);
  fs.mkdirSync(path.join(planDir, 'plan-ceo-review'), {recursive:true});
  fs.writeFileSync(path.join(planDir, 'plan-ceo-review', 'SKILL.md'), skill);
  fs.writeFileSync(path.join(planDir, 'plan.md'), 'Review this plan.');
  results.push({variant, heading:skill.match(/^### (0[A-Z])\\. Mode Selection/m)?.[1],
    captured:await captureModeSelectionAuq({planDir, testName:'free-semantic-capture', model:'fake-model'})});
}
console.log(JSON.stringify({calls, results}));
`);
    try {
      const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
      expect(child.status, `${child.error ?? ''}\n${child.stderr}`).toBe(0);
      const { calls, results } = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
      expect(results).toEqual([
        { variant: 'current', heading: expect.stringMatching(/^0[A-Z]$/), captured: expect.stringContaining('captured mode choice') },
        { variant: 'frozen', heading: '0F', captured: expect.stringContaining('captured mode choice') },
      ]);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.userPrompt).toContain('Proceed to Mode Selection,');
        expect(call.userPrompt).not.toMatch(/Step 0[A-Z]/);
        expect(call.userPrompt).toContain(join(call.workingDirectory, 'plan-ceo-review', 'SKILL.md'));
        expect(call.userPrompt).toMatch(/read any other SKILL\.md/i);
        expectMentions(call.userPrompt, [['wait', 'askuserquestion', 'answer']], 'call.userPrompt');
        expect(call).toMatchObject({ allowedTools: ['Read', 'Write', 'AskUserQuestion'], maxTurns: 12, maxRetries: 0, model: 'fake-model' });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('Eng LLM scope and pending decisions precede the test artifact', () => {
    const eng = readWorkflowExcerpt('plan-eng-review/SKILL.md', '## Scope gate', '## Section self-check');
    const tests = eng.slice(eng.indexOf('### 3. Test review'), eng.indexOf('### 4. Performance review'));
    const scope = tests.indexOf('### LLM/eval scope');
    const decisions = tests.indexOf('**Step 5. Add missing tests to the plan:**');
    const stop = decisions + tests.slice(decisions).search(/stop for each pending decision/i);
    const artifact = tests.indexOf('### Test Plan Artifact');
    expect(0 <= scope && scope < decisions && decisions < stop && stop < artifact).toBe(true);
    expect(tests.match(/For LLM\/prompt changes:/g)).toHaveLength(1);
    const fastPath = tests.slice(tests.indexOf('**Fast path:**'), scope);
    expect(fastPath).toMatch(/still check LLM\/eval scope/i);
  });

  test('plan review evidence and design approval rules precede their use', () => {
    const eng = readWorkflowExcerpt('plan-eng-review/SKILL.md', '## Scope gate', '## Section self-check');
    expect(eng.indexOf('## Confidence Calibration')).toBeLessThan(eng.indexOf('### 1. Architecture review'));
    expectOutsideReviewControlFlow(eng, '**Construct the plan review prompt**');
    expect(eng).toMatch(/evidence, not approval/i);
    const pendingDecision = eng.slice(eng.indexOf('### Send once and wait'), eng.indexOf("### Record the answer"));
    expectMentions(pendingDecision, [['stop', 'arrives', 'actual']], 'pendingDecision');
    expectMentions(pendingDecision.replace(/\s+/g, ' '), [['do not', 'exitplanmode', 'another']], 'section');
    expectMentions(eng.replace(/\s+/g, ' '), [['only', 'working-plan', 'authorized']], 'section');
    const design = readWorkflowExcerpt('plan-design-review/SKILL.md', '## Review Sections', ASK_QUESTIONS_HEADING);
    expectMentions(design, [['wait', 'approval', 'edit']], 'design');
    const pass4 = design.slice(design.indexOf('### Pass 4:'), design.indexOf('### Pass 5:'));
    expect(pass4.match(/^### /gm)).toHaveLength(1);
    expect(pass4).toMatch(/^#### Design Hard Rules$/m);
    expect(pass4.indexOf('**Pass 4 evaluation:**')).toBeLessThan(pass4.indexOf('\n#### Design Hard Rules'));
    expect(pass4.indexOf('#### Design Hard Rules')).toBeLessThan(pass4.indexOf('FIX TO 10:'));
    expect(pass4).toContain('caps this pass below 8');
  });

  test('fails closed for missing excerpt markers', () => {
    expect(() => readWorkflowExcerpt('ship/SKILL.md', '# missing', null)).toThrow('Start marker not found');
    expect(() => readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '# missing')).toThrow('End marker not found');
  });

  test('retro judge includes compare semantics and unambiguous report inputs', () => {
    const text = readWorkflowExcerpt('retro/SKILL.md', '## Instructions', '## Tone');
    expect(text).toContain('## Compare Mode');
    expectMentions(text, [['before', 'current', 'second']], 'text');
    expect(text).toContain('prs_merged: null');
    expect(text).toContain('`streak_days`');
    expect(text).toContain('### Shipping Streaks');
    expect(text).toContain('### Shortcut Debt');
    expect(text.indexOf('## Capture Learnings')).toBeGreaterThan(text.indexOf('### Step 14:'));
    expect(text).not.toContain('$(date');
    expect(text.match(/today="<today>"/g)).toHaveLength(2);
    const judge = readFileSync(join(import.meta.dir, 'skill-llm-eval.test.ts'), 'utf8');
    expect(judge).toMatch(/skillPath: 'retro\/SKILL.md',[\s\S]*?endMarker: '## Tone'/);
  });

  test('deploy gates and navigation timing formulas are executable as documented', () => {
    const land = readFileSync(join(import.meta.dir, '../land-and-deploy/SKILL.md.tmpl'), 'utf8');
    expect(land).not.toContain('Skip Step 3, go to Step 4');
    expectMentions(land, [['before', 'continue', 'merging']], 'land');
    const benchmark = readFileSync(join(import.meta.dir, '../benchmark/SKILL.md.tmpl'), 'utf8');
    const timings = { startTime: 0, domInteractive: 600, domComplete: 1200, loadEventEnd: 1400 };
    for (const [label, expected] of [['DOM Interactive', 600], ['DOM Complete', 1200], ['Full Load', 1400]] as const) {
      const formula = benchmark.match(new RegExp(`\\*\\*${label}\\*\\*: \x60([^\x60]+)\x60`))![1];
      const actual = new Function(...Object.keys(timings), `return ${formula}`)(...Object.values(timings));
      expect(actual).toBe(expected);
    }
  });

  test('ship commits logical chunks without rewriting existing checkpoint commits', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    const commit = text.slice(text.indexOf('## Step 15:'), text.indexOf('## Step 16:'));
    expect(commit).toMatch(/bisectable commits/i);
    expect(commit).toContain('continue to Step 16');
    expect(commit).not.toMatch(/rebase|reset|squash|fixup|WIP_TODO|gstack-context/);
    expect(text).not.toContain('Step 15.0');
  });
});
