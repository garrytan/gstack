/**
 * Free text never enters a shell command (CEO-12).
 *
 *   {{FREE_TEXT_FILE:BODY_FILE=body}}            → bash that creates one private
 *   {{FREE_TEXT_FILE:TITLE_FILE=title:BODY_FILE=body}}  mktemp file per variable,
 *                                                  plus the write rule.
 *
 * Bodies, titles, messages, briefs, prompts, error output and reviewer or diff
 * text go into a `mktemp` file that the agent writes with its own file-write
 * tool; the next block passes the file (`--body-file`, `-F body=@file`,
 * `"$(cat "$FILE")"`). There is no heredoc fallback: a host that cannot write
 * the file leaves the post unsent and says so.
 *
 * Location (ENG-14, probed against the pinned Claude Code 2.1.284): the
 * project's own `.gstack/tmp/`, kept out of git through `.git/info/exclude`.
 * Claude Code's Write tool writes there under acceptEdits without a prompt and
 * keeps mktemp's 0600 mode; `$TMPDIR` and the gstack state root are outside
 * the project, so even acceptEdits asks for them and headless sessions are
 * refused. In default mode every Write asks once, wherever the file lives.
 */
import type { TemplateContext } from './types';

export const FREE_TEXT_DIR = '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"';

export interface FreeTextFile { variable: string; stem: string }

function parse(args: string[] | undefined): FreeTextFile[] {
  const files = (args ?? []).map(a => {
    const [variable, stem] = a.split('=');
    return { variable, stem: stem || 'text' };
  }).filter(f => /^[A-Z_][A-Z0-9_]*$/.test(f.variable));
  return files.length ? files : [{ variable: 'TEXT_FILE', stem: 'text' }];
}

/** Bash lines that create the private files and print each path and basename. */
export function freeTextFileBash(files: FreeTextFile[]): string {
  return [
    `_GT=${FREE_TEXT_DIR}`,
    'mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }',
    `_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }`,
    ...files.map(f => `${f.variable}=$(mktemp "$_GT/${f.stem}.XXXXXX") && echo "${f.variable}: $${f.variable} (name: \${${f.variable}##*/})"`),
  ].join('\n');
}

export const FREE_TEXT_WRITE_RULE = 'Write the text into each printed file with your file-write tool (Claude Code\'s Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand.';

/**
 * First lines of a later block: rebuild each path from the printed basename
 * (`placeholder`) and refuse, with the manual command, when a write never
 * happened. `manual` is echoed inside double quotes: escape `"` and `$(`.
 */
export function freeTextFileUse(files: Array<{ variable: string; placeholder: string }>, manual: string): string {
  return [
    ...files.map(f => `${f.variable}=${FREE_TEXT_DIR.slice(0, -1)}/${f.placeholder}"`),
    `${files.map(f => `[ -s "$${f.variable}" ]`).join(' && ')} || { echo "Not sent: ${files.map(f => `$${f.variable}`).join(' or ')} is missing or empty, so the text was never written. Write it, then send by hand: ${manual}" >&2; exit 1; }`,
  ].join('\n');
}

export function generateFreeTextFile(_ctx: TemplateContext, args?: string[]): string {
  return `\`\`\`bash\n${freeTextFileBash(parse(args))}\n\`\`\`\n\n${FREE_TEXT_WRITE_RULE}`;
}
