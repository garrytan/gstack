/** Execute each outside-review fence with no state from a previous shell. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand, outsideVoicePreflight, outsideVoiceInvocation } from '../scripts/resolvers/outside-voice';
import { generateCodexDocReview, generateCodexPlanReview } from '../scripts/resolvers/review';
import { validateOutsideReview } from '../lib/outside-review-result';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';

const ROOT = path.resolve(import.meta.dir, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-outside-preflight-'));
afterAll(() => fs.rmSync(TEMP, { recursive: true, force: true }));

test('Eng owns routing without changing any preflight shell or implicit caller default', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { host: host.name, skillName: 'plan-eng-review', paths: HOST_PATHS[host.name] } as TemplateContext;
    const ordinary = outsideVoicePreflight(ctx, { disabledBehavior: 'skip-all' });
    const callerOwned = outsideVoicePreflight(ctx, { disabledBehavior: 'skip-all', routing: 'caller' });
    expect(callerOwned).toBe(ordinary.slice(0, ordinary.indexOf('\n```') + 4));
    expect(outsideVoicePreflight(ctx, { disabledBehavior: 'skip-all', routing: undefined })).toBe(ordinary);
    const rendered = generateCodexPlanReview(ctx);
    expect(rendered).not.toContain('Branch on the echoed `CODEX_MODE`');
    expect(rendered.match(/\*\*Outcome routing:\*\*/g)).toHaveLength(1);
    expect(rendered).not.toContain('Pick exactly one row');
    expect(rendered).toContain('do not run fallback after a completed review');
    expect(rendered.replace(/\s+/g, ' ')).toContain('explain how the user can select a supported model');
    expect(rendered.replace(/\s+/g, ' ')).toContain('Do not change the configured model or retry this invocation; use Native fallback as the routing table directs');
  }
});

test('Eng routes ready through completion and persistence, never directly to exit', () => {
  function hasCompleteRoutes(text: string): boolean {
    const routing = text.slice(text.indexOf('**Outcome routing:**'), text.indexOf('**Disabled is a terminal branch'));
    const rows = new Map([...routing.matchAll(/^\| ([^|]+) \| ([^|]+) \|$/gm)].map(match => [match[1].trim(), match[2].trim()]));
    return rows.get('Ready')?.includes('route its result here again') === true
      && rows.get('Reviewer completes')?.includes('resolve findings in Cross-model tension, then Persist the result') === true
      && rows.get('Disabled')?.includes('No prompt, outside process or native replacement') === true
      && rows.get('Outside execution or output validation fails')?.includes('finish termination, then use Native fallback') === true
      && rows.get('Native fallback unavailable or fails')?.includes('record missing coverage') === true
      && !routing.includes('Pick exactly one row');
  }
  for (const host of ALL_HOST_CONFIGS) {
    const rendered = generateCodexPlanReview({ host: host.name, skillName: 'plan-eng-review', paths: HOST_PATHS[host.name] } as TemplateContext);
    expect(hasCompleteRoutes(rendered)).toBe(true);
    expect(hasCompleteRoutes(rendered.replace('route its result here again', 'leave Outside Voice'))).toBe(false);
    expect(hasCompleteRoutes(rendered.replace('then Persist the result', 'then continue'))).toBe(false);
    expect(hasCompleteRoutes(rendered.replace('No prompt, outside process or native replacement', 'Use native fallback'))).toBe(false);
    expect(hasCompleteRoutes(rendered.replace('finish termination, then use Native fallback', 'start another outside invocation'))).toBe(false);
    expect(hasCompleteRoutes(rendered.replace('record missing coverage', 'record a clean review'))).toBe(false);
  }
});

