import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { disabledPlanReviewEvidence, installDisabledPlanReviewFixture } from './helpers/disabled-plan-review-fixture';

const ROOT = resolve(import.meta.dir, '..');
const TEMP = mkdtempSync(join(tmpdir(), 'gstack-disabled-plan-oracle-'));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function completed() {
  return {
    exitReason: 'success', output: 'Outside review: disabled (codex_reviews disabled). Native review complete.',
    transcript: [
      { type: 'system', subtype: 'init', tools: ['Bash', 'Read', 'Write', 'Agent'] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'preflight', name: 'Bash', input: { command: './runtime/bin/gstack-config get codex_reviews; echo "CODEX_MODE: $_CODEX_MODE"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'preflight', content: 'CODEX_MODE: disabled\n' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Outside review: disabled.' },
    ] as any[],
  };
}

function dispatch(name: string, input: Record<string, string>) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'forbidden', name, input }] } };
}

const PRIOR_RECORD = {
  skill: 'codex-plan-review', timestamp: '2026-09-08T00:00:00Z', status: 'clean',
  source: 'codex', host: 'claude', outside_provider: 'codex', outside_status: 'completed', phase: 'plan-review',
};
const disabledRecord = () => ({ ...PRIOR_RECORD, timestamp: '2026-09-08T00:00:01Z', status: 'skipped', source: 'none', outside_status: 'disabled' });
function oracle(result: ReturnType<typeof completed>, cliDispatchLog = '') {
  return disabledPlanReviewEvidence(result, cliDispatchLog, [PRIOR_RECORD, disabledRecord()].map(record => JSON.stringify(record)).join('\n'), PRIOR_RECORD);
}

