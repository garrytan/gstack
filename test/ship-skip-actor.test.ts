import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HookCallback, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryProvider } from './helpers/agent-sdk-runner';
import type { EvalTestEntry } from './helpers/eval-store';
import { createShipSkipFixture, runShipSkipActor, shipSkipWorkflow } from './helpers/ship-skip-actor';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { DEFAULT_SHARD_TIMEOUT_MS, retriesForFiles } from '../scripts/test-paid-shards';

type Fault = 'repeat-skip' | 'silent-clear' | 'fake-probe' | 'requeue' | 'missing-skip-ack' | 'decision-forgery' | 'product-write' | 'late-source-read' | 'rate-limit'
  | 'empty-workflow' | 'truncated-workflow' | 'empty-source' | 'truncated-source' | 'offset-read' | 'limited-read'
  | 'unbound-cached-read' | 'wrong-read-metadata' | 'wrong-cache-receipt' | 'release-waiver' | 'combined-permission'
  | 'early-source-read' | 'enriched-evidence';
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

function protocol(fault?: Fault, billing?: Array<number | undefined>, controls: { annotations?: boolean; fullTextReread?: boolean } = {}) {
  let calls = 0;
  let directory = '';
  const sessions: Array<{ options: Parameters<QueryProvider>[0]['options']; root: string; closed: number }> = [];
  const provider: QueryProvider = ({ prompt, options }) => {
    calls++;
    const cwd = options!.cwd!;
    directory = cwd;
    const root = path.dirname(cwd);
    const session = { options, root, closed: 0 };
    sessions.push(session);
    const env = options!.env!;
    expect(String(prompt)).toContain(path.join(root, 'assets/workflow.md'));
    expect(env).toMatchObject({ HOME: path.join(root, 'home'), GSTACK_HOME: path.join(root, 'state'),
      GSTACK_STATE_ROOT: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') });
    expect(options!.tools).toEqual(['Read', 'Write', 'Bash', 'AskUserQuestion']);
    expect(options!.allowedTools).toEqual([]);
    expect(options!.permissionMode).toBe('default');
    expect(options!.settingSources).toEqual([]);
    const command = (action: string) => `${quote(process.execPath)} ${quote(path.resolve(import.meta.dir, 'helpers/ship-skip-actor.ts'))} --fixture ${quote(root)} ${action}`;
    let sequence = 0;
    const readFiles = new Set<string>();
    const execute = async function* (tool: string, input: Record<string, unknown>): AsyncGenerator<SDKMessage, void> {
      const id = `attempt-${calls}-tool-${++sequence}`;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } } as SDKMessage;
      const hook = options!.hooks!.PreToolUse![0].hooks[0];
      const decision = await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
        tool_use_id: id, session_id: 'scripted-free-control', transcript_path: '', cwd,
      } as Parameters<HookCallback>[0], id, { signal: new AbortController().signal });
      const output = (decision as { hookSpecificOutput: { permissionDecision: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput;
      let content = '';
      let nativeResult: unknown;
      let failed = output.permissionDecision === 'deny';
      const approved = output.updatedInput ?? input;
      if (failed) content = 'Registered fixture hook denied this interaction';
      else if (tool === 'AskUserQuestion') {
        expect(output.permissionDecision).toBe('ask');
        const normalized = { questions: (approved.questions as any[]).map(question => ({ question: question.question, header: question.header,
          options: question.options, multiSelect: question.multiSelect })) };
        const response = await options!.canUseTool!(tool, normalized, { signal: new AbortController().signal, toolUseID: id });
        failed = response.behavior !== 'allow';
        if (response.behavior === 'allow') {
          expect(Object.values(response.updatedInput!.answers as Record<string, string>)).toEqual(['Skip']);
          nativeResult = response.updatedInput;
          content = `Your questions have been answered: "${normalized.questions[0].question}"="Skip". You can now continue with these answers in mind.`;
        } else content = response.message;
        if (fault === 'missing-skip-ack') return;
      } else if (tool === 'Read') {
        const file = approved.file_path as string;
        const bytes = fs.readFileSync(file, 'utf8');
        const lines = bytes.split('\n');
        nativeResult = { type: 'text', file: { filePath: file, content: bytes, numLines: lines.length, startLine: 1, totalLines: lines.length } };
        content = lines.map((line, index) => `${index + 1}\t${line}`).join('\n');
        if (readFiles.has(file) && !controls.fullTextReread || fault === 'unbound-cached-read' && file.endsWith('/invoice.ts')) {
          nativeResult = { type: 'file_unchanged', file: { filePath: file } };
          content = fault === 'wrong-cache-receipt' ? 'Claimed unchanged without the native receipt.'
            : 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';
        }
        if (file.endsWith('/workflow.md') && fault === 'empty-workflow' || file.endsWith('/invoice.ts') && fault === 'empty-source') content = '';
        if (file.endsWith('/workflow.md') && fault === 'truncated-workflow' || file.endsWith('/invoice.ts') && fault === 'truncated-source') content = content.slice(0, 15);
        if (fault === 'wrong-read-metadata' && file.endsWith('/workflow.md')) (nativeResult as any).file.content = 'foreign content';
        readFiles.add(file);
      }
      else if (tool === 'Write') {
        fs.writeFileSync(approved.file_path as string, approved.content as string, { mode: 0o600 });
        content = 'Record written';
      } else if (tool === 'Bash') {
        expect(approved).toMatchObject({ timeout: 10000, run_in_background: false });
        const result = spawnSync('bash', ['-c', approved.command as string], { cwd, env, encoding: 'utf8', timeout: 10000 });
        failed = result.status !== 0;
        content = result.stdout + result.stderr;
      }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }] },
        ...(nativeResult ? { tool_use_result: nativeResult } : {}) } as SDKMessage;
    };
    const ask = () => execute('AskUserQuestion', { questions: [{ header: 'Invoice auth', multiSelect: false,
      question: fault === 'release-waiver' ? 'Accept the invoice authorization risk and authorize release?' : 'Fix invoice.ts authorization so only the invoice owner is accepted?',
      options: [{ label: 'Fix', description: 'Enforce the owner check.' }, { label: 'Skip', description: fault === 'combined-permission'
        ? 'Leave the source unchanged and authorize publication.' : 'Leave the source unchanged and retain the unresolved defect.' }] }] });
    return {
      close() { session.closed++; expect(fs.existsSync(root)).toBe(true); },
      async *[Symbol.asyncIterator]() {
        if (fault === 'rate-limit' && calls === 2) {
          const old = sessions[0];
          expect(old.closed).toBe(1);
          expect(old.root).not.toBe(root);
          expect(fs.existsSync(old.root)).toBe(true);
          const prior = fs.readFileSync(path.join(old.root, 'owner-answer.json'), 'utf8');
          const denied = await old.options!.canUseTool!('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 'late-old-question' });
          expect(denied).toMatchObject({ behavior: 'deny', message: 'Attempt is closed or expired' });
          const blocked = await old.options!.hooks!.PreToolUse![0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Write',
            tool_input: { file_path: path.join(old.root, 'review-record.json'), content: 'late old attempt' }, tool_use_id: 'late-old-write',
            session_id: 'scripted-free-control', transcript_path: '', cwd: old.options!.cwd!,
          }, 'late-old-write', { signal: new AbortController().signal });
          expect((blocked as any).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'Attempt is closed or expired' });
          expect(fs.existsSync(path.join(root, 'review-record.json'))).toBe(false);
          expect(fs.existsSync(path.join(root, 'owner-answer.json'))).toBe(false);
          expect(fs.readFileSync(path.join(old.root, 'owner-answer.json'), 'utf8')).toBe(prior);
        }
        yield* execute('Read', { file_path: path.join(root, 'assets/workflow.md'),
          ...(fault === 'offset-read' ? { offset: 9999 } : fault === 'limited-read' ? { limit: 1 } : {}) });
        yield* execute('Read', { file_path: path.join(root, 'assets/finding.json') });
        yield* execute('Read', { file_path: path.join(cwd, 'invoice.ts') });
        yield* execute('Bash', { command: command('read') });
        if (fault !== 'decision-forgery') yield* ask();
        if (fault === 'repeat-skip') yield* ask();
        if (fault === 'product-write') yield* execute('Write', { file_path: path.join(cwd, 'invoice.ts'), content: 'cleared' });
        if (fault === 'early-source-read') yield* execute('Read', { file_path: path.join(cwd, 'invoice.ts') });
        const input = JSON.parse(fs.readFileSync(path.join(root, 'assets/finding.json'), 'utf8'));
        const record = { skill: 'review', via: 'ship', status: fault === 'silent-clear' ? 'clean' : 'issues_found',
          issues_found: fault === 'silent-clear' ? 0 : 1, critical: fault === 'silent-clear' ? 0 : 1, informational: 0,
          completed: fault === 'fake-probe', converged: fault === 'fake-probe', cycles: 0,
          findings: fault === 'silent-clear' ? [] : [{ ...input.finding, action: 'skipped',
            ...(fault === 'enriched-evidence' ? { decision_evidence: { ...input.finding.decision_evidence, unchanged: true } } : {}),
            ...(controls.annotations ? { decision_note: 'Owner chose Skip; source unchanged; verification remains incomplete.' } : {}) }],
          ...(fault === 'fake-probe' ? { VERIFY_RESULT: 'pass', probes: [{ id: 'invented', status: 'pass' }] } : {}) };
        yield* execute('Write', { file_path: path.join(root, 'review-record.json'), content: JSON.stringify(record) });
        yield* execute('Bash', { command: command('persist') });
        if (fault === 'rate-limit' && calls === 1) {
          if (billing?.[0] !== undefined) yield { type: 'result', subtype: 'error_during_execution', num_turns: sequence,
            errors: ['rate limit'], total_cost_usd: billing[0] } as SDKMessage;
          throw Object.assign(new Error('rate limit'), { status: 429 });
        }
        yield* execute('Bash', { command: command('rediscover') });
        if (fault !== 'late-source-read' && fault !== 'early-source-read') yield* execute('Read', { file_path: path.join(cwd, 'invoice.ts') });
        yield* execute('Bash', { command: command(fault === 'requeue' ? 'repeat' : 'advance') });
        if (fault === 'late-source-read') yield* execute('Read', { file_path: path.join(cwd, 'invoice.ts') });
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Invoice authorization remains unresolved and skipped. No verification was run. Selected the queue boundary only.' }] } } as SDKMessage;
        yield { type: 'result', subtype: 'success', num_turns: sequence,
          ...(billing ? billing[calls - 1] === undefined ? {} : { total_cost_usd: billing[calls - 1] } : { total_cost_usd: 0 }) } as SDKMessage;
      },
    } as Query;
  };
  return { provider, directory: () => directory, calls: () => calls, sessions };
}

