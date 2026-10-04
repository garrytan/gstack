import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { readQaDeadline } from '../../lib/qa-deadline';
import { readQaCaptureRecord } from '../../lib/qa-evidence';
import type { SkillTestResult } from './session-runner';
import { runSkillTest, SESSION_DRAIN_GRACE_MS } from './session-runner';
import { CAPTURE_MS } from './eval-budgets';
import { refreshHermeticSkillRuntime } from './hermetic-skill-runtime';
import { seedHermeticGstackHome } from './hermetic-env';
import { observeQAWrites, qaHelperUsageCommand, type QAWriteObservation } from './qa-functional-observer';
import { nativeCalls, readQACheckpointFiles, validateQACheckpoints } from './qa-checkpoint-evidence';
import { ownedPath } from './qa-functional-fixture';
import { qaEvidenceCommand, qaNativeCapture, qaProducerReceipt, type QaEvidenceContext } from './qa-evidence-producer';
import { qaCaptureArtifacts } from './qa-functional-evidence';

export type QaCaller = 'review' | 'ship';
export const QA_CALLER_ROOT = path.resolve(import.meta.dir, '../..');

export function callerExcerpt(source: string, start: string, end: string): string {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0 || last <= first || source.indexOf(start, first + start.length) >= 0) {
    throw new Error(`Missing or ambiguous caller excerpt boundary: ${start} -> ${end}`);
  }
  return source.slice(first, last);
}

