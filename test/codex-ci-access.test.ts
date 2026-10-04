/**
 * The CI image's Codex CLI and credential reach only the Codex eval files.
 *
 * Every other paid case must see Codex exactly as it did before Codex entered
 * the image: not on PATH and not logged in, so a skill's outside-voice probe
 * (`command -v codex`) reports not_installed and gate verdicts and slice
 * budgets do not move. This pins the image (Codex off PATH), the workflows
 * (login under a non-default home, never exported as CODEX_HOME), the
 * per-shard scoping helper, and the shard runner's use of it.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_CI_CASES, CODEX_CI_ENV, CODEX_CI_FILES, buildRunManifest, codexShardAccess, isCodexShard, packBySliceBudget, parseRunManifest, runPaidShards, scopeCodexAccess, shardFile } from '../scripts/test-paid-shards';
import { buildHermeticEnv } from './helpers/hermetic-env';
import { E2E_TIERS, E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = '/opt/codex/bin';
const HOME = '/home/runner/.gstack-ci-codex';
const ciEnv = (tier: string): NodeJS.ProcessEnv => ({ PATH: '/usr/local/bin:/usr/bin:/bin', EVALS_TIER: tier, [CODEX_CI_ENV.binDir]: BIN, [CODEX_CI_ENV.home]: HOME });
const sees = (env: NodeJS.ProcessEnv) => ({
  onPath: (env.PATH ?? '').split(path.delimiter).includes(BIN),
  home: env.CODEX_HOME ?? null,
  leaked: Object.keys(env).filter(name => name.startsWith('GSTACK_CI_CODEX')),
});
const planned = (tier: 'gate' | 'periodic') => buildRunManifest({ tier, profile: 'full', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } })
  .entries.filter(entry => entry.status === 'planned').map(entry => entry.file);

/** The paid test files a registered E2E case runs in. */
const caseFiles = (id: string) => (E2E_TOUCHFILES[id] ?? []).filter(dep => /^test\/.*\.test\.ts$/.test(dep));

