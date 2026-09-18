import { marked } from 'marked';
import { engSetupAUQ, type AskUserQuestionFingerprint } from './claude-pty-runner';
import type { NativePlanQuestionCall } from './plan-count-transcript';

type Seed = 'dispatcher' | 'lookup' | 'email' | 'tests' | 'orders';
type Finding = { seed: Seed; ledgerId: string; phase: string; signature: string };
const plain = (value: string) => value.replace(/[`*_]/g, '').trim();
const option = (value: string) => plain(value).replace(/^[A-D][).]\s*/, '').replace(/\s*\(recommended\)$/i, '');

// A numeric zero and "no" state the same current coverage absence. Keep
// quantified negation and historical/quoted claims out of the seeded defect.
function hasCurrentTestAbsence(value: string): boolean {
  const text = prose(value.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ''));
  return text.split(/(?<=[.!?])\s+|\n/).some(clause => {
    if (!current(clause) || /\b(?:previously|formerly|historical|used to|in the past|(?:prior|earlier|old) (?:plan|version))\b/i.test(clause)) return false;
    const absent = /\b(?:(?:no|zero|0) (?:automated )?(?:tests?|coverage)|none planned|never (?:runs|executes))\b/gi;
    return [...clause.matchAll(absent)].some(match => !/\b(?:not|never|no longer|more than|greater than|less than|at least|at most|over|above|under|below|up to|(?:do|does|did|is|are|was|were|has|have|had|could|would|should|must)n['’]t|can['’]t|won['’]t|cannot)\s+(?:(?:currently|now|yet|still|already|actually|exactly|just|only|have|has|had|contain|contains|include|includes|provide|provides|run|runs|ship|ships)\s+)*$/i.test(clause.slice(0, match.index)));
  });
}

// Finite obligations from this fixture's supplied plan. These match the
// behavior under discussion, not decision numbers, option labels, class names
// chosen for a remedy, or a particular generated sentence.
const obligations: Array<{ seed: Seed; subject: RegExp; defect: { test(value: string): boolean }; remedy: RegExp }> = [
  { seed: 'dispatcher', subject: /\b(?:dispatcher|WebhookDispatcher|routing)\b/i,
    defect: /\b(?:bypass\w*|skip\w*|separate (?:entry|routing)|second (?:path|front door|routing))\b/i,
    remedy: /\b(?:register\w*|reus\w*|route\w*|single routing|one routing)\b/i },
  { seed: 'lookup', subject: /\b(?:SQL|query|lookup|userId|DB|database|parameter)\b/i,
    defect: /\b(?:raw|concatenat\w*|interpolat\w*|glue\w*|splice\w*)\b/i,
    remedy: /\b(?:bound parameter|bind\w*|parameteriz\w*|prepared statement|ORM|find_by)\b/i },
  { seed: 'email', subject: /\b(?:mail|email|notification|receipt)\b/i,
    defect: /\b(?:no error handling|propagat\w*|escape\w*|unhandled|uncaught|rethrow\w*)\b/i,
    remedy: /\b(?:rescue|catch|handle|isolate|isolation|enqueue|queue|background job)\b/i },
  { seed: 'tests', subject: /\b(?:tests?|coverage|suite)\b/i,
    defect: { test: hasCurrentTestAbsence },
    remedy: /\b(?:add|write|implement|handler|unit|integration|regression)\b/i },
  { seed: 'orders', subject: /\b(?:orders?|query|queries)\b/i,
    defect: /\b(?:per-order|one query per order|N\+1|(?:fetch\w*|quer\w*)[^.]*loop)\b/i,
    remedy: /\b(?:batch\w*|single (?:orders )?query|one (?:bound-parameter )?query|bulk)\b/i },

];

// Use only current prose. Quoted/code blocks never supply a defect, remedy,
// or ledger. Inline code identifiers retain their literal technical names.
function prose(value: string): string {
  return marked.lexer(value).filter(t => !['code', 'blockquote', 'html'].includes(t.type))
    .map(t => plain(t.raw)).join('\n');
}
function current(value: string): boolean {
  return !/^[\x60\"'“‘]/.test(value.trim()) && !/\bno (?:current )?(?:defect|gap|issue|problem)\b/i.test(value) && !/^(?:example|quoted|historical|source|hypothetical|previously|formerly|if|unless)\b/i.test(value.trim()) &&
    !/\b(?:this|that|the) (?:finding|issue|decision|defect|assessment|remedy) (?:is|was|has been) (?:already |now )?(?:resolved|fixed|withdrawn|retracted|not current|superseded|historical|quoted)\b/i.test(value);
}
function currentDocumentContext(tokens: ReturnType<typeof marked.lexer>, index: number): boolean {
  const headings: Array<{ depth: number; text: string }> = [];
  for (const token of tokens.slice(0, index)) if (token.type === 'heading') {
    while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
    headings.push({ depth: token.depth, text: plain(token.text) });
  }
  return headings.every(heading => current(heading.text));
}
function currentDocumentSources(tokens: ReturnType<typeof marked.lexer>): string[] {
  // A source declaration is metadata, not the historical/source quotation
  // excluded by current(). Use one grammar for recognition and currentness,
  // including foreign/duplicate declarations; callers still require one PLAN.md.
  const label = '(?:Source(?: (?:plan|document|file))?(?: under review)?|(?:Plan|Document|File) under review|(?:Reviewed|Review target|Input) plan)';
  const declaration = new RegExp(`^${label}:\\s*`, 'i');
  const active = (value: string) => current(value.replace(declaration, 'Review attribution: ')) &&
    !/\b(?:history|historical|archiv(?:ed|al)|withdrawn|retracted|superseded|obsolete|cancelled|canceled|not current|no longer current|previously|formerly|hypothetical)\b/i.test(value) &&
    !/\b(?:if|unless|might|may|would|could)\b/i.test(value);
  const headings: Array<{ depth: number; text: string }> = [];
  return tokens.flatMap(token => {
    if (token.type === 'heading') {
      while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
      headings.push({ depth: token.depth, text: plain(token.text) });
    }
    if (token.type !== 'paragraph' || !headings.every(h => active(h.text)) || /^[`"'“‘]/.test(token.raw.trim())) return [];
    const text = plain(token.raw);
    if (!active(text)) return [];
    return text.split(/(?<=[.!?])\s+|\n/).flatMap(statement => {
      const match = declaration.exec(statement.trim());
      if (!match || !active(statement)) return [];
      const field = statement.trim().slice(match[0].length).trim();
      const path = /^([\w./-]+)(?=$|[\s,;!?])/.exec(field);
      if (!path) return [field];
      // A declaration names one path, optionally followed by source location,
      // revision or copy metadata. Unknown tails and additional document paths
      // remain non-PLAN records, never a silently discarded second declaration.
      const suffix = field.slice(path[1]!.length);
      if (suffix.trim() && !/^(?:[.,;]$|\(|@|(?:at|in|on|for)\b|L\d+\b|Validation\b)/i.test(suffix.trim())) return [field];
      const references = (value: string) => [...value.matchAll(/\b[\w./-]+\.(?:md|markdown)\b/gi)];
      const attribution = suffix.replace(/\(([^()]*)\)/g, (whole, metadata: string) =>
        /^(?:copied(?: byte-identically)? (?:in|into|to)|byte-identical to the plan embedded in)\s+/i.test(metadata) &&
        references(metadata).length === 1 ? '' : whole);
      if (references(attribution).length) return [field];
      return [path[1]!.replace(/[.;,]+$/, '')];
    });
  });
}

// The ledger enumerates "unresolved" while its procedure calls these rows
// pending. Normalize only that unqualified current scalar, never a quoted,
// compound or inactive status. The five existing dispositions keep their rules.
function pendingRowContext(tokens: ReturnType<typeof marked.lexer>, index: number, owner = ''): boolean {
  const active = (text: string) => current(text) &&
    !/\b(?:historical|archiv(?:ed|al)|withdrawn|retracted|superseded|obsolete|cancelled|canceled|not current|no longer current)\b/i.test(text);
  const headings: Array<{ depth: number; text: string }> = [];
  for (const token of tokens.slice(0, index + 1)) if (token.type === 'heading') {
    while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
    headings.push({ depth: token.depth, text: plain(token.text) });
  }
  return active(owner) && headings.every(heading => active(heading.text));
}
function ledgerStatus(value: string, tokens: ReturnType<typeof marked.lexer>, index: number,
  owner: string, evidence: string, sourcePlan: string): string {
  const status = plain(value);
  if (!/^pending$/i.test(status)) return status;
  const sources = currentDocumentSources(tokens);
  return pendingRowContext(tokens, index, owner) && current(evidence) &&
    sources.length === 1 && sources[0] === 'PLAN.md' && !hasForeignContractSource(evidence, sourcePlan)
    ? 'unresolved' : '';
}
// An existing suite can provide zero coverage of the new implementation.
// The owned test row supplies that scope; historical quotes and current
// positive/contradictory coverage statements cannot establish its absence.
function excludesCurrentTestTarget(value: string): boolean {
  const text = prose(value.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ''));
  const clauses = text.split(/(?<=[.!?])\s+|\n/).filter(clause => current(clause) &&
    !/\b(?:previously|formerly|historical(?:ly)?|used to|(?:prior|earlier|old) (?:plan|version))\b/i.test(clause));
  if (clauses.some(clause => /\b(?:not true|false|not the case)\b/i.test(clause) ||
    /\b(?:suite|tests?)\s+(?:(?:now|already|also|fully|directly|does|do)\s+)*(?:covers?|exercises?|executes?|tests?|runs?)\s+(?:the\s+)?(?:new|this|current)\s+(?:class|handler|code|path|implementation)\b/i.test(clause))) return false;
  return clauses.some(clause => /\b(?:suite|tests?|coverage)\b/i.test(clause) && (
    /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?(?:cover|exercise|execute|test|run)s?\s+(?:the\s+)?(?:new|this|current)\s+(?:class|handler|code|path|implementation)\b/i.test(clause) ||
    /\b(?:suite|tests?)\s+(?:(?:only|still)\s+)?(?:covers?|exercises?|executes?|tests?|runs?)\s+(?:the\s+)?(?:old|prior)\s+(?:class|handler|code|path|implementation)\s*[,;]?\s*(?:but\s+)?not\s+(?:this one|(?:the\s+)?new\s+(?:class|handler|code|path|implementation))\b/i.test(clause)));
}

