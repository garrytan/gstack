import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT, main } from '../lib/ci-audit/cli';
import type { Run } from '../lib/ci-audit/collect';
import { concurrencyFlag, lessonRunners } from '../lib/ci-audit/lessons';
import { cohort, measure, phases } from '../lib/ci-audit/measure';
import { priceRunner } from '../lib/ci-audit/prices';
import { ISSUE_MARKER, planIssue } from '../lib/ci-audit/publish';
import type { AuditReport } from '../lib/ci-audit/report';
import { CI_SHAPING, MIN_COHORT, comparable, judgeHead, staticChecks } from '../lib/ci-audit/ship-check';
import { parseWorkflow, readStatic } from '../lib/ci-audit/static';
import { scoreReply, writePlantedRepo } from './helpers/ci-audit-planted';

const ROOT = path.resolve(import.meta.dir, '..');
const FX = path.join(ROOT, 'test/fixtures/ci-audit/gstack');
const FX_ARGS = ['--repo', 'garrytan/gstack', '--since-days', '1', '--until', '2026-10-31T16:12:00Z', '--runs-per-workflow', '2', '--logs', '3', '--fixture', FX];

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, s => out.push(s), s => err.push(s));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ci-audit-'));

let seq = 0;
function run(sha: string, wf: string, startMin: number, endMin: number, over: Partial<Run> = {}): Run {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 31, 0, 0) + m * 60_000).toISOString().replace('.000Z', 'Z');
  return { id: ++seq, name: wf, path: `.github/workflows/${wf}`, event: 'pull_request', head_sha: sha, head_branch: 'b', status: 'completed', conclusion: 'success', created_at: at(startMin), updated_at: at(endMin), run_attempt: 1, pull_requests: [{ number: 1, base: { ref: 'main' } }], ...over };
}

