/** Inspect execution events, never prose, for completed outside-review evidence. */
export interface OutsideExecution {
  command: string;
  output: string;
  succeeded: boolean;
}

export function claudeOutsideExecutions(transcript: unknown[]): OutsideExecution[] {
  const calls = new Map<string, string>();
  const results: OutsideExecution[] = [];
  for (const event of transcript as any[]) {
    const blocks = event?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') {
        const command = block.input?.command;
        if (typeof block.id === 'string' && typeof command === 'string') calls.set(block.id, command);
      }
      if (event.type === 'user' && block.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const output = typeof block.content === 'string' ? block.content
          : (Array.isArray(block.content) ? block.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '');
        results.push({ command: calls.get(block.tool_use_id)!, output, succeeded: block.is_error !== true });
      }
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

export function foundInvoiceAuthorizationDefect(executions: OutsideExecution[], provider: 'codex' | 'claude-code'): boolean {
  const invocation = provider === 'codex' ? /\bcodex\s+(?:exec|review)\b/
    : /\bgstack-claude-code(?:['"])?\s+--/;
  return executions.some(({ command, output, succeeded }) => succeeded
    && invocation.test(command)
    && /invoice/i.test(output)
    && /owner|ownership|unauthori[sz]ed|another user|cross[- ](?:tenant|user)|access control|authorization/i.test(output)
    && !/OUTSIDE_STATUS:\s*(?:unavailable|disabled|skipped)/.test(output));
}
