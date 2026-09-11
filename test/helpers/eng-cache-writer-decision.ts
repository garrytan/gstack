import type { NativePlanQuestion } from './plan-count-transcript';

/** A current cache-writer decision may name its actors in the plan context.
 * Called only after engNumberedFindingAUQ validates completed native metadata. */
export function engCacheWriterDecision(q: NativePlanQuestion): boolean {
  const lines = q.question.split('\n');
  // Severity, confidence and source citations annotate an owned issue; they
  // never replace its current defect, assessment or opposed choices.
  const annotated = /^D([1-9]\d*) [—–:-] Issue ([1-9]\d*) \[P[0-3]\] \(confidence (?:10|[1-9])\/10\) [A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?(?: \+ :[1-9]\d*(?:-[1-9]\d*)?)? [—–:-] ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both mutate one module-level ([A-Za-z_$][\w$]*) that does not serialize mutations\. How should the shared cache be wired\?$/.exec(lines[0] ?? '');
  const architecture = /^D([1-9]\d*) [—–:-] Architecture issue ([1-9]\d*): global mutable ([A-Za-z_$][\w$]*) shared by two services with unserialized mutations\.?$/.exec(lines[0] ?? '');
  const declared = annotated || architecture;
  const ordinal = declared?.[1] ?? /^D([1-9]\d*) [—–:-] Who is allowed to write to the auth cache\?$/.exec(lines[0] ?? '')?.[1];
  if (!ordinal || (declared ? q.header !== `Arch ${declared[2]}` : q.header !== 'Cache writes')) return false;
  const context = declared ? /^Project\/branch\/task: (\S[^\n]*)\.$/.exec(lines[1] ?? '')
    : /^Project\/branch\/task: (\S[^\n]*), ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both mutating one backing cache \(([\w./-]+\.md):\d+(?:, \d+(?:[-–]\d+)?)?\)\.$/.exec(lines[1] ?? '');
  const declaredWriters = architecture && /^ELI10: [A-Za-z][\w./-]*\.md:[1-9]\d*(?:-[1-9]\d*)? has ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both import one module-level ([A-Za-z_$][\w$]*) and both write to it, and [A-Za-z][\w./-]*\.md:[1-9]\d* says nothing serializes those writes\./.exec(lines[2] ?? '');
  const actors = architecture ? [declaredWriters?.[1] ?? '', declaredWriters?.[2] ?? ''] : annotated ? [annotated[3]!, annotated[4]!] : [context?.[2] ?? '', context?.[3] ?? ''];
  const assessment = architecture ? declaredWriters && declaredWriters[3] === architecture[3] : annotated
    ? /^ELI10: Two services share one global cache object exported from a module, and both write to it\. /.test(lines[2] ?? '')
    : /^ELI10: Two services write to the same cache and nothing orders their writes\. /.test(lines[2] ?? '');
  if (!context || actors[0] === actors[1] || !assessment ||
      lines.filter(line => /^Project\/branch\/task:/.test(line)).length !== 1 ||
      lines.filter(line => /^ELI10:/.test(line)).length !== 1) return false;
  const boundary = '(?:^|[.!?;]\\s+|\\n|[✅❌]\\s*)(?:Correction:\\s*)?';
  const owner = `(?:(?:this|the|that) (?:finding|issue|gap|assessment|option|action|remedy|race|single-writer requirement)|D\\s*${ordinal}${declared ? `|${architecture ? '(?:Architecture )?' : ''}Issue ${declared[2]}` : ''})`;
  const status = `(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current${declared ? '|optional|unproven|proposed|conditional on approval' : ''})`;
  const current = (text: string) => (declared ? text.replace(/\*\*/g, '').replace(/\((?:human|CC):[^)\n]*\)[ \t]+(?=(?:Correction:\s*)?(?:this|the|that) (?:option|action|remedy)\b)/gi, '$&. ') : text)
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
  const contradiction = new RegExp(`${boundary}(?:(?:the|these|both) services (?:no longer (?:writes?|mutates?)|now serialize)|(?:${actors.map(escape).join('|')}) (?:no longer|does not) (?:writes?|mutates?)|(?:the |this )?(?:auth )?cache (?:is no longer shared|now serializes)|(?:the )?(?:race is (?:resolved|closed)|(?:writes|writers) are (?:now )?(?:ordered|serialized)))\\b`, 'i');
  if (contradiction.test(current(q.question))) return false;
  if (architecture) {
    const cache = escape(architecture[3]!);
    const text = current(q.question);
    const namedResolved = new RegExp(`${boundary}${cache} (?:is (?:now |already )?(?:serialized|ordered)|now serializes|no longer (?:shares|has) (?:mutable )?state)\\b`, 'i');
    const onlyWriter = new RegExp(`${boundary}only (?:${actors.map(escape).join('|')}) writes\\b`, 'i');
    const conditional = new RegExp(`\\b(?:if|when|once|unless) (?:approved|accepted)|\\b(?:after|pending) approval\\b|${boundary}${owner} (?:requires (?:approval|acceptance)|is (?:conditional|contingent|dependent) on (?:approval|acceptance))\\b`, 'i');
    const cancelled = new RegExp(`${boundary}(?:do not|don't|never|skip|cancel|withdraw) (?:inject|use|keep|accept|adopt|choose|proceed|reject|write|serialize|document)\\b`, 'i');
    if (framed.test(text) || conditional.test(text) || cancelled.test(text) || namedResolved.test(text) || onlyWriter.test(text)) return false;
    const race = /Picture ([A-Za-z_$][\w$]*) invalidating tenant ([A-Za-z][\w-]*) on suspension at the same instant ([A-Za-z_$][\w$]*) writes a freshly refreshed token for tenant ([A-Za-z][\w-]*)\. Last writer wins, the suspended tenant keeps a valid session, and nothing logs it\./.exec(current(lines[2] ?? ''));
    if (!race || race[1] === race[3] || !actors.includes(race[1]!) || !actors.includes(race[3]!) || race[2] !== race[4]) return false;
    const rows = q.options.map(option => ({ id: new RegExp(`^${architecture[2]}([A-D]): (.+?)(?: \\(recommended\\))?$`).exec(option.label), text: current(option.description ?? '').trim() }));
    if (rows.some(row => !row.id || framed.test(row.text) || closed.test(row.text) || conditional.test(row.text) || cancelled.test(row.text)) || new Set(rows.map(row => row.id![1])).size !== rows.length) return false;
    const remedy = rows.find(row => new RegExp(`^Inject ${cache} by constructor; ${cache} owns all writes and serializes per tenant key; every method requires tenant context$`).test(row.id![2]!));
    const unchanged = rows.find(row => row.id![2] === 'Do nothing; document that mutations are unserialized');
    if (!remedy || !unchanged ||
        !/^✅\s*Invalidation can never be overwritten by a concurrent refresh: writes for one tenant key run in order through one owner\./.test(remedy.text) ||
        !new RegExp(`✅\\s*Tests construct a fresh ${cache} per case, so no cross-test state leaks\\.`).test(remedy.text) ||
        !/✅\s*No method accepts a call without a tenant ID, so tenant isolation is enforced at the type boundary\./.test(remedy.text) ||
        !/❌\s*Leaves a silent security failure mode \(suspended tenant stays valid\) in a multi-tenant auth path\./.test(unchanged.text) ||
        contradiction.test(unchanged.text) || namedResolved.test(unchanged.text) || onlyWriter.test(unchanged.text)) return false;
    const reversed = new RegExp(`${boundary}(?:${cache} (?:does not|no longer) (?:owns?|serializes?)|(?:the |this )?(?:queue|mutex|serialization|tenant context) (?:is|was|has been) (?:removed|disabled|optional)|(?:either|a) service (?:still )?writes directly|(?:${actors.map(escape).join('|')}) (?:also |still )?(?:writes|mutates) (?:the cache )?directly)\\b`, 'i');
    if (reversed.test(remedy.text)) return false;
    return rows.every(row => row === remedy || row === unchanged ||
      new RegExp(`^Keep module-level export but add a per-key write lock inside ${cache}$`).test(row.id![2]!) &&
      /❌\s*Tests still share one global instance and need manual reset hooks\./.test(row.text) && !namedResolved.test(row.text) && !onlyWriter.test(row.text));
  }
  if (annotated) {
    const text = current(q.question), explanation = current(lines[2] ?? '');
    const conditional = new RegExp(`\\b(?:if|when|once|unless) (?:approved|accepted)|\\b(?:after|pending) approval\\b|${boundary}${owner} (?:requires (?:approval|acceptance)|is (?:conditional|contingent|dependent) on (?:approval|acceptance))\\b`, 'i');
    const namedResolved = new RegExp(`${boundary}${escape(annotated[5]!)} (?:is (?:now |already )?(?:serialized|ordered)|no longer (?:shares|has) (?:mutable )?state)\\b`, 'i');
    const scenario = /while ([A-Za-z_$][\w$]*) is halfway through minting, the mint can land after the invalidation and a suspended tenant keeps a live session\./.exec(explanation);
    if (!scenario || !actors.includes(scenario[1]!) || framed.test(text) || conditional.test(text) || namedResolved.test(text)) return false;
    const rows = q.options.map(option => ({ label: option.label.replace(/ \(recommended\)$/, ''), text: current(option.description ?? '').trim() }));
    const cancelled = new RegExp(`${boundary}(?:do not|don't|never|skip|cancel|withdraw) (?:inject|use|keep|accept|adopt|choose|proceed|reject|write|serialize|document)\\b`, 'i');
    if (rows.some(row => framed.test(row.text) || closed.test(row.text) || conditional.test(row.text) || cancelled.test(row.text))) return false;
    const remedy = rows.find(row => row.label === 'Inject + single-writer + version-checked writes');
    const unchanged = rows.find(row => row.label === 'Keep module-level export as planned');
    if (!remedy || !unchanged) return false;
    const writer = new RegExp(`^✅\\s*${escape(annotated[5]!)} passed into both services by constructor from one composition root; ([A-Za-z_$][\\w$]*) is the only writer, ([A-Za-z_$][\\w$]*) reads and invalidates\\.`).exec(remedy.text);
    if (!writer || writer[1] === writer[2] || !actors.includes(writer[1]) || !actors.includes(writer[2]) ||
        !/✅\s*Writes carry the policy version and are rejected if the entry was invalidated since read \(compare-and-set\), with a unit test for the interleaving\./.test(remedy.text) ||
        !/❌\s*Global mutable state shared by two writers, no serialization, order-dependent tests, and a silent tenant-isolation hole\./.test(unchanged.text) ||
        contradiction.test(unchanged.text) || namedResolved.test(unchanged.text)) return false;
    const override = new RegExp(`${boundary}(?:${escape(writer[2]!)} (?:also |still )?writes|${escape(writer[1]!)} (?:does not|no longer) writes|(?:the )?adapter (?:accepts stale writes|does not reject stale writes)|(?:the )?(?:version check|single-writer requirement) is (?:removed|disabled|optional))\\b`, 'i');
    if (override.test(remedy.text) || new RegExp(`${boundary}only (?:${actors.map(escape).join('|')}) writes\\b`, 'i').test(unchanged.text)) return false;
    return rows.every(row => row === remedy || row === unchanged || row.label === 'Constructor injection only' &&
      /❌\s*Both services still write freely; the write-after-invalidate race stays open\b/.test(row.text) && !contradiction.test(row.text) &&
      !namedResolved.test(row.text) && !new RegExp(`${boundary}only (?:${actors.map(escape).join('|')}) writes\\b`, 'i').test(row.text));
  }
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
