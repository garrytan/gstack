/** Inspect lettered consent options, not narration that quotes an unavailable option. */
export function asideDriveOptions(text: string): string[] {
  const options: string[] = [];
  let current: string | undefined;
  for (const line of text.replaceAll('**', '').split('\n')) {
    const option = line.match(/^[ \t]*(?:[-*+][ \t]+)?[A-D][).][ \t]+(.*)$/);
    if (option) {
      if (current !== undefined) options.push(current);
      current = option[1];
    } else if (current !== undefined && /^[ \t]+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current !== undefined) {
      options.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) options.push(current);
  return options.filter(option => /\bAside\b/i.test(option) && /\b(?:drive|driving|browse|browsing|navigate|click)\b/i.test(option));
}
