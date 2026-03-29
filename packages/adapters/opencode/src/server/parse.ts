// For OpenCode adapter, we don't have complex output parsing in non-interactive mode
// The output is just the AI's response text
// We don't extract usage or session info from the output in this simple implementation

export function parseOpenCodeOutput(output: string): { 
  summary: string; 
} {
  return {
    summary: output.trim()
  };
}

// Since we don't have session management in this adapter, we don't need unknown session detection
// But we'll export the function for completeness
export function isOpenCodeUnknownSessionError(output: string): boolean {
  // OpenCode doesn't have session IDs in the same way as Claude Code
  // So we'll never have unknown session errors in this adapter
  return false;
}