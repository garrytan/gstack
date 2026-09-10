import type { NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

export interface NativeAutoDecision {
  sessionId: string;
  skillToolUseId: string;
  timestamp: string;
  summary: string;
  option: string;
  annotation: string;
}

const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
const annotationLine = /^Auto-decided ([^\r\n→]{1,240}) → ([^\r\n→]{1,200}) \(your preference\)\. Change with \/plan-tune\.$/;

/** Asserted prose only; later quoted examples cannot retract a current decision. */
function publicProse(text: string): string {
  const lines: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t|\s*>)/.test(line)) continue;
    const current = plain(line);
    // A direct correction owns its quoted verdict; an attributed example does not.
    if (/^(?:Correction|Actually|Update):\s*/i.test(current)) lines.push(current.replace(/["“”`]/g, ''));
    else lines.push(current.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '""'));
  }
  return lines.join('\n');
}

function withdrawn(text: string, option: string): boolean {
  const prose = publicProse(text);
  if (/\b(?:I|we)\s+(?:retract|withdraw|revoke|cancel)\b[^.!?\n]{0,100}\b(?:auto[- ]decision|annotation|decision|selection|choice)\b/i.test(prose) ||
      /\b(?:I|we)\s+(?:did not|didn't|have not|haven't|will not|won't|no longer)\s+auto-decide\b/i.test(prose) ||
      /\b(?:I|we)\s+(?:did not|didn't|have not|haven't)\s+make\s+(?:this|that|the)\s+(?:decision|selection|choice)\b/i.test(prose) ||
      /\b(?:this|that|the)\s+(?:auto[- ]decision|annotation|statement|decision|selection|choice)\b[^.!?\n]{0,100}\b(?:withdrawn|retracted|revoked|cancelled|canceled|hypothetical|conditional|example)\b/i.test(prose)) return true;
  return [...prose.matchAll(/^Review mode:\s*([^\n.]+)\.?$/gmi)].some(m => plain(m[1]!).toLowerCase() !== option.toLowerCase());
}

function assertedAnnotation(text: string): RegExpExecArray | null {
  const paragraphs = text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '').split(/\r?\n\s*\r?\n/);
  let index = 0;
  // A preamble notice is independent of the immediately following current
  // mode declaration. No arbitrary source/example prefix is skipped.
  if (/^Heads-up from gstack: this branch has unshipped work\. Run `\/review` then `\/ship` when you're ready\.$/.test(paragraphs[0] ?? '')) index++;
  const mode = /^\*\*Review mode:\s*([^*\n.]+)\.\*\*$/.exec(paragraphs[index] ?? '');
  if (mode) index++;
  if (index && !mode) return null;
  const paragraph = paragraphs[index];
  if (!paragraph || /^(?: {4}|\t)/.test(paragraph) || paragraph.includes('\n')) return null;
  const match = annotationLine.exec(paragraph);
  if (!match || !plain(match[1]!) || !plain(match[2]!)) return null;
  // The printed skill template is not a concrete observed choice.
  if (/<[^>\r\n]+>/.test(match[1]!) || /<[^>\r\n]+>/.test(match[2]!)) return null;
  if (mode && (plain(mode[1]!).toLowerCase() !== plain(match[2]!).toLowerCase() ||
      !/^(?:review mode|"Review mode:[^"]+\?")$/i.test(match[1]!))) return null;
  return match;
}

/** Exact public annotation after a successful invocation in the owned native session. */
export function findNativeAutoDecision(
  transcript: PlanCountTranscript,
  tools: NativePublicToolEvent[],
  opts: { skillName: string; sessionId: string; commandStartedAt: number; now: number },
): NativeAutoDecision | null {
  if (transcript.status !== 'ready' || !opts.sessionId || !opts.skillName ||
      !Number.isFinite(opts.commandStartedAt) || !Number.isFinite(opts.now) || opts.now < opts.commandStartedAt) return null;
  const at = (timestamp: string) => Date.parse(timestamp);
  const timely = (timestamp: string) => Number.isFinite(at(timestamp)) && at(timestamp) >= opts.commandStartedAt && at(timestamp) <= opts.now;
  const uses = tools.filter(e => e.kind === 'use' && e.sessionId === opts.sessionId && e.name === 'Skill' &&
    [opts.skillName, `gstack:${opts.skillName}`].includes(String(e.input?.skill ?? '')) && timely(e.timestamp));
  if (uses.length !== 1 || !uses[0]!.toolUseId) return null;
  const use = uses[0]!;
  const results = tools.filter(e => e.kind === 'result' && e.sessionId === opts.sessionId && e.toolUseId === use.toolUseId);
  if (results.length !== 1 || results[0]!.isError !== false || !timely(results[0]!.timestamp) || at(results[0]!.timestamp) < at(use.timestamp)) return null;
  // A native question actually surfaced; the annotation cannot erase it.
  if (transcript.calls.some(call => call.sessionId === opts.sessionId)) return null;
  const messages = transcript.assistantMessages.filter(m => m.sessionId === opts.sessionId);
  if (messages.some(m => !Number.isFinite(at(m.timestamp)) || at(m.timestamp) > opts.now)) return null;
  const loadedAt = at(results[0]!.timestamp);
  for (const message of messages) {
    if (at(message.timestamp) < loadedAt) continue;
    const match = assertedAnnotation(message.text);
    if (!match) continue;
    const option = plain(match[2]!);
    const current = messages.filter(m => at(m.timestamp) >= at(message.timestamp)).map(m => m.text).join('\n\n');
    if (withdrawn(current, option)) continue;
    return { sessionId: opts.sessionId, skillToolUseId: use.toolUseId, timestamp: message.timestamp,
      summary: plain(match[1]!), option, annotation: match[0] };
  }
  return null;
}
