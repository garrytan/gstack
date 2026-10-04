import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPaidShard, shardSlug } from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const workflows = ['evals.yml', 'evals-periodic.yml', 'evals-marathon.yml'].map(name => ({
  name,
  value: Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8')) as any,
}));
const executors = workflows.flatMap(({ name, value }) => Object.entries(value.jobs)
  .flatMap(([jobName, job]: [string, any]) => job.steps
    .filter((step: any) => step.run?.includes('scripts/test-paid-shards.ts') && step.run.includes(' --slice '))
    .map((step: any) => ({ name, jobName, job, step }))));

// A host-run executor (evals-periodic eval-codex-slices) starts the CI image with
// `docker run`; the literal `-e NAME=VALUE` flags are the slice's environment.
function dockerEnv(run: string): Record<string, string> {
  return Object.fromEntries([...run.matchAll(/(?:^|\s)-e ([A-Z_][A-Z0-9_]*)=(\S+)/g)].map(match => [match[1]!, match[2]!]));
}
const executorEnv = (job: any, step: any): Record<string, string> => ({ ...job.env, ...step.env, ...dockerEnv(step.run) });
// Upload paths on a host-run executor name the host side of its `-v` mounts;
// map them back to the container paths (and the mounted HOME back to `~/`).
function containerPath(step: any, uploadPath: string): string {
  const mounts = [...step.run.matchAll(/-v "\$RUNNER_TEMP\/([^:"]+):([^:"]+)(?::ro)?"/g)].map(match => [match[1]!, match[2]!]);
  for (const [host, inside] of mounts) {
    const prefix = '${{ runner.temp }}/' + host;
    if (uploadPath === prefix || uploadPath.startsWith(prefix + '/')) {
      const mapped = inside + uploadPath.slice(prefix.length);
      return inside === dockerEnv(step.run).HOME ? mapped.replace(inside, '~') : mapped;
    }
  }
  return uploadPath;
}

function render(template: string, fields: Record<string, string>): string {
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    if (!(key in fields)) throw new Error(`Unbound CI expression: ${key}`);
    return fields[key];
  });
}

test('every direct CI paid executor binds a safe unique run/attempt/job/slice identity', () => {
  expect(executors.map(({ name, jobName }) => `${name}:${jobName}`)).toEqual([
    'evals.yml:eval-slices', 'evals-periodic.yml:eval-slices', 'evals-periodic.yml:eval-codex-slices', 'evals-periodic.yml:gate-census', 'evals-marathon.yml:eval-slices',
  ]);
  const ids = new Set<string>();
  for (const [workflowIndex, { job, step }] of executors.entries()) {
    // Container jobs run as `runner`; the host-run Codex job passes the runner's own uid to docker.
    if (job.container) expect(job.container.options).toBe('--user runner');
    else expect(step.run).toContain('--user "$(id -u):$(id -g)"');
    const env = executorEnv(job, step);
    expect(env.EVALS_RUN_ID).toBeString();
    for (const run of ['36302678692', '36302678693']) {
      for (const attempt of ['1', '2']) {
        // The planner sizes the matrix; cover more slices than any live plan.
        expect(job.strategy.matrix.slice).toMatch(/^\$\{\{ fromJSON\(needs\.plan-slices\.outputs\.(?:[a-z]+_)*slices\) \}\}$/);
        for (let slice = 1; slice <= 64; slice++) {
          const id = render(env.EVALS_RUN_ID, {
            'github.run_id': `${run}${workflowIndex}`,
            'github.run_attempt': attempt, 'matrix.slice': String(slice),
          });
          expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
          expect(id.length).toBeLessThan(120);
          expect(ids.has(id)).toBe(false);
          ids.add(id);
        }
      }
    }
  }
});