describe('recorded gstack window (2026-10-31, replayed offline)', () => {
  test('replays to a complete report with the same numbers every time', async () => {
    const a = await cli(['run', ...FX_ARGS, '--root', tmp(), '--json']);
    expect(a.code).toBe(EXIT.ok);
    const r = JSON.parse(a.out) as AuditReport;
    expect(r.schema).toBe('gstack-ci-audit/v1');
    expect(r.pushToGreen.n).toBe(104);
    expect(Math.round(r.pushToGreen.p50! / 60)).toBe(12);
    expect(r.pushToGreen.excluded).toMatchObject({ cancelled_or_superseded: 12, rerun: 3, window_edge: 4 });
    expect(r.lessons.map(l => l.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.static).toBeNull();
    for (const id of [2, 9]) expect(r.lessons.find(l => l.id === id)!.state).toBe('unknown');
    const b = JSON.parse((await cli(['run', ...FX_ARGS, '--root', tmp(), '--json'])).out) as AuditReport;
    expect({ ...b, generatedAt: '' }).toEqual({ ...r, generatedAt: '' });
  });

  test('reads the Ubicloud VM family and cache restores from the sampled logs, not step times', async () => {
    const r = JSON.parse((await cli(['run', ...FX_ARGS, '--root', tmp(), '--json'])).out) as AuditReport;
    const suite = r.jobs.find(j => j.runner.startsWith('ubicloud'))!;
    expect(suite.price).toContain('premium');
    expect(r.cost.note).not.toContain('assumed');
    expect(r.lessons.find(l => l.id === 6)!.evidence.join(' ')).toMatch(/cache restores in 3 sampled logs: \d+ hit, 0 missed/);
  });

  test('fixture files keep only allowlisted fields', () => {
    for (const f of fs.readdirSync(FX)) {
      const text = fs.readFileSync(path.join(FX, f), 'utf8');
      expect(text).not.toMatch(/"(actor|triggering_actor|head_commit|author|committer|email|message|display_title|repository)"/);
    }
  });

  test('at most 10% of normal heads would print "slower" against their own cohort', async () => {
    const r = JSON.parse((await cli(['run', ...FX_ARGS, '--root', tmp(), '--json'])).out) as AuditReport;
    expect(r.pushToGreen.n).toBeGreaterThan(50);
    const runs = fs.readdirSync(FX).filter(f => f.includes('actions_runs_per_page')).flatMap(f => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8')).workflow_runs as Run[]);
    const heads = cohort(runs, r.window.since, 'main').heads;
    const judged = heads.map(h => judgeHead(h.seconds, comparable(heads, h).map(x => x.seconds), 120)).filter(j => j.state !== 'unknown');
    expect(judged.length).toBeGreaterThan(30);
    expect(judged.filter(j => j.state === 'slower').length / judged.length).toBeLessThanOrEqual(0.1);
  });
});

describe('planted repo (three problems, two decoys)', () => {
  test('the default run finds all three with numbers and flags neither decoy', async () => {
    const d = tmp();
    await writePlantedRepo(path.join(d, 'repo'), path.join(d, 'fx'));
    const prev = process.env.GSTACK_CI_AUDIT_FIXTURE;
    process.env.GSTACK_CI_AUDIT_FIXTURE = path.join(d, 'fx');
    try {
      const res = await cli(['run', '--logs', '10', '--root', path.join(d, 'repo'), '--json']);
      expect(res.code).toBe(EXIT.ok);
      const r = JSON.parse(res.out) as AuditReport;
      const lesson = (id: number) => r.lessons.find(l => l.id === id)!;
      expect(lesson(6).state).toBe('finding');
      expect(lesson(6).summary).toContain('no cache is saved from main');
      expect(lesson(6).summary).toContain('100% of sampled cache restores missed');
      expect(lesson(7).summary).toMatch(/lint\.yml finishes last on 100% of PR heads, a median 3\.\d min after everything else, mostly waiting for a machine/);
      expect(lesson(7).fix).toContain('fix the wait');
      expect(lesson(1).fix).toContain('same fast runner pool');
      expect(lesson(1).evidence.join(' ')).toMatch(/lint on ubuntu-24\.04: wait p50 8\.0 min/);
      expect(lesson(8).summary).toContain('no test exercises the skip logic');
      const all = JSON.stringify(r.lessons);
      expect(all).not.toMatch(/full-history|blob:none/);
      expect(lesson(1).evidence.join(' ')).not.toContain('windows');
      expect(r.fixes.map(f => f.lesson).sort()).toEqual([1, 6, 7, 8]);
      const md = await cli(['run', '--logs', '10', '--root', path.join(d, 'repo')]);
      expect(scoreReply(md.out)).toEqual({ found: ['unseeded-cache', 'lint-waits-last', 'untested-path-filter'], decoys: [] });
    } finally { if (prev == null) delete process.env.GSTACK_CI_AUDIT_FIXTURE; else process.env.GSTACK_CI_AUDIT_FIXTURE = prev; }
  });
});

describe('planted-repo reply scorer', () => {
  test('a generic CI checklist finds nothing, and recommending a decoy is caught', () => {
    expect(scoreReply('Consider caching dependencies, using faster runners and parallelizing tests.')).toEqual({ found: [], decoys: [] });
    expect(scoreReply('The release-notes job clones full history; add filter: blob:none or use a shallow clone.').decoys).toEqual(['blob-none-checkout']);
    expect(scoreReply('windows.yml waits 86 s in the queue; move it to a faster runner.').decoys).toEqual(['windows-queue']);
  });

  test('the three problems in plain words count, the lint one only with a number', () => {
    const reply = [
      '1. lint.yml finishes last: the lint job waits about 8 minutes for a runner to do 5 s of work.',
      '2. No cache is saved from main, so every PR starts cold and the npm cache misses.',
      "3. e2e.yml skips PRs by path filter, and no test checks that skip logic.",
    ].join('\n');
    expect(scoreReply(reply)).toEqual({ found: ['unseeded-cache', 'lint-waits-last', 'untested-path-filter'], decoys: [] });
    expect(scoreReply('The lint job waits for a runner a lot.').found).toEqual([]);
  });
});

describe('comparable cohort', () => {
  test('counts only heads whose every run went green on the first attempt, from first run created to last finished', () => {
    const runs = [
      run('a', 'ci.yml', 60, 70), run('a', 'win.yml', 61, 75),
      run('sup', 'ci.yml', 60, 64, { conclusion: 'cancelled' }), run('sup', 'win.yml', 60, 66),
      run('re', 'ci.yml', 60, 70, { run_attempt: 2 }),
      run('pend', 'ci.yml', 60, 70, { status: 'in_progress', conclusion: null }),
      run('edge', 'ci.yml', 5, 20),
      run('fail', 'ci.yml', 60, 66, { conclusion: 'failure' }), run('fail', 'win.yml', 60, 80),
    ];
    const c = cohort(runs, '2026-10-31T00:00:00Z', 'main');
    expect(c.heads.map(h => [h.sha, h.seconds, h.bottleneck])).toEqual([['a', 15 * 60, '.github/workflows/win.yml']]);
    expect(c.excluded).toEqual({ unsettled: 1, cancelled_or_superseded: 1, rerun: 1, window_edge: 1 });
    expect(c.failures).toMatchObject({ n: 1, p50: 6 * 60 });
  });

  test('a head with a different workflow set is not comparable', () => {
    const runs = [run('x', 'ci.yml', 60, 70), run('y', 'ci.yml', 60, 70), run('y', 'docs.yml', 60, 61)];
    const heads = cohort(runs, '2026-10-31T00:00:00Z').heads;
    expect(comparable(heads, heads.find(h => h.sha === 'x')!)).toEqual([]);
  });

  test('slower needs both the p90 and the minimum gap; a thin cohort gives no verdict', () => {
    const pool = Array.from({ length: 10 }, (_, i) => 600 + i * 10);
    expect(judgeHead(700, pool, 120).state).toBe('ok');
    expect(judgeHead(760, pool, 120).state).toBe('slower');
    expect(judgeHead(760, pool, 300).state).toBe('ok');
    expect(judgeHead(5000, pool.slice(0, MIN_COHORT - 1), 120).state).toBe('unknown');
  });
});

describe('job phases', () => {
  test('waiting is created to started; setup comes from step names; runner-less status jobs are dropped', () => {
    const r = run('a', 'ci.yml', 0, 10);
    const step = (name: string, a: string, b: string) => ({ name, started_at: `2026-10-31T00:${a}Z`, completed_at: `2026-10-31T00:${b}Z`, conclusion: 'success' });
    const job = { id: 1, run_id: r.id, name: 'test (1/4)', status: 'completed', conclusion: 'success', created_at: '2026-10-31T00:00:00Z', started_at: '2026-10-31T00:00:30Z', completed_at: '2026-10-31T00:05:00Z', labels: ['ubuntu-24.04'],
      steps: [step('Set up job', '00:30', '00:32'), step('Run actions/checkout@v4', '00:32', '00:40'), step('bun install', '00:40', '01:00'), step('Run tests', '01:00', '05:00')] };
    expect(phases(r, job)).toMatchObject({ job: 'test', waitS: 30, setupS: 30, runS: 240 });
    expect(phases(r, { ...job, labels: [], steps: [] })).toBeNull();
  });

  test('a job that moved runners mid-window is split by runner', () => {
    const r1 = run('a', 'ci.yml', 0, 10);
    const r2 = run('b', 'ci.yml', 0, 10);
    const job = (id: number, runId: number, label: string) => ({ id, run_id: runId, name: 'suite', status: 'completed', conclusion: 'success', created_at: '2026-10-31T00:00:00Z', started_at: '2026-10-31T00:00:10Z', completed_at: '2026-10-31T00:03:00Z', labels: [label], steps: [] as any[] });
    const m = measure({ repo: 'o/n', defaultBranch: 'main', isPrivate: false, since: '2026-10-30T00:00:00Z', until: '2026-10-31T01:00:00Z', runs: [r1, r2], jobs: { [r1.id]: [job(1, r1.id, 'ubicloud-standard-8')], [r2.id]: [job(2, r2.id, 'ubicloud-standard-2')] }, caches: null, partial: [], notes: [], calls: 0, sampledPerWorkflow: 2 });
    expect(m.groups.map(g => g.key).sort()).toEqual(['.github/workflows/ci.yml / suite (ubicloud-standard-2)', '.github/workflows/ci.yml / suite (ubicloud-standard-8)']);
  });
});

describe('lesson 1', () => {
  const group = (key: string, labels: string, waitP90: number, runP50: number) => ({ key, workflow: key, job: key, labels, n: 10, wait: { n: 10, p50: waitP90 / 2, p90: waitP90 }, setup: { n: 10, p50: 5, p90: 5 }, run: { n: 10, p50: runP50, p90: runP50 }, longWaits: waitP90 > 60 ? Array.from({ length: 10 }, (_, i) => `2026-10-${10 + i}T0${i % 10}:00:00Z`) : [], jobMinutes: 1, billedMinutes: 10 });
  const ctx = (groups: any[]) => ({ data: { isPrivate: false }, m: { groups, windowDays: 7, sampledRuns: 10 }, st: null } as any);

  test('a GitHub-hosted job that waits while the rest run on a faster pool: move it', () => {
    const l = lessonRunners(ctx([group('lint', 'ubuntu-24.04', 500, 5), group('test', 'ubicloud-standard-2', 20, 180)]));
    expect(l.state).toBe('finding');
    expect(l.fix).toContain('same fast runner pool');
  });

  test('a job that waits while another job on the same label starts at once: a faster runner would not help', () => {
    const l = lessonRunners(ctx([group('lint', 'ubuntu-24.04', 500, 5), group('test', 'ubuntu-24.04', 8, 180)]));
    expect(l.state).toBe('finding');
    expect(l.summary).toContain('on the same runner label starts in seconds');
    expect(l.fix).toContain('a faster runner would not help');
  });
});

describe('prices', () => {
  test('GitHub standard runners are free on public repos; Ubicloud bills by VM family', () => {
    expect(priceRunner('ubuntu-24.04', false).usdPerMinute).toBe(0);
    expect(priceRunner('ubuntu-24.04', true).usdPerMinute).toBe(0.006);
    expect(priceRunner('ubicloud-standard-2', false, {}, 'premium').usdPerMinute).toBeCloseTo(0.002);
    expect(priceRunner('ubicloud-standard-8', false, {}, 'premium').usdPerMinute).toBeCloseTo(0.008);
    expect(priceRunner('ubicloud-standard-2', false).usdPerMinute).toBeCloseTo(0.00125);
  });
});

describe('ship-check static rules', () => {
  test('CI-shaping files include workflows, package.json, hook managers and linter configs, not ordinary source', () => {
    for (const f of ['.github/workflows/ci.yml', 'package.json', 'web/package.json', 'bunfig.toml', 'tsconfig.json', '.husky/pre-push', 'lefthook.yml', 'biome.json', 'vitest.config.ts', '.gstack/pregate.json']) expect(CI_SHAPING.test(f)).toBe(true);
    for (const f of ['src/app.ts', 'docs/ci.md', 'README.md']) expect(CI_SHAPING.test(f)).toBe(false);
  });

  test('flags a full-history checkout, oversubscribed tasks and an untested path filter in a touched workflow', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), [
      'on:', '  pull_request:', '    paths: ["src/**"]', 'jobs:', '  test:', '    runs-on: ubuntu-24.04', '    steps:',
      '      - uses: actions/checkout@v4', '        with:', '          fetch-depth: 0', '      - run: bun test --max-concurrency=32',
    ].join('\n'));
    Bun.spawnSync(['git', 'init', '-q', dir], { timeout: 10_000 });
    Bun.spawnSync(['git', '-C', dir, 'add', '.'], { timeout: 10_000 });
    const st = readStatic(dir, 'main');
    const out = staticChecks(st, ['.github/workflows/ci.yml'], false);
    expect(out.some(l => l.startsWith('lesson 6:') && l.includes('full history'))).toBe(true);
    expect(out.some(l => l.includes('runs 32 tasks on'))).toBe(true);
    expect(out.some(l => l.startsWith('lesson 8:'))).toBe(true);
    expect(staticChecks(st, ['src/app.ts'], false)).toEqual([]);
  });

  test('YAML aliases are not expanded and oversize files are refused', () => {
    const bomb = ['a: &a [x, x, x]', ...Array.from({ length: 60 }, (_, i) => `k${i}: &k${i} [*a, *a]`), 'on: push', 'jobs: {}'].join('\n');
    expect(parseWorkflow('.github/workflows/b.yml', bomb, 'main').unreadable).toBeTruthy();
    expect(parseWorkflow('.github/workflows/big.yml', 'x'.repeat(600 * 1024), 'main').unreadable).toBeTruthy();
  });

  test('concurrency flags are read from bun, jest and make lines', () => {
    expect(concurrencyFlag('bun test --max-concurrency=16')).toBe(16);
    expect(concurrencyFlag('npx jest --maxWorkers 8')).toBe(8);
    expect(concurrencyFlag('make -j 12 test')).toBe(12);
    expect(concurrencyFlag('echo -j 3 ./run-n 5')).toBe(0);
  });
});

