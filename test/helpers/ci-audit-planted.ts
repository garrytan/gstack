/**
 * A synthetic GitHub repo for /ci-audit with three planted problems and two decoys.
 *   planted: no cache saved from main (every PR restore misses); a GitHub-hosted
 *            5-second lint job that waits ~8 min for a machine and finishes last;
 *            a path-filtered e2e workflow that no test exercises.
 *   decoys:  a full-history checkout that already uses filter: blob:none; a
 *            windows job on main that waits over a minute but runs for ten.
 * writePlantedRepo() writes the checkout and records the GitHub responses the
 * default `gstack-ci-audit run --logs 10` asks for, through the real collector.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collect, sampleLogs } from '../../lib/ci-audit/collect';
import { Budget, recordingClient, type ApiClient } from '../../lib/ci-audit/github';

export const PLANTED_REPO = 'acme/widgets';
export const PLANTED_NOW = Date.parse('2026-11-07T15:00:00Z');

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const WORKFLOWS: Record<string, string> = {
  'ci.yml': `name: CI
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
  typecheck:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: npx tsc --noEmit
  release-notes:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          filter: blob:none
      - run: git log --oneline -20
`,
  'lint.yml': `name: Lint
on:
  pull_request:
jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: npx oxlint
`,
  'e2e.yml': `name: E2E
on:
  pull_request:
    paths: ['src/**']
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run e2e
`,
  'windows.yml': `name: Windows
on:
  push:
    branches: [main]
jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`,
};

interface Data { runs: any[]; jobs: Record<number, any[]>; logs: Record<number, string> }

function synth(): Data {
  const runs: any[] = [];
  const jobs: Record<number, any[]> = {};
  const logs: Record<number, string> = {};
  let id = 1000;
  const wfId: Record<string, number> = { 'ci.yml': 11, 'lint.yml': 12, 'e2e.yml': 13, 'windows.yml': 14 };
  const job = (runId: number, name: string, label: string, created: number, waitS: number, steps: [string, number][]) => {
    let t = created + waitS * 1000;
    const started = t;
    const st = steps.map(([n, s]) => { const a = t; t += s * 1000; return { name: n, status: 'completed', conclusion: 'success', number: 1, started_at: iso(a), completed_at: iso(t) }; });
    const j = { id: ++id, run_id: runId, run_attempt: 1, name, status: 'completed', conclusion: 'success', created_at: iso(created), started_at: iso(started), completed_at: iso(t), labels: [label], runner_name: 'GitHub Actions 1', steps: st };
    (jobs[runId] ??= []).push(j);
    return { j, end: t };
  };
  const run = (wf: string, event: string, sha: string, created: number, pr: number | null, conclusion = 'success') => {
    const r = { id: ++id, name: wf, path: `.github/workflows/${wf}`, event, head_sha: sha, head_branch: pr ? `feature-${pr}` : 'main', status: 'completed', conclusion, created_at: iso(created), run_started_at: iso(created), updated_at: iso(created), run_attempt: 1, workflow_id: wfId[wf], pull_requests: pr ? [{ number: pr, base: { ref: 'main' } }] : [] };
    runs.push(r);
    return r;
  };
  const setOnly = (r: any, end: number) => { r.updated_at = iso(end + 2000); };
  for (let i = 0; i < 36; i++) {
    const T = PLANTED_NOW - 6.5 * 86400_000 + i * 4 * 3600_000 + (i % 3) * 600_000;
    const sha = `${(0xa000 + i).toString(16)}${'0'.repeat(36)}`;
    const pr = 100 + i;
    const ci = run('ci.yml', 'pull_request', sha, T, pr);
    const test = job(ci.id, 'test', 'ubuntu-24.04', T + 3000, 5 + (i % 4), [['Set up job', 2], ['Run actions/checkout@v4', 3], ['Run actions/setup-node@v4', 25], ['Run npm ci', 40 + (i % 5)], ['Run npm test', 150 + (i * 7) % 50], ['Complete job', 1]]);
    logs[test.j.id] = [`${iso(T)} Cache not found for input keys: node-cache-Linux-x64-npm-${i}`, `${iso(T)} npm ci finished`].join('\n');
    const tc = job(ci.id, 'typecheck', 'ubuntu-24.04', T + 3000, 4 + (i % 3), [['Set up job', 2], ['Run actions/checkout@v4', 3], ['Run npx tsc --noEmit', 12], ['Complete job', 1]]);
    const rn = job(ci.id, 'release-notes', 'ubuntu-24.04', T + 3000, 4, [['Set up job', 2], ['Run actions/checkout@v4', 4], ['Run git log --oneline -20', 1], ['Complete job', 1]]);
    setOnly(ci, Math.max(test.end, tc.end, rn.end));
    const lint = run('lint.yml', 'pull_request', sha, T, pr);
    const lj = job(lint.id, 'lint', 'ubuntu-24.04', T + 2000, 420 + (i * 37) % 120, [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Run npx oxlint', 5], ['Complete job', 1]]);
    setOnly(lint, lj.end);
    if (i % 2 === 0) {
      const e2e = run('e2e.yml', 'pull_request', sha, T, pr);
      const ej = job(e2e.id, 'e2e', 'ubuntu-24.04', T + 2000, 6, [['Set up job', 2], ['Run actions/checkout@v4', 3], ['Run npm ci', 40], ['Run npm run e2e', 120], ['Complete job', 1]]);
      setOnly(e2e, ej.end);
    }
    if (i % 12 === 5) {
      const sup = `${(0xb000 + i).toString(16)}${'0'.repeat(36)}`;
      const c = run('ci.yml', 'pull_request', sup, T - 1800_000, pr, 'cancelled');
      setOnly(c, T - 1700_000);
      const l = run('lint.yml', 'pull_request', sup, T - 1800_000, pr, 'cancelled');
      setOnly(l, T - 1700_000);
    }
    if (i % 6 === 2) {
      const w = run('windows.yml', 'push', `${(0xc000 + i).toString(16)}${'0'.repeat(36)}`, T + 7200_000, null);
      const wj = job(w.id, 'windows', 'windows-latest', T + 7203_000, 70 + (i % 4) * 8, [['Set up job', 3], ['Run actions/checkout@v4', 8], ['Run npm ci', 60], ['Run npm test', 600], ['Complete job', 2]]);
      setOnly(w, wj.end);
    }
  }
  return { runs, jobs, logs };
}

function syntheticClient(d: Data): ApiClient {
  const byId = new Map(d.runs.map(r => [r.id, r]));
  const wf = [['.github/workflows/ci.yml', 11], ['.github/workflows/lint.yml', 12], ['.github/workflows/e2e.yml', 13], ['.github/workflows/windows.yml', 14]] as const;
  return {
    async get(p) {
      const u = new URL(`https://x${p}`);
      const q = u.searchParams;
      const created = q.get('created') ?? '';
      const [from, to] = created.startsWith('>=') ? [created.slice(2), '9999'] : created.split('..');
      const inWindow = (r: any) => r.created_at >= (from ?? '') && r.created_at <= (to ?? '9999');
      if (u.pathname === '/rate_limit') return { status: 200, json: { resources: { core: { limit: 5000, remaining: 5000, reset: PLANTED_NOW / 1000 + 3600 } } } };
      if (u.pathname === `/repos/${PLANTED_REPO}`) return { status: 200, json: { default_branch: 'main', private: false } };
      if (u.pathname === `/repos/${PLANTED_REPO}/actions/runs`) {
        const page = Number(q.get('page') ?? 1);
        const list = d.runs.filter(r => inWindow(r) && (!q.get('event') || r.event === q.get('event')) && (!q.get('branch') || r.head_branch === q.get('branch'))).sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { status: 200, json: { total_count: list.length, workflow_runs: list.slice((page - 1) * 100, page * 100) } };
      }
      const jobs = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(u.pathname);
      if (jobs) return byId.has(Number(jobs[1])) ? { status: 200, json: { total_count: d.jobs[Number(jobs[1])]?.length ?? 0, jobs: d.jobs[Number(jobs[1])] ?? [] } } : { status: 404, json: {} };
      if (u.pathname === `/repos/${PLANTED_REPO}/actions/workflows`) return { status: 200, json: { total_count: wf.length, workflows: wf.map(([p2, id]) => ({ id, path: p2, state: 'active' })) } };
      const counts = /\/actions\/workflows\/(\d+)\/runs$/.exec(u.pathname);
      if (counts) return { status: 200, json: { total_count: d.runs.filter(r => r.workflow_id === Number(counts[1]) && inWindow(r)).length, workflow_runs: [] } };
      if (u.pathname === `/repos/${PLANTED_REPO}/actions/caches`) return { status: 200, json: { total_count: 6, actions_caches: Array.from({ length: 6 }, (_, i) => ({ key: `node-cache-Linux-x64-npm-${i}`, ref: `refs/pull/${130 + i}/merge`, size_in_bytes: 50_000_000, created_at: iso(PLANTED_NOW - i * 3600_000), last_accessed_at: iso(PLANTED_NOW - i * 3600_000) })) } };
      return { status: 404, json: { message: 'Not Found' } };
    },
    async text(p) {
      const m = /\/actions\/jobs\/(\d+)\/logs$/.exec(p);
      return m ? d.logs[Number(m[1])] ?? '' : null;
    },
  };
}

/** Writes the checkout to `checkout` and the replay fixture (with its clock) to `fixture`. */
export async function writePlantedRepo(checkout: string, fixture: string): Promise<void> {
  fs.mkdirSync(path.join(checkout, '.github/workflows'), { recursive: true });
  for (const [f, text] of Object.entries(WORKFLOWS)) fs.writeFileSync(path.join(checkout, '.github/workflows', f), text);
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'widgets', scripts: { test: 'bun test', e2e: 'bun test e2e', lint: 'oxlint', typecheck: 'tsc --noEmit' }, devDependencies: { oxlint: '^1.0.0', typescript: '^5.9.0' } }, null, 2));
  fs.mkdirSync(path.join(checkout, '.husky'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.husky/pre-push'), '#!/bin/sh\nnpx oxlint && npx tsc --noEmit\n', { mode: 0o755 });
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'src/widget.ts'), 'export const widget = (n: number) => n * 2;\n');
  fs.mkdirSync(path.join(checkout, 'test'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'test/widget.test.ts'), "import { widget } from '../src/widget';\ntest('doubles', () => expect(widget(2)).toBe(4));\n");
  const git = (...a: string[]) => spawnSync('git', ['-C', checkout, ...a], { stdio: 'ignore', timeout: 10_000 });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', `https://github.com/${PLANTED_REPO}.git`);
  git('add', '-A');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'clock.json'), JSON.stringify({ now: PLANTED_NOW }) + '\n');
  const budget = new Budget(800, 60_000);
  const client = recordingClient(syntheticClient(synth()), fixture);
  const data = await collect(client, budget, { repo: PLANTED_REPO, sinceDays: 7, runsPerWorkflow: 30, now: PLANTED_NOW });
  await sampleLogs(client, data, 10);
}

