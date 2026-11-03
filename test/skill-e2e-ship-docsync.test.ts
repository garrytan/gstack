import { expect, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_LONG_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { runId, describeIfSelected, testConcurrentIfSelected, createEvalCollector, recordE2E, finalizeEvalCollector, logCost } from './helpers/e2e-helpers';
import { describeE2ETier } from './helpers/e2e-gate';
import { acceptedChangedPaths, docsAttemptContracts, docsDispatchIndices, vetDocsCompletion } from './helpers/docsync-contract';
import { fixtureDocs, repoSnapshot, changedFiles, DOC_PATH, preserveDocsEvidence, sawSpawnedMarker, childReportedSpawnedMarker, type DocsScenario } from './helpers/docsync-fixture';
import { observeDocsWrites, docsWriteFailures, docsShipPhase, docsToolFailures, docsCompletedRead, docsSessionOptions } from './helpers/docsync-observer';
import type { SkillTestResult } from './helpers/session-runner';
import { runShipDocsFault } from './helpers/docsync-fault-eval';

const describeE2E = describeE2ETier('gate');
const collector = createEvalCollector('e2e-ship-docsync');

async function runShipDocs(testName: string, scenario: DocsScenario) {
  if (!process.env.EVALS_RUN_ID) throw Error('Native docs acceptance requires EVALS_RUN_ID');
  const deadline = Date.now() + CAPTURE_LONG_MS;
  const fixture = fixtureDocs(scenario);
  try {
    const skeleton = fs.readFileSync(path.join(fixture.skills, 'ship/SKILL.md'), 'utf8');
    const prBody = fs.readFileSync(path.join(fixture.skills, 'ship/sections/pr-body.md'), 'utf8');
    const phase = path.join(fixture.home, 'phase.md');
    const storePointer = fs.readFileSync(path.join(process.env.DOCSYNC_GENERATED_ROOT || path.resolve(import.meta.dir, '..'), 'ship/sections/apple-release.md'), 'utf8')
      .split('\n').find(line => line.startsWith('**Documentation preflight:**'));
    if (!storePointer) throw new Error('store documentation preflight pointer moved');
    fs.writeFileSync(phase, docsShipPhase(skeleton, prBody, scenario, storePointer));
    const report = path.join(fixture.home, 'ship-report.md');
    const receipt = path.join(fixture.home, 'publication.json');
    const publish = path.join(fixture.home, 'fixture-publish.ts');
    fs.writeFileSync(publish, `import {readFileSync,writeFileSync} from 'node:fs';\nconst report=readFileSync(${JSON.stringify(report)},'utf8');\nif(!/Documentation/i.test(report)) throw Error('missing audit report');\nwriteFileSync(${JSON.stringify(receipt)},JSON.stringify({report}),{mode:0o600});\n`);
    const observer = await observeDocsWrites(fixture);
    let result: SkillTestResult | undefined;
    let observation: ReturnType<typeof observer.stop>;
    try {
      result = await runSkillTest(docsSessionOptions({
        fixture,
        phase,
        report,
        publish,
        scenario,
        testName,
        runId,
        timeout: Math.max(1, deadline - Date.now() - 15_000),
      }));
    } finally {
      observation = observer.stop();
      preserveDocsEvidence(fixture, result ?? { output: 'capture did not return', toolCalls: [] }, runId, testName, { observation });
    }
    if (!result) throw Error('missing native parent result');
    logCost(testName, result);
    const calls = result.toolCalls;
    const dispatches = docsDispatchIndices(calls);
    const dispatch = dispatches[0] ?? -1;
    const publishCall = calls.findIndex(call => call.tool === 'Bash' && String(call.input?.command).includes(`bun ${publish}`));
    let passed = false;
    try {
      expect(dispatch).toBeGreaterThanOrEqual(0);
      // The gate's attempt budget: an initial audit plus at most one re-audit, every child in the foreground.
      expect(dispatches.length).toBeLessThanOrEqual(2);
      for (const index of dispatches) expect(calls[index].input.run_in_background).toBe(false);
      if (publishCall >= 0) expect(dispatches.at(-1)!).toBeLessThan(publishCall);
      expect(result.exitReason).toBe('success');
      expect(docsWriteFailures(observation!, scenario === 'current' || scenario === 'store' ? [] : [DOC_PATH], {
        result, fixture, scripts: [publish], readOnly: scenario === 'current' || scenario === 'store',
      })).toEqual([]);
      expect(docsToolFailures(result, fixture, [publish], scenario === 'current' || scenario === 'store')).toEqual([]);
      const output = fs.readFileSync(report, 'utf8');
      const after = repoSnapshot(fixture.repo);
      const changed = changedFiles(fixture.before, after);
      expect(after.head).toBe(fixture.before.head);
      expect(after.index).toBe(fixture.before.index);
      expect(after.contents['personal-note.txt']).toBe(fixture.before.contents['personal-note.txt']);
      expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('User-maintained note: KEEP THIS EXACTLY.');
      if (scenario === 'store') {
        expect(output).toMatch(/Documentation[\s\S]*blocked/i);
        expect(fs.existsSync(receipt)).toBe(false);
        expect(publishCall).toBe(-1);
        expect(changed).toEqual([]);
        expect(output).not.toMatch(/Documentation(?: is|:) current/i);
      } else {
        // The parent accepts the last attempt; a rejected earlier attempt's edits stay in the tree (Blocked recovery preserves
        // partial content), so the accepted contract owns the paths no earlier attempt reported plus any it claims itself.
        const { accepted: contract, attempts: contracts } = docsAttemptContracts(dispatches.map(index => calls[index].output));
        dispatches.forEach((index, position) => {
          expect(JSON.stringify(calls[index].input)).toContain(contracts[position].audit_id);
          expect(childReportedSpawnedMarker(result, calls[index])).toBe(true);
        });
        expect(sawSpawnedMarker(result)).toBe(true);
        vetDocsCompletion(contract, {
          settled: result.exitReason === 'success', markerSeen: sawSpawnedMarker(result),
          headUnchanged: after.head === fixture.before.head, indexUnchanged: after.index === fixture.before.index,
          candidateUnchanged: changed.every(p => p === DOC_PATH), readOnly: false,
          changedPaths: acceptedChangedPaths(changed, contracts), allowedDocs: [DOC_PATH],
        });
        expect(contract.status).not.toBe('blocked');
        if (scenario === 'current') expect(contracts.map(attempt => attempt.status)).toEqual(contracts.map(() => 'current'));
        else expect(contracts.some(attempt => attempt.status === 'updated' && attempt.files_updated.includes(DOC_PATH))).toBe(true);
        expect(contract.files_reviewed).toContain(DOC_PATH);
        expect(docsCompletedRead(result, path.join(fixture.repo, DOC_PATH), fixture, {
          source: Buffer.from(fixture.before.contents[DOC_PATH], 'base64').toString('utf8'),
          beforeFirstEdit: scenario !== 'current',
        })).toBe(true);
        expect(output).toContain(contract.documentation_section);
        expect(fs.existsSync(receipt)).toBe(true);
        expect(publishCall).toBeGreaterThan(dispatch);
        expect(changed).toEqual(scenario === 'current' ? [] : [DOC_PATH]);
        if (scenario === 'updated') expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toMatch(/Default format: JSON\./i);
      }
      const actualMutation = calls.filter(call => call.tool === 'Bash').map(call => String(call.input?.command))
        .filter(command => /\bgit\s+(?:add|commit|push|reset|checkout|stash|merge|pull|rebase)(?=[\s;&|<>)]|$)/.test(command));
      expect(actualMutation).toEqual([]);
      passed = true;
    } finally {
      recordE2E(collector, testName, 'Ship doc-sync lifecycle', result, { passed });
    }
  } finally {
    fixture.clean();
  }
}

