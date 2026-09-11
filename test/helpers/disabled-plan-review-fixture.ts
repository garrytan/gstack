/** Isolated real-parent fixture and execution oracle for the plan-review off switch. */
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSkillSections } from './skill-fixture';
import { claudeOutsideExecutions } from './outside-voice-evidence';

export const OUTSIDE_PLAN_SECTION = 'Outside Voice — Independent Plan Challenge (default-on)';

/** Extract generated instructions; runtime paths are the only content substitution. */
export function installDisabledPlanReviewFixture(rendered: string, repo: string, runtimeRoot: string) {
  const source = join(rendered, 'plan-eng-review');
  const main = readFileSync(join(source, 'SKILL.md'), 'utf8');
  const frontmatter = main.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0];
  if (!frontmatter) throw new Error('Generated plan-eng-review has no frontmatter');
  // The shared plan challenge is lazily loaded. Give the established,
  // fence-aware extractor its frontmatter without copying any workflow prose.
  const input = join(repo, 'outside-plan-source.md');
  writeFileSync(input, frontmatter + readFileSync(join(source, 'sections/review-sections.md'), 'utf8'));
  let generated: string;
  try { generated = extractSkillSections(input, [OUTSIDE_PLAN_SECTION]); }
  finally { unlinkSync(input); }
  symlinkSync(runtimeRoot, join(repo, 'runtime'), 'dir');
  const instructions = generated
    .replaceAll('$HOME/.claude/skills/gstack', '$PWD/runtime')
    .replaceAll('~/.claude/skills/gstack', './runtime');
  const workflowPath = join(repo, 'OUTSIDE-PLAN.md');
  writeFileSync(workflowPath, instructions);

  const stateDir = join(repo, 'gstack-state');
  const configDir = join(repo, 'claude-config');
  const spyDir = join(repo, 'cli-bin');
  const cliDispatchLog = join(repo, 'outside-cli-dispatch.log');
  for (const dir of [stateDir, configDir, spyDir]) mkdirSync(dir, { recursive: true });
  // A forbidden invocation is observable without buying another model call.
  // No prompt/credentials are recorded; even --version/auth probes count.
  writeFileSync(join(spyDir, 'codex'), '#!/bin/sh\nprintf "codex invoked\\n" >> "$GSTACK_DISABLED_CLI_LOG"\nexit 73\n', { mode: 0o755 });
  const env = {
    PATH: `${spyDir}${delimiter}${process.env.PATH ?? ''}`,
    CLAUDE_CONFIG_DIR: configDir,
    GSTACK_HOME: stateDir,
    GSTACK_STATE_ROOT: stateDir,
    GSTACK_DISABLED_CLI_LOG: cliDispatchLog,
    GSTACK_ACTIVE_HOST: 'claude',
    GSTACK_PROJECT_SLUG: 'disabled-plan-fixture',
  };
  const config = spawnSync(join(runtimeRoot, 'bin/gstack-config'), ['set', 'codex_reviews', 'disabled'], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000,
  });
  if (config.status !== 0) throw new Error(`Cannot seed isolated review control: ${config.stderr}`);
  // Seed real historical coverage so the new disabled record must replace it
  // in the dashboard's latest-record view, not merely appear in final prose.
  const prior = {
    skill: 'codex-plan-review', timestamp: new Date(Date.now() - 60_000).toISOString(),
    status: 'clean', source: 'codex', host: 'claude', outside_provider: 'codex',
    outside_status: 'completed', phase: 'plan-review',
  };
  const logged = spawnSync(join(runtimeRoot, 'bin/gstack-review-log'), [JSON.stringify(prior)], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000,
  });
  if (logged.status !== 0) throw new Error(`Cannot seed historical review: ${logged.stderr}`);
  const slug = spawnSync(join(runtimeRoot, 'bin/gstack-slug'), [], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000,
  });
  const branch = /^BRANCH=([a-zA-Z0-9._-]+)$/m.exec(slug.stdout)?.[1];
  if (slug.status !== 0 || !branch) throw new Error('Cannot resolve isolated review-log branch');
  const reviewLogPath = join(stateDir, 'projects', env.GSTACK_PROJECT_SLUG, `${branch}-reviews.jsonl`);
  const priorRecord = JSON.parse(readFileSync(reviewLogPath, 'utf8').trim());
  return { workflowPath, instructions, generated, stateDir, cliDispatchLog, reviewLogPath, priorRecord, env };
}

