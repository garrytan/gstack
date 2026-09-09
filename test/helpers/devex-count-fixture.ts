import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** Concrete product decisions, separate from the skill's mandatory Step-0 confirmations. */
export const DEVEX_COUNT_FILES: Record<string, string> = {
  'README.md': `# EvalKit SDK

EvalKit is a Python SDK for ML engineers evaluating LLM responses. The primary
developer writes Python daily, uses a terminal, and wants a local result before
connecting the SDK to production CI. The agreed review posture is DX POLISH:
improve the existing SDK's touchpoints within the beta release scope.

## Getting started

Install with \`python -m pip install evalkit==2.0.0b1\`, set EVALKIT_API_KEY,
then follow the quickstart's command: \`python examples/first_eval.py\`.
The published package inventory is in docs/package-contents.txt.

The chosen first-success experience is an included, copy-paste demo command:
\`python -m evalkit.demo\`. It evaluates bundled sample responses and prints
real per-example scores plus an overall score. It needs no hosted playground
or new interactive UI. Like every first evaluation, it currently waits for the
mandatory CI check described in docs/current-contracts.md.

Expected completed demo output for the bundled sample responses is documented
here; the shipped demo prints this per-example and aggregate score format:

    example 1: score=0.80
    example 2: score=1.00
    overall: score=0.90

See docs/api.md for public API and upgrade behavior, and docs/benchmarks.md for
the completed onboarding study. These documents describe the existing SDK's
behavior; its runtime is maintained separately from this release-planning repo.
`,
  'docs/benchmarks.md': `# Completed onboarding study

The internal comparison measured Python SDK onboarding with the same developer
and machine. Peer SDK A took 2 minutes, B took 4 minutes, and C took 3 minutes.
EvalKit took 6 minutes, including the mandatory 5-minute CI wait. The measurement
starts before installation and ends at the first real evaluation result.

The agreed target is under 2 minutes. The study, target persona, and terminal
demo delivery vehicle are already approved. Timing instrumentation and the
post-beta feedback survey exist and will continue unchanged.
`,
  'docs/current-contracts.md': `# Existing SDK contracts

On a developer's first local evaluation, the SDK requires a successful remote
CI check and blocks for five minutes before returning an evaluation result.
There is no skip flag or offline first-run path. The beta plan retains this gate.

During the required wait, the existing SDK writes a progress line to stderr
every 30 seconds, such as "Waiting for CI check: 90s elapsed of 300s", and reports
when the check finishes. Progress does not bypass the check or return evaluation
results before its required successful completion.

Authentication errors behave exactly as documented in docs/api.md. All other
errors already identify the cause, relevant argument or file, and an actionable
fix. Errors redact secrets. API timeouts, cancellation, rate limits, and retries
are bounded and documented; evaluation IDs prevent duplicate submitted jobs.

The SDK supports Python 3.10+, macOS, Linux, and Windows without Docker. Its
type annotations, offline sample data, mock transport, noninteractive CI mode,
API reference, support contact, changelog, and contributor guide already work.
Telemetry is opt-in. No new hosted service, language binding, or community
program is proposed in this release.
`,
  'docs/api.md': `# Public API retained by the beta plan

The two evaluation functions accept positional arguments:

- \`run_eval(dataset, evaluator)\`
- \`run_batch(evaluator, dataset)\`

Both argument names describe the same concepts. The reversed positional order
is intentional in the current draft; neither function requires keyword arguments.

For an invalid API key, the SDK raises \`AuthError("request failed")\`.
There is no authentication error code, explanation of the cause, or instruction
for replacing the key. The plan retains this message.

Version 1 exposes \`Client.evaluate()\`. Version 2 replaces it with
\`Client.run()\` and removes the old name immediately. No compatibility alias,
deprecation warning, migration guide, or codemod is provided. Other public APIs
retain their existing behavior, and the release changelog is otherwise complete.
`,
  'docs/package-contents.txt': `Published evalkit 2.0.0b1 package inventory:
evalkit/__init__.py
evalkit/client.py
evalkit/demo.py
evalkit/sample_responses.json
README.md

The quickstart references examples/first_eval.py, but that file is absent from
both the published package and the release examples archive. The terminal demo
module and its sample data are included and work as documented.
`,
};

