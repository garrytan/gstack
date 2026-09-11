import type { PlanCountTranscript } from './plan-count-transcript';

export interface AutoplanPhaseHit {
  phase: number;
  ts: number;
}

function phaseDeclaration(text: string): RegExpExecArray | null {
  const declaration = String.raw`Phase[ \t]+(1|2(?:\.5)?|3)(?:[ \t]+\(([^()]*)\))?[ \t]+(?:is[ \t]+)?(?:complete(?:d)?|done|finished|wrapped[ \t]+up)`;
  const plain = text.replace(new RegExp(String.raw`^\*\*(${declaration}[.:]?)\*\*`, 'i'), '$1');
  if (/\bEmit\s+phase-transition\s+summary\s*:/i.test(plain)) return null;
  let match = new RegExp(String.raw`^${declaration}(?:[.:](?:[ \t]+.*)?|)$`, 'i').exec(plain);
  if (!match) {
    // A dash or "with" can introduce the results of an actual completion.
    // Keep the recap affirmative; source, future and withdrawn claims cannot
    // supply the missing phase declaration.
    const recap = new RegExp(String.raw`^${declaration}(?:[ \t]*[—–][ \t]*|[ \t]+(?<withResult>with)[ \t]+)(.+)$`, 'i').exec(plain);
    const tail = recap?.[4]?.trim();
    if (tail && !/^["“'‘>]|\?|\b(?:if|unless|when|once|pending|maybe|perhaps|would|could|will|source|example|sample|quote(?:d)?|historical|earlier|previous(?:ly)?|template|not|no|never|superseded|provided|rejected|incomplete|unfinished|withdrawn|retracted|cancelled|canceled)\b/i.test(tail)) match = recap;
    if (match?.groups?.withResult && /\bhypothetic(?:al|ally)\b/i.test(tail!)) match = null;
  }
  // Optional phase names are metadata, and must agree with the phase number.
  const names: Record<string, RegExp> = {
    '1': /^CEO(?:[ \t]+review)?$/i,
    '2': /^design(?:[ \t]+review)?$/i,
    '2.5': /^DX(?:[ \t]+review)?$/i,
    '3': /^eng(?:ineering)?(?:[ \t]+review)?$/i,
  };
  if (match?.[2] !== undefined && !names[match[1]!]!.test(match[2])) return null;
  return match;
}

/** An explicit current withdrawal in the same announcement cancels a new with-result claim. */
function withResultWithdrawn(lines: string[], index: number, phase: string): boolean {
  let source = false;
  let fence: {char: string; length: number} | undefined;
  const owner = new RegExp(String.raw`^(?:(?:correction|current status)[ \t]*:[ \t]*)?(?:this[ \t]+(?:phase|completion|declaration|announcement)|Phase[ \t]+${phase.replace('.', '\\.')})(?:[ \t]+(?:completion|declaration|status))?[ \t]*(?:(?:is|was|has been)[ \t]+|:[ \t]*)(.+)$`, 'i');
  for (const line of lines.slice(index + 1)) {
    if (/^(?: {4}|\t)/.test(line)) continue;
    const text = line.trim().replace(/\*\*/g, '');
    const delimiter = /^(`{3,}|~{3,})/.exec(text)?.[1];
    if (delimiter) {
      if (!fence) fence = {char: delimiter[0]!, length: delimiter.length};
      else if (delimiter[0] === fence.char && delimiter.length >= fence.length && !text.slice(delimiter.length).trim()) fence = undefined;
      continue;
    }
    if (fence || /^[>"“'‘]/.test(text)) continue;
    if (/\b(?:example|sample|quote(?:d)?|source|historical|earlier|previous|archived|template)\b.*[:：]\s*$/i.test(text)) { source = true; continue; }
    if (/^(?:current (?:status|review|phase)|correction)\b/i.test(text.replace(/^#{1,6}[ \t]+/, ''))) source = false;
    if (source) continue;
    if (phaseDeclaration(text)) break;
    const status = owner.exec(text)?.[1]?.replace(/["“”'‘’`]/g, '');
    if (status && /^(?:withdrawn|retracted|cancelled|canceled|superseded|rejected|incomplete|unfinished|not (?:complete(?:d)?|current)|no longer (?:complete(?:d)?|current))\b/i.test(status)) return true;
  }
  return false;
}

/**
 * Observe actual assistant announcements from this fixture's native transcript.
 * The terminal renders Markdown bold as ANSI, and its Read output can contain
 * the same source markers. Neither rendered styling nor tool output is evidence
 * that a phase completed. Native timestamps also preserve order when several
 * completed messages arrive between two polls.
 */
export function autoplanPhaseCompletions(
  transcript: PlanCountTranscript,
  commandStartedAt: number,
): AutoplanPhaseHit[] {
  if (transcript.status !== 'ready') return [];
  const hits: AutoplanPhaseHit[] = [];
  const messages = [...transcript.assistantMessages]
    .filter(message => Number.isFinite(Date.parse(message.timestamp)) && Date.parse(message.timestamp) >= commandStartedAt)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  for (const message of messages) {
    let fence: { char: string; length: number } | undefined;
    let previousLine = '';
    const lines = message.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      // Four spaces/a tab creates an indented Markdown code block. Preserve
      // that distinction before trimming the declaration's whitespace.
      if (/^(?: {4}|\t)/.test(line)) continue;
      const text = line.trim();
      const delimiter = /^(`{3,}|~{3,})/.exec(text)?.[1];
      if (delimiter) {
        if (!fence) fence = { char: delimiter[0]!, length: delimiter.length };
        else if (delimiter[0] === fence.char && delimiter.length >= fence.length &&
                 !text.slice(delimiter.length).trim()) fence = undefined;
        previousLine = text;
        continue;
      }
      if (fence) continue;
      // Accept a plain/bold declaration, never a heading, quoted source,
      // table cell, checklist, or a sentence promising future completion.
      let match = phaseDeclaration(text);
      if (/^>\s/.test(text)) {
        // The skill's transition summary itself is a blockquote. Accept a
        // filled-in single-phase summary with concrete consensus counts;
        // a bare quotation or the template's [N]/[X/Y] examples cannot pass.
        const block: string[] = [];
        for (let cursor = index; cursor < lines.length && /^ {0,3}>/.test(lines[cursor]!); cursor++) {
          block.push(lines[cursor]!.replace(/^ {0,3}>\s?/, ''));
        }
        const concreteSummary = block.filter(value => phaseDeclaration(value)).length === 1 &&
          block.some(value => /^Consensus:\s*\d+\s*\/\s*\d+\b/i.test(value)) &&
          !/\[[^\]]*\]|\{\{/.test(block.join('\n'));
        if (concreteSummary) match = phaseDeclaration(text.replace(/^>\s?/, ''));
      }
      const introducedExample = /\b(?:example|sample|quote(?:d)?|source|template|instruction|marker|expected\s+(?:output|announcement))\b.*[:：]\s*$/i.test(previousLine) ||
        (!!match?.groups?.withResult && /\b(?:example|sample|quote(?:d)?|source|historical|earlier|previous|archived|hypothetical|template)\b.*[:：]\s*$/i.test(previousLine.replace(/\*\*/g, '')));
      // Keep an example introduction across all its marker/quoted lines,
      // rather than allowing its second marker to look like real completion.
      if (text && !(introducedExample && (match || text.startsWith('>')))) previousLine = text;
      if (!match || introducedExample) continue;
      if (match.groups?.withResult && withResultWithdrawn(lines, index, match[1]!)) continue;
      const phase = Number(match[1]);
      if (!hits.some(hit => hit.phase === phase)) hits.push({ phase, ts: Date.parse(message.timestamp) });
    }
  }
  return hits;
}