/** Check each completion mention; a historical record cannot excuse a later current claim. */
function hasUnattributedOutsideCompletion(output: string): boolean {
  const marker = /\bboth reviewers agree\b|["']?\boutside_status["']*\s*[:=]\s*["']*completed\b/gi;
  const clauses = output.replace(/[*`]/g, '').split(/\r?\n|(?<=[.!?;])\s+|\b(?:but|however|nevertheless|yet)\b[:,]?\s*/i);
  return clauses.some(clause => [...clause.matchAll(marker)].some(match => {
    const before = clause.slice(0, match.index).trimEnd();
    // A quoted phrase is not automatically a denial. Require the local no-claim
    // statement, so a second positive assertion in the same paragraph still fails.
    const denied = /\bno\s*["'“”‘’]*\s*$/i.test(before)
      || /\b(?:(?:do|did|will|would|can|could)\s+not|cannot|can't|won't)\s+(?:claim|say|state|report)\s*["'“”‘’]*\s*$/i.test(before)
      || /\b(?:am|is|are)\s+not\s+(?:claiming|saying|stating|reporting)\s*["'“”‘’]*\s*$/i.test(before);
    if (denied) return false;
    // Agreement is a current prose claim unless explicitly denied; an old
    // log entry only establishes the provenance of its recorded status value.
    if (/^both reviewers agree$/i.test(match[0])) return true;
    // A record explicitly dated before this run is historical even when its
    // subject is "that record" rather than "the earlier record".
    const datedBeforeRun = String.raw`\s+is\s+timestamped\s+(?:about\s+)?(?:a|an|one|two|\d+)\s+(?:minute|hour|day|week)s?\s+before\s+(?:this|my)\s+(?:run|session|workflow)`;
    const recordPattern = new RegExp(String.raw`\b(?:(?:earlier|prior|historical|old(?:er)?)\s+(?:entry|record|line)|(?:that|the)\s+(?:entry|record|line)(?=${datedBeforeRun}))\b`, 'gi');
    const record = [...before.matchAll(recordPattern)].at(-1);
    if (!record) return true;
    // Bind this occurrence to an old record's reported value. A mere mention
    // of a record, a second status, or a new reporting subject cannot inherit
    // its historical attribution, even without a sentence boundary.
    const prefix = before.slice(record.index + record[0].length);
    // Date metadata still describes this record's own value. Admit explicit
    // clock or pre-run timestamps, not arbitrary prose that can change subjects.
    const clock = String.raw`\s+from\s+(?:[01]\d|2[0-3]):[0-5]\d,?`;
    const beforeRun = String.raw`\s*,?\s*(?:written|recorded)\s+(?:about\s+)?(?:a|an|one|\d+)\s+(?:minute|hour|day|week)s?\s+before\s+this\s+(?:run|session|workflow)(?:\s+(?:started|began))?,?`;
    const timestamp = String.raw`(?:${datedBeforeRun}\s+and|\s*,?\s*timestamped\b[^,;.!?]{1,160},?|${clock}|${beforeRun})`;
    const report = new RegExp(String.raw`^(?:${timestamp})?\s*(?:(?:that\s+)?(?:claims?|claiming|shows?|showed|says?|said|records?|recorded|reported)\b|:)\s*`, 'i').exec(prefix);
    // Only intervening review-log metadata belongs to this reported value.
    // Arbitrary prose could switch to a new subject without an earlier status.
    const field = String.raw`["']?(?:status|source|host|outside_provider|phase|timestamp)["']?\s*[:=]\s*["']?[a-z0-9_.:+-]+["']?`;
    const metadata = new RegExp(String.raw`^(?:${field}\s*(?:,\s*|(?:with|and)\s*))*$`, 'i');
    const reportsOldValue = report !== null && metadata.test(prefix.slice(report[0].length).trim());
    const attribution = clause.slice(record.index).replace(/\bbefore\s+(?:this|my)\s+(?:run|session|workflow)\b/gi, 'beforehand');
    const current = /\b(?:now|currently|current|today|new|updat\w*|append\w*|chang\w*|mark\w*|set|write|wrote)\b|\bthis\s+(?:run|session|workflow)\b/i.test(attribution);
    return !reportsOldValue || current;
  }));
}

