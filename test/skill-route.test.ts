/**
 * lib/skill-route.ts, the skill-route hook and gstack-skill-route --explain
 * (GST-1088, lane A): deterministic scoring against installed triggers, one
 * additionalContext line when it fires, nothing at all (exit 0, no stderr) on
 * every error, and off by default.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROMPT_MAX_CHARS, ROUTED_SKILLS, ROUTE_THRESHOLD, firstStep, hintLine, readSkillSwitch, routePrompt, scanInstalledSkills, scorePrompt, stem } from '../lib/skill-route';
import { ROOT, ROUTE_HOOK, SKILLS, hookEnv, runHook, skillsDir, tmpDir } from './helpers/skill-contract-fixture';

let state = '', skills = '';
beforeEach(() => { state = tmpDir('gstack-route-state-'); skills = skillsDir(); });
afterEach(() => { for (const d of [state, skills]) fs.rmSync(d, { recursive: true, force: true }); });

const prompt = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 'sess-r', transcript_path: '/tmp/t.jsonl', cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: text, ...extra });
const route = (input: string, env: Record<string, string> = { GSTACK_SKILL_ROUTING: 'on' }) => runHook(ROUTE_HOOK, input, hookEnv(state, skills, env));
const traceLog = () => fs.readFileSync(path.join(state, 'hooks', 'skill-route.log'), 'utf8');
const silent = { code: 0, stdout: '', stderr: '' };

/** Claude Code's UserPromptSubmit output: exactly hookSpecificOutput { hookEventName, additionalContext }, one line. */
function expectHookSchema(stdout: string): string {
  const out = JSON.parse(stdout);
  expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  const line = out.hookSpecificOutput.additionalContext;
  expect(typeof line).toBe('string');
  expect(line).not.toContain('\n');
  return line;
}

describe('scorer', () => {
  const { skills: fixtureSkills } = scanInstalledSkills(skillsDir(['investigate', 'review', 'qa']));

  test('deterministic, phrase match scores 1, stemming covers inflections', () => {
    const a = scorePrompt('this test fails, fix it', fixtureSkills);
    expect(a).toEqual(scorePrompt('this test fails, fix it', fixtureSkills));
    expect(a[0]).toMatchObject({ skill: 'investigate', score: 1, trigger: 'this test fails' });
    expect(routePrompt('the tests are failing', fixtureSkills).route?.skill).toBe('investigate');
    expect(['fixes', 'failing', 'debugging', 'passes'].map(stem)).toEqual(['fix', 'fail', 'debug', 'pass']);
  });

  test('threshold, weak single words, slash commands and long prompts', () => {
    expect(ROUTE_THRESHOLD).toBe(0.66);
    expect(routePrompt('what is the weather', fixtureSkills).route).toBeNull();
    expect(routePrompt('please review my diff', fixtureSkills)).toMatchObject({ route: null, reason: 'below-threshold' });
    expect(routePrompt('/investigate fix this bug', fixtureSkills)).toMatchObject({ route: null, reason: 'slash-command' });
    expect(routePrompt(`fix this bug ${'x'.repeat(PROMPT_MAX_CHARS)}`, fixtureSkills)).toMatchObject({ route: null, reason: 'prompt-too-long' });
  });

  test('only the four discovery targets route; another installed skill with a matching trigger does not', () => {
    expect(ROUTED_SKILLS).toEqual(['investigate', 'review', 'qa', 'verify']);
    const ship = { name: 'ship', file: '', frontmatter: '', triggers: ['ship this branch'] };
    expect(scorePrompt('ship this branch', [ship])[0]).toMatchObject({ skill: 'ship', score: 1 });
    expect(routePrompt('ship this branch', [...fixtureSkills, ship])).toMatchObject({ route: null, reason: 'below-threshold' });
    expect(routePrompt('this test fails, ship this branch', [ship, ...fixtureSkills]).route?.skill).toBe('investigate');
  });

  test('malformed triggers are reported and skipped, never thrown', () => {
    const scan = scanInstalledSkills(skillsDir(['broken', 'qa'], { nofront: 'no frontmatter here\n' }));
    expect(scan.problems).toEqual(['broken: malformed triggers']);
    expect(scan.skills.map(s => s.name)).toEqual(['broken', 'qa']);
    expect(scanInstalledSkills(path.join(state, 'missing')).problems[0]).toContain('skills directory unreadable');
  });

  test('the hint names its source and off switch, and asks for the one-sentence routing note', () => {
    const line = hintLine({ skill: 'investigate', score: 1, matched: 2, trigger: 'fix this bug', file: '' });
    expect(line).toContain('gstack skill routing (UserPromptSubmit hook');
    expect(line).toContain('off: gstack-config set skill_routing off');
    expect(line).toContain('tell the user in one sentence that gstack routed this to /investigate');
    expect(firstStep(SKILLS.investigate)).toBe('Reproduce the failure before you change code, then fix it and prove the fix.');
  });

  test('switch precedence: env over config over default off; typos read as off', () => {
    expect(readSkillSwitch('skill_routing', { GSTACK_STATE_ROOT: state })).toEqual({ on: false, source: 'default' });
    fs.writeFileSync(path.join(state, 'config.yaml'), 'skill_routing: on\nskill_contracts: maybe\n');
    expect(readSkillSwitch('skill_routing', { GSTACK_STATE_ROOT: state })).toEqual({ on: true, source: 'config skill_routing' });
    expect(readSkillSwitch('skill_routing', { GSTACK_STATE_ROOT: state, GSTACK_SKILL_ROUTING: 'off' })).toEqual({ on: false, source: 'env GSTACK_SKILL_ROUTING' });
    expect(readSkillSwitch('skill_contracts', { GSTACK_STATE_ROOT: state })).toEqual({ on: false, source: 'config skill_contracts', invalid: 'maybe' });
  });
});