export function qaCallerInstructions(caller: QaCaller, root = QA_CALLER_ROOT): string {
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const source = read(`${caller}/SKILL.md`);
  const excerpt = caller === 'review'
    ? callerExcerpt(source, '## Step 4: Critical pass (core review)', '## Step 5.8: Persist Eng Review result')
    : callerExcerpt(source,
      '> **STOP.** Before auditing plan completion, verification, and scope drift (Step 8),',
      '> **STOP.** Before addressing Greptile review comments');
  const review = caller === 'review' ? excerpt : read('ship/sections/review-army.md');
  if (!review.includes(`### Step ${caller === 'review' ? '4.7' : '9.2.1'}: Exploratory QA (before Fix-First)`) || !review.includes('sections/exploratory.md')) {
    throw new Error(`Generated /${caller} parent is missing the exploratory QA integration`);
  }
  const army = read(`${caller}/sections/review-army.md`);
  if (!army.toLowerCase().includes('exploratory') || !army.includes('50')) {
    throw new Error(`Generated /${caller} specialist bypass is missing its exploration handoff`);
  }
  for (const id of ['scope', 'exploratory', 'system-functional']) {
    const body = read(`qa/sections/${id}.md`);
    if (body.trim().length < 200 || /\{\{[A-Z_]+/.test(body)) {
      throw new Error(`Incomplete generated QA resource: ${id}`);
    }
  }
  if (caller === 'ship') {
    const plan = read('ship/sections/plan-completion.md');
    if (!plan.includes('## Step 8.1: Plan Verification') || plan.includes('### 3. Invoke /qa-only inline')) {
      throw new Error('Generated plan verification has not been integrated');
    }
  }
  return excerpt;
}

export interface CallerTool {
  id: string;
  parent: string | null;
  name: string;
  input: Record<string, unknown>;
  output: string;
  failed: boolean;
  index: number;
  resultIndex: number;
  messageId?: string;
  sessionId?: string;
  handoffContent?: string;
}

const UNCHANGED_READ = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';

export function callerTools(transcript: unknown[]): CallerTool[] {
  const failures: string[] = [];
  const calls = nativeCalls(transcript, failures);
  if (failures.length) throw new Error(failures.join('; '));
  const tools: CallerTool[] = [];
  for (const call of calls) {
    const start = transcript[call.start] as any;
    const event = transcript[call.end] as any;
    const tool: CallerTool = { id: call.id, parent: call.parent, name: call.name, input: call.input,
      output: call.output, failed: call.failed, index: call.start, resultIndex: call.end,
      messageId: start.message.id, sessionId: start.session_id };
    tools.push(tool);
    const native = event.tool_use_result;
    if (!tool.failed && tool.name === 'Read' && typeof tool.input.file_path === 'string'
      && tool.input.file_path.endsWith('/HANDOFF.md') && Object.keys(tool.input).length === 1
      && typeof tool.sessionId === 'string' && event.session_id === tool.sessionId
      && event.message.content.length === 1 && native?.file?.filePath === tool.input.file_path) {
      if (native.type === 'text' && typeof native.file.content === 'string') {
        const lines = native.file.content.split('\n');
        if (native.file.startLine === 1 && native.file.numLines === lines.length && native.file.totalLines === lines.length
          && tool.output === lines.map((line: string, i: number) => `${i + 1}\t${line}`).join('\n')) {
          tool.handoffContent = native.file.content;
        }
      } else if (native.type === 'file_unchanged' && tool.output === UNCHANGED_READ) {
        const prior = tools.findLast(read => read.name === 'Read' && read.parent === tool.parent && read.sessionId === tool.sessionId
          && read.input.file_path === tool.input.file_path
          && read.resultIndex >= 0 && read.resultIndex < tool.index && (!tool.messageId || read.messageId !== tool.messageId));
        tool.handoffContent = prior?.handoffContent;
      }
    }
  }
  return tools;
}

export interface CallerProbe {
  id: string;
  charter: string;
  input: string;
  snapshot: string;
  status: 'pass' | 'fail' | 'blocked' | 'inconclusive';
  stdout: string;
  stderr: string;
  exit: number | null;
}

export interface CallerReceipt {
  status: 'pass' | 'fail' | 'blocked' | 'inconclusive';
  probes: string[];
  remaining: string[];
}

const literalCallerArgument = /(?:[^\s'"\\;&|<>`$(){}*?\[\]~#]+|'[^'\r\n]*'|"[^"\\$`\r\n]*")/.source;
const literalCallerCLI = new RegExp(`^bun (?:scripts/probe\\.ts|cli\\.ts)(?: ${literalCallerArgument})?$`);
const literalCallerProbe = new RegExp(`^bun scripts/probe\\.ts(?: ${literalCallerArgument})?$`);
const literalDeadlineCommand = new RegExp(`^bun (${literalCallerArgument}) (start|status|run) (${literalCallerArgument})(?: (.*))?$`);
const literalCallerListing = new RegExp(`^ls(?: -[la]+)?(?: --)?(?: ${literalCallerArgument})*$`);
const callerDiffMode = '(--stat|--numstat|--name-only|--name-status)';
const literalCallerDiff = new RegExp(`^git diff(?: ${callerDiffMode})?(?: (origin/main|"\\$DIFF_BASE"))?(?: ${callerDiffMode})?(?: --(?: ${literalCallerArgument})+)?$`);
const callerDiffPreface = 'DIFF_BASE=$(git merge-base origin/main HEAD) && ';

function literalCallerDiffAllowed(text: string): boolean {
  const recomputedBase = text.startsWith(callerDiffPreface);
  const diff = literalCallerDiff.exec(recomputedBase ? text.slice(callerDiffPreface.length) : text);
  return !!diff && !(diff[1] && diff[3]) && recomputedBase === (diff[2] === '"$DIFF_BASE"');
}

function literalCallerListingAllowed(text: string): boolean {
  if (!literalCallerListing.test(text)) return false;
  const operands = text.match(new RegExp(literalCallerArgument, 'g'))!.slice(1);
  if (operands[0]?.match(/^-[la]+$/)) operands.shift();
  return operands[0] === '--' || operands.every(operand => !operand.replace(/^['"]/, '').startsWith('-'));
}

export interface CallerDeadlineContext {
  runtime: string;
  fixtureRoot: string;
}

function callerEvidenceContext(context?: CallerDeadlineContext): QaEvidenceContext | undefined {
  return context ? { cwd: context.fixtureRoot, reportRoot: path.join(context.fixtureRoot, 'reports'), executable: path.join(context.runtime, 'bin/gstack-qa-evidence') } : undefined;
}

function callerEvidenceCommand(command: string, context?: CallerDeadlineContext) {
  const parsed = qaEvidenceCommand(command, callerEvidenceContext(context));
  if (!context || !parsed) return;
  try {
    if (!path.isAbsolute(context.fixtureRoot) || path.resolve(context.fixtureRoot) !== context.fixtureRoot
      || context.runtime !== path.join(path.dirname(context.fixtureRoot), 'host/runtime')
      || fs.realpathSync(context.runtime) !== context.runtime
      || fs.realpathSync(path.join(context.runtime, 'bin/gstack-qa-evidence')) !== path.join(fs.realpathSync(QA_CALLER_ROOT), 'bin/gstack-qa-evidence')
      || !fs.lstatSync(ownedPath(context.fixtureRoot, 'reports')).isDirectory()) return;
    if (parsed.action !== 'capture') return parsed;
    if (!literalCallerProbe.test(parsed.nativeCommand!)) return;
    if (parsed.deadline === path.join(context.fixtureRoot, 'reports/deadline.json') || parsed.timeoutMs === 10000) return parsed;
  } catch {}
}

function callerDeadlineCommand(command: string, context?: CallerDeadlineContext) {
  if (!context) return;
  const capture = callerEvidenceCommand(command, context);
  if (capture?.action === 'capture' && capture.deadline) return { action: 'run', stateFile: capture.deadline };
  const match = literalDeadlineCommand.exec(command.trim());
  if (!match) return;
  const literal = (value: string) => /^['"]/.test(value) ? value.slice(1, -1) : value;
  const helper = path.join(context.runtime, 'bin/gstack-qa-deadline');
  const stateFile = path.join(context.fixtureRoot, 'reports/deadline.json');
  if (literal(match[1]) !== helper || literal(match[3]) !== stateFile) return;
  try {
    if (!path.isAbsolute(context.runtime) || path.resolve(context.runtime) !== context.runtime
      || !path.isAbsolute(context.fixtureRoot) || path.resolve(context.fixtureRoot) !== context.fixtureRoot
      || context.runtime !== path.join(path.dirname(context.fixtureRoot), 'host/runtime')
      || fs.realpathSync(context.runtime) !== context.runtime
      || ownedPath(context.fixtureRoot, 'reports/deadline.json') !== stateFile
      || !fs.lstatSync(path.dirname(stateFile)).isDirectory()
      || !fs.statSync(helper).isFile()
      || fs.realpathSync(helper) !== path.join(fs.realpathSync(QA_CALLER_ROOT), 'bin/gstack-qa-deadline')) return;
  } catch { return; }
  const action = match[2];
  const rest = match[4];
  if (action === 'status' && rest === undefined) return { action, stateFile };
  if (action === 'run' && rest?.startsWith('-- ') && literalCallerProbe.test(rest.slice(3))) {
    return { action, stateFile };
  }
  if (action !== 'start' || rest === undefined) return;
  const start = new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,3})?(?: (${literalCallerArgument}))?$`).exec(rest);
  if (!start) return;
  const seconds = Number(start[1] + (start[2] ?? ''));
  if (!(seconds > 0 && seconds <= 300)) return;
  const earlier = start[3] === undefined ? undefined : literal(start[3]);
  if (earlier !== undefined) {
    const time = Date.parse(earlier);
    if (!Number.isFinite(time) || ![new Date(time).toISOString(), new Date(time).toISOString().replace('.000Z', 'Z')].includes(earlier)) return;
  }
  return { action, stateFile };
}

export function qaCallerCommandAllowed(command: string, workflowCommands: string[] = [], deadline?: CallerDeadlineContext): boolean {
  const text = command.trim();
  if (qaHelperUsageCommand(text)) return true;
  if (callerEvidenceCommand(text, deadline)) return true;
  if (callerDeadlineCommand(text, deadline)) return true;
  if (/\bgstack-qa-(?:deadline|evidence)\b/.test(text) && !literalCallerCLI.test(text)
    && !literalCallerDiffAllowed(text) && !literalCallerListingAllowed(text)) return false;
  if (workflowCommands.includes(text)) return true;
  if (literalCallerCLI.test(text)) return true;
  if (literalCallerDiffAllowed(text)) return true;
  if (literalCallerListingAllowed(text)) return true;
  let normalizedRecord = text;
  const substitutedFields: string[] = [];
  for (const [field, command] of [['timestamp', 'date -u +%Y-%m-%dT%H:%M:%SZ'], ['commit', 'git rev-parse --short HEAD']]) {
    const fragment = `"${field}":"'"$(${command})"'"`;
    if (!normalizedRecord.includes(fragment)) continue;
    if (normalizedRecord.split(fragment).length !== 2) return false;
    normalizedRecord = normalizedRecord.replace(fragment, `"${field}":"native-${field}"`);
    substitutedFields.push(field);
  }
  const reviewRecord = normalizedRecord.match(/^\/?[\w./-]+\/bin\/gstack-review-log '([^'\r\n]+)'(?: --finish ([a-zA-Z0-9._:-]+))?$/);
  if (reviewRecord) {
    try {
      const record = JSON.parse(reviewRecord[1]);
      if (substitutedFields.some(field => record[field] !== `native-${field}`)) return false;
      if (record?.skill === 'review') return !!reviewRecord[2];
      return record?.skill === 'adversarial-review'
        && (!!reviewRecord[2] || record.completed === false && record.converged === false);
    } catch { return false; }
  }
  if (/[\n\r;&|<>`$\\(){}]/.test(text)) return false;
  return /^(?:pwd|ls(?: -la)?|bun --version|date -u \+%Y-%m-%dT%H:%M:%SZ|bun (?:run test|test(?: cli\.test\.ts)?))$/.test(text)
    || /^git (?:status --(?:short|porcelain)|branch --show-current|rev-parse (?:--short )?HEAD|merge-base origin\/main HEAD|log origin\/main\.\.HEAD --oneline|ls-files(?: --others --exclude-standard)?)$/.test(text)
    || /^\/?[\w./-]+\/bin\/gstack-review-log --start (?:review|adversarial-review)$/.test(text)
    || /^\/?[\w./-]+\/bin\/gstack-(?:review-read|specialist-stats)$/.test(text);
}

/**
 * A QA helper call whose script path bun could not load (a mistyped path)
 * executed nothing. Returns the same command at the installed helper path, so
 * the caller can hold it to the declared interface; anything else is undefined.
 */
export function unloadedHelperCommand(tool: Pick<CallerTool, 'input' | 'output' | 'failed'>, runtime: string): string | undefined {
  const command = String(tool.input.command).trim();
  const script = /^bun (\/[\w./-]+\/bin\/(gstack-qa-(?:evidence|deadline))) /.exec(command);
  if (!tool.failed || !script || tool.output.trim() !== `Exit code 1\nerror: Module not found "${script[1]}"`) return;
  return `bun ${path.join(runtime, 'bin', script[2]!)}${command.slice(script[0].length - 1)}`;
}

const REVIEW_RECORD_STATUSES: Record<QaCaller, string[]> = { review: ['clean', 'issues_found'], ship: ['clean', 'issues_found', 'unavailable'] };

export function validateCallerEvidence(input: {
  caller: QaCaller;
  result: Pick<SkillTestResult, 'transcript' | 'exitReason'>;
  probes: CallerProbe[];
  receipt: CallerReceipt;
  currentSnapshot: string;
  requiredCharters: string[];
  mutations: string[];
  observerComplete: boolean;
  workflowCommands?: string[];
  fixtureRoot?: string;
  runtime?: string;
  requireGuardedSmoke?: boolean;
  requireCapturedEvidence?: boolean;
  reportRoot: string;
  checkpointFiles: Record<string, string>;
  reportMarkdown: string;
}): string[] {
  const errors: string[] = [];
  const deadline = input.fixtureRoot && input.runtime ? { fixtureRoot: input.fixtureRoot, runtime: input.runtime } : undefined;
  const producerContext = callerEvidenceContext(deadline);
  if (deadline && input.reportRoot !== path.join(deadline.fixtureRoot, 'reports')) errors.push('deadline report root differs from the owned caller report root');
  if (input.result.exitReason !== 'success') errors.push(`session did not complete: ${input.result.exitReason}`);
  if (!input.observerComplete) errors.push('observer incomplete');
  if (input.mutations.length) errors.push(...input.mutations.map(file => `unauthorized mutation: ${file}`));
  let tools: CallerTool[];
  try { tools = callerTools(input.result.transcript); } catch (error) {
    return [...errors, (error as Error).message];
  }
  const reads = tools.filter(tool => tool.name === 'Read' && !tool.failed && tool.output.trim());
  const captureOf = (tool: CallerTool) => qaNativeCapture({ ...tool, start: tool.index, end: tool.resultIndex }, producerContext);
  const readOf = (suffix: string) => reads.find(tool => String(tool.input.file_path ?? '').endsWith(suffix));
  for (const resource of ['/qa/sections/exploratory.md', '/qa/sections/system-functional.md']) {
    if (!readOf(resource)) errors.push(`missing executed resource read: ${resource}`);
  }
  const parentRead = readOf(`/caller-${input.caller}.md`);
  if (!parentRead) errors.push('missing parent entrypoint read');
  if (input.caller === 'ship' && !readOf('/ship/sections/review-army.md')) errors.push('missing ship Step 9 read');
  for (const tool of tools) {
    const file = String(tool.input.file_path ?? '');
    const guarded = tool.name === 'Bash' ? callerDeadlineCommand(String(tool.input.command), deadline) : undefined;
    if (input.fixtureRoot && ['Write', 'Edit', 'MultiEdit'].includes(tool.name)) {
      try {
        const relative = path.relative(input.fixtureRoot, ownedPath(input.fixtureRoot, file));
        if (!/^(?:reports|\.qa-state)\//.test(relative)) errors.push('write outside the declared report/fixture interface');
        if (relative === 'reports/deadline.json' || /^reports\/\.qa-deadline-/.test(relative)) errors.push('actor attempted to replace reserved deadline state');
        if (input.requireCapturedEvidence && /^reports\/exploration-\d{3}\.json$/.test(relative)) errors.push('actor transcribed or overwrote helper-owned checkpoint');
      } catch { errors.push('write outside the declared report/fixture interface'); }
    }
    const corrected = tool.name === 'Bash' && deadline ? unloadedHelperCommand(tool, deadline.runtime) : undefined;
    if (tool.name === 'Bash' && !qaCallerCommandAllowed(String(tool.input.command), input.workflowCommands, deadline)
      && !(corrected && qaCallerCommandAllowed(corrected, input.workflowCommands, deadline))) {
      errors.push('command outside declared caller observation interface');
    }
    const record = tool.name === 'Bash' ? String(tool.input.command).match(/gstack-review-log '(.*)'(?: --finish \S+)?$/s)?.[1] : undefined;
    const status = record?.match(/"status"\s*:\s*"([^"]*)"/)?.[1] ?? '';
    if (record && /"skill"\s*:\s*"review"/.test(record) && !REVIEW_RECORD_STATUSES[input.caller].includes(status)) {
      errors.push(`review record status outside the ${input.caller} vocabulary: ${status}`);
    }
    if (tool.name === 'Read' && /\/(?:browse|devex-review)\/SKILL\.md$|\/qa\/sections\/(?:browser-[^/]+|qa-patterns)\.md$/.test(file)) {
      errors.push(`unexpected browser/DX load: ${file}`);
    }
    if (tool.name === 'Skill' && /^(?:gstack-)?(?:qa|qa-only|review|ship)$/.test(String(tool.input.skill))) {
      errors.push(`recursive full skill: ${tool.input.skill}`);
    }
    if (tool.name === 'Read' && /\/(?:qa|qa-only|review|ship)\/SKILL\.md$/.test(file)) {
      errors.push(`recursive full skill read: ${file}`);
    }
    if (tool.name === 'Bash' && guarded?.action !== 'run' && !literalCallerCLI.test(String(tool.input.command).trim()) && !literalCallerDiffAllowed(String(tool.input.command).trim()) && !literalCallerListingAllowed(String(tool.input.command).trim()) && /\bgit\s+(?:(?:-C|-c)\s+\S+\s+)*(?:add|commit|push|stash|reset|checkout|restore|merge|rebase|cherry-pick)(?=\s|[;&|<>]|$)|\bgh\s+pr\s+(?:create|merge)\b/.test(String(tool.input.command))) {
      errors.push('unauthorized git/publication action');
    }
    if (tool.parent && ['Write', 'Edit', 'MultiEdit'].includes(tool.name) && !/\/(?:reports|evidence|state)\//.test(file)) {
      errors.push('discovery child attempted a product/test edit');
    }
  }
  const seen = new Set<string>();
  let guardedDiagnostics = 0;
  const checkpointProbes: Array<{ command: string; observed: CallerProbe; index: number }> = [];
  for (const probe of input.probes) {
    const key = JSON.stringify([probe.charter, probe.input, probe.snapshot]);
    if (seen.has(key) && probe.status === 'pass') errors.push(`duplicate unchanged passing probe: ${probe.id}`);
    seen.add(key);
    const tool = tools.find(tool => tool.name === 'Bash'
      && (/^(?:\s*cd\s+[^\n&;]+\s*&&)?\s*(?:bun|[\w./-]+\/bun)\s+(?:run\s+)?(?:scripts\/probe\.ts|'scripts\/probe\.ts'|"scripts\/probe\.ts")(?:\s|$)/.test(String(tool.input.command))
        || callerDeadlineCommand(String(tool.input.command), deadline)?.action === 'run'
        || callerEvidenceCommand(String(tool.input.command), deadline)?.action === 'capture')
      && (callerEvidenceCommand(String(tool.input.command), deadline)?.action === 'capture'
        ? isDeepStrictEqual(captureOf(tool)?.captured.observed, probe)
        : tool.output.split('\n').some(line => {
          try { return JSON.stringify(JSON.parse(line)) === JSON.stringify(probe); } catch { return false; }
        })));
    if (!tool) errors.push(`probe missing native command/result: ${probe.id}`);
    else {
      checkpointProbes.push({ command: String(tool.input.command), observed: probe, index: tool.index });
      if (parentRead && (tool.index <= parentRead.resultIndex || tool.messageId && tool.messageId === parentRead.messageId)) errors.push(`probe preceded parent entrypoint: ${probe.id}`);
      for (const id of ['exploratory', 'system-functional']) {
        const resource = readOf(`/qa/sections/${id}.md`);
        if (resource && (tool.index <= resource.resultIndex || tool.messageId && tool.messageId === resource.messageId)) errors.push(`probe preceded resource read: ${id}`);
      }
      if (input.requireGuardedSmoke) {
        const command = String(tool.input.command);
        const guarded = callerDeadlineCommand(command, deadline);
        const captured = captureOf(tool);
        const requiredPlan = probe.charter === 'plan:nine' && probe.input === '9' && input.requiredCharters.includes('plan:nine')
          && /^bun scripts\/probe\.ts (?:9|'9'|"9")$/.test(captured?.command.nativeCommand ?? command.trim());
        if (guarded?.action !== 'run') {
          if (!requiredPlan) errors.push(`smoke probe missing trusted deadline run: ${probe.id}`);
        } else {
          let valid = false;
          try {
            const receipts = captured?.captured.receipt.timing ?? tool.output.split('\n').filter(line => line.startsWith('QA_DEADLINE '))
              .map(line => JSON.parse(line.slice('QA_DEADLINE '.length)));
            const [started, finished] = receipts;
            const state = readQaDeadline(guarded.stateFile);
            const start = Date.parse(started.observedAt), end = Date.parse(finished.observedAt);
            const limit = Date.parse(state.deadlineAt);
            valid = receipts.length === 2 && state.budgetMs <= 300_000
              && Number.isFinite(start) && Number.isFinite(end)
              && new Date(start).toISOString() === started.observedAt && new Date(end).toISOString() === finished.observedAt
              && start >= Date.parse(state.startedAt) && start < limit && end >= start && end < limit
              && Number.isInteger(probe.exit) && probe.exit !== null && probe.exit >= 0 && probe.exit <= 255
              && tool.failed === (probe.exit !== 0)
              && isDeepStrictEqual(started, { guard: 'qa-deadline', event: 'started', ...state, observedAt: started.observedAt, remainingMs: limit - start, expired: false })
              && isDeepStrictEqual(finished, { guard: 'qa-deadline', event: 'finished', observedAt: finished.observedAt, deadlineAt: state.deadlineAt, timedOut: false, exitCode: probe.exit });
          } catch {}
          if (valid) guardedDiagnostics++;
          else errors.push(`smoke probe missing consistent deadline receipts: ${probe.id}`);
        }
      }
    }
    if (probe.status === 'pass' && probe.exit === null) errors.push(`unfinished probe reported pass: ${probe.id}`);
  }
  if (input.requireGuardedSmoke && !guardedDiagnostics) errors.push('no authenticated guarded diagnostic executed');
  checkpointProbes.sort((a, b) => a.index - b.index);
  if (input.requireCapturedEvidence && checkpointProbes.some(probe => qaEvidenceCommand(probe.command, producerContext)?.action !== 'capture')) errors.push('diagnostic probe bypassed production capture');
  const expiredTargets = tools.flatMap(tool => {
    if (tool.name !== 'Bash' || !tool.failed) return [];
    const command = String(tool.input.command);
    const guarded = callerDeadlineCommand(command, deadline);
    if (guarded?.action !== 'run') return [];
    try {
      const completion = qaProducerReceipt({ ...tool, start: tool.index, end: tool.resultIndex }, producerContext, 'incomplete');
      let diagnostics: any[];
      if (completion?.command.action === 'capture' && producerContext) {
        const capture = readQaCaptureRecord(input.reportRoot, completion.command.id!, completion.receipt.sha256);
        if (capture.receipt.status !== 'incomplete' || capture.receipt.exitCode !== 124 || completion.receipt.exitCode !== 124
          || capture.receipt.signal !== null || capture.receipt.cwd !== producerContext.cwd || capture.receipt.deadline !== guarded.stateFile
          || !isDeepStrictEqual(capture.receipt.argv, completion.command.argv) || capture.stdout.length || capture.stderr.length) return [];
        diagnostics = capture.receipt.timing;
      } else diagnostics = tool.output.split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(line => JSON.parse(line.slice('QA_DEADLINE '.length)));
      if (diagnostics.length !== 1) return [];
      const receipt = diagnostics[0];
      const state = readQaDeadline(guarded.stateFile);
      const observed = Date.parse(receipt.observedAt);
      if (state.budgetMs > 300_000 || !Number.isFinite(observed) || new Date(observed).toISOString() !== receipt.observedAt
        || observed < Date.parse(state.startedAt) || observed < Date.parse(state.deadlineAt)
        || !isDeepStrictEqual(receipt, { guard: 'qa-deadline', event: 'expired', ...state, observedAt: receipt.observedAt, remainingMs: 0, expired: true })
        || tool.output.split('\n').some(line => { try { JSON.parse(line); return true; } catch { return false; } })) return [];
      return [{ command, output: tool.output }];
    } catch { return []; }
  });
  errors.push(...validateQACheckpoints({
    transcript: input.result.transcript, reportRoot: input.reportRoot,
    producer: producerContext,
    probes: checkpointProbes, requiredProbes: checkpointProbes.slice(1),
    additionalTargets: expiredTargets,
    files: input.checkpointFiles, reportMarkdown: input.reportMarkdown,
    // An installed review-log record cites checkpoints in its findings' evidence.
    citesCheckpointsOnly: command => /^\S*\/gstack-review-log '/.test(command.trim())
      && qaCallerCommandAllowed(command, input.workflowCommands, deadline),
  }));
  const selected = input.receipt.probes.map(id => input.probes.find(probe => probe.id === id));
  if (selected.some(probe => !probe)) errors.push('receipt references an unobserved probe');
  const currentProbes = selected.filter((probe): probe is CallerProbe => !!probe && probe.snapshot === input.currentSnapshot);
  const boundary = currentProbes.find(probe => probe.charter === 'plan:nine' && probe.input === '9'
    && probe.exit === 0 && probe.stdout === '18\n' && probe.stderr === '' && probe.status === 'pass');
  const happyProof = currentProbes.find(probe => probe.charter === 'happy' && probe.status === 'pass') ?? boundary;
  for (const charter of input.requiredCharters) {
    const current = currentProbes.filter(probe => probe.charter === charter
      || charter === 'happy' && probe === boundary
      || charter === 'adverse' && probe === boundary && (!input.requiredCharters.includes('happy') || probe.id !== happyProof?.id));
    if (!current.length && !input.receipt.remaining.length) errors.push(`missing current charter: ${charter}`);
    if (input.receipt.status === 'pass' && !current.some(probe => probe.status === 'pass')) {
      errors.push(`false green for charter: ${charter}`);
    }
  }
  const handoffs = reads.filter(tool => String(tool.input.file_path ?? '').endsWith('/HANDOFF.md'));
  for (const tool of tools) {
    if (tool.name !== 'Bash' || !/gstack-review-log['"]?\s/.test(String(tool.input.command))
      || !/"completed"\s*:\s*true/.test(String(tool.input.command))) continue;
    if (handoffs.some(read => (read.resultIndex >= tool.index || tool.messageId && tool.messageId === read.messageId)
      && !handoffs.some(prior => prior.input.file_path === read.input.file_path && prior.parent === read.parent && prior.sessionId === read.sessionId
        && (read.output !== UNCHANGED_READ && prior.output === read.output
          || read.handoffContent !== undefined && prior.handoffContent === read.handoffContent)
        && prior.resultIndex < tool.index && (!tool.messageId || tool.messageId !== prior.messageId)))) {
      errors.push('review completion preceded handoff freshness decision');
    }
  }
  if (input.requireCapturedEvidence && input.reportRoot) {
    const evidenceFile = path.join(input.reportRoot, 'evidence.json');
    const verdict = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).verdict : undefined;
    if (verdict && input.receipt.status !== verdict.status) errors.push(`receipt status ${input.receipt.status} differs from helper verdict ${verdict.status}`);
  }
  if (input.receipt.status === 'pass' && (input.receipt.remaining.length || selected.some(probe => probe?.status !== 'pass'))) {
    errors.push('blocked, failing or incomplete coverage reported green');
  }
  return errors;
}

export function callerSnapshot(files: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}

export const QA_CALLER_CASES = [
  'review-exploratory-small-cli',
  'ship-exploratory-small-cli',
  'ship-exploratory-unavailable',
  'ship-exploratory-plan-checks',
  'ship-exploratory-late-input',
] as const;

export type QaCallerCase = typeof QA_CALLER_CASES[number];
export const QA_CALLER_TEST_MS = CAPTURE_MS + SESSION_DRAIN_GRACE_MS + 10_000;
const productFiles = ['scale.ts', 'cli.ts', 'cli.test.ts', 'README.md', 'package.json'];

export interface QaCallerFixture {
  root: string;
  cwd: string;
  state: string;
  runtime: string;
  config: string;
  instructions: string;
  caller: QaCaller;
  caseId: QaCallerCase;
  reviewStart?: string;
  startObservations: string;
  gitEnvironment: Record<'GIT_OBJECT_DIRECTORY' | 'GIT_ALTERNATE_OBJECT_DIRECTORIES', string>;
  journal: string;
  child?: string;
  mutationEvents: string[];
  observerErrors: string[];
  observation?: QAWriteObservation;
  workflowCommands: string[];
  lateApplied: boolean;
  snapshot(): string;
  probes(): CallerProbe[];
  observe(): Promise<void>;
  close(): Promise<void>;
}

export function createQaCallerFixture(caseId: QaCallerCase, options: { instructions?: string; installRuntime?: boolean } = {}): QaCallerFixture {
  const caller: QaCaller = caseId.startsWith('review-') ? 'review' : 'ship';
  const instructions = options.instructions ?? qaCallerInstructions(caller);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-'));
  const cwd = path.join(root, 'product');
  const state = path.join(root, 'state');
  for (const dir of [cwd, state, path.join(cwd, 'scripts'), path.join(cwd, 'reports'), path.join(cwd, '.qa-state')]) fs.mkdirSync(dir);
  const runtimeParent = path.join(root, 'host');
  fs.mkdirSync(runtimeParent);
  const config = options.installRuntime === false ? '' : refreshHermeticSkillRuntime(QA_CALLER_ROOT, runtimeParent);
  const runtime = path.join(runtimeParent, 'runtime');
  const journal = path.join(root, 'probes.jsonl');
  const fixtureInput = path.join(state, 'fixture.json');
  fs.writeFileSync(journal, '', { mode: 0o600 });
  seedHermeticGstackHome(state);
  fs.appendFileSync(path.join(state, 'config.yaml'), 'cross_project_learnings: false\n');
  fs.writeFileSync(fixtureInput, '{"locale":"C"}\n');
  const base = 'export function scale(value: string) {\n  const n = Number(value);\n  if (!/^\\d+$/.test(value) || n > 9) throw new Error("integer required: 0..9");\n  return 2 * n;\n}\n';
  fs.writeFileSync(path.join(cwd, 'scale.ts'), base);
  fs.writeFileSync(path.join(cwd, 'cli.ts'), 'import { scale } from "./scale";\ntry { console.log(scale(process.argv[2] ?? "")); } catch (error) { console.error((error as Error).message); process.exit(2); }\n');
  if (caseId === 'ship-exploratory-unavailable') {
    fs.writeFileSync(path.join(cwd, 'cli.ts'), 'import "./vendor/native-engine.ts";\n' + fs.readFileSync(path.join(cwd, 'cli.ts'), 'utf8'));
  }
  fs.writeFileSync(path.join(cwd, 'cli.test.ts'), 'import { test, expect } from "bun:test";\nimport { scale } from "./scale";\ntest("double a positive number", () => expect(scale("3")).toBe(6));\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'caller-scale', private: true, scripts: { test: 'bun test cli.test.ts' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), `# Scale CLI\n\nThe CLI doubles an integer from 0 through 9 inclusive. Success exits 0 with the doubled integer and a newline on stdout, and empty stderr. Other inputs exit 2, with empty stdout and exactly \"integer required: 0..9\\n\" on stderr. It has no persistent business state or network effects.\n\nRun \`bun cli.ts <integer>\`. The repository's diagnostic client \`bun scripts/probe.ts <integer>\` launches that same CLI, records its separate streams and exit status, and prints a JSON receipt. The client preserves the command's exit status. Every diagnostic receipt field is synthetic, nonsecret evidence; snapshot identifies the owned source and fixture inputs. Its journal is owned temporary evidence outside the source tree. It is safe to use with arbitrary local input. Native tests: \`bun run test\`. No browser or service is used.\n`);
  if (caseId === 'ship-exploratory-unavailable') {
    fs.appendFileSync(path.join(cwd, 'README.md'), '\nThis target additionally requires the generated native-engine module at vendor/native-engine.ts. The module has not been built in this environment; no dependency generation, installation or substitute engine is authorized. Pure scale unit tests do not exercise that CLI prerequisite.\n');
  }
  const probeSource = `import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const files = ${JSON.stringify(productFiles)};
const snapshot = createHash('sha256').update(JSON.stringify([...files.map(file => [file, fs.readFileSync(file, 'utf8')]), ['fixture.json', fs.readFileSync(${JSON.stringify(fixtureInput)}, 'utf8')]].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const input = process.argv[2] ?? '';
const n = Number(input), valid = /^\\d+$/.test(input) && n <= 9;
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureInput)}, 'utf8'));
const result = spawnSync(${JSON.stringify(process.execPath)}, ['cli.ts', input], { cwd: process.cwd(), env: { ...process.env, LC_ALL: fixture.locale }, encoding: 'utf8', timeout: 2000 });
const stdout = result.stdout ?? '', stderr = result.stderr ?? result.error?.message ?? '';
const exit = result.status ?? null;
const expected = valid ? { exit: 0, stdout: String(n * 2) + '\\n', stderr: '' } : { exit: 2, stdout: '', stderr: 'integer required: 0..9\\n' };
const missingPrerequisite = ${caseId === 'ship-exploratory-unavailable'} && !fs.existsSync('vendor/native-engine.ts');
const status = result.error || missingPrerequisite && exit !== 0 ? 'blocked' : exit === expected.exit && stdout === expected.stdout && stderr === expected.stderr ? 'pass' : 'fail';
const charter = input === '9' ? 'plan:nine' : valid && n > 0 ? 'happy' : 'adverse';
const probe = { id: 'probe-' + randomUUID(), charter, input, snapshot, status, stdout, stderr, exit };
fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(probe) + '\\n');
console.log(JSON.stringify(probe));
process.exit(exit ?? 127);
`;
  fs.writeFileSync(path.join(cwd, 'scripts/probe.ts'), probeSource);
  fs.writeFileSync(path.join(cwd, 'HANDOFF.md'), 'No concurrent input update.\n');
  if (caseId === 'ship-exploratory-plan-checks') {
    fs.writeFileSync(path.join(cwd, 'PLAN.md'), '# Scale change\n\n## Verification\n\nThe upper boundary is a required release check: run `bun scripts/probe.ts 9`; require exit 0, stdout `18\\n`, and empty stderr. Ordinary positive input is not a substitute for this check.\n');
  }
  const childOutputs: Partial<Record<QaCallerCase, string>> = {
    'review-exploratory-small-cli': `ADVERSARIAL REVIEW (Claude subagent):
Fixtures and tests were reviewed in summary mode; none changed.
1. FIXABLE — scale.ts:3: the added \`!n\` guard treats the documented valid input 0 as invalid because Number("0") is falsy, so \`0\` now exits 2 with the rejection message instead of printing 0.
Recommendation: Fix the \`!n\` guard at scale.ts:3 because it rejects the documented lower boundary 0.
`,
    'ship-exploratory-plan-checks': `{"total_items":0,"done":0,"changed":0,"partial":0,"not_done":0,"unverifiable":0,"summary":"PLAN.md has no implementation deliverables. Execution-only check retained verbatim for Step 8.1/9: run \`bun scripts/probe.ts 9\`; require exit 0, stdout \`18\\\\n\`, and empty stderr (PLAN.md, Verification). Pending execution."}
`,
  };
  const childText = childOutputs[caseId];
  const child = childText === undefined ? undefined : path.join(root, 'children', caller === 'review' ? 'adversarial.md' : 'plan-audit.json');
  if (child) { fs.mkdirSync(path.dirname(child)); fs.writeFileSync(child, childText!); }
  const run = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(`Caller fixture git ${args[0]} failed: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
  };
  try {
    run('init', '-b', 'main');
    run('config', 'user.name', 'QA Caller Fixture');
    run('config', 'user.email', 'qa-caller-fixture@gstack.test');
    run('config', 'commit.gpgsign', 'false');
    run('config', 'gc.auto', '0');
    run('config', 'maintenance.auto', 'false');
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'reports/\n.gstack/\n.qa-state/\ncaller-*.md\n');
    run('add', '.');
    run('commit', '-m', 'Seed caller fixture');
    run('update-ref', 'refs/remotes/origin/main', 'HEAD');
    run('checkout', '-b', 'caller-change');
    fs.writeFileSync(path.join(cwd, 'scale.ts'), caseId === 'review-exploratory-small-cli'
      ? base.replace('if (!/^', 'if (!n || !/^')
      : base.replace('return 2 * n;', 'return n + n;'));
    const numstat = run('diff', '--numstat', 'origin/main').split('\n').filter(Boolean);
    if (numstat.reduce((sum, line) => sum + line.split('\t').slice(0, 2).reduce((n, value) => n + Number(value), 0), 0) >= 50) {
      throw new Error('Caller fixture no longer exercises the small-diff bypass');
    }
    if (fs.realpathSync(cwd).startsWith(fs.realpathSync(QA_CALLER_ROOT) + path.sep)) throw new Error('Product fixture is inside source checkout');
    if (run('rev-parse', '--show-toplevel') !== fs.realpathSync(cwd)) throw new Error('Wrong fixture repository root');
    const instructionFile = path.join(cwd, `caller-${caller}.md`);
    fs.writeFileSync(instructionFile, instructions.replace(/~\/\.claude\/skills\/gstack\b/g, runtime));
    const gitEnvironment = {
      GIT_OBJECT_DIRECTORY: path.join(state, 'git-objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
    };
    fs.cpSync(fs.realpathSync(path.join(cwd, '.git/objects')), gitEnvironment.GIT_OBJECT_DIRECTORY, { recursive: true });
    const startObservations = [
      `git rev-parse --short HEAD: ${run('rev-parse', '--short', 'HEAD')}`,
      `git log origin/main..HEAD --oneline: ${run('log', 'origin/main..HEAD', '--oneline') || '(no commits)'}`,
      `git ls-files --others --exclude-standard: ${run('ls-files', '--others', '--exclude-standard') || '(none)'}`,
      `git status --short: ${run('status', '--short')}`,
      `git diff origin/main --stat:\n${run('diff', 'origin/main', '--stat')}`,
      `git diff origin/main:\n${run('diff', 'origin/main')}`,
      'reports/ and .qa-state/ contain no files yet.',
    ].join('\n');
    let reviewStart: string | undefined;
    {
      const start = spawnSync('bash', [path.join(QA_CALLER_ROOT, 'bin/gstack-review-log'), '--start', 'review'], {
        cwd, env: { ...process.env, ...gitEnvironment, GSTACK_HOME: state, GSTACK_STATE_ROOT: state },
        encoding: 'utf8', timeout: 5000,
      });
      if (start.status !== 0 || !/^[0-9a-f-]{36}$/.test(start.stdout.trim())) {
        throw new Error(`Caller review start failed: ${start.stderr || start.error?.message}`);
      }
      reviewStart = start.stdout.trim();
    }
    const mutationEvents: string[] = [], observerErrors: string[] = [];
    let observer: Awaited<ReturnType<typeof observeQAWrites>> | undefined;
    const sources = [instructions, ...[
      `${caller}/sections/review-army.md`, 'ship/sections/plan-completion.md',
      'qa/sections/scope.md', 'qa/sections/exploratory.md', 'qa/sections/system-functional.md',
      ...(caller === 'review' ? ['review/sections/adversarial.md'] : []),
    ].map(file => fs.readFileSync(path.join(QA_CALLER_ROOT, file), 'utf8'))];
    const workflowCommands = sources.flatMap(source => [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map(match => match[1].replaceAll('~/.claude/skills/gstack', runtime).replaceAll('<base>', 'main').trim()));
    if (caller === 'review') {
      const native = fs.readFileSync(path.join(QA_CALLER_ROOT, 'review/sections/adversarial.md'), 'utf8');
      for (const match of native.matchAll(/`([^`\n]+)`/g)) {
        const command = match[1].replaceAll('<base>', 'main');
        if (command.startsWith('DIFF_BASE=$(git merge-base origin/main HEAD) && git diff')) workflowCommands.push(command);
        if (command.startsWith('git diff "$DIFF_BASE"')) {
          workflowCommands.push(command, `DIFF_BASE=$(git merge-base origin/main HEAD) && ${command}`);
        }
      }
    }
    const snapshot = () => callerSnapshot({ ...Object.fromEntries(productFiles.map(file => [file, fs.readFileSync(path.join(cwd, file), 'utf8')])), 'fixture.json': fs.readFileSync(fixtureInput, 'utf8') });
    const probes = () => fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as CallerProbe);
    const fixture: QaCallerFixture = {
      root, cwd, state, runtime, config, caller, caseId, instructions, journal, child, mutationEvents, observerErrors, workflowCommands, reviewStart, startObservations, gitEnvironment,
      lateApplied: false, snapshot, probes,
      observe: async () => {
        if (observer || fixture.observation) throw new Error('Caller observation cannot restart mid-capture');
        observer = await observeQAWrites(cwd, { reportDirectory: 'reports', evidenceProducer: true });
      },
      close: async () => {
        coordinator?.close();
        if (!observer) return;
        fixture.observation = observer.stop();
        observer = undefined;
        observerErrors.push(...fixture.observation.failures);
        if (!fixture.observation.complete) observerErrors.push('incomplete caller write observation');
        for (const file of new Set([...fixture.observation.events.map(event => event.path), ...fixture.observation.changed])) {
          if (!/^(?:reports|\.qa-state)(?:\/|$)/.test(file)) mutationEvents.push(file);
        }
      },
    };
    const coordinator = caseId === 'ship-exploratory-late-input' ? fs.watch(journal, () => {
      if (fixture.lateApplied || probes().length < 2) return;
      fixture.lateApplied = true;
      fs.writeFileSync(fixtureInput, '{"locale":"POSIX"}\n');
      fs.writeFileSync(path.join(cwd, 'reports/HANDOFF.md'), `The fixture coordinator changed the selected native process locale from C to POSIX in ${fixtureInput}.\n`);
    }) : undefined;
    coordinator?.on('error', error => observerErrors.push(error.message));
    return fixture;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function callerReviewRecordTemplate(fixture: Pick<QaCallerFixture, 'caller' | 'runtime'>): string {
  const source = fs.readFileSync(path.join(QA_CALLER_ROOT, fixture.caller === 'review' ? 'review/SKILL.md' : 'ship/sections/review-army.md'), 'utf8');
  const templates = source.match(/^~\/\.claude\/skills\/gstack\/bin\/gstack-review-log '\{"skill":"review",.*$/gm) ?? [];
  if (templates.length !== 1) throw new Error(`Expected one installed /${fixture.caller} review record template, found ${templates.length}`);
  return templates[0].replace('~/.claude/skills/gstack', fixture.runtime);
}

export function qaCallerSessionOptions(fixture: QaCallerFixture, runId: string): Parameters<typeof runSkillTest>[0] {
  return {
    prompt: `Load gstack's /${fixture.caller} supplied parent phase from caller-${fixture.caller}.md and resume it on the selected working-tree diff against origin/main. This excerpt comes from ${fixture.runtime}/${fixture.caller}/SKILL.md; resolve installed-relative references there, not from the excerpt file or product directory. That path identifies the asset base, not another entrypoint: do not read or invoke the full parent SKILL.md or rerun its preamble. Earlier preamble/branch/base setup is complete; use the existing local origin/main ref without fetch. Earlier-phase asset locators are ${fixture.runtime}/review/checklist.md and ${fixture.runtime}/qa/templates/functional-report-template.md. Read those files directly when referenced; recursive Glob does not follow the installed asset symlinks. Cross-project learnings are configured off in this owned fixture. ${fixture.reviewStart ? `The actual review-start helper already captured REVIEW_START=${fixture.reviewStart} for this unchanged core pass; retain that token. ` : ''} This fixture evaluates only the supplied parent phase, not later publication stages. The fixture owner recorded these read-only observations when this phase began; they are current until an input changes, so use them instead of re-running those commands, and recheck freshness before completion outputs:\n${fixture.startObservations}\n Read README.md for the project contract and commands. Use diagnostic-client commands such as \`bun scripts/probe.ts <literal>\` for exploratory discoveries and their checkpoint evidence. A required \`bun run test\` is separate suite verification: report it as verification, never as a diagnostic observation or checkpoint anchor/target. Use the production evidence helper to publish each diagnostic checkpoint as \`reports/exploration-NNN.json\`, not inside a nested directory; do not transcribe its observed payload. ${fixture.caseId === 'ship-exploratory-plan-checks' ? 'The previously discovered plan is PLAN.md.' : 'No plan file was found.'} There is no remote service and no release publication is authorized. There is no interactive approver; do not invent answers or permission. Keep normal parent decision gates. Before the completion report and each completed:true review record, read HANDOFF.md and reports/HANDOFF.md if present for any concurrent collaborator update, await the results, and compare evidence with current inputs. If a probe's snapshot differs from an earlier probe's, read reports/HANDOFF.md first; it names any collaborator change. A gstack-review-log completed:true record is a completion, not preliminary bookkeeping; a later handoff read cannot validate an earlier completion.\n\nDeadline bookkeeping additionally permits \`bun ${fixture.runtime}/bin/gstack-qa-deadline start ${fixture.cwd}/reports/deadline.json SECONDS [EARLIER_UTC]\`, \`bun ${fixture.runtime}/bin/gstack-qa-deadline status ${fixture.cwd}/reports/deadline.json\`, and \`bun ${fixture.runtime}/bin/gstack-qa-deadline run ${fixture.cwd}/reports/deadline.json -- bun scripts/probe.ts [literal]\`. These are closed literal forms: SECONDS must be positive and at most 300, EARLIER_UTC is the optional caller absolute deadline: use the section clock's Hard deadline UTC, never its Runner entry UTC, reserve-start time or a clock-read time. The child is only the existing diagnostic client with zero or one literal argument. Resolve these exact helper and state paths; do not use variables, another helper, another state file, nested wrappers, scripts, operators or substitutions. Only this helper may create or change reports/deadline.json and its .qa-deadline- temporary files; never use Write/Edit/MultiEdit on those paths. Record the full outer run command in checkpoints and evidence; keep the unchanged child JSON as observed, separate from prefixed guard diagnostics. A completed expired guard-run is not a probe or a pass: retain its unused checkpoint, report not-run coverage and do not restart the deadline. Keep the 12-probe smoke limit. Required suites and explicit plan checks are outside the bounded smoke budget, not permission to reset it.\n\nFunctional evidence uses the same production helper and existing diagnostic client: \`bun ${fixture.runtime}/bin/gstack-qa-evidence capture ${fixture.cwd}/reports NNN --public --deadline ${fixture.cwd}/reports/deadline.json -- bun scripts/probe.ts [literal]\`. These diagnostic receipts are declared public/synthetic, so --public is approved; a fresh three-digit ID is required each time. Explicit plan probes outside the smoke budget may replace --deadline with --timeout-ms 10000; this does not reset or bypass the smoke deadline. After the first capture, put causal intent in the next capture itself by adding \`--after PREV --hypothesis 'causal hypothesis'\` before \`--\` (PREV = the most recent complete capture ID); the helper publishes reports/exploration-NNN.json linking capture PREV's observation to that probe before running it, so one call is both checkpoint and probe. The separate form stays valid: \`bun ${fixture.runtime}/bin/gstack-qa-evidence checkpoint ${fixture.cwd}/reports NNN CAPTURE_ID 'full prior capture command' 'causal hypothesis' 'full next capture command'\`, or Write only capture, observationCommand, hypothesis and nextCommand to reports/intent.json and run checkpoint REPORT_ROOT NNN intent.json. Quote arguments literally. Materialize is supported when evidence.json is required. Sources stay inside reports. Decide to execute the next probe before publishing its checkpoint, then await successful publication and dispatch that exact probe. If you defer an optional idea or stop exploration, do not publish a checkpoint for it; describe it as not run in Markdown. An unused checkpoint requires an actual authenticated expired-capture result; nearing the deadline or choosing to stop is not enough. A complete capture can truthfully retain a nonzero domain exit (including expected rejection or unavailable dependency); it is not automatically a pass. Wrapper-failed, interrupted or incomplete captures are not observations or passes; an authenticated expired capture can retain an unused checkpoint as not-run evidence. No new native child command or shell authority is granted.\n\nThe supported Bash interface is one literal documented native command or one exact generated workflow shell block with main substituted for <base>; even read-only commands must not be chained except for the exact DIFF_BASE preface below. Native CLI commands accept no argument or one literal argument: an unquoted shell-safe word, single-quoted text, or double-quoted text without expansion or escapes; no multiline arguments or shell composition. Inventory commands are pwd, bun --version, and ls with an optional combined -l/-a flag, optional -- separator, and literal path operands using the same quoting rules; operands beginning with - require --. Listing never permits other options, glob expansion, substitution, redirection or composition. The supported Git forms are git status --short, git status --porcelain, git branch --show-current, git rev-parse HEAD, git rev-parse --short HEAD, git merge-base origin/main HEAD, the plan-completion section's git log origin/main..HEAD --oneline, git diff (optional origin/main base and at most one output mode: --stat, --numstat, --name-only, or --name-status, before or after the base; optional literal pathspec arguments after --), git ls-files, and git ls-files --others --exclude-standard. Diff pathspecs use the same literal argument syntax as the CLI; quote globs so Git, not the shell, interprets them. The only variable-base form is DIFF_BASE=$(git merge-base origin/main HEAD) && git diff with exactly the double-quoted "$DIFF_BASE" base, the same optional output mode and literal pathspecs. That exact preface recomputes the base in the same command; other assignments and variable expansions are forbidden; the only additional command substitutions are the two installed bookkeeping fields described below. No other Git options, configuration overrides, --output, --no-index, --ext-diff, --textconv, external helpers or mutations are authorized. Exact generated workflow blocks remain allowed. Review bookkeeping permits the installed gstack-review-log start commands and single-quoted JSON records for review/adversarial-review (the installed quote-spliced double-quoted $(date -u +%Y-%m-%dT%H:%M:%SZ) is permitted only as the complete top-level timestamp value, and $(git rev-parse --short HEAD) only as the complete top-level commit value; no other substitutions, field placements or shell evaluation), gstack-review-read, gstack-specialist-stats, plus date -u +%Y-%m-%dT%H:%M:%SZ; use an original start token for a started attempt and completed:false/converged:false without a token for an unstarted one. These installed helpers are shell scripts: run them by exact installed path, never through bun or another interpreter. A review record fills this installed template, keeping its keys and adding none: \`${callerReviewRecordTemplate(fixture)}\`. A review record's status is clean only for a completed review with zero unresolved defects, otherwise issues_found${fixture.caller === 'ship' ? ' (unavailable for missing dispatched reviewer output)' : ''}; a review stopped at a gate records completed:false, never a receipt status such as blocked. Bookkeeping has an owned state directory and private Git object store; the real product, index, refs and config must stay unchanged. Outside providers are unavailable in this isolated fixture; the native reviewer is still required.${fixture.child ? ` Subagent dispatch uses a deterministic child transport instead of Agent/Task: when the workflow dispatches ${fixture.caller === 'review' ? 'the native adversarial reviewer (Step 4.8)' : 'the plan completion audit (Step 8)'}, complete its dispatch prerequisites, do not invoke Agent or Task, and Read ${fixture.child} as that child's complete final output; apply the parent's normal handling to it.` : ''} Other interpreters, shell composition outside those generated blocks or the exact DIFF_BASE preface, global setup and external operations are not authorized. Use Read/Glob/Grep for discovery instead of cat/head/tail; use native Write/Edit tools for any authorized file output. Pass these same command and write boundaries to any child; generated shell fragments remain verbatim apart from the declared substitutions.\n\nWrite the phase report to reports/review.md. Keep it compact (aim under 300 words): retain each required heading and field, link to reports/evidence.json and the checkpoints for details already recorded there, and do not restate the diff, the evidence rows or the review record. Also save reports/receipt.json with this machine-readable result shape: {\"status\":\"pass|fail|blocked|inconclusive\",\"probes\":[\"observed diagnostic receipt ids\"],\"remaining\":[\"names of incomplete contracts\"]}. The status is the overall supplied phase gate, not whether some probes passed: copy it from the verdict.status that materialize prints and writes to reports/evidence.json, and if that verdict is not pass, rerun what it lists as open before finishing when a pass is required. The probes array contains the exact id values from the captured child JSON (probe-...), never the helper's three-digit capture IDs or QA_EVIDENCE.id. Capture IDs select stored observations for checkpoint/materialize; child diagnostic IDs identify the actual probes in this final receipt. Read the child JSON's id for each probe used as evidence; do not derive it from a filename or execution counter. remaining names unresolved required contracts or gates in this phase. Pass requires no remaining required contracts or gates. Optional unavailable providers and later stages outside this excerpt are not required remainder. This format does not establish that any work succeeded. Stop at the end of this phase, or at its first unresolved approval gate.`,
    appendSystemPrompt: `Caller execution scheduling (fixture contract):
This session has at most 25 assistant turns, including required verification and final artifacts. The command boundary applies to each Bash call, not to the number of independent tool calls in an assistant turn.
After required clock and approval prerequisites settle, issue independent source Reads and read-only discovery together as separate native tool calls once their paths and inputs are known. For example, after the first clock read, one response can Read the caller excerpt, README.md, every product file and the referenced checklist and templates. Wait for their results before decisions that depend on them.
The completion reserve is for required verification, affected-input revalidation and artifacts, not an earlier deadline. Keep completing required work within the actual remaining deadline; reserve entry alone is not a reason to stop. Use each native probe's snapshot to distinguish current from superseded evidence before deciding which checks still need revalidation.
Never group diagnostic probes, checkpoint publication with its next probe (a capture carrying --after is one probe, not a group), or any action with the clock/status/approval result it needs. Shell composition remains forbidden outside the declared forms. Preserve every required Read, probe, verification, freshness check, approval and report field; the turn limit does not authorize skipping work or reporting incomplete work as passed.`,
    workingDirectory: fixture.cwd,
    timeout: CAPTURE_MS,
    completionReserveMs: CAPTURE_MS / 4,
    maxTurns: 25,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent', 'Skill', 'AskUserQuestion'],
    testName: fixture.caseId,
    runId,
    publicStreamDiagnostics: true,
    env: { CLAUDE_CONFIG_DIR: fixture.config, GSTACK_HOME: fixture.state, GSTACK_STATE_ROOT: fixture.state, GSTACK_HEADLESS: '1', GIT_OPTIONAL_LOCKS: '0', ...fixture.gitEnvironment },
  };
}

export async function runQaCaller(fixture: QaCallerFixture, runId: string, runner = runSkillTest): Promise<SkillTestResult> {
  const options = qaCallerSessionOptions(fixture, runId);
  if (!options.env?.CLAUDE_CONFIG_DIR) throw new Error('Live caller capture requires the hermetic skill runtime');
  return runner(options);
}

export function readCallerReceipt(fixture: QaCallerFixture): CallerReceipt {
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.cwd, 'reports/receipt.json'), 'utf8'));
  if (!receipt || !['pass', 'fail', 'blocked', 'inconclusive'].includes(receipt.status)
    || !Array.isArray(receipt.probes) || !receipt.probes.every((id: unknown) => typeof id === 'string')
    || !Array.isArray(receipt.remaining) || !receipt.remaining.every((name: unknown) => typeof name === 'string')) {
    throw new Error('Malformed caller receipt');
  }
  return receipt;
}

export function retainQaCallerEvidence(fixture: QaCallerFixture, dir: string, result: SkillTestResult | undefined): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) throw new Error('Evidence directory must be a real owned directory');
  fs.chmodSync(dir, 0o700);
  const handoffReads = new Set<string>();
  const publicEvents = result?.transcript.flatMap(event => {
    if (!['assistant', 'user'].includes(event.type)) return [];
    const content = (event.message?.content ?? []).filter((block: any) => ['tool_use', 'tool_result'].includes(block.type));
    for (const block of content) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Read'
        && typeof block.input?.file_path === 'string' && block.input.file_path.endsWith('/HANDOFF.md')) {
        handoffReads.add(JSON.stringify([event.parent_tool_use_id ?? null, block.id]));
      }
    }
    const handoffResult = event.type === 'user' && content.length === 1 && content[0].type === 'tool_result'
      && (handoffReads.has(JSON.stringify([event.parent_tool_use_id ?? null, content[0].tool_use_id]))
        || /\/\.qa-evidence\/\d{3}\/observation\.json$/.test(event.tool_use_result?.file?.filePath ?? ''));
    const metadata = handoffResult ? event.tool_use_result
      : typeof event.tool_use_result?.interrupted === 'boolean' ? { interrupted: event.tool_use_result.interrupted } : undefined;
    return content.length ? [{ type: event.type, parent_tool_use_id: event.parent_tool_use_id ?? null,
      session_id: event.session_id, message: { id: event.message?.id, content },
      ...(metadata ? { tool_use_result: metadata } : {}) }] : [];
  }) ?? [];
  const retain = (file: string, content: string) => {
    const destination = path.join(dir, file);
    if (fs.existsSync(destination)) throw new Error('Evidence capture must not overwrite an earlier attempt');
    fs.writeFileSync(destination, content, { mode: 0o600, flag: 'wx' });
  };
  let captures: unknown;
  let captureFailure: unknown;
  try { captures = qaCaptureArtifacts(path.join(fixture.cwd, 'reports')); }
  catch (error) { captureFailure = error; captures = { error: String(error) }; }
  for (const [file, content] of Object.entries({
    'native-events.json': JSON.stringify(publicEvents, null, 2),
    'native-probes.jsonl': fs.readFileSync(fixture.journal, 'utf8'),
    'captures.json': JSON.stringify(captures, null, 2),
    'observer.json': JSON.stringify({ observation: fixture.observation, events: fixture.mutationEvents, errors: fixture.observerErrors, lateApplied: fixture.lateApplied, snapshot: fixture.snapshot(), exitReason: result?.exitReason ?? 'capture failed' }, null, 2),
    'consumed-parent.md': fixture.instructions,
    'report.md': fs.existsSync(path.join(fixture.cwd, 'reports/review.md')) ? fs.readFileSync(path.join(fixture.cwd, 'reports/review.md'), 'utf8') : 'No report produced.\n',
    'receipt.json': fs.existsSync(path.join(fixture.cwd, 'reports/receipt.json')) ? fs.readFileSync(path.join(fixture.cwd, 'reports/receipt.json'), 'utf8') : 'null\n',
  })) {
    retain(file, content);
  }
  try {
    const deadline = path.join(fixture.cwd, 'reports/deadline.json');
    if (fs.lstatSync(deadline, { throwIfNoEntry: false })) retain('deadline.json', JSON.stringify(readQaDeadline(deadline)) + '\n');
  } catch (error) {
    retain('deadline-capture-error.txt', `Deadline capture failed: ${(error as Error).message}\n`);
  }
  let checkpoints: Record<string, string>;
  try { checkpoints = readQACheckpointFiles(path.join(fixture.cwd, 'reports')); }
  catch (error) {
    retain('checkpoint-capture-error.txt', `Checkpoint capture failed: ${(error as Error).message}\n`);
    return;
  }
  for (const [file, content] of Object.entries(checkpoints)) retain(file, content);
  if (captureFailure) throw captureFailure;
}
