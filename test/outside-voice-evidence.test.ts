import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EvalCollector } from './helpers/eval-store';
import { claudeOutsideExecutions, codexOutsideExecutions, codexReviewVerdicts, foundInvoiceAuthorizationDefect, outsideExecutionTranscript } from './helpers/outside-voice-evidence';
import captured_codex_review_unavailable from './fixtures/codex-review-sandbox-unavailable-37158847998.json';
import captured_outside_background_ai from './fixtures/outside-background-ai.json';
import { parseNDJSON } from './helpers/session-runner';
import captured_outside_voice_async from './fixtures/outside-async-task-m-events.json';

const finding = '[P1] invoice.ts removed the owner check, allowing unauthorized access to private invoices.';

describe('cross-harness live eval evidence', () => {
  test('Claude prose claiming Codex ran is not evidence', () => {
    const transcript = [{ type: 'assistant', message: { content: [{ type: 'text', text: `codex exec: ${finding}` }] } }];
    expect(foundInvoiceAuthorizationDefect(claudeOutsideExecutions(transcript), 'codex')).toBe(false);
  });
  test('Claude tool results must match the actual outside tool invocation', () => {
    const transcript = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'outside', name: 'Bash', input: { command: 'codex exec --json -' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native', content: finding }] } },
    ];
    expect(foundInvoiceAuthorizationDefect(claudeOutsideExecutions(transcript), 'codex')).toBe(false);
    transcript.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'outside', content: finding }] } } as any);
    expect(foundInvoiceAuthorizationDefect(claudeOutsideExecutions(transcript), 'codex')).toBe(true);
  });
  test('Codex requires completed, successful command execution with findings in its output', () => {
    const event = { type: 'item.completed', item: { type: 'command_execution', command: '"/runtime/bin/gstack-claude-code" --cwd /repo --access none --timeout-ms 1000', aggregated_output: finding, exit_code: 0 } };
    expect(foundInvoiceAuthorizationDefect(codexOutsideExecutions([JSON.stringify(event)]), 'claude-code')).toBe(true);
    for (const invalid of [
      { ...event, type: 'item.started' },
      { ...event, item: { ...event.item, exit_code: 124 } },
      { ...event, item: { ...event.item, aggregated_output: 'OUTSIDE_STATUS: unavailable\n' + finding } },
      { type: 'item.completed', item: { type: 'agent_message', text: finding } },
    ]) expect(foundInvoiceAuthorizationDefect(codexOutsideExecutions([JSON.stringify(invalid)]), 'claude-code')).toBe(false);
  });
});

