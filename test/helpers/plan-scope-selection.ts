import type { NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

function deicticPlanSelection(text: string): RegExpExecArray | null {
  return /^(?:I'll|I will) (?:review|(?:run|invoke) (?:the )?\/?([\w:-]+) skill (?:to review|on|against)) (?:this|your|the) (?:draft[ \t]+)?([\p{L}\p{N}]+(?:[ \t\u2010-\u2015-]+[\p{L}\p{N}]+)*[ \t]+)?plan\.$/iu.exec(text);
}

function describesTitle(descriptor: string | undefined, title: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[\u2010-\u2015-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !descriptor || ` ${normalize(title)} `.includes(` ${normalize(descriptor)} `);
}

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
    if (/^(?:#{1,6}\s+)?(?:Current|Actual)\s+(?:assessment|scope|selection|status)\b/i.test(text)) source = false;
    else if (/^(?:#{1,6}\s+)?(?:Source|Example|Historical|Quoted|Original message|Expected output)\b/i.test(text)
      || /^(?:The following|This is)\b[^.!?]*\b(?:source|example|hypothetical|quoted)\b/i.test(text)) source = true;
    if (!source) assertions.push(text);
  }
  for (const statement of assertions.join('\n').split(/(?<=[.!?;])\s+|\n+/).map(line => line.trim())) {
    if (statement.endsWith('?')) continue;
    const claim = statement.replace(/^Correction:\s*/i, '');
    const plain = claim.replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’|`[^`\n]*`/g, (quoted, index) =>
      /^(?:withdrawn|retracted|cancelled|canceled|hypothetical|no longer current|superseded|rejected)$/i.test(quoted.slice(1, -1)) &&
      /^(?:The|This|That|My)\s+(?:(?:scope|target)\s+)?(?:selection|declaration)\s+(?:is|was|has been|remains)\s+(?:now\s+)?$/i.test(claim.slice(0, index))
        ? quoted.slice(1, -1) : '[quoted]');
    if (/^(?:The|This|That|My)\s+(?:(?:scope|target)\s+)?(?:selection|declaration)\s+(?:is|was|has been|remains)\s+(?:now\s+)?(?:withdrawn|retracted|cancelled|canceled|hypothetical|no longer current|superseded|rejected)\b/i.test(plain)
      || /^(?:(?:I|We)\s+(?:have\s+)?)?(?:withdrawn?|withdrew|retract(?:ed)?|cancel(?:led|ed)?|disregard(?:ed)?|ignore(?:d)?)\s+(?:this|that|the|my)\s+(?:selection|declaration)\b/i.test(plain)) return true;
    const deictic = deicticPlanSelection(claim);
    if (deictic && !describesTitle(deictic[2], title)) return true;
    const reviewing = /^(?:I'll|I will|I'm|I am|We will|We're|We are) (?:now )?(?:review|reviewing) (?:the )?(?:branch diff|(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`) (?:draft(?: plan)?|plan))(?: instead)?\.$/i.exec(claim);
    if (reviewing && (reviewing[1] ?? reviewing[2] ?? reviewing[3] ?? 'branch diff').toLowerCase() !== title.toLowerCase()) return true;
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
  // Loading must succeed in this invocation; the public target declaration
  // may come immediately before it, so the user can interrupt before work.
  const calls = tools.filter(event => event.kind === 'use' && event.sessionId === opts.sessionId &&
    event.name === 'Skill' && [opts.skillName, `gstack:${opts.skillName}`].includes(String(event.input?.skill ?? '')) &&
    Number.isFinite(at(event.timestamp)) && at(event.timestamp) >= opts.commandStartedAt);
  const loaded = calls.flatMap(call => tools.filter(event => event.kind === 'result' &&
    event.sessionId === opts.sessionId && event.toolUseId === call.toolUseId && event.isError === false &&
    Number.isFinite(at(event.timestamp)) && at(event.timestamp) >= at(call.timestamp)));
  if (calls.length !== 1 || loaded.length !== 1) return false;
  // Explicit Skill arguments must select this seed, not merely mention its
  // title while requesting another target. Unknown argument forms fail closed.
  const args = calls[0]!.input?.args;
  if (args !== undefined && args !== '') {
    if (typeof args !== 'string') return false;
    const target = /^Review (?:the )?(?:draft plan|plan) (?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)(?: (?:provided|pasted) in the conversation above)?(?: \([^()\n]*\))?\.?$/i.exec(args)
      ?? /^Review (?:the )?pasted (?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`) (?:draft plan|plan)\.?$/i.exec(args);
    const pasted = /^Review this draft plan:\s*([\s\S]+)$/i.exec(args);
    const sameDraft = pasted && pasted[1]!.replace(/\s+/g, ' ').trim() === opts.seed.replace(/\s+/g, ' ').trim();
    if (!sameDraft && (!target || (target[1] ?? target[2] ?? target[3])!.toLowerCase() !== title.toLowerCase()
      || /\b(?:if|unless|instead|not|pending|assuming)\b/i.test(args))) return false;
  }
  const work = tools.filter(event => event.kind === 'use' && event.sessionId === opts.sessionId && event.toolUseId !== calls[0]!.toolUseId);
  const beforeWork = (time: number) => work.every(event => Number.isFinite(at(event.timestamp)) &&
    (at(event.timestamp) < opts.commandStartedAt || at(event.timestamp) > time));
  if (!beforeWork(at(loaded[0]!.timestamp))) return false;
  const remainsSelected = (timestamp: string) => !transcript.assistantMessages.some(later =>
    later.sessionId === opts.sessionId && Number.isFinite(at(later.timestamp)) &&
    at(later.timestamp) >= at(timestamp) && withdrawsPlanSelection(later.text, title));
  for (const message of transcript.assistantMessages) {
    if (message.sessionId !== opts.sessionId || !Number.isFinite(at(message.timestamp)) ||
        at(message.timestamp) <= opts.commandStartedAt || !beforeWork(at(message.timestamp))) continue;
    // Only a first asserted line can select the target. A source, quote or
    // hypothesis introduction owns its following text regardless of wording.
    const line = message.text.split(/\r?\n/).find(value => value.trim());
    if (!line || /^(?: {4}|\t)/.test(line)) continue;
    const text = line.trim();
    // A deictic target binds to the single pasted plan. Any descriptor must
    // occur as contiguous whole words in its title, never merely in its body.
    const draft = deicticPlanSelection(text);
    const names = [opts.skillName, `gstack:${opts.skillName}`, opts.skillName.replace(/^plan-/, '')];
    if (draft && describesTitle(draft[2], title) && (!draft[1] || names.includes(draft[1].toLowerCase())) && remainsSelected(message.timestamp)) return true;
    const automatic = /^(?:I\'ll|I will) auto[- ]select option B and review\s+(?:the\s+)?(.+?)\s+(?:draft(?:\s+plan)?|plan)\s+(?:you shared|you pasted|pasted here)(.*)$/i.exec(text);
    const automaticTarget = automatic?.[1]?.replace(/^(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)$/, (_, straight, curly, code) => straight ?? curly ?? code);
    const selectedNow = /^(?:I've|I have) selected (?:option B, )?(?:reviewing|to review)\s+(?:the\s+)?pasted\s+(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)\s+(?:draft(?:\s+plan)?|plan)(.*)$/i.exec(text);
    const selected = selectedNow ?? /^(?:Scope gate confirms plan mode, so )?(?:I'll review|I will review|I'll go with reviewing|I will go with reviewing|I'll proceed with reviewing|I will proceed with reviewing|I'm proceeding with reviewing|I am proceeding with reviewing)\s+(?:the\s+)?(?:pasted\s+)?(?:"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`)\s+(?:draft(?:\s+plan)?|plan)(?:\s+(?:you pasted|pasted here))?(.*)$/i.exec(text);
    const selectedTarget = automaticTarget ?? (selected && (selected[1] ?? selected[2] ?? selected[3]));
    if (!selectedTarget || selectedTarget.trim().toLowerCase() !== title.toLowerCase()) continue;
    const tail = automatic?.[2] ?? selected![4]!;
    if (/\b(?:if|unless|assuming|pending|only after|instead|not|won't|cannot)\b/i.test(tail)) continue;
    if (/\b(?:retract|withdraw|cancel|disregard|ignore)\s+(?:that|this|the|my)\s+(?:selection|declaration)\b/i.test(tail)) continue;
    if (/\b(?:treat|consider|regard)\s+(?:that|this|the|my)\s+(?:selection|declaration)\s+as\s+(?:a\s+)?(?:hypothetical|example|proposal)\b/i.test(tail)) continue;
    if (/\b(?:that|this|the|my)\s+(?:selection|declaration)\s+(?:is|was)\s+(?:withdrawn|cancelled|canceled|hypothetical|retracted)\b/i.test(tail)) continue;
    if (automatic) {
      if (/^(?:\.|,\s*running\s+(?:the\s+)?(?:pre-review\s+)?audit\b[^?]*\.)$/i.test(tail) && remainsSelected(message.timestamp)) return true;
      continue;
    }
    if (selectedNow) {
      // A completed selection may name the pasted target before its plan-mode
      // reason. Keep the first assertion bound; later work is not a new target.
      // Internal token dots (DESIGN.md) do not open another sentence.
      if (/^(?:\s+(?:since|because)\s+(?:we're|we are|I'm|I am)\s+in plan mode)?\.(?:\s+(?:Now|Next,?|Then)\s+(?:I'll|I will)\s+(?:run|start|begin)\s+(?:the\s+)?(?:pre-review\s+)?(?:audit|Design Doc Check)\b(?:[^.!?]|\.(?=\S))*\.)?$/i.test(tail) && remainsSelected(message.timestamp)) return true;
      continue;
    }
    if (/^(?:\.(?:\s+(?:Next,|Then\b).*)?|,\s*(?:starting|beginning)\s+(?:with|by)\b.*|,\s*and\s+now\s+(?:I'm|I am)\s+(?:running|starting|beginning)\s+(?:the\s+)?(?:pre-review\s+)?audit\b[^?]*\.|\. Running (?:the )?(?:pre-review )?audit\b(?:[^.!?]|\.(?=\S))*\.|)$/.test(tail) && remainsSelected(message.timestamp)) return true;
  }
  return false;
}
