import { afterAll, expect } from 'bun:test';
import { runSkillTest, type SkillTestResult } from './helpers/session-runner';
import { createReadinessFixture } from './helpers/sync-gbrain-readiness-fixture';
import { readinessVerdictProblems } from './helpers/sync-gbrain-readiness-verdict';
import { describeE2ETier } from './helpers/e2e-gate';
import { createEvalCollector, finalizeEvalCollector, describeIfSelected, testIfSelected, recordE2E, runId } from './helpers/e2e-helpers';

const collector = createEvalCollector('e2e-sync-gbrain-readiness');
const describeE2E = describeE2ETier('periodic');
afterAll(async () => { await finalizeEvalCollector(collector); });

async function runReadiness(kind: 'ready' | 'unknown', name: string) {
  const fixture = createReadinessFixture(kind);
  let result: SkillTestResult | undefined;
  let failure: unknown;
  try {
    result = await runSkillTest({
      testName: name, runId, workingDirectory: fixture.workDir, env: fixture.env,
      prompt: 'Read readiness.md. Step 2 already ran. Execute the Step 4 read helper once, apply its guidance decision, then give the Step 5 capability and overall verdict from that evidence. The fixture supplies only this helper interface: other Step 5 rows are unavailable, so report them unknown rather than invoking extra CLI commands. Do not install, sync, doctor, put, delete, or repair the brain. A read does not prove semantic search or writes. Report whether CLAUDE.md changed.',
      maxTurns: 8, timeout: 240_000, allowedTools: ['Read', 'Bash', 'Edit', 'Write'],
      tools: ['Read', 'Bash', 'Edit', 'Write'],
    });
    expect(result.exitReason).toBe('success');
    expect(fixture.calls()).toEqual([
      'sources list --json',
      'list --source client-fixture --limit 1',
      'get code/fixture/readme --source client-fixture --json',
    ]);
    const content = fixture.content();
    expect(fixture.sourceIntact()).toBe(true);
    if (kind === 'ready') {
      expect(content).toContain('## GBrain Search Guidance');
      expect(content).toContain('<!-- gstack-gbrain-search-guidance:start -->');
    } else {
      expect(content).toContain(fixture.guidance);
    }
    expect(readinessVerdictProblems(kind, result.output)).toEqual([]);
  } catch (error) { failure = error; }
  finally {
    if (result) recordE2E(collector, name, 'sync-gbrain-readiness', result,
      failure ? { passed: false, error: String(failure) } : undefined);
    else collector?.addTest({ name, suite: 'sync-gbrain-readiness', tier: 'e2e', passed: false,
      duration_ms: 0, cost_usd: 0, exit_reason: 'harness_error', error: String(failure) });
    fixture.cleanup();
  }
  if (failure) throw failure;
}

describeE2E('sync-gbrain periodic readiness', () => describeIfSelected('sync-gbrain source-scoped readiness actors', ['sync-gbrain-read-ready', 'sync-gbrain-read-unknown'], () => {
  testIfSelected('sync-gbrain-read-ready', async () => runReadiness('ready', 'sync-gbrain-read-ready'), 270_000);
  testIfSelected('sync-gbrain-read-unknown', async () => runReadiness('unknown', 'sync-gbrain-read-unknown'), 270_000);
}));
