/**
 * GST-470: the router failure-routing eval's arms. GSTACK_ROUTER_ARM is
 * current (the default), before or none, and anything else throws. The none arm
 * builds a repository with no installed skills and a prompt that is the user's
 * request alone. The current and before arms' prompts and repositories are byte
 * for byte what main built (the reference copies below, from
 * test/skill-e2e-failure-routing.test.ts at 0cd2b4a).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURES, makeRepo, plainMetrics, routerArm, routerPrompt, type Fixture } from './helpers/failure-routing-fixture';
import { extractSkillHead, sliceBetween } from './helpers/skill-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const BASE = 'HEAD';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function mainRouterSection(arm: 'before' | 'current'): string {
  const skill = arm === 'before'
    ? spawnSync('git', ['show', `${BASE}:SKILL.md`], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).stdout
    : fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  return sliceBetween(skill, '## Route first', 'Best-effort, record') + sliceBetween(skill, '**Routing rules', 'If the user opts out');
}

function mainPrompt(fixture: Fixture, arm: 'before' | 'current'): string {
  return `The user invoked the gstack router skill (/gstack) in this repository. The router's instructions:\n\n${mainRouterSection(arm)}\n\nThe user's request: "${fixture.request}"`;
}

function mainMakeRepo(fixture: Fixture): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-routing-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'bun test' } }, null, 2));
  for (const [file, body] of Object.entries(fixture.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  for (const skill of ['investigate', 'qa', 'review', 'ship']) {
    fs.mkdirSync(path.join(repo, '.claude', 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', skill, 'SKILL.md'), extractSkillHead(path.join(ROOT, skill, 'SKILL.md')));
  }
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { cwd: repo, timeout: 10_000 });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return repo;
}

/** Every file under dir except .git, path → contents, plus the committed file list. */
function tree(dir: string): { files: Record<string, string>; committed: string } {
  dirs.push(dir);
  const files: Record<string, string> = {};
  for (const rel of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
    if (rel === '.git' || rel.startsWith('.git' + path.sep)) continue;
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isFile()) files[rel] = fs.readFileSync(abs, 'utf8');
  }
  const committed = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout;
  return { files, committed };
}

describe('router arms (GST-470)', () => {
  test('GSTACK_ROUTER_ARM: unset is current; before, current and none parse; anything else throws', () => {
    expect(routerArm({})).toBe('current');
    for (const arm of ['before', 'current', 'none'] as const) expect(routerArm({ GSTACK_ROUTER_ARM: arm })).toBe(arm);
    for (const bad of ['nonee', 'Current', 'after', '']) {
      expect(() => routerArm({ GSTACK_ROUTER_ARM: bad })).toThrow('must be before, current or none, got ' + bad);
    }
  });

  test('none: the repository has no installed skills and the prompt is the request alone', () => {
    for (const fixture of FIXTURES) {
      const repo = tree(makeRepo(fixture, 'none'));
      const reference = tree(mainMakeRepo(fixture));
      expect(Object.keys(repo.files).some(f => f.startsWith('.claude'))).toBe(false);
      const withoutSkills = Object.fromEntries(Object.entries(reference.files).filter(([f]) => !f.startsWith('.claude')));
      expect(repo.files).toEqual(withoutSkills);
      const prompt = routerPrompt(fixture, 'none');
      expect(prompt).toBe(fixture.request);
      for (const word of ['## Route first', '**Routing rules', 'gstack', 'router', 'skill', '/investigate']) expect(prompt).not.toContain(word);
    }
  });

  test('current and before: prompts and repositories are byte-identical to main', () => {
    for (const fixture of FIXTURES) {
      for (const arm of ['current', 'before'] as const) expect(routerPrompt(fixture, arm, BASE)).toBe(mainPrompt(fixture, arm));
      for (const arm of ['current', 'before'] as const) expect(tree(makeRepo(fixture, arm))).toEqual(tree(mainMakeRepo(fixture)));
    }
  });

  test('plain metrics count read-only calls before the first edit', () => {
    const call = (tool: string, input: Record<string, unknown> = {}) => ({ tool, input, output: '' });
    expect(plainMetrics([])).toMatchObject({ editedBeforeRead: false, readsBeforeEdit: 0 });
    expect(plainMetrics([call('Read'), call('Grep'), call('Edit'), call('Read')])).toMatchObject({ editedBeforeRead: false, readsBeforeEdit: 2 });
    expect(plainMetrics([call('Edit'), call('Read')])).toMatchObject({ editedBeforeRead: true, readsBeforeEdit: 0 });
    expect(plainMetrics([call('Bash', { command: "sed -i 's/ /-/' src/slug.js" }), call('Read')])).toMatchObject({ editedBeforeRead: true, readsBeforeEdit: 0 });
    expect(plainMetrics([call('Bash', { command: 'bun test' }), call('Skill', { skill: 'investigate' }), call('Write')]))
      .toMatchObject({ editedBeforeRead: false, readsBeforeEdit: 1, sequence: 'Bash → Skill(investigate) → Write' });
  });
});
