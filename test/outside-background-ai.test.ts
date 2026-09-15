import { describe, expect, test } from 'bun:test';
import { claudeOutsideExecutions, foundInvoiceAuthorizationDefect, outsideExecutionTranscript } from './helpers/outside-voice-evidence';
import captured from './fixtures/outside-background-ai.json';

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
