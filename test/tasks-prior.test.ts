/**
 * G2 (#1791): a rerun of a plan review reconciles the last task list instead
 * of writing a second, conflicting one. Bug on main: /autoplan's aggregator
 * keeps only the newest run_id per phase, so run 1's open task vanishes when
 * run 2 lists something else, and a rerun that closes every task (an empty
 * list) leaves run 1's stale tasks showing. These tests run the real rendered
 * aggregator block against fixture lists.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateTasksSectionAggregate, generateTasksSectionEmit } from '../scripts/resolvers/tasks-section';
import type { TemplateContext } from '../scripts/resolvers/types';
import { addRows, priorSet, readTaskFiles, supersede, SupersedeRefused } from '../lib/tasks-prior';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-tasks');
const BRANCH = 'feature/x';

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-prior-'));
  const repo = path.join(home, 'repo');
  const dir = path.join(home, '.gstack', 'projects', 'demo');
  fs.mkdirSync(repo); fs.mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q', '-b', BRANCH);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'seed');
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  const bin = path.join(home, '.claude', 'skills', 'gstack', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gstack-paths'), `#!/bin/sh\necho ${path.join(home, '.gstack')}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gstack-slug'), '#!/bin/sh\n[ "$2" = SLUG ] && echo demo || echo feature-x\n', { mode: 0o755 });
  return { home, repo, dir, commit };
}

const row = (run: string, id: string, title: string, commit: string, extra: Record<string, unknown> = {}) => JSON.stringify({ phase: 'eng-review', run_id: run, branch: BRANCH, commit, id, priority: 'P1', component: 'demo', files: ['a.ts'], effort_human: '~1h', effort_cc: '~5min', title, source_finding: 'f', ...extra });

function aggregate(w: ReturnType<typeof world>): string {
  const block = /```bash\n([\s\S]*?)\n```/.exec(generateTasksSectionAggregate({} as TemplateContext))![1]!;
  const r = spawnSync('bash', ['-c', `${block}\nprintf '%s' "$AGGREGATED_TASKS"`], { cwd: w.repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: w.home } });
  return r.stdout;
}
const tasks = (cmd: string[], repo: string) => {
  const home = path.dirname(repo), state = path.join(home, '.gstack');
  return spawnSync('bun', [BIN, ...cmd], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, GSTACK_HOME: state, GSTACK_STATE_ROOT: state } });
};

describe('the bug on main: the aggregator keeps only the newest run', () => {
  test('run 2 listing other work hides run 1\'s open task; an empty rerun shows run 1\'s stale task', () => {
    const w = world();
    fs.writeFileSync(path.join(w.dir, 'tasks-eng-review-20261031-100000.jsonl'), row('R1', 'T1', 'add retry', w.commit) + '\n');
    fs.writeFileSync(path.join(w.dir, 'tasks-eng-review-20261031-110000.jsonl'), row('R2', 'T1', 'add metrics', w.commit) + '\n');
    expect(aggregate(w)).toContain('add metrics');
    expect(aggregate(w)).not.toContain('add retry');
    fs.writeFileSync(path.join(w.dir, 'tasks-eng-review-20261031-110000.jsonl'), '');
    expect(aggregate(w)).toContain('add retry');
  });
});

describe('gstack-tasks prior and supersede', () => {
  test('prior finds this branch\'s newest earlier list by row fields, across legacy file names', () => {
    const w = world();
    fs.writeFileSync(path.join(w.dir, 'tasks-eng-review-20261031-100000.jsonl'), [row('R1', 'T1', 'old', w.commit), row('R1', 'T2', 'other branch', w.commit, { branch: 'main' })].join('\n') + '\n');
    fs.writeFileSync(path.join(w.dir, 'tasks-eng-review-feature-x-20261031-110000.jsonl'), row('R2', 'T1', 'add retry', w.commit) + '\nnot json\n');
    fs.writeFileSync(path.join(w.dir, 'tasks-ceo-review-feature-x-20261031-120000.jsonl'), JSON.stringify({ phase: 'ceo-review', run_id: 'R9', branch: BRANCH, id: 'T1' }) + '\n');
    const r = tasks(['prior', '--phase', 'eng-review', '--branch', BRANCH, '--dir', w.dir], w.repo);
    expect(r.stdout.split('\n')[0]).toBe(`PRIOR_TASKS: ${path.join(w.dir, 'tasks-eng-review-feature-x-20261031-110000.jsonl')} run=R2 tasks=1`);
    expect(r.stdout).toContain('"title":"add retry"');
    expect(r.stderr).toContain('PRIOR_TASKS_MALFORMED: ');
    expect(tasks(['prior', '--phase', 'eng-review', '--branch', 'nope', '--dir', w.dir], w.repo).stdout.trim()).toBe('PRIOR_TASKS: none');
    expect(tasks(['prior', '--phase', 'eng-review', '--branch', BRANCH, '--dir', path.join(w.home, 'missing')], w.repo).stdout.trim()).toBe('PRIOR_TASKS: none');
    expect(tasks(['prior', '--phase', 'eng', '--branch', BRANCH, '--dir', w.dir], w.repo).status).toBe(2);
  });

  test('a carried task survives the rerun and a zero-open rerun clears the aggregate', () => {
    const w = world();
    const first = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(first, [row('R1', 'T1', 'add retry', w.commit), row('R1', 'T2', 'rename flag', w.commit)].join('\n') + '\n');
    const second = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-110000.jsonl');
    fs.writeFileSync(second, [row('R2', 'T1', 'add retry', w.commit, { carried_from: 'R1/T1' }), row('R2', 'T2', 'add metrics', w.commit)].join('\n') + '\n');
    const s = tasks(['supersede', '--phase', 'eng-review', '--branch', BRANCH, '--dir', w.dir, '--keep', second], w.repo);
    expect(s.stdout).toBe(`SUPERSEDED: ${first}\n`);
    expect(fs.existsSync(path.join(w.dir, 'superseded-tasks-eng-review-feature-x-20261031-100000.jsonl'))).toBe(true);
    const agg = aggregate(w);
    expect(agg).toContain('add retry');
    expect(agg).toContain('add metrics');
    expect(agg).not.toContain('rename flag');

    const third = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-120000.jsonl');
    fs.writeFileSync(third, '');
    expect(tasks(['supersede', '--phase', 'eng-review', '--branch', BRANCH, '--dir', w.dir, '--keep', third], w.repo).stdout).toBe(`SUPERSEDED: ${second}\n`);
    expect(aggregate(w)).not.toContain('add retry');
  });

  test('another phase, a mixed-branch legacy file and a newer run stay live; a bad --keep moves nothing', () => {
    const w = world();
    const ceo = path.join(w.dir, 'tasks-ceo-review-feature-x-20261031-090000.jsonl');
    fs.writeFileSync(ceo, JSON.stringify({ phase: 'ceo-review', run_id: 'R0', branch: BRANCH, id: 'T1' }) + '\n');
    const mixed = path.join(w.dir, 'tasks-eng-review-20261031-080000.jsonl');
    fs.writeFileSync(mixed, [row('R0', 'T1', 'a', w.commit), row('R0', 'T2', 'b', w.commit, { branch: 'main' })].join('\n') + '\n');
    const keep = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(keep, row('R2', 'T1', 'x', w.commit) + '\n');
    const newer = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-110000.jsonl');
    fs.writeFileSync(newer, row('R3', 'T1', 'y', w.commit) + '\n');
    const r = supersede(w.dir, 'eng-review', BRANCH, keep);
    expect(r.moved).toEqual([]);
    expect(r.skipped.map(s => s.reason).sort()).toEqual(['holds another branch', 'newer than the kept list']);
    expect(fs.existsSync(ceo)).toBe(true);
    fs.writeFileSync(keep, row('R2', 'T1', 'x', w.commit, { branch: 'main' }) + '\n');
    expect(() => supersede(w.dir, 'eng-review', BRANCH, keep)).toThrow(SupersedeRefused);
    const refused = tasks(['supersede', '--phase', 'eng-review', '--branch', BRANCH, '--dir', w.dir, '--keep', keep], w.repo);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('(TASKS_SUPERSEDE_REFUSED)');
    expect(fs.existsSync(mixed) && fs.existsSync(newer)).toBe(true);
  });

  test('an interrupted supersede is finished by the next call', () => {
    const w = world();
    const old = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(old, row('R1', 'T1', 'a', w.commit) + '\n');
    fs.writeFileSync(path.join(w.dir, '.tasks-supersede-eng-review.pending'), JSON.stringify([[old, path.join(w.dir, 'superseded-' + path.basename(old))]]));
    expect(priorSet(readTaskFiles(w.dir, 'eng-review'), 'eng-review', BRANCH)?.run_id).toBe('R1');
    expect(tasks(['prior', '--phase', 'eng-review', '--branch', BRANCH, '--dir', w.dir], w.repo).stdout.trim()).toBe('PRIOR_TASKS: none');
    expect(fs.existsSync(path.join(w.dir, '.tasks-supersede-eng-review.pending'))).toBe(false);
  });
});

describe('gstack-tasks add', () => {
  const R1 = '20261031T100000Z-1';
  const rowsFile = (w: ReturnType<typeof world>) => {
    fs.mkdirSync(path.join(w.repo, '.gstack', 'tmp'), { recursive: true });
    return path.join(w.repo, '.gstack', 'tmp', 'tasks-eng-review-rows.jsonl');
  };
  const lists = (w: ReturnType<typeof world>) => fs.readdirSync(w.dir).filter(n => /^tasks-eng-review-.*\.jsonl$/.test(n));

  test('a rerun carries one task, closes the other, and the aggregate shows only the reconciled list', () => {
    const w = world();
    const prior = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(prior, row(R1, 'T1', 'add retry', w.commit) + '\n' + row(R1, 'T2', 'add metrics', w.commit) + '\n');
    expect(tasks(['prior', '--phase', 'eng-review', '--dir', w.dir], w.repo).stdout).toMatch(new RegExp(`RECONCILE: .*tasks-eng-review-rows\\.jsonl.*"carried_from": "${R1}/<id>".*"prior": "${R1}/<id>", "disposition": "done"`));
    const title = 'retry "quoted"\nwith a \\ backslash and $(id)';
    const task = (id: string, t: string, extra = {}) => JSON.stringify({ id, priority: 'P1', component: 'demo', title: t, source_finding: 'f', effort_human: '~1h', effort_cc: '~5min', files: ['a.ts'], ...extra });
    const rows = rowsFile(w);
    fs.writeFileSync(rows, [task('T1', title, { carried_from: `${R1}/T1` }), JSON.stringify({ prior: `${R1}/T2`, disposition: 'done', reason: w.commit }), task('T2', 'validate the rate limit')].join('\n') + '\n');
    const add = tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo);
    expect(add.status).toBe(0);
    const list = /^ADDED: tasks=2 dispositions=1 (.+)$/m.exec(add.stdout)![1]!;
    expect(path.basename(list)).toMatch(/^tasks-eng-review-feature-x-\d{8}-\d{6}\.jsonl$/);
    expect(add.stdout).toContain(`SUPERSEDED: ${prior}`);
    const written = fs.readFileSync(list, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(written[0]).toMatchObject({ phase: 'eng-review', branch: BRANCH, commit: w.commit, id: 'T1', title, files: ['a.ts'], carried_from: `${R1}/T1` });
    expect(written[0].run_id > R1).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'task-dispositions-eng-review-feature-x.jsonl'), 'utf8'))).toMatchObject({ prior: `${R1}/T2`, disposition: 'done', reason: w.commit, branch: BRANCH });
    expect(fs.existsSync(rows)).toBe(false);
    expect(fs.readFileSync(path.join(w.repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.gstack/tmp/');
    const agg = aggregate(w);
    expect(agg).toContain('with a');
    expect(agg).not.toContain('add metrics');
  });

  test('with no rows file and no earlier list, add writes an empty list (ran, no findings)', () => {
    const w = world();
    const add = tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo);
    expect(add.stdout).toMatch(/^ADDED: tasks=0 dispositions=0 /m);
    expect(lists(w)).toHaveLength(1);
    expect(fs.readFileSync(path.join(w.dir, lists(w)[0]!), 'utf8')).toBe('');
  });

  test('add refuses while an earlier task is neither carried nor closed, and both lists stay as they were', () => {
    const w = world();
    const prior = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(prior, row(R1, 'T1', 'add retry', w.commit) + '\n' + row(R1, 'T2', 'add metrics', w.commit) + '\n');
    fs.writeFileSync(rowsFile(w), JSON.stringify({ prior: `${R1}/T1`, disposition: 'done', reason: w.commit }) + '\n');
    const add = tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo);
    expect(add.status).toBe(3);
    expect(add.stderr).toContain(`TASKS_SUPERSEDE_REFUSED`);
    expect(add.stderr).toContain(`undecided: ${R1}/T2;`);
    expect(lists(w)).toEqual([path.basename(prior)]);
    expect(fs.existsSync(rowsFile(w))).toBe(true);
    fs.rmSync(rowsFile(w));
    expect(tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo).stderr).toContain(`undecided: ${R1}/T1, ${R1}/T2;`);
  });

  test('a dropped disposition is recorded with its reason and retires the prior list', () => {
    const w = world();
    const prior = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(prior, row(R1, 'T1', 'add retry', w.commit) + '\n');
    fs.writeFileSync(rowsFile(w), JSON.stringify({ prior: `${R1}/T1`, disposition: 'dropped', reason: 'out of scope' }) + '\n');
    const add = tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo);
    expect(add.stdout).toMatch(/^ADDED: tasks=0 dispositions=1 /m);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'task-dispositions-eng-review-feature-x.jsonl'), 'utf8'))).toMatchObject({ prior: `${R1}/T1`, disposition: 'dropped', reason: 'out of scope' });
    expect(fs.existsSync(path.join(w.dir, 'superseded-' + path.basename(prior)))).toBe(true);
    expect(aggregate(w)).not.toContain('add retry');
  });

  test('prior deletes a rows file an unfinished run left, so add never ingests stale rows', () => {
    const w = world();
    fs.writeFileSync(rowsFile(w), JSON.stringify({ id: 'T9', priority: 'P1', component: 'c', title: 'stale', source_finding: 's', effort_human: 'h', effort_cc: 'c', files: [] }) + '\n');
    expect(tasks(['prior', '--phase', 'eng-review', '--dir', w.dir], w.repo).stdout).toContain('PRIOR_TASKS: none');
    expect(fs.existsSync(rowsFile(w))).toBe(false);
    expect(tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo).stdout).toMatch(/^ADDED: tasks=0 dispositions=0 /m);
  });

  test('from a subdirectory, add excludes .gstack/tmp in the repository\'s own git dir and reads the root rows file', () => {
    const w = world();
    const sub = path.join(w.repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(rowsFile(w), JSON.stringify({ id: 'T1', priority: 'P1', component: 'c', title: 'from sub', source_finding: 's', effort_human: 'h', effort_cc: 'c', files: [] }) + '\n');
    const add = spawnSync('bun', [BIN, 'add', '--phase', 'eng-review', '--dir', path.relative(sub, w.dir)], { cwd: sub, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: w.home, GSTACK_HOME: path.join(w.home, '.gstack'), GSTACK_STATE_ROOT: path.join(w.home, '.gstack') } });
    expect(add.stdout).toMatch(/^ADDED: tasks=1 dispositions=0 /m);
    expect(fs.readFileSync(path.join(w.repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.gstack/tmp/');
    expect(fs.existsSync(path.join(w.home, '.git'))).toBe(false);
  });

  test('on a detached HEAD the rows carry an empty branch, as the /autoplan aggregator reads it', () => {
    const w = world();
    spawnSync('git', ['checkout', '-q', '--detach'], { cwd: w.repo, timeout: 10_000 });
    fs.writeFileSync(rowsFile(w), JSON.stringify({ id: 'T1', priority: 'P1', component: 'c', title: 'detached task', source_finding: 's', effort_human: 'h', effort_cc: 'c', files: [] }) + '\n');
    expect(tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo).status).toBe(0);
    expect(aggregate(w)).toContain('detached task');
  });

  test('a second add in the same second refuses and keeps its rows file', () => {
    const w = world();
    const t0 = new Date('2026-10-31T10:00:00Z');
    addRows(w.dir, 'eng-review', BRANCH, 'feature-x', w.commit, path.join(w.home, 'none.jsonl'), t0);
    const rows = path.join(w.home, 'rows.jsonl');
    fs.writeFileSync(rows, JSON.stringify({ id: 'T1', priority: 'P1', component: 'c', title: 't', source_finding: 's', effort_human: 'h', effort_cc: 'c', files: [] }) + '\n');
    expect(() => addRows(w.dir, 'eng-review', BRANCH, 'feature-x', w.commit, rows, t0)).toThrow(SupersedeRefused);
    expect(fs.existsSync(rows)).toBe(true);
  });

  test('add refuses an invalid rows file and writes nothing', () => {
    const w = world();
    const prior = path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl');
    fs.writeFileSync(prior, row(R1, 'T1', 'add retry', w.commit) + '\n');
    for (const bad of ['{"id":"T1"}', '{"id":"T1","priority":"P1","component":"c","title":"t","source_finding":"s","effort_human":"h","effort_cc":"c","files":[1]}', '{"prior":"T2","disposition":"done","reason":"x"}', '{"prior":"R/T2","disposition":"maybe","reason":"x"}', 'not json']) {
      fs.writeFileSync(rowsFile(w), bad + '\n');
      const r = tasks(['add', '--phase', 'eng-review', '--dir', w.dir], w.repo);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('TASKS_SUPERSEDE_REFUSED');
    }
    expect(lists(w)).toEqual([path.basename(prior)]);
  });
});

describe('the rendered emit block', () => {
  test('every plan review reads the prior list and writes through gstack-tasks with no free text on a command line', () => {
    for (const [skill, phase] of [['plan-eng-review', 'eng-review'], ['plan-ceo-review', 'ceo-review'], ['plan-design-review', 'design-review'], ['plan-devex-review', 'devex-review']] as const) {
      const out = generateTasksSectionEmit({ skillName: skill } as TemplateContext, [phase]);
      expect(out).toContain(`gstack-tasks prior --phase ${phase}`);
      expect(out).toContain(`.gstack/tmp/tasks-${phase}-rows.jsonl`);
      expect(out).toContain(`\`\`\`bash\n~/.claude/skills/gstack/bin/gstack-tasks add --phase ${phase}\n\`\`\``);
      expect(out).toContain('"carried_from":"<run_id>/<id>"');
      expect(out.match(/```bash/g)).toHaveLength(1);
    }
  });
});