// A Contracts citation inherits the document's unique current source only
// when its substantive quotation is a complete current source clause. It
// never borrows arbitrary quoted examples or a partial substring elsewhere.
function currentContractQuote(literal: string, sourcePlan: string): boolean {
  const normalize = (text: string) => plain(text).replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim();
  const active = (text: string) => current(text) && !/\b(?:withdrawn|retracted|superseded|historical|obsolete|no longer current|not current)\b/i.test(text);
  const tokens = marked.lexer(sourcePlan);
  const clauses = tokens.flatMap((token, index) => token.type === 'paragraph' &&
      currentDocumentContext(tokens, index) && active(token.raw)
    ? plain(token.raw).replace(/\s+/g, ' ').split(/(?<=[.;])\s+/).filter(active).map(normalize) : []);
  return active(literal) && clauses.filter(clause => clause === normalize(literal)).length === 1;
}
function hasForeignContractSource(value: string, sourcePlan: string): boolean {
  // Only authenticated source quotations can contain incidental code paths.
  // Quotation length alone must not hide a conflicting source citation.
  const attribution = value.replace(/"([^"\n]+)"|“([^”\n]+)”/g,
    (whole, straight, curly) => (straight ?? curly).trim().split(/\s+/).length >= 6 &&
      currentContractQuote(straight ?? curly, sourcePlan) ? '' : whole);
  const paths = [...attribution.matchAll(/(?:(?:(?:[A-Za-z]:|~)?[\\/]+|\.{1,2}[\\/])(?:[\w.-]+[\\/])*|(?:[\w.-]+[\\/])+)[\w.-]+|\b[\w-]+\.(?:md|markdown)\b/gi)];
  return paths.some(match => {
    const path = match[0];
    if (path === 'PLAN.md') return false;
    // A slash alone also joins ordinary prose (read/write, success/failure).
    // Filesystem syntax, a filename extension or an explicit reference owns
    // a path; a compound in the surrounding explanation does not.
    if (!/[\\/]/.test(path) || /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/.test(path) ||
        /\\/.test(path) || /(?:^|[\\/])[^\\/]+\.[\w-]+/.test(path)) return true;
    const before = attribution.slice(0, match.index), after = attribution.slice(match.index! + path.length);
    return /^(?:[\\/]|:\d+\b|#[\w-]+)/.test(after) ||
      (/[`"'“‘<]$/.test(before) && /^[`"'”’>]/.test(after)) ||
      /\]\(\s*<?$/.test(before) || /(?:^|\n)\s*\[[^\]]+\]:\s*<?$/.test(before) ||
      /\b(?:source(?:\s+(?:plan|file))?|file|path|document|evidence|citation|reference)\s*[:=]\s*$/i.test(before) ||
      /\b(?:read|see|consult|from|per|according to|documented in|specified in|cited in)\s+$/i.test(before);
  });
}
function currentContractCitation(value: string, sourcePlan: string): boolean {
  if (!/^Contracts?:\s*\S/i.test(value) || hasForeignContractSource(value, sourcePlan)) return false;
  const normalize = (text: string) => plain(text).replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim();
  const active = (text: string) => current(text) && !/\b(?:withdrawn|retracted|superseded|historical|obsolete|no longer current|not current)\b/i.test(text);
  const outside = value.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  if (!active(outside)) return false;
  const quotes = [...value.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)].map(match => normalize(match[1] ?? match[2]!))
    .filter(literal => literal.split(' ').length >= 6);
  if (!quotes.length) return false;
  return quotes.every(literal => currentContractQuote(literal, sourcePlan));
}

// A whole quoted ledger value can cite the supplied plan's current prose.
// Authenticate its complete paragraph/sentence, not a substring or a quote
// elsewhere. This does not turn quoted evidence into a seeded defect.
function quotedSourceProposal(value: string, sourcePlan: string): boolean {
  const quoted = /^(?:"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|‘([^’\n]+)’)$/u.exec(value.trim());
  const literal = quoted?.slice(1).find(part => part !== undefined);
  if (!literal || !current(literal)) return false;
  const activeSource = (text: string) => current(text) &&
    !/\b(?:withdrawn|retracted|superseded|obsolete|historical|archiv(?:ed|al)|(?:no longer|not) current)\b/i.test(text);
  const headings: Array<{ depth: number; text: string }> = [];
  let matches = 0;
  for (const token of marked.lexer(sourcePlan)) {
    if (token.type === 'heading') {
      while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
      headings.push({ depth: token.depth, text: plain(token.text) });
    }
    if (token.type !== 'paragraph' || !headings.every(h => activeSource(h.text))) continue;
    const text = token.raw.trim();
    if (!activeSource(text)) continue;
    matches += text === literal ? 1 : text.split(/(?<=[.!?])\s+/).filter(sentence => sentence === literal).length;
  }
  return matches === 1;
}
const mentions = (text: string, id: string) => text.split(/[^A-Za-z0-9_.-]+/).some(token => token.replace(/[.:]$/, '') === id);

function ownedAnswer(fp: AskUserQuestionFingerprint): NativePlanQuestionCall | null {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
    fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
    (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
    !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
    !Number.isFinite(Date.parse(call.answeredAt ?? '')) || Object.keys(call.answers ?? {}).length !== 1) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
    new Set(q.options.map(o => o.label)).size !== q.options.length ||
    !q.options.some(o => o.label === call.answers?.[q.question]) ||
    fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return null;
  return call;
}

/** Setup may share one native packet. Authenticate the complete answer and
 * every offered tab before excluding it; a mixed setup/review packet is not setup. */
function ownedSetupPacket(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || fp.nativeQuestionIndex !== undefined ||
      call.questions.length < 2 || call.questions.length > 4 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      !Number.isFinite(Date.parse(call.answeredAt ?? '')) ||
      Object.keys(call.answers ?? {}).length !== call.questions.length ||
      new Set(call.questions.map(q => q.question)).size !== call.questions.length) return false;
  const options = call.questions.flatMap(q => q.options.map((o, i) => ({ index: i + 1, label: o.label })));
  if (fp.options.length !== options.length || !fp.options.every((o, i) =>
      o.index === options[i]!.index && o.label === options[i]!.label)) return false;
  if (!call.questions.every(q => !q.multiSelect && q.options.length >= 2 && q.options.length <= 4 &&
      new Set(q.options.map(o => o.label)).size === q.options.length &&
      typeof call.answers?.[q.question] === 'string' && q.options.some(o => o.label === call.answers[q.question]))) return false;
  // These per-question views feed only the bare content classifiers. The
  // original packet above owns authentication; a view is never a recorded call.
  return call.questions.every(q => setupQuestionContent({
    ...fp, promptSnippet: `${q.header} ${q.question}`,
    options: q.options.map((o, i) => ({ index: i + 1, label: o.label })),
    nativeCall: { ...call, questions: [q], answers: { [q.question]: call.answers?.[q.question]! } },
  }));
}

/** A question can attribute one offered baseline explicitly "as planned".
 * Its title, active ledger proposal and matching native option must agree;
 * ELI10 must still assert the current plan's behavior, not quoted history. */