test('one bounded native case fits the whole-file wall and never retries', () => {
  const retries = retriesForFiles(['test/skill-e2e-ship-skip.test.ts']);
  expect(retries).toBe(0);
  expect(CAPTURE_MS * (retries + 1) + 120000).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);
});

test('fixture declares the exact post-rediscovery Read and canonical evidence contract before launch', () => {
  const fixture = createShipSkipFixture('Bounded interface declaration control');
  try {
    expect(fixture.prompt).toContain(`After the rediscover command's result is acknowledged, issue a new full Read with exactly ${JSON.stringify({ file_path: fixture.product })}`);
    expect(fixture.prompt).toContain('Receive its actual tool result before issuing either routing command (advance or repeat), even when the result is file_unchanged');
    expect(fixture.prompt).toContain('A Read before rediscovery or a prose claim of unchanged source does not satisfy this step.');
    expect(fixture.prompt).toContain(`Copy the canonical decision_evidence object from ${fixture.inputPath} unchanged, with exactly its path and sha256 fields and values; put any annotations outside decision_evidence.`);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const fullTextReread of [false, true]) test(`declared Skip interface accepts ${fullTextReread ? 'full text' : 'native unchanged receipt'} and annotations outside canonical evidence`, async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  try {
    const file = await runShipSkipActor(() => {}, protocol(undefined, undefined, { annotations: true, fullTextReread }).provider, artifacts);
    const retained = JSON.parse(fs.readFileSync(file, 'utf8'));
    const finding = retained.evidence.persisted.findings[0];
    expect(finding.decision_evidence).toEqual(retained.evidence.input.finding.decision_evidence);
    expect(Object.keys(finding.decision_evidence).sort()).toEqual(['path', 'sha256']);
    expect(finding.decision_note).toBe('Owner chose Skip; source unchanged; verification remains incomplete.');
    expect(retained.evidence.product).toBe(retained.evidence.originalProduct);
    const events = retained.attempts[0].events;
    const results = events.flatMap((event: any, index: number) => event.type === 'user'
      ? event.message.content.filter((block: any) => block.type === 'tool_result').map((block: any) => ({ index, id: block.tool_use_id, native: event.tool_use_result })) : []);
    const calls = events.flatMap((event: any) => event.type === 'assistant'
      ? event.message.content.filter((block: any) => block.type === 'tool_use') : []);
    const rediscover = calls.find((call: any) => call.name === 'Bash' && call.input.command.endsWith(' rediscover'));
    const advance = calls.find((call: any) => call.name === 'Bash' && call.input.command.endsWith(' advance'));
    const sourceReads = calls.filter((call: any) => call.name === 'Read' && call.input.file_path.endsWith('/invoice.ts'));
    expect(sourceReads).toHaveLength(2);
    expect(sourceReads[1].input).toEqual({ file_path: sourceReads[0].input.file_path });
    const acknowledgment = results.find((result: any) => result.id === sourceReads[1].id);
    expect(acknowledgment.native.type).toBe(fullTextReread ? 'text' : 'file_unchanged');
    expect(acknowledgment.index).toBeGreaterThan(results.find((result: any) => result.id === rediscover.id).index);
    expect(acknowledgment.index).toBeLessThan(events.findIndex((event: any) => event.type === 'assistant'
      && event.message.content.some((block: any) => block.type === 'tool_use' && block.id === advance.id)));
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

test('registered native callback, real logger and routing adapter retain a bound Skip after cleanup', async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  const records: EvalTestEntry[] = [];
  const driver = protocol();
  try {
    const file = await runShipSkipActor(entry => records.push(entry), driver.provider, artifacts);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: true, cost_usd: 0, name: 'ship-skipped-queued-finding' });
    const retained = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(retained).toEqual(JSON.parse(records[0].output!));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
    expect(retained.evidence.answers).toHaveLength(1);
    expect(retained.evidence.answers[0].answers).toEqual({ 'Fix invoice.ts authorization so only the invoice owner is accepted?': 'Skip' });
    expect(retained.evidence.persisted.review_binding.state).toBe('incomplete');
    expect(retained.evidence.persisted.review_binding.start_wtree).toBe(retained.evidence.start.wtree);
    expect(retained.evidence.persisted.review_binding.end_wtree).toBe(retained.evidence.start.wtree);
    expect(retained.evidence.persisted.completed).toBe(false);
    expect(retained.evidence.product).toBe(retained.evidence.originalProduct);
    expect(retained.evidence.receipts.map((row: any) => row.action)).toEqual(['read', 'persist', 'rediscover', 'advance']);
    expect(retained.workflow).toContain('Only unmatched or reopened findings remain queued');
    expect(retained.attempts[0].events.filter((event: any) => event.type === 'user').length).toBeGreaterThan(0);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

for (const [fault, message] of [
  ['repeat-skip', 'undeclared or repeated interaction'],
  ['silent-clear', 'skipped defect was silently cleared'],
  ['fake-probe', 'synthetic coverage was marked complete'],
  ['requeue', 'without requeue'],
  ['missing-skip-ack', 'native Skip response was not acknowledged'],
  ['decision-forgery', 'expected exactly one captured owner Skip'],
  ['product-write', 'undeclared or repeated interaction'],
  ['late-source-read', 'source not re-read before routing'],
  ['early-source-read', 'source not re-read before routing'],
  ['enriched-evidence', 'persisted Skip lost its identity or source evidence'],
  ['empty-workflow', 'complete workflow was not delivered'],
  ['truncated-workflow', 'complete workflow was not delivered'],
  ['empty-source', 'owner decision lacks complete source'],
  ['truncated-source', 'owner decision lacks complete source'],
  ['offset-read', 'complete workflow was not delivered'],
  ['limited-read', 'complete workflow was not delivered'],
  ['unbound-cached-read', 'owner decision lacks complete source'],
  ['wrong-read-metadata', 'complete workflow was not delivered'],
  ['wrong-cache-receipt', 'source not re-read before routing'],
  ['release-waiver', 'expected exactly one captured owner Skip'],
  ['combined-permission', 'expected exactly one captured owner Skip'],
] as const) test(`scripted negative control rejects ${fault}`, async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  const records: EvalTestEntry[] = [];
  const driver = protocol(fault);
  try {
    await expect(runShipSkipActor(entry => records.push(entry), driver.provider, artifacts)).rejects.toThrow(message);
    expect(records).toHaveLength(1);
    expect(records[0].passed).toBe(false);
    const retained = JSON.parse(fs.readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0]), 'utf8'));
    expect(retained.error).toContain(message);
    if (fault === 'release-waiver' || fault === 'combined-permission') expect(retained.evidence.answers).toHaveLength(0);
    expect(retained.attempts.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

test('rate-limit retry resets owned decisions and logs while preserving both attempts', async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  const driver = protocol('rate-limit');
  try {
    const file = await runShipSkipActor(() => {}, driver.provider, artifacts);
    const retained = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(driver.calls()).toBe(2);
    expect(retained.attempts).toHaveLength(2);
    expect(new Set(retained.attempts.map((attempt: any) => attempt.evidence.repo)).size).toBe(2);
    expect(retained.attempts[0].lateCallbacks).toEqual(['AskUserQuestion', 'PreToolUse']);
    expect(retained.roots.every((root: string) => !fs.existsSync(root))).toBe(true);
    expect(driver.sessions.map(session => session.closed)).toEqual([1, 1]);
    for (const attempt of retained.attempts) {
      expect(attempt).toMatchObject({ active: false, closed: true, drained: true });
      expect(attempt.evidence.answers).toHaveLength(1);
      expect(attempt.evidence.receipts.filter((row: any) => row.action === 'persist')).toHaveLength(1);
    }
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

test('stream closure rejects late callbacks and retains its root until iterator drain', async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  const driver = protocol();
  let drained = false;
  const provider: QueryProvider = args => {
    const stream = driver.provider(args);
    return new Proxy(stream, { get(target, property) {
      if (property === Symbol.asyncIterator) return () => {
        const iterator = target[Symbol.asyncIterator]();
        return { next: (...values: any[]) => iterator.next(...values), async return() {
          expect(driver.sessions[0].closed).toBe(1);
          const root = path.dirname(args.options!.cwd!);
          expect(fs.existsSync(root)).toBe(true);
          await new Promise(resolve => setTimeout(resolve, 25));
          const answer = await args.options!.canUseTool!('AskUserQuestion', {}, { toolUseID: 'during-drain', signal: new AbortController().signal });
          expect(answer).toMatchObject({ behavior: 'deny', message: 'Attempt is closed or expired' });
          expect(fs.existsSync(root)).toBe(true);
          const result = await iterator.return?.();
          drained = true;
          return result ?? { done: true, value: undefined };
        } };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    const file = await runShipSkipActor(() => {}, provider, artifacts);
    expect(drained).toBe(true);
    const retained = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(retained.attempts[0]).toMatchObject({ closed: true, drained: true, lateCallbacks: ['AskUserQuestion'] });
    expect(retained.retainedRoots).toEqual([]);
    expect(fs.existsSync(driver.sessions[0].root)).toBe(false);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

for (const [label, costs, expected, known] of [
  ['known retry sums', [0.125, 0.25], 0.375, true],
  ['missing retry billing', [undefined, 0.25], 0.25, false],
  ['all billing missing', [undefined, undefined], 0, false],
] as const) test(`billing reports ${label} without inventing missing charges`, async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  const entries: EvalTestEntry[] = [];
  try {
    const file = await runShipSkipActor(entry => entries.push(entry), protocol('rate-limit', [...costs]).provider, artifacts);
    const captured = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(entries[0].cost_usd).toBe(expected);
    expect(captured.billing).toMatchObject({ knownCostUsd: expected, costKnown: known, status: known ? 'complete' : 'incomplete' });
    expect(captured.billing.attempts.map((attempt: any) => attempt.costUsd)).toEqual(costs.map(cost => cost ?? null));
    expect(entries[0].transcript!.filter(event => event.type === 'result')).toHaveLength(costs[0] === undefined ? 1 : 2);
    if (!known) expect(entries[0].error).toContain('actual total cost is unknown');
    expect(entries[0].passed).toBe(true);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

test.each(['empty', 'foreign-config'])('ship fixture seeds real commits with %s identity-free HOME', mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-ident-'));
  try {
    const home = path.join(root, 'home');
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(home);
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const config = path.join(home, '.gitconfig');
    fs.writeFileSync(config, mode === 'empty' ? '' : `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
    const worker = path.join(root, 'worker.ts');
    fs.writeFileSync(worker, `
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createShipSkipFixture } from ${JSON.stringify(path.join(import.meta.dir, 'helpers/ship-skip-actor.ts'))};
const fixture = createShipSkipFixture('identity-only setup control', ${JSON.stringify(path.join(root, 'fixture'))});
const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: fixture.repo, env: fixture.env, encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
console.log(JSON.stringify({
  commits: git('rev-list', '--count', 'HEAD'),
  branch: git('branch', '--show-current'),
  top: git('rev-parse', '--show-toplevel'),
  config: fs.readFileSync(fixture.repo + '/.git/config', 'utf8'),
  authors: git('log', '--format=%an <%ae>'),
  source: fs.readFileSync(fixture.repo + '/invoice.ts', 'utf8'),
}));
`);
    const result = spawnSync(process.execPath, [worker], {
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' },
      encoding: 'utf8', timeout: 20000,
    });
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence.commits).toBe('2');
    expect(evidence.branch).toBe('fixture/queued-finding');
    expect(evidence.top).toBe(fs.realpathSync(path.join(root, 'fixture/project')));
    expect(evidence.authors.split('\n')).toHaveLength(2);
    expect(evidence.authors).toMatch(/\S+ <[^<>\s]+>/);
    expect(evidence.config).not.toMatch(/include|hooksPath|remote|credential/i);
    expect(evidence.source).toContain('=> true;');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Git routing variables fail before any Git invocation or foreign state write', () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
  const worker = path.join(artifacts, 'git-routing.ts');
  fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createShipSkipFixture } from ${JSON.stringify(path.resolve(import.meta.dir, 'helpers/ship-skip-actor.ts'))};
const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
for (const key of keys) delete process.env[key];
const root = ${JSON.stringify(artifacts)};
const foreign = path.join(root, 'foreign');
const initialized = spawnSync('git', ['init', '-q', foreign], { env: process.env, encoding: 'utf8', timeout: 10000 });
if (initialized.status !== 0) throw new Error(initialized.stderr);
fs.writeFileSync(path.join(foreign, 'sentinel'), 'foreign worktree must not change');
const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
const calls = path.join(root, 'git-calls');
fs.writeFileSync(path.join(bin, 'git'), ${JSON.stringify(`#!/bin/sh\nprintf called >> ${quote(path.join(artifacts, 'git-calls'))}\nexec ${quote(Bun.which('git')!)} "$@"\n`)}, { mode: 0o755 });
process.env.PATH = bin + ':' + process.env.PATH;
const snapshot = () => fs.readdirSync(foreign, { recursive: true }).map(file => String(file)).sort().map(file => {
 const full = path.join(foreign, file), stat = fs.lstatSync(full);
 return [file, stat.mode, stat.isFile() ? fs.readFileSync(full).toString('hex') : null];
});
const before = JSON.stringify(snapshot());
const destinations = [path.join(foreign, '.git'), foreign, path.join(foreign, '.git'), path.join(foreign, '.git/index'), path.join(foreign, '.git/objects'), path.join(foreign, '.git/objects')];
const results = [];
for (const [index, key] of keys.entries()) {
 process.env[key] = destinations[index];
 let error;
 try { createShipSkipFixture('routing control', path.join(root, 'fixture-' + index)); } catch (caught) { error = String(caught); }
 delete process.env[key];
 results.push({ key, error, gitCalled: fs.existsSync(calls), foreignUnchanged: JSON.stringify(snapshot()) === before });
}
console.log(JSON.stringify(results));
`);
  try {
    const result = spawnSync(process.execPath, [worker], { encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    fs.writeFileSync(path.join(artifacts, 'git-routing.json'), JSON.stringify(evidence), { mode: 0o600 });
    expect(evidence).toHaveLength(6);
    for (const row of evidence) {
      expect(row.error).toContain(`Refusing ambient Git routing: ${row.key}`);
      expect(row.gitCalled).toBe(false);
      expect(row.foreignUnchanged).toBe(true);
    }
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});

for (const kind of ['generation-error', 'fixture-error', 'generation-exhausted', 'fixture-exhausted'] as const) {
  test(`case-entry deadline records and cleans ${kind} without launching a query`, () => {
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sskip-art-'));
    const worker = path.join(artifacts, 'worker.ts');
    fs.writeFileSync(worker, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'bun:test';
const directory = ${JSON.stringify(artifacts)};
process.env.TMPDIR = directory;
const kind = ${JSON.stringify(kind)};
const realNow = Date.now;
let elapsed = 0;
Date.now = () => realNow() + elapsed;
const generatorPath = ${JSON.stringify(path.resolve(import.meta.dir, '../scripts/gen-skill-docs.ts'))};
const generator = await import(generatorPath);
const generate = generator.runGeneration;
mock.module(generatorPath, () => ({ ...generator, runGeneration: async (...args: any[]) => {
  if (kind === 'generation-error') throw new Error('Injected generation error');
  const result = await generate(...args);
  if (kind === 'generation-exhausted') elapsed = ${CAPTURE_MS};
  return result;
} }));
mock.module('node:fs', () => ({ ...fs, default: fs, writeFileSync: (file: any, ...args: any[]) => {
  if (String(file).endsWith('/invoice.ts')) {
    if (kind === 'fixture-error') throw new Error('Injected fixture error');
    if (kind === 'fixture-exhausted') elapsed = ${CAPTURE_MS};
  }
  return fs.writeFileSync(file, ...args);
} }));
const { runShipSkipActor } = await import(${JSON.stringify(path.resolve(import.meta.dir, 'helpers/ship-skip-actor.ts'))});
const records: any[] = [];
let queries = 0, error;
try { await runShipSkipActor((entry: any) => records.push(entry), () => { queries++; throw new Error('Unexpected query launch'); }, directory); }
catch (caught) { error = String(caught); }
const saved = fs.readdirSync(directory).find(file => file.startsWith('ship-skipped-queued-finding-'));
const payload = saved ? JSON.parse(fs.readFileSync(path.join(directory, saved), 'utf8')) : null;
console.log(JSON.stringify({ error, queries, records: records.map(record => ({ passed: record.passed, error: record.error })), payload,
  leftovers: fs.readdirSync(directory).filter(file => file.startsWith('sskip-')),
  rootsGone: payload?.roots?.every((root: string) => !fs.existsSync(root)) ?? false }));
`);
    try {
      const result = spawnSync(process.execPath, [worker], { encoding: 'utf8', timeout: 20000 });
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout.trim());
      fs.writeFileSync(path.join(artifacts, `setup-${kind}.json`), JSON.stringify(evidence), { mode: 0o600 });
      expect(evidence.queries).toBe(0);
      expect(evidence.records).toHaveLength(1);
      expect(evidence.records[0].passed).toBe(false);
      expect(evidence.error).toContain(kind.endsWith('exhausted') ? 'deadline exhausted' : `Injected ${kind.split('-')[0]} error`);
      expect(evidence.payload.deadline - evidence.payload.started).toBe(CAPTURE_MS - 20000);
      expect(evidence.leftovers).toEqual([]);
      expect(evidence.rootsGone).toBe(true);
      expect(evidence.payload.roots.length).toBe(kind.startsWith('fixture') ? 1 : 0);
    } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
  });
}

test('fixture ships actual generated decision sections and isolates all model writes', async () => {
  const workflow = await shipSkipWorkflow();
  const fixture = createShipSkipFixture(workflow);
  try {
    expect(fs.readFileSync(fixture.workflowPath, 'utf8')).toBe(workflow);
    for (const marker of ['### Step 9.3:', '## Step 9.4:', '### Finish the adversarial phase', 'gstack-review-log', '--finish REVIEW_START']) expect(workflow).toContain(marker);
    expect(workflow).not.toContain('### Decide whether to repeat Step 9');
    expect(workflow).not.toContain('### Refresh learnings');
    expect(fixture.prompt).toContain('earlier reviewers and the rediscovery are explicitly synthetic fixture inputs');
    expect(fixture.prompt).toContain('persist completed:false and converged:false');
    expect(fixture.prompt).toContain('No product writes, direct receipt/config access');
    expect(fs.realpathSync(fixture.product).startsWith(fs.realpathSync(fixture.root) + path.sep)).toBe(true);
    expect(fs.statSync(fixture.product).mode & 0o777).toBe(0o644);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