test('CEO and Eng describe the actual disabled route and completion validator', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const skillName of ['plan-ceo-review', 'plan-eng-review']) {
      const ctx: TemplateContext = { host: host.name, skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host.name] };
      const output = generateCodexPlanReview(ctx);
      expect(output).not.toContain('Skip this section entirely');
      if (skillName === 'plan-ceo-review') {
        expect(output.replace(/\s+/g, ' ')).toContain('If preflight selected `disabled`, use the guarded record below');
        expect(output).toContain('"outside_status":"disabled"');
      } else expect(output).toContain('persist `outside_status: disabled` with the guarded');
      const prompt = output.slice(output.indexOf('"IMPORTANT:'), output.indexOf('\n<plan content>"'));
      expect(prompt).toContain('End with Recommendation: <action> because <specific reason>');
      expect(prompt).toContain('If there are no findings, say so and explain why');
      const invocation = outsideVoiceInvocation(ctx);
      expect(invocation).toContain('missing Recommendation: <action> because <reason> markers');
      expect(invocation).not.toContain('score/severity/completion');
      if (skillName === 'plan-eng-review') {
        const routing = output.slice(output.indexOf('**Outcome routing:**'), output.indexOf('**Disabled is a terminal branch'));
        expect(routing).toMatch(/\| Disabled \|[^\n]*No prompt, outside process or native replacement\./);
        expect(routing).toMatch(/\| Other preflight mode, including harness mismatch \|[^\n]*Native fallback\./);
        expect(routing).toMatch(/\| Outside execution or output validation fails \|[^\n]*finish termination, then use Native fallback\./);
        expect(routing).toMatch(/\| Native fallback unavailable or fails \|[^\n]*No clean-review credit\./);
        const fallback = output.slice(output.indexOf('**Native fallback'), output.indexOf('Dispatch via the Agent tool'));
        expect(fallback.replace(/\s+/g, ' ')).toContain('Immediately before dispatch, check the preflight result again: disabled means no replacement');
        const bounded = output.slice(output.indexOf('**Bounded outside-voice wait'), output.indexOf('**Cross-model tension:**'));
        expect(bounded).toContain('A native result never supplies outside coverage.');
        expect(output).toContain('A completed native fallback uses SOURCE=in-host, OUTSIDE_STATUS=unavailable, and STATUS=clean or issues_found from its findings');
        expect(output).toContain('"unavailable" if neither reviewer completed');
        expect(output).toContain('Never count missing coverage as a clean review');
        expect(output).toContain("These findings are the reviewer's, even if later resolved by the parent");
        // Compact prose must retain the actual wrong-harness execution guard.
        expect(invocation).toContain('exit 78');
        expect(invocation.indexOf('exit 78')).toBeLessThan(invocation.indexOf('_OUTSIDE_TMP=$(mktemp'));
      } else {
        const prose = output.replace(/\s+/g, ' ');
        expect(prose).toContain('Other preflight failures retain their printed diagnosis, including harness mismatch');
        const fallback = prose.slice(prose.indexOf('**Native fallback —'), prose.indexOf('Dispatch via the Agent tool'));
        expect(fallback).toContain('Immediately before dispatch, recheck whether reviews are enabled');
        expect(fallback).toContain('`CODEX_MODE: disabled`, return to **Record the disabled outcome** without dispatching');
        expect(prose).toContain('Its opening harness guard rechecks the fresh shell: exit 78 uses the same Native fallback below, never a replacement provider');
        expect(prose).toContain('A native result never supplies outside coverage.');
        expect(invocation).toContain('exit 78');
        expect(invocation.indexOf('exit 78')).toBeLessThan(invocation.indexOf('_OUTSIDE_TMP=$(mktemp'));
      }
    }
  }
  expect(validateOutsideReview('Recommendation: proceed because no findings remain.', 'review').completed).toBe(true);
  expect(validateOutsideReview('SCORE: 10\nAMBIGUITIES: NONE', 'review').completed).toBe(false);
  expect(validateOutsideReview('Recommendation: proceed', 'review').completed).toBe(false);
});

