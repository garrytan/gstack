import type { NativePlanQuestionCall } from './plan-count-transcript';

/** A selected manual exit cannot modify the decisions already in the report.
 * Inspect the current recap and chosen action; unchosen follow-up reviews may
 * still have gates to clear. Report freshness and Exit ownership stay with the
 * caller, so this recognition alone never establishes review completion.
 */
export function isRecordedDxManualNavigation(call: NativePlanQuestionCall): boolean {
  if (!call.answered || call.failed !== false || !call.sessionId || !call.toolUseId ||
      !Number.isFinite(Date.parse(call.answeredAt ?? '')) || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 1) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || q.header.trim() !== 'Next steps' || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 || /```|~~~|<gstack-qid/i.test(q.question) ||
      (q.question.match(/\?/g)?.length ?? 0) !== 1) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const manual = (s: string) => /^Skip, handle (?:next steps )?manually$/i.test(label(s));
  const eng = (s: string) => /^Run \/plan-eng-review(?: next)?$/i.test(label(s));
  const implement = (s: string) => /^Ready to implement$/i.test(label(s));
  if (q.options.filter(o => manual(o.label)).length !== 1 ||
      q.options.filter(o => eng(o.label)).length !== 1 ||
      q.options.filter(o => implement(o.label)).length !== 1) return false;
  const selected = q.options.find(o => o.label === call.answers?.[q.question]);
  if (!selected || !manual(selected.label) ||
      !/^(?:End|Finish|Stop) the DX review here[.;]\s*you (?:will )?(?:run|handle) (?:subsequent|later) reviews (?:yourself|manually)\.$/i
        .test(selected.description?.trim() ?? '')) return false;

  // Native options, not the prose letters, identify the chosen action. Separate
  // the offered pros/cons from assertions about the current review, retaining
  // the final Net paragraph so it cannot hide an additional plan instruction.
  const parts = q.question.split(/\nPros \/ cons:\s*\n/);
  if (parts.length !== 2) return false;
  const net = /(?:^|\n)Net:\s*([^]*)$/.exec(parts[1]!);
  if (!net) return false;
  const current = `${parts[0]}\nNet: ${net[1]}`;
  const lines = current.split(/\r?\n/).filter(line =>
    !/^\s*>/.test(line) && !/^\s*(["'`]).*\1\s*$/.test(line));
  const prose = lines.join('\n');
  if (!/^(?:D[1-9]\d*\s*[—–-]\s*)?DX review (?:is )?complete\. What(?:['’]s)? next\?\n/i.test(prose)) return false;
  const contexts = [...prose.matchAll(/^Project\/branch\/task:\s*([^\n]+)$/gim)];
  const recaps = [...prose.matchAll(/^ELI10:\s*([^\n]+)$/gim)];
  if (contexts.length !== 1 || recaps.length !== 1) return false;
  const context = contexts[0]![1]!, recap = recaps[0]![1]!;
  // Only the single current context may introduce the recap. An intervening
  // source heading or hypothetical introduction changes its authority.
  const introduction = prose.slice(0, recaps[0]!.index).split('\n').slice(1).filter(line => line.trim());
  if (introduction.length !== 1 || !/^Project\/branch\/task:/.test(introduction[0]!) ||
      /^(?:source|example|historical|previous|earlier|if|unless|when|once|after|provided|proposed|optional)\b|^(?:for historical context|for example|from (?:a )?source excerpt)\b|^["'“‘`]/i.test(context) ||
      !/\/plan-devex-review\b[^.!?\n]*\bis finished; plan written to [^\s;]+\.md\./i.test(context) ||
      !/^The DX review is done:\s/i.test(recap) ||
      !/\bdecisions recorded\b/i.test(recap)) return false;
  return !/(?:^|\n|[.!;]\s+)(?:Source|Example|Historical(?: review)?|Previously|Earlier review(?: assessment)?):/i.test(prose) &&
    !/\b(?:DX review|DX findings?|DX decisions?|DX tasks?|plan|report|handoff)\b[^.!?\n]{0,70}\b(?:unresolved|outstanding|pending|remaining|withdrawn|retracted|superseded|cancelled|canceled|not current)\b/i.test(prose) &&
    !/\b(?:not|never)\s+(?:all\s+)?(?:done|complete|completed|recorded|written|resolved)\b|\b(?:done|complete|completed|recorded|written|resolved)\s+(?:only\s+)?(?:after|if|when|once|unless|until)\b/i.test(prose) &&
    !/(?:^|[.!?;]\s+|\n|\b(?:should|must|need to|will)\s+)(?:(?:we|you|please|first|then|also)\s+)*(?:add|fix|edit|update|rewrite|remove|implement|resolve|decide|change|approve|start|run)\b/im.test(prose);
}