describe('codex CI access scope', () => {
  test('the Codex files and opted-in cases hold the approved periodic Codex cases and no gate case', () => {
    for (const file of [...CODEX_CI_FILES, ...Object.keys(CODEX_CI_CASES)]) expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    const reaches = (id: string) => caseFiles(id).some(file => CODEX_CI_FILES.includes(file) || CODEX_CI_CASES[file]?.includes(id));
    for (const id of ['codex-review', 'codex-review-findings', 'codex-discover-skill', 'outside-voice-codex-to-claude-code',
      'outside-voice-claude-code-to-codex', 'outside-plan-disabled-no-fallback', 'codex-sol-scope-termination']) {
      expect(E2E_TIERS[id], id).toBe('periodic');
      expect(reaches(id), `${id} cannot reach the CI Codex`).toBe(true);
    }
    for (const ids of Object.values(CODEX_CI_CASES)) for (const id of ids) expect(E2E_TIERS[id], id).toBe('periodic');
    const gateInCodexFiles = Object.keys(E2E_TIERS)
      .filter(id => E2E_TIERS[id] === 'gate' && caseFiles(id).some(file => CODEX_CI_FILES.includes(file)));
    expect(gateInCodexFiles, 'a gate case would run with an authenticated Codex').toEqual([]);
  });

  test('only the opted-in case of a mixed file asks for Codex, and hermetic sessions drop the CI variables', () => {
    for (const [file, ids] of Object.entries(CODEX_CI_CASES)) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const calls = [...source.matchAll(/process\.env\.GSTACK_CI_CODEX_BIN_DIR\b/g)].map(match => match.index!);
      expect(calls, file).toHaveLength(ids.length);
      for (const [i, id] of ids.entries()) {
        const start = source.indexOf(`IfSelected('${id}'`);
        const next = source.slice(start + 1).search(/IfSelected\('/);
        const end = next < 0 ? source.length : start + 1 + next;
        expect(calls[i]! > start && calls[i]! < end, `${file}: CI Codex read outside the ${id} case`).toBe(true);
      }
    }
    const child = buildHermeticEnv({ ...ciEnv('periodic'), HOME: '/home/runner' }, {});
    expect(Object.keys(child).filter(name => name.startsWith('GSTACK_CI_CODEX'))).toEqual([]);
    expect((child.PATH ?? '').split(path.delimiter)).not.toContain(BIN);
  });

  test('no planned gate shard can see the CI Codex CLI or its credential', () => {
    const gate = planned('gate');
    expect(gate.length).toBeGreaterThan(20);
    for (const key of gate) {
      const env = ciEnv('gate');
      scopeCodexAccess(env, [shardFile(key)]);
      expect(sees(env), key).toEqual({ onPath: false, home: null, leaked: [] });
      expect(codexShardAccess([shardFile(key)], 'periodic') === 'path', `${key}: a gate shard is a Codex file`).toBe(false);
    }
  });

  test('in the periodic census only the Codex files see Codex on PATH', () => {
    const periodic = planned('periodic');
    const access = (key: string) => {
      const env = ciEnv('periodic');
      scopeCodexAccess(env, [shardFile(key)]);
      return { key, ...sees(env) };
    };
    const results = periodic.map(access);
    const granted = results.filter(result => result.onPath);
    expect([...new Set(granted.map(result => shardFile(result.key)))].sort()).toEqual([...CODEX_CI_FILES].sort());
    for (const result of granted) expect(result.home, result.key).toBe(HOME);
    for (const result of results.filter(result => !result.onPath)) {
      expect(result.home, result.key).toBeNull();
      expect(result.leaked.length === 0 || shardFile(result.key) in CODEX_CI_CASES, result.key).toBe(true);
    }
  });

  test('a mixed shard is denied, case and trial keys follow their file, and local runs are untouched', () => {
    expect(codexShardAccess(['test/codex-e2e.test.ts', 'test/skill-e2e-plan.test.ts'], 'periodic')).toBe('none');
    expect(codexShardAccess([shardFile('test/codex-e2e.test.ts#codex-review~t2')], 'periodic')).toBe('path');
    expect(codexShardAccess(['test/codex-e2e.test.ts'], 'gate')).toBe('none');
    expect(codexShardAccess(['test/skill-e2e-workflow.test.ts'], 'gate')).toBe('none');
    expect(codexShardAccess(['test/skill-e2e-workflow.test.ts'], 'periodic')).toBe('case-opt-in');
    expect(codexShardAccess([], 'periodic')).toBe('none');
    const ci = { ...ciEnv('periodic'), CODEX_HOME: '/somewhere/else' };
    scopeCodexAccess(ci, [shardFile('test/skill-e2e-plan.test.ts#codex-offered-eng-review')]);
    expect(sees(ci)).toEqual({ onPath: false, home: null, leaked: [] });
    const optIn = { ...ciEnv('periodic'), CODEX_HOME: '/somewhere/else' };
    scopeCodexAccess(optIn, ['test/skill-e2e-workflow.test.ts']);
    expect(sees(optIn)).toEqual({ onPath: false, home: null, leaked: [CODEX_CI_ENV.binDir, CODEX_CI_ENV.home] });
    const local: NodeJS.ProcessEnv = { PATH: '/usr/bin', CODEX_HOME: '/home/dev/.codex' };
    scopeCodexAccess(local, ['test/skill-e2e-plan.test.ts']);
    expect(local).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/home/dev/.codex' });
  });

  test.skipIf(process.platform === 'win32')('the paid shard runner gives each child the scoped environment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ci-access-'));
    try {
      const bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
      fs.mkdirSync(bin); fs.mkdirSync(home);
      fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const shards = [['test/codex-e2e.test.ts'], ['test/skill-e2e-workflow.test.ts'],
        ['test/skill-e2e-plan.test.ts#codex-offered-eng-review'], ['test/skill-e2e-outside-voice.test.ts', 'test/skill-e2e-review.test.ts']];
      const probe = 'p=$(command -v codex || echo none); printf "%s|%s|%s" "$p" "${CODEX_HOME:-}" "$(env | grep -c "^GSTACK_CI_CODEX" || true)"';
      const run = async (tier: string) => {
        const out = fs.mkdtempSync(path.join(dir, `${tier}-`));
        await runPaidShards(shards, {
          jobs: 1, timeoutMs: 30_000, log: () => {}, logDir: dir,
          env: { PATH: '/usr/bin:/bin', HOME: dir, EVALS_TIER: tier, GSTACK_CLAUDE_CLI_VERSION: 'test', [CODEX_CI_ENV.binDir]: bin, [CODEX_CI_ENV.home]: home },
          commandFor: files => ({ command: '/bin/sh', args: ['-c', `${probe} > "${path.join(out, String(shards.indexOf(files)))}"`] }),
        });
        return shards.map((_, index) => fs.readFileSync(path.join(out, String(index)), 'utf8'));
      };
      expect(await run('periodic')).toEqual([`${path.join(bin, 'codex')}|${home}|0`, 'none||2', 'none||0', 'none||0']);
      expect(await run('gate')).toEqual(['none||0', 'none||0', 'none||0', 'none||0']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('Codex slices for the host-run job', () => {
  const budgetPlan = () => buildRunManifest({ tier: 'periodic', profile: 'full', sliceBudgetMs: 540_000, jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' } });

  test('packing never puts a Codex shard on a slice with other shards', () => {
    const files = ['test/codex-e2e.test.ts', 'test/skill-e2e-outside-voice.test.ts', 'test/skill-e2e-plan.test.ts', 'test/skill-e2e-review.test.ts'];
    const recorded = Object.fromEntries(files.map(file => [file, 60_000]));
    const plan = packBySliceBudget(files, 540_000, 2, recorded, undefined, file => isCodexShard(file, 'periodic'));
    expect(plan.slices).toEqual([['test/codex-e2e.test.ts', 'test/skill-e2e-outside-voice.test.ts'], ['test/skill-e2e-plan.test.ts', 'test/skill-e2e-review.test.ts']]);
    expect(packBySliceBudget(files, 540_000, 2, recorded).slices).toHaveLength(1);
  });

  test('the live periodic plan names exactly the slices holding Codex shards, and they hold nothing else', () => {
    const manifest = budgetPlan();
    const planned = manifest.entries.filter(entry => entry.status === 'planned');
    const codexSlices = manifest.plan!.codexSlices!;
    expect(codexSlices.length).toBeGreaterThan(0);
    expect(new Set(planned.filter(entry => isCodexShard(entry.file, 'periodic')).map(entry => shardFile(entry.file))))
      .toEqual(new Set([...CODEX_CI_FILES, ...Object.keys(CODEX_CI_CASES)]));
    for (const entry of planned) expect(codexSlices.includes(entry.slice), entry.file).toBe(isCodexShard(entry.file, 'periodic'));
  });

  test('a manifest that hides a Codex slice or mixes it with another shard fails to parse', () => {
    const manifest = budgetPlan();
    const codexSlice = manifest.plan!.codexSlices![0]!;
    const hidden = structuredClone(manifest);
    hidden.plan!.codexSlices = [];
    expect(() => parseRunManifest(JSON.stringify(hidden))).toThrow(/Codex slices must be exactly/);
    const omitted = structuredClone(manifest);
    delete omitted.plan!.codexSlices;
    expect(() => parseRunManifest(JSON.stringify(omitted))).toThrow(/Codex slices must be exactly/);
    const mixed = structuredClone(manifest);
    mixed.entries.find(entry => entry.status === 'planned' && !isCodexShard(entry.file, 'periodic'))!.slice = codexSlice;
    expect(() => parseRunManifest(JSON.stringify(mixed))).toThrow(new RegExp(`Codex slice ${codexSlice} also holds`));
  });
});

describe('codex CI access in the image and workflows', () => {
  test('the image installs Codex off PATH at the directory it advertises', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, '.github/docker/Dockerfile.ci'), 'utf8');
    expect(dockerfile).toMatch(/^ENV GSTACK_CI_CODEX_BIN_DIR=\/opt\/codex\/bin$/m);
    expect(dockerfile).toMatch(/npm i -g --prefix=\/opt\/codex @openai\/codex@\d+\.\d+\.\d+/);
    expect(dockerfile).toContain('! command -v codex');
    expect(dockerfile).not.toMatch(/^ENV PATH=.*\/opt\/codex/m);
  });

  test('the login step never makes the credential the default Codex home', () => {
    const steps: string[] = [];
    for (const name of ['evals.yml', 'evals-periodic.yml', 'evals-marathon.yml']) {
      const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8')) as any;
      for (const job of Object.values<any>(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!/login --with-api-key/.test(String(step.run ?? ''))) continue;
          steps.push(String(step.run));
          // The paid jobs run inside the CI container whose default shell is `sh -e` (dash),
          // which rejects `set -o pipefail`; the login step must opt into bash.
          if (/pipefail/.test(String(step.run))) expect({ step: step.name, shell: step.shell }).toEqual({ step: step.name, shell: 'bash' });
        }
      }
    }
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const run of steps) {
      // The host-run Codex job logs in inside its one `docker run` script, so the home stays a shell export there.
      if (run.includes('docker run ')) {
        const exported = run.indexOf('export GSTACK_CI_CODEX_HOME="$CODEX_HOME"');
        expect(exported).toBeGreaterThan(run.indexOf('login --with-api-key'));
        expect(run.indexOf('unset CODEX_HOME')).toBeGreaterThan(exported);
        expect(run.indexOf('unset CODEX_HOME')).toBeLessThan(run.indexOf('scripts/test-paid-shards.ts'));
      } else {
        expect(run).toContain('echo "GSTACK_CI_CODEX_HOME=$CODEX_HOME" >> "$GITHUB_ENV"');
      }
      expect(run).not.toMatch(/echo "CODEX_HOME=/);
      expect(run).not.toContain('$HOME/.codex"');
      expect(run).toContain('"${GSTACK_CI_CODEX_BIN_DIR:?}/codex"');
    }
  });
});