describe('own-harness review fallback instructions', () => {
  for (const host of ALL_HOST_CONFIGS) {
    for (const [name, render] of [['plan', generateCodexPlanReview], ['documentation', generateCodexDocReview]] as const) {
      test(`${host.name}: ${name} fallback names only the mode its preflight emits`, () => {
        const ctx: TemplateContext = { host: host.name, skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', paths: HOST_PATHS[host.name] };
        const text = render(ctx);
        const mode = host.name === 'codex' ? 'under_current_harness' : 'under_codex';
        const preflight = text.match(/```bash\n([\s\S]*?)\n```/)![1];
        expect(preflight).toContain(mode);
        expect([...new Set(text.match(/under_codex|under_current_harness/g))]).toEqual([mode]);
        expect(text.includes("retain the section's native pass if defined")).toBe(false);

        const fallback = text.slice(text.indexOf('**Native fallback'), text.indexOf('Dispatch via the Agent tool'));
        const ownHarnessBranch = `On \`CODEX_MODE: ${mode}\``;
        expect(text.split(ownHarnessBranch)).toHaveLength(2);
        expect(fallback).toContain(ownHarnessBranch);
        expect(fallback).toContain('`outside_status: unavailable`');
        expect(fallback).toContain('run no outside CLI');
        expect(fallback).toContain('use the native subagent below');
        expect(fallback).toContain('A native result never supplies outside coverage.');
        expect(fallback).toContain('The disabled branch never reaches this fallback.');
        expect(fallback).toContain('`CODEX_MODE: disabled`, finish this section with `outside_status: disabled`;');
      });
    }
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(TEMP, 'case-'));
  const repo = path.join(dir, "repo ' $(touch NEVER)");
  const home = path.join(dir, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  const capture = path.join(dir, 'capture.json');
  const fake = path.join(dir, 'fake-claude.ts');
  fs.writeFileSync(fake, `const prompt=await Bun.stdin.text(); await Bun.write(process.env.FIXTURE_CAPTURE!,JSON.stringify({prompt,args:process.argv.slice(2)})); console.log(JSON.stringify({result:'Recommendation: ship because the isolated fixture completed its review.'}));`);
  const env = { ...process.env, HOME: home, CODEX_HOME: '', GSTACK_HOME: path.join(home, '.gstack'),
    GSTACK_ROOT: '', GSTACK_BIN: '', GSTACK_ACTIVE_HOST: 'codex', CODEX_THREAD_ID: 'fixture', CODEX_SANDBOX: '', CLAUDECODE: '',
    GSTACK_CLAUDE_BIN: process.execPath, GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([fake]), FIXTURE_CAPTURE: capture };
  const install = (destination: string) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(ROOT, destination, 'dir');
    return destination;
  };
  const local = path.join(repo, '.agents/skills/gstack');
  const global = path.join(home, '.codex/skills/gstack');
  const ctx: TemplateContext = { host: 'codex', model: 'gpt', skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', paths: HOST_PATHS.codex };
  const run = (command: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', command], {
    cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000,
  });
  const preflight = (overrides: NodeJS.ProcessEnv = {}) => {
    const rendered = outsideVoicePreflight(ctx, { disabledBehavior: 'opt-in' });
    const command = rendered.match(/```bash\n([\s\S]*?)\n```/)![1];
    return run(`${command}\nprintf 'RESOLVED_ROOT: %s\\n' "$GSTACK_ROOT"`, overrides);
  };
  return { repo, home, env, local, global, ctx, capture, install, run, preflight };
}

describe('outside reviewer runtime discovery in fresh shells', () => {
  test('a repo-local installation resolves before any preamble exports exist', () => {
    const f = fixture();
    f.install(f.local);
    f.install(f.global);
    const result = f.preflight();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
    expect(result.stderr).toBe('');
    // The availability probe resolves a CLI; it must not dispatch a review.
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('global installation and CODEX_HOME both work without a local installation', () => {
    const f = fixture();
    f.install(f.global);
    expect(f.preflight().stdout).toContain(`RESOLVED_ROOT: ${f.global}`);
    const codexHome = path.join(f.home, 'custom codex');
    const custom = f.install(path.join(codexHome, 'skills/gstack'));
    const result = f.preflight({ CODEX_HOME: codexHome });
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${custom}`);
  });

  test('valid explicit runtime roots take priority and stale roots fall back locally', () => {
    const f = fixture();
    f.install(f.local);
    const explicit = f.install(path.join(f.home, 'explicit runtime'));
    expect(f.preflight({ GSTACK_ROOT: explicit }).stdout).toContain(`RESOLVED_ROOT: ${explicit}`);
    expect(f.preflight({ GSTACK_BIN: path.join(explicit, 'bin') }).stdout).toContain(`RESOLVED_ROOT: ${explicit}`);
    const result = f.preflight({ GSTACK_ROOT: '/missing/gstack', GSTACK_BIN: '/missing/gstack/bin' });
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
  });

  test('missing CLI reports not_installed rather than an import-path failure', () => {
    const f = fixture();
    f.install(f.local);
    const result = f.preflight({ GSTACK_CLAUDE_BIN: 'missing-gstack-claude-fixture-command' });
    expect(result.stdout).toContain('CODEX_MODE: not_installed');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('master switch is read from the discovered runtime before outside dispatch', () => {
    const f = fixture();
    f.install(f.local);
    const config = spawnSync(path.join(ROOT, 'bin/gstack-config'), ['set', 'codex_reviews', 'disabled'], {
      cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 5000,
    });
    expect(config.status).toBe(0);
    const command = outsideVoicePreflight(f.ctx, { disabledBehavior: 'codex-only' }).match(/```bash\n([\s\S]*?)\n```/)![1];
    const result = f.run(command);
    expect(result.stdout).toContain('CODEX_MODE: disabled');
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('invocation independently discovers runtime and sends the literal prompt', () => {
    const f = fixture();
    f.install(f.local);
    const prompt = path.join(f.repo, "prompt ' literal.txt");
    fs.writeFileSync(prompt, 'Review literal $(touch NEVER) and `touch NEVER` text.');
    const command = outsideVoiceCommand(f.ctx, { promptFile: prompt, timeoutMs: 3000 });
    const result = f.run(command);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OUTSIDE_STATUS: completed provider=claude-code host=codex');
    expect(JSON.parse(fs.readFileSync(f.capture, 'utf8')).prompt).toBe(fs.readFileSync(prompt, 'utf8'));
    expect(fs.existsSync(path.join(f.repo, 'NEVER'))).toBe(false);
  });
});
