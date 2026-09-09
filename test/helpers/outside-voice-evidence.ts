/** Inspect execution events, never prose, for completed outside-review evidence. */
export interface OutsideExecution {
  command: string;
  output: string;
  succeeded: boolean;
  background?: {
    toolUseId: string;
    taskId: string;
    outputFile: string;
    outputToolUseId?: string;
    completion: 'pending' | 'task_notification' | 'TaskOutput';
  };
}

function toolText(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
}

function sessionIdentity(event: any): string | null {
  if (event?.isSidechain === true || event?.parent_tool_use_id != null) return null;
  const id = event?.session_id ?? event?.sessionId;
  if (typeof id !== 'string' || !id || (event.sessionId && event.sessionId !== id)) return null;
  return id;
}

/** Only native task events carry completion; quoted/user-authored notifications do not. */
function taskNotification(event: any) {
  if (event?.type === 'system' && event.subtype === 'task_notification') return {
    taskId: event.task_id, toolUseId: event.tool_use_id, outputFile: event.output_file,
    status: event.status, summary: event.summary,
  };
  if (event?.type !== 'attachment' || event.attachment?.type !== 'queued_command' ||
      event.attachment.commandMode !== 'task-notification') return null;
  const text = event.attachment.prompt;
  if (typeof text !== 'string') return null;
  const match = /^<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>\s*<tool-use-id>([^<>\r\n]+)<\/tool-use-id>\s*<output-file>([^<>\r\n]+)<\/output-file>\s*<status>(completed|failed|stopped)<\/status>\s*<summary>([^<>]+)<\/summary>\s*<\/task-notification>$/.exec(text);
  return match ? { taskId: match[1], toolUseId: match[2], outputFile: match[3], status: match[4], summary: match[5] } : null;
}

/** A complete native Read starts at line one and includes the task's exit footer. */
function completedTaskRead(text: string): string | null {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const numbered = lines.map(line => /^\s*(\d+)\t(.*)$/.exec(line));
  if (!numbered.length || numbered.some((line, index) => !line || Number(line[1]) !== index + 1)) return null;
  const output = numbered.map(line => line![2]).join('\n');
  return /(?:^|\n)\[exited with code 0\]\s*$/.test(output) ? output : null;
}