const near = (a: string, b: string, gap = 240) => new RegExp(`(${a})[^\\n]{0,${gap}}(${b})|(${b})[^\\n]{0,${gap}}(${a})`, 'i');

/** Each planted problem as a reply must name it; the lint one needs a number. */
export const PLANTED = [
  { id: 'unseeded-cache', re: near('cache', 'main\\b|default branch|miss|not found|cold|seed') },
  { id: 'lint-waits-last', re: near('lint', '(wait|queue|machine|runner)[^\\n]{0,160}\\d+(\\.\\d+)?\\s*(min|minutes|m\\b|s\\b|sec)') },
  { id: 'untested-path-filter', re: near('e2e|path[- ]?filter|paths:|skip logic|skips? (PRs|runs)', 'no test|untested|not tested|nothing tests|without (a |any )?test|no .{0,20}test (covers|exercises)') },
] as const;

/** Decoys a reply must not present as something to fix. */
export const DECOYS = [
  { id: 'blob-none-checkout', re: near('release-notes|fetch-depth|full[- ]history', '(add|use|switch to|set)[^\\n]{0,40}(blob:none|shallow|fetch-depth: ?1)') },
  { id: 'windows-queue', re: near('windows', '(wait|queue)[^\\n]{0,120}(fix|move it|faster runner|bigger runner|problem|too slow)') },
] as const;

export function scoreReply(text: string): { found: string[]; decoys: string[] } {
  return { found: PLANTED.filter(p => p.re.test(text)).map(p => p.id), decoys: DECOYS.filter(d => d.re.test(text)).map(d => d.id) };
}