describe('skill-route hook', () => {
  test('routes a fitting prompt with one schema-valid line and a trace', () => {
    const r = route(prompt('this test fails, fix it'));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(expectHookSchema(r.stdout)).toContain('this request fits /investigate');
    expect(traceLog()).toMatch(/session=sess-r event=routed skill=investigate score=1 variant=name\n$/);
    expect(traceLog()).not.toContain('fix it');
  });

  test('hint variants for the pilot: first step and contract', () => {
    expect(expectHookSchema(route(prompt('fix this bug'), { GSTACK_SKILL_ROUTING: 'on', GSTACK_SKILL_ROUTE_HINT: 'step' }).stdout))
      .toContain('Its first step: Reproduce the failure before you change code');
    expect(expectHookSchema(route(prompt('fix this bug'), { GSTACK_SKILL_ROUTING: 'on', GSTACK_SKILL_ROUTE_HINT: 'contract' }).stdout))
      .toContain('Done means: a DEBUG REPORT with Symptom, Root cause, Fix, Evidence; a test or repro run after your last edit.');
  });

  test('off by default, off in config, and off in env over config on', () => {
    expect(route(prompt('fix this bug'), {})).toEqual(silent);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'skill_routing: off\n');
    expect(route(prompt('fix this bug'), {})).toEqual(silent);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'skill_routing: on\n');
    expect(route(prompt('fix this bug'), { GSTACK_SKILL_ROUTING: 'off' })).toEqual(silent);
    expect(expectHookSchema(route(prompt('fix this bug'), {}).stdout)).toContain('/investigate');
  });

  test('slash commands and non-matching prompts: no output', () => {
    expect(route(prompt('/investigate fix this bug'))).toEqual(silent);
    expect(route(prompt('what time is it in Tokyo'))).toEqual(silent);
    expect(traceLog()).toContain('reason=slash-command');
    expect(traceLog()).toContain('reason=below-threshold');
  });

  test('error cases exit 0 with nothing on stdout or stderr, and count a failure', () => {
    expect(route('{not json')).toEqual(silent);
    expect(route('[1,2]')).toEqual(silent);
    expect(route(prompt('x'.repeat(PROMPT_MAX_CHARS + 1) + ' fix this bug'))).toEqual(silent);
    expect(route(prompt('fix this bug ' + 'y'.repeat(300 * 1024)))).toEqual(silent);
    expect(route(JSON.stringify({ session_id: 'sess-r' }))).toEqual(silent);
    const log = traceLog();
    for (const event of ['event=bad-json', 'reason=prompt-too-long', 'event=stdin-over-cap', 'event=no-prompt']) expect(log).toContain(event);
    expect(log).toContain('session=unknown event=stdin-over-cap cap=262144 failures=3');
    expect(log).toContain('session=sess-r event=no-prompt failures=2');
  });

  test('malformed triggers in one skill: logged, the others still route', () => {
    fs.rmSync(skills, { recursive: true, force: true });
    skills = skillsDir(['broken', 'investigate']);
    expect(expectHookSchema(route(prompt('fix this bug')).stdout)).toContain('/investigate');
    expect(traceLog()).toContain('event=skill-problems problems="broken: malformed triggers" failures=1');
  });

  test('unreadable config and an unwritable state root: still exit 0 and silent', () => {
    fs.mkdirSync(path.join(state, 'config.yaml'));
    expect(route(prompt('fix this bug'), {})).toEqual(silent);
    const file = path.join(state, 'root-is-a-file');
    fs.writeFileSync(file, 'x');
    const r = runHook(ROUTE_HOOK, prompt('fix this bug'), hookEnv(file, skills, { GSTACK_SKILL_ROUTING: 'on' }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expectHookSchema(r.stdout);
  });

  test('the bash shim exits 0', () => {
    const r = spawnSync('bash', [path.join(ROOT, 'hosts', 'claude', 'hooks', 'skill-route-hook')], {
      input: '{bad', env: hookEnv(state, skills, { GSTACK_SKILL_ROUTING: 'on' }), encoding: 'utf8', timeout: 20_000,
    });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
  });
});

describe('gstack-skill-route --explain', () => {
  const explain = (...args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-skill-route'), args, { env: hookEnv(state, skills), encoding: 'utf8', timeout: 20_000 });

  test('prints the switch, threshold, candidates with scores, the route and the hint (a dry run with the switch off)', () => {
    const r = explain('--explain', 'this test fails, fix it');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('switch: skill_routing off (default)');
    expect(r.stdout).toContain('threshold: 0.66');
    expect(r.stdout).toContain('1.00  /investigate  "this test fails"');
    expect(r.stdout).toContain('route: /investigate');
    expect(r.stdout).toContain('broken: malformed triggers');
    expect(JSON.parse(explain('--explain', 'what is this', '--json').stdout)).toMatchObject({ route: null, reason: 'below-threshold', threshold: 0.66 });
    expect(explain('--explain').status).toBe(2);
  });
});
