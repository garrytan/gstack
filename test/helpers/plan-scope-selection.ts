import type { NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

/** A selected pasted plan may be announced by name instead of the menu letter. */
export function nativeSeededPlanSelection(
  transcript: PlanCountTranscript,
  tools: NativePublicToolEvent[],
  opts: { seed: string; skillName: string; sessionId: string; commandStartedAt: number },
): boolean {
  if (transcript.status !== 'ready' || !opts.sessionId || !Number.isFinite(opts.commandStartedAt)) return false;
  const headings = [...opts.seed.matchAll(/^#\s+(?:Plan:\s*)?([^\r\n]+)$/gmi)];
  if (headings.length !== 1) return false;
  const title = headings[0]![1]!.trim();
  if (!title || title.length > 200) return false;
  const at = (timestamp: string) => Date.parse(timestamp);
  // A late reply to the pre-pumped seed is insufficient: the same owned
  // session must actually finish loading this skill after its invocation.
  const calls = tools.filter(event => event.kind === 'use' && event.sessionId === opts.sessionId &&
    event.name === 'Skill' && [opts.skillName, `gstack:${opts.skillName}`].includes(String(event.input?.skill ?? '')) &&
    Number.isFinite(at(event.timestamp)) && at(event.timestamp) >= opts.commandStartedAt);
  const loaded = calls.flatMap(call => tools.filter(event => event.kind === 'result' &&
    event.sessionId === opts.sessionId && event.toolUseId === call.toolUseId && event.isError === false &&
    Number.isFinite(at(event.timestamp)) && at(event.timestamp) >= at(call.timestamp)));
  if (loaded.length !== 1) return false;
  for (const message of transcript.assistantMessages) {
    if (message.sessionId !== opts.sessionId || !Number.isFinite(at(message.timestamp)) ||
        at(message.timestamp) < at(loaded[0]!.timestamp)) continue;
    // Only a first asserted line can select the target. A source, quote or
    // hypothesis introduction owns its following text regardless of wording.
    const line = message.text.split(/\r?\n/).find(value => value.trim());
    if (!line || /^(?: {4}|\t)/.test(line)) continue;
    const text = line.trim();
    const selected = /^(?:I'll review|I will review|I'm proceeding with reviewing|I am proceeding with reviewing)\s+(?:the\s+)?(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)\s+(?:draft(?:\s+plan)?|plan)\s+(?:you pasted|pasted here)(.*)$/i.exec(text);
    if (!selected || (selected[1] ?? selected[2] ?? selected[3])!.trim().toLowerCase() !== title.toLowerCase()) continue;
    const tail = selected[4]!;
    if (/\b(?:if|unless|assuming|pending|only after|instead|not|won't|cannot)\b/i.test(tail)) continue;
    if (/^(?:\.(?:\s+(?:Next,|Then\b).*)?|,\s*(?:starting|beginning)\s+with\b.*|)$/.test(tail)) return true;
  }
  return false;
}
