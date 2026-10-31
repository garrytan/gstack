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
import { priorSet, readTaskFiles, supersede, SupersedeRefused } from '../lib/tasks-prior';

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
const tasks = (cmd: string[], cwd: string) => spawnSync('bun', [BIN, ...cmd], { cwd, encoding: 'utf8', timeout: 30_000 });

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

describe('gstack-tasks start, add and close', () => {
  test('a rerun carries one task, closes the other, and the aggregate shows only the reconciled list', () => {
    const w = world();
    const R1 = '20261031T100000Z-1';
    fs.writeFileSync(path.join(w.dir, 'tasks-eng-review-feature-x-20261031-100000.jsonl'), row(R1, 'T1', 'add retry', w.commit) + '\n' + row(R1, 'T2', 'add metrics', w.commit) + '\n');
    const prior = tasks(['prior', '--phase', 'eng-review', '--dir', w.dir], w.repo).stdout;
    expect(prior).toContain('PRIOR_TASKS: ');
    expect(prior).toMatch(/RECONCILE: .*--carried-from 20261031T100000Z-1\/<id>.*close --phase eng-review --prior 20261031T100000Z-1\/<id> --done <commit>.*supersede --phase eng-review --keep/);
    const start = tasks(['start', '--phase', 'eng-review', '--dir', w.dir], w.repo);
    const vars = Object.fromEntries(start.stdout.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 2, -1)]));
    expect(path.basename(vars.TASKS_FILE!)).toMatch(/^tasks-eng-review-feature-x-\d{8}-\d{6}\.jsonl$/);
    expect(fs.readFileSync(vars.TASKS_FILE!, 'utf8')).toBe('');
    const title = 'retry "quoted"\nwith a \\ backslash';
    const add = tasks(['add', '--file', vars.TASKS_FILE!, '--run', vars.RUN_ID!, '--id', 'T1', '--priority', 'P1', '--component', 'demo', '--title', title, '--source', 'f', '--effort-human', '~1h', '--effort-cc', '~5min', '--files', '["a.ts"]', '--carried-from', `${R1}/T1`], w.repo);
    expect(add.status).toBe(0);
    const written = JSON.parse(fs.readFileSync(vars.TASKS_FILE!, 'utf8'));
    expect(written).toMatchObject({ phase: 'eng-review', run_id: vars.RUN_ID, branch: BRANCH, commit: w.commit, id: 'T1', title, files: ['a.ts'], carried_from: `${R1}/T1` });
    const close = tasks(['close', '--phase', 'eng-review', '--prior', `${R1}/T2`, '--done', w.commit, '--dir', w.dir], w.repo);
    expect(close.stdout).toStartWith(`CLOSED: ${R1}/T2 done `);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'task-dispositions-eng-review-feature-x.jsonl'), 'utf8'))).toMatchObject({ prior: `${R1}/T2`, disposition: 'done', reason: w.commit, branch: BRANCH });
    expect(tasks(['supersede', '--phase', 'eng-review', '--keep', vars.TASKS_FILE!, '--dir', w.dir], w.repo).stdout).toContain('SUPERSEDED: ');
    const agg = aggregate(w);
    expect(agg).toContain('with a');
    expect(agg).not.toContain('add metrics');
  });

  test('add refuses a file that is not a phase list and a --files value that is not a string array', () => {
    const w = world();
    const base = ['--run', 'R', '--id', 'T1', '--priority', 'P1', '--component', 'c', '--title', 't', '--source', 's', '--effort-human', 'h', '--effort-cc', 'c'];
    const wrongFile = tasks(['add', '--file', path.join(w.dir, 'notes.jsonl'), ...base, '--files', '[]'], w.repo);
    expect(wrongFile.status).toBe(3);
    expect(wrongFile.stderr).toContain('TASKS_SUPERSEDE_REFUSED');
    expect(tasks(['add', '--file', path.join(w.dir, 'tasks-eng-review-x.jsonl'), ...base, '--files', '[1]'], w.repo).status).toBe(3);
    expect(tasks(['close', '--phase', 'eng-review', '--prior', 'R1/T2', '--dir', w.dir], w.repo).status).toBe(2);
    expect(fs.existsSync(path.join(w.dir, 'notes.jsonl'))).toBe(false);
  });
});

describe('the rendered emit block', () => {
  test('every plan review reads the prior list and writes through gstack-tasks', () => {
    for (const [skill, phase] of [['plan-eng-review', 'eng-review'], ['plan-ceo-review', 'ceo-review'], ['plan-design-review', 'design-review'], ['plan-devex-review', 'devex-review']] as const) {
      const out = generateTasksSectionEmit({ skillName: skill } as TemplateContext, [phase]);
      expect(out).toContain(`gstack-tasks prior --phase ${phase}`);
      expect(out).toContain(`gstack-tasks start --phase ${phase}`);
      expect(out).toContain('gstack-tasks add --file "$TASKS_FILE" --run "$RUN_ID"');
      expect(out).toContain('--carried-from');
      expect(out).not.toContain('jq -nc');
    }
  });
});
