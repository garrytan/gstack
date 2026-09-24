import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyHollowShardGuard, buildRunManifest, computePaidCaseSelection, expectedPrCaseCount,
  existingPromptSourceAliases,
  collectorOutcomeCounts, formatProfileCoverage,
  paidSelectionEnv, parseCliOptions, parseRunManifest, prProfileFileSelected,
  prProfileTestNamePattern, runPaidShards, verifySliceResults,
  type PaidCaseSelection, type SliceResult,
} from '../scripts/test-paid-shards';
import { PR_PROFILE_CASE_IDS, PR_PROFILE_FILES } from '../scripts/test-pr-profile';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { resolveModuleSelection } from './helpers/e2e-helpers';

const ROOT = path.resolve(import.meta.dir, '..');
const CEO_FILES = [
  'test/skill-e2e-plan.test.ts', 'test/skill-e2e-ask-user-question-format-compliance.test.ts',
  'test/skill-e2e-opus-47.test.ts', 'test/skill-llm-eval.test.ts',
];
const ceoManifest = () => buildRunManifest({ tier: 'gate', profile: 'pr', sliceCount: 1,
  evalsAll: false, env: {}, changedFiles: ['plan-ceo-review/SKILL.md.tmpl'], discovered: CEO_FILES });

describe('PR profile paid-runner integration', () => {
  test('CLI defaults remain full, explicit PR profile is gated and validated', () => {
    expect(parseCliOptions([], {}).profile).toBe('full');
    expect(parseCliOptions(['--profile', 'pr'], {}).profile).toBe('pr');
    expect(parseCliOptions([], { EVALS_PROFILE: 'pr' }).profile).toBe('pr');
    expect(() => parseCliOptions(['--profile', 'fast'], {})).toThrow('pr or full');
    expect(() => parseCliOptions(['--profile'], {})).toThrow('pr or full');
    expect(() => parseCliOptions(['--profile', 'pr', '--tier', 'periodic'], {})).toThrow('gate tier');
    expect(() => parseCliOptions(['--profile', 'pr', '--files-per-shard', '2'], {})).toThrow('one file');
  });

  test('every short probe has exactly one audited file registered as a dependency', () => {
    const ids = Object.values(PR_PROFILE_FILES).flat().sort();
    expect(ids).toEqual([...PR_PROFILE_CASE_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const [file, cases] of Object.entries(PR_PROFILE_FILES)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      for (const id of cases) expect(E2E_TOUCHFILES[id], id).toContain(file);
    }
  });

  test('planner binds E2E and judge IDs and explicitly defers direct-describe broad probes', () => {
    const manifest = ceoManifest();
    expect(manifest.profile).toBe('pr');
    expect(manifest.selection?.e2e).toContain('plan-ceo-review-benefits');
    expect(manifest.selection?.e2e).not.toContain('plan-ceo-review-plan-mode');
    expect(manifest.selection?.judges).toContain('plan-ceo-review/SKILL.md modes');
    expect(manifest.entries.find(entry => entry.file.includes('opus-47'))?.status).toBe('skipped-by-diff');
    expect(manifest.entries.find(entry => entry.file.includes('ask-user-question'))?.status).toBe('planned');
    expect(manifest.prCoverage?.deferred.some(item => item.id === 'plan-ceo-review-plan-mode')).toBe(true);
    expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
    const env = paidSelectionEnv('pr', manifest.selection!, manifest.selectionReason);
    expect(JSON.parse(env.EVALS_SELECTION_JSON!).selected).toEqual(manifest.selection!.e2e);
    expect(JSON.parse(env.EVALS_JUDGE_SELECTION_JSON!).selected).toEqual(manifest.selection!.judges);
  });

  test('unknown dependencies restore full gate while missing prompt coverage fails before execution', () => {
    const fallback = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['lib/unknown-pr-runtime.ts'] });
    expect(fallback.coverage?.mode).toBe('full-fallback');
    expect(fallback.selection.e2e).toContain('qa-only-no-fix');
    expect(fallback.selection.e2e).not.toContain('autoplan-chain-pty');
    expect(fallback.coverage?.deferred.some(item => item.id === 'autoplan-chain-pty')).toBe(true);
    expect(() => computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['unregistered/nested/SKILL.md'] })).toThrow('requires full validation');
  });

  test('source aliasing requires an actual template and preserves broad-only generated coverage', () => {
    const aliases = existingPromptSourceAliases(['benchmark-models/SKILL.md', 'no-such-skill/SKILL.md']);
    expect(aliases['benchmark-models/SKILL.md']).toBe('benchmark-models/SKILL.md.tmpl');
    expect(aliases['no-such-skill/SKILL.md']).toBeUndefined();
    const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['benchmark-models/SKILL.md'] });
    expect(result.coverage?.mode).toBe('pr');
    expect(result.coverage?.deferredPromptFiles).toContain('benchmark-models/SKILL.md');
    expect(result.coverage?.needsFullValidation).toBe(false);
  });

  test('version-only release changes are verified against the real merge-base before exemption', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-package-'));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git(['init', '-b', 'main']);
      git(['config', 'user.email', 'test@gstack.local']);
      git(['config', 'user.name', 'Fixture']);
      const file = path.join(root, 'package.json');
      fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', scripts: { test: 'bun test' } }));
      git(['add', 'package.json']); git(['commit', '-m', 'seed']);
      fs.writeFileSync(file, JSON.stringify({ version: '1.0.1', scripts: { test: 'bun test' } }));
      const options = { profile: 'pr' as const, rootDir: root, env: { EVALS_BASE: 'main' }, changedFiles: ['package.json'] };
      const versionOnly = computePaidCaseSelection(options);
      expect(versionOnly.coverage?.mode).toBe('pr');
      expect(versionOnly.selection).toEqual({ e2e: [], judges: [] });
      fs.writeFileSync(file, JSON.stringify({ version: '1.0.1', scripts: { test: 'bun another-runner' } }));
      expect(computePaidCaseSelection(options).coverage?.mode).toBe('full-fallback');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('tampered profiles, broadened IDs and unplanned direct-describe files cannot import', () => {
    const manifest = ceoManifest();
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, profile: 'quick' }))).toThrow('profile');
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, selection: undefined }))).toThrow('coverage/selection');
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, prCoverage: { ...manifest.prCoverage, missingCoverage: ['missing/SKILL.md'] } }))).toThrow('full validation');
    const broad = structuredClone(manifest);
    broad.selection!.e2e!.push('qa-only-no-fix'); broad.prCoverage!.e2e.push('qa-only-no-fix');
    expect(() => parseRunManifest(JSON.stringify(broad))).toThrow('broad-only');
    const injected = structuredClone(manifest);
    injected.entries.find(entry => entry.file.includes('opus-47'))!.status = 'planned';
    injected.entries.find(entry => entry.file.includes('opus-47'))!.slice = 1;
    expect(() => parseRunManifest(JSON.stringify(injected))).toThrow('outside its PR case selection');
    for (const action of ['remove', 'skip', 'duplicate'] as const) {
      const missing = structuredClone(manifest);
      const file = 'test/skill-e2e-plan.test.ts';
      if (action === 'remove') missing.entries = missing.entries.filter(entry => entry.file !== file);
      if (action === 'skip') missing.entries.find(entry => entry.file === file)!.status = 'skipped-by-diff';
      if (action === 'duplicate') missing.entries.push({ ...missing.entries.find(entry => entry.file === file)! });
      expect(() => parseRunManifest(JSON.stringify(missing)), action).toThrow('exactly one planned owning file');
    }
    const noJudge = structuredClone(manifest);
    noJudge.entries = noJudge.entries.filter(entry => entry.file !== 'test/skill-llm-eval.test.ts');
    expect(() => parseRunManifest(JSON.stringify(noJudge))).toThrow('exactly one planned owning file');
  });

  test('PR children reject absent or malformed selection rather than recomputing broad work', () => {
    const previous = process.env.EVALS_PROFILE;
    process.env.EVALS_PROFILE = 'pr';
    let recomputed = 0;
    try {
      expect(() => resolveModuleSelection(undefined, () => { recomputed++; return null; })).toThrow('persisted');
      expect(() => resolveModuleSelection('{"selected":42}', () => { recomputed++; return null; })).toThrow('valid persisted');
      expect(recomputed).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.EVALS_PROFILE; else process.env.EVALS_PROFILE = previous;
    }
  });

  test('name filters handle literal labels and never select broad raw tests', () => {
    const selection = { e2e: ['plan-review-report', 'auq-format-gate'], judges: ['plan-ceo-review/SKILL.md modes'] };
    const report = new RegExp(prProfileTestNamePattern('test/skill-e2e-plan.test.ts', selection));
    expect(report.test('Plan Review Report E2E /plan-eng-review writes GSTACK REVIEW REPORT to plan file')).toBe(true);
    expect(report.test('Plan Review Report E2E plan-ceo-review')).toBe(false);
    const auq = new RegExp(prProfileTestNamePattern('test/skill-e2e-ask-user-question-format-compliance.test.ts', selection));
    expect(auq.test("/plan-ceo-review's first AskUserQuestion is a compliant decision brief (7/7 + substance)")).toBe(true);
    const judge = new RegExp(prProfileTestNamePattern('test/skill-llm-eval.test.ts', selection));
    expect(judge.test('LLM-as-judge plan-ceo-review/SKILL.md modes')).toBe(true);
    expect(judge.test('LLM-as-judge plan-ceo-review/SKILLxmd modes')).toBe(false);
    expect(prProfileFileSelected('test/skill-e2e-opus-47.test.ts', selection)).toBe(false);
  });

  test('real Bun child executes only the persisted case through the actual registered helper', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-profile-'));
    const file = 'test/skill-e2e-plan.test.ts';
    const receipt = path.join(root, 'receipt.txt');
    const selection: PaidCaseSelection = { e2e: ['plan-ceo-review-benefits'], judges: [] };
    try {
      fs.mkdirSync(path.join(root, 'test'));
      fs.writeFileSync(path.join(root, file), `
        import { test } from 'bun:test';
        import { appendFileSync } from 'node:fs';
        import { describeIfSelected, testIfSelected } from ${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-helpers.ts'))};
        describeIfSelected('fixture', ['plan-ceo-review-benefits', 'plan-review-report'], () => {
          testIfSelected('plan-ceo-review-benefits', async () => { appendFileSync(${JSON.stringify(receipt)}, 'selected\\n'); }, 5000);
          testIfSelected('plan-review-report', async () => { throw new Error('unselected model boundary executed'); }, 5000);
          test('unexpected raw paid call', () => { throw new Error('raw model boundary executed'); });
        });
      `);
      const options = {
        rootDir: root, timeoutMs: 10_000, jobs: 1, log: () => {},
        expectedCases: { [file]: 1 }, casePatterns: { [file]: prProfileTestNamePattern(file, selection) },
        env: { PATH: path.dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: root, GSTACK_HOME: path.join(root, 'state'), GSTACK_EVAL_DIR: path.join(root, 'evals'),
          GSTACK_CLAUDE_CLI_VERSION: 'free-fixture', EVALS: '1', EVALS_TIER: 'gate', EVALS_PREFLIGHT_OK: '1',
          ...paidSelectionEnv('pr', selection, 'free helper execution proof') },
      };
      const result = await runPaidShards([[file]], options);
      expect(result.outcomes[0].status).toBe('passed');
      expect(fs.readFileSync(receipt, 'utf8')).toBe('selected\n');
      // The same selected callback cannot cover a second promised case.
      const incomplete = await runPaidShards([[file]], { ...options, expectedCases: { [file]: 2 } });
      expect(incomplete.outcomes[0].status).toBe('failed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('report rejects missing selection binding and hollow or incomplete executed-case counts', () => {
    const manifest = ceoManifest();
    const result: SliceResult = {
      version: 1, tier: 'gate', profile: 'pr', selection: manifest.selection, sliceIndex: 1, sliceCount: 1,
      outcomes: manifest.entries.filter(entry => entry.status === 'planned').map(entry => ({
        files: [entry.file], status: 'passed', exitCode: 0, elapsedMs: 1,
        executedTests: expectedPrCaseCount(entry.file, manifest.selection!), skippedTests: 0,
        ...(entry.budget ? { budget: entry.budget } : {}),
      })),
    };
    expect(verifySliceResults(manifest, [result]).ok).toBe(true);
    expect(verifySliceResults(manifest, [{ ...result, selection: undefined }]).ok).toBe(false);
    const hollow = structuredClone(result);
    hollow.outcomes[0].skippedTests = hollow.outcomes[0].executedTests;
    expect(verifySliceResults(manifest, [hollow]).ok).toBe(false);
    const guarded = applyHollowShardGuard([{ ...hollow.outcomes[0], shard: 1, groupPid: null }], { evalsAll: false, requireExecuted: true });
    expect(guarded[0].status).toBe('passed-empty');
  });

  test('report distinguishes retained/deferred coverage and final executed/reused outcomes from attempts', () => {
    const manifest = ceoManifest();
    const lines = formatProfileCoverage(manifest).join('\n');
    expect(lines).toContain('profile=pr mode=pr');
    expect(lines).toContain(`selected E2E=${manifest.selection!.e2e!.length}`);
    expect(lines).toContain('not PR passes');
    expect(collectorOutcomeCounts([{ tests: [
      { name: 'retry', suite: 'judge', passed: false },
      { name: 'retry', suite: 'judge', passed: true, execution: 'executed' },
      { name: 'cached', suite: 'judge', passed: true, execution: 'reused' },
      { name: 'failed', suite: 'native', passed: false },
    ] }])).toEqual({ executed: 2, reused: 1, passed: 2, failed: 1, manual_accepted: 0, attempts: 4 });
  });
});