describe('weekly issue', () => {
  const report = (fixes: number, partial: string[] = []): AuditReport => ({ ok: true, generatedAt: '2026-11-07T15:05:00Z', partial, fixes: Array.from({ length: fixes }, () => ({})) } as unknown as AuditReport);
  const existing = { number: 7, body: `${ISSUE_MARKER}\nold findings` };
  const md = { ...report(2), schema: 'gstack-ci-audit/v1', repo: 'o/n', window: { since: '', until: '', days: 7 }, notes: [], calls: 1, static: null, pushToGreen: { n: 0, p50: null, p90: null, excluded: {}, bottlenecks: [] }, timeToFirstFailure: { n: 0, p50: null, p90: null }, preJobWait: { n: 0, p50: null, p90: null }, sampledRuns: 0, jobs: [], lessons: [], fixes: [], cost: { billedMinutesPerWeek: 0, usdPerMonth: 0, note: '' } } as unknown as AuditReport;
  const withFixes = { ...md, fixes: [{ lesson: 1, title: 't', finding: 'f', fix: 'x', saving: null }] } as unknown as AuditReport;

  test('a complete audit with findings creates or replaces the issue', () => {
    expect(planIssue({ exit: 0, report: withFixes }, null).action).toBe('create');
    const upd = planIssue({ exit: 0, report: withFixes }, existing);
    expect(upd.action).toBe('update');
    expect((upd as { body: string }).body.startsWith(ISSUE_MARKER)).toBe(true);
  });

  test('only a complete audit with nothing left closes it', () => {
    expect(planIssue({ exit: 0, report: report(0) }, existing).action).toBe('close');
    expect(planIssue({ exit: 0, report: report(0) }, null).action).toBe('none');
  });

  test('partial, unavailable and failed audits keep the tracked findings and say why', () => {
    for (const o of [{ exit: 4, report: report(0, ['job details stopped early']) }, { exit: 4, report: { ...withFixes, partial: ['x'] } as AuditReport }, { exit: 3, report: null, error: 'CI_AUDIT: unavailable rate (ci_audit_rate_limit)' }, { exit: 5, report: null }, { exit: 0, report: null }]) {
      const a = planIssue(o, existing);
      expect(a.action).toBe('keep');
      expect((a as { comment: string }).comment).toMatch(/^Kept open: /);
    }
    expect(planIssue({ exit: 3, report: null, error: 'CI_AUDIT: unavailable x (ci_audit_deadline)' }, null).action).toBe('none');
    expect(planIssue({ exit: 4, report: { ...withFixes, partial: ['x'] } as AuditReport }, null).action).toBe('create');
  });
});