describeE2E('Ship doc-sync lifecycle E2E (gate)', () => {
  describeIfSelected('Ship doc-sync lifecycle', ['ship-docsync-completion', 'ship-docsync-current', 'ship-docsync-failure', 'ship-docsync-store',
      'ship-docsync-missing-marker', 'ship-docsync-missing-asset', 'ship-docsync-launch-failure', 'ship-docsync-timeout-unsettled',
      'ship-docsync-late-result', 'ship-docsync-stale-before', 'ship-docsync-stale-after', 'ship-docsync-recovery'], () => {
    testConcurrentIfSelected('ship-docsync-completion', () => runShipDocs('ship-docsync-completion', 'updated'), CAPTURE_LONG_MS);
    testConcurrentIfSelected('ship-docsync-current', () => runShipDocs('ship-docsync-current', 'current'), CAPTURE_LONG_MS);
    testConcurrentIfSelected('ship-docsync-failure', () => runShipDocsFault('ship-docsync-failure', 'legacy-completion', collector, CAPTURE_LONG_MS), CAPTURE_LONG_MS);
    testConcurrentIfSelected('ship-docsync-store', () => runShipDocs('ship-docsync-store', 'store'), CAPTURE_LONG_MS);
    testConcurrentIfSelected('ship-docsync-missing-marker', () => runShipDocsFault('ship-docsync-missing-marker', 'missing-marker', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-missing-asset', () => runShipDocsFault('ship-docsync-missing-asset', 'missing-asset', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-launch-failure', () => runShipDocsFault('ship-docsync-launch-failure', 'launch-failure', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-timeout-unsettled', () => runShipDocsFault('ship-docsync-timeout-unsettled', 'timeout-unsettled', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-late-result', () => runShipDocsFault('ship-docsync-late-result', 'late-result', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-stale-before', () => runShipDocsFault('ship-docsync-stale-before', 'stale-before', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-stale-after', () => runShipDocsFault('ship-docsync-stale-after', 'stale-after', collector), CAPTURE_MS);
    testConcurrentIfSelected('ship-docsync-recovery', () => runShipDocsFault('ship-docsync-recovery', 'recovery', collector), CAPTURE_MS);
  });
});

afterAll(() => finalizeEvalCollector(collector));
