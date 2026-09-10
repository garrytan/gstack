import { describe, expect, test } from 'bun:test';
import { readWorkflowExcerpt } from './helpers/workflow-excerpt';
import { LLM_JUDGE_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

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
    expect(text.indexOf('## Codex Documentation Review')).toBeLessThan(text.indexOf('## Step 9:'));
    expect(text).toContain('no in-host substitute is defined here');
    expect(text).toContain('all Claude fallback modes');
    expect(text).toContain('Step 9 then commits and pushes those edits');
    expect(text).toContain('Entries scoring <2 need attention, not replacement');
    expect(text).not.toContain('Flag and rewrite');
    expect(text).toContain('if VERSION is absent, use the completion date only');
  });

  test('plan review evidence and design approval rules precede their use', () => {
    const eng = readWorkflowExcerpt('plan-eng-review/SKILL.md', '## Review Sections', '## CRITICAL RULE');
    expect(eng.indexOf('## Confidence Calibration')).toBeLessThan(eng.indexOf('### 1. Architecture review'));
    expect(eng).toContain('quote the motivating plan requirement');
    expect(eng).toContain('including all Claude fallback modes');
    expect(eng).toContain('no in-host substitute is defined here');
    const design = readWorkflowExcerpt('plan-design-review/SKILL.md', '## Review Sections', '## CRITICAL RULE');
    expect(design).toContain('wait for approval, then edit the plan and re-rate');
    const pass4 = design.slice(design.indexOf('### Pass 4:'), design.indexOf('### Pass 5:'));
    expect(pass4.indexOf('### Design Hard Rules')).toBeLessThan(pass4.indexOf('FIX TO 10:'));
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