describe('Saturday workflow template', () => {
  const file = path.join(ROOT, 'lib/ci-audit/templates/ci-audit-weekly.yml');
  const doc = Bun.YAML.parse(fs.readFileSync(file, 'utf8')) as any;

  test('runs Saturday morning and on demand, reads Actions, writes only issues', () => {
    expect(doc.on.schedule).toEqual([{ cron: '0 15 * * 6' }]);
    expect('workflow_dispatch' in doc.on).toBe(true);
    expect(doc.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    expect(doc.jobs.audit.if).toBe('github.ref_name == github.event.repository.default_branch');
  });

  test('audits within the GITHUB_TOKEN hourly limit and always publishes the outcome', () => {
    const steps = doc.jobs.audit.steps as { name?: string; run?: string; if?: string }[];
    const audit = steps.find(s => s.name === 'Audit')!.run!;
    const max = Number(/--max-calls (\d+)/.exec(audit)?.[1]);
    expect(max + 500).toBeLessThanOrEqual(1000);
    expect(audit).toContain('set +e');
    const pub = steps.find(s => s.name === 'Publish')!;
    expect(pub.if).toBe('always()');
    expect(pub.run).toContain('--exit "${{ steps.audit.outputs.code || 5 }}"');
  });
});

describe('command line', () => {
  test('usage errors exit 1 with help; a bad slug is refused before any call', async () => {
    expect((await cli(['run', '--bogus'])).code).toBe(EXIT.usage);
    const r = await cli(['run', '--repo', '../etc', '--fixture', FX]);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toMatch(/^CI_AUDIT: unavailable .*\(ci_audit_bad_repo\)\nfix: .*docs\/troubleshooting\.md#ci-audit-bad-repo/);
  });

  test('a call budget too small for the window is reported with its code, not a crash', async () => {
    const r = await cli(['run', ...FX_ARGS, '--root', tmp(), '--max-calls', '3']);
    expect([EXIT.unavailable, EXIT.partial] as number[]).toContain(r.code);
    expect(r.err).toContain('ci_audit_call_budget');
  });

  test('ship-check off prints one line and makes no calls', async () => {
    const home = tmp();
    fs.writeFileSync(path.join(home, 'config.yaml'), 'ci_audit_ship: off\n');
    const prev = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = home;
    try {
      const r = await cli(['ship-check', '--base', 'main', '--pr', '1', '--repo', 'o/n', '--fixture', tmp()]);
      expect(r).toMatchObject({ code: EXIT.ok, out: 'CI_AUDIT: off (gstack-config ci_audit_ship=off)' });
    } finally { if (prev == null) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prev; }
  });

  test('ship-check without gh on PATH reports ci_audit_gh_missing and keeps the static lines', () => {
    const bin = tmp();
    fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
    const r = Bun.spawnSync([path.join(bin, 'bun'), '--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin/gstack-ci-audit'), 'ship-check', '--base', 'main', '--pr', '5', '--repo', 'o/n', '--root', tmp()], { env: { PATH: bin, HOME: tmp(), GSTACK_STATE_ROOT: tmp() }, timeout: 20_000 });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(EXIT.unavailable);
    expect(out).toContain('(ci_audit_gh_missing)');
    expect(out).toContain('CI_AUDIT_USED: 0 calls');
  });

  test('ship-check against a slow gh stops at its deadline', () => {
    const bin = tmp();
    fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const r = Bun.spawnSync([path.join(bin, 'bun'), '--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin/gstack-ci-audit'), 'ship-check', '--base', 'main', '--pr', '5', '--repo', 'o/n', '--root', tmp()], { env: { PATH: `${bin}:/bin:/usr/bin`, HOME: tmp(), GSTACK_STATE_ROOT: tmp() }, timeout: 30_000 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.stdout.toString()).toContain('(ci_audit_deadline)');
  }, 35_000);

  test('a rate-limited 403 is reported as ci_audit_rate_limit with the reset time', () => {
    const bin = tmp();
    fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "HTTP/2.0 403 Forbidden\\r\\nX-Ratelimit-Remaining: 0\\r\\nX-Ratelimit-Reset: 1793472066\\r\\n\\r\\n{\\"message\\":\\"API rate limit exceeded\\"}"\nexit 1\n', { mode: 0o755 });
    const r = Bun.spawnSync([path.join(bin, 'bun'), '--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin/gstack-ci-audit'), 'ship-check', '--base', 'main', '--pr', '5', '--repo', 'o/n', '--root', tmp()], { env: { PATH: `${bin}:/bin:/usr/bin`, HOME: tmp(), GSTACK_STATE_ROOT: tmp() }, timeout: 20_000 });
    expect(r.stdout.toString()).toContain('(ci_audit_rate_limit)');
  });

  test('ship-check against a failing gh reports ci_audit_api_failed', () => {
    const bin = tmp();
    fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n{}"\nexit 1\n', { mode: 0o755 });
    const r = Bun.spawnSync([path.join(bin, 'bun'), '--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin/gstack-ci-audit'), 'ship-check', '--base', 'main', '--pr', '5', '--repo', 'o/n', '--root', tmp()], { env: { PATH: `${bin}:/bin:/usr/bin`, HOME: tmp(), GSTACK_STATE_ROOT: tmp() }, timeout: 20_000 });
    expect(r.stdout.toString()).toMatch(/\(ci_audit_(api_failed|repo_unreadable)\)/);
  });
});
