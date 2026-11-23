// Release gate census 45216872389 (main @ c4cfe6d1) failed cso-diff-mode twice at the e2e report check's old
// rule that every daily finding is supported. #4739 made /cso keep an unconfirmed candidate as a
// low-confidence hypothesis instead of dropping it, and the captured run did exactly that. These are that
// run's two submissions (attempt 1, paid-slice-8-a1), replayed through the real helper on the case's fixture.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunReportV3 } from '../lib/cso/contracts';
import { DIFF_MODE_BASE, DIFF_MODE_CHANGE, withFixture, requireReport, expectDailyFinding, expectDiffModeReport, isWebhookAuthFinding, type Fixture } from './helpers/cso-e2e-report';

const ROOT = path.resolve(import.meta.dir, '..');
const launcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher');
const CAPTURED = ['diff-mode-45216872389-sub1.json', 'diff-mode-45216872389-sub2.json']
  .map(name => path.join(ROOT, 'test', 'fixtures', 'cso-e2e', name));

function replayCapturedRun(f: Fixture): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-e2e-replay-'));
  try {
    const cso = (...args: string[]) => {
      const result = spawnSync(launcher, args, { cwd: f.repo, encoding: 'utf8', timeout: 120_000,
        env: { HOME: home, GSTACK_HOME: f.state, PATH: process.env.PATH ?? '' } });
      if (result.status !== 0) throw new Error(`gstack-cso ${args[0]} exited ${result.status}: ${result.stderr}${result.stdout}`);
      return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    };
    const run = cso('start', '--repo', f.repo, '--diff', '--base', 'main', '--offline').runId as string;
    const control = path.join(home, 'control');
    fs.mkdirSync(control, { mode: 0o700 });
    for (const capture of CAPTURED) {
      const file = path.join(control, path.basename(capture));
      fs.writeFileSync(file, fs.readFileSync(capture), { mode: 0o600 });
      cso('submit', run, file);
      fs.rmSync(file);
    }
    cso('finish', run);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('cso e2e report contract (release gate 45216872389)', () => {
  test('the captured diff-mode run, with one low-confidence hypothesis, meets the daily and diff-mode contract', async () => {
    await withFixture(DIFF_MODE_BASE, DIFF_MODE_CHANGE, async f => {
      replayCapturedRun(f);
      const report = requireReport(f);
      expectDiffModeReport(report, f);
      expect(report.findings.map(item => item.evidence).sort()).toEqual(['hypothesis', 'supported', 'supported', 'supported']);
    });
  }, 60_000);

  test('the checks still reject a confident hypothesis, a downgraded target and a finding outside the diff', async () => {
    await withFixture(DIFF_MODE_BASE, DIFF_MODE_CHANGE, async f => {
      replayCapturedRun(f);
      const report = requireReport(f);
      const hypothesis = report.findings.find(item => item.evidence === 'hypothesis')!;
      expect(() => expectDailyFinding({ ...hypothesis, confidence: 'medium' })).toThrow();
      const downgraded: RunReportV3 = structuredClone(report);
      const targets = downgraded.findings.filter(isWebhookAuthFinding);
      expect(targets).toHaveLength(1);
      Object.assign(targets[0], { evidence: 'hypothesis', confidence: 'low' });
      expect(() => expectDiffModeReport(downgraded, f)).toThrow();
      const outside: RunReportV3 = structuredClone(report);
      outside.findings[0].location.path = 'app.js';
      expect(() => expectDiffModeReport(outside, f)).toThrow();
    });
  }, 60_000);
});