for (const { name, jobName, job, step } of executors) {
  test(`${name}:${jobName} passes its rendered identity through a real shard and retains native evidence after cleanup`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-native-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(home); fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'test'));
    const configured = executorEnv(job, step);
    const runId = render(configured.EVALS_RUN_ID, {
      'github.run_id': '36302678692', 'github.run_attempt': '2', 'matrix.slice': '4',
    });
    const evalDir = path.join(root, path.basename(configured.GSTACK_EVAL_DIR));
    const file = 'test/native-launch.test.ts';
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
console.log(JSON.stringify({type: 'result', subtype: 'success', result: JSON.stringify({runId: process.env.EVALS_RUN_ID, leakedToken: !!process.env.GITHUB_TOKEN})}));
`, { mode: 0o700 });
    fs.writeFileSync(path.join(root, file), `
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSkillTest } from ${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))};
import { fixtureDocs, preserveDocsEvidence } from ${JSON.stringify(path.join(ROOT, 'test/helpers/docsync-fixture.ts'))};
import { persistPlanCountSnapshot } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-count-artifacts.ts'))};
test('native launch plumbing without a model', async () => {
  expect(process.env.EVALS_RUN_ID).toBe(${JSON.stringify(runId)});
  const fixture = fixtureDocs('risky');
  const result = await runSkillTest({prompt: 'fixture', workingDirectory: fixture.repo,
    model: 'fixture', timeout: 5000, startupGraceMs: 5000, allowedTools: [],
    testName: 'ci-native', runId: process.env.EVALS_RUN_ID, env: fixture.env});
  expect(result.exitReason).toBe('success');
  expect(JSON.parse(result.output)).toEqual({runId: process.env.EVALS_RUN_ID, leakedToken: false});
  const docs = preserveDocsEvidence(fixture, result, process.env.EVALS_RUN_ID!, 'ci-native');
  const snapshots = [0, 1].map(attempt => persistPlanCountSnapshot({skillName: 'ci-native',
    observation: {attempt}, raw: 'native-raw-' + attempt, visible: 'native-visible',
    cwd: fixture.repo, claudeConfigDir: fixture.env.CLAUDE_CONFIG_DIR}));
  fixture.clean();
  expect(fs.existsSync(fixture.home)).toBe(false);
  expect(fs.existsSync(docs)).toBe(true);
  expect(snapshots[0].artifactDir).not.toBe(snapshots[1].artifactDir);
  for (const snapshot of snapshots) {
    expect(snapshot.artifactError).toBeUndefined();
    expect(fs.existsSync(path.join(snapshot.artifactDir!, 'observation.json'))).toBe(true);
  }
  fs.writeFileSync(path.join(process.env.GSTACK_EVAL_DIR!, 'smoke.json'), JSON.stringify({
    docs, snapshots, shardTmp: os.tmpdir(), fixtureRoot: fixture.home,
    runId: process.env.EVALS_RUN_ID, evalDir: process.env.GSTACK_EVAL_DIR,
  }));
});
`);
    try {
      const outcome = await runPaidShard([file], 1, 1, {
        rootDir: root, evalDirBase: evalDir, logDir: root, jobs: 2, log: () => {}, timeoutMs: 30_000,
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home,
          EVALS_RUN_ID: runId, GSTACK_EVAL_DIR: configured.GSTACK_EVAL_DIR,
          GSTACK_CLAUDE_CLI_VERSION: 'synthetic-no-model', GITHUB_TOKEN: 'synthetic-token' },
      });
      expect(outcome.status).toBe('passed');
      const shardDir = path.join(evalDir, 'shards', shardSlug([file]));
      const result = JSON.parse(fs.readFileSync(path.join(shardDir, 'smoke.json'), 'utf8'));
      expect(result).toMatchObject({ runId, evalDir: shardDir });
      expect(fs.existsSync(result.shardTmp)).toBe(false);
      expect(fs.existsSync(result.fixtureRoot)).toBe(false);
      expect(fs.existsSync(result.docs)).toBe(true);
      for (const snapshot of result.snapshots) {
        const record = JSON.parse(fs.readFileSync(path.join(snapshot.artifactDir, 'observation.json'), 'utf8'));
        expect(record.capture.runId).toBe(runId);
        expect(snapshot.artifactDir.startsWith(shardDir + path.sep)).toBe(true);
      }
      const upload = job.steps.find((candidate: any) => candidate.with?.path && containerPath(step, candidate.with.path) === configured.GSTACK_EVAL_DIR);
      expect(upload.if).toBe('always()');
      const captures = job.steps.find((candidate: any) => candidate.name === 'Upload native capture evidence');
      expect(captures.if).toBe('always()');
      expect(captures.with['include-hidden-files']).toBe(true);
      expect(captures.with['retention-days']).toBe(90);
      const artifactName = render(captures.with.name, { 'env.EVALS_RUN_ID': runId });
      expect(artifactName).toBe(`native-captures-${runId}`);
      expect(artifactName).not.toMatch(/^(paid-slice|gate-census)-[0-9]/);
      const patterns = captures.with.path.trim().split('\n').map((pattern: string) => containerPath(step, pattern));
      expect(patterns).toEqual(['~/.gstack/projects/*/e2e-runs', '~/.gstack/projects/*/evals/qa-callers',
        '~/.gstack-dev/e2e-runs', '~/.gstack-dev/evals/qa-callers']);
      const uploaded = patterns.flatMap((pattern: string) => [...new Bun.Glob(`${pattern.replace(/^~\//, '')}/**/*`)
        .scanSync({ cwd: home, absolute: true, dot: true, onlyFiles: true })]);
      expect(uploaded).toContain(result.docs);
      expect(uploaded.some((file: string) => file.endsWith('ci-native.ndjson'))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
}
