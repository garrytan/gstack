const WINDOW = 4096,
  OVERLAP = 256,
  EXCERPT = 300,
  LEAD = 100;
let pattern: RegExp | undefined;

/** Matches one file's lines in bounded windows and posts each hit as it is found, so a search stopped mid-file keeps the hits before the stop. */
self.onmessage = (event: MessageEvent) => {
  const message = event.data as { pattern?: string; text?: string };
  if (typeof message.pattern === 'string') {
    pattern = new RegExp(message.pattern);
    postMessage({ done: true });
    return;
  }
  let windowed = false;
  (message.text ?? '').split('\n').forEach((line, index) => {
    if (line.length > WINDOW) windowed = true;
    for (let start = 0; ; start += WINDOW - OVERLAP) {
      const found = pattern!.exec(line.slice(start, start + WINDOW));
      if (found) {
        const from = Math.max(0, start + found.index - LEAD);
        postMessage({ hit: { line: index + 1, text: line.slice(from, from + EXCERPT) } });
        return;
      }
      if (start + WINDOW >= line.length) return;
    }
  });
  postMessage({ done: true, windowed });
};
