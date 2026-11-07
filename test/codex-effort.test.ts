/**
 * D1-A (#3098, #2934): Codex reasoning effort follows the model's precedence,
 * GSTACK_CODEX_EFFORT, then codex_effort in config.yaml, then each gate's own
 * default, for manual /codex and gstack's outside reviews alike. /spec's gate
 * keeps medium inside its 120 s budget whatever is set. Template contracts are
 * adapted from #3098 (@Lockyer228); the gate test runs the generated command
 * against a fake codex and reads the arguments it was given.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexEffortSetting, modelsMain } from '../lib/model-policy-cli';
import { outsideVoiceCommand } from '../scripts/resolvers/outside-voice';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { between, expectMentions, expectTokens } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MODES: Array<[string, string]> = [['review-mode', 'high'], ['challenge-mode', 'high'], ['consult-mode', 'medium']];

describe('manual /codex modes (#3098)', () => {
  test('every mode dispatches through run-with-timeout --effort with its own default', () => {
    for (const [mode, def] of MODES) {
      const tmpl = read(`codex/sections/${mode}.md.tmpl`);
      const dispatches = tmpl.split('\n').filter(line => /run-with-timeout --user-invoked --effort \w+ (--request-effort '<effort-level>' )?\d+ codex (exec|review)\b/.test(line));
      expect(dispatches.length, mode).toBeGreaterThan(0);
      for (const line of dispatches) {
        expect(line, mode).toContain(`--effort ${def} --request-effort '<effort-level>' `);
        expect(line, mode).not.toContain('model_reasoning_effort');
      }
      expect(tmpl, mode).not.toContain('check-effort');
    }
  });

  test('the skill body documents the precedence and the --effort / --xhigh overrides', () => {
    const body = read('codex/SKILL.md.tmpl');
    for (const want of ['GSTACK_CODEX_EFFORT', 'codex_effort', 'run-with-timeout --effort <default>', '--request-effort']) expect(body).toContain(want);
    const flags = between(body, '**Effort flags, read before the mode:**', '```bash');
    expectTokens(flags, ['--effort <level>', '--effort=<level>', '--xhigh', '--effort xhigh', '<effort-level>'], 'codex effort flags');
    expectMentions(flags, [['directly after', 'mode word', 'leading flags', '--model', '--role', 'before any prompt text'], ['later', 'prompt text'], ['remove', 'before Step 1'],
      ['missing', 'lowercase word', 'differing levels', 'stop'], ['later', 'level', 'say so']], 'codex effort flags');
    const step1 = between(body, '## Step 1: Detect mode', '- Review (2A)');
    expectMentions(step1, [['effort flags removed'], ['--request-effort', 'outranks']], 'codex Step 1');
  });

  test('effort flags are read and validated before mode detection and before the paid model probe', () => {
    const body = read('codex/SKILL.md.tmpl');
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const check = at(`"$_CODEX_PROBE" check-effort high --request '<effort-level>' >/dev/null || exit 1`);
    expect(at('**Effort flags, read before the mode:**')).toBeLessThan(check);
    expect(check).toBeLessThan(at('"$_CODEX_PROBE" probe-model exec'));
    expect(check).toBeLessThan(at('## Step 1: Detect mode'));
    expect(body).not.toMatch(/prefix each\s+`run-with-timeout` dispatch with `GSTACK_CODEX_EFFORT/);
  });

  test('docs/model-policy.md documents the per-request --effort flag in its Reasoning effort section', () => {
    const doc = between(read('docs/model-policy.md'), '## Reasoning effort', '## Which workflows use the tiers?');
    expectTokens(doc, ['/codex review --effort medium', '--effort=<level>', '--xhigh', '--request-effort', 'GSTACK_CODEX_EFFORT'], 'model-policy effort');
    expectMentions(doc, [['outranks', 'exported'], ['directly after', 'mode word', 'leading flags', 'prompt'], ['unknown level', 'before any Codex call']], 'model-policy effort');
    expect(doc).toContain('| 0 | `/codex ... --effort <level>`');
  });
});

describe('gstack outside reviews use the same precedence', () => {
  test('rendered gates pass their default to run-with-timeout --effort', () => {
    for (const [rel, def] of [['autoplan/sections/ceo-phase.md', 'high'], ['plan-eng-review/sections/review-sections.md', 'high'],
      ['review/sections/adversarial.md', 'high'], ['design-consultation/sections/proposal-and-preview.md', 'medium']] as const) {
      const text = read(rel);
      expect(text, rel).not.toContain('check-effort');
      const dispatches = text.split('\n').filter(line => /run-with-timeout (--effort \w+ )?\d+ codex (exec|review)\b/.test(line));
      expect(dispatches.length, rel).toBeGreaterThan(0);
      for (const line of dispatches) {
        expect(line, rel).toContain(`run-with-timeout --effort ${def} `);
        expect(line, rel).not.toContain('model_reasoning_effort');
      }
    }
  });

  const fakeBin = path.join(TMP, 'bin');
  const capture = path.join(TMP, 'codex-args');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/usr/bin/env bash
[ "$1" = sandbox ] && exit 0
printf '%s\\n' "$@" > '${capture}'
cat >/dev/null
while [ "$#" -gt 0 ]; do [ "$1" = -o ] && printf 'SCORE: 8\\nAMBIGUITIES: NONE\\n' > "$2"; shift; done
echo '{"type":"item.completed","item":{"type":"agent_message","text":"SCORE: 8"}}'
`, { mode: 0o755 });
  const repo = path.join(TMP, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 30_000 });
  const prompt = path.join(TMP, 'prompt.txt');
  fs.writeFileSync(prompt, 'Score this spec.\n');

  function dispatchedArgs(gate: 'spec' | 'review', effortEnv: string | undefined, stored: string | undefined): string[] {
    const state = path.join(TMP, `state-${gate}-${effortEnv ?? 'none'}-${stored ?? 'none'}`);
    fs.mkdirSync(state, { recursive: true });
    if (stored) fs.writeFileSync(path.join(state, 'config.yaml'), `codex_effort: ${stored}\n`);
    const ctx: TemplateContext = { skillName: gate === 'spec' ? 'spec' : 'review', tmplPath: 'x/SKILL.md.tmpl', host: 'claude', paths: { ...HOST_PATHS.claude, binDir: path.join(ROOT, 'bin'), skillRoot: ROOT } };
    const command = gate === 'spec'
      ? outsideVoiceCommand(ctx, { promptFile: prompt, timeoutMs: 120_000, gate: 'spec', reasoningEffort: 'medium' })
      : outsideVoiceCommand(ctx, { promptFile: prompt, timeoutMs: 300_000 });
    fs.rmSync(capture, { force: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CODEX_|GSTACK_CODEX_|OPENAI_)/.test(k)) env[k] = v;
    Object.assign(env, { PATH: `${fakeBin}:${process.env.PATH}`, GSTACK_HOME: state, GSTACK_STATE_ROOT: '', CODEX_HOME: TMP, GSTACK_ACTIVE_HOST: 'claude', CLAUDECODE: '1' });
    if (effortEnv) env.GSTACK_CODEX_EFFORT = effortEnv;
    spawnSync('bash', ['-c', command], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
    return fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\n') : [];
  }

  test('an ordinary gate takes env, then config, then its default', () => {
    expect(dispatchedArgs('review', undefined, undefined)).toContain('model_reasoning_effort="high"');
    expect(dispatchedArgs('review', undefined, 'low')).toContain('model_reasoning_effort="low"');
    expect(dispatchedArgs('review', 'max', 'low')).toContain('model_reasoning_effort="max"');
    expect(dispatchedArgs('review', 'banana', undefined)).toEqual([]);
  });

  const FENCES = (['review-mode', 'challenge-mode', 'consult-mode'] as const).flatMap(mode =>
    read(`codex/sections/${mode}.md`).split('\n').filter(line => /run-with-timeout --user-invoked --effort \w+ --request-effort '<effort-level>' \d+ codex /.test(line))
      .map(line => ({ mode, line: line.trim().split(' | tee ')[0] })));

  test('all four rendered /codex dispatches carry the request level to the probe, over env and codex_effort', () => {
    expect(FENCES.length).toBe(4);
    const dispatches = (['review-mode', 'challenge-mode', 'consult-mode'] as const).flatMap(mode =>
      read(`codex/sections/${mode}.md`).split('\n').filter(line => /run-with-timeout\b.*\bcodex (exec|review)\b/.test(line)));
    expect(dispatches.length).toBe(FENCES.length);
    expect(dispatches.filter(line => /\bcodex review\b/.test(line))).toEqual([]);
    const state = path.join(TMP, 'state-codex-request-effort');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'codex_effort: low\n');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CODEX_|GSTACK_CODEX_|OPENAI_)/.test(k)) env[k] = v;
    Object.assign(env, { PATH: `${fakeBin}:${process.env.PATH}`, GSTACK_HOME: state, GSTACK_STATE_ROOT: '', CODEX_HOME: TMP, GSTACK_ACTIVE_HOST: 'claude', CLAUDECODE: '1' });
    const err = path.join(TMP, 'dispatch-err');
    const run = (line: string, level: string, exported?: string) => {
      fs.rmSync(capture, { force: true });
      fs.rmSync(err, { force: true });
      const script = [`_CODEX_PROBE=${JSON.stringify(path.join(ROOT, 'bin', 'gstack-codex-probe'))}`, '_CODEX_SANDBOX_MODE=read-only', '_CODEX_SEL=gpt-test',
        `_REPO_ROOT=${JSON.stringify(repo)}`, `PROMPT_FILE=${JSON.stringify(prompt)}`, `_PROMPT_FILE=${JSON.stringify(prompt)}`, '_SID=sid-test',
        `TMPOUT=${JSON.stringify(path.join(TMP, 'dispatch-out'))}`, `TMPRESP=${JSON.stringify(path.join(TMP, 'dispatch-resp'))}`, `TMPERR=${JSON.stringify(err)}`,
        line.replace('<base>', 'HEAD').replace(`'<effort-level>'`, `'${level}'`)].join('\n');
      const r = spawnSync('bash', ['-c', script], { cwd: repo, env: exported ? { ...env, GSTACK_CODEX_EFFORT: exported } : env, encoding: 'utf8', timeout: 60_000 });
      return { status: r.status, args: fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\n') : [], stderr: fs.existsSync(err) ? fs.readFileSync(err, 'utf8') : '' };
    };
    for (const { mode, line } of FENCES) {
      expect(run(line, '').args, mode).toContain('model_reasoning_effort="low"');
      expect(run(line, 'medium').args, mode).toContain('model_reasoning_effort="medium"');
      expect(run(line, 'xhigh').args, mode).toContain('model_reasoning_effort="xhigh"');
      expect(run(line, 'medium', 'max').args, mode).toContain('model_reasoning_effort="medium"');
      const unfilled = run(line, '<effort-level>');
      expect(unfilled.args, mode).toEqual([]);
      expect(unfilled.stderr, mode).toContain('placeholder was left unfilled');
      const bogus = run(line, 'bogus');
      expect(bogus.args, mode).toEqual([]);
      expect(bogus.status, mode).toBe(1);
      expect(bogus.stderr, mode).toContain("CODEX_EFFORT: invalid — 'bogus' from /codex --effort");
      expect(bogus.stderr, mode).toContain('--effort medium');
    }
  });

  test('check-effort --request outranks env and config, and names the flag when the level is invalid', () => {
    const probe = path.join(ROOT, 'bin', 'gstack-codex-probe');
    const state = path.join(TMP, 'state-check-effort-request');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'codex_effort: low\n');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CODEX_|GSTACK_CODEX_|OPENAI_)/.test(k)) env[k] = v;
    Object.assign(env, { GSTACK_HOME: state, GSTACK_STATE_ROOT: '' });
    const check = (args: string[], exported?: string) => spawnSync(probe, ['check-effort', ...args], { env: exported ? { ...env, GSTACK_CODEX_EFFORT: exported } : env, encoding: 'utf8', timeout: 30_000 });
    expect(check(['high', '--request', 'medium'], 'max').stdout).toBe('CODEX_EFFORT: medium\n');
    expect(check(['high', '--request', '']).stdout).toBe('CODEX_EFFORT: low\n');
    expect(check(['high', '--request', ''], 'max').stdout).toBe('CODEX_EFFORT: max\n');
    const bad = check(['high', '--request', 'turbo']);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain("'turbo' from /codex --effort");
    expect(bad.stderr).not.toContain('export GSTACK_CODEX_EFFORT');
    expect(bad.stderr).toContain('docs/model-policy.md#reasoning-effort');
    const unfilled = check(['high', '--request', '<effort-level>']);
    expect(unfilled.status).toBe(1);
    expect(unfilled.stderr).toContain("'<effort-level>' placeholder was left unfilled");
    expect(unfilled.stderr).not.toContain('from /codex --effort');
    expect(check(['high', '--request']).status).toBe(64);
    expect(check(['high', '--bogus', 'low']).status).toBe(64);
  });

  test('/spec keeps medium effort and its 120 s budget whatever env or config say', () => {
    for (const [env, stored] of [[undefined, undefined], ['max', undefined], [undefined, 'xhigh'], ['ultra', 'low']] as const) {
      expect(dispatchedArgs('spec', env, stored)).toContain('model_reasoning_effort="medium"');
    }
    const spec = read('spec/sections/gate-and-file.md');
    const dispatch = spec.split('\n').find(line => /run-with-timeout \d+ codex exec/.test(line))!;
    expect(dispatch).toContain('run-with-timeout 120 codex exec');
    expect(dispatch).toContain(`-c 'model_reasoning_effort="medium"'`);
    expect(spec).not.toContain('check-effort');
  });
});

describe('codex_effort setting', () => {
  test('gstack-config rejects an invalid level and keeps the stored one', () => {
    const state = path.join(TMP, 'config-state');
    fs.mkdirSync(state, { recursive: true });
    const env = { ...process.env, GSTACK_HOME: state, GSTACK_STATE_ROOT: '' } as Record<string, string>;
    const config = (...args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-config'), args, { env, encoding: 'utf8', timeout: 30_000 });
    expect(config('set', 'codex_effort', 'low').status).toBe(0);
    const bad = config('set', 'codex_effort', 'banana');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("codex_effort 'banana' not recognized");
    expect(config('get', 'codex_effort').stdout).toBe('low');
    expect(codexEffortSetting(env)).toEqual({ value: 'low', source: 'config', valid: true });
    expect(codexEffortSetting({ ...env, GSTACK_CODEX_EFFORT: 'max' })).toEqual({ value: 'max', source: 'env', valid: true });
    const list = modelsMain([], env);
    expect(list.stdout).toContain('codex effort: low (codex_effort in ');
    expect(JSON.parse(modelsMain(['--json'], { ...env, GSTACK_CODEX_EFFORT: 'nope' }).stdout).codexEffort).toEqual({ value: 'nope', source: 'env', valid: false });
  });
});