function attributedBaselineDefect(q: NativePlanQuestionCall['questions'][number], proposed: string,
  explanation: string, spec: typeof obligations[number]): boolean {
  const unquoted = (text: string) => prose(text.replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’|`[^`]*`/g, ''));
  const title = unquoted(q.question.split('\n')[0]!).replace(/^D\d+\s*[—–-]\s*/i, '');
  if (!current(title) || !title.endsWith('?')) return false;
  const alternatives = [...title.matchAll(/(?:^|[:,;]\s*|\bor\s+)([^,;:?]+?)\s+as (?:planned|written)(?=\s*[,;?]|$)/gi)];
  if (alternatives.length !== 1) return false;
  const baseline = alternatives[0]![1]!.trim();
  const normalize = (value: string) => plain(value).toLowerCase().replace(/\s+/g, ' ').trim();
  const words = (value: string) => normalize(value).match(/[a-z0-9_]+/g) ?? [];
  const expected = words(baseline), actual = words(proposed);
  if (!current(baseline) || !spec.subject.test(baseline) || !spec.defect.test(baseline) ||
      expected.length < 2 || !actual.some((_, i) => expected.every((word, offset) => actual[i + offset] === word))) return false;
  const offered = q.options.filter(o => {
    const body=unquoted(`${o.label}\n${o.description ?? ''}`);
    return current(body) && !/\b(?:this|that|the) (?:option|alternative|baseline) (?:is|was|has been) (?:already |now )?(?:withdrawn|retracted|rejected|superseded|not current|historical)\b/i.test(body) &&
      normalize(option(o.label).replace(/^(?:keep|retain|preserve)\s+/i, '')
        .replace(/\s*\(as (?:planned|written)\)\s*$/i, '')) === normalize(baseline);
  });
  if (offered.length !== 1) return false;
  const clauses = unquoted(explanation).split(/(?<=[.!?])\s+|\n/);
  return clauses.some(clause => current(clause) && spec.subject.test(clause) &&
    /\b(?:the|this) (?:current )?plan\s+\S/i.test(clause) && !spec.remedy.test(clause) &&
    !/\b(?:previously|formerly|historical|example|hypothetical|if|unless|not|never|no longer|doesn't|does not)\b/i.test(clause));
}

/** Source requires Current/Proposed/Status/evidence and a cited row ID. It
 * does not require heading depth, column order, a Dn(ledger ID) title, or
 * native option wording. Pending is valid: the actual ACK precedes the next Edit. */
export function ceoPaymentFinding(fp: AskUserQuestionFingerprint, seedPlan: string, savedPlan: string): Finding | null {
  const call = ownedAnswer(fp);
  if (!call) return null;
  const q = call.questions[0]!;
  const question = prose(q.question);
  const explanation = /^ELI10:\s*(.+)$/m.exec(question)?.[1] ?? question;
  if (!question.trim() || !current(question) || !current(explanation)) return null;
  const options = q.options.map(o => prose(`${o.label}\n${o.description ?? ''}`)).filter(current);
  const tokens = marked.lexer(savedPlan);
  const declaredSources = currentDocumentSources(tokens);
  const namedSourcePlan = tokens.some(t => t.type === 'paragraph' &&
    /(?:^|\n)Source plan:\s*PLAN\.md\b/.test(plain(t.raw)));
  const matches: Finding[] = [];
  for (const table of tokens.filter(t => t.type === 'table')) {
    if (table.type !== 'table') continue;
    const column = (meaning: RegExp) => table.header.map((c, i) => meaning.test(plain(c.text)) ? i : -1).filter(i => i >= 0);
    const fields = { id: column(/^(?:ID|Decision)\b/i), current: column(/^Current\b/i),
      proposed: column(/^Proposed\b/i), status: column(/^Status\b/i), evidence: column(/\b(?:Contract|Evidence)\b/i) };
    if (Object.values(fields).some(indices => indices.length !== 1)) continue;
    for (const cells of table.rows) {
      const read = (key: keyof typeof fields) => plain(cells[fields[key][0]!]!.text);
      const owner = read('id'), id = owner.split(/\s/, 1)[0]!.replace(/[.:]$/, '');
      const pending = /^pending$/i.test(read('status'));
      const status = ledgerStatus(cells[fields.status[0]!]!.text, tokens, tokens.indexOf(table), owner, read('evidence'), seedPlan);
      const sourceBound = /\bPLAN\.md\b/.test(read('evidence')) ||
        (namedSourcePlan && /\bEvidence:\s*plan text\b/i.test(read('evidence')));
      if (!id || !mentions(question, id) || !/^(?:unresolved|approved|reopened|deferred|declined)\b/i.test(status) || !sourceBound) continue;
      // A row can contain its proposals directly or cite a separate saved
      // comparison bearing the same ID. Heading spelling/depth is immaterial.
      const blocks = tokens.map((t, i) => t.type === 'heading' && mentions(plain(t.text), id) ? i : -1).filter(i => i >= 0);
      if (pending && blocks.filter(index => pendingRowContext(tokens, index)).length > 1) continue;
      const proposals: Array<{ body: string; phase: string; active: boolean }> = [{ body: read('proposed'), phase: 'ledger row', active: currentDocumentContext(tokens, tokens.indexOf(table)) }];
      for (const start of blocks) {
        const heading = tokens[start]!;
        if (heading.type !== 'heading') continue;
        let end = start + 1;
        while (end < tokens.length && !(tokens[end]!.type === 'heading' && (tokens[end] as any).depth <= heading.depth)) end++;
        const preceding = tokens.slice(0, start).filter(t => t.type === 'heading' && t.depth < heading.depth).at(-1);
        proposals.push({ body: prose(tokens.slice(start + 1, end).map(t => t.raw).join('')), phase: preceding?.type === 'heading' ? preceding.text : heading.text, active: current(plain(heading.text)) && currentDocumentContext(tokens, start) && (!pending || pendingRowContext(tokens, start)) });
      }
      for (const spec of obligations) {
        const row = `${owner} ${read('evidence')} ${read('current')}`;
        // Current holds existing/approved behavior. A correct baseline can
        // still have a defective pending alternative in Proposed; keep that
        // defect bound to this active row, not a copied comparison elsewhere.
        const defectValue = (field: 'current' | 'proposed') => spec.seed === 'tests'
          ? cells[fields[field][0]!]!.text : read(field);
        const defectExplanation = spec.seed === 'tests'
          ? /^ELI10:\s*(.+)$/m.exec(q.question)?.[1] ?? q.question : explanation;
        const scopedTestAbsence = spec.seed === 'tests' && declaredSources.length === 1 && declaredSources[0] === 'PLAN.md' &&
          currentDocumentContext(tokens, tokens.indexOf(table)) && /\btests?\b/i.test(owner) &&
          /^(?:unresolved|reopened)\b/i.test(status) && current(read('current')) &&
          /^(?:None|zero|0|no (?:new )?(?:automated )?tests?)\.?$/i.test(cells[fields.proposed[0]!]!.text.trim()) &&
          excludesCurrentTestTarget(cells[fields.current[0]!]!.text) && excludesCurrentTestTarget(defectExplanation);
        const pendingDefect = /^(?:unresolved|reopened)\b/i.test(status) &&
          current(read('proposed')) && spec.subject.test(read('proposed')) && spec.defect.test(defectValue('proposed'));
        if (!spec.subject.test(seedPlan) || !spec.defect.test(seedPlan) || !spec.subject.test(row) ||
          !(spec.defect.test(defectValue('current')) || pendingDefect || scopedTestAbsence) ||
          !spec.subject.test(question) || !(spec.defect.test(defectExplanation) || scopedTestAbsence ||
            (pendingDefect && declaredSources.length <= 1 && declaredSources.every(source => source === 'PLAN.md') &&
              currentDocumentContext(tokens, tokens.indexOf(table)) && attributedBaselineDefect(q, read('proposed'), explanation, spec)))) continue;
        const operative = options.some(o => spec.remedy.test(o) && spec.subject.test(o));
        const proposal = proposals.find(p => (!(scopedTestAbsence || pending) || p.active) && current(p.body) && spec.remedy.test(p.body) && spec.subject.test(p.body));
        if (operative && proposal) matches.push({ seed: spec.seed, ledgerId: id, phase: proposal.phase, signature: fp.signature });
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function setupQuestion(fp: AskUserQuestionFingerprint): boolean {
  const call = ownedAnswer(fp);
  if (!call) return false;
  return setupQuestionContent(fp);
}
function setupQuestionContent(fp: AskUserQuestionFingerprint): boolean {
  const q = fp.nativeCall!.questions[0]!;
  const title = prose(q.question).split('\n')[0]!;
  const labels = q.options.map(o => option(o.label));
  if (/\b(?:skill routing|routing rules)\b/i.test(title) && /\bCLAUDE\.md\b/i.test(title))
    return labels.length === 2 && labels.some(l => /\b(?:add|enable|include|append)\b.*\brouting\b/i.test(l)) && labels.some(l => /\b(?:no thanks|skip|manually|manual)\b/i.test(l));
  // Authentication belongs to the complete original packet or single-call
  // wrapper; setup content needs no working-plan file yet.
  if (prose(q.question).trim() && current(prose(q.question)) && engSetupAUQ(fp)) return true;
  // Preserve the existing label-wrapper contract; the shared predicate
  // expects unnumbered action labels while this older route accepts wrappers.
  if (/\bcross[- ]project learnings\b/i.test(title) && /\b(?:enable|search)\b/i.test(title))
    return labels.length === 2 && labels.some(l => /\benable\b.*\bcross[- ]project\b/i.test(l)) && labels.some(l => /\bproject[- ]scoped\b/i.test(l));
  const modes = labels.map(l => l.match(/\b(?:SCOPE EXPANSION|SELECTIVE EXPANSION|HOLD SCOPE|SCOPE REDUCTION)\b/g));
  if (labels.length === 4 && modes.every(found => found?.length === 1) && new Set(modes.flat()).size === 4) return true;
  if (/\b(?:scope|review target)\b/i.test(title) && labels.some(l => /skip\s+interview|plan\s+immediately/i.test(l))) return true;
  if (/\boffice-hours\b/i.test(title) && labels.length === 2 && labels.some(l => /\brun\b.*office-hours/i.test(l)) && labels.some(l => /^skip\b/i.test(l))) return true;
  const remedyEvidence = obligations.some(spec => spec.subject.test(q.question) && spec.defect.test(q.question) &&
    q.options.some(o => spec.remedy.test(`${o.label} ${o.description ?? ''}`)));
  return !remedyEvidence && /\b(?:which|choose|select)\b.*\bapproach\b/i.test(title) && /^Approach$/i.test(q.header);
}
function todoDecision(fp: AskUserQuestionFingerprint): boolean {
  const q = fp.nativeCall!.questions[0]!;
  return /\bTODO(?:S\.md|s|[- ]\d+)?\b/i.test(q.header + ' ' + q.question.split('\n')[0]) &&
    q.options.some(o => /^(?:add|build|implement|remove|defer|skip)\b/i.test(option(o.label)));
}

/** Count other real choices by their saved decision identity, not a defect
 * vocabulary. A row alone is insufficient: its own complete comparison must
 * bind every offered native option. This grants count credit, not approval. */
function recordedDecision(fp: AskUserQuestionFingerprint, savedPlan: string, sourcePlan: string): { ledgerId: string; phase: string } | null {
  const call = ownedAnswer(fp);
  if (!call) return null;
  const q = call.questions[0]!, question = prose(q.question);
  if (!question.trim() || !current(question)) return null;
  const title = question.split('\n')[0]!;
  const tokens = marked.lexer(savedPlan);
  // A current document may declare its source once and cite that plan's
  // sections in each row. An unrelated mention elsewhere is not provenance.
  const currentContext = (index: number) => sectionContext(tokens, index) &&
    (tokens[index]?.type !== 'heading' || activeSection(plain(tokens[index].text)));
  const sourceRecords = currentDocumentSources(tokens);
  const namedSource = sourceRecords.length === 1 && sourceRecords[0] === 'PLAN.md';
  const lineCitation = (evidence: string) => {
    const cited = /^Plan lines?\s+([1-9]\d*(?:\s*[-–—]\s*[1-9]\d*)?(?:\s*,\s*[1-9]\d*(?:\s*[-–—]\s*[1-9]\d*)?)*)\s*:/i.exec(evidence);
    return Boolean(cited && cited[1]!.split(',').every(range => {
      const bounds=range.trim().split(/\s*[-–—]\s*/).map(Number), first=bounds[0]!, last=bounds.at(-1)!;
      return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first<=last && last<=sourcePlan.split('\n').length;
    }));
  };
  const inheritedSource = (evidence: string) => namedSource &&
    (/\bEvidence:\s*plan text\b|\bplan\s+§\s*\S|\bplan\s+sections?\s+\S|^Plan(?: contract)?:\s*\S/i.test(evidence) ||
      lineCitation(evidence) || currentContractCitation(evidence, sourcePlan));
  // A section citation can name the source in its current heading instead
  // of a special document-wide declaration. Resolve every cited section
  // against the actual input, and require an attributed current section.
  const activeSection = (text: string) => current(text) &&
    // The prescribed answered-decision history is separate from a reopened
    // row's current payload; it cannot supply or duplicate that comparison.
    !/^Answered decisions?\b/i.test(text) &&
    !/\b(?:historical|archiv(?:ed|al)|withdrawn|retracted|superseded|obsolete|not current|no longer current)\b/i.test(text);
  const sectionContext = (document: ReturnType<typeof marked.lexer>, index: number) => {
    const headings: Array<{ depth: number; text: string }> = [];
    // Enter the current heading before checking context: a completed sibling
    // (and its descendants) is not an ancestor of the section that follows.
    for (const token of document.slice(0, index + 1)) if (token.type === 'heading') {
      while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
      headings.push({ depth: token.depth, text: plain(token.text) });
    }
    return headings.every(heading => activeSection(heading.text));
  };
  const sectionCitation = (raw: string) => {
    const evidence = plain(raw.replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’/g, ''));
    if (!activeSection(evidence) || hasForeignContractSource(raw, sourcePlan) || sourceRecords.length > 1 || sourceRecords.some(source => source !== 'PLAN.md')) return false;
    const attributed = tokens.flatMap((token, index) => {
      if (token.type !== 'heading' || !sectionContext(tokens, index) || !activeSection(plain(token.text))) return [];
      const match = /^(.+?)(?:\s+retained)?\s+\(from\s+([^()]+)\)$/i.exec(plain(token.text));
      return match ? [{ section: match[1]!.toLowerCase(), source: match[2]! }] : [];
    });
    if (!attributed.length || attributed.some(row => row.source !== 'PLAN.md') ||
        new Set(attributed.map(row => row.section)).size !== attributed.length) return false;
    const sourceTokens = marked.lexer(sourcePlan);
    const headings = sourceTokens.flatMap((token, index) => token.type === 'heading' &&
      sectionContext(sourceTokens, index) && activeSection(plain(token.text)) ? [plain(token.text).replace(/\s+retained$/i, '').toLowerCase()] : []);
    const references = [...evidence.matchAll(/§\s*/g)].map(match => {
      const tail = evidence.slice(match.index! + match[0].length).toLowerCase();
      return headings.filter(heading => tail.startsWith(heading) && /^(?:\s|[.,;:]|$)/.test(tail.slice(heading.length)));
    });
    return references.length > 0 && references.every(matches => matches.length === 1) &&
      references.some(matches => attributed.some(row => row.section === matches[0]));
  };
  // The same option may give both dimensions as a parenthesized tuple,
  // with the value before or after its field, or a bare finite effort size.
  // Risk must remain explicit. Inventory every metadata tuple before accepting
  // one so mixed compact/full forms cannot hide duplicate or invalid claims.
  const optionFacts = (raw: string) => {
    const visible = raw.replace(/`+[^`]*`+|"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])|‘[^’\n]*’/gu,
      match => ' '.repeat(match.length));
    const firstTradeoff = visible.search(/\b(?:Pros|Cons)\s*:/i);
    const claims = [...visible.matchAll(/\(([^()]+)\)/g)].filter(match =>
      (firstTradeoff < 0 || match.index! < firstTradeoff) && /\brisk\b/i.test(match[1]!) &&
      (/\beffort\b/i.test(match[1]!) || /[,;]/.test(match[1]!)));
    if (!claims.length) return raw;
    if (claims.length !== 1) return null;
    const match = claims[0]!, before = visible.slice(0, match.index).trimEnd();
    const after = visible.slice(match.index! + match[0].length);
    if (/\b(?:not|never|no longer|previously|formerly|historical(?:ly)?|hypothetical(?:ly)?|quoted|withdrawn|retracted)(?:[\s,:;.—–-]+(?:currently|now|actually|exactly|only|still|just|estimated?|rated?|rating|as|at|effort|risk|tuple|metadata))*[\s,:;.—–-]*$/i.test(before) ||
        /\b(?:this|that|the) (?:estimate|tuple|rating|metadata|effort|risk) (?:is|was|has been) (?:already |now )?(?:withdrawn|retracted|not current|no longer (?:current|valid)|superseded|historical|quoted)\b/i.test(visible) ||
        !/^(?:\s*[.,;]|\s*$)/.test(after)) return null;
    const fields = match[1]!.split(/\s*[,;]\s*/).map(part => {
      const forward = /^(effort|risk)\s*:?\s+(.+)$/i.exec(part.trim());
      const reverse = /^(.+?)\s+(effort|risk)$/i.exec(part.trim());
      return forward ? [forward[1]!.toLowerCase(), forward[2]!] : reverse ? [reverse[2]!.toLowerCase(), reverse[1]!]
        : /^(?:S|M|L|XL)$/i.test(part.trim()) ? ['effort', part.trim()] : [];
    });
    const facts = Object.fromEntries(fields.filter(field => field.length === 2));
    const risk = /^(low|medium|high)(?:\s*(?:[-–—]|\bto\b)\s*(low|medium|high))?$/i.exec(facts.risk ?? '');
    const levels = ['low','medium','high'];
    if (fields.length !== 2 || Object.keys(facts).length !== 2 ||
        !/^(?:S|M|L|XL)$/i.test(facts.effort ?? '') || !risk ||
        (risk[2] && levels.indexOf(risk[1]!.toLowerCase()) >= levels.indexOf(risk[2]!.toLowerCase()))) return null;
    return raw.slice(0, match.index) + `. Effort ${facts.effort}. Risk ${facts.risk}.` + raw.slice(match.index! + match[0].length);
  };
  const optionText = (raw:string) => raw
    .replace(/((?:this|that|the) (?:option|alternative|baseline) (?:is|was|has been)\s+(?:(?:already|now)\s+)?)["“'‘]([^"”'’\n]+)["”'’]/gi,'$1$2')
    .replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’/g,'');
  const withdrawnOption = /\b(?:this|that|the) (?:option|alternative|baseline) (?:is|was|has been) (?:already |now )?(?:withdrawn|retracted|rejected|superseded|not current|no longer (?:current|valid)|historical|quoted)\b/i;
  // The skill requires complete per-option facts, not a GFM option table.
  // Code and quoted children cannot supply a prose/list option's fields.
  const proseOption = (parts: readonly any[]) => {
    const paragraphs = parts.filter(part => part.type === 'paragraph' || part.type === 'text');
    const first = paragraphs[0];
    if (!first) return null;
    const normalized = optionFacts(paragraphs.map(part => part.raw).join('\n'));
    if (normalized === null) return null;
    const text = plain(normalized);
    const label = first.tokens?.[0]?.type === 'strong' ? plain(first.tokens[0].text)
      : /^([A-D][).:]\s+.+?)\s+[—–-]\s+/i.exec(text)?.[1]
        ?? /^([A-D][).:]\s+.+?)[.:]\s+/i.exec(text)?.[1]
        // A plain label can own the next line's full option facts. A
        // single-line fragment cannot borrow fields from another paragraph.
        ?? (first.type === 'paragraph' && tokens.indexOf(first) >= 0 &&
          first.raw.trim().includes('\n') && currentContext(tokens.indexOf(first)) &&
          /^[A-D][).:]\s+\S/i.test(plain(first.raw.split('\n')[0]!))
          ? plain(first.raw.split('\n')[0]!) : undefined);
    if (!label || !/^[A-D][).:]\s+\S/i.test(label)) return null;
    const details = text.slice(label.length).replace(/^[.:\s—–-]+/, '');
    // Mask quoted/code field names without changing offsets. A real field
    // may follow a quoted sentence, but the quotation cannot supply a field.
    const fieldText = plain(normalized.replace(/`[^`]*`|"(?:\\.|[^"\\])*"|“[^”]*”|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])|‘[^’]*’/gu, raw => {
      const literal = raw.replace(/[`*_]/g, '');
      const ending = /[.!?,;]["”'’]$/.exec(literal)?.[0] ?? '';
      return literal.slice(0, literal.length - ending.length).replace(/[^\s]/g, ' ') + ending;
    })).slice(text.length - details.length);
    const facts = [...fieldText.matchAll(/(?:^|[.!?,;]["”'’]?\s+|\n\s*)(Effort(?: estimate)?|Risk(?: level)?|Pros|Cons)\s*:?\s+/gi)];
    const fields = Object.fromEntries(facts.map((fact, index) => [fact[1]!.split(' ')[0]!.toLowerCase(),
      details.slice(fact.index! + fact[0].length, facts[index + 1]?.index ?? details.length).trim()]));
    // A Cons condition states a contingent cost of this current alternative;
    // it does not make the option, its promised benefit or its metadata
    // hypothetical. Keep withdrawal/source/history checks on the clause and
    // the whole option, and keep every other field's currentness unchanged.
    const currentFact = (field: string, value: string) => current(field === 'cons'
      ? value.replace(/^(?:if|unless)\s+(?=\S)/i, '') : value);
    const complete = facts.length === 4 && Object.keys(fields).length === 4 && current(text) && !withdrawnOption.test(optionText(text)) &&
      ['effort', 'risk', 'pros', 'cons'].every(field => fields[field] && currentFact(field, fields[field]!)) &&
      /^(?:S|M|L|XL)\b/i.test(fields.effort!) && /^(?:low|medium|high)\b/i.test(fields.risk!);
    return { label, summary: text, bindingText: label + ' ' + details.slice(0, facts[0]?.index ?? details.length), complete };
  };
  // The checkpoint also saves the native Question/Header and unchanged full
  // option descriptions. These use native ✅/❌ tradeoffs, not prose-fallback
  // field names. Match the whole current record without borrowing old tables.
  const exactNativeFields = (section: ReturnType<typeof marked.lexer>) => {
    const line = (value: string) => value.trim()
      .replace(/^\*\*(Question|Header):\*\*\s*/, '$1: ')
      .replace(/^\*\*(Question|Header)\*\*:\s*/, '$1: ')
      .replace(/^\*\*([A-D][).:]\s+.+)\*\*$/, '$1');
    const lines = (value: string) => value.replace(/\r\n/g, '\n').split('\n').map(line).filter(Boolean);
    const saved = section.filter(token => token.type === 'paragraph' && currentContext(tokens.indexOf(token))).flatMap(token => lines(token.raw));
    const questions = saved.flatMap((value, i) => /^Question:/.test(value) ? [i] : []);
    const headers = saved.flatMap((value, i) => /^Header:/.test(value) ? [i] : []);
    if (questions.length !== 1 || headers.length !== 1 || !q.header.trim()) return false;
    const prefixes = q.options.flatMap(offered => /^([A-D])[).:]\s+/.exec(offered.label)?.[1] ?? []);
    if (new Set(prefixes).size !== prefixes.length) return false;
    const assigned = new Set(prefixes);
    const options = q.options.map((offered, index) => {
      const prefix = /^([A-D])[).:]\s+/.exec(offered.label);
      if (prefix && /^[A-D][).:]\s+/.test(offered.label.slice(prefix[0].length))) return null;
      const id = prefix?.[1] ?? ['A', 'B', 'C', 'D'].find(value => !assigned.has(value));
      if (!id) return null;
      assigned.add(id);
      const description = prose(offered.description ?? '');
      const tradeoffs = [...description.matchAll(/([✅❌])\s*([^✅❌]+)/g)];
      if (!description.trim() || !current(description) || withdrawnOption.test(optionText(description)) ||
          !/\bEffort(?: estimate)?\s*:?\s+(?:S|M|L|XL)\b/i.test(description) ||
          !/\bRisk(?: level)?\s*:?\s+(?:low|medium|high)\b/i.test(description) ||
          tradeoffs.filter(part => part[1] === '✅').length < 2 || !tradeoffs.some(part => part[1] === '❌') ||
          tradeoffs.some(part => !/[A-Za-z0-9]/.test(part[2]!))) return null;
      return `${prefix ? offered.label : `${id}) ${offered.label}`}\n${offered.description}`;
    });
    if (options.some(value => value === null)) return false;
    const fields = [`Question: ${q.question}`, `Header: ${q.header}`];
    if (headers[0]! < questions[0]!) fields.reverse();
    const expected = lines([...fields, ...options].join('\n'));
    const start = Math.min(questions[0]!, headers[0]!);
    if (!saved.slice(0, start).every(activeSection)) return false;
    const actual = saved.slice(start);
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  };
  const selector = (label: string) => /^([A-D])[.):]\s*/i.exec(plain(label))?.[1]?.toUpperCase();
  const labelWords = (label: string) => (option(label).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])
    .filter(word => !['recommended', 'option', 'only', 'plan', 'planned', 'written', 'keep', 'same', 'full'].includes(word));
  // Terminal punctuation and a status suffix are presentation, not a choice.
  const caption = (value: string) => option(value).replace(/^[A-D]:\s*/i, '').replace(/\s*\((?:plan )?as (?:written|planned)\)\.?$/i, '').replace(/[.:]$/, '').trim();
  const words = (value: string) => (caption(value).toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .map(word => word === 'via' ? 'through' : word);
  const completeCaption = (offered: string, saved: string, summary: string) => {
    const a = selector(offered), b = selector(saved);
    if (a && a !== b) return false;
    const left = words(offered), right = words(saved + ' ' + summary);
    // Abbreviations may omit detail, but an unlettered saved caption cannot
    // add an action or narrow its scope. A terminal 'in place' is presentation.
    const savedCaption = words(caption(saved).replace(/ in place$/i, ''));
    if (!a && savedCaption.some(word => !left.includes(word))) return false;
    // A lettered grid may abbreviate a terminal "only" qualifier; never
    // discard an action's internal scope or a negation while binding it.
    if (a && left.at(-1) === 'only' && !right.includes('only')) left.pop();
    if (['no', 'not', 'never', 'without'].some(word => left.includes(word) !== right.includes(word))) return false;
    if (!left.length || (!a && left.length < 2) || left[0] !== right[0]) return false;
    let cursor = 0;
    return left.every(word => { const index = right.indexOf(word, cursor); cursor = index + 1; return index >= 0; });
  };
  const sameOption = (offered: string, saved: string, summary: string) => caption(offered).toLowerCase() === caption(saved).toLowerCase() ||
    Boolean(selector(offered) && selector(offered) === selector(saved) &&
      labelWords(offered).some(word => labelWords(saved + ' ' + summary).includes(word))) ||
    (!selector(offered) && completeCaption(offered, saved, summary));
  // Bare grid columns supply no action text. Bind their declaration to the
  // whole native caption, preserving targets, scope, counts and negation.
  // Assertion summaries may omit "assert full", count precision, a mock
  // already named in the native brief, and source-bound scalar call arguments.
  const declaredOption = (offered: typeof q.options[number], saved: string) => {
    const assignment = '[a-z_][a-z0-9_]*=(?:[0-9]+|[a-z_][a-z0-9_]*)';
    const argumentsKey = (value: string) => {
      const pairs = value.match(new RegExp(assignment, 'gi')) ?? [];
      return pairs.length && new Set(pairs.map(pair => pair.split('=')[0])).size === pairs.length
        ? pairs.sort().join(',') : null;
    };
    const sourceArguments = (value: string) => {
      const key = argumentsKey(value), sourceTokens = marked.lexer(sourcePlan);
      if (!key) return false;
      return sourceTokens.some((token, index) => {
        if (!sectionContext(sourceTokens, index)) return false;
        const parts = token.type === 'paragraph' ? [token] : token.type === 'list'
          ? token.items.flatMap(item => item.tokens.filter(part => part.type === 'text' || part.type === 'paragraph')) : [];
        return parts.some(part => {
          const text = prose(part.raw.replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’/g, '')).replace(/\s+/g, ' ');
          if (!activeSection(text) || /\b(?:not|never|if|unless|hypothetical|previously|formerly)\b/i.test(text)) return false;
          const calls = new RegExp(`\\bcall\\s+[a-z_][a-z0-9_.]*(?:\\(\\))?\\s+with\\s+(${assignment}(?:\\s*(?:,|\\band\\b)\\s*${assignment})*)(?=\\s*(?:[,.;]|$))`, 'gi');
          return [...text.matchAll(calls)].some(call => argumentsKey(call[1]!) === key);
        });
      });
    };
    const normalize = (value: string) => {
      let text = caption(value);
      if (/^assert\s+/i.test(text)) {
        text = text.replace(/^assert\s+(?:full\s+)?/i, '')
          .replace(/\bexactly\s+(?=(?:[0-9]+|one|two|three|four)\b)/gi, '');
        if (/\bmock\b/i.test(prose(offered.description ?? '')))
          text = text.replace(/\bmock\s+(?=[a-z_][a-z0-9_]*\s+call\b)/gi, '');
        text = text.replace(new RegExp(`(\\bcall)\\s+with\\s+(${assignment}(?:,\\s*${assignment})*)$`, 'i'),
          (whole, call, args) => sourceArguments(args) ? call : whole);
      }
      return text.toLowerCase().replace(/\+|\bplus\b/g, ' and ').match(/[a-z0-9_]+|[^\s.,]/g) ?? [];
    };
    const left = normalize(offered.label), right = normalize(saved);
    return selector(offered.label) === selector(saved) && left.length > 0 &&
      left.length === right.length && left.every((word, index) => word === right[index]);
  };
  // A saved "as planned" alternative names the owned baseline. Resolve that
  // reference before ordinary caption matching; a letter or a shared word is
  // insufficient, and retaining a baseline cannot silently append an action.
  const baselineCaption = (value: string) => option(value).replace(/^[A-D]:\s*/i, '').replace(/[.]$/, '').trim();
  const baselineWords = (value: string) => baselineCaption(value).toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const sameBaseline = (a: string, b: string) => baselineCaption(a).replace(/\s+/g, ' ').toLowerCase() ===
    baselineCaption(b).replace(/\s+/g, ' ').toLowerCase();
  const retainedCaption = (value: string) => baselineCaption(value)
    .replace(/^(?:keep|retain|preserve)\s+/i, '')
    .replace(/^as (?:planned|written):\s*/i, '')
    .replace(/\s*\((?:plan )?as (?:planned|written)\)$/i, '');
  const savedBaseline = (saved: { label: string; bindingText: string }) => {
    const label = baselineCaption(saved.label);
    const tail = saved.bindingText.slice(saved.label.length).trim();
    if (/^as (?:planned|written)\b/i.test(label)) {
      const caption = retainedCaption(label.replace(/^as (?:planned|written):?\s*/i, ''));
      return { generic: !caption, caption };
    }
    const suffix = /^(.*?)\s*(?:\((?:plan )?as (?:planned|written)\)|,\s*as (?:planned|written))$/i.exec(label);
    if (suffix) return { generic: false, caption: retainedCaption(suffix[1]!) };
    if (/^\((?:plan )?as (?:planned|written)\)(?:\s|[—–-]|$)/i.test(tail)) return { generic: false, caption: retainedCaption(label) };
    return null;
  };
  const matches: Array<{ ledgerId: string; phase: string }> = [];
  for (const table of tokens.filter(t => t.type === 'table')) {
    if (table.type !== 'table') continue;
    const index = (meaning: RegExp) => table.header.flatMap((cell, i) => meaning.test(plain(cell.text)) ? [i] : []);
    const fields = { id: index(/^(?:ID|Decision)\b/i), evidence: index(/\b(?:Contract|Evidence)\b/i),
      current: index(/^Current\b/i), proposed: index(/^Proposed\b/i), status: index(/^Status\b/i) };
    if (Object.values(fields).some(found => found.length !== 1)) continue;
    for (const cells of table.rows) {
      const read = (key: keyof typeof fields) => plain(cells[fields[key][0]!]!.text);
      const id = read('id').split(/\s/, 1)[0]!.replace(/[.:]$/, '');
      const status = ledgerStatus(cells[fields.status[0]!]!.text, tokens, tokens.indexOf(table), read('id'), read('evidence'), sourcePlan);
      const quotedProposal = !current(read('proposed')) && /^(?:unresolved|reopened)\b/i.test(status) &&
        (!sourceRecords.length || namedSource) && currentContext(tokens.indexOf(table)) &&
        quotedSourceProposal(cells[fields.proposed[0]!]!.text, sourcePlan);
      const sectionEvidence = sectionCitation(cells[fields.evidence[0]!]!.text);
      const headingCitation = !namedSource && /§/.test(read('evidence')) && tokens.some(token =>
        token.type === 'heading' && /\(from\s+[^()]+\)$/i.test(plain(token.text)));
      if (headingCitation && !sectionEvidence) continue;
      if (!id || !mentions(title, id) || !/^(?:unresolved|reopened|approved|deferred|declined)\b/i.test(status) ||
          !read('current') || !read('proposed') || read('current') === read('proposed') ||
          !current(read('evidence')) || (!current(read('proposed')) && !quotedProposal)) continue;
      if (!/\bPLAN\.md\b/.test(read('evidence')) && !inheritedSource(read('evidence')) && !sectionEvidence) continue;
      const contractCitation = /^Contracts?:/i.test(read('evidence'));
      if (contractCitation && (!currentContext(tokens.indexOf(table)) || hasForeignContractSource(read('evidence'), sourcePlan))) continue;
      if (sectionEvidence && !sectionContext(tokens, tokens.indexOf(table))) continue;
      // A named current record is also valid as a plain/bold paragraph.
      // A bare Row marker inherits only its enclosing currentDecision heading;
      // incidental row mentions and quoted/code tokens cannot own a comparison.
      const paragraphRecord = (index: number) => {
        const token = tokens[index];
        if (token?.type !== 'paragraph' || !currentContext(index) || !current(plain(token.raw))) return false;
        const marker = plain(token.raw).split('\n')[0]!;
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const parentIndex = tokens.slice(0, index).findLastIndex(t => t.type === 'heading');
        const parent = tokens[parentIndex];
        // An immediate same-row marker describes its named heading's record.
        // A marker after any record content remains a separate declaration.
        if (parent?.type === 'heading' && /^currentDecision\b/i.test(plain(parent.text)) &&
            mentions(plain(parent.text), id) && tokens.slice(parentIndex + 1, index).every(t => t.type === 'space')) return false;
        if (new RegExp(`^currentDecision\\s*(?:[:(—–-]\\s*)?${escaped}(?=$|[\\s):—–-])`, 'i').test(marker)) return activeSection(marker);
        return parent?.type === 'heading' && /^currentDecision\b/i.test(plain(parent.text)) &&
          new RegExp(`^Row\\s+${escaped}(?=$|[\\s:—–-])`, 'i').test(marker) && activeSection(marker);
      };
      const anchors = tokens.flatMap((t, i) =>
        (t.type === 'heading' && current(plain(t.text)) && mentions(plain(t.text), id)) ||
        (t.type === 'paragraph' && /^(?:Options|Approaches|Comparison)\b/i.test(plain(t.raw)) && mentions(plain(t.raw), id)) ||
        paragraphRecord(i) ? [i] : []);
      // A row reference in a coverage/task heading does not declare another
      // saved decision. Keep broad legacy discovery, but count ownership only
      // where a record is declared or its own fields/comparison begin. Explicit
      // empty/incomplete records still conflict; never borrow a child record.
      const recordAnchors = anchors.filter(start => {
        const anchor = tokens[start]!;
        const heading = plain(anchor.raw).replace(/^#+\s*/, '');
        const rowName = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const kind = '(?:decision|review|options|approaches|comparison)';
        const declared = new RegExp(`^(?:(?:current|pending)\\s+)?(?:${kind}\\s+(?:for\\s+)?${rowName}\\b|${rowName}\\s+${kind}\\b)`, 'i');
        if (paragraphRecord(start) || /^currentDecision\b/i.test(heading) || declared.test(heading) ||
            (anchor.type === 'paragraph' && /^(?:Options|Approaches|Comparison)\b/i.test(plain(anchor.raw)))) return true;
        let end = start + 1;
        while (end < tokens.length && tokens[end]!.type !== 'heading') end++;
        return tokens.slice(start + 1, end).some(token => {
          if (token.type === 'paragraph') return !/^[`"'“‘]/.test(token.raw.trim()) &&
            /^(?:(?:Question|Header):|[A-D][).:]\s+\S)/m.test(plain(token.raw));
          if (token.type === 'list') return token.items.some(item => !/^[`"'“‘]/.test(item.text.trim()) &&
            /^[A-D][).:]\s+\S/.test(plain(item.text)));
          const columns = token.type === 'table' ? token.header.map(cell => plain(cell.text)) :
            token.type === 'code' ? (token.text.split('\n').find(line => line.includes('|')) ?? '').split('|').map(plain) : [];
          return columns.some(column => /^(?:Option|Approach)\b/i.test(column)) ||
            columns.filter(column => /^[A-D]$/.test(column)).length >= 2;
        });
      });
      let matchedPhase: string | undefined;
      for (const start of anchors) {
        if ((quotedProposal || contractCitation) && !currentContext(start)) continue;
        if (sectionEvidence && (!sectionContext(tokens, start) || !activeSection(plain(tokens[start]!.raw)))) continue;
        const anchor = tokens[start]!;
        let end = start + 1;
        while (end < tokens.length && !(tokens[end]!.type === 'heading' &&
          (anchor.type !== 'heading' || (tokens[end] as any).depth <= anchor.depth))) end++;
        // Keep a paragraph anchor's continuation (e.g. Header/Question) in
        // the exact-field record, just as fields below a heading are retained.
        const section = tokens.slice(anchor.type === 'paragraph' ? start : start + 1, end);
        if (currentContext(start) && currentContext(tokens.indexOf(table))) {
          // Reuse the owned ledger/source gates, but require one current row
          // and comparison anchor before granting this exact-field path credit.
          const currentRows = tokens.flatMap(token => {
            if (token.type !== 'table' || !currentContext(tokens.indexOf(token))) return [];
            const ids = token.header.flatMap((cell, i) => /^(?:ID|Decision)\b/i.test(plain(cell.text)) ? [i] : []);
            return ids.length === 1 ? token.rows.map(row => plain(row[ids[0]!]!.text).split(/\s/, 1)[0]!.replace(/[.:]$/, '')) : [];
          });
          const ownedComparison = pendingRowContext(tokens, tokens.indexOf(table), read('id')) &&
              sourceRecords.length <= 1 && sourceRecords.every(source => source === 'PLAN.md') &&
              !hasForeignContractSource(cells[fields.evidence[0]!]!.text, sourcePlan) &&
              currentRows.filter(value => value === id).length === 1 && recordAnchors.filter(currentContext).length === 1;
          if (paragraphRecord(start) && (!pendingRowContext(tokens, tokens.indexOf(table), read('id')) ||
              sourceRecords.some(source => source !== 'PLAN.md') ||
              hasForeignContractSource(cells[fields.evidence[0]!]!.text, sourcePlan) ||
              currentRows.filter(value => value === id).length !== 1 || recordAnchors.filter(currentContext).length !== 1)) continue;
          if (ownedComparison && exactNativeFields(section)) matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          // Markdown permits an option paragraph followed by a facts list.
          // Bind only the adjacent list to that option; never borrow a later
          // option's facts, quoted/code content or another section's details.
          const options = section.flatMap((token, index) => {
            if (token.type === 'list') return token.items.map(item => proseOption(item.tokens));
            if (token.type !== 'paragraph') return [];
            let next = index + 1;
            while (section[next]?.type === 'space') next++;
            const details = section[next];
            const facts = details?.type === 'list' && details.items.every(item => {
              const first = item.tokens.find(part => part.type === 'text' || part.type === 'paragraph');
              return first && /^(?:Effort|Risk|Pros|Cons|Reuse|Coverage)\s*:/i.test(plain(first.raw));
            }) ? details.items.flatMap(item => item.tokens.filter(part => part.type === 'text' || part.type === 'paragraph')) : [];
            return [proseOption([token, ...facts])];
          }).filter(option => option !== null);
          const baselineOption = (offered: string, saved: NonNullable<typeof options[number]>) => {
            const addedAction = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|\b(?:and|but|also|first|then|now|next|while)\s+)(?:please\s+)?(?:add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|cut(?:ting)?|drop(?:ping)?|replac(?:e|ing)|rewrit(?:e|ing)|chang(?:e|ing)|alter(?:ing)?|modif(?:y|ying)|enabl(?:e|ing)|disabl(?:e|ing)|implement(?:ing)?|install(?:ing)?|introduc(?:e|ing)|build(?:ing)?|writ(?:e|ing)|record(?:ing)?|captur(?:e|ing)|creat(?:e|ing)|switch(?:ing)?|migrat(?:e|ing)|externaliz(?:e|ing)|refactor(?:ing)?|expand(?:ing)?|reduc(?:e|ing)|deploy(?:ing)?|approv(?:e|ing)|run(?:ning)?)\b/i;
            const unchanged = (action:string) => [saved.summary.slice(saved.label.length),q.options.find(o=>o.label===offered)?.description ?? ''].every(raw=>{
              const text=optionText(raw), escaped=action.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
              return current(text) && !addedAction.test(text) &&
                !withdrawnOption.test(text) &&
                !new RegExp(`\\b(?:not|never|no longer|doesn't|does not|will not)\\s+(?:(?:currently|now|actually)\\s+)?${escaped}(?:s|es)?\\b`,'i').test(text);
            });
            if (/\bvia\b/i.test(caption(offered)) !== /\bvia\b/i.test(caption(saved.label)) &&
                /\bthrough\b/i.test(caption(offered)+' '+caption(saved.label)) && !unchanged(words(offered)[0] ?? '')) return false;
            const baseline = savedBaseline(saved);
            const offeredBaseline = savedBaseline({label:offered,bindingText:offered});
            // Both captions explicitly retain this row's current baseline.
            // A shortened action caption may omit its uniquely owned target;
            // the current row must supply the whole native action and target,
            // not another option, quoted history, a negation or a second match.
            if (baseline && offeredBaseline && !baseline.generic && !offeredBaseline.generic) {
              const short = baselineWords(baseline.caption), full = baselineWords(offeredBaseline.caption);
              if (short.length && short.length < full.length && short.every((word,i)=>word===full[i])) {
                const value=plain(cells[fields.current[0]!]!.text.replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'|‘[^’\n]*’/g,''));
                const valueWords=baselineWords(value);
                const verb=(word:string)=>word===full[0] || word===full[0]+'s' || (full[0]!.endsWith('s') && word===full[0]+'es');
                const hits=valueWords.flatMap((word,i)=>verb(word) && full.slice(1).every((next,j)=>valueWords[i+j+1]===next)?[i]:[]);
                // A one-word action caption can omit an explicit destination
                // and numeric outcome. Both must occur together in Current;
                // the same-letter grid must name that action and retain the
                // exact outcome. This is not unordered word-overlap matching.
                const result = /^([a-z][a-z0-9_]*)\s+([0-9]+)$/i.exec(offeredBaseline.caption.split(',').at(-1)!.trim());
                const operands = valueWords.flatMap((_, i) => full.slice(1).every((word, j) => valueWords[i+j] === word) ? [i] : []);
                const explicitOutcome = short.length === 1 && /^(?:to|from|through|via)$/.test(full[1] ?? '') &&
                  selector(offered) === selector(saved.label) && result && operands.length === 1 &&
                  [saved.summary.slice(saved.label.length), q.options.find(o => o.label === offered)?.description ?? ''].every(raw =>
                    [...optionText(raw).matchAll(new RegExp(`\\b${result[1]}\\s+([0-9]+)\\b`, 'gi'))]
                      .every(claim => claim[1] === result[2])) && section.some(token => {
                    if (token.type !== 'table' || !currentContext(tokens.indexOf(token))) return false;
                    const headers = token.header.map(cell => plain(cell.text)), ids = headers.map(selector);
                    const own = ids.indexOf(selector(offered)), currentColumn = headers.findIndex(h => /^Current$/i.test(h));
                    const commitment = headers.findIndex(h => /^Commitment$/i.test(h));
                    if (headers.length !== q.options.length + 3 || own < 0 || currentColumn < 0 || commitment < 0 ||
                        !headers.some(h => /^Source(?:\b|\/)/i.test(h)) ||
                        !q.options.every(o => ids.filter(id => id === selector(o.label)).length === 1) ||
                        !sameBaseline(retainedCaption(headers[own]!), baseline.caption)) return false;
                    const rows = token.rows.filter(row => plain(row[commitment]!.text).split(/\s/, 1)[0]!.toLowerCase() === result[1]!.toLowerCase());
                    return rows.length === 1 && plain(rows[0]![currentColumn]!.text) === result[2] && plain(rows[0]![own]!.text) === result[2];
                  });
                return namedSource && currentContext(tokens.indexOf(table)) && current(value) &&
                  !/\b(?:not|never|no longer|[a-z]+n['’]t|will|would|could|should|may|might|previously|formerly|historical|hypothetical|if|unless|withdrawn|retracted|superseded|(?:other|another|foreign) (?:plan|project))\b/i.test(value) &&
                  (!selector(offered) || selector(offered)===selector(saved.label)) &&
                  (hits.length===1 || explicitOutcome) && unchanged(full[0]!);
              }
            }
            if (!baseline || (!baseline.generic && !/^(?:keep|retain|preserve)\b/i.test(baselineCaption(offered))))
              return sameOption(offered, saved.label, selector(offered) ? saved.summary : saved.bindingText);
            const offeredId = selector(offered), savedId = selector(saved.label);
            if (offeredId && offeredId !== savedId) return false;
            const retained = retainedCaption(offered);
            if (!baseline.generic) {
              if (!sameBaseline(retained, baseline.caption)) return false;
              // The concrete caption itself identifies the unchanged plan
              // alternative in this source-bound row's complete comparison.
              return baselineWords(baseline.caption).length >= 2;
            }
            if (!offeredId || offeredId !== savedId || (baseline.caption && !sameBaseline(retained, baseline.caption))) return false;
            const alternatives = [...read('proposed').matchAll(/(?:^|\s)([A-D])[).:]\s+(.+?)(?=\s[A-D][).:]\s|$)/g)];
            const own = alternatives.filter(match => match[1] === savedId);
            if (own.length !== 1 || !sameBaseline(retained, own[0]![2]!)) return false;
            // A generic caption is resolved by the same-letter Proposed
            // alternative AND its unchanged Current column in the owned grid.
            // The complete prose option still owns effort/risk/pros/cons.
            return section.some(token => {
              if (token.type !== 'table' || !currentContext(tokens.indexOf(token))) return false;
              const headers = token.header.map(cell => plain(cell.text));
              const identity = (header: string) => /^[A-D]$/.test(header) ? header : selector(header);
              const ids = headers.map(identity), baselineIndex = ids.indexOf(savedId);
              const currentIndex = headers.findIndex(header => /^Current$/i.test(header));
              const contractIndex = headers.findIndex(header => /^Commitment$/i.test(header));
              const sourceIndex = headers.findIndex(header => /^Source(?:\b|\/)/i.test(header));
              const optionIndices = ids.flatMap((id, i) => id ? [i] : []);
              if (headers.length !== q.options.length + 3 || optionIndices.length !== q.options.length ||
                  new Set(optionIndices.map(i => ids[i])).size !== q.options.length || baselineIndex < 0 ||
                  currentIndex < 0 || contractIndex < 0 || sourceIndex < 0) return false;
              const rawRows = token.raw.trimEnd().split('\n').slice(2);
              const rows = token.rows.map(row => row.map(cell => plain(cell.text)));
              return rows.length > 0 && rows.every((row, index) => /(^|[^\\])\|/.test(rawRows[index] ?? '') &&
                row.length === headers.length && row.every(cell => cell && current(cell)) &&
                row[baselineIndex]!.toLowerCase() === row[currentIndex]!.toLowerCase()) &&
                rows.some(row => optionIndices.some(i => row[i]!.toLowerCase() !== row[currentIndex]!.toLowerCase()));
            });
          };
          const matched = q.options.map(offered => options.flatMap((saved, index) =>
            saved!.complete && baselineOption(offered.label, saved!) ? [index] : []));
          if (options.length === q.options.length && matched.every(found => found.length === 1) &&
              new Set(matched.flat()).size === q.options.length) {
            matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          }
        }
        for (const comparison of tokens.slice(start + 1, end)) {
          if (comparison.type !== 'table') continue;
          if ((quotedProposal || contractCitation) && !currentContext(tokens.indexOf(comparison))) continue;
          if (sectionEvidence && !sectionContext(tokens, tokens.indexOf(comparison))) continue;
          const headers = comparison.header.map(c => plain(c.text));
          // The declared commitment grid transposes the option table: each
          // complete alternative is a column. Its saved effort/risk row and
          // behavioral cells bind the owned native pros/cons for that option.
          const commitment = headers.findIndex(h => /^Commitment$/i.test(h));
          const source = headers.findIndex(h => /^Source(?:\b|\/)/i.test(h));
          const baseline = headers.findIndex(h => /^Current$/i.test(h));
          const gridSelector = (header: string) => selector(header) ?? /^([A-D])$/i.exec(header)?.[1]?.toUpperCase();
          const optionColumns = headers.flatMap((header, index) => gridSelector(header) ? [index] : []);
          if (commitment >= 0 && source >= 0 && baseline >= 0 &&
              currentContext(start) && currentContext(tokens.indexOf(table)) && currentContext(tokens.indexOf(comparison)) &&
              headers.length === q.options.length + 3 &&
              optionColumns.length === q.options.length &&
              new Set(optionColumns.map(i => gridSelector(headers[i]!))).size === q.options.length) {
            // GFM permits a following un-delimited paragraph as a padded row.
            // Only explicit grid rows supply cells; a current prose footer
            // remains context and cannot fill a missing value in a real row.
            const rawRows = comparison.raw.trimEnd().split('\n').slice(2);
            const gridRow = (index: number) => /(^|[^\\])\|/.test(rawRows[index] ?? '');
            const footerCurrent = rawRows.filter((_, index) => !gridRow(index)).every(line => current(plain(line)));
            const rows = comparison.rows.filter((_, index) => gridRow(index)).map(row => row.map(cell => plain(cell.text)));
            const effortRisk = rows.filter(row => /^Effort\s*\/\s*risk$/i.test(row[commitment] ?? ''));
            const effort = rows.filter(row => /^Effort$/i.test(row[commitment] ?? ''));
            const risk = rows.filter(row => /^Risk$/i.test(row[commitment] ?? ''));
            const behavior = rows.filter(row => !/^(?:Effort(?:\s*\/\s*risk)?|Risk)$/i.test(row[commitment] ?? ''));
            const scalar = (value: string, kind: 'effort' | 'risk') => {
              const match = /^(S|M|L|XL|low|medium|high)(?:\s*\(([^()]*)\))?$/i.exec(value);
              return Boolean(match && (kind === 'effort' ? /^(?:S|M|L|XL)$/i : /^(?:low|medium|high)$/i).test(match[1]!) &&
                (kind !== 'effort' || !(match[2]?.match(/\b(?:S|M|L|XL)\b/gi) ?? []).some(size => size.toUpperCase() !== match[1]!.toUpperCase())) &&
                current(match[2] ?? '') && !/\b(?:not|never|no longer|withdrawn|retracted|superseded|historical|previously|formerly|low|medium|high|risk|effort)\b/i.test(match[2] ?? ''));
            };
            const separate = effortRisk.length === 0 && effort.length === 1 && risk.length === 1;
            const metadata = separate ? optionColumns.every(i => scalar(effort[0]![i] ?? '', 'effort') && scalar(risk[0]![i] ?? '', 'risk'))
              : effortRisk.length === 1 && effort.length === 0 && risk.length === 0 && optionColumns.every(i => /^(?:S|M|L|XL)\s*\/\s*(?:low|medium|high)$/i.test(effortRisk[0]![i] ?? ''));
            const bare = optionColumns.some(i => /^[A-D]$/i.test(headers[i]!));
            const declarations = [...read('proposed').matchAll(/(?:^|[.;]\s+)([A-D])[).:]\s+(.+?)(?=[.;]\s+[A-D][).:]\s+|$)/g)]
              .map(match => `${match[1]}) ${match[2]}`);
            const uniqueGrid = !(bare || separate) || (sourceRecords.length <= 1 && sourceRecords.every(source => source === 'PLAN.md') &&
              anchors.length === 1 && section.filter(token => token.type === 'table' &&
              token.header.some(cell => /^Commitment$/i.test(plain(cell.text)))).length === 1);
            const complete = footerCurrent && metadata && uniqueGrid &&
              behavior.length > 0 && behavior.every(row => row.length === headers.length && row[commitment] && row[source] && row[baseline] &&
                current(row[commitment]!) && (!(bare || separate) || (current(row[source]!) && !hasForeignContractSource(row[source]!, sourcePlan))) &&
                optionColumns.every(i => row[i] && current(row[i]!))) &&
              behavior.some(row => new Set(optionColumns.map(i => row[i]!.toLowerCase())).size > 1) &&
              q.options.every(o => { const facts = prose(o.description ?? ''); return /✅/.test(facts) && /❌/.test(facts) && current(facts) &&
                (!(bare || separate) || !withdrawnOption.test(optionText(facts))); });
            const matched = q.options.map(offered => optionColumns.filter(i => /^[A-D]$/i.test(headers[i]!)
              ? selector(offered.label) === gridSelector(headers[i]!) && declarations.length === q.options.length &&
                declarations.filter(saved => selector(saved) === gridSelector(headers[i]!) && declaredOption(offered, saved)).length === 1
              : completeCaption(offered.label, headers[i]!, '')));
            if (complete && matched.every(found => found.length === 1) && new Set(matched.flat()).size === q.options.length)
              matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          }
          const optionColumn = headers.findIndex(h => /^(?:Option|Approach)\b/i.test(h));
          if (optionColumn < 0 || !['effort', 'risk', 'pros', 'cons'].every(h => headers.some(v => v.toLowerCase() === h)) ||
              comparison.rows.length !== q.options.length || comparison.rows.some(row => row.some(cell => !plain(cell.text)))) continue;
          const saved = comparison.rows.map(row => plain(row[optionColumn]!.text));
          const summaryColumn = headers.findIndex(h => /^(?:Summary|Description|Approach)$/i.test(h));
          const matched = q.options.map(offered => saved.flatMap((label, i) => sameOption(offered.label, label,
            summaryColumn < 0 ? '' : plain(comparison.rows[i]![summaryColumn]!.text)) ? [i] : []));
          if (matched.every(found => found.length === 1) && new Set(matched.flat()).size === q.options.length) {
            matchedPhase = anchor.type === 'heading' ? plain(anchor.text) : plain(anchor.raw).split('\n')[0];
          }
        }
      }
      if (matchedPhase) matches.push({ ledgerId: id, phase: matchedPhase });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Fixture-local metric adapter. It never advances the shared phase boundary.
 * Every real current question, including repeated remedies, still counts
 * toward the original 4–7 band. Unknown decisions fail closed. */