export function claudeOutsideExecutions(transcript: unknown[]): OutsideExecution[] {
  const calls = new Map<string, { command?: string; name: string; input: any; session: string | null }>();
  const tasks = new Map<string, {
    command: string; session: string; taskId: string; outputFile: string; failed: boolean;
    completion?: 'task_notification' | 'TaskOutput';
    outputs: Array<{ toolUseId: string; output: string; complete: boolean }>;
  }>();
  const results: OutsideExecution[] = [];
  for (const event of transcript as any[]) {
    const notice = taskNotification(event);
    const notified = notice && tasks.get(notice.toolUseId);
    if (notified && sessionIdentity(event) === notified.session && notice.taskId === notified.taskId && notice.outputFile === notified.outputFile) {
      if (notice.status === 'failed' || notice.status === 'stopped') notified.failed = true;
      else if (notice.status === 'completed') {
        const terminal = /^Background command [\s\S]+ completed \(exit code (-?\d+)\)$/.exec(notice.summary ?? '');
        if (terminal?.[1] === '0') notified.completion = 'task_notification';
        else if (terminal) notified.failed = true;
      }
    }
    const blocks = event?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' &&
          ['Bash', 'Read', 'TaskOutput'].includes(block.name)) {
        calls.set(block.id, { command: block.input?.command, name: block.name, input: block.input, session: sessionIdentity(event) });
      }
      if (event.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id)!;
        const output = toolText(block.content);
        if (call.name === 'Bash' && typeof call.command === 'string') {
          const acknowledgment = /^Command running in background with ID: ([a-zA-Z0-9_-]+)\. Output is being written to: ([^\r\n]+)\. You will be notified when it completes\. To check interim output, use Read on that file path\.$/.exec(output);
          if (!acknowledgment) {
            const existing = tasks.get(block.tool_use_id);
            if (existing) {
              if (block.is_error === true) existing.failed = true;
              results.push({ command: existing.command, output, succeeded: false,
                background: { toolUseId: block.tool_use_id, taskId: existing.taskId,
                  outputFile: existing.outputFile, completion: 'pending' } });
              continue;
            }
            const pending = /^Command running in background\b/.test(output) || event.toolUseResult?.backgroundTaskId;
            results.push({ command: call.command, output, succeeded: block.is_error !== true && !pending });
            continue;
          }
          const [, taskId, outputFile] = acknowledgment;
          const background = { toolUseId: block.tool_use_id, taskId: taskId!, outputFile: outputFile!, completion: 'pending' as const };
          results.push({ command: call.command, output, succeeded: false, background });
          const existing = tasks.get(block.tool_use_id);
          if (block.is_error === true || !call.session || sessionIdentity(event) !== call.session ||
              !outputFile!.endsWith(`/tasks/${taskId}.output`) || !outputFile!.startsWith('/')) {
            if (existing) existing.failed = true;
            continue;
          }
          if (existing) {
            // Replayed acknowledgments cannot reset completed output or a
            // terminal failure. One original call cannot launch a second task.
            if (existing.command !== call.command || existing.session !== call.session ||
                existing.taskId !== taskId || existing.outputFile !== outputFile) existing.failed = true;
            continue;
          }
          tasks.set(block.tool_use_id, { command: call.command, session: call.session, taskId: taskId!, outputFile: outputFile!, failed: false, outputs: [] });
          continue;
        }
        if (!call.session || sessionIdentity(event) !== call.session) continue;
        for (const task of tasks.values()) {
          if (task.session !== call.session) continue;
          if (call.name === 'Read' && call.input?.file_path === task.outputFile) {
            const complete = block.is_error !== true && (call.input.offset === undefined || call.input.offset === 1)
              ? completedTaskRead(output) : null;
            task.outputs.push({ toolUseId: block.tool_use_id, output: complete ?? output, complete: complete !== null });
          }
          if (block.is_error === true) {
            if (call.name === 'TaskOutput' && call.input?.task_id === task.taskId) task.failed = true;
            continue;
          }
          if (call.name === 'TaskOutput' && call.input?.task_id === task.taskId) {
            // CLI's native TaskOutput envelope puts terminal status before the
            // output. Findings containing an exit-code string cannot supply it.
            const terminal = /^<retrieval_status>success<\/retrieval_status>\s*<task_id>([^<>]+)<\/task_id>\s*<task_type>local_bash<\/task_type>\s*<status>(completed|failed|stopped)<\/status>\s*<exit_code>(-?\d+)<\/exit_code>\s*<output>\n([\s\S]*)\n<\/output>\s*$/.exec(output);
            if (!terminal || terminal[1] !== task.taskId) continue;
            const complete = terminal[2] === 'completed' && terminal[3] === '0';
            if (!complete) task.failed = true;
            else {
              task.completion = 'TaskOutput';
            }
            task.outputs.push({ toolUseId: block.tool_use_id, output: terminal[4]!, complete });
          }
        }
      }
    }
  }
  for (const [toolUseId, task] of tasks) {
    for (const output of task.outputs) {
      results.push({ command: task.command, output: output.output,
        succeeded: output.complete && Boolean(task.completion) && !task.failed,
        background: { toolUseId, taskId: task.taskId, outputFile: task.outputFile,
          outputToolUseId: output.toolUseId, completion: task.completion ?? 'pending' } });
    }
  }
  return results;
}

export function codexOutsideExecutions(lines: string[]): OutsideExecution[] {
  return lines.flatMap(line => {
    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (event.type !== 'item.completed' || item?.type !== 'command_execution') return [];
      if (typeof item.command !== 'string' || typeof item.aggregated_output !== 'string') return [];
      return [{ command: item.command, output: item.aggregated_output, succeeded: item.exit_code === 0 }];
    } catch { return []; }
  });
}

function outsideInvocation(provider: 'codex' | 'claude-code'): RegExp {
  return provider === 'codex' ? /\bcodex\s+(?:exec|review)\b/
    : /\bgstack-claude-code(?:['"])?\s+--/;
}

/** Preserve provider results, including failures, without unrelated shell/config events. */
export function outsideExecutionTranscript(executions: OutsideExecution[], provider: 'codex' | 'claude-code') {
  return executions.filter(({ command }) => outsideInvocation(provider).test(command))
    .map(({ command, output, succeeded, background }) => ({
      type: 'outside_execution' as const, provider, command, output, succeeded,
      ...(background ? { background } : {}),
    }));
}

export function foundInvoiceAuthorizationDefect(executions: OutsideExecution[], provider: 'codex' | 'claude-code'): boolean {
  return executions.some(({ command, output, succeeded }) => succeeded
    && outsideInvocation(provider).test(command)
    && /invoice/i.test(output)
    && /owner|ownership|unauthori[sz]ed|another user|cross[- ](?:tenant|user)|access control|authorization/i.test(output)
    && !/(?:^|\n)\s*(?:I|We)\s+(?:cannot|can['’]t|won['’]t|am unable to|are unable to)\s+(?:review|perform|complete|provide|conduct|help with)\b/i.test(output)
    && !/OUTSIDE_STATUS:\s*(?:unavailable|disabled|skipped)/.test(output));
}
