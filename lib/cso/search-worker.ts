const WINDOW = 4096,
  OVERLAP = 256,
  EXCERPT = 300,
  LEAD = 100;
let pattern: RegExp | undefined;

/** Matches one file's lines in bounded windows, so a long line costs at most one window's backtracking per step. */
self.onmessage = (event: MessageEvent) => {
  const message = event.data as { pattern?: string; text?: string };
  if (typeof message.pattern === 'string') {
    pattern = new RegExp(message.pattern);
    postMessage({ ready: true });
    return;
  }
  const hits: Array<{ line: number; text: string }> = [];
  (message.text ?? '').split('\n').forEach((line, index) => {
    for (let start = 0; ; start += WINDOW - OVERLAP) {
      const found = pattern!.exec(line.slice(start, start + WINDOW));
      if (found) {
        const from = Math.max(0, start + found.index - LEAD);
        hits.push({ line: index + 1, text: line.slice(from, from + EXCERPT) });
        return;
      }
      if (start + WINDOW >= line.length) return;
    }
  });
  postMessage({ hits });
};