export function createCeoPaymentFindingCounter(seedPlan: string, readPlan: () => string,
  existingFinding: (fp: AskUserQuestionFingerprint) => boolean) {
  const trace: Array<Finding | { signature: string; kind: 'setup' | 'existing-finding' | 'additional-current-decision' } |
    { signature: string; kind: 'recorded-decision'; ledgerId: string; phase: string }> = [];
  return {
    trace,
    isReviewAUQ(fp: AskUserQuestionFingerprint, priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
      const setupPacket = ownedSetupPacket(fp);
      if ((!ownedAnswer(fp) && !setupPacket) || priorCalls.some(call => `${call.sessionId}:${call.toolUseId}` === fp.signature))
        throw new Error(`Invalid or duplicated completed native decision: ${fp.signature}`);
      if (setupPacket || setupQuestion(fp)) { trace.push({ signature: fp.signature, kind: 'setup' }); return false; }
      const plan = readPlan();
      const finding = ceoPaymentFinding(fp, seedPlan, plan);
      if (finding) { trace.push(finding); return true; }
      const decision = recordedDecision(fp, plan, seedPlan);
      if (decision) { trace.push({ signature: fp.signature, kind: 'recorded-decision', ...decision }); return true; }
      if (todoDecision(fp)) { trace.push({ signature: fp.signature, kind: 'additional-current-decision' }); return true; }
      if (existingFinding(fp)) { trace.push({ signature: fp.signature, kind: 'existing-finding' }); return true; }
      throw new Error(`Unsupported current CEO decision; cannot exclude it from the 4–7 count: ${fp.signature}`);
    },
  };
}
