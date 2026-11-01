/**
 * Main-push CI reuse wiring (GSTA-156 P3b) for free-tests.yml and windows-free-tests.yml. Pins the properties that
 * make reuse safe: only a push to main consumes, the reuse job alone reads Actions with a job-level actions: read,
 * a skipped or failed reuse job runs every job exactly as before (GitHub skips a job whose needed job was skipped
 * unless its condition uses a status function, so every dependent condition starts with !cancelled()), the
 * aggregate's reuse branch runs before any download and the strict path is otherwise unchanged, tested-tree is
 * uploaded only after strict verification, and the run profiles in .gstack/pregate.json name real jobs.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseWorkflow } from '../lib/pregate/workflows';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FILES = { 'free-tests.yml': { aggregate: 'free-tests', profile: 'ci-reuse/free-tests', plan: 'free-plan', exempt: [] as string[], manual: false }, 'windows-free-tests.yml': { aggregate: 'windows-free-tests', profile: 'ci-reuse/windows-free-tests', plan: 'windows-plan', exempt: ['windows-record-durations'], manual: true } };
const REUSE_IF = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const SKIP = "steps.route.outputs.reused != 'true'";
const PROFILES = JSON.parse(read('.gstack/pregate.json')).run_profiles as Record<string, { workflow: string; jobs: string[]; artifact: string; events: string[]; os: string }>;

/** Evaluate a job condition the way the runner would for one reuse outcome (status functions true: nothing cancelled). */
function runs(cond: string, s: { result: string; reused: string; plan?: string }): boolean {
  const expr = cond.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/!cancelled\(\)|always\(\)/g, 'true')
    .replace(/needs\.reuse\.result/g, JSON.stringify(s.result)).replace(/needs\.reuse\.outputs\.reused/g, JSON.stringify(s.reused))
    .replace(/needs\.(free|windows)-plan\.result/g, JSON.stringify(s.plan ?? 'success')).replace(/inputs\.record_durations/g, 'false');
  expect(expr).not.toMatch(/needs\.|inputs\.|github\.|steps\./);
  return new Function(`return (${expr});`)() as boolean;
}

