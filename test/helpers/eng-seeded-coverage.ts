import type { NativePlanQuestionCall } from './plan-count-transcript';
import { type AskUserQuestionFingerprint } from './claude-pty-runner';
import { marked } from 'marked';
// Ignore displayed examples/code, while retaining inline code identifiers.
function prose(text: string, omitLiteralProse = false): string {
  let fence: string | undefined;
  const lines = text.split('\n').filter(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence && !/^(?: {0,3}>| {4}|\t)/.test(line);
  }).join('\n');
  return (omitLiteralProse ? lines.replace(/`([^`]+)`/g, (span, body: string) => /\s/.test(body) ? '' : span) : lines).replace(/[`*]/g, '');
}

function completedDecision(call: NativePlanQuestionCall, startedAt: number, finishedAt: number): boolean {
  const answeredAt = Date.parse(call.answeredAt ?? '');
  if (!call.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      !Number.isFinite(answeredAt) || answeredAt < startedAt || answeredAt > finishedAt ||
      call.questions.length < 1 || call.questions.length > 4 || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length !== 0) return false;
  return new Set(call.questions.map(q => q.question)).size === call.questions.length &&
    Object.keys(call.answers ?? {}).length === call.questions.length &&
    call.questions.every(q => q.question.trim() && !q.multiSelect && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every(o => o.label.trim()) && new Set(q.options.map(o => o.label)).size === q.options.length &&
    q.options.some(o => call.answers?.[q.question] === o.label));
}

