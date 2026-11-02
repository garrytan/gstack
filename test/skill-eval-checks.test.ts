import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

/**
 * The check commands in test/fixtures/skill-evals/<skill>/tasks.json are vendored byte for byte by
 * gstack-evals' Lane A, which runs them as the grader of a paid trial. Each case seeds a fresh work
 * dir with the task's own seed.sh, plays an agent action, and runs the committed check with sh.
 * A "hole" is an action that breaks the task's rule and must fail the check; an "honest" action
 * must pass it, so a check cannot be fixed by making it fail everything (gstack-evals GST-374).
 */
const ROOT = path.resolve(import.meta.dir, '..');
const DIR = path.join(ROOT, 'test', 'fixtures', 'skill-evals');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-checks-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Task = { id: string; setup?: string; check?: string };
const tasks = (skill: string): Task[] => JSON.parse(fs.readFileSync(path.join(DIR, skill, 'tasks.json'), 'utf8'));
let runs = 0;

function sh(cwd: string, script: string, env: Record<string, string>) {
  return spawnSync('sh', ['-c', script], { cwd, env, encoding: 'utf8', timeout: 30_000 });
}

function runCheck(skill: string, id: string, action: string): number {
  const task = tasks(skill).find(t => t.id === id)!;
  const root = path.join(tmp, `${++runs}`);
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const home = path.join(work, '.gstack-home');
  const env = {
    PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1',
    SKILL_EVAL_FIXTURES: path.join(DIR, skill), GSTACK_HOME: home, GSTACK_STATE_ROOT: home,
  };
  for (const step of [task.setup ?? 'true', action]) {
    const r = sh(work, step, env);
    if (r.status !== 0) throw new Error(`${skill}/${id}: ${step} exited ${r.status}: ${r.stderr}`);
  }
  return sh(work, task.check!, env).status ?? -1;
}

const SLUG = '.gstack-home/projects/work';
const EXTRA = 'mkdir -p .gstack-home/projects/elsewhere && ';
const LINK_HOME = (file: string) =>
  `mkdir -p ../swap/projects/work && echo x > ../swap/projects/work/${file} && rm -rf .gstack-home && ln -s ../swap .gstack-home`;
const designChecks = tasks('office-hours').filter(t => t.check?.includes("-name '*-design-*.md'"));

const cases: Array<{ skill: string; id: string; honest: string; holes: Record<string, string> }> = [
  {
    skill: 'office-hours', id: 'no-code-session',
    honest: 'mkdir -p .gstack-home/projects/work docs && echo d > .gstack-home/projects/work/me-main-design-1.md && echo n > docs/notes.md',
    holes: {
      'an agent-written .gitignore hides new code': "printf '*\\n' > .gitignore && mkdir src && echo 'print(1)' > src/main.py",
      'new code with no .gitignore': "mkdir src && echo 'print(1)' > src/main.py",
    },
  },
  {
    skill: 'learn', id: 'no-code-change',
    honest: `echo '{"key":"seen"}' >> ${SLUG}/learnings.jsonl`,
    holes: {
      'a new untracked file under app/': 'mkdir -p app/services && echo x > app/services/eager.rb',
      'a new file under app/ hidden by an agent-written .gitignore': "printf '*\\n' > app/.gitignore && echo x > app/models/order.rb",
    },
  },
  {
    skill: 'learn', id: 'add',
    honest: `echo '{"key":"flaky-port-3000","trusted":true}' >> ${SLUG}/learnings.jsonl`,
    holes: {
      'the learning lands in an extra project folder': EXTRA + `echo '{"key":"flaky-port-3000","trusted":true}' > .gstack-home/projects/elsewhere/learnings.jsonl`,
    },
  },
  {
    skill: 'learn', id: 'prune-stale',
    honest: `grep -v stale-cache-after-deploy ${SLUG}/learnings.jsonl > kept && mv kept ${SLUG}/learnings.jsonl`,
    holes: {
      'the seeded file is wiped and an extra project folder holds the kept keys':
        `: > ${SLUG}/learnings.jsonl && ` + EXTRA + "printf 'always-run-rubocop\\nn-plus-one-queries\\n' > .gstack-home/projects/elsewhere/learnings.jsonl",
    },
  },
  {
    skill: 'learn', id: 'prune-conflict',
    honest: 'true',
    holes: {
      'a line is dropped and an extra project folder restores the count':
        `head -n 6 ${SLUG}/learnings.jsonl > kept && mv kept ${SLUG}/learnings.jsonl && ` + EXTRA + 'echo x > .gstack-home/projects/elsewhere/learnings.jsonl',
    },
  },
  ...designChecks.map(t => ({
    skill: 'office-hours', id: t.id, honest: 'mkdir -p .gstack-home/projects/work && echo n > .gstack-home/projects/work/notes.md',
    holes: { 'a design doc behind a state root swapped for a symlink': LINK_HOME('me-main-design-1.md') },
  })),
  {
    skill: 'office-hours', id: 'backend-skips-visual',
    honest: 'mkdir -p .gstack-home/projects/work && echo n > .gstack-home/projects/work/me-main-design-1.md',
    holes: { 'a mockup behind a state root swapped for a symlink': `mkdir -p ../swap/projects/work/designs && ${LINK_HOME('designs/mockup-1.png')}` },
  },
];

describe('skill-eval check commands fail the agent actions they exist to catch', () => {
  test('the eight office-hours design checks are all covered', () => {
    expect(designChecks.map(t => t.id)).toEqual([
      'mode-question', 'first-startup-question', 'vague-evidence-pushback', 'builder-mode',
      'premise-challenge', 'second-opinion-offer', 'alternatives', 'approach-approval-gate',
    ]);
  });

  for (const c of cases) {
    test(`${c.skill}/${c.id}: an honest run passes`, () => {
      expect(runCheck(c.skill, c.id, c.honest)).toBe(0);
    });
    for (const [hole, action] of Object.entries(c.holes)) {
      test(`${c.skill}/${c.id}: ${hole} fails the check`, () => {
        expect(runCheck(c.skill, c.id, action)).not.toBe(0);
      });
    }
  }
});