describe('/codex review execution evidence', () => {
  const run = (command: string, output: string, isError = false) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'review', name: 'Bash', input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'review', content: output, is_error: isError }] } },
  ];
  const command = '_gstack_codex_timeout_wrapper 330 codex review --base main >"$TMPOUT" 2>"$TMPERR"\n'
    + 'bun ~/.claude/skills/gstack/lib/outside-review-result.ts --label \'Codex review\' --exit "$_CODEX_EXIT" --stderr "$TMPERR" structured "$TMPOUT"';

  test('the captured sandbox-unavailable review (recorded passed in CI) has no executed verdict', () => {
    expect(codexReviewVerdicts(claudeOutsideExecutions(captured_codex_review_unavailable.transcript))).toEqual([]);
  });

  test('only the validator verdict printed by the codex command counts', () => {
    expect(codexReviewVerdicts(claudeOutsideExecutions(run(command, `[P1] SQL injection\nVERDICT: findings\nFINDINGS: P1`, true)))).toEqual(['findings']);
    expect(codexReviewVerdicts(claudeOutsideExecutions(run(command, 'Codex outside review unavailable: sandbox\nVERDICT: unavailable', true)))).toEqual(['unavailable']);
    expect(codexReviewVerdicts(claudeOutsideExecutions(run('cat > codex-output.md <<EOF\nno `codex review` ran\nEOF', 'VERDICT: findings')))).toEqual([]);
    expect(codexReviewVerdicts(claudeOutsideExecutions(run('codex review --base main', 'VERDICT: clean')))).toEqual([]);
    expect(codexReviewVerdicts(claudeOutsideExecutions([{ type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: findings' }] } }]))).toEqual([]);
  });
});

describe('outside execution artifact retention', () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    test(`${provider} persists full successful and failed results before cleanup`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-evidence-'));
      try {
        const command = provider === 'codex' ? 'codex exec --json -'
          : '"/runtime/bin/gstack-claude-code" --cwd /repo --access none --timeout-ms 1000';
        const output = 'Review detail\n'.repeat(300) + finding;
        const failedOutput = 'OUTSIDE_STATUS: unavailable\nprovider exited before final response';
        const executions = [
          { command: 'cat /owned/auth.json /owned/config.toml', output: 'UNRELATED_CONFIG_CONTENT', succeeded: true },
          { command, output: failedOutput, succeeded: false },
          { command, output, succeeded: true, unrelated: 'UNRELATED_EVENT_FIELD' },
        ];
        const transcript = outsideExecutionTranscript(executions, provider);
        const collector = new EvalCollector('e2e', dir);
        collector.addTest({ name: `outside-${provider}`, suite: 'outside-voice', tier: 'e2e',
          passed: true, duration_ms: 1, cost_usd: 0, transcript });

        // addTest writes immediately, before disposable host homes/repositories disappear.
        const stored = fs.readFileSync(path.join(dir, '_partial-e2e.json'), 'utf8');
        const entries = JSON.parse(stored).tests[0].transcript;
        expect(entries).toEqual([
          { type: 'outside_execution', provider, command, output: failedOutput, succeeded: false },
          { type: 'outside_execution', provider, command, output, succeeded: true },
        ]);
        expect(entries[1].output.length).toBeGreaterThan(2000);
        expect(stored).not.toContain('UNRELATED_CONFIG_CONTENT');
        expect(stored).not.toContain('UNRELATED_EVENT_FIELD');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('unrelated providers and host prose never become retained outside executions', () => {
    const unrelated = [{ command: 'codex exec --json -', output: finding, succeeded: true }];
    expect(outsideExecutionTranscript(unrelated, 'claude-code')).toEqual([]);
    expect(outsideExecutionTranscript(claudeOutsideExecutions([
      { type: 'assistant', message: { content: [{ type: 'text', text: `codex exec: ${finding}` }] } },
    ]), 'codex')).toEqual([]);
  });
});

describe('outside-background-ai', () => {
const captured = captured_outside_background_ai;
const events = () => structuredClone(captured.events) as any[];
const block = (input: any[], index: number) => input[index].message.content[0];
const outputFile = /<output-file>([^<]+)<\/output-file>/.exec(captured.events[2].attachment!.prompt!)![1]!;
const finding = 'The missing invoice owner authorization check allows another user to access the invoice.';
const detected = (input: any[]) => foundInvoiceAuthorizationDefect(claudeOutsideExecutions(input), 'codex');

function rejects(mutations: Array<(input: any[]) => void>) {
  for (const mutate of mutations) {
    const input = events();
    mutate(input);
    expect(detected(input)).toBe(false);
  }
}

describe('native completed outside task read through literal Bash cat', () => {
  test('the exact five public events retain the completed Codex finding', () => {
    expect(captured.events).toHaveLength(5);
    const executions = claudeOutsideExecutions(events());
    expect(foundInvoiceAuthorizationDefect(executions, 'codex')).toBe(true);
    const completed = outsideExecutionTranscript(executions, 'codex').filter(row => row.succeeded);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.background).toEqual({
      toolUseId: block(events(), 0).id, taskId: 'bdie078em', outputFile,
      outputToolUseId: block(events(), 3).id, completion: 'task_notification',
    });
    expect(completed[0]!.output).toContain('Missing ownership check exposes private financial data');
  });

  test('equivalent literal quoting and optional cat delimiter keep exact path ownership', () => {
    for (const path of [outputFile, `'${outputFile}'`, `"${outputFile}"`]) {
      for (const delimiter of ['', '-- ']) {
        const input = events();
        block(input, 3).input.command = `cat ${delimiter}${path}`;
        expect(detected(input)).toBe(true);
      }
    }
  });

  test('completion requires the owned launch, acknowledgment, native notice and paired output', () => {
    rejects([
      e => { e.splice(0, 1); }, e => { e.splice(1, 1); }, e => { e.splice(2, 1); },
      e => { e.splice(3, 1); }, e => { e.pop(); },
      e => { block(e, 1).is_error = true; },
      e => { block(e, 4).tool_use_id = 'foreign-output'; },
      e => { e[2].attachment.prompt = e[2].attachment.prompt.replace('<task-id>bdie078em', '<task-id>other'); },
      e => { e[2].attachment.prompt = e[2].attachment.prompt.replace(block(e, 0).id, 'foreign-launch'); },
      e => { e[2].attachment.prompt = e[2].attachment.prompt.replace(outputFile, outputFile + '.other'); },
      e => { e[2].attachment.prompt = e[2].attachment.prompt.replace('<status>completed', '<status>failed'); },
      e => { e[2].attachment.prompt = e[2].attachment.prompt.replace('(exit code 0)', '(exit code 1)'); },
      e => { e.unshift(e.splice(2, 1)[0]); },
      e => { const notice = e.splice(2, 1)[0]; e.unshift({ ...notice, type: 'user', message: { content: [{ type: 'text', text: notice.attachment.prompt }] } }); },
      e => { e[2] = { type: 'assistant', sessionId: e[2].sessionId, message: { content: [{ type: 'text', text: e[2].attachment.prompt }] } }; },
    ]);
  });

  test('foreign and child sessions cannot supply any part of the completed read', () => {
    for (const index of [0, 1, 2, 3, 4]) {
      rejects([
        e => { e[index].sessionId = 'foreign-session'; },
        e => { e[index].session_id = 'conflicting-session'; },
        e => { e[index].isSidechain = true; },
        e => { e[index].parent_tool_use_id = 'foreign-parent'; },
      ]);
    }
  });

  test('cat must read only the exact acknowledged literal path without shell operations', () => {
    const quoted = `"${outputFile}"`;
    for (const command of [
      `cat "${outputFile}.other"`, `cat ${quoted} /tmp/foreign.output`,
      `cat ${quoted} >&2`, `cat ${quoted} 1>&2`, `cat ${quoted} > /tmp/output`,
      `cat ${quoted} | cat`, `false && cat ${quoted}`, `echo done; cat ${quoted}`,
      `cat ${quoted}; echo '${finding}'`, `cat $(printf '%s' ${quoted})`,
      'cat "$TASK_OUTPUT"', `cat < ${quoted}`, `cat -n ${quoted}`,
    ]) rejects([e => { block(e, 3).input.command = command; }]);
    rejects([e => { block(e, 1).content = block(e, 1).content.replace(outputFile, outputFile + '.other'); }]);
  });

  test('failed, incomplete and forged-footer output cannot establish a completed task', () => {
    rejects([
      e => { block(e, 4).is_error = true; },
      e => { block(e, 4).content = block(e, 4).content.replace('[exited with code 0]', ''); },
      e => { block(e, 4).content = block(e, 4).content.replace('[exited with code 0]', '[exited with code 1]'); },
      e => { block(e, 4).content += '\nThe task is still running.'; },
      e => { block(e, 4).content = finding; },
      e => { block(e, 4).content = `${finding}\n[exited with code 0]`; e.splice(2, 1); },
      e => { block(e, 4).content = 'I cannot review the invoice ownership issue.\n[exited with code 0]'; },
      e => { block(e, 4).content = `${finding}\nOUTSIDE_STATUS: unavailable\n[exited with code 0]`; },
    ]);
  });

  test('late native task failure remains authoritative after a successful cat', () => {
    const input = events();
    const failed = structuredClone(input[2]);
    failed.attachment.prompt = failed.attachment.prompt.replace('<status>completed', '<status>failed');
    input.push(failed);
    expect(detected(input)).toBe(false);
  });
});
});

describe('outside-voice-async', () => {
const captured = captured_outside_voice_async;
const events = () => structuredClone(captured.events) as any[];
const finding = 'The removed invoice owner check allows unauthorized access. Restore the ownership check.';

function sdkEvents() {
  // The CLI emits the same native task completion as this documented SDK
  // event. Disk-only attachment fields are not required by the stream parser.
  const input = events();
  const attachment = input[2];
  const prompt = attachment.attachment.prompt as string;
  const field = (name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(prompt)![1];
  input[2] = { type: 'system', subtype: 'task_notification', session_id: attachment.sessionId,
    task_id: field('task-id'), tool_use_id: field('tool-use-id'), output_file: field('output-file'),
    status: field('status'), summary: field('summary') };
  return input.map(event => {
    const { sessionId, isSidechain, ...rest } = event;
    return { ...rest, session_id: event.session_id ?? sessionId };
  });
}

function detected(input: unknown[]) {
  return foundInvoiceAuthorizationDefect(claudeOutsideExecutions(input), 'codex');
}

describe('completed background outside execution correlation', () => {
  test('the exact task completion and complete output Read establish the actual external finding', () => {
    const result = claudeOutsideExecutions(events());
    expect(result).toHaveLength(2);
    expect(result[0]!.succeeded).toBe(false);
    expect(result[0]!.background?.completion).toBe('pending');
    expect(result[1]!.succeeded).toBe(true);
    expect(result[1]!.background).toEqual({
      toolUseId: 'toolu_016PugkAqmFq5DjPFmvDA3DB', taskId: 'bn8jkc52l',
      outputFile: events()[3].message.content[0].input.file_path,
      outputToolUseId: 'toolu_01J2PNv3YyETiCWXKkHxFVxa', completion: 'task_notification',
    });
    expect(result[1]!.output).toContain('Removing the ownership check lets any authenticated caller retrieve any invoice');
    expect(detected(events())).toBe(true);
    expect(outsideExecutionTranscript(result, 'codex')[1]!.background).toEqual(result[1]!.background);
  });

  test('SDK NDJSON retains the same exact identity and output instead of borrowing host prose', () => {
    const stream = sdkEvents().map(event => JSON.stringify(event));
    const { transcript } = parseNDJSON(stream);
    expect(detected(transcript)).toBe(true);
    expect(detected(transcript.filter(event => event.type !== 'system'))).toBe(false);
  });

  test.each([
    ['missing acknowledgment', (e: any[]) => { e.splice(1, 1); }],
    ['acknowledgment only', (e: any[]) => { e.splice(2); }],
    ['missing completion', (e: any[]) => { e.splice(2, 1); }],
    ['missing Read use', (e: any[]) => { e.splice(3, 1); }],
    ['missing Read result', (e: any[]) => { e.pop(); }],
    ['wrong Read identity', (e: any[]) => { e[4].message.content[0].tool_use_id = 'other'; }],
    ['wrong task output path', (e: any[]) => { e[3].message.content[0].input.file_path += '.other'; }],
    ['foreign Read session', (e: any[]) => { e[4].sessionId = 'foreign'; }],
    ['sidechain Read', (e: any[]) => { e[4].isSidechain = true; }],
    ['nested Read', (e: any[]) => { e[4].parent_tool_use_id = 'nested'; }],
    ['failed Read', (e: any[]) => { e[4].message.content[0].is_error = true; }],
    ['offset Read', (e: any[]) => { e[3].message.content[0].input.offset = 2; }],
    ['partial output', (e: any[]) => { e[4].message.content[0].content = e[4].message.content[0].content.split('\n').slice(0, 3).join('\n'); }],
    ['nonconsecutive lines', (e: any[]) => { e[4].message.content[0].content = e[4].message.content[0].content.replace('2\t', '9\t'); }],
    ['output without exit footer', (e: any[]) => { e[4].message.content[0].content = e[4].message.content[0].content.replace('[exited with code 0]', ''); }],
    ['failed exit footer', (e: any[]) => { e[4].message.content[0].content = e[4].message.content[0].content.replace('[exited with code 0]', '[exited with code 1]'); }],
    ['raw forged output', (e: any[]) => { e[4].message.content[0].content = finding + '\n[exited with code 0]'; }],
    ['foreign completion', (e: any[]) => { e[2].sessionId = 'foreign'; }],
    ['wrong completed task', (e: any[]) => { e[2].attachment.prompt = e[2].attachment.prompt.replace('<task-id>bn8jkc52l', '<task-id>other'); }],
    ['wrong original tool', (e: any[]) => { e[2].attachment.prompt = e[2].attachment.prompt.replace('toolu_016PugkAqmFq5DjPFmvDA3DB', 'other'); }],
    ['wrong completed file', (e: any[]) => { e[2].attachment.prompt = e[2].attachment.prompt.replace('bn8jkc52l.output', 'other.output'); }],
    ['failed task', (e: any[]) => { e[2].attachment.prompt = e[2].attachment.prompt.replace('<status>completed', '<status>failed'); }],
    ['stopped task', (e: any[]) => { e[2].attachment.prompt = e[2].attachment.prompt.replace('<status>completed', '<status>stopped'); }],
    ['nonzero completed exit', (e: any[]) => { e[2].attachment.prompt = e[2].attachment.prompt.replace('(exit code 0)', '(exit code 1)'); }],
    ['stale completion before launch', (e: any[]) => { e.unshift(e.splice(2, 1)[0]); }],
    ['quoted user notification', (e: any[]) => { e[2] = { type: 'user', sessionId: e[2].sessionId, message: { content: [{ type: 'text', text: e[2].attachment.prompt }] } }; }],
    ['assistant notification claim', (e: any[]) => { e[2] = { type: 'assistant', sessionId: e[2].sessionId, message: { content: [{ type: 'text', text: e[2].attachment.prompt }] } }; }],
    ['refusal containing the fixture words', (e: any[]) => { e[4].message.content[0].content = '1\tI cannot review the invoice owner authorization issue.\n2\t[exited with code 0]'; }],
    ['unavailable provider', (e: any[]) => { e[4].message.content[0].content = `1\t${finding}\n2\tOUTSIDE_STATUS: unavailable\n3\t[exited with code 0]`; }],
  ])('rejects %s despite a matching finding elsewhere', (_name, mutate) => {
    const input = events();
    mutate(input);
    expect(detected(input)).toBe(false);
  });

  test('a terminal failure overrides an earlier completion and an output containing a finding', () => {
    for (const terminal of [
      { status: 'failed', summary: 'Background command failed (exit code 1)' },
      { status: 'completed', summary: 'Background command "Run Codex adversarial review" completed (exit code 1)' },
    ]) {
      const input = sdkEvents();
      input.push({ ...input[2], ...terminal });
      expect(detected(input)).toBe(false);
    }
  });

  test('replayed acknowledgments preserve task state and reject conflicting launch identities', () => {
    const original = sdkEvents();
    const failed = { ...original[2], status: 'failed', summary: 'Background command failed (exit code 1)' };
    expect(detected([
      ...original.slice(0, 3), failed, original[1], ...original.slice(2),
    ])).toBe(false);
    expect(detected([...original, original[1]])).toBe(true);

    const plain = structuredClone(original[1]);
    plain.message.content[0].content = finding;
    expect(detected([...original.slice(0, 2), plain])).toBe(false);
    const retained = claudeOutsideExecutions([...original, plain]);
    expect(retained.filter(result => result.succeeded)).toHaveLength(1);
    expect(retained.find(result => result.output === finding)?.succeeded).toBe(false);
    plain.message.content[0].is_error = true;
    plain.message.content[0].content = 'The background launch failed.';
    expect(detected([...original, plain])).toBe(false);

    for (const alter of [
      (ack: any) => { ack.message.content[0].content = ack.message.content[0].content.replaceAll('bn8jkc52l', 'other-task'); },
      (ack: any) => { ack.session_id = 'foreign'; },
      (ack: any) => { ack.message.content[0].is_error = true; },
    ]) {
      const acknowledgment = structuredClone(original[1]);
      alter(acknowledgment);
      expect(detected([...original, acknowledgment])).toBe(false);
    }
  });

  test('partial and failed exact-path Reads remain diagnostic output without earning completion', () => {
    for (const fail of [false, true]) {
      const input = events();
      input[4].message.content[0].content = finding;
      input[4].message.content[0].is_error = fail;
      const retained = outsideExecutionTranscript(claudeOutsideExecutions(input), 'codex');
      expect(retained.at(-1)!.output).toBe(finding);
      expect(retained.at(-1)!.succeeded).toBe(false);
      expect(detected(input)).toBe(false);
    }
  });

  test('an unsupported background acknowledgment cannot pass as a foreground result', () => {
    const input = events().slice(0, 2);
    input[1].message.content[0].content += '\n' + finding;
    expect(detected(input)).toBe(false);
  });

  test('TaskOutput requires the exact launched task and native completed exit-zero envelope', () => {
    const input = sdkEvents().slice(0, 2);
    const session_id = input[0].session_id;
    const result = `<retrieval_status>success</retrieval_status>\n\n<task_id>bn8jkc52l</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>completed</status>\n\n<exit_code>0</exit_code>\n\n<output>\n${finding}\n</output>`;
    input.push({ type: 'assistant', session_id, message: { content: [{ type: 'tool_use', name: 'TaskOutput', id: 'task-output', input: { task_id: 'bn8jkc52l' } }] } });
    input.push({ type: 'user', session_id, message: { content: [{ type: 'tool_result', tool_use_id: 'task-output', content: result }] } });
    expect(detected(input)).toBe(true);
    for (const content of [
      result.replace('>success<', '>not_ready<'), result.replace('>completed<', '>running<'),
      result.replace('>0<', '>1<'), result.replace('>bn8jkc52l<', '>other<'),
      result.replace('>local_bash<', '>local_agent<'), finding + result,
    ]) {
      const invalid = structuredClone(input);
      invalid[3].message.content[0].content = content;
      expect(detected(invalid)).toBe(false);
    }
    const invalid = structuredClone(input);
    invalid[3].message.content[0].is_error = true;
    expect(detected(invalid)).toBe(false);
  });
});
});
