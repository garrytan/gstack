/**
 * agent-notes — the collapsed section at the end of a PR body that holds every line gstack's tools read
 * (R76: the front of a body is for people, the end is for machines). The section is the marker line, then
 * `<details><summary>Agent notes</summary>`, a blank line, the content, a blank line and `</details>`; there is one,
 * at the very end of the body (a Capy badge a bot appends may follow it). It carries the ship receipt and its runs
 * block, the Approvals table and Plan line, issue and Refs lines, ruled notes and the exception lines /ship writes, so
 * the readable part above it opens with plain sentences.
 *
 * The marker counts only on a line of its own outside a code fence, so a body that quotes it in an example never
 * opens a section; the last such line wins. `</details>` closes the section only on its own line outside a fence, so a
 * receipt block inside the notes cannot end it early. A body with no marker has no section (`notes: null`): readers
 * then read the whole body, which keeps PRs posted before this section existed working.
 */
export const AGENT_NOTES_MARKER = '<!-- gstack:agent-notes -->';
export const AGENT_NOTES_OPEN = '<details><summary>Agent notes</summary>';
const CLOSE = '</details>';
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const fenceCloses = (fence: string, line: string) => new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line);

interface Parsed { readable: string; notes: string | null; after: string }

/** Line indexes of `wanted` lines outside code fences, from `from` on. */
function linesOutsideFences(lines: string[], from: number, wanted: string): number[] {
  const hits: number[] = [];
  let fence: string | null = null;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r?\n$/, '');
    if (fence !== null) { if (fenceCloses(fence, line)) fence = null; continue; }
    const open = FENCE_OPEN.exec(line);
    if (open) { fence = open[1]!; continue; }
    if (line.trim() === wanted) hits.push(i);
  }
  return hits;
}

/**
 * The section's lines in a body split after each newline: the marker line, the line after the wrapper's opener, and
 * the closing `</details>` line (`lines.length` when it never closes); null when the body has no section.
 */
export function agentNotesLines(lines: string[]): { marker: number; start: number; close: number } | null {
  const marker = linesOutsideFences(lines, 0, AGENT_NOTES_MARKER).at(-1);
  if (marker === undefined) return null;
  let start = marker + 1;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (start < lines.length && /^<details\b[^>]*>\s*(?:<summary>[^<]*<\/summary>)?$/i.test(lines[start]!.trim())) {
    start++;
    if (start < lines.length && /^<summary>[^<]*<\/summary>$/i.test(lines[start]!.trim())) start++;
  }
  return { marker, start, close: wrapperClose(lines, start) };
}

/**
 * The `</details>` line that closes the wrapper: the first one outside fences with every `<details>` opened inside the
 * notes closed, or, when a `<details>` in the notes never closes, the first `</details>` line outside fences.
 */
function wrapperClose(lines: string[], from: number): number {
  let depth = 0;
  let first = -1;
  let fence: string | null = null;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r?\n$/, '');
    if (fence !== null) { if (fenceCloses(fence, line)) fence = null; continue; }
    const open = FENCE_OPEN.exec(line);
    if (open) { fence = open[1]!; continue; }
    if (line.trim() === CLOSE && depth === 0) return i;
    if (line.trim() === CLOSE && first < 0) first = i;
    const prose = line.replace(/`[^`]*`/g, '');
    depth = Math.max(0, depth + (prose.match(/<details\b/gi)?.length ?? 0) - (prose.match(/<\/details>/gi)?.length ?? 0));
  }
  return first >= 0 ? first : lines.length;
}

/** The body around its section: the text above the marker, the content inside the wrapper, and any text after `</details>`. */
function parse(body: string): Parsed {
  const lines = body.split(/(?<=\n)/);
  const at = agentNotesLines(lines);
  if (!at) return { readable: body, notes: null, after: '' };
  const { marker, start, close: end } = at;
  return {
    readable: lines.slice(0, marker).join(''),
    notes: lines.slice(start, end).join('').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, ''),
    after: lines.slice(end + 1).join(''),
  };
}

/** The text above the Agent notes marker, and the section's content (`null` when the body has no section). */
export function splitAgentNotes(body: string): { readable: string; notes: string | null } {
  const { readable, notes } = parse(body);
  return { readable, notes };
}

/** What machine readers parse: the section's content when the body has one, else the whole body (a legacy body). */
export function agentNotesOrBody(body: string): string {
  return parse(body).notes ?? body;
}

/** The section for `content`: the marker, the collapsed wrapper, and the content between blank lines. */
export function renderAgentNotes(content: string): string {
  return `${AGENT_NOTES_MARKER}\n${AGENT_NOTES_OPEN}\n\n${content.trim()}\n\n${CLOSE}\n`;
}

/** `body` with its section's content replaced by `content` (the section appended when the body has none); text after `</details>` stays after it. */
export function withAgentNotes(body: string, content: string): string {
  const { readable, after } = parse(body);
  const lead = readable.replace(/\s+$/, '');
  const tail = after.replace(/^\s+/, '');
  return (lead ? `${lead}\n\n` : '') + renderAgentNotes(content) + (tail ? `\n${tail}` : '');
}
