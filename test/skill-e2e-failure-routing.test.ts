/**
 * Router failure routing (#3157, #3158). The gstack router checks a reported
 * failure's cause before it routes: a user-supplied cause that one read-only
 * check confirms is fixed directly; an unknown cause gets one bounded triage
 * pass; anything still unverified goes to /investigate before any edit.
 *
 * Four fixtures, two per issue. The direct cases (verified cause, triage that
 * resolves it) must fix the bug without /investigate and leave the suite
 * green. The fallback cases (contradicted cause, unclear intermittent failure)
 * are the negative controls: an edit before /investigate is a contract
 * violation. Every case needs one to four read-only calls before it routes. The agent sees the rendered router section, sliced from
 * SKILL.md; GSTACK_ROUTER_ARM=before slices the base branch's router instead.
 * GSTACK_ROUTER_ARM=none is the descriptive no-gstack arm: the request alone,
 * no installed skills, scored on plain metrics (suite green, edits before the
 * first read, read-only calls before the first edit) recorded as observations.
 * Fixtures and scoring live in test/helpers/failure-routing-fixture.ts.
 */
import { afterAll, expect } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runSkillTest } from './helpers/session-runner';
import { expectContract } from './helpers/eval-store';
import {
  runId, describeIfSelected, testConcurrentIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { FIXTURES, makeRepo, plainMetrics, routerArm, routerPrompt, routing, sourceSnapshot } from './helpers/failure-routing-fixture';
import { recordObservation } from './helpers/none-arm';

const collector = createEvalCollector('e2e-failure-routing');
const ARM = routerArm();

describeIfSelected('Router failure routing (#3157, #3158)', FIXTURES.map(f => f.name), () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    finalizeEvalCollector(collector);
  });

  for (const fixture of FIXTURES) {
    testConcurrentIfSelected(fixture.name, async () => {
      const repo = makeRepo(fixture, ARM);
      dirs.push(repo);
      const sourceBefore = sourceSnapshot(repo, fixture);
      const result = await runSkillTest({
        prompt: routerPrompt(fixture, ARM),
        workingDirectory: repo,
        maxTurns: 6,
        tools: ['Skill', 'Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        allowedTools: ['Skill', 'Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        timeout: CAPTURE_MS,
        testName: fixture.name,
        runId,
      });
      logCost(`router ${fixture.name} (${ARM})`, result);
      const suite = spawnSync(process.execPath, [...bunIsolationArgs(), 'test'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
      const green = suite.status === 0;
      if (ARM === 'none') {
        const p = plainMetrics(result.toolCalls);
        const plain = `arm=none reads_before_edit=${p.readsBeforeEdit} edited_before_read=${p.editedBeforeRead} green=${green} tools: ${p.sequence}`;
        recordE2E(collector, fixture.name, 'Router failure routing', result, { passed: true, output: plain });
        recordObservation(fixture.name, green, `suite green after the run: ${plain}`);
        recordObservation(fixture.name, !p.editedBeforeRead, `no edit before the first read-only call: ${plain}`);
        recordObservation(fixture.name, p.readsBeforeEdit >= 1, `at least one read-only call before the first edit: ${plain}`);
        return;
      }
      const r = routing(result);
      const sourceChanged = sourceSnapshot(repo, fixture) !== sourceBefore;
      const summary = `arm=${ARM} route=${r.investigated ? 'investigate' : 'direct'} reads=${r.readsBeforeRoute} green=${green} tools: ${r.sequence}`;
      const bounded = r.readsBeforeRoute >= 1 && r.readsBeforeRoute <= 4;
      const passed = bounded && (fixture.route === 'direct' ? !r.investigated && green : r.investigated && !r.editedFirst);
      recordE2E(collector, fixture.name, 'Router failure routing', result, { passed, output: summary });

      if (fixture.route === 'investigate') {
        expectContract(!r.editedFirst && (r.investigated || !sourceChanged), `edited before /investigate on an unverified cause: ${summary}`, { collector, name: fixture.name });
        expect(r.investigated, summary).toBe(true);
      } else {
        expect(r.investigated, summary).toBe(false);
        expect(green, `suite still red after the direct fix: ${summary}\n${suite.stdout}${suite.stderr}`).toBe(true);
      }
      expect(r.readsBeforeRoute, `no read-only check before routing: ${summary}`).toBeGreaterThanOrEqual(1);
      expect(r.readsBeforeRoute, `triage was not bounded: ${summary}`).toBeLessThanOrEqual(4);
    }, CAPTURE_MS);
  }
});
