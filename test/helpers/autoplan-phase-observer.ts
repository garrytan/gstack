import type { PlanCountTranscript } from './plan-count-transcript';

export interface AutoplanPhaseHit {
  phase: number;
  ts: number;
}

function phaseDeclaration(text: string): RegExpExecArray | null {
  const plain = text.replace(/^\*\*(Phase[ \t]+[\d.]+[ \t]+complete\.?)\*\*/i, '$1');
  if (/\bEmit\s+phase-transition\s+summary\s*:/i.test(plain)) return null;
  return /^Phase[ \t]+(1|2(?:\.5)?|3)[ \t]+complete(?:\.(?:[ \t]+.*)?|)$/i.exec(plain);
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
      const introducedExample = /\b(?:example|sample|quote(?:d)?|source|template|instruction|marker|expected\s+(?:output|announcement))\b.*[:：]\s*$/i.test(previousLine);
      // Keep an example introduction across all its marker/quoted lines,
      // rather than allowing its second marker to look like real completion.
      if (text && !(introducedExample && (match || text.startsWith('>')))) previousLine = text;
      if (!match || introducedExample) continue;
      const phase = Number(match[1]);
      if (!hits.some(hit => hit.phase === phase)) hits.push({ phase, ts: Date.parse(message.timestamp) });
    }
  }
  return hits;
}
