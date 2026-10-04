import { expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CAPTURE_MS } from './eval-budgets';
import { runSkillTest, type SkillTestResult } from './session-runner';
import { runId, logCost, recordE2E } from './e2e-helpers';
import type { EvalCollector } from './eval-store';
import { DOC_PATH, fixtureDocs, preserveDocsEvidence, repoSnapshot, changedFiles } from './docsync-fixture';
import { DOCS_CHECKPOINT_MARKER, docsActorCanRepair, docsActorSeeded, installDocsActor, seedDocsFirstAttempt, type DocsActorState, type DocsFault } from './docsync-fault-actor';
import { observeDocsWrites, docsWriteFailures, docsNativeInterface, docsToolFailures, docsCompletedRead, docsBoundedStageInterface, docsShipPhase } from './docsync-observer';
import { extractDocsDispatch } from './docsync-contract';

export function docsActorVerdict(state: DocsActorState, report: string, published: boolean): string[] {
  const failures: string[] = [];
  const actions = state.events.map(e => e.action);
  const calls = state.events.filter(e => e.action === 'dispatch');
  const success = ['recovery', 'stale-before', 'stale-after'].includes(state.scenario);
  const count = state.scenario === 'missing-asset' ? 0 : success || state.scenario === 'late-result' ? 2 : 1;
  const legacy = state.scenario === 'legacy-completion';
  if (legacy ? calls.length < 1 || calls.length > 2 : calls.length !== count) {
    failures.push(`wrong executed dispatch count: ${calls.length}, expected ${legacy ? '1 or 2' : count}`);
  }
  if (new Set(calls.map(e => e.audit_id)).size !== calls.length) failures.push('audit identity reused');
  if (published !== success || actions.includes('publish') !== success) failures.push('wrong parent publication decision');
  if (state.events.some(e => e.action === 'rejected')) failures.push('parent attempted invalid actor interaction');
  if (!success && !/Documentation[\s\S]*blocked/i.test(report)) failures.push('blocked documentation not reported');
  // An inline-code mention ("no `Documentation: current/updated`") quotes the status line; it does not claim it.
  if (!success && /Documentation(?: is|:) current/i.test(report.replace(/`[^`\n]*`/g, ''))) failures.push('false current report');
  if (success && (!state.acceptedId || !report.includes(state.acceptedId))) failures.push('actual repaired audit not consumed');
  if (legacy) {
    if (state.repaired || actions.includes('repair')) failures.push('legacy launcher has no repair');
    if (calls.length === 2) {
      const attempts = calls.map(call => state.tasks.find(task => task.audit_id === call.audit_id && task.id === call.task_id));
      if (state.tasks.length !== 2 || attempts.some(task => !task?.settled) || attempts[0]?.id === attempts[1]?.id) {
        failures.push('legacy re-audit lacks distinct settled child evidence');
      } else {
        const [first, second] = attempts as DocsActorState['tasks'];
        try {
          for (const task of [first, second]) {
            const candidate = JSON.parse(task.candidate);
            if (candidate.audit_id !== task.audit_id || !isDeepStrictEqual(candidate, task.observed_candidate)) {
              throw Error('candidate does not match dispatched inputs');
            }
          }
          const before = first.observed_candidate;
          const after = second.observed_candidate;
          const auditedPaths = new Set([...before.selected_paths, ...after.selected_paths]);
          if (![...auditedPaths].some(file => before.content_hashes[file] !== after.content_hashes[file])) {
            failures.push('legacy re-audit had no changed audited input');
          }
        } catch {
          failures.push('legacy re-audit did not use fresh observed snapshots');
        }
      }
    }
  }
  if (state.scenario === 'timeout-unsettled') {
    const stop = actions.indexOf('stop');
    if (stop < 0 || !state.events.slice(stop + 1).some(e => e.action === 'status' && e.detail === 'running')) failures.push('unsettled stop was not checked');
    if (state.tasks.every(t => t.settled)) failures.push('unsettled fault was not exercised');
  }
  if (state.scenario === 'late-result') {
    const stopped = state.events.findIndex(e => e.action === 'stop' && e.detail === 'settled');
    const repair = actions.indexOf('repair');
    const second = state.events.findIndex(e => e.action === 'dispatch' && e.audit_id === calls[1]?.audit_id);
    if (stopped < 0 || repair <= stopped || second <= repair || !actions.includes('late-callback')) failures.push('late result recovery sequence not exercised');
  }
  if (state.scenario === 'recovery') {
    const repair = actions.indexOf('repair');
    if (repair < 0 || repair >= state.events.findIndex(e => e.action === 'dispatch' && e.audit_id === calls[1]?.audit_id)) failures.push('retry had no concrete repair');
  }
  if (state.scenario.startsWith('stale-')) {
    const edit = actions.indexOf('scheduled-input-edit');
    const firstResult = actions.indexOf('completion');
    if (edit < 0 || firstResult < 0 || (state.scenario === 'stale-before' ? edit >= firstResult : edit <= firstResult)) failures.push('wrong stale input/result order');
    const second = state.events.findIndex(e => e.action === 'dispatch' && e.audit_id === calls[1]?.audit_id);
    if (second <= edit || actions.indexOf('publish') <= second) failures.push('stale audit was published or not refreshed');
  }
  return failures;
}

export function docsFaultPrompt(fixture: ReturnType<typeof fixtureDocs>, phase: string, report: string, scenario: DocsFault,
  seed?: { candidate: string; completion: string }): string {
  const actorFile = path.join(import.meta.dir, 'docsync-fault-actor.ts');
  const stateFile = path.join(fixture.home, 'actor-state.json');
  const opening = seed
    ? `Load gstack /ship: ${phase} is its excerpt for this step, so ship/SKILL.md needs no Read. Continue the documentation phase from ${phase}, already in progress, and stop before Step 15. Base main; existing open PR, already-pushed docs-only branch. Skill assets are installed at ${fixture.skills}. The fixture owner already prepared and dispatched attempt 1 through the transport below; the invocation record's Checkpoint 1 is its pre-dispatch entry and names its candidate, prompt, dispatch exit code and verbatim output, saved once at ${seed.completion}. Resume at Parent processing (Collect, then validate) for that output. Do not repeat attempt 1's preparation, save its output again or reread the child assets it already checked. Attempt 1 is this invocation's own attempt: it counts toward the attempt limit, and a further attempt needs what Blocked recovery requires (changed audited inputs, or a concrete correction the declared interface below actually provides). No audit from an earlier invocation is reusable. Place candidate/prompt/report artifacts directly under ${fixture.home}. Write the final ship report to ${report}; no user risk exception or risky edit is approved.`
    : `Load gstack /ship. Execute the actual next phase from ${phase} and stop before Step 15. Base main; ${scenario === 'legacy-completion' ? 'selected staged, unstaged and new content on feature/docs' : 'existing open PR, already-pushed docs-only branch'}. Skill assets are installed at ${fixture.skills}. Place candidate/prompt/report artifacts directly under ${fixture.home}. No prior audit is reusable. Write the final ship report to ${report}; no user risk exception or risky edit is approved.`;
  return `${opening}

${docsBoundedStageInterface(fixture)}

This native-parent fixture supplies a deterministic child transport instead of Agent/Task. It is a host adapter, not a replacement workflow. Do not invoke real Agent/Task or execute the child's audit/lifecycle yourself. ${seed ? `In one response, natively Read the actual phase, its installed documentation section at ${path.join(fixture.skills, 'ship/sections/documentation.md')}, the invocation record, attempt 1's candidate at ${seed.candidate} and its saved output. No ls, cat or directory search is needed, and native Edit of the invocation record needs no second Read. Keep each journal entry to at most four short lines and the final report to at most fifteen lines: cite evidence by artifact path and name only changed paths and hashes. After the report and any receipt, the final response is one line naming the Documentation status.` : 'Read the actual phase and its installed documentation section and child assets.'} The adapter returns child evidence; only you apply the loaded workflow's gates.

Declared transport interface (literal key=value arguments; quote file paths as needed):
bun ${actorFile} prepare ${stateFile} audit_id=ID
bun ${actorFile} dispatch ${stateFile} audit_id=ID candidate=ABSOLUTE_JSON_PATH prompt=ABSOLUTE_PROMPT_PATH run_in_background=false
bun ${actorFile} inspect ${stateFile}
bun ${actorFile} status ${stateFile} task_id=RETURNED_TASK_ID
bun ${actorFile} stop ${stateFile} task_id=RETURNED_TASK_ID
${docsActorCanRepair(scenario) ? `bun ${actorFile} repair ${stateFile}\nThis launcher supports one concrete marking/transport repair, only after a dispatched child is confirmed settled. That isolated repair is authorized, not approval for document risks.` : 'This launcher has no repair operation or alternate launcher. Missing assets/marking, launch failures and invalid completions cannot be repaired here. Do not invoke repair or invent an inline fallback.'}
bun ${actorFile} publish ${stateFile} audit_id=ID report=${report}

prepare is a serialization convenience, not an audit or validation: after inspecting the required inputs and deciding an attempt is allowed, supply a fresh id of 1–80 letters/digits/underscores/hyphens, beginning with a letter or digit. It saves current base/HEAD/index, selected paths, dirty paths, docs roots and content hashes to a new candidate JSON, and copies the exact installed section's child prompt with literal substitutions and the observation interface to a new prompt file. It returns their paths. Read these artifacts; use the returned paths unchanged in dispatch. prepare neither launches a child nor resets/increments the attempt count, repairs content, compares snapshots or accepts an audit. Saved files are never overwritten. Use the single batched inspect transport call (declared above) to read committed, staged, unstaged and new content in one response instead of one command per file.

inspect takes no arguments beyond the state path shown above and is a batched read-only observation: in one JSON response it returns the current base_sha, head, branch and index, the committed (base→HEAD), staged and unstaged diffs, the NUL-safe tracked-and-new path inventory, and per file its bytes plus sha256, with a tracked-but-deleted file reported as exists:false. It returns no verdict, acceptance, snapshot refresh, attempt, count change or publication, never exposes private transport state or precomputed gate answers, and grants no repair, risk exception, new attempt or missing-asset bypass; you still parse the returned data and apply every gate yourself. It is a real observation boundary: an independent editor may change inputs exactly at inspect time, as during any repository read, so an inspect after the child can legitimately reveal a changed input that invalidates a returned audit. ${seed ? 'inspect is the authoritative repository observation in this phase: its result already contains what git status, git rev-parse, git diff, git ls-files or cat of product files would return, so do not run those reads. One inspect after reading attempt 1\'s output serves its freshness check and any repeated Prepare. After a later child returns, one inspect serves its ownership and freshness checks and the pre-publication recheck when only private artifacts were written since. For those checks compare base_sha, head, index and each files[path].sha256 with the saved candidate, and read content or diffs only for paths whose hash differs. inspect does not substitute for reading the phase and documentation section.' : 'Read the actual phase, the installed documentation section and the child assets directly; inspect does not substitute for those reads.'}

Parent output handling (stay inside the declared interface; do not add shell to it):
1. Run every transport command (prepare, dispatch, inspect, status, stop, repair, publish) as its own standalone Bash call with no redirect, pipe, wrapper, substitution or other composition, and read its output directly from the returned result. Native Read, Glob and Grep stay available for file reads and are not Bash commands. Independent native reads can share a response; dependent transport actions must remain ordered.
2. Keep inspect observations in their original tool results in context and compare those returned values directly. Do not transcribe or reserialize inspect JSON into duplicate snapshot files; prepare already saves the required candidate and prompt. Never redirect a command into a file and never re-run a command merely to save its output. Compare the returned base/head/index/sha256/content/diff fields and the required asset Read results in your own reasoning. Use only the transport commands above and the commands permitted by the Fixture observation interface below; do not introduce any undeclared comparison or processing program to compare or transform observations, even read-only.
3. Persist each required checkpoint as one short appended journal entry, not a rewritten record or separate edits for each field. After reading the invocation record, use native Edit with old_string exactly ${JSON.stringify(DOCS_CHECKPOINT_MARKER)}, new_string containing only the new entry followed by that same marker, and replace_all=false. The marker must occur exactly once; if missing or duplicated, stop rather than guessing an edit. Preserve unrelated sections and every earlier entry byte-for-byte, retaining each earlier attempt's id, count, evidence paths and outcome. The latest stated value is current; do not recopy previous entries. Each entry states the current attempt count, newly learned decision/evidence and next required action. Reference saved candidate/prompt/completion artifacts instead of repeating their contents or prior narration. Before dispatch, save the incremented attempt count, fresh audit id and candidate/prompt paths together. Save the returned child handle before polling; consolidation must never postpone the pre-launch count or child-settlement checks.
4. After the child, preserve each actual child completion/rejected output once in Markdown as the bounded-stage interface requires. Compare the saved snapshot with current files and apply the loaded output, ownership and freshness gates. If recovery is authorized, save the intermediate result in one checkpoint before continuing it.${seed ? ' When recovery continues directly into the remaining attempt, make that one checkpoint after its prepare so it is also the pre-dispatch entry: prior result and reason, any repair, incremented count, fresh id and candidate/prompt paths together.' : ''} Otherwise use the finishing checkpoint below, not an extra status-only update. A changed input requires the workflow's fresh attempt, never silently replaced hashes. Recheck freshness again before publication.
5. After the loaded Continue or recover / Blocked recovery steps reach a final outcome, finish the required invocation state and final report before optional narration or formatting. Append status, reasons, evidence paths, pending work and any accepted post-child hashes/documentation_section in one finishing entry; do not repeat earlier gate analysis or split that known outcome across multiple edits. Append the finishing checkpoint and Write the complete report in the same response using separate native file calls, then return briefly after any authorized publication receipt. Follow the loaded gate order: when it requires stopping, write the required invocation state and report, then stop rather than continuing later preparation to fill optional artifacts. Never omit the final report or final response, even when publication is blocked.

dispatch returns terminal final text, a launch error, or a running task_id. Terminal final text means that child is settled. A launch error saying no child started is authoritative and returns no task handle: do not probe invented ids. Use status/stop only with an actual returned task_id. The virtual clock advances to the next policy deadline on each status query; do not sleep. A stop request alone is not settlement or permission to publish. An independent fixture actor may change selected source between phases. Do not read/edit ${stateFile}; it is private transport state. Only when the actual workflow permits publication, call publish, a local receipt rather than GitHub.

${docsNativeInterface(fixture, [actorFile], true)}`;
}

export async function runShipDocsFault(testName: string, scenario: DocsFault, collector: EvalCollector, captureMs = CAPTURE_MS) {
  if (!process.env.EVALS_RUN_ID) throw Error('Native docs fault acceptance requires EVALS_RUN_ID');
  const deadline = Date.now() + captureMs;
  const fixture = fixtureDocs(scenario === 'legacy-completion' ? 'legacy' : 'current');
  const actorFile = path.join(import.meta.dir, 'docsync-fault-actor.ts');
  const stateFile = installDocsActor(fixture, scenario);
  const seed = docsActorSeeded(scenario) ? seedDocsFirstAttempt(fixture, stateFile) : undefined;
  const report = path.join(fixture.home, 'ship-report.md');
  const phase = path.join(fixture.home, 'phase.md');
  const skeleton = fs.readFileSync(path.join(fixture.skills, 'ship/SKILL.md'), 'utf8');
  const start = skeleton.indexOf('## Step 14.5: Documentation audit (every ship)');
  const end = skeleton.indexOf('## Step 15: Commit');
  if (start < 0 || end <= start) throw Error('native parent documentation phase markers moved');
  fs.writeFileSync(phase, scenario === 'legacy-completion'
    ? docsShipPhase(skeleton, fs.readFileSync(path.join(fixture.skills, 'ship/sections/pr-body.md'), 'utf8'), 'legacy', '')
    : skeleton.slice(start, end));
  const observer = await observeDocsWrites(fixture);
  let result: SkillTestResult | undefined;
  let passed = false;
  try {
    result = await runSkillTest({
      prompt: docsFaultPrompt(fixture, phase, report, scenario, seed),
      workingDirectory: fixture.repo, maxTurns: scenario === 'legacy-completion' ? 30 : 24,
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: Math.max(1, deadline - Date.now() - 15_000), env: fixture.env, testName, runId,
    });
    logCost(testName, result);
    expect(result.exitReason).toBe('success');
    expect(docsCompletedRead(result, phase, fixture)).toBe(true);
    const documentation = path.join(fixture.skills, 'ship/sections/documentation.md');
    expect(docsCompletedRead(result, documentation, fixture)).toBe(true);
    if (seed) expect(docsCompletedRead(result, seed.completion, fixture)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as DocsActorState;
    const parentEvents = state.events.slice(seed?.events ?? 0);
    const summary = fs.readFileSync(report, 'utf8');
    expect(docsActorVerdict(state, summary, fs.existsSync(path.join(fixture.home, 'publication.json')))).toEqual([]);
    expect(docsToolFailures(result, fixture, [actorFile])).toEqual([]);
    const after = repoSnapshot(fixture.repo);
    expect(after.head).toBe(fixture.before.head);
    expect(after.index).toBe(fixture.before.index);
    expect(after.contents['personal-note.txt']).toBe(fixture.before.contents['personal-note.txt']);
    expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('User-maintained note: KEEP THIS EXACTLY.');
    if (scenario === 'legacy-completion') {
      expect(changedFiles(fixture.before, after)).toEqual([DOC_PATH]);
      expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('Default format: JSON.');
      expect(state.events.some(e => e.action === 'partial-doc-edit')).toBe(true);
    }
    for (const task of state.tasks) {
      expect(JSON.parse(task.candidate)).toEqual(task.observed_candidate);
      const source = extractDocsDispatch(fs.readFileSync(documentation, 'utf8'));
      const literalPieces = source.split(/<branch>|<base>|<candidate-path>|<audit-id>|<mode>/);
      let cursor = 0;
      const actual = task.prompt.replaceAll(fixture.home, '${HOME}').replace(/\s+/g, ' ');
      for (const piece of literalPieces) {
        const literal = piece.replace(/\s+/g, ' ');
        const found = actual.indexOf(literal, cursor);
        expect(found).toBeGreaterThanOrEqual(cursor);
        cursor = found + literal.length;
      }
    }
    const events = result.toolCalls.filter(call => call.tool === 'Bash' && String(call.input?.command).includes(actorFile)
      && String(call.input?.command).includes(stateFile));
    for (const action of ['prepare', 'dispatch', 'inspect', 'status', 'stop', 'repair', 'publish']) {
      expect(events.filter(call => String(call.input?.command).replaceAll("'", '').replaceAll('"', '').includes(` ${action} `)).length)
        .toBe(parentEvents.filter(e => e.action === action).length);
    }
    const inspectCalls = events.filter(call => String(call.input?.command).replaceAll("'", '').replaceAll('"', '').includes(' inspect '));
    const inspectReceipts = parentEvents.filter(e => e.action === 'inspect').map(e => e.detail);
    expect(inspectCalls.length).toBe(inspectReceipts.length);
    inspectCalls.forEach((call, index) => {
      const emitted = call.output.trim().split('\n').at(-1) ?? '';
      expect(createHash('sha256').update(emitted).digest('hex')).toBe(inspectReceipts[index]);
    });
    if (scenario !== 'missing-asset' && (!seed || parentEvents.some(e => e.action === 'dispatch'))) {
      expect(events.some(call => call.output.includes('SESSION_KIND:') || call.output.includes('task_id') || call.output.includes('Child launch failed'))).toBe(true);
    }
    passed = true;
  } finally {
    const observation = observer.stop();
    const failures = docsWriteFailures(observation, scenario.startsWith('stale-') ? ['app.ts', DOC_PATH] : scenario === 'legacy-completion' ? [DOC_PATH] : [],
      result ? { result, fixture, scripts: [actorFile] } : undefined);
    if (failures.length) passed = false;
    preserveDocsEvidence(fixture, result ?? { output: 'capture did not return', toolCalls: [] }, runId, testName, {
      observation, actor: JSON.parse(fs.readFileSync(stateFile, 'utf8')), passed,
    });
    if (result) recordE2E(collector, testName, 'Native ship docs fault adapter', result, { passed });
    fixture.clean();
    expect(failures).toEqual([]);
  }
}