/** Structural eligibility for this distinct-issue counter, not seed quality. */
function batchingIssueNumber(call: NativePlanQuestionCall): string | undefined {
  if (!completedDecision(call, 0, Date.now()) || call.questions.length !== 1) return;
  const q = call.questions[0]!;
  const title = q.question.split('\n')[0]!;
  const legacy = /^(?:D[1-9]\d*\s*[—–:-]\s*)?Issue ([1-9]\d*)\s*:\s*\S[^\n]*$/i.exec(title)?.[1];
  let issue = legacy, currentOwner = legacy ? `Issue ${legacy}` : '';
  if (legacy) {
    if (!new RegExp(`^(?:Arch(?:itecture)?|Code quality|Tests?|Testing|Performance|Security)(?: ${legacy})?$`, 'i').test(q.header.trim())) return;
    const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[.):]\s+\S/i.exec(o.label));
    if (optionIds.some(id => id?.[1] !== legacy) || new Set(optionIds.map(id => id![2]!.toUpperCase())).size !== q.options.length) return;
  } else {
    // The current ledger uses stable R IDs and a new D number for each ask.
    // Earlier briefs may instead cite their current finding in task metadata.
    // Bind only that owned identity, never D alone or a later recap of others.
    const decision = /^D([1-9]\d*)\b/.exec(title);
    // D owns this ask. R can be shared by the title/header or live in the
    // header alone when this question names one current source document.
    const recordIds = [...prose(title, true).replace(/"[^"\n]*"|“[^”\n]*”/g, '').matchAll(/\bR[1-9]\d*\b/g)].map(match => match[0]);
    let recordId = recordIds.length === 1 ? recordIds[0] : undefined;
    const lines = prose(q.question, true).split('\n').filter(line => line.trim());
    const metadata = lines[1]?.replace(/"[^"\n]*"|“[^”\n]*”/g, '') ?? '';
    const explanation = (lines[2] ?? '').replace(/"[^"\n]*"|“[^”\n]*”/g, '');
    if (!decision || !/^Project\/branch\/task: \S/.test(metadata) || !/\bPLAN\.md\b/.test(metadata) ||
        lines.filter(line => /^Project\/branch\/task:/.test(line)).length !== 1 ||
        lines.filter(line => /^ELI10:/.test(line)).length !== 1 || !/^ELI10: \S/.test(explanation) ||
        /^ELI10:\s*(?:".*"|“.*”)\s*$/.test(lines[2] ?? '') ||
        /^ELI10: (?:source|quoted|historical|example|hypothetical)\b/i.test(explanation) ||
        /\b(?:copied|quoted|historical)\s+(?:(?:source|quoted)\s+)?(?:example|excerpt|text|material)\b/i.test(metadata) ||
        q.options.some(option => !prose(option.description ?? '', true).trim())) return;
    const finding = /(?:^|[,;]\s*)finding (F[1-9]\d*)\s*\(PLAN\.md:[1-9]\d*(?:[-–][1-9]\d*)?\)/i.exec(metadata)?.[1];
    if (recordIds.length > 1 || /\b(?:copied|quoted|historical|example|hypothetical)\b/i.test(title)) return;
    if (!recordId && !finding) {
      const header = q.header.trim();
      const ids = [...header.matchAll(/\bR[1-9]\d*\b/g)].map(match => match[0]);
      const sources = [...metadata.matchAll(/\b[\w./-]+\.md(?::[1-9]\d*(?:[-–][1-9]\d*)?)?\b/g)].map(match => match[0]);
      // This native form carries the complete tradeoff in each option.
      // Short aliases for a comparison in the question/report must keep using
      // the saved-ledger path; the header cannot replace that authority.
      const completeOptions = q.options.every(option => {
        const description = prose(option.description ?? '', true).replace(/"[^"\n]*"|“[^”\n]*”/g, '').trim();
        const blocks = [...description.matchAll(/([✅❌])\s*([^✅❌]+)/g)];
        return description.startsWith('✅') && blocks.every(block => /[A-Za-z0-9]/.test(block[2]!)) &&
          blocks.filter(block => block[1] === '✅').length >= 2 && blocks.some(block => block[1] === '❌');
      });
      if (!completeOptions || lines.some(line => /^(?:Options?:\s*)?[A-D][).:]\s+\S/.test(line))) return;
      // A bare D number, a quoted/foreign R, or an unrelated source mention
      // cannot supply identity. Native ACK/options and current-status checks
      // below remain the same as the title-owned route.
      if (ids.length !== 1 || !new RegExp(`^${ids[0]}(?:\\s+[A-Za-z]|\\s*[—–:-]\\s*[A-Za-z])`).test(header) ||
          /\bR[1-9]\d*\b/.test(title) || /[\r\n`"“”]/.test(header) ||
          [...title.matchAll(/\bD[1-9]\d*\b/g)].length !== 1 ||
          /\b(?:copied|quoted|historical|history|example|hypothetical|withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|not current|no longer current)\b/i.test(header) ||
          sources.length !== 1 || !/^PLAN\.md(?::[1-9]\d*(?:[-–][1-9]\d*)?)?$/.test(sources[0]!)) return;
      recordId = ids[0];
    }
    if (recordId) {
      const headerIds = [...q.header.matchAll(/\bR[1-9]\d*\b/g)].map(match => match[0]);
      if (!new RegExp(`^${recordId}\\b`).test(q.header.trim()) || headerIds.length !== 1 || headerIds[0] !== recordId) return;
      issue = `record:${recordId}`;
    } else if (finding) issue = `finding:${finding.toUpperCase()}`;
    else return;
    currentOwner = `${recordId ?? finding}|D${decision[1]}`;
  }
  // Owned scalar statuses remain current prose; a whole code example does not.
  const owner = `(?:(?:this|the|that) (?:issue|finding|decision)|${currentOwner})`;
  const statusPrefix = `(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?${owner} (?:is|was|has been) `;
  const scalarOwner = new RegExp(`${statusPrefix}$`, 'i');
  const text = q.question.replace(/`([^`\n]+)`/g, (span, body: string, at: number, source: string) =>
    scalarOwner.test(source.slice(0, at)) ? body : span);
  const inactive = new RegExp(`${statusPrefix}["“'‘]?(?:withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|hypothetical|not current|no longer current)\\b`, 'i');
  return inactive.test(prose(text, true)) ? undefined : issue;
}

/** Batching measures separate native issue decisions; seed quality is checked separately. */
export function isEngBatchingIssueAUQ(fp: AskUserQuestionFingerprint, priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
  const call = fp.nativeCall;
  if (!call || fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      priorCalls.some(prior => prior.sessionId !== call.sessionId || prior.toolUseId === call.toolUseId)) return false;
  const issue = batchingIssueNumber(call);
  if (!issue) return false;
  const q = call.questions[0]!;
  if (fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  // Re-asking an eligible issue cannot inflate the floor; setup and batches do not suppress later separate decisions.
  return !priorCalls.some(prior => batchingIssueNumber(prior) === issue);
}

// The report's target declaration field (Target / Review target / Reviewed target, optionally qualified).
const TARGET_FIELD = /^(?:Reviewed |Review )?target(?: \([^)\n]*\))?:/i;

/** A native brief can use its D number and topic while its stable R identity
 * lives in the required saved ledger. Count that owned choice, not a title
 * spelling. This does not approve the row or validate the implementation. */
function recordedBatchingIssue(call: NativePlanQuestionCall, savedPlan: string): string | undefined {
  const q = call.questions[0]!;
  const text = prose(q.question, true), lines = text.split('\n').filter(line => line.trim());
  const title = lines[0] ?? '', decision = /^D([1-9]\d*(?:\.[1-9]\d*)?)\s*[—–:-]\s+\S/.exec(title);
  const metadata = (lines[1] ?? '').replace(/"[^"\n]*"|“[^”\n]*”/g, ''), explanation = lines[2] ?? '';
  const source = /\bPLAN\.md:([1-9]\d*(?:[-–][1-9]\d*)?)\b/.exec(metadata)?.[1];
  if (!decision || !/^Project\/branch\/task: \S/.test(metadata) ||
      !/^ELI10: \S/.test(explanation) || /^ELI10:\s*(?:".*"|“.*”)\s*$/.test(explanation) ||
      /^(?:ELI10:\s*)?(?:source|quoted|historical|example|hypothetical)\b/i.test(explanation) ||
      lines.filter(line => /^Project\/branch\/task:/.test(line)).length !== 1 ||
      lines.filter(line => /^ELI10:/.test(line)).length !== 1 ||
      /\b(?:copied|quoted|historical|hypothetical)\b/i.test(metadata)) return;
  if (q.options.some(option => !prose(option.description ?? '', true).trim()) ||
      /\b(?:this|the|that) (?:issue|finding|decision) (?:is|was|has been) ["“'‘]?(?:withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|hypothetical|not current|no longer current)\b/i.test(text)) return;
  const clean = (s: string) => s.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  const tokens = marked.lexer(savedPlan);
  const ledgers = tokens.flatMap((t, i) => t.type === 'heading' && /^Decision ledger$/i.test(clean(t.text)) ? [i] : []);
  if (ledgers.length !== 1) return;
  const start = ledgers[0]!, heading = tokens[start]!;
  if (heading.type !== 'heading') return;
  const currentHeading = (at: number) => {
    const ancestors: Array<{ depth: number; text: string }> = [];
    for (const token of tokens.slice(0, at + 1)) if (token.type === 'heading') {
      while (ancestors.length && ancestors.at(-1)!.depth >= token.depth) ancestors.pop();
      ancestors.push(token);
    }
    return !ancestors.some(owner => {
      const previous = tokens.slice(0, tokens.findIndex(token => token.type === 'heading' && token === owner))
        .filter(token => token.type !== 'space').at(-1);
      return /\b(?:copied|quoted|historical|history|example|hypothetical|template|archived|withdrawn|superseded)\b/i.test(clean(owner.text)) ||
        previous?.type === 'paragraph' && /\b(?:source|quoted|copied|historical|example|hypothetical|template|archived)\b[^\n]*[:：]\s*$/i.test(previous.raw);
    });
  };
  if (!currentHeading(start)) return;
  // A named plan may inherit its file identity only from this report's one
  // current target declaration and matching title, never from quoted examples.
  const sourceNames = [...metadata.matchAll(/\b[\w./-]+\.md\b/g)].map(match => match[0]);
  const rawSourceNames = [...(lines[1] ?? '').matchAll(/\b[\w./-]+\.md\b/g)];
  const directSource = sourceNames.length > 0 && sourceNames.every(name => name === 'PLAN.md') &&
    new Set([...metadata.matchAll(/\bPLAN\.md:([1-9]\d*(?:[-–][1-9]\d*)?)\b/g)].map(match => match[1])).size <= 1;
  const targetName = (s: string) => clean(s).replace(/^Eng(?:ineering)? review(?: report)?\s*[:—–-]\s*/i, '')
    .replace(/^Plan\s*[:—–-]\s*/i, '').toLowerCase();
  const named = [...(lines[1] ?? '').matchAll(/"(Plan:\s*[^"\n]+)"|“(Plan:\s*[^”\n]+)”|\b[Pp]lan\s+"([^"\n]+)"|\b[Pp]lan\s+“([^”\n]+)”/g)]
    .map(match => targetName(match[1] ?? match[2] ?? match[3] ?? match[4]!));
  const titles = tokens.slice(0, start).filter(token => token.type === 'heading' && token.depth === 1);
  // Target declarations are fields, whatever their list or emphasis markup.
  const targetFields = tokens.slice(0, start).flatMap((token, at) => {
    if ((token.type !== 'paragraph' && token.type !== 'list') || !currentHeading(at)) return [];
    const previous = tokens.slice(0, at).filter(t => t.type !== 'space').at(-1);
    const quotedContext = /\b(?:quoted|copied|historical|example|hypothetical|archived)\b[^\n]*:\s*$/i;
    if (previous?.type === 'paragraph' && quotedContext.test(previous.raw)) return [];
    // A declaration may open a later sentence of its line ("Report destination
    // requested by the user. Review target (fixed): `PLAN.md` in ..."); each
    // sentence start is a field position, a mid-sentence mention is not.
    const parts = token.raw.split('\n').flatMap(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_]/g, '').trim()
      .split(/(?<=[.!?])\s+(?=[A-Z])/));
    return parts.filter((line, i) => TARGET_FIELD.test(line) &&
      !parts.slice(0, i).some(part => quotedContext.test(part)));
  });
  const targetFiles = targetFields.length === 1 ? [...targetFields[0]!.matchAll(/[\w./-]*[\w-]+\.md\b/g)].map(match => match[0]) : [];
  // An unsourced brief inherits the report's one current PLAN.md target; its
  // ledger record still supplies the cited finding. A brief that names its plan
  // must name the report title's plan, and an unfenced copy of that plan may
  // add its own H1 only when it names that same plan.
  const namedSource = !rawSourceNames.length && named.length <= 1 && titles.length >= 1 &&
    titles[0]!.type === 'heading' && currentHeading(tokens.indexOf(titles[0]!)) &&
    targetFiles.length === 1 && targetFiles[0]!.split('/').at(-1) === 'PLAN.md' &&
    (named.length === 0 || /^Eng(?:ineering)? review(?: report)?\s*[:—–-]\s*\S/i.test(clean(titles[0]!.text)) &&
      titles.every(title => title.type === 'heading' && targetName(title.text) === named[0]));
  if (!directSource && !namedSource) return;
  const withdrawn = (value: string, owners: string) => new RegExp(
    `(?:^|[.!?;]\\s+|\\n)(?:Correction:\\s*)?(?:${owners}) (?:is|was|has been) ["“'‘]?(?:withdrawn|cancelled|canceled|rejected|superseded|resolved|closed|hypothetical|not current|no longer current)\\b`, 'i').test(prose(value, true));
  const decisionOwner = `D${decision[1].replace('.', '\\.')}`;
  if (withdrawn(q.question, decisionOwner)) return;
  const previous = tokens.slice(0, start).filter(t => t.type !== 'space').at(-1);
  if (previous && /\b(?:copied|quoted|historical|example|hypothetical|template)\b.*[:：]\s*$/i.test(previous.raw)) return;
  // Records may continue in the current Architecture/Code quality/Tests/Performance
  // sections. Their typed fields own the choice; the ledger need not be contiguous.
  const end = tokens.findIndex((token, at) => at > start && token.type === 'heading' && /^GSTACK REVIEW REPORT$/i.test(clean(token.text)));
  const recordEnd = end < 0 ? tokens.length : end;
  const recordSection = (at: number, depth: number) => {
    const owner = tokens.slice(0, at).filter(token => token.type === 'heading' && token.depth < depth).at(-1);
    if (!owner || owner.type !== 'heading') return false;
    const name = clean(owner.text).replace(/^(?:Section\s+)?[1-9]\d*(?:[.:]|\s+[—–-])?\s*/i, '');
    return /^Decision ledger$/i.test(name) || /^(?:Architecture|Code quality|Tests?|Testing|Performance) review(?:\s*[—–:-]\s+[A-Za-z0-9][A-Za-z0-9 ,/()&-]*)?$/i.test(name);
  };
  const words = (s: string) => (clean(s).toLowerCase().replace(/\(recommended\)/g, '').match(/[a-z][a-z0-9_]*/g) ?? [])
    .filter(word => !['the', 'a', 'an', 'and', 'or', 'with', 'to', 'of', 'as', 'is', 'it', 'one', 'first', 'now', 'option', 'recommended', 'planned'].includes(word));
  const captionWords = (s: string) => words(s.replace(/['’]s\b/g, '')).filter(word =>
    !['by', 'on', 'at', 'per', 'then', 'only', 'what', 'how', 'should', 'does', 'each', 'every'].includes(word))
    .map(word => word.length > 4 && /ies$/.test(word) ? word.slice(0, -3) + 'y'
      : word.length > 3 && /s$/.test(word) && !/ss$/.test(word) ? word.slice(0, -1) : word);
  const inlineLabelScore = (native: string, saved: string) => {
    const modifiers = (s: string) => s.replace(/\b([a-z][a-z0-9_]*)-keyed\b/gi, 'keyed by $1');
    const left = captionWords(modifiers(native)), right = captionWords(modifiers(saved));
    const negated = (ws: string[]) => ws.some(word => ['no', 'not', 'never', 'without', 'dont'].includes(word));
    // Normalize the keyed modifier, then preserve action/operand order. A
    // caption cannot swap the source and destination of the same operation.
    if (left.length < 2 || right.length < 2 || left[0] !== right[0] || negated(left) !== negated(right)) return 0;
    let cursor = 0;
    for (const word of left) {
      const at = right.indexOf(word, cursor);
      if (at < 0) return 0;
      cursor = at + 1;
    }
    return left.length / right.length;
  };
  const labelScore = (native: string, saved: string) => {
    const normalize = (s: string) => clean(s).replace(/^[A-D][).:]\s+/, '')
      .replace(/\s*\(recommended\)/gi, '').toLowerCase()
      // Both captions defer this choice. An appended implementation action
      // is not part of the equivalence.
      .replace(/^(?:decide at|leave to) implementation(?: time)?$/, 'defer to implementation');
    if (normalize(native) === normalize(saved)) return 3;
    const left = words(normalize(native)), right = words(normalize(saved));
    const negated = (tokens: string[]) => tokens.some(word => ['no', 'not', 'never', 'without', 'dont'].includes(word));
    if (Math.min(left.length, right.length) < 2 || negated(left) !== negated(right)) return 0;
    if (normalize(saved).startsWith(normalize(native) + ' ')) return 2;
    // Native captions may abbreviate the saved caption, but cannot introduce
    // a different action. Every native content word must occur in order in
    // the saved label; a short abbreviation must retain its first letter.
    let cursor = 0, exact = 0;
    for (const word of left) {
      const found = right.findIndex((candidate, at) => at >= cursor && (candidate === word ||
        word.length >= 2 && word.length <= 3 && candidate.length > word.length && candidate[0] === word[0] &&
        new RegExp('^' + [...word].join('.*')).test(candidate)));
      if (found < 0) return 0;
      if (right[found] === word) exact++;
      cursor = found + 1;
    }
    return exact >= 2 ? left.length / right.length : 0;
  };
  const matches: string[] = [];
  for (let i = start + 1; i < recordEnd; i++) {
    const record = tokens[i]!;
    if (record.type !== 'heading') continue;
    const id = /^(R[1-9]\d*(?:[a-z][a-z0-9]*)?):\s+\S/.exec(clean(record.text))?.[1];
    if (!id || !currentHeading(i) || !recordSection(i, record.depth) || withdrawn(q.question, id)) continue;
    let stop = i + 1;
    while (stop < recordEnd && !(tokens[stop]!.type === 'heading' && (tokens[stop] as any).depth <= record.depth)) stop++;
    const body = tokens.slice(i + 1, stop);
    if (withdrawn(body.filter(t => t.type === 'paragraph').map(t => t.raw).join('\n'), `${id}|${decisionOwner}`)) continue;
    const paragraphs = body.filter(t => t.type === 'paragraph').map(t => t.raw);
    const fields = paragraphs.join('\n').split('\n').map(line => line.replace(/\*\*/g, '').trim());
    const field = (name: string) => fields.filter(line => line.startsWith(name + ':')).map(line => line.slice(name.length + 1).trim());
    const finding = field('Finding'), baseline = field('Plan baseline'), state = field('State');
    if (finding.length !== 1 || baseline.length !== 1 || !baseline[0] || state.length !== 1 ||
        !/^(?:pending|approved)$/i.test(state[0]!) ||
        /\b(?:copied|quoted|historical|example|hypothetical|withdrawn|superseded)\b/i.test(finding[0]!)) continue;
    const marker = `Question D${decision[1]}:`;
    const questions = fields.flatMap((line, at) => line.startsWith(marker) ? [at] : []);
    if (questions.length !== 1) continue;
    const inlineBrief = fields[questions[0]!]!.slice(marker.length).trim();
    const inline = Boolean(inlineBrief);
    if (!inline && clean(fields[questions[0]! + 1] ?? '') !== clean(title)) continue;
    const sources = [...finding[0]!.matchAll(/\b([\w./-]+\.md)(?::([1-9]\d*(?:[-–][1-9]\d*)?))?\b/g)];
    if (sources.length !== 1 || sources[0]![1] !== 'PLAN.md' ||
        !inline && !sources[0]![2] || source && sources[0]![2] !== source) continue;
    if (inline) {
      const topic = captionWords(`${record.text} ${inlineBrief.split('Options:')[0]}`);
      const nativeTopic = new Set(captionWords(`${q.header} ${title}`));
      const completeOptions = q.options.every(option => {
        const description = prose(option.description ?? '', true).replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, '').trim();
        const blocks = [...description.matchAll(/([✅❌])\s*([^✅❌]+)/g)];
        return description.startsWith('✅') && blocks.every(block => /[A-Za-z0-9]/.test(block[2]!)) &&
          blocks.filter(block => block[1] === '✅').length >= 2 && blocks.some(block => block[1] === '❌');
      });
      const sameId = tokens.slice(start + 1, recordEnd).filter(token => token.type === 'heading' &&
        new RegExp(`^${id}:`).test(clean(token.text)));
      if (!completeOptions || sameId.length !== 1 || new Set(topic.filter(word => nativeTopic.has(word))).size < 2 ||
          [...title.matchAll(/\bD[1-9]\d*(?:\.[1-9]\d*)?\b/g)].length !== 1 ||
          /["“'‘][^"”'’\n]*\b[\w./-]+\.md\b/.test(finding[0]!) ||
          /^(?:["“'‘`]|quoted\b|copied\b|historical\b|example\b|hypothetical\b)/i.test(inlineBrief)) continue;
    }
    // The source requires the complete brief, not a literal Options field.
    // Read option records only inside this Question block, before answer/history.
    // Code, quotations and foreign blocks never contribute saved option labels.
    const briefLines = body.flatMap(token => token.type === 'paragraph' ? token.raw.split('\n') :
      token.type === 'list' ? token.items.flatMap(item => item.tokens.filter(child => child.type === 'text' || child.type === 'paragraph').flatMap(child => child.raw.split('\n'))) : [])
      .map(line => line.replace(/\*\*/g, '').replace(/^\s*[-*+]\s+(?=[A-D][).:]\s)/, '').trim());
    const questionAt = briefLines.findIndex(line => line.startsWith(marker));
    if (questionAt < 0) continue;
    const remaining = inline ? [inlineBrief.includes('Options:') ? inlineBrief.slice(inlineBrief.indexOf('Options:')) : '',
      ...briefLines.slice(questionAt + 1)] : briefLines.slice(questionAt + 2);
    const boundary = remaining.findIndex(line => /^(?:Question D[1-9]\d*(?:\.[1-9]\d*)?|Finding|Plan baseline|Runtime evidence|State|Actual answer|Accepted scope|History):/.test(line));
    let brief = remaining.slice(0, boundary < 0 ? remaining.length : boundary);
    // A copied complete question may already deliberate its A-D choices.
    // Explicit native fields own the offered options; question prose cannot
    // supply a second set or lend another question's choices to this record.
    const headers = brief.flatMap((line, at) => /^Header:/.test(line) ? [at] : []);
    if (headers.length) {
      const options = brief.flatMap((line, at) => /^Options:/.test(line) ? [at] : []);
      // Selectors bind options independently of presentation order. Native
      // labels may already own one; conflicting or repeated prefixes cannot
      // manufacture another choice or borrow its full description.
      const nativeOptions = q.options.map((option, at) => {
        const label = clean(option.label), prefix = /^([A-D])[).:]\s+/.exec(label);
        const selector = prefix?.[1];
        const caption = prefix ? label.slice(prefix[0].length) : label;
        return { selector, label: caption, description: option.description ?? '' };
      });
      const selectors = q.options.map((_, at) => String.fromCharCode(65 + at));
      const explicitSelectors = nativeOptions.flatMap(option => option.selector ? [option.selector] : []);
      if (new Set(explicitSelectors).size !== explicitSelectors.length ||
          nativeOptions.some(option => option.selector && !selectors.includes(option.selector) || !option.label || /^[A-D][).:]\s+/.test(option.label))) continue;
      // The preamble's `(recommended)` suffix marks the recommendation; it is not part of the choice.
      const unmarked = (label: string) => clean(label).replace(/\s*\(recommended\)$/i, '');
      const readOptions = (lines: string[]) => {
        const records: Array<{ selector: string; label: string; description: string[] }> = [];
        for (const line of lines) {
          const label = /^([A-D])[).:]\s+(.+)$/.exec(line);
          if (label) records.push({ selector: label[1]!, label: label[2]!, description: [] });
          else if (records.length) records.at(-1)!.description.push(line);
          else if (line.trim()) return undefined;
        }
        if (records.length !== nativeOptions.length || new Set(records.map(record => record.selector)).size !== records.length ||
            records.some(record => !selectors.includes(record.selector))) return undefined;
        const matches = records.map(record => nativeOptions.flatMap((native, at) =>
          (!native.selector || native.selector === record.selector) && unmarked(record.label) === unmarked(native.label) &&
            clean(record.description.join('\n')) === clean(native.description) ? [at] : []));
        return matches.every(match => match.length === 1) && new Set(matches.flat()).size === records.length ? records : undefined;
      };
      // Explicit Options fields are authoritative. Matching question prose
      // cannot repair an abbreviated description or contradictory choice.
      const optionRecords = options.length === 1 && clean(brief[options[0]!]!) === 'Options:'
        ? readOptions(brief.slice(options[0]! + 1)) : undefined;
      if (inline || headers.length !== 1 || options.length !== 1 || !optionRecords ||
          field('Header').length !== 1 || field('Options').length !== 1 || field('Actual answer').length !== 1 ||
          options[0]! <= headers[0]! || brief.slice(headers[0]! + 1, options[0]!).some(line => line.trim()) ||
          clean(brief[headers[0]!]!.slice('Header:'.length)) !== clean(q.header) ||
          !(() => {
            const question = [title, ...brief.slice(0, headers[0])];
            const native = clean(prose(q.question, true));
            if (clean(prose(question.join('\n'), true)) === native) return true;
            const deliberations = question.flatMap((line, at) => /^Pros\s*\/\s*cons:$/i.test(line) ? [at] : []);
            if (deliberations.length !== 1) return false;
            const at = deliberations[0]!;
            // A copied deliberation block owns the same complete alternatives,
            // even when the native UI presents its recommended choice first.
            for (let end = at + 2; end <= question.length; end++) {
              if (!readOptions(question.slice(at + 1, end))) continue;
              return clean(prose([...question.slice(0, at), ...question.slice(end)].join('\n'), true)) === native;
            }
            return false;
          })()) continue;
      // The grid's A-D columns use selector order, not menu presentation order.
      brief = [...optionRecords].sort((a, b) => a.selector.localeCompare(b.selector))
        .flatMap(record => [`${record.selector}) ${record.label}`, ...record.description]);
    }
    if (brief.some(line => /^(?:quoted|copied|historical|example|hypothetical|template)(?:\s+[^:]*)?:/i.test(line))) continue;
    const labels: Array<[string, string, string]> = [];
    for (const line of brief) {
      // Compact and expanded briefs use the same A-D records. Descriptions
      // remain prose; their mentions of options cannot define another label.
      const content = line.replace(/^Options:\s*/, '');
      if (!/^[A-D][).:]\s+\S/.test(content)) continue;
      for (const match of content.matchAll(/(?:^|\s)([A-D])[).:]\s+(.+?)(?=\s+[A-D][).:]\s+|$)/g))
        labels.push([match[0], match[1]!, match[2]!]);
    }
    if (labels.length !== q.options.length || labels.some((label, index) => label[1] !== String.fromCharCode(65 + index))) continue;
    const comparisons = body.filter(t => t.type === 'table').filter(table => {
      if (table.type !== 'table') return false;
      const headers = table.header.map(c => clean(c.text));
      const columnIds = headers.slice(2).map(header => /^([A-D])(?:[).:]?\s+\S.*)?$/.exec(header)?.[1]);
      // The role is Current; a baseline-context caption may qualify it. Do
      // not strip arbitrary parenthetical prose: historical/proposed/negated
      // values cannot masquerade as the current baseline column.
      const currentColumn = /^Current(?:\s+\((?:(?:approved|original) )?(?:plan(?: baseline)?|baseline|proposal)\))?$/i.test(headers[1] ?? '');
      if (headers[0] !== 'Choice' || !currentColumn ||
          JSON.stringify(columnIds) !== JSON.stringify(q.options.map((_, at) => String.fromCharCode(65 + at)))) return false;
      // R5a/R5b are dimensions of the one R5 decision, not extra asks. Keep
      // the record boundary and unique row identities; R50 is another issue.
      const rows = table.rows.filter(row => new RegExp(`^${id}(?:[a-z])?\\b`).test(clean(row[0]!.text)));
      const rowIds = rows.map(row => {
        const caption = clean(row[0]!.text);
        const explicit = new RegExp(`^(${id}[a-z])\\b`).exec(caption)?.[1];
        // Lettered dimensions have explicit identities. Bare R rows instead
        // identify their distinct commitments by the complete caption.
        return explicit ?? caption.toLowerCase();
      });
      if (!rows.length || new Set(rowIds).size !== rowIds.length || rows.some(row => !row.every(cell => clean(cell.text)))) return false;
      const optionColumns = q.options.map(option => {
        const scores = labels.map((label, at) => {
          const direct = labelScore(option.label, label[2]!) || inline && inlineLabelScore(option.label, label[2]!);
          const caption = headers[at + 2]!.replace(/^[A-D][).:]?\s*/, '');
          const captionWords = words(caption), savedWords = words(label[2]!);
          const negated = (tokens: string[]) => tokens.some(word => ['no', 'not', 'never', 'without', 'dont'].includes(word));
          // A descriptive header belongs to its existing A/B/C option. It
          // cannot relabel a contradictory saved choice or lend another
          // column's action to a short native caption.
          const boundCaption = captionWords.filter(word => savedWords.includes(word)).length >= 2 &&
            negated(captionWords) === negated(savedWords);
          if (inline && !boundCaption && !rows.some(row => labelScore(label[2]!, row[at + 2]!.text) ||
              inlineLabelScore(label[2]!, row[at + 2]!.text))) return 0;
          const captionScore = boundCaption ? labelScore(option.label, caption) || inline && inlineLabelScore(option.label, caption) : 0;
          // Extra native detail must also exist in that option's saved grid
          // column; a shared caption cannot authorize an added action.
          const extendsCaption = clean(option.label).toLowerCase().startsWith(clean(label[2]!).toLowerCase() + ' ');
          return direct || captionScore || extendsCaption && Math.max(...rows.map(row => labelScore(option.label, row[at + 2]!.text))) || 0;
        });
        const best = Math.max(...scores);
        return best > 0 && scores.filter(score => score === best).length === 1 ? scores.indexOf(best) : -1;
      });
      return !optionColumns.includes(-1) && new Set(optionColumns).size === q.options.length;
    });
    if (comparisons.length === 1) matches.push(`record:${id}`);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Fixture-local identity memory prevents re-asks from inflating the floor,
 * even after a reopened row replaces its earlier saved question. */
export function createEngBatchingIssueCounter(readPlan: () => string,
  isSetup: (fp: AskUserQuestionFingerprint) => boolean) {
  const seen = new Set<string>();
  const trace: Array<{ signature: string; issue: string; source: 'native' | 'saved-ledger' }> = [];
  return {
    trace,
    isReviewAUQ(fp: AskUserQuestionFingerprint, priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
      const call = fp.nativeCall;
      if (!call || fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
          (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
          priorCalls.some(prior => prior.sessionId !== call.sessionId || prior.toolUseId === call.toolUseId) ||
          !completedDecision(call, 0, Date.now()) || call.questions.length !== 1 || isSetup(fp)) return false;
      const q = call.questions[0]!;
      if (fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
      const native = batchingIssueNumber(call);
      if (native && !isEngBatchingIssueAUQ(fp, priorCalls)) return false;
      const issue = native ?? recordedBatchingIssue(call, readPlan());
      if (!issue || seen.has(issue)) return false;
      seen.add(issue); trace.push({ signature: fp.signature, issue, source: native ? 'native' : 'saved-ledger' });
      return true;
    },
  };
}
