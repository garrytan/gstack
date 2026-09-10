import type { NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

/** An asserted correction can retract a declaration; quoted source cannot. */
function withdrawsPlanSelection(message: string, title: string): boolean {
  let fence: { char: string; length: number } | undefined;
  let source = false;
  const assertions: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (!fence) fence = { char: mark[1]![0]!, length: mark[1]!.length };
      else if (mark[1]![0] === fence.char && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence || /^(?:\s*>| {4}|\t)/.test(line)) continue;
    const text = line.trim();
    if (/^(?:#{1,6}\s+)?(?:Current|Actual)\s+(?:assessment|scope|selection)\b/i.test(text)) source = false;
    else if (/^(?:#{1,6}\s+)?(?:Source|Example|Historical|Quoted|Original message|Expected output)\b/i.test(text)
      || /^(?:The following|This is)\b[^.!?]*\b(?:source|example|hypothetical|quoted)\b/i.test(text)) source = true;
    if (!source) assertions.push(text);
  }
  for (const statement of assertions.join('\n').split(/(?<=[.!?])\s+|\n+/).map(line => line.trim())) {
    if (statement.endsWith('?')) continue;
    const claim = statement.replace(/^Correction:\s*/i, '');
    const plain = claim.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '[quoted]');
    if (/^(?:The|This|That|My)\s+(?:(?:scope|target)\s+)?(?:selection|declaration)\s+(?:is|was|has been|remains)\s+(?:now\s+)?(?:withdrawn|retracted|cancelled|canceled|hypothetical)\b/i.test(plain)
      || /^(?:(?:I|We)\s+(?:have\s+)?)?(?:withdrawn?|withdrew|retract(?:ed)?|cancel(?:led|ed)?|disregard(?:ed)?|ignore(?:d)?)\s+(?:this|that|the|my)\s+(?:selection|declaration)\b/i.test(plain)) return true;
    const changedTarget = /^(?:The|This|My)\s+(?:selected|review)\s+target\s+is\s+(?:now\s+)?(.+?)[.!?]?$/i.exec(claim);
    if (changedTarget) {
      const target = changedTarget[1]!.replace(/^(?:the\s+)/i, '').replace(/["“”`]/g, '').replace(/\s+(?:draft(?:\s+plan)?|plan)[.!?]?$/i, '').trim();
      if (target.toLowerCase() !== title.toLowerCase()) return true;
    }
  }
  return false;
}

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
  const remainsSelected = (timestamp: string) => !transcript.assistantMessages.some(later =>
    later.sessionId === opts.sessionId && Number.isFinite(at(later.timestamp)) &&
    at(later.timestamp) >= at(timestamp) && withdrawsPlanSelection(later.text, title));
  for (const message of transcript.assistantMessages) {
    if (message.sessionId !== opts.sessionId || !Number.isFinite(at(message.timestamp)) ||
        at(message.timestamp) < at(loaded[0]!.timestamp)) continue;
    // Only a first asserted line can select the target. A source, quote or
    // hypothesis introduction owns its following text regardless of wording.
    const line = message.text.split(/\r?\n/).find(value => value.trim());
    if (!line || /^(?: {4}|\t)/.test(line)) continue;
    const text = line.trim();
    const selectedNow = /^(?:I've|I have) selected (?:reviewing|to review)\s+(?:the\s+)?pasted\s+(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)\s+(?:draft(?:\s+plan)?|plan)(.*)$/i.exec(text);
    const selected = selectedNow ?? /^(?:Scope gate confirms plan mode, so )?(?:I'll review|I will review|I'll go with reviewing|I will go with reviewing|I'll proceed with reviewing|I will proceed with reviewing|I'm proceeding with reviewing|I am proceeding with reviewing)\s+(?:the\s+)?(?:pasted\s+)?(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)\s+(?:draft(?:\s+plan)?|plan)(?:\s+(?:you pasted|pasted here))?(.*)$/i.exec(text);
    if (!selected || (selected[1] ?? selected[2] ?? selected[3])!.trim().toLowerCase() !== title.toLowerCase()) continue;
    const tail = selected[4]!;
    if (/\b(?:if|unless|assuming|pending|only after|instead|not|won't|cannot)\b/i.test(tail)) continue;
    if (/\b(?:retract|withdraw|cancel|disregard|ignore)\s+(?:that|this|the|my)\s+(?:selection|declaration)\b/i.test(tail)) continue;
    if (/\b(?:treat|consider|regard)\s+(?:that|this|the|my)\s+(?:selection|declaration)\s+as\s+(?:a\s+)?(?:hypothetical|example|proposal)\b/i.test(tail)) continue;
    if (/\b(?:that|this|the|my)\s+(?:selection|declaration)\s+(?:is|was)\s+(?:withdrawn|cancelled|canceled|hypothetical|retracted)\b/i.test(tail)) continue;
    if (selectedNow) {
      // A completed selection may name the pasted target before its plan-mode
      // reason. Keep the first assertion bound; later work is not a new target.
      // Internal token dots (DESIGN.md) do not open another sentence.
      if (/^(?:\s+(?:since|because)\s+(?:we're|we are|I'm|I am)\s+in plan mode)?\.(?:\s+(?:Now|Next,|Then)\s+(?:I'll|I will)\s+(?:run|start|begin)\s+(?:the\s+)?(?:pre-review\s+)?audit\b(?:[^.!?]|\.(?=\S))*\.)?$/i.test(tail) && remainsSelected(message.timestamp)) return true;
      continue;
    }
    if (/^(?:\.(?:\s+(?:Next,|Then\b).*)?|,\s*(?:starting|beginning)\s+(?:with|by)\b.*|,\s*and\s+now\s+(?:I'm|I am)\s+(?:running|starting|beginning)\s+(?:the\s+)?(?:pre-review\s+)?audit\b[^?]*\.|\. Running (?:the )?(?:pre-review )?audit\b(?:[^.!?]|\.(?=\S))*\.|)$/.test(tail) && remainsSelected(message.timestamp)) return true;
  }
  return false;
}