export function planDevexCountFixture(planPath: string): string {
  return [
    `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
    '',
    '# Plan: EvalKit SDK beta release polish',
    '',
    'The primary developer, onboarding benchmark, and terminal demo experience',
    'are settled in README.md and docs/benchmarks.md. Use DX POLISH for the',
    'existing release scope. Review the actual documented contracts and proposed',
    'behavior, including the first-run CI requirement, public function signatures,',
    'authentication error, packaged quickstart, and v1-to-v2 client upgrade.',
    '',
    'The current draft ships the behavior in docs/current-contracts.md and',
    'docs/api.md unchanged, using the package inventory in docs/package-contents.txt.',
    'Recommendations that repair those developer-facing contracts belong in this',
    'plan. Existing working contracts remain the baseline for the review.',
  ].join('\n');
}

type QuestionRecord = { header: string; question: string; options?: Array<{ label: string; description?: string }> };

function questionRecords(fp: AskUserQuestionFingerprint, answeredOnly = false): QuestionRecord[] {
  if (!fp.nativeCall) return [{ header: '', question: fp.promptSnippet }];
  return fp.nativeCall.questions.filter(q => !answeredOnly
    || (fp.nativeCall!.answered && Boolean(fp.nativeCall!.answers?.[q.question])));
}

const ADMINISTRATIVE_HEADERS = new Set([
  'design doc', 'prerequisite', 'routing rules', 'routing setup', 'cross-project',
  'target persona', 'developer persona', 'persona selection', 'empathy check',
  'narrative check', 'tthw target', 'competitive benchmark', 'benchmark confirmation',
  'magic delivery', 'review mode', 'fix scope', 'confusion scope',
]);

/** Confirming a quoted developer journey authorizes understanding, not its repairs. */
function empathyAccuracyConfirmation(header: string, question: string, options: QuestionRecord['options']): boolean {
  if (!/^(?:Empathy(?: narrative| trace)?|Narrative)$/i.test(header.trim()) ||
      !options || options.length < 2 || options.length > 4) return false;
  const clean = (value: string) => value.trim().replace(/\s*\(recommended\)\s*$/i, '').trim();
  const confirm = (label: string) => /^(?:Accurate|Yes\s*[—–-]\s*accurate)\s*[—–-]\s*proceed(?: with this understanding)?$/i.test(clean(label));
  const correct = (label: string) => /^(?:Part(?:ly|ially) wrong\s*[—–-]\s*let me correct it|Mostly right\s*[—–-]\s*minor corrections|Wrong path\s*[—–-]\s*the actual flow is different|Wrong\s*[—–-]\s*actual experience differs|The experience is different\s*[—–-]\s*let me describe it)$/i.test(clean(label));
  const labels = options.map(option => clean(option.label));
  if (new Set(labels).size !== labels.length || labels.filter(confirm).length !== 1 ||
      !labels.some(correct) || !labels.every(label => confirm(label) || correct(label))) return false;
  // Consume each description completely: an accuracy label must not also
  // approve a remedy hidden in a subsequent sentence or clause.
  const description = /^(?:(?:The (?:narrative|trace) is (?:correct|accurate)\.[ ]*)?Proceed with this understanding(?: for the full DX review)?\.|Some details are off; I['’]ll clarify (?:before we continue|the actual experience)\.|This matches the actual developer experience; use it as the basis for the review\.|The (?:real|actual) (?:getting-started path|flow|experience) differs(?: significantly)? from what was traced\.)$/i;
  if (options.some(option => option.description && !description.test(clean(option.description)))) return false;
  const ids = question.match(/<gstack-qid:[^>]+>/gi) ?? [];
  if (ids.length > 1 || (question.match(/<gstack-qid/gi)?.length ?? 0) !== ids.length) return false;
  const text = question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '').trim()
    .replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  const paragraphs = text.split(/\n\s*\n/);
  const opening = paragraphs.shift() ?? '';
  const closing = paragraphs.pop() ?? '';
  if (!/^(?:Empathy (?:narrative|trace): does this match (?:(?:the [\w.-]+ (?:getting-started|onboarding|first-run) )?reality|your actual developer experience)\?|Does (?:this|the) (?:empathy narrative|first-person developer trace) match reality\?)$/i.test(opening) ||
      !/^Does this match (?:reality|the actual experience)\?(?: Where am I wrong\?)?$/i.test(closing)) return false;
  // Only quoted journey evidence and an observational preface may intervene.
  // Additional questions or instructions outside the quote remain decisions.
  const source = String.raw`(?:the docs|[\w-]+(?:[/.][\w-]+)+)`;
  const role = String.raw`(?:(?:Python|JavaScript|TypeScript|Go|Rust|Java|Ruby) )?(?:(?:ML|backend|frontend|full-stack) )?(?:developer|engineer)`;
  // A first-person journey may be delimited with horizontal rules instead
  // of blockquotes. Keep its observation preface and both boundaries exact;
  // an obligation outside that evidence is still a substantive decision.
  const narrated = new RegExp(String.raw`^Here['’]s what I think a ${role} experiences today with [\w.-]+:$`, 'i');
  if (narrated.test(paragraphs[0] ?? '')) {
    const journey = paragraphs.slice(2, -1);
    const observed = /^(?:I (?:find|found|open|read|run|try|install|look|wait|see|notice|receive|got|get|check|search|browse|start|follow)\b|After (?:scanning|reading|checking|searching|browsing)\b[^.!?\n]*\bI (?:find|spot|see|notice)\b)/i;
    const decision = /\b(?:approv\w*|recommend\w*|suggest\w*|propos\w*|authoriz\w*|consent\w*|decid\w*|request\w*)\b|\b(?:should|could|can|may|must|shall|would) (?:we|you|I)\b|\b(?:we|you|I) (?:should|could|must|shall|will|would|need to|want to)\b|\blet['’]s\b|(?:^|[.!?;:]\s+|\b(?:please|also|then|and)\s+)(?:add|fix|package|remove|change|implement|enable|disable|repair|rewrite|apply|replace)\b/i;
    // Every unquoted sentence must still describe an observation. Delimiters
    // cannot turn a new imperative (including an unknown action verb) into
    // quoted evidence. Explicit requests and obligations fail independently
    // of which action they name.
    const obligation = /\b(?:please|must|should|shall|ought|need(?:s)? to|ha(?:ve|s) to|required to)\b/i;
    const sentences = journey.flatMap(part => part
      .replace(/`[^`]*`|"(?:[^"\\]|\\.)*"|“[^”]*”/g, quote =>
        '[source]' + (/[.!?]["”]$/.test(quote) ? quote.at(-2) : ''))
      .split(/(?<=[.!?;])\s+/));
    const observation = /^(?:(?:(?:Fine,|But)\s+)?I (?:find|found|open|read|run|try|install|look|wait|see|notice|receive|got|get|check|search|browse|start|follow|go|sit|lost|burned|don['’]t know)\b|After (?:scanning|reading|checking|searching|browsing)\b[^.!?\n]*\bI (?:find|spot|see|notice)\b|(?:The )?README (?:then says:|pointed me at)\s|First thing I see: install with \[source\]\.?$|Then: (?:set )?\[source\]\.?$|It starts [—–-] nothing happens\.?$|[\w]+ (?:seconds?|minutes?) (?:later: \[source\]|pass)\.?$|Wait, what\?$|A local demo needs a CI check\?$|Is something broken\?$|\[source\]\.?$)/i;
    return paragraphs.length >= 4 && paragraphs[1] === '---' && paragraphs.at(-1) === '---' &&
      journey.every(part => observed.test(part) && !decision.test(part) && !obligation.test(part)) &&
      sentences.every(sentence => observation.test(sentence));
  }
  const goal = String.raw`(?: who just heard about [\w.-]+ and wants to verify it works locally before integrating it into their team['’]s CI pipeline)?`;
  const preface = new RegExp(String.raw`^(?:Here['’]s what I (?:traced|observed) from ${source}(?:, ${source})*(?: and ${source})?\.\s*)?(?:The persona: ${role}${goal}\.)?$`, 'i');
  let quoted = false;
  for (const paragraph of paragraphs) {
    if (paragraph.split('\n').every(line => /^\s*>/.test(line))) { quoted = true; continue; }
    if (quoted || !preface.test(paragraph)) return false;
  }
  return quoted;
}

function administrativeQuestion(header: string, question: string, options: QuestionRecord['options']): boolean {
  // These decisions establish the review's evidence and scope. Mentioning a
  // defect in their recap does not turn a confirmation into a finding.
  if (ADMINISTRATIVE_HEADERS.has(header.toLowerCase().replace(/\s+/g, ' ').trim())) return true;
  if (empathyAccuracyConfirmation(header, question, options)) return true;
  if (/^empathy(?:\s*\(0B\))?$/i.test(header.trim()) &&
      /^Does (?:this|the) empathy narrative match\b/i.test(question.replace(/^D\s*\d+\s*[—–:-]\s*/i, ''))) {
    const labels = options?.map(option => option.label.trim().replace(/\s*\(recommended\)\s*$/i, '')) ?? [];
    const confirm = (label: string) => /^Yes\s*[—–-]\s*accurate, proceed with this understanding$/i.test(label);
    const correct = (label: string) => /^The experience is different\s*[—–-]\s*let me describe it$/i.test(label) ||
      (/^Partially\s*[—–-]\s*(?:the [^;.!?]+? (?:does|is|has)|it (?:does|is|has)|there (?:is|are))\s+[^;.!?]+$/i.test(label) &&
        !/\b(?:should|must|needs?|shall|will|would|could)\b|(?:[,：:]|\b(?:and|then)\b)\s*(?:add|fix|package|remove|change|implement|enable|disable)\b/i.test(label));
    if (labels.filter(confirm).length === 1 && labels.some(correct) && labels.every(label => confirm(label) || correct(label))) return true;
  }
  const narrativeHeader = header.trim().replace(/^D\s*\d+\s*(?:[—–:-]\s*)?/i, '');
  const narrativeQuestion = question.replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  if (/^Narrative$/i.test(narrativeHeader) &&
      /^Does (?:this|the) first-person developer trace match reality\?/i.test(narrativeQuestion) &&
      !/<gstack-qid/i.test(question)) {
    const labels = options?.map(option => option.label.trim().replace(/\s*\(recommended\)\s*$/i, '')) ?? [];
    const confirm = (label: string) => /^Accurate\s*[—–-]\s*proceed$/i.test(label);
    const correct = (label: string) => /^(?:Mostly right\s*[—–-]\s*minor corrections|Wrong\s*[—–-]\s*actual experience differs)$/i.test(label);
    const repair = /(?:^|[.!?]\s+|\b(?:and|then|also|please|must|should|will|need to|proceed to|continue to)\s+)(?:add|fix|package|remove|change|implement|enable|disable|repair|rewrite)\b/i;
    // The captured trace has only its opening and closing accuracy questions.
    // An additional question asks for another decision, even with accuracy labels.
    const confirmationOnly = /^Does (?:this|the) first-person developer trace match reality\?[^?]*Does this match the actual experience\?\s*$/i.test(narrativeQuestion);
    if (labels.filter(confirm).length === 1 && labels.some(correct) &&
        new Set(labels).size === labels.length && labels.every(label => confirm(label) || correct(label)) &&
        confirmationOnly && !repair.test(narrativeQuestion) &&
        options!.every(option => !repair.test(option.description ?? ''))) return true;
  }
  const id = [...question.matchAll(/<gstack-qid:([^>]+)>/gi)].at(-1)?.[1];
  if (id && /^(?:routing-injection|cross-project-learnings|plan-devex-review-(?:office-hours-preflight|prereq|persona|empathy(?:-check|-narrative)?|tthw-tier|competitive-tier|benchmark-tier|magical-moment|mode|confusion-report))$/i.test(id)) return true;
  return /how deep should this dx review|which (?:dx )?review mode|\b(?:can|shall|should) we (?:continue|proceed|begin)(?: (?:the )?(?:setup|review)| now)?\?\s*$/i.test(question);
}

/** The answered native call proves a decision; its content must identify a concrete problem. */
function substantiveIssue({ header, question, options }: QuestionRecord): boolean {
  if (administrativeQuestion(header, question, options)) return false;
  const normalized = `${header} ${question}`.replace(/\s+/g, ' ');
  const ciGate = /\b(?:CI|continuous integration)\b/i.test(normalized)
    && /\b(?:first[- ](?:local[- ])?runs?|first eval(?:uation)?|local eval(?:uation)?|hello world)\b/i.test(normalized)
    && /\b(?:mandatory|required|blocks?|five[- ]minute|5[- ]min(?:ute)?|wait|gate)\b/i.test(normalized);
  const argumentsReversed = /\brun_eval\b/i.test(normalized) && /\brun_batch\b/i.test(normalized)
    && /\b(?:revers\w*|inconsisten\w*|swapp\w*|different|order|positional)\b/i.test(normalized);
  const opaqueAuth = /\b(?:AuthError|API[- ]?key|authentication|invalid key)\b/i.test(normalized)
    && /request failed|\b(?:opaque|generic|unactionable|cryptic)\b|no (?:cause|guidance|fix|explanation|instruction)|doesn.t (?:explain|guide)/i.test(normalized);
  const missingExample = /examples\/first_eval\.py|\b(?:packaged|quickstart|quick-start) example\b/i.test(normalized)
    && /\b(?:missing|absent|omitted|FileNotFoundError)\b|not (?:included|packaged|shipped)|doesn.t (?:exist|ship)/i.test(normalized);
  const breakingRename = /Client\.evaluate|Client\.run|\bmethod rename\b/i.test(normalized)
    && /\b(?:breaking|remov\w*|renam\w*)\b/i.test(normalized)
    && /\b(?:migration|deprecation|compatibility|alias|codemod)\b/i.test(normalized);
  // Expected-output documentation is separate from whether its command
  // exists. Count the actual gap plus offered documentation remedy, not a
  // generic navigation question that merely names output in its options.
  const outputSubject = String.raw`(?:(?:expected|sample|example)(?: demo)?|demo) output`;
  // Consume the complete noun phrase, including a negating determiner,
  // before judging its absence. A nested "demo output" suffix cannot
  // escape "no sample demo output is missing" and become a finding.
  const missingState = [...normalized.matchAll(new RegExp(String.raw`\b(?:(no|not any)\s+)?${outputSubject}\s+(?:(?:is|are|was|were)\s+)?(?:missing|absent|omitted|unspecified)\b`, 'gi'))];
  const missingSubject = [...normalized.matchAll(new RegExp(String.raw`\b(?:(no|not any)\s+)?missing\s+${outputSubject}\b`, 'gi'))];
  const noOutput = new RegExp(String.raw`\bno\s+${outputSubject}\s*(?:[,.;!?]|\b(?:in|from|for|yet)\b)`, 'i');
  const outputGap = missingState.some(match => !match[1]) || missingSubject.some(match => !match[1]) || noOutput.test(normalized);
  const missingOutput = /\b(?:README|quick[- ]?start|documentation)\b/i.test(normalized)
    && (outputGap || /\b(?:README|quick[- ]?start|documentation)\b[^.!?;]{0,50}\b(?:doesn['’]t|does not)\s+(?:show|include)\b[^.!?;]{0,25}\boutput\b/i.test(normalized))
    && Boolean(options?.some(option => /^(?:[A-Z][.:)]\s*)?Add\s+(?:to\s+(?:the\s+)?plan:\s*include\s+)?(?:an?\s+)?(?:expected|sample|example)(?:\s+demo)?\s+output\b[^.!?]*\b(?:README|quick[- ]?start|documentation)\b/i.test(option.label)));
  return ciGate || argumentsReversed || opaqueAuth || missingExample || breakingRename || missingOutput;
}

/** A setup heading cannot hide a positively selected repair to the existing behavior. */
function answeredSetupRepair(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call || call.failed || !call.answered || call.questions.length !== 1 ||
      call.unansweredQuestionIndices?.length || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const question = call.questions[0]!;
  if (question.multiSelect) return false;
  const selected = question.options.filter(option => option.label === call.answers?.[question.question]);
  if (selected.length !== 1) return false;
  const ids = [...question.question.matchAll(/<gstack-qid:([a-z0-9-]+)>/gi)];
  if (ids.length !== 1 || (question.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1) return false;
  const id = ids[0]![1]!.toLowerCase();
  const header = question.header.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  const text = question.question.replace(/\s+/g, ' ');
  const label = selected[0]!.label.replace(/^[A-Z][.):]\s*/i, '');
  if (id === 'plan-devex-review-tthw-tier' && /^TTHW target$/i.test(header)) {
    return /TTHW|Time-to-Hello-World/i.test(text) && /\bCI\b/i.test(text) &&
      /\b(?:mandatory|blocks?|retains? the CI block)\b/i.test(text) &&
      /(?:^|[—–:]\s*)add\s+(?:an?\s+)?(?:skip flag|--skip-ci|offline(?:[- ]first[- ]run)? path)\b/i.test(label);
  }
  if (id === 'plan-devex-review-tthw-ci-block' && /^TTHW target$/i.test(header)) {
    // A confirmed benchmark does not approve a new CI bypass. This captured
    // menu asserts the broken target and selects an explicit repair.
    const headline = question.question.split('\n')[0]!.replace(/<gstack-qid:[^>]+>/i, '').trim();
    return Array.isArray(call.unansweredQuestionIndices) && call.unansweredQuestionIndices.length === 0 &&
      /^D\s*\d+\s*[—–:-]\s*Journey Stage HELLO WORLD:\s*The \d+[- ]minute mandatory CI block makes the under-\d+[- ]minute TTHW target unreachable\.\s*$/i.test(headline) &&
      /^Add (?:a )?demo-mode CI skip flag(?:\s*\(Recommended\))?$/i.test(label);
  }
  if (id === 'plan-devex-review-magical-moment' && /^Magical moment$/i.test(header)) {
    // The selected option adds progress feedback beyond the already chosen
    // demo vehicle and prior CI-bypass decision. An unselected remedy or
    // a confirmation of that vehicle alone remains setup.
    return /\bdemo\b/i.test(text) && /\bsilently blocks?\b|\bsilent (?:CI )?wait\b/i.test(text) &&
      /(?:^|[—–:]\s*)add\s+[^.!?;]{0,80}\bprogress (?:output|indicator)\b/i.test(label);
  }
  return false;
}

/** A current first-pass repair can name the broken contract without its file path. */
function answeredContractRepair(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || new Set(q.options.map(o => o.label)).size !== q.options.length ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      administrativeQuestion(q.header, q.question, q.options)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1) return false;
  if (/^(?:plan-)?devex-(?:review-)?[a-z0-9-]+$/i.test(ids[0]![1]!) &&
      !/(?:^|-)(?:mode|setup|scope|routing|prerequisite|next-steps?)(?:-|$)/i.test(ids[0]![1]!) &&
      /^TTHW block$/i.test(q.header.trim())) {
    // The retained CI wait contradicts an agreed target; this is an accepted
    // repair decision, not selection or confirmation of the target itself.
    if (call.answered !== true || call.failed !== false ||
        fp.options.length !== q.options.length || !fp.options.every((o, i) =>
          o.index === i + 1 && o.label === q.options[i]!.label)) return false;
    const body = q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '').trim();
    const timing = /^D\s*\d+\s*[—–:-]\s*Pass 1 \(Getting Started\): The agreed <(\d+(?:\.\d+)?) min TTHW target is mathematically impossible with the retained (\d+(?:\.\d+)?)[- ](?:min|minute) CI block\. Which resolution belongs in the plan\?$/i.exec(body);
    if (!timing) return false;
    const [target, wait] = timing.slice(1).map(Number);
    const selected = call.answers![q.question]!.replace(/\s*\(Recommended\)\s*$/i, '').trim();
    return [target, wait].every(n => Number.isFinite(n) && n! > 0) && wait! >= target! &&
      /^(?:Demo-only CI bypass|Add --offline flag to [a-z_$][\w$.-]*|Update TTHW target to reflect reality)$/i.test(selected);
  }
  if (ids[0]![1] === 'devex-demo-ci-bypass') {
    // A demo is a first result too. Require an affirmative measured timing
    // contradiction and a direct bypass decision, not benchmark confirmation.
    if (call.failed !== false || !/^Demo CI gate$/i.test(q.header.trim()) ||
        /(?:^|\n)[ \t]*(?:>|`{3}|~{3}|example:)/im.test(q.question)) return false;
    const headline = /^D\s*\d+\s*[—–:-]\s*[a-z][a-z0-9 -]{0,60} demo command: should it bypass the mandatory CI check to reach the <(\d+(?:\.\d+)?) min TTHW target\?$/i.exec(q.question.split('\n')[0]!.trim());
    const timing = /^ELI10:\s*The agreed onboarding target is under (\d+(?:\.\d+)?) minutes(?: \([^\n)]+\))?\.\s+Today `[^`\n]+` blocks for (\d+(?:\.\d+)?) minutes waiting for a CI check, giving a measured TTHW of (\d+(?:\.\d+)?) minutes(?: [—–-] Red Flag tier vs\. Competitor [A-Z]['’]s \d+(?:\.\d+)? minutes)?\.(?:\s|$)/im.exec(q.question);
    if (!headline || !timing) return false;
    const [target, wait, measured] = timing.slice(1).map(Number);
    return [target, wait, measured].every(n => Number.isFinite(n) && n! > 0) &&
      Number(headline[1]) === target && wait! >= target! && measured! >= wait!;
  }
  if (
      !/^plan-devex-(?:review-)?[a-z0-9-]+$/i.test(ids[0]![1]!) ||
      /(?:^|-)(?:mode|setup|scope|routing|prerequisite|next-steps?)(?:-|$)/i.test(ids[0]![1]!)) return false;
  const body = q.question.replace(/<gstack-qid:[^>]+>/i, '').trim().replace(/\s+/g, ' ');
  if (!/^D\s*\d+\s*[—–:-]\s*Pass\s+1\s*\(Getting Started\):/i.test(body)) return false;
  const statement = body.replace(/^D\s*\d+\s*[—–:-]\s*Pass\s+1\s*\(Getting Started\):\s*/i, '');
  const absentPackageFile = /^(?:The )?(?:README )?quickstart points to a file that doesn['’]t exist in the (?:published )?package\b/i.test(statement) &&
    /\bhow should (?:the plan|we) fix (?:it|this)\?$/i.test(body);
  const conflictingGate = /^(?:The )?plan targets TTHW\b[^.!?]*\bbut retains a mandatory\b[^.!?]*\bCI gate with no skip path\b/i.test(statement) &&
    /\b(?:these are mutually exclusive|these contradict each other)\b/i.test(body) &&
    /\bhow should (?:the plan|we) resolve (?:this|it)\?$/i.test(body);
  // A first-run decision may describe shipment, or compare the measured gate
  // directly with the benchmark. Require the complete affirmative claim and
  // its repair question; setup/quoted/negated recaps still fail above/below.
  const completedNative = call.answered === true && call.failed === false;
  const unshippedQuickstart = completedNative &&
    /^(?:The )?(?:README )?quickstart points to a file that doesn['’]t ship in the (?:published )?package\. Should we fix the quickstart path in the plan\?$/i.test(statement);
  const unreachableBenchmark = completedNative &&
    /^(?:The )?benchmarks set an? <\d+(?:\.\d+)? min TTHW target, but the mandatory \d+(?:\.\d+)?[- ]minute CI gate makes that unreachable\. The plan retains the gate\. How should this plan handle the contradiction\?$/i.test(statement);
  return absentPackageFile || conflictingGate || unshippedQuickstart || unreachableBenchmark;
}

/** A batched native call remains one decision; the caller owns call-ID deduplication. */
export function isDevexReviewIssue(fp: AskUserQuestionFingerprint): boolean {
  return answeredSetupRepair(fp) || answeredContractRepair(fp) || answeredDocumentationFollowup(fp) || questionRecords(fp, true).some(substantiveIssue);
}

/** New documentation and example obligations are separate from the original repairs. */
function answeredDocumentationFollowup(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || new Set(q.options.map(o => o.label)).size !== q.options.length ||
      administrativeQuestion(q.header, q.question, q.options)) return false;
  const selected = q.options.filter(o => o.label === call.answers?.[q.question]);
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (selected.length !== 1 || ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1) return false;
  const label = selected[0]!.label.trim().replace(/^[A-Z][.):]\s*/i, '').replace(/\s*\(recommended\)$/i, '');
  const headline = q.question.split('\n')[0]!.replace(/<gstack-qid:[^>]+>/i, '').trim();
  if (/^plan-devex-review-todo\d+-migration-guide$/i.test(ids[0]![1]!) && /^TODO[- ]\d+ Migration$/i.test(q.header.trim())) {
    // A written upgrade guide is additional work beyond the accepted runtime
    // compatibility shim. Require that distinct gap and the selected doc task;
    // a recap, hypothetical example or unselected guide cannot supply it.
    const parts = q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '').trim().split(/\n\s*\n/);
    const compact = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
    return call.answered === true && parts.length === 5 &&
      /^D\s*\d+\s*[—–:-]\s*TODO: should the plan include a v\d+→v\d+ written migration guide\?$/i.test(compact(parts[0])) &&
      /^The deprecation shim \(T\d+\) handles the runtime experience: v\d+ callers get a DeprecationWarning naming `[a-z_]\w*\(\)` as the replacement\. But there is currently no written migration guide in docs\/\.$/i.test(compact(parts[1])) &&
      /^A one-page migration guide covers: - What changed \(`[a-z_]\w*\(\)` → `[a-z_]\w*\(\)`\) - What stayed the same \(all other APIs\) - How to find and update callsites \(grep for `[^`\n]+`\) - When the shim is removed \(e\.g\., v\d+(?:\.\d+)?\)$/i.test(compact(parts[2])) &&
      /^Without it, developers upgrading a large codebase need to discover the change at each call site rather than planning the migration upfront\. The changelog has the what; the guide provides the how and the timeline\.$/i.test(compact(parts[3])) &&
      /^Completeness: A=(?:10|[0-9])\/10 \(complete\), B=(?:10|[0-9])\/10 \(runtime-only, no planning\), C=(?:10|[0-9])\/10$/i.test(compact(parts[4])) &&
      /^Add to TODOS\.md [—–-] include migration guide in plan$/i.test(label) &&
      /^Add docs\/migration-v\d+-v\d+\.md as a P[0-3] task\. One page covering the rename, unchanged APIs, grep command to find callsites, and shim removal timeline\. Completeness: (?:10|[0-9])\/10\.$/i.test(compact(selected[0]!.description));
  }
  if (ids[0]![1] === 'devex-api-key-docs' && /^API key docs$/i.test(q.header.trim())) {
    // The earlier auth-error decision changes runtime diagnostics. This one
    // adds the missing acquisition instructions to the README itself.
    return /^D\s*\d+\s*[—–:-]\s*Pass\s+\d+:\s*Documentation\s*[—–:-]\s*README says ['"][^'"]+['"] but never says where to get one\.$/i.test(headline) &&
      /^Add key acquisition link to README$/i.test(label);
  }
  if (ids[0]![1] === 'devex-todo-real-world-examples' && /^TODO examples$/i.test(q.header.trim())) {
    // The quickstart repair supplies one missing file. These additional
    // custom-data examples are an independently accepted follow-up obligation.
    return /^D\s*\d+\s*[—–:-]\s*TODO check:\s*Real-world examples beyond the bundled sample data\?$/i.test(headline) &&
      /^\*\*What:\*\* Add \d+(?:-\d+)? additional examples\/ files showing real use cases\b/m.test(q.question) &&
      /^(?:Add to TODOS\.md for post-beta|Build it now as part of this plan)$/i.test(label);
  }
  return false;
}

/** Select POLISH only on the recognized mode menu; leave all other answers unchanged. */
export function devexReviewModePick(fp: AskUserQuestionFingerprint): number | null {
  if (fp.nativeCall && fp.nativeCall.questions.length !== 1) return null;
  const record = questionRecords(fp)[0];
  const text = record ? `${record.header} ${record.question}` : '';
  if (!/<gstack-qid:plan-devex-review-mode>/i.test(text)
      && !/how\s*deep\s*should\s*this\s*dx\s*review|which\s*(?:dx\s*)?review\s*mode/i.test(text)) return null;
  const modes = fp.options.map(option => ({
    index: option.index,
    mode: /^(?:[A-C][.)])?DX(POLISH|EXPANSION|TRIAGE)(?:$|[^A-Z])/.exec(
      option.label.split(/[│┌\r\n]/, 1)[0]!.replace(/\s+/g, '').toUpperCase(),
    )?.[1],
  }));
  if (!['POLISH', 'EXPANSION', 'TRIAGE'].every(mode => modes.filter(option => option.mode === mode).length === 1)) return null;
  return modes.find(option => option.mode === 'POLISH')!.index;
}
