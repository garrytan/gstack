import { describe, expect, test } from 'bun:test';
import { ENG_REVIEW_EXCERPT, readWorkflowExcerpt } from './helpers/workflow-excerpt';
import { LLM_JUDGE_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

function expectOutsideReviewControlFlow(text: string, promptHeading: string): void {
  const ceo = text.includes('**Record the disabled outcome:**');
  const markers = [ceo ? '**Record the disabled outcome:**' : '**Disabled is a terminal branch', promptHeading, '**If `CODEX_MODE: ready`', '\n**Native fallback —'];
  const indices = markers.map(marker => text.indexOf(marker));
  expect(indices.every(index => index >= 0)).toBe(true);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
  const disabled = text.slice(indices[0], indices[1]);
  if (ceo) {
    expect(disabled).toContain('"outside_status":"disabled"');
    expect(disabled.replace(/\s+/g, ' ')).toContain('without a challenge, CLI invocation, Agent/Task fallback or questions about outside findings');
    expect(disabled).toContain('_DISABLED_REVIEW_MODE=');
    expect(disabled).toContain('if [ "$_DISABLED_REVIEW_MODE" = disabled ]');
  } else {
    expect(disabled).toContain('persist `outside_status: disabled`');
    expect(disabled.replace(/\s+/g, ' ')).toMatch(/Do not construct a (?:review prompt|challenge), invoke an outside CLI, dispatch an Agent\/Task fallback/);
  }
  expect(text.slice(indices[1], indices[2])).toContain('(skip only on `disabled`)');

  const fallback = text.slice(indices[3]);
  if (text.includes('**Outcome routing:**')) {
    const routing = text.slice(text.indexOf('**Outcome routing:**'), indices[0]);
    expect(routing).toContain('Other preflight mode, including harness mismatch');
    expect(routing).toContain('Outside execution or output validation fails');
    expect(routing).toContain('Retain its output and diagnosis, finish termination, then use Native fallback');
    expect(routing).toContain('No prompt, outside process or native replacement');
    expect(fallback.replace(/\s+/g, ' ')).toContain('Immediately before dispatch, check the preflight result again: disabled means no replacement');
  } else if (ceo) {
    expect(fallback.replace(/\s+/g, ' ')).toContain('Other preflight failures retain their printed diagnosis, including harness mismatch');
    expect(fallback.replace(/\s+/g, ' ')).toContain('These failures do not block the review; they use the bounded fallback below');
  } else {
    expect(fallback).toContain('The disabled branch never reaches this fallback.');
    expect(fallback.replace(/\s+/g, ' ')).toMatch(/Otherwise, use this fallback for missing\/broken CLI, failed authentication\/model selection, a failed preflight(?: \(including harness mismatch\))?, or a failed outside invocation\./);
  }
  const dispatch = fallback.indexOf('Dispatch via the Agent tool');
  expect(dispatch).toBeGreaterThan(0);
  const recheck = fallback.slice(0, dispatch);
  if (ceo) {
    expect(recheck.replace(/\s+/g, ' ')).toContain('Immediately before dispatch, recheck the preflight result');
    expect(recheck.replace(/\s+/g, ' ')).toContain('`CODEX_MODE: disabled`, return to **Record the disabled outcome** without dispatching');
  } else if (!text.includes('**Outcome routing:**')) {
    expect(recheck).toContain('Immediately before dispatching, check the preflight result again.');
    expect(recheck).toContain('`CODEX_MODE: disabled`, finish this section with `outside_status: disabled`;');
    expect(recheck).toContain('do not dispatch.');
  }
  expect(fallback).toContain('Availability/native fallback is not outside completion.');
}

describe('workflow judge excerpts', () => {
  test('helper changes select all dependent workflow judges', () => {
    const selected = selectTests(['test/helpers/workflow-excerpt.ts'], LLM_JUDGE_TOUCHFILES, []).selected;
    expect(selected).toHaveLength(14);
    expect(selected).toContain('ship/SKILL.md workflow');
    expect(selected).toContain('plan-design-review/SKILL.md passes');
  });

  test('expands ship sections in execution order, not alphabetical order', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    const headings = ['## Step 3:', '## Step 4:', '## Step 7:', '## Step 8:', '## Step 9:', '## Step 10:', '## Step 11:', '## Step 12:', '## Step 13:', '## Step 14:'];
    const indices = headings.map(heading => text.indexOf(heading));
    expect(indices.every(index => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('ship uses project-native commands and never jumps over mandatory gates', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    expect(text).toContain("Use the project's test commands discovered in Step 4");
    expect(text).toContain("Use the project's documented eval selection");
    expect(text).not.toMatch(/skipping evals[^\n]*Step 9/);
    const reviewAndTriage = text.slice(text.indexOf('## Step 9:'), text.indexOf('## Step 11:'));
    expect(reviewAndTriage.match(/continue to Step 12/i)).toBeNull();
    expect(text).not.toContain('Steps 4-6:');
    expect(text).toContain('During pre-flight, read the existing review log');
    expect(text).toContain('Save the JSON `baseVersion` as `BASE_VERSION`');
    expect(text).toContain("GIT_SEQUENCE_EDITOR='cp");
    expect(text).not.toContain("--exec 'true'");
    expect(text).not.toContain('-X ours');
    expect(text).toContain('````text\nYou are running a ship-workflow');
  });

  test('a sliced section is not appended again with its generated header', () => {
    const text = readWorkflowExcerpt('plan-design-review/SKILL.md', '## Review Sections', '## CRITICAL RULE');
    expect(text.match(/## Review Sections/g)).toHaveLength(1);
    expect(text).not.toContain('## CRITICAL RULE');
    expect(text).not.toContain('AUTO-GENERATED');
  });

  test('ship publishes existing PRs only after shared body composition and scan', () => {
    const text = readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
    const publish = text.slice(text.indexOf('## Step 19:'), text.indexOf('## Step 20:'));
    const compose = publish.indexOf('PR_BODY_FILE=$(mktemp)');
    const scan = publish.indexOf('gstack-redact --from-file "$PR_BODY_FILE"');
    const edit = publish.indexOf('gh pr edit --body-file');
    expect(compose).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(compose);
    expect(edit).toBeGreaterThan(scan);
    expect(publish.indexOf('Print the existing URL')).toBeGreaterThan(edit);
    expect(text).not.toContain('Phase 8e.5');
    expect(text).toContain('never create an empty commit');
    const review = text.slice(text.indexOf('## Step 9:'), text.indexOf('## Step 10:'));
    expect(review.indexOf('## Confidence Calibration')).toBeLessThan(review.indexOf('1. Read'));
    expect(review).toContain('only continue to Step 10 after item 9');
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
    expect(text).toContain('each Y response\'s evidence and each D response\'s dropped item');
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
    expect(review).toContain('Skip the apply gate, persist `status: unavailable`, `outside_status: unavailable`, and `source: none`');
    expect(review).toContain('present the findings, then use AskUserQuestion ONCE:');
    expect(review).toContain('On A or per-finding approvals, make the approved edits yourself');
    expect(text).toContain('Step 9 then commits and pushes those edits');
    expect(text).toContain('Entries scoring <2 need attention, not replacement');
    expect(text).not.toContain('Flag and rewrite');
    expect(text).toContain('if VERSION is absent, use the completion date only');
  });

  test('Eng preparation and decision procedure precede the four review sections', async () => {
    const { marked } = await import('marked');
    const { skillPath, startMarker, endMarker } = ENG_REVIEW_EXCERPT;
    const eng = readWorkflowExcerpt(skillPath, startMarker, endMarker);
    const stages = ['## Review preparation', '## Retrospective learning', '## Confidence Calibration', '## Decision procedure',
      '### 1. Establish current state', '## Review Sections',
      '### 1. Architecture review', '### 2. Code quality review', '### 3. Test review', '### 4. Performance review']
      .map(heading => eng.indexOf(heading));
    expect(stages.every(index => index >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(eng.match(/^## Decision procedure$/gm)).toHaveLength(1);
    const procedure = eng.slice(eng.indexOf('## Decision procedure'), eng.indexOf('## Review Sections'));
    const headings = marked.lexer(procedure).filter(token => token.type === 'heading' && token.depth === 3);
    expect(headings.map(token => token.text)).toEqual(['1. Establish current state', '2. Separate independent choices', '3. Compare one choice',
      '4. Save the pending record', '5. Ask and wait', '6. Apply and refresh']);
    expect(procedure).toContain("### 4. Save the pending record");
    expect(procedure).toContain('### 5. Ask and wait');
    expect(procedure).toContain("### 6. Apply and refresh");
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
    const runner = join(import.meta.dir, 'helpers', 'session-runner.ts');
    const script = join(dir, 'capture.ts');
    writeFileSync(script, `import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const calls = [];
mock.module(${JSON.stringify(runner)}, () => ({runSkillTest: async options => {
  calls.push(options);
  fs.writeFileSync(path.join(options.workingDirectory, 'ask-capture.md'), 'captured mode choice');
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
        { variant: 'current', heading: expect.stringMatching(/^0[A-Z]$/), captured: 'captured mode choice' },
        { variant: 'frozen', heading: '0F', captured: 'captured mode choice' },
      ]);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.prompt).toContain('Proceed to Mode Selection,');
        expect(call.prompt).not.toMatch(/Step 0[A-Z]/);
        expect(call.prompt).toContain(join(call.workingDirectory, 'plan-ceo-review', 'SKILL.md'));
        expect(call.prompt).toContain('Do NOT search for, Glob, find, or read any OTHER SKILL.md');
        expect(call).toMatchObject({ allowedTools: ['Read', 'Write'], maxTurns: 12, timeout: 240_000, model: 'fake-model' });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('Eng LLM scope and pending decisions precede the test artifact', () => {
    const eng = readWorkflowExcerpt('plan-eng-review/SKILL.md', '## Scope gate', '## Section self-check');
    const tests = eng.slice(eng.indexOf('### 3. Test review'), eng.indexOf('### 4. Performance review'));
    const scope = tests.indexOf('### LLM/eval scope');
    const decisions = tests.indexOf('**Step 5. Add missing tests to the plan:**');
    const stop = tests.indexOf("**STOP for each pending decision.**", decisions);
    const artifact = tests.indexOf('### Test Plan Artifact');
    expect(0 <= scope && scope < decisions && decisions < stop && stop < artifact).toBe(true);
    expect(tests.match(/For LLM\/prompt changes:/g)).toHaveLength(1);
    expect(tests.slice(artifact)).not.toContain("**STOP for each pending decision.**");
    const fastPath = tests.slice(tests.indexOf('**Fast path:**'), scope);
    expect(fastPath).toContain('Still check LLM/eval scope and produce the Test Plan Artifact');
  });

  test('plan review evidence and design approval rules precede their use', () => {
    const eng = readWorkflowExcerpt('plan-eng-review/SKILL.md', '## Scope gate', '## Section self-check');
    expect(eng.indexOf('## Confidence Calibration')).toBeLessThan(eng.indexOf('### 1. Architecture review'));
    expect(eng).toContain('quote the motivating plan requirement');
    expectOutsideReviewControlFlow(eng, '**Construct the plan review prompt**');
    expect(eng).toContain('Agreement between reviewers is evidence, not approval');
    expect(eng).toContain('new or reopened choices still need their own answers');
    const pendingDecision = eng.slice(eng.indexOf('### 5. Ask and wait'), eng.indexOf("### 6. Apply and refresh"));
    expect(pendingDecision).toContain("**STOP until the actual answer arrives.**");
    expect(pendingDecision.replace(/\s+/g, ' ')).toContain("Do not apply a remedy, make another call, start the next section or call ExitPlanMode while the choice awaits an answer");
    expect(eng.replace(/\s+/g, ' ')).toContain("Use a scoped Edit to save this record and only the authorized working-plan amendments. Leave other choices unchanged");
    const design = readWorkflowExcerpt('plan-design-review/SKILL.md', '## Review Sections', '## CRITICAL RULE');
    expect(design).toContain('wait for approval, then edit the plan and re-rate');
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
    expect(text).toContain('does not require saved history');
    expect(text).toContain('one second before the current start');
    expect(text).toContain('PRs referenced');
    expect(text).toContain('prs_merged: null');
    expect(text).toContain('not newly added test cases');
    expect(text).toContain('`streak_days` is the live **team** streak');
    expect(text).toContain('draft the tweetable summary using the format in Step 14, then save');
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
    expect(land).toContain('continue to Step 3.4, then Step 3.5 before merging');
    const benchmark = readFileSync(join(import.meta.dir, '../benchmark/SKILL.md.tmpl'), 'utf8');
    const timings = { startTime: 0, domInteractive: 600, domComplete: 1200, loadEventEnd: 1400 };
    for (const [label, expected] of [['DOM Interactive', 600], ['DOM Complete', 1200], ['Full Load', 1400]] as const) {
      const formula = benchmark.match(new RegExp(`\\*\\*${label}\\*\\*: \x60([^\x60]+)\x60`))![1];
      const actual = new Function(...Object.keys(timings), `return ${formula}`)(...Object.values(timings));
      expect(actual).toBe(expected);
    }
  });

  test('WIP squash example consumes the prepared todo and preserves file contents', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-wip-example-'));
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
      if (result.status !== 0) throw new Error(result.stderr || String(result.error));
      return result.stdout.trim();
    };
    try {
      git('init', '-b', 'main');
      writeFileSync(join(cwd, 'file'), 'base\n');
      git('add', 'file');
      git('commit', '-m', 'base');
      git('switch', '-c', 'feature');
      for (const message of ['logical change', 'WIP: finish change', 'other logical change']) {
        writeFileSync(join(cwd, 'file'), message + '\n');
        git('commit', '-am', message);
      }
      const commits = git('rev-list', '--reverse', 'main..HEAD').split('\n');
      const todo = join(cwd, '.git', 'prepared-todo');
      writeFileSync(todo, commits.map((sha, i) => `${i === 1 ? 'fixup' : 'pick'} ${sha}`).join('\n') + '\n');
      const source = readFileSync(join(import.meta.dir, '../ship/SKILL.md.tmpl'), 'utf8');
      const snippet = source.match(/```bash\n(export WIP_TODO=[\s\S]*?)\n```/)![1]
        .replace('<absolute path to prepared todo>', todo).replaceAll('origin/<base>', 'main');
      const originalTree = git('rev-parse', 'HEAD^{tree}');
      const result = spawnSync('bash', ['-c', snippet], { cwd, env, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-list', '--count', 'main..HEAD')).toBe('2');
      expect(git('rev-parse', 'HEAD^{tree}')).toBe(originalTree);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