describe('disabled outside-plan live oracle', () => {
  test('requires a real disabled preflight with Agent available and valid completion', () => {
    expect(oracle(completed(), '').passed).toBe(true);
  });
  test('captured native init exposes the requested subagent as Task on Claude Code 2.1.257', () => {
    const result = completed();
    // G's actual init canonicalized the requested Agent tool to Task.
    result.transcript[0] = {
      type: 'system', subtype: 'init',
      tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Write'],
      model: 'claude-sonnet-4-6', claude_code_version: '2.1.257',
    };
    expect(oracle(result)).toMatchObject({ passed: true, completed: true,
      agentAvailable: true, persistedDisabled: true, fallbackCalls: [] });
  });
  test('unknown, malformed and lookalike tools do not establish subagent availability', () => {
    for (const tools of [undefined, null, 'Agent', {}, [], ['Bash', 'Read'],
      ['AgentTool'], ['TaskCreate', 'TaskList', 'TaskOutput', 'TaskStop'],
      ['agent', 'task'], ['mcp__custom__Agent'], [{ name: 'Agent' }]]) {
      const result = completed(); result.transcript[0].tools = tools;
      expect(oracle(result)).toMatchObject({ passed: false, agentAvailable: false });
    }
  });
  test('subagent availability must come from the native system init', () => {
    for (const init of [
      { type: 'assistant', subtype: 'init', tools: ['Task'] },
      { type: 'system', subtype: 'other', tools: ['Agent'] },
      { type: 'system', subtype: 'init' },
    ]) {
      const result = completed(); result.transcript[0] = init;
      expect(oracle(result)).toMatchObject({ passed: false, agentAvailable: false });
    }
    const result = completed(); result.transcript.shift();
    expect(oracle(result)).toMatchObject({ passed: false, agentAvailable: false });
  });
  test('claimed disabled status without matching successful tool evidence cannot pass', () => {
    for (const mutate of [
      (r: ReturnType<typeof completed>) => { r.transcript.splice(1, 2); },
      (r: ReturnType<typeof completed>) => { r.transcript[2].message.content[0].tool_use_id = 'unrelated'; },
      (r: ReturnType<typeof completed>) => { r.transcript[2].message.content[0].is_error = true; },
      (r: ReturnType<typeof completed>) => { r.transcript[1].message.content[0].input.command = 'cat OUTSIDE-PLAN.md'; },
    ]) {
      const result = completed(); mutate(result);
      expect(oracle(result, '').passed).toBe(false);
    }
  });
  test('missing Agent availability cannot make a no-fallback result pass', () => {
    const result = completed(); result.transcript[0].tools = ['Bash', 'Read'];
    expect(oracle(result, '').passed).toBe(false);
  });
  test('empty, malformed, unsuccessful and timed-out completions cannot pass', () => {
    for (const mutate of [
      (r: ReturnType<typeof completed>) => { r.transcript.pop(); },
      (r: ReturnType<typeof completed>) => { r.transcript.at(-1).is_error = true; },
      (r: ReturnType<typeof completed>) => { r.transcript.at(-1).result = ''; },
      (r: ReturnType<typeof completed>) => { r.transcript.at(-1).result = {}; },
      (r: ReturnType<typeof completed>) => { r.transcript.at(-1).subtype = 'error_max_turns'; },
      (r: ReturnType<typeof completed>) => { r.exitReason = 'timeout'; },
    ]) {
      const result = completed(); mutate(result);
      expect(oracle(result, '').passed).toBe(false);
    }
  });
  test('Agent/Task fallback dispatch fails even when the parent reports disabled', () => {
    for (const available of ['Agent', 'Task']) for (const tool of ['Agent', 'Task']) {
      const result = completed(); result.transcript[0].tools = ['Bash', 'Read', available];
      result.transcript.splice(-1, 0, dispatch(tool, { prompt: 'Review the plan independently' }));
      const evidence = oracle(result, '');
      expect(evidence.agentAvailable).toBe(true);
      expect(evidence.passed).toBe(false);
      expect(evidence.fallbackCalls).toHaveLength(1);
    }
  });
  test('an observed outside CLI invocation fails even when the parent reports disabled', () => {
    expect(oracle(completed(), 'codex invoked\n').passed).toBe(false);
  });
  test('an unexecuted outside branch in a combined Bash block is not dispatch evidence', () => {
    const result = completed();
    result.transcript[1].message.content[0].input.command = './runtime/bin/gstack-config get codex_reviews; echo "CODEX_MODE: disabled"; if [ "$mode" != disabled ]; then codex exec --json -; fi';
    const evidence = oracle(result, '');
    expect(evidence.passed).toBe(true);
    expect(evidence.outsideCommandMentions).toHaveLength(1);
  });
  test('requires a new persisted disabled record after the preserved completed record', () => {
    for (const records of [
      [], [PRIOR_RECORD], [disabledRecord()],
      [PRIOR_RECORD, { ...disabledRecord(), status: 'clean' }],
      [PRIOR_RECORD, { ...disabledRecord(), source: 'codex' }],
      [PRIOR_RECORD, { ...disabledRecord(), host: 'codex' }],
      [PRIOR_RECORD, { ...disabledRecord(), outside_provider: 'claude-code' }],
      [PRIOR_RECORD, { ...disabledRecord(), outside_status: 'completed' }],
      [PRIOR_RECORD, { ...disabledRecord(), phase: 'documentation' }],
      [PRIOR_RECORD, { ...disabledRecord(), timestamp: PRIOR_RECORD.timestamp }],
      [PRIOR_RECORD, disabledRecord(), { ...PRIOR_RECORD, timestamp: '2026-09-08T00:00:02Z' }],
    ]) {
      expect(disabledPlanReviewEvidence(completed(), '', records.map(record => JSON.stringify(record)).join('\n'), PRIOR_RECORD).passed).toBe(false);
    }
    expect(disabledPlanReviewEvidence(completed(), '', '{bad-json}', PRIOR_RECORD).passed).toBe(false);
  });

  test('missing or falsely completed attribution fails', () => {
    for (const output of ['Done.', 'Outside review is not disabled.', 'outside_status: completed', 'Outside review disabled. Both reviewers agree.']) {
      const result = completed(); result.output = output;
      expect(oracle(result, '').passed).toBe(false);
    }
  });

  test('generated preflight reads isolated disabled config without executing the available CLI', () => {
    const rendered = join(TEMP, 'render');
    const generation = spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', '--host', 'claude', '--out-dir', rendered], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(generation.status, generation.stderr).toBe(0);
    const repo = mkdtempSync(join(TEMP, 'repo-'));
    const fixture = installDisabledPlanReviewFixture(rendered, repo, ROOT);
    const preflight = fixture.instructions.match(/```bash\n([\s\S]*?)\n```/)?.[1];
    expect(preflight).toBeDefined();
    const result = spawnSync('bash', ['-c', preflight!], {
      cwd: repo, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^CODEX_MODE: disabled\s*$/m);
    expect(existsSync(fixture.cliDispatchLog)).toBe(false);
    const persist = [...fixture.instructions.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map(match => match[1]).find(command => command.includes('"outside_status":"disabled"'));
    expect(persist).toBeDefined();
    const logged = spawnSync('bash', ['-c', persist!], {
      cwd: repo, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 5_000,
    });
    expect(logged.status, logged.stderr).toBe(0);
    const reviewLog = readFileSync(fixture.reviewLogPath, 'utf8');
    const records = reviewLog.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(fixture.priorRecord);
    expect(records[1]).toMatchObject({ skill: 'codex-plan-review', host: 'claude', outside_provider: 'codex',
      outside_status: 'disabled', phase: 'plan-review', status: 'skipped', source: 'none' });
    expect(disabledPlanReviewEvidence(completed(), '', reviewLog, fixture.priorRecord).persistedDisabled).toBe(true);
    // A fresh enabled shell must not append a disabled record, even if the
    // model unnecessarily executes this guarded fence after the preflight.
    const enable = spawnSync(join(ROOT, 'bin/gstack-config'), ['set', 'codex_reviews', 'enabled'], {
      cwd: repo, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 5_000,
    });
    expect(enable.status, enable.stderr).toBe(0);
    const enabledLog = spawnSync('bash', ['-c', persist!], {
      cwd: repo, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 5_000,
    });
    expect(enabledLog.status, enabledLog.stderr).toBe(0);
    expect(readFileSync(fixture.reviewLogPath, 'utf8')).toBe(reviewLog);
    // Prove the sentinel observes a real invocation; an empty broken spy is
    // not acceptable evidence that the generated off branch skipped the CLI.
    const forbidden = spawnSync('codex', ['--version'], { cwd: repo, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 5_000 });
    expect(forbidden.status).toBe(73);
    expect(readFileSync(fixture.cliDispatchLog, 'utf8')).toBe('codex invoked\n');
  }, 150_000);
  test('generated Codex plan and documentation log fences resolve runtime in fresh shells', () => {
    const rendered = join(TEMP, 'codex-render');
    const generated = spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', rendered], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(generated.status, generated.stderr).toBe(0);
    const repo = mkdtempSync(join(TEMP, 'codex-repo-'));
    const home = join(repo, 'owned-home');
    const codexHome = join(home, 'custom codex');
    const state = join(repo, 'gstack-state');
    mkdirSync(join(codexHome, 'skills'), { recursive: true });
    symlinkSync(ROOT, join(codexHome, 'skills', 'gstack'), 'dir');
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, GSTACK_HOME: state, GSTACK_STATE_ROOT: state,
      GSTACK_PROJECT_SLUG: 'codex-disabled-fixture', GSTACK_ROOT: '', GSTACK_BIN: '', GSTACK_ACTIVE_HOST: 'codex' };
    const run = (command: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', command], { cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5_000 });
    const config = (mode: string) => spawnSync(join(ROOT, 'bin/gstack-config'), ['set', 'codex_reviews', mode], {
      cwd: repo, env, encoding: 'utf8', timeout: 5_000,
    });
    const slug = spawnSync(join(ROOT, 'bin/gstack-slug'), [], { cwd: repo, env, encoding: 'utf8', timeout: 5_000 });
    expect(slug.status, slug.stderr).toBe(0);
    const branch = /^BRANCH=([a-zA-Z0-9._-]+)$/m.exec(slug.stdout)?.[1];
    expect(branch).toBeDefined();
    const logPath = join(state, 'projects', env.GSTACK_PROJECT_SLUG, `${branch}-reviews.jsonl`);
    const brokenRuntime = join(repo, 'broken-runtime');
    mkdirSync(join(brokenRuntime, 'bin'), { recursive: true });
    mkdirSync(join(brokenRuntime, 'lib'));
    writeFileSync(join(brokenRuntime, 'lib/claude-bin.ts'), '// valid explicit runtime marker\n');
    writeFileSync(join(brokenRuntime, 'bin/gstack-config'), '#!/bin/sh\nexit 19\n', { mode: 0o755 });
    const unexpectedWrite = join(repo, 'unexpected-review-write');
    writeFileSync(join(brokenRuntime, 'bin/gstack-review-log'), '#!/bin/sh\nprintf invoked > "$UNEXPECTED_REVIEW_WRITE"\n', { mode: 0o755 });
    for (const [skill, id, phase] of [
      ['gstack-plan-eng-review', 'codex-plan-review', 'plan-review'],
      ['gstack-document-release', 'codex-doc-review', 'documentation'],
    ]) {
      const instructions = readFileSync(join(rendered, '.agents', 'skills', skill, 'SKILL.md'), 'utf8');
      const fence = [...instructions.matchAll(/```bash\n([\s\S]*?)\n```/g)]
        .map(match => match[1]).find(command => command.includes(`"skill":"${id}"`) && command.includes('"outside_status":"disabled"'));
      expect(fence, skill).toBeDefined();
      expect(config('disabled').status).toBe(0);
      const prior = { skill: id, timestamp: new Date(Date.now() - 60_000).toISOString(), status: 'clean', source: 'claude-code',
        host: 'codex', outside_provider: 'claude-code', outside_status: 'completed', phase };
      const seed = spawnSync(join(ROOT, 'bin/gstack-review-log'), [JSON.stringify(prior)], { cwd: repo, env, encoding: 'utf8', timeout: 5_000 });
      expect(seed.status, seed.stderr).toBe(0);
      const before = readFileSync(logPath, 'utf8');
      const logged = run(fence!); // No variables survive from a preflight shell.
      expect(logged.status, logged.stderr).toBe(0);
      const after = readFileSync(logPath, 'utf8');
      expect(after.startsWith(before)).toBe(true);
      const records = after.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.skill === id);
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({ skill: id, host: 'codex', outside_provider: 'claude-code',
        outside_status: 'disabled', phase, status: 'skipped', source: 'none' });
      expect(config('enabled').status).toBe(0);
      const skipped = run(fence!);
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(readFileSync(logPath, 'utf8')).toBe(after);
      const failedRead = run(fence!, { GSTACK_ROOT: brokenRuntime, UNEXPECTED_REVIEW_WRITE: unexpectedWrite });
      expect(failedRead.status).not.toBe(0);
      expect(failedRead.stderr).toContain('Cannot read codex_reviews');
      expect(readFileSync(logPath, 'utf8')).toBe(after);
      expect(existsSync(unexpectedWrite)).toBe(false);
    }
  }, 150_000);

});
