import { describe, expect, test } from 'bun:test';
import { claudeOutsideExecutions, foundInvoiceAuthorizationDefect, outsideExecutionTranscript } from './helpers/outside-voice-evidence';
import { parseNDJSON } from './helpers/session-runner';
import captured from './fixtures/outside-async-task-m-events.json';

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
