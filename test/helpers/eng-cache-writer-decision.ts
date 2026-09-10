import type { NativePlanQuestion } from './plan-count-transcript';

/** A current cache-writer decision may name its actors in the plan context.
 * Called only after engNumberedFindingAUQ validates completed native metadata. */
export function engCacheWriterDecision(q: NativePlanQuestion): boolean {
  const lines = q.question.split('\n');
  const ordinal = /^D([1-9]\d*) [—–:-] Who is allowed to write to the auth cache\?$/.exec(lines[0] ?? '')?.[1];
  if (!ordinal || q.header !== 'Cache writes') return false;
  const context = /^Project\/branch\/task: (\S[^\n]*), ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both mutating one backing cache \(([\w./-]+\.md):\d+(?:, \d+(?:[-–]\d+)?)?\)\.$/.exec(lines[1] ?? '');
  const assessment = /^ELI10: Two services write to the same cache and nothing orders their writes\. /.test(lines[2] ?? '');
  if (!context || context[2] === context[3] || !assessment ||
      lines.filter(line => /^Project\/branch\/task:/.test(line)).length !== 1 ||
      lines.filter(line => /^ELI10:/.test(line)).length !== 1) return false;
  const boundary = '(?:^|[.!?;]\\s+|\\n|[✅❌]\\s*)(?:Correction:\\s*)?';
  const owner = `(?:(?:this|the|that) (?:finding|issue|gap|assessment|option|action|remedy|race|single-writer requirement)|D\\s*${ordinal})`;
  const status = '(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)';
  const current = (text: string) => text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(new RegExp(`(${boundary}${owner} (?:is|was|has been) )["“'‘\x60](${status})["”'’\x60]`, 'gim'), '$1$2')
    .replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’\n]*’/g, '')
    .replace(/`([^`\n]*)`/g, (_, value: string) => /^[A-Za-z_$][\w$]*$/.test(value) ? value : '');
  const framed = new RegExp(`${boundary}(?:Source(?: excerpt| example)?|Quoted(?: source| example)?|Historical(?: assessment| example)?|Hypothetical(?: scenario| example)?|Earlier review)(?:[.:,]|\\s)|${boundary}(?:if|unless|when|assuming|provided|suppose|imagine)\\b`, 'i');
  const closed = new RegExp(`${boundary}${owner} (?:is|was|has been) ${status}\\b|${boundary}(?:there is )?no current (?:gap|risk|finding|race) (?:remains|exists)\\b`, 'i');
  // The first assertion is current; its following revoked-token scenario is
  // a causal explanation, not a condition on whether this review occurs.
  if (/\b(?:if|when|once|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i.test(current(context[1]!)) || framed.test(current(context[1]!)) || framed.test(current(lines.slice(0, 3).join('\n').split('ELI10:')[0]!)) ||
      closed.test(current(q.question))) return false;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const actors = [context[2]!, context[3]!];
  const contradiction = new RegExp(`${boundary}(?:(?:the|these|both) services (?:no longer (?:writes?|mutates?)|now serialize)|(?:${actors.map(escape).join('|')}) (?:no longer|does not) (?:writes?|mutates?)|(?:the |this )?(?:auth )?cache (?:is no longer shared|now serializes)|(?:the )?(?:race is (?:resolved|closed)|(?:writes|writers) are (?:now )?(?:ordered|serialized)))\\b`, 'i');
  if (contradiction.test(current(q.question))) return false;
  const rows = q.options.map(option => ({
    id: new RegExp(`^${ordinal}([A-D]) (.+?)(?: \\(recommended\\))?$`).exec(option.label),
    text: current(option.description ?? '').trim(),
  }));
  if (rows.some(row => !row.id) || new Set(rows.map(row => row.id![1])).size !== rows.length) return false;
  const cancelled = new RegExp(`${boundary}(?:do not|don't|never|skip|cancel|withdraw) (?:use|keep|accept|adopt|choose|proceed|reject|write|serialize|document)\\b`, 'i');
  if (rows.some(row => framed.test(row.text) || closed.test(row.text) || cancelled.test(row.text))) return false;
  const remedy = rows.find(row => row.id![2] === 'Single writer + version');
  const unchanged = rows.find(row => row.id![2] === 'Accept the race');
  if (!remedy || !unchanged) return false;
  const writers = /^([A-Za-z_$][\w$]*) writes with policy-version tag; adapter rejects stale writes; ([A-Za-z_$][\w$]*) reads\/invalidates\./.exec(remedy.text);
  if (!writers || writers[1] === writers[2] || !actors.includes(writers[1]!) || !actors.includes(writers[2]!)) return false;
  const override = new RegExp(`${boundary}(?:${escape(writers[2]!)} (?:also |still )?writes|${escape(writers[1]!)} (?:does not|no longer) writes|(?:the )?adapter (?:accepts stale writes|does not reject stale writes)|(?:the )?(?:version check|single-writer requirement) is (?:removed|disabled|optional))\\b`, 'i');
  const unchangedOverride = new RegExp(`${boundary}(?:only (?:${actors.map(escape).join('|')}) writes|(?:the |both )?writers no longer (?:write|mutate)|(?:the )?race is (?:no longer current|resolved|closed))\\b`, 'i');
  if (override.test(remedy.text) || !/^Keep both writers as planned and document the known race\./.test(unchanged.text) || contradiction.test(unchanged.text) || unchangedOverride.test(unchanged.text)) return false;
  return rows.every(row => row === remedy || row === unchanged ||
    (row.id![2] === 'Single writer only' &&
      new RegExp(`^${escape(writers[1]!)} writes, ${escape(writers[2]!)} reads and invalidates\\. No version check\\.`).test(row.text) && !override.test(row.text)));
}
