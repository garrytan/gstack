import { afterAll, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeE2ETier } from './helpers/e2e-gate';
import { createEvalCollector, finalizeEvalCollector, describeIfSelected, testConcurrentIfSelected, runId } from './helpers/e2e-helpers';
import { resolveClaudeBinary, runAgentSdkTest, toSkillTestResult, type QueryProvider } from './helpers/agent-sdk-runner';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { publicEvents } from './helpers/setup-gbrain-sandbox';
import { createShipLandFixture, REVIEW_HEAD, SHIP_LAND_CASES } from './helpers/ship-land-fixture';
import { createShipLandActor, queryShipLandFixture } from './helpers/ship-land-actor';

const describeE2E = describeE2ETier('gate');
const collector = createEvalCollector('e2e-ship-land-contracts');
const BUDGET_MS = 120_000;

describeE2E('Ship/land command and requested-review contracts', () => {
  for (const name of SHIP_LAND_CASES) {
    const id = `ship-land-${name}`;
    describeIfSelected(id, [id], () => {
      testConcurrentIfSelected(id, async () => {
        const fixture = createShipLandFixture(name);
        const evidenceDir = path.join(process.env.GSTACK_EVAL_DIR ?? path.resolve('.context/ship-land-evidence'), `${id}-${randomUUID()}`);
        fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(evidenceDir, 'workflow.md'), fixture.excerpt, { mode: 0o600 });
        const events: unknown[] = [];
        let failure: string | undefined;
        let finalized = false;
        const retain = () => {
          if (!finalized) fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({
            name, promptSha256: fixture.sha256, events: publicEvents(events), commands: fixture.events(),
            questions: actor.questions, waiver: actor.waiver, mergePermission: actor.mergePermission, failure,
          }, null, 2), { mode: 0o600 });
        };
        const actor = createShipLandActor(name, fixture, retain);
        const canMerge = ['review-approved', 'review-approved-comment', 'review-bot', 'review-solo', 'review-waiver', 'review-head-change', 'review-protected'].includes(name);
        try {
          retain();
          await runRecordedOfficeHoursAttempt({
            collector, name: id, suite: 'Ship/land contracts', model: 'sdk-default', budgetMs: BUDGET_MS,
            run: async signal => {
              const provider: QueryProvider = input => {
                const source = queryShipLandFixture(input);
                const observed = (async function* () {
                  for await (const event of source) {
                    if (!finalized) { actor.observe(event); events.push(event); retain(); }
                    yield event;
                  }
                })();
                return Object.assign(observed, { close: () => source.close?.() }) as ReturnType<QueryProvider>;
              };
              const result = await runAgentSdkTest({
                systemPrompt: { type: 'preset', preset: 'claude_code' },
                userPrompt: `Load gstack's ${name.startsWith('commands-') ? '/ship and /land-and-deploy validation' : '/land-and-deploy readiness'} workflow excerpt at ${fixture.skillPath} and execute it in this isolated repository. ` +
                  (name.startsWith('commands-')
                    ? 'Step 4 discovery is ready: read repository instructions and CI. Execute the supplied ship Steps 5, 6 and 16, then the supplied landing test-results gate using the ship handoff. No other ship/land phases are in scope. Stop if a required gate cannot be resolved.'
                    : 'The target is PR #42 in fixture-owner/fixture-repo. Version drift, internal gstack reviews, local required tests, documentation and PR accuracy are already verified on the current head. Execute the supplied CI and requested-human-review gates, then readiness confirmation and Step 4 only if permitted. Stop after merge or any unresolved gate; do not deploy or clean up branches. The supplied gh is a local fixture; no real service calls are permitted.') +
                  ' You may read files, run local commands and ask questions. Do not modify project sources or use network services. The actor only answers the scoped gate decisions; it cannot approve extra work.',
                workingDirectory: fixture.repo, env: fixture.env, signal, queryProvider: provider,
                pathToClaudeCodeExecutable: resolveClaudeBinary() ?? undefined,
                maxTurns: 16, maxRetries: 0, testName: id, runId,
                allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'AskUserQuestion'],
                canUseTool: async (tool, input, options) => {
                  signal.throwIfAborted();
                  return actor.canUseTool(tool, input, options);
                },
              });
              return toSkillTestResult(result);
            },
            validate: result => {
              expect(result.exitReason).toBe('success');
              const commands = fixture.events();
              const starts = commands.filter(event => event.phase === 'start');
              const merges = starts.filter(event => event.kind === 'gh' && event.args[0] === 'pr' && event.args[1] === 'merge');
              if (name.startsWith('commands-')) {
                expect(merges).toHaveLength(0);
                if (['commands-python', 'commands-node', 'commands-no-eval'].includes(name)) {
                  for (const lane of fixture.lanes) {
                    const runs = starts.filter(event => event.kind === 'gstack-evidence' && event.args[0] === 'run' && event.args.includes(lane.label));
                    expect(runs).toHaveLength(1);
                    expect(runs[0].cwd).toBe(lane.cwd);
                    expect(runs[0].args.at(-1)).toBe(lane.command);
                    const checks = starts.filter(event => event.kind === 'gstack-evidence' && event.args[0] === 'check' && event.args.includes(lane.label));
                    expect(checks.length).toBeGreaterThanOrEqual(2);
                    expect(checks.every(event => event.cwd === lane.cwd && event.args.includes(lane.command))).toBe(true);
                  }
                  expect(commands.filter(event => event.kind === 'lane')).toHaveLength(fixture.lanes.length);
                  expect(commands.filter(event => event.kind === 'gstack-evidence' && event.phase === 'end'
                    && ['run', 'check'].includes(event.args[0])).every(event => event.exit === 0)).toBe(true);
                } else {
                  expect(actor.questions.length).toBeGreaterThan(0);
                  expect(starts.some(event => event.kind === 'gstack-evidence' && event.args[0] === 'check')).toBe(false);
                  if (name === 'commands-zero-eval' || name === 'commands-selector-error') {
                    expect(commands.some(event => event.kind === 'lane' && event.args.includes('evals'))).toBe(false);
                  }
                  expect(result.output).toMatch(/block|hold|missing|unavailable|conflict|fail|zero|no .*select/i);
                }
              } else {
                expect(starts.some(event => event.kind === 'gh' && event.args[1] === 'checks')).toBe(true);
                if (!name.startsWith('ci-')) {
                  expect(starts.some(event => event.args.includes('--paginate') && event.args.some(arg => arg.endsWith('/timeline')))).toBe(true);
                  if (name !== 'review-unknown') expect(starts.some(event => event.args.includes('--paginate') && event.args.some(arg => arg.endsWith('/reviews')))).toBe(true);
                }
                const allowed = canMerge && name !== 'review-head-change';
                expect(merges).toHaveLength(allowed ? 1 : 0);
                if (name.startsWith('review-') && !canMerge) expect(actor.questions.length).toBeGreaterThan(0);
                if (allowed) {
                  expect(actor.mergePermission).toBe(true);
                  expect(merges[0].args).toContain('--match-head-commit');
                  expect(merges[0].args).toContain(REVIEW_HEAD);
                  expect(merges[0].args).not.toContain('--admin');
                  const beforeMerge = commands.slice(0, commands.indexOf(merges[0]));
                  const permission = beforeMerge.findLastIndex(event => event.kind === 'answer' && event.answer?.startsWith('Merge PR #42 at'));
                  expect(permission).toBeGreaterThanOrEqual(0);
                  const refreshed = beforeMerge.slice(permission + 1);
                  expect(refreshed.some(event => event.kind === 'gh' && event.args[1] === 'view' && event.args.some(arg => arg.includes('headRefOid')))).toBe(true);
                  expect(refreshed.some(event => event.kind === 'gh' && event.args[1] === 'checks')).toBe(true);
                  if (name === 'review-waiver' || name === 'review-protected') {
                    expect(beforeMerge.slice(0, permission).some(event => event.answer?.startsWith("I waive only alice's pending requested human review for PR #42 at"))).toBe(true);
                  }
                  const end = commands.find(event => event.kind === 'gh' && event.args[1] === 'merge' && event.phase === 'end');
                  expect(end?.exit).toBe(name === 'review-protected' ? 1 : 0);
                  if (name === 'review-protected') {
                    const mergeIndex = commands.findIndex(event => event === end);
                    expect(commands.slice(mergeIndex + 1).some(event => event.kind === 'gh' && event.args[1] === 'view' && event.args.some(arg => arg.includes('state')))).toBe(true);
                  }
                }
                if (name === 'review-waiver' || name === 'review-protected') expect(actor.questions.length).toBeGreaterThanOrEqual(2);
                if (name === 'review-head-change') expect(actor.mergePermission).toBe(true);
              }
            },
          });
        } catch (error) {
          failure = String(error);
          throw error;
        } finally {
          retain();
          finalized = true;
          fixture.cleanup();
        }
      }, BUDGET_MS + OFFICE_HOURS_BUN_GRACE_MS);
    });
  }
});

afterAll(() => finalizeEvalCollector(collector));
