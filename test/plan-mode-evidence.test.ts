import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { assertNoPlanFileDecisions, seededPlanTargeted } from './helpers/plan-mode-evidence';
import { planFileHasDecisionsSection, type PlanSkillObservation } from './helpers/claude-pty-runner';

const ROOT = path.resolve(import.meta.dir, '..');
const SECRET = 'fixture-private-diagnostic-value';

// Import the actual paid registration in an isolated Bun process. Only model
// execution is replaced; Bun assertions and the report-file validator are real.
for (const skill of ['design', 'eng'] as const) {
 const PAID_FILE = `test/skill-e2e-plan-${skill}-plan-mode.test.ts`;
 const skillName = `plan-${skill}-review`;
 for (const scenario of ['success', 'missing-auto-select', 'scope-question', 'bad-report', 'bad-outcome', 'retry', 'unwritable', ...(skill === 'eng' ? ['missing-decisions'] : [])]) {
  test(`${skill} plan-mode caller preserves its outcome and failure evidence: ${scenario}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-mode-evidence-'));
    const evalDir = path.join(dir, 'artifacts');
    const events = path.join(dir, 'calls.jsonl');
    const script = path.join(dir, 'registration.test.ts');
    if (scenario === 'unwritable') fs.writeFileSync(evalDir, 'existing file');
    fs.writeFileSync(script, `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const runnerPath = ${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))};
const { assertReportAtBottomIfPlanWritten, planFileHasDecisionsSection } = await import(runnerPath);
const scenario = ${JSON.stringify(scenario)};
const report = ${JSON.stringify(path.join(dir, 'plan.md'))};
fs.writeFileSync(report, '# Plan\\n' + (scenario === 'missing-decisions' ? '' : '## Decisions to confirm\\nPending.\\n')
  + '## GSTACK REVIEW REPORT\\nDone.\\n' + (scenario === 'bad-report' ? '## Unexpected trailing section\\n' : ''));
let calls = 0;
mock.module(runnerPath, () => ({
  assertReportAtBottomIfPlanWritten, planFileHasDecisionsSection,
  runPlanSkillObservation: async opts => {
    const call = ++calls;
    fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ call, opts }) + '\\n');
    return { outcome: ['bad-report', 'missing-decisions'].includes(scenario) ? 'plan_ready' : scenario === 'bad-outcome' ? 'auto_decided' : 'asked',
      summary: 'Returned observation ' + call, elapsedMs: 42,
      evidence: 'Visible terminal tail ' + call + ': ' + process.env.DIAGNOSTIC_API_TOKEN,
      ...(['bad-report', 'missing-decisions'].includes(scenario) ? { planFile: report } : {}),
      proseAUQEverObserved: true, waitingEverObserved: true, tokensObserved: { 'draft-plan': true, 'scope-announcement': false },
      scopeGateQuestionObserved: scenario === 'scope-question',
      scopeGateAutoSelectObserved: !['missing-auto-select', 'retry', 'unwritable'].includes(scenario) };
  },
}));
await import(${JSON.stringify(path.join(ROOT, PAID_FILE))});
`);
    try {
      const child = Bun.spawnSync([process.execPath, 'test', ...(scenario === 'retry' ? ['--retry', '1'] : []), script], {
        cwd: ROOT, timeout: 10_000, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, EVALS: '1', EVALS_TIER: 'periodic', GSTACK_EVAL_DIR: evalDir,
          DIAGNOSTIC_API_TOKEN: SECRET, TMPDIR: dir, TMP: dir, TEMP: dir },
      });
      const output = child.stdout.toString() + child.stderr.toString();
      expect(child.exitCode, output).toBe(scenario === 'success' ? 0 : 1);
      expect(output).not.toContain('Unhandled error between tests');
      const calls = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toHaveLength(scenario === 'retry' ? 3 : 2);
      for (const { opts } of calls) {
        expect(opts.skillName).toBe(skillName);
        expect(opts.inPlanMode).toBe(true);
        expect(opts.timeoutMs).toBe(CAPTURE_MS);
        const keys = ['skillName', 'inPlanMode', 'timeoutMs'];
        if (opts.initialPlanContent) {
          keys.push('initialPlanContent', 'trackTokens');
          expect(opts.trackTokens.length).toBeGreaterThan(0);
          for (const token of opts.trackTokens) expect(opts.initialPlanContent).toContain(token);
          if (skill === 'eng') {
            keys.push('extraArgs', 'cwd', 'env');
            expect(opts.extraArgs).toEqual(['--disallowedTools', 'AskUserQuestion']);
            // The seeded runner plan reviews its own fixture project, never this checkout.
            expect(path.isAbsolute(opts.cwd)).toBe(true);
            expect(path.relative(ROOT, opts.cwd).startsWith('..')).toBe(true);
            expect(opts.env).toEqual({ DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
          }
        }
        expect(Object.keys(opts).sort()).toEqual(keys.sort());
      }
      if (scenario === 'unwritable') {
        expect(output).toContain('failed to retain observation');
        expect(output).toContain('scopeGateAutoSelectObserved');
        expect(output).toContain('Received: false');
        expect(fs.readFileSync(evalDir, 'utf8')).toBe('existing file');
        return;
      }
      const root = path.join(evalDir, 'plan-mode');
      const dirs = fs.existsSync(root) ? fs.readdirSync(root) : [];
      expect(dirs).toHaveLength(scenario === 'success' ? 0 : ['retry', 'bad-report', 'bad-outcome'].includes(scenario) ? 2 : 1);
      expect(new Set(dirs).size).toBe(dirs.length);
      for (const id of dirs) {
        const file = path.join(root, id, 'observation.json');
        const text = fs.readFileSync(file, 'utf8');
        const artifact = JSON.parse(text);
        expect(text).not.toContain(SECRET);
        expect(artifact.attemptId).toBe(id);
        expect(artifact.caseFile).toBe(PAID_FILE);
        expect(artifact.caseName).toMatch(/^(reaches a terminal outcome|scope gate auto-selects B|STOP gate fires)/);
        expect(artifact.nativeSessionId).toBeNull();
        expect(artifact.provenance).toContain('native session identity is not exposed');
        expect(artifact.observation.evidence).toMatch(/^Visible terminal tail \d: \[REDACTED_ENV\]$/);
        expect(artifact.observation.elapsedMs).toBe(42);
        expect(artifact.observation.tokensObserved).toEqual({ 'draft-plan': true, 'scope-announcement': false });
        expect(artifact.observation.waitingEverObserved).toBe(true);
        expect(artifact.failure.message.length).toBeGreaterThan(0);
        if (process.platform !== 'win32') {
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
          expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        }
      }
      if (scenario === 'bad-report') expect(output).toContain('GSTACK REVIEW REPORT contract violation');
      if (scenario === 'missing-auto-select') expect(output).toContain('scopeGateAutoSelectObserved');
      if (scenario === 'scope-question') expect(output).toContain('scopeGateQuestionObserved');
      if (scenario === 'missing-decisions') expect(output).toContain('without a question');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
}

// Seeded-plan targeting and plan-file decision substitutes (stored observations).
{
  const TOKENS = ['ShardManager', 'ResultMerger'];
  const base = { outcome: 'asked', summary: '', evidence: '', elapsedMs: 1 } as unknown as PlanSkillObservation;
  const targetingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-targeting-'));
  afterAll(() => fs.rmSync(targetingDir, { recursive: true, force: true }));
  const plan = (name: string, body: string) => { const file = path.join(targetingDir, name); fs.writeFileSync(file, body); return file; };

  describe('seeded plan targeting', () => {
    test.each([
      ['exact announcement observed', { scopeGateAutoSelectObserved: true }],
      ['paraphrased announcement with seed content in the review', { scopeGateAutoSelectObserved: false, tokensObserved: { ShardManager: true, ResultMerger: false } }],
    ])('known-good: %s', (_name, fields) => {
      expect(seededPlanTargeted({ ...base, ...fields } as PlanSkillObservation, TOKENS)).toBe(true);
    });
    test.each([
      ['no announcement and no seed content', { scopeGateAutoSelectObserved: false, tokensObserved: { ShardManager: false, ResultMerger: false } }],
      ['an untracked token cannot stand in for the seed', { scopeGateAutoSelectObserved: false, tokensObserved: { 'draft-plan': true } }],
    ])('known-bad: %s', (_name, fields) => {
      expect(seededPlanTargeted({ ...base, ...fields } as PlanSkillObservation, TOKENS)).toBe(false);
    });
  });

  describe('plan-file decision substitute', () => {
    test('a plan_ready plan file with ## Decisions fails', () => {
      const planFile = plan('decisions.md', '# Plan\n\n## Decisions to confirm\n- A or B?\n\n## GSTACK REVIEW REPORT\n');
      expect(() => assertNoPlanFileDecisions({ ...base, outcome: 'plan_ready', planFile } as PlanSkillObservation, planFileHasDecisionsSection))
        .toThrow('not written to the plan as a substitute');
    });
    test('a plan_ready plan file without ## Decisions passes, and asked runs are not checked', () => {
      const planFile = plan('clean.md', '# Plan\n\n## Approach\nShip it.\n\n## GSTACK REVIEW REPORT\n');
      expect(() => assertNoPlanFileDecisions({ ...base, outcome: 'plan_ready', planFile } as PlanSkillObservation, planFileHasDecisionsSection)).not.toThrow();
      expect(() => assertNoPlanFileDecisions({ ...base, outcome: 'asked' } as PlanSkillObservation, planFileHasDecisionsSection)).not.toThrow();
    });
  });
}
