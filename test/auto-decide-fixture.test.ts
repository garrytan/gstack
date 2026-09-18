/** Real preamble/preference checks for the explicit AUTO_DECIDE state override. */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedHermeticGstackHome } from './helpers/hermetic-env';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import selectorCapture from './fixtures/auto-decide-mode-selector-749df.json';

const ROOT = path.resolve(import.meta.dir, '..');
const TARGET = 'plan-ceo-review-mode';
const UNRELATED = 'feature-continuous-checkpoint';

function withFixture(check: (fixture: {
  state: string;
  home: string;
  preferenceFile: string;
  run: (bin: string, args?: string[], input?: string) => string;
}) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-decide-fixture-'));
  try {
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    const tmp = path.join(root, 'tmp');
    for (const dir of [project, home, state, tmp]) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(home, '.gstack'));
    fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), 'operator sentinel\n');
    const env = {
      PATH: process.env.PATH!, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      GSTACK_HOME: state, CONDUCTOR_WORKSPACE_PATH: project,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: project, env, stdio: 'pipe', timeout: 10_000 });
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Test project\n\n## Skill routing\n\n- Review plans with /plan-ceo-review.\n');
    const run = (bin: string, args: string[] = [], input?: string): string =>
      execFileSync(path.join(ROOT, 'bin', bin), args, {
        cwd: project, env, input, encoding: 'utf8', timeout: 10_000,
      });

    // Same explicit baseline as the paid case; never seed a blanket preference.
    seedHermeticGstackHome(state);
    run('gstack-config', ['set', 'question_tuning', 'true']);
    run('gstack-config', ['set', 'cross_project_learnings', 'false']);
    run('gstack-question-preference', ['--write', JSON.stringify({
      question_id: TARGET, preference: 'never-ask', source: 'plan-tune',
    })]);
    const rawSlug = run('gstack-slug').match(/SLUG=([^\s;]+)/)?.[1];
    if (!rawSlug) throw new Error('Fixture project slug was not emitted');
    const slug = rawSlug.replace(/['"]/g, '');
    const preferenceFile = path.join(state, 'projects', slug, 'question-preferences.json');
    check({ state, home, preferenceFile, run });
    expect(fs.readFileSync(path.join(home, '.gstack', 'config.yaml'), 'utf8')).toBe('operator sentinel\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('AUTO_DECIDE explicit fixture state', () => {
  test('actual paid setup declines cross-project sharing while preserving only the mode preference', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-decide-body-'));
    const script = path.join(dir, 'body.fixture.test.ts');
    const factsFile = path.join(dir, 'facts.json');
    fs.mkdirSync(path.join(dir, '.gstack'));
    const operatorConfig = path.join(dir, '.gstack', 'config.yaml');
    fs.writeFileSync(operatorConfig, 'operator sentinel\n');
    const legacyTask = path.join(dir, '.gstack', 'projects', 'project', 'tasks-ceo-review-20260909-081225.jsonl');
    fs.mkdirSync(path.dirname(legacyTask), { recursive: true });
    fs.writeFileSync(legacyTask, 'prior-run task sentinel\n');
    fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)};
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => describe }));
mock.module(path.join(root, 'test/helpers/claude-pty-runner.ts'), () => ({
  runPlanSkillObservation: async opts => {
    expect(typeof opts.cwd).toBe('string');
    expect(opts.requireProseEvidence).toBe(true);
    expect(opts.env.DISABLE_AUTOUPDATER).toBe('1');
    expect(opts.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(opts.autoDecisionState.stateRoot).toBe(fs.realpathSync(opts.env.GSTACK_STATE_ROOT));
    expect(opts.cwd).not.toBe(root);
    // Execute the actual paid callback: both the saved draft and seed sent to
    // the observer must declare its audit interface before any model starts.
    expect(fs.readFileSync(path.join(opts.cwd, 'PLAN.md'), 'utf8')).toBe(opts.initialPlanContent);
    expect(opts.initialPlanContent).toMatch(/full selected mode name[\\s\\S]*user_choice and recommended/);
    expect(opts.initialPlanContent).toContain('public decision');
    expect(opts.initialPlanContent).toContain('No review mode has\\nbeen selected.');
    expect(opts.initialPlanContent).not.toMatch(/HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION/);
    const run = (bin, args) => execFileSync(path.join(root, 'bin', bin), args, {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8', timeout: 10000,
    }).trim();
    const slug = run('gstack-slug', []).match(/SLUG=([^\\s;]+)/)?.[1].replace(/['\"]/g, '');
    const facts = { cwd: opts.cwd, state: opts.env.GSTACK_HOME, slug,
      crossProject: run('gstack-config', ['get', 'cross_project_learnings']),
      target: run('gstack-question-preference', ['--check', ${JSON.stringify(TARGET)}]),
      unrelated: run('gstack-question-preference', ['--check', ${JSON.stringify(UNRELATED)}]),
    };
    const prior = fs.existsSync(${JSON.stringify(factsFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(factsFile)}, 'utf8')) : [];
    fs.writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify([...prior, facts]));
    expect(opts.autoDecisionState.projectSlug).toBe(slug);
    expect(slug).toBe(path.basename(opts.cwd));
    expect(slug).not.toBe('project');
    expect(fs.existsSync(path.join(process.env.HOME, '.gstack', 'projects', slug, 'tasks-ceo-review-20260909-081225.jsonl'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(opts.env.GSTACK_HOME, 'projects', slug, 'question-preferences.json'), 'utf8')))
      .toEqual({ ${JSON.stringify(TARGET)}: 'never-ask' });
    expect(facts.target).toBe('AUTO_DECIDE');
    expect(facts.unrelated).toBe('ASK_NORMALLY');
    expect(facts.crossProject).toBe('false');
    return { outcome: 'auto_decided', evidence: 'controlled observation', answered: [] };
  },
}));
await import(path.join(root, 'test/skill-e2e-auto-decide-preserved.test.ts'));
`);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = spawnSync(process.execPath, ['test', script], {
          cwd: ROOT, encoding: 'utf8', timeout: 15_000,
          env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir,
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig'),
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.status, child.stdout + child.stderr).toBe(0);
      }
      const attempts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map(fact => fact.slug)).size).toBe(2);
      for (const facts of attempts) {
        expect(fs.existsSync(facts.cwd)).toBe(false);
        expect(fs.existsSync(facts.state)).toBe(false);
      }
      expect(fs.readFileSync(legacyTask, 'utf8')).toBe('prior-run task sentinel\n');
      expect(fs.readFileSync(operatorConfig, 'utf8')).toBe('operator sentinel\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  test('normal baseline reaches the target preference without unrelated onboarding', () => {
    withFixture(({ preferenceFile, run }) => {
      const output = run('gstack-skill-start', ['--skill', 'plan-ceo-review']);
      expect(output).toContain('SKILL_START_PROTO: 1');
      expect(output).toContain('SESSION_KIND: interactive');
      expect(output).toContain('CONDUCTOR_SESSION: true');
      expect(output).toContain('QUESTION_TUNING: true');
      expect(output).toContain('UPDATE_CHECK: false');
      expect(output).not.toContain('GSTACK_INSTRUCTION_BEGIN:');
      expect(run('gstack-config', ['get', 'cross_project_learnings'])).toBe('false');
      expect(run('gstack-question-preference', ['--check', TARGET, '--summary-stdin'], 'Choose the CEO review mode')).toBe('AUTO_DECIDE\n');
      expect(run('gstack-question-preference', ['--check', UNRELATED, '--summary-stdin'], 'Enable continuous checkpoint auto-commits?')).toBe('ASK_NORMALLY\n');
      expect(JSON.parse(fs.readFileSync(preferenceFile, 'utf8'))).toEqual({ [TARGET]: 'never-ask' });
    });
  });

  test('the missing checkpoint marker reproduces the unrelated question from both paid failures', () => {
    withFixture(({ state, run }) => {
      fs.unlinkSync(path.join(state, '.feature-prompted-continuous-checkpoint'));
      const output = run('gstack-skill-start', ['--skill', 'plan-ceo-review']);
      expect(output).toContain('GSTACK_INSTRUCTION_BEGIN: feature-checkpoint ');
      expect(output).toContain('Feature discovery: AskUserQuestion for Continuous checkpoint auto-commits.');
      expect(run('gstack-question-preference', ['--check', TARGET])).toBe('AUTO_DECIDE\n');
      expect(run('gstack-question-preference', ['--check', UNRELATED])).toBe('ASK_NORMALLY\n');
    });
  });

  test('seeding refuses existing state and a symlink instead of resetting its target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-decide-seed-'));
    try {
      const state = path.join(root, 'state');
      const alias = path.join(root, 'alias');
      fs.mkdirSync(state);
      fs.writeFileSync(path.join(state, 'config.yaml'), 'operator sentinel\n');
      fs.symlinkSync(state, alias, 'dir');
      expect(() => seedHermeticGstackHome(state)).toThrow('private, existing empty directory');
      expect(() => seedHermeticGstackHome(alias)).toThrow('private, existing empty directory');
      expect(fs.readdirSync(state)).toEqual(['config.yaml']);
      expect(fs.readFileSync(path.join(state, 'config.yaml'), 'utf8')).toBe('operator sentinel\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const selectorClone = () => structuredClone(selectorCapture) as any;
const decideSelector = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);

function fullModeAudit() {
  const f = selectorClone();
  // Synthetic producer output under the newly declared fixture interface.
  // Preserve the original C/C record; no historical retry becomes a pass.
  const row = f.options.stateEvidence.records[0];
  row.user_choice = row.recommended = 'HOLD SCOPE';
  const request = f.tools.find((e: any) => e.kind === 'use' && e.toolUseId === 'toolu_01U1wW11UNCTAvCsbL4MH5AR');
  request.input.command = request.input.command.replaceAll('"user_choice":"C"', '"user_choice":"HOLD SCOPE"')
    .replaceAll('"recommended":"C"', '"recommended":"HOLD SCOPE"');
  return f;
}

test('retained C/C audit has no authenticated selector-to-mode mapping', () => {
  const f = selectorClone();
  expect(f.options.stateEvidence.records[0].user_choice).toBe('C');
  expect(f.options.stateEvidence.records[0].recommended).toBe('C');
  expect(f.transcript.calls).toEqual([]);
  expect(decideSelector(f)).toBeNull();
});

test('full mode names are supported by the unchanged generic logger, alongside option keys', () => {
  withFixture(({ preferenceFile, run }) => {
    const choices = ['C', 'HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'];
    for (const choice of choices) {
      run('gstack-question-log', [JSON.stringify({ ...selectorCapture.options.stateEvidence.records[0],
        user_choice: choice, recommended: choice })]);
    }
    const rows = fs.readFileSync(path.join(path.dirname(preferenceFile), 'question-log.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.user_choice)).toEqual(choices);
    expect(rows.map(row => row.recommended)).toEqual(choices);
    expect(rows.every(row => row.auto_decided === true && row.followed_recommendation === true)).toBe(true);
  });
});

test('synthetic full-name request and owned append authenticate the unchanged retry declaration', () => {
  const f = fullModeAudit();
  const result = decideSelector(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.stateRecord).toEqual(f.options.stateEvidence.records[0]);
  expect(result?.annotation).toBe(f.transcript.assistantMessages.at(-1).text);
  expect(selectorCapture.options.stateEvidence.records[0].user_choice).toBe('C');
});

for (const [name, mutate] of Object.entries({
  'missing record': (f: any) => { f.options.stateEvidence.records = []; },
  'missing owned state': (f: any) => { delete f.options.stateEvidence; },
  'foreign session': (f: any) => { f.options.stateEvidence.records[0].session_id = 'foreign'; },
  'foreign skill': (f: any) => { f.options.stateEvidence.records[0].skill = 'plan-eng-review'; },
  'foreign question': (f: any) => { f.options.stateEvidence.records[0].question_id = 'plan-eng-review-mode'; },
  'nonautomatic record': (f: any) => { f.options.stateEvidence.records[0].auto_decided = false; },
  'contradictory recommendation': (f: any) => { f.options.stateEvidence.records[0].recommended = 'SCOPE EXPANSION'; },
  'contradictory declaration': (f: any) => { f.transcript.assistantMessages.at(-1).text += '\n\nMode: SCOPE EXPANSION.'; },
  'duplicate record': (f: any) => { f.options.stateEvidence.records.push({ ...f.options.stateEvidence.records[0] }); },
  'unmapped selector': (f: any) => { f.options.stateEvidence.records[0].user_choice = f.options.stateEvidence.records[0].recommended = 'C'; },
  'different preference': (f: any) => { f.options.stateEvidence.preference = 'always-ask'; },
})) test(`full-name fixture evidence still rejects ${name}`, () => {
  const f = fullModeAudit(); mutate(f); expect(decideSelector(f)).toBeNull();
});
