import path from 'node:path';

/** Rebase recorded Unix paths without inserting raw backslashes into JSON. */
export function capturedPathRebaser(replacements: Array<[string, string]>) {
  const text = (value: string) => replacements.reduce((value, [before, after]) =>
    value.replaceAll(before, after.split(path.sep).join('/')), value);
  // Translate separators without resolving traversal, redundant separators, or
  // relative spelling that an ownership rejection control must still observe.
  const file = (value: string) => text(value).split('/').join(path.sep);
  const pathKeys = new Set(['cwd', 'config', 'stateRoot', 'file', 'file_path', 'transcriptPath']);
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value), (key, value) =>
    typeof value === 'string' ? (pathKeys.has(key) ? file(value) : text(value)) : value);
  return { text, file, json };
}
