// For OpenCode adapter, we're primarily using non-interactive mode
// which doesn't produce the kind of streaming output that needs line-by-line parsing
// for the transcript viewer. However, we still need to implement this interface.

import type { TranscriptEntry } from '@paperclipai/adapter-utils';

// In non-interactive mode, OpenCode outputs the response directly
// We'll treat the entire output as a single assistant message
export function parseOpenCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // For simplicity, we'll return each line as a stdout entry
  // In a more sophisticated implementation, we might buffer lines and
  // detect when we have a complete response
  return [{
    kind: 'stdout',
    ts,
    text: line
  }];
}