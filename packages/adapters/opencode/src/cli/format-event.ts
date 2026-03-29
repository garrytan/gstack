import pc from 'picocolors';

/**
 * Format a line of stdout from the OpenCode process for display in the terminal.
 * This is used when running `paperclipai run --watch`.
 *
 * @param line - The line of stdout from the OpenCode process
 * @param debug - Whether to enable debug output (unrecognized lines are shown in gray)
 */
export function formatOpenCodeStdoutEvent(line: string, debug: boolean): void {
  // In this simple implementation, we just print the line as-is.
  // We could try to parse the line to see if it's a known OpenCode output format,
  // but for now we'll treat all lines as regular output.
  console.log(line);

  // If we wanted to do more sophisticated formatting, we could do something like:
  // if (debug) {
  //   // In debug mode, we might want to show all lines, even if we don't understand them
  //   console.log(pc.gray(line));
  // } else {
  //   // In non-debug mode, we might want to filter or style known lines
  //   // For example, if we knew that lines starting with "[INFO]" are info messages:
  //   if (line.startsWith('[INFO]')) {
  //     console.log(pc.blue(line));
  //   } else if (line.startsWith('[ERROR]')) {
  //     console.log(pc.red(line));
  //   } else {
  //     console.log(line);
  //   }
  // }
}

// Note: The CLI adapter interface expects a function named `formatStdoutEvent`.
// We'll export it with that name in the index.ts file.