export function disabledPlanReviewEvidence(result: {
  exitReason: string; output: string; transcript: any[];
}, cliDispatchLog: string, reviewLog = '', priorRecord?: Record<string, unknown>) {
  const init = result.transcript.find(event => event?.type === 'system' && event.subtype === 'init');
  const terminal = result.transcript.filter(event => event?.type === 'result').at(-1);
  const toolCalls = result.transcript.flatMap(event => event?.type === 'assistant' && Array.isArray(event.message?.content)
    ? event.message.content.filter((block: any) => block.type === 'tool_use') : []);
  const fallbackCalls = toolCalls.filter((call: any) => call.name === 'Agent' || call.name === 'Task');
  // Command text may contain an unexecuted guarded branch. Keep it for
  // diagnostics; only the executable sentinel establishes CLI dispatch.
  const outsideCommandMentions = toolCalls.filter((call: any) => call.name === 'Bash'
    && /\bcodex\s+(?:exec|review)\b|\bgstack-claude-code(?:['"])?\s+--/.test(String(call.input?.command ?? '')));
  const disabledPreflight = claudeOutsideExecutions(result.transcript).filter(call => call.succeeded
    && /gstack-config\b/.test(call.command) && /codex_reviews\b/.test(call.command)
    && /^CODEX_MODE: disabled\s*$/m.test(call.output));
  const completed = result.exitReason === 'success' && terminal?.subtype === 'success'
    && terminal.is_error !== true && typeof terminal.result === 'string' && terminal.result.trim().length > 0;
  const disabledAttribution = /outside_status["'`*]*\s*[:=]\s*["'`*]*disabled\b/i.test(result.output)
    || result.output.split('\n').some(line => /\b(?:outside(?:\s+(?:voice|review))?|codex(?:\s+review)?)\b/i.test(line)
      && /\bdisabled\b/i.test(line) && !/\bnot\s+disabled\b/i.test(line));
  const falseCompletion = hasUnattributedOutsideCompletion(result.output);
  // Native CLI releases expose the requested subagent as Agent or Task.
  // Availability never permits dispatch: fallbackCalls rejects both names.
  const agentAvailable = Array.isArray(init?.tools) && init.tools.some((tool: unknown) => tool === 'Agent' || tool === 'Task');
  let records: any[] = [];
  let malformedLog = false;
  try { records = reviewLog.trim() ? reviewLog.trim().split('\n').map(line => JSON.parse(line)) : []; }
  catch { malformedLog = true; }
  const planRecords = records.filter(record => record && typeof record === 'object' && record.skill === 'codex-plan-review');
  const priorIndex = priorRecord ? planRecords.findIndex(record => JSON.stringify(record) === JSON.stringify(priorRecord)) : -1;
  const latestRecord = planRecords.at(-1);
  const persistedDisabled = !malformedLog && priorIndex >= 0 && priorIndex < planRecords.length - 1
    && priorRecord?.outside_status === 'completed' && latestRecord.status === 'skipped'
    && latestRecord.source === 'none' && latestRecord.host === 'claude'
    && latestRecord.outside_provider === 'codex' && latestRecord.outside_status === 'disabled'
    && latestRecord.phase === 'plan-review' && typeof latestRecord.timestamp === 'string'
    && typeof priorRecord.timestamp === 'string' && Number.isFinite(Date.parse(latestRecord.timestamp))
    && Date.parse(latestRecord.timestamp) > Date.parse(priorRecord.timestamp);
  return {
    passed: completed && agentAvailable && disabledPreflight.length > 0 && fallbackCalls.length === 0
      && cliDispatchLog.trim() === '' && disabledAttribution && !falseCompletion && persistedDisabled,
    completed, agentAvailable, disabledAttribution, falseCompletion, persistedDisabled, latestRecord, malformedLog,
    disabledPreflight, fallbackCalls, outsideCommandMentions, cliDispatchLog,
  };
}