for (const [file, spec] of Object.entries(FILES)) {
  describe(`${file} main-push reuse wiring`, () => {
    const source = read(`.github/workflows/${file}`);
    const wf = Bun.YAML.parse(source) as any;
    const jobs = wf.jobs as Record<string, any>;
    const needs = (name: string): string[] => [jobs[name].needs ?? []].flat();
    const suite = Object.keys(jobs).filter(n => n !== 'reuse' && n !== spec.aggregate && !spec.exempt.includes(n));

    test('only a push to main consumes, with job-level actions: read on the reuse job alone and no secrets', () => {
      expect(jobs.reuse.if).toBe(REUSE_IF);
      expect(jobs.reuse.permissions).toEqual({ contents: 'read', actions: 'read' });
      expect(wf.permissions).toEqual({ contents: 'read' });
      for (const name of Object.keys(jobs).filter(n => n !== 'reuse')) expect([name, jobs[name].permissions]).toEqual([name, undefined]);
      expect(source).not.toContain('secrets.');
      expect(source).not.toContain('pull_request_target');
      const find = jobs.reuse.steps.find((s: any) => s.id === 'find');
      expect(find.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
      expect(find.run).toBe(`bun run scripts/ci-tree-reuse.ts find --workflow ${file} --profile ${spec.profile}`);
      expect(jobs.reuse.steps[0].with['persist-credentials']).toBe(false);
      expect(Object.keys(jobs.reuse.outputs).sort()).toEqual(['reused', 'run_id', 'run_url', 'tree']);
    });

    test('every suite job needs reuse and runs unless reuse succeeded with reused=true; a skipped or failed reuse runs them all', () => {
      expect(suite.length).toBeGreaterThan(1);
      for (const name of suite) {
        expect([name, needs(name)]).toEqual([name, expect.arrayContaining(['reuse'])]);
        const cond = jobs[name].if as string;
        expect([name, cond]).toEqual([name, expect.stringMatching(/^\$\{\{ !cancelled\(\) && /)]);
        expect([name, runs(cond, { result: 'skipped', reused: '' })]).toEqual([name, true]);
        expect([name, runs(cond, { result: 'success', reused: 'false' })]).toEqual([name, true]);
        expect([name, runs(cond, { result: 'failure', reused: '' })]).toEqual([name, true]);
        expect([name, runs(cond, { result: 'failure', reused: 'true' })]).toEqual([name, true]);
        expect([name, runs(cond, { result: 'success', reused: 'true' })]).toEqual([name, false]);
      }
      for (const name of suite.filter(n => needs(n).includes(spec.plan))) expect([name, runs(jobs[name].if, { result: 'skipped', reused: '', plan: 'failure' })]).toEqual([name, false]);
      expect(needs(spec.aggregate)).toContain('reuse');
      expect(runs(jobs[spec.aggregate].if, { result: 'success', reused: 'true' })).toBe(true);
    });

    test('every job downstream of reuse uses a status function, so a skipped reuse never skips it', () => {
      const downstream = (name: string): boolean => needs(name).some(n => n === 'reuse' || downstream(n));
      for (const name of Object.keys(jobs).filter(downstream)) expect([name, jobs[name].if]).toEqual([name, expect.stringMatching(/!cancelled\(\)|always\(\)/)]);
    });

    test(spec.manual ? 'pregate reads every test lane as manual: the nightly Windows suite is never a PR obligation (windows-smoke.yml is)' : 'pregate still sees every test lane as required (no condition reads inputs or workflow_dispatch)', () => {
      const lanes = parseWorkflow(file, source, 'linux').filter(l => l.runsTests && !spec.exempt.includes(l.job));
      expect(lanes.length).toBeGreaterThan(0);
      for (const lane of lanes) expect([lane.id, lane.manual]).toEqual([lane.id, spec.manual]);
    });

    test('the aggregate routes first, before any download; the strict path follows unchanged and alone uploads tested-tree after verification', () => {
      const steps = jobs[spec.aggregate].steps as any[];
      expect(steps[0].id).toBe('route');
      expect(steps[0].if).toBeUndefined();
      for (const step of steps.slice(1)) expect([step.name ?? step.uses, step.if]).toEqual([step.name ?? step.uses, SKIP]);
      const verify = steps.findIndex(s => s.run?.includes('--ci-verify'));
      const record = steps.findIndex(s => s.run?.includes('scripts/ci-tree-reuse.ts record'));
      const upload = steps.findIndex(s => s.with?.name === 'tested-tree');
      expect(steps.findIndex(s => s.uses?.startsWith('actions/download-artifact@'))).toBeGreaterThan(0);
      expect(verify).toBeGreaterThan(0);
      expect(record).toBe(verify + 1);
      expect(upload).toBe(record + 1);
      expect(steps.length).toBe(upload + 1);
      expect(steps[upload].uses).toStartWith('actions/upload-artifact@');
      expect(steps[upload].with['if-no-files-found']).toBe('error');
      expect(steps[record].env).toEqual({ PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}' });
      expect(steps[1].run).toMatch(/set -eu\n(test "\$[A-Z_]+_RESULT" = success\n)+$/);
    });

    test.skipIf(!Bun.which('bash'))('the route step takes the reuse branch only for a well-formed reuse on a main push, and fails rather than passes on anything else claiming reuse', () => {
      const route = jobs[spec.aggregate].steps[0];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse route '));
      const shell = (p: string) => p.split(path.sep).join('/');
      try {
        const go = (env: Record<string, string>) => {
          const out = path.join(dir, 'out'); const summary = path.join(dir, 'summary');
          fs.writeFileSync(out, ''); fs.writeFileSync(summary, '');
          const r = spawnSync('bash', ['-e', '-c', route.run], { env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: shell(out), GITHUB_STEP_SUMMARY: shell(summary), GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'garrytan/gstack', REUSE_RESULT: '', REUSED: '', REUSE_RUN_ID: '', REUSE_RUN_URL: '', REUSE_TREE: '', ...env }, encoding: 'utf8', timeout: 5000 });
          return { status: r.status, out: fs.readFileSync(out, 'utf8'), summary: fs.readFileSync(summary, 'utf8') };
        };
        const good = { REUSE_RESULT: 'success', REUSED: 'true', REUSE_RUN_ID: '123', REUSE_RUN_URL: 'https://github.com/garrytan/gstack/actions/runs/123', REUSE_TREE: 'a'.repeat(40) };
        expect(go({ REUSE_RESULT: 'skipped', GITHUB_EVENT_NAME: 'pull_request' })).toEqual({ status: 0, out: 'reused=false\n', summary: '' });
        expect(go({ REUSE_RESULT: 'success', REUSED: 'false' })).toEqual({ status: 0, out: 'reused=false\n', summary: '' });
        expect(go({ ...good, REUSE_RESULT: 'failure' })).toEqual({ status: 0, out: 'reused=false\n', summary: '' });
        const reused = go(good);
        expect([reused.status, reused.out]).toEqual([0, 'reused=true\n']);
        expect(reused.summary).toContain('Reused https://github.com/garrytan/gstack/actions/runs/123');
        for (const bad of <Record<string, string>[]>[{ REUSE_RUN_ID: '' }, { REUSE_RUN_ID: '12x' }, { REUSE_RUN_URL: 'https://github.com/other/repo/actions/runs/123' }, { REUSE_TREE: '' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }]) {
          const r = go({ ...good, ...bad });
          expect([JSON.stringify(bad), r.status === 0, r.out]).toEqual([JSON.stringify(bad), false, '']);
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('its run profile names this workflow, its real non-matrix jobs and the uploaded artifact, and is never named after a lane (lane clears keep their URL path until GST-555)', () => {
      const profiles = Object.entries(PROFILES).filter(([, p]) => p.workflow === file);
      expect(profiles.map(([n]) => n)).toContain(spec.profile);
      for (const [name, p] of profiles) {
        expect([name, p.events.sort()]).toEqual([name, ['pull_request', 'workflow_dispatch']]);
        expect([name, p.artifact]).toEqual([name, 'tested-tree']);
        for (const job of p.jobs) expect([name, job, !!jobs[job] && !jobs[job].strategy]).toEqual([name, job, true]);
        expect(p.jobs).toContain(spec.aggregate);
        expect([name, /\.ya?ml\//.test(name)]).toEqual([name, false]);
      }
    });
  });
}

test('every workflow that calls one of these grants the calling job actions: read, which the reuse job needs even when it is skipped', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const callers: string[] = [];
  for (const name of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
    const jobs = (Bun.YAML.parse(read(`.github/workflows/${name}`)) as any)?.jobs ?? {};
    for (const [id, job] of Object.entries(jobs) as Array<[string, any]>) {
      const called = /^\.\/\.github\/workflows\/(.+)$/.exec(job?.uses ?? '')?.[1];
      if (!called || !(called in FILES)) continue;
      callers.push(`${name}/${id}`);
      expect([`${name}/${id}`, job.permissions?.actions]).toEqual([`${name}/${id}`, expect.stringMatching(/^(read|write)$/)]);
    }
  }
  expect(callers).toContain('free-durations-record.yml/windows');
});
