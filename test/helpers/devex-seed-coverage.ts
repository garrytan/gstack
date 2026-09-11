import type { NativePlanQuestion, PlanCountTranscript } from './plan-count-transcript';

export const DEVEX_SEEDED_GAPS = [
  'local-ci-gate', 'missing-quickstart', 'reversed-arguments', 'opaque-auth-error', 'breaking-upgrade',
] as const;
export type DevexSeededGap = typeof DEVEX_SEEDED_GAPS[number];

/** Bind an unnamed signature question to its own first asserted explanation. */
function explainedReversedSignatures(q: NativePlanQuestion, title: string): boolean {
  const question = /^(?:Journey stage [A-Z ]+: )?the two public functions take the same two arguments in (?:opposite|reversed) positional order\. How should (?:the plan|we) (?:fix|align|unify) the signatures\?$/i.test(title);
  const traced = /^Journey stage: REAL USAGE\. Two sibling functions take the same two arguments in (?:opposite|reversed) order\.$/i.test(title);
  const declared = traced || /^Journey stage(?: REAL USAGE:|: REAL USAGE\.) The two public evaluation functions take the same two arguments in (?:opposite|reversed) order\.$/i.test(title);
  // A dedicated assertion can put its named signatures in its own Evidence
  // field. Bind subject, source identities and repair instead of menu wording.
  const subject = title.replace(/^Journey stage(?: REAL USAGE:|: REAL USAGE\.)\s*/i, '');
  const evidenced = !question && !declared &&
    /^(?:the )?(?:two|both) public (?:evaluation )?functions take\b/i.test(subject) &&
    /\bthe same two arguments\b/i.test(subject) && /\b(?:opposite|reversed) (?:positional )?order\.?$/i.test(subject);
  const declaration = declared || evidenced;
  if (!question && !declaration) return false;
  const lines = q.question.split('\n');
  if (lines[0]!.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '') !== title) return false;
  const explanation = lines.findIndex(line => line.startsWith('ELI10: '));
  const context = lines.slice(1, explanation).filter(line => line.trim());
  const project = traced ? /^Project\/branch\/task: [^;\n]+; ([\w./-]+):\d+(?:[-–]\d+)?\.$/.exec(context[0] ?? '') : declaration && context.length === 1
    ? /^Project\/branch\/task: [^;\n]+; ([\w./-]+) lines? \d+(?: to |[-–])\d+\.$/.exec(context[0]!) : null;
  if (explanation < 1 || (declared && !project) || (!traced && !evidenced && context.some(line =>
    (!declaration && !/^Project\/branch\/task: [^;\n]+; reviewing the public function signatures in [\w./-]+\.$/.test(line)) ||
    /\b(?:quoted|source excerpt|source example|hypothetical|historical|not (?:a )?current|if approved)\b/i.test(line)))) return false;
  // Inline code may name each signature; a quoted/fenced explanation, earlier
  // unrelated sentence, past definition or hypothetical definition cannot.
  const declaredSignatures = traced
    ? /^I traced the first real integration after the demo\. ([\w./-]+) lists the two evaluation functions: (`?)run_eval\(\s*dataset\s*,\s*evaluator\s*\)\2 and (`?)run_batch\(\s*evaluator\s*,\s*dataset\s*\)\3\./.exec(context[1] ?? '')
    : declaration && /^ELI10: ([\w./-]+) documents (`?)run_eval\(\s*dataset\s*,\s*evaluator\s*\)\2 and (`?)run_batch\(\s*evaluator\s*,\s*dataset\s*\)\3\. Same two concepts, reversed positional order, and neither function requires keywords\./.exec(lines[explanation]!);
  if (!evidenced && (declaration ? !declaredSignatures || declaredSignatures[1] !== project?.[1]
    : !/^ELI10: [\w./-]+(?: lines? \d+(?:\s*[-–]\s*\d+)?)? define (`?)run_eval\(\s*dataset\s*,\s*evaluator\s*\)\1 and (`?)run_batch\(\s*evaluator\s*,\s*dataset\s*\)\2\./.test(lines[explanation]!))) return false;
  const currentProse = (text: string) => {
    let fence = false;
    return text.split('\n').filter(line => {
      if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return false; }
      return !fence && !/^\s*>/.test(line);
    }).join('\n')
      .replace(/(^|[.!?\n]\s*)((?:Correction:\s*)?(?:this|that|the) (?:evidence|trace) (?:is|was|has been) )["“'‘`](withdrawn|rejected|cancelled|canceled|superseded|historical|hypothetical|(?:not|no longer) current)["”'’`]/gi, '$1$2$3')
      .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, '');
  };
  // The traced declaration owns its named signatures before ELI10, so its
  // currentness must include that same source paragraph.
  const current = currentProse(lines.slice(traced || evidenced ? 1 : explanation).join('\n'));
  if ((current.match(/^ELI10:/gm)?.length ?? 0) !== 1) return false;
  if (declaration && /\b(?:if|once|when|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i.test(current)) return false;
  if (declaration && /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:these|the) (?:functions|signatures) (?:are (?:now|already)|have been) (?:aligned|consistent)\b/i.test(current)) return false;
  if ((traced || evidenced) && /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:this|that|the) (?:trace|evidence) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|historical|hypothetical|(?:not|no longer) current)\b/i.test(current)) return false;
  if (/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:(?:this|that|the) (?:finding|explanation)|(?:(?:this|that|the) )?argument[- ]order (?:issue|defect)|these signatures)\b[^.\n]*\b(?:withdrawn|rejected|(?:already )?(?:fixed|resolved)|historical|(?:not|no longer) current)\b/i.test(current) ||
      /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:there is|there's) no argument[- ]order (?:issue|defect)\b/i.test(current) ||
      /(?:^|[.!?\n]\s*)(?:Correction:\s*)?run_eval and run_batch now (?:use|take) the same positional order\b/i.test(current)) return false;
  if (evidenced) {
    // Only an asserted citation at the start of this decision's field owns
    // the pair; quoted examples, later borrowed prose and split fields do not.
    const fields = lines.slice(1, explanation + 1).filter(line => /^(?:Evidence|ELI10):/.test(line));
    const pair = /^(?:Evidence|ELI10):\s*[\w./-]+(?: lines? \d+(?:[-–]\d+)?|:\d+(?:[-–]\d+)?)?:\s*(`?)run_eval\(\s*dataset\s*,\s*evaluator\s*\)\1 and (`?)run_batch\(\s*evaluator\s*,\s*dataset\s*\)\2(?:[.;]|$)/;
    if (!fields.some(line => pair.test(line)) || fields.some(line =>
      /^(?:Evidence|ELI10):\s*(?:>|`|"|“|Source\b|Quoted\b|Historical\b|Earlier\b|Example\b|Hypothetical\b|If\b|Assuming\b|Provided\b)/i.test(line))) return false;
    return q.options.some(option => {
      const label = currentProse(option.label.replace(/`(\(\s*dataset\s*,\s*evaluator\s*\))`/g, '$1'));
      const remedy = currentProse(option.description ?? '');
      const first = remedy.split(/[.!?\n]/)[0] ?? '';
      return /^(?:[A-D]\)\s*)?(?:Align|Unify|Standardize)\b/i.test(label) && /\(\s*dataset\s*,\s*evaluator\s*\)/.test(label) &&
        /\bsame (?:positional )?order\b/i.test(first) && /\bboth functions\b/i.test(first) &&
        /\bkeywords? (?:accepted|supported)\b|\baccept keywords\b/i.test(remedy) &&
        /\bswaps? (?:is |are )?(?:detected|caught|rejected)\b/i.test(remedy) && /\b(?:clear|actionable) (?:error|message)\b/i.test(remedy) &&
        !/\b(?:if|unless|when|once|after|pending)\b|\b(?:no|not|never|without|do not|don't)\b|\b(?:other|another|foreign|different) (?:functions?|API|pair|project|issue)\b/i.test(`${label}\n${remedy}`) &&
        !/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:this|that|the) (?:option|action|correction) (?:is|was|has been) (?:historical|withdrawn|rejected|cancelled|canceled|superseded|(?:not|no longer) current)\b/i.test(remedy) &&
        !/\brun_(?!eval\b|batch\b)\w+\b/.test(remedy);
    });
  }
  // A declared reversal may offer a keyword-only repair instead of a swap
  // guard. It must bind both arguments to both functions in the same option.
  if (declaration) return q.options.some(option =>
    (traced ? /^Fix in plan: same order \+ keyword-only for both(?: \(recommended\))?$/i.test(option.label) &&
      /^✅\s*run_eval\(\*\s*,\s*dataset\s*,\s*evaluator\s*\) and run_batch\(\*\s*,\s*dataset\s*,\s*evaluator\s*\); wrong order becomes a TypeError naming the parameter at the call site\b/i.test(option.description ?? '')
      : /^(?:Align|Unify|Standardize) order \+ keyword-only(?: \(recommended\))?$/i.test(option.label) &&
        /^Both functions (?:take|accept|use) dataset and evaluator as keyword-only in the same order\./i.test(option.description ?? '')) &&
    !/\b(?:if|once|when|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i.test(currentProse(option.description ?? '')) &&
    !/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:(?:do not|don't|never) (?:change|align|unify) (?:either|both|the|these) (?:functions?|signatures?)\b|(?:do not|don't|never) (?:make|require) (?:either|both|the) (?:functions?|signatures?|arguments?) keyword-only\b|(?:this|the) (?:option|correction|action) is (?:withdrawn|rejected|cancelled)\b)/i.test(currentProse(option.description ?? '')));
  // The same offered action must align both functions and retain the call-site
  // swap guard. Selecting an offered alternate or deferral is still a decision.
  return q.options.some(option => /^Same order\s*\+\s*swap guard(?: \(recommended\))?$/i.test(option.label) &&
    /^(?:✅\s*)?Both (?:become|use|take) `?\(\s*dataset\s*,\s*evaluator\s*\)`?, accept keywords, and raise a call-site `?TypeError`? naming the swapped argument and the fix if types are reversed\./i.test(option.description ?? '') &&
    !/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:(?:do not|don't|never) (?:change|align|unify) (?:either|both|the) signatures?\b|(?:do not|don't|never|skip) (?:add|require|implement) (?:a |the )?swap guard\b|(?:this|the) (?:option|correction|action) is (?:withdrawn|rejected|cancelled)\b)/i.test(currentProse(option.description ?? '')));
}

/** Identify a dedicated seed decision by its subject and meaningful alternatives. */
function decisionGaps(q: NativePlanQuestion): DevexSeededGap[] {
  const rawTitle = q.question.split('\n')[0]!.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  const title = rawTitle.replace(/`([^`\n]+)`/g, '$1');
  const questionMarks = title.match(/\?/g)?.length ?? 0;
  const upgradeVocabulary = /\b(?:alias|warning|compatibility|deprecat\w*|migration|remov\w*|rename|keep)\b/i.test(title);
  // A named method becoming its replacement is a transition even when the
  // title asks about a soft landing. Its own explanation must establish the gap.
  const upgradeTransition = !upgradeVocabulary && /\bClient\.evaluate\(\) becomes Client\.run\(\)/i.test(title);
  // Journey labels, possessives and a positive inclusive aside format the
  // asserted subject. Keep the original title for all meaning/currentness checks.
  // These six stages come from the skill's journey trace. A decision may span
  // adjacent touchpoints without changing the subject or who asserts it.
  const journeyStage = '(?:DISCOVER|INSTALL|HELLO WORLD|REAL USAGE|DEBUG|UPGRADE)';
  const stage = title.match(new RegExp(`^Journey stage ${journeyStage}(?:\\s*\\/\\s*${journeyStage})?: (.+)$`, 'i'))
    ?? title.match(new RegExp(`^Journey stage: ${journeyStage}(?:\\s*\\/\\s*${journeyStage})?\\. (.+)$`, 'i'));
  // New field declarations require a canonical stage. Existing direct
  // questions can still name another touchpoint without normalizing it.
  if (!stage && (/^Journey stage:/i.test(title) ||
      (/^Journey stage\b/i.test(title) && !title.includes('?')))) return [];
  if (stage && /^(?:Assuming|Provided)\b/i.test(stage[1]!.trim())) return [];
  const assertionTitle = stage ? stage[1]!
    .replace(/\b([A-Za-z0-9_.]+)['’]s\b/g, '$1')
    .replace(/, including ([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+){0,6}),/gi, (aside, subject: string) =>
      /\b(?:if|unless|assuming|provided|except|excluding|only|no|not|never|without|was|were|is|are|has|had|may|might|could|would|historical|earlier|quoted|source|example|hypothetical|fixed|resolved|cancelled|canceled|withdrawn|rejected|superseded)\b/i.test(subject) ? aside : '')
    : title;
  const opaqueAuthentication = /^(?:The )?authentication error says nothing[.?]?$/i.test(assertionTitle);
  const vanishingUpgrade = /^v\d+ Client\.evaluate\(\) vanishes in v\d+ with no warning, alias, or guide[.?]?$/i.test(assertionTitle);
  // A defect heading can assert a prerequisite or compare named signatures
  // without a finite verb. Keep these semantic families narrow: a topic label,
  // healthy signature pair or optional check is not an asserted defect.
  const nominalDefect = /^(?:The )?(?:Mandatory|Required) (?:\d+(?:\.\d+)?[- ](?:minute|second) )?(?:remote )?CI (?:check|gate) before (?:the )?first local (?:result|evaluation|run)[.?]?$/i.test(assertionTitle) ||
    /^run_eval\(\s*dataset\s*,\s*evaluator\s*\) (?:vs\.?|versus|and) run_batch\(\s*evaluator\s*,\s*dataset\s*\): (?:reversed|opposite|swapped) (?:positional|argument) order[.?]?$/i.test(assertionTitle);
  const nominalSubject = /^(?:Mandatory|Required|Optional)\b[^?!\n]*\bCI (?:check|gate)\b/i.test(assertionTitle) ||
    /^run_eval\([^)]+\) (?:vs\.?|versus|and) run_batch\([^)]+\):/i.test(assertionTitle);
  if (nominalSubject && !nominalDefect) return [];
  const signatureDeclaration = /^run_eval\(\s*dataset\s*,\s*evaluator\s*\) and run_batch\(\s*evaluator\s*,\s*dataset\s*\) (?:take|takes)\b/i.test(assertionTitle);
  if (/^run_eval\([^)]+\) and run_batch\([^)]+\) (?:take|takes)\b/i.test(assertionTitle) && !signatureDeclaration) return [];
  // The named tuples can establish the reversal without an adjective. Keep
  // their identities and order together; malformed or negated comparisons
  // cannot fall through to the broader direct-question path.
  const tupleSubject = /^run_eval (?:takes?|does not take)\b[^\n]*\brun_batch\b/i.test(assertionTitle);
  const tuples = /^run_eval takes\s*\(\s*(\w+)\s*,\s*(\w+)\s*\) (?:but|while) run_batch takes\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)(?:[.?]|\. Fix in plan\?)?$/i.exec(assertionTitle);
  const reversedTuples = Boolean(tuples && tuples[1] !== tuples[2] &&
    [tuples[1], tuples[2]].sort().join(',') === 'dataset,evaluator' &&
    tuples[1] === tuples[4] && tuples[2] === tuples[3]);
  if (tupleSubject && !reversedTuples) return [];
  const finiteTitle = signatureDeclaration ? assertionTitle.replace(/\([^)]*\)/g, '') : assertionTitle;
  // Negative availability asserts a missing referenced file. Bind it to that
  // object; do not erase a negation of the quickstart's own reference or gate.
  const absentReference = /\b(?:points?|references?) (?:at|to) (?:examples\/first_eval\.py|(?:a|the) (?:file|example)),? (?:which|that) (?:is not (?:shipped|in (?:the )?(?:package|wheel)(?: or (?:the )?(?:release )?examples archive)?)|does not (?:ship|exist))[.?]?$/i.test(assertionTitle);
  const newAssertion = nominalDefect || signatureDeclaration || reversedTuples || absentReference || opaqueAuthentication || vanishingUpgrade;
  const guardedDeclaration = Boolean(stage || newAssertion || upgradeTransition);
  const polarityTitle = absentReference ? title.replace(/\bdoes not (ship|exist)([.?]?)$/i, 'is absent$2') : title;
  // Punctuation cannot route a newly admitted asserted family around its
  // ownership checks; an offered alternate still resolves the same decision.
  const declaration = (questionMarks === 0 || (questionMarks === 1 && title.endsWith('?'))) &&
    (/^(?:[A-Za-z0-9_.]+\s+){1,12}(?:points?|references?|blocks?|requires?|takes?|raises?|removes?|drops?)\b/i.test(finiteTitle) || nominalDefect || opaqueAuthentication || vanishingUpgrade) &&
    !/^`[^`]*`$/.test(rawTitle) &&
    !/\b(?:if|unless|suppose|might|may|could|would|previously|earlier|historical|hypothetical|example|quoted|source|never|no longer|does not|do not|did not)\b/i.test(polarityTitle);
  if (newAssertion && !declaration) return [];
  if ((!declaration && (!title.endsWith('?') || questionMarks !== 1)) ||
      /^`[^`]*`[.?]?$/.test(rawTitle) ||
      /^(?:>|"|“|Example\b|Quoted\b|Source(?: excerpt| example)?[,:.]|Historical\b|Earlier review\b|If (?:approved|accepted)\b|Assuming\b|Provided\b|Suppose\b)|\bhypothetical\b/i.test(title) ||
      /\b(?:if|once|when|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i.test(title) ||
      /\b(?:continue|proceed|next section|move on|format|already (?:fixed|resolved))\b/i.test(title) ||
      /\b(?:have|did)\b[^?]*\bread\b|\b(?:narrative|trace|recap|summary)\b[^?]*\b(?:accurate|match|confirm)\b/i.test(title) ||
      /\b(?:report|summary|recap)\b[^?]*\b(?:mention|include|reference|list)\b|\b(?:mention|include|reference|list)\b[^?]*\b(?:report|summary|recap)\b/i.test(title)) return [];
  let offered = q.options;
  let signatureOptions = q.options;
  if (declaration || upgradeTransition) {
    const currentProse = (text: string, offeredAction = false) => {
      // In a tuple decision, a semicolon also separates current assertions.
      // Quotations and fenced examples are still removed as whole statements.
      if (reversedTuples || upgradeTransition) text = text.replace(/;/g, '.');
      // An option's trailing effort estimate separates its prose from an owned
      // status even without punctuation. Keep it on the same line so a quoted
      // historical sentence is still removed as one quotation below.
      const bounded = guardedDeclaration && offeredAction ? text.replace(/(\(human:[^()\n]{1,80}\/ CC:[^()\n]{1,80}\))[ \t]+(?=(?:Correction:\s*)?(?:(?:this|that|the) (?:option|action|correction)|D\s*[1-9]\d*) (?:is|was|has been) ["“'‘`]?(?:cancelled|canceled|superseded|withdrawn|rejected|(?:not|no longer) current)\b)/gi, '$1. ') : text;
      // Preserve a scalar status asserted by a current, unquoted owner before
      // removing source quotations. The owner must still match this decision.
      const owned = guardedDeclaration ? bounded.replace(/(^|[.!?\n]\s*)((?:Correction:\s*)?(?:(?:this|that|the) (?:finding|issue|gap|defect|explanation|option|action|correction)|D\s*[1-9]\d*) (?:is|was|has been) )["“'‘`](cancelled|canceled|superseded|withdrawn|rejected|(?:not|no longer) current)["”'’`]/gim, '$1$2$3') : bounded;
      let fence = false;
      return owned.split('\n').filter(line => {
        if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return false; }
        return !fence && !/^\s*>/.test(line);
      }).join('\n')
        .replace(/(^|[.!?\n]\s*)((?:Correction:\s*)?(?:this|that|the) (?:finding|issue|gap|defect|explanation|option|action|correction) (?:is|was|has been) )["“](withdrawn|rejected|(?:already )?(?:fixed|resolved)|historical|(?:not|no longer) current|cancelled)["”]/gim, '$1$2$3')
        .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, '');
    };
    const sourceFrame = /(?:^|[.!?\n;]\s*)(?:(?:ELI10|Project\/branch\/task):\s*)?(?:(?:Source(?: excerpt| example)?|Quoted(?: source| example)?|Historical(?: example| assessment)?(?: only)?|Earlier(?: review)? assessment|Example|Hypothetical(?: example| assessment| scenario)?|If approved|If accepted)[,:.]|(?:The following|This assessment|This explanation)\b[^.\n]*\b(?:quoted|source|historical|hypothetical|example)\b|Historically,)/i;
    const lines = q.question.split('\n'), explanation = lines.findIndex(line => /^ELI10:/.test(line));
    const preface = lines.slice(0, explanation < 0 ? undefined : explanation + 1).join('\n');
    if (guardedDeclaration && /^(?:Project\/branch\/task|ELI10):\s*(?:Assuming|Provided)\b/im.test(currentProse(preface))) return [];
    if (/^\s*(?:```|~~~)/m.test(preface) || sourceFrame.test(currentProse(preface)) ||
        /\bnot (?:a )?current (?:finding|issue|defect)\b/i.test(currentProse(preface))) return [];
    const current = currentProse(q.question);
    const approval = /\b(?:if|once|when|unless) (?:approved|accepted)|\b(?:after|pending) approval\b/i;
    if (upgradeTransition) {
      if (/^ELI10:\s*>/.test(lines[explanation] ?? '')) return [];
      const namedCurrent = currentProse(q.question.replace(/`([A-Za-z_$][\w.$]*(?:\(\))?)`/g, '$1'));
      if (/(?:^|[.!?\n]\s*)(?:Correction:\s*)?Client\.evaluate\(\) (?:is (?:now|already|still)|now remains) (?:a |an )?(?:deprecated |compatibility )?alias\b/i.test(namedCurrent)) return [];
      const first = currentProse((lines[explanation] ?? '').replace(/`([A-Za-z_$][\w.$]*(?:\(\))?)`/g, '$1'))
        .replace(/^ELI10:\s*/, '').split(/(?<=[.!?])\s/)[0] ?? '';
      if (explanation < 1 || lines.filter(line => /^ELI10:/.test(line)).length !== 1 || approval.test(current) ||
          /\b(?:if|unless|assuming|provided|suppose|might|may|could|would|previously|earlier|historical|hypothetical|never|no longer|does not|do not|did not)\b/i.test(`${title} ${first}`) ||
          !/\brenames Client\.evaluate\(\) to Client\.run\(\)/i.test(first) ||
          !/\b(?:deletes|removes|drops) (?:the )?old (?:name|method)\b/i.test(first) ||
          !/\b(?:no |without (?:a )?)(?:compatibility )?alias\b/i.test(first)) return [];
    }
    if (reversedTuples && (approval.test(current) ||
      /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:these (?:functions|signatures)|run_eval and run_batch) (?:are (?:now|already) aligned|(?:now )?(?:use|take) the same (?:positional )?order)\b/i.test(current))) return [];
    const decision = guardedDeclaration && /^D\s*([1-9]\d*)\s*[—–:-]/i.exec(q.question);
    if (decision && new RegExp(`(?:^|[.!?\\n]\\s*)(?:Correction:\\s*)?D\\s*${decision[1]} (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|(?:not|no longer) current)\\b`, 'i').test(current)) return [];
    if (guardedDeclaration && /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:this|that|the) (?:finding|issue|gap|defect|explanation) (?:is|was|has been) (?:cancelled|canceled|superseded)\b/i.test(current)) return [];
    if (/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:(?:this|that|the) (?:finding|issue|gap|defect|explanation) (?:is|was|has been) (?:withdrawn|rejected|(?:already )?(?:fixed|resolved)|historical|(?:not|no longer) current|(?:a |only a )?source example)|there is no (?:current )?(?:finding|issue|gap|defect))\b/i.test(current)) return [];
    // A declaration's action evidence must belong to a current offered option,
    // rather than an example or an explicitly withdrawn correction.
    const action = (text: string) => currentProse(text.replace(/`([A-Za-z_$][\w.$/-]*(?:\([^`\n]*\))?)`/g, '$1'), true);
    signatureOptions = offered.filter(option => {
      const text = `${option.label}\n${option.description ?? ''}`, prose = currentProse(text, true);
      if (upgradeTransition && (approval.test(prose) || /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:do not|don't|never) (?:keep|add|preserve|provide|retain) (?:the |a |an )?(?:compatibility )?alias\b/i.test(prose))) return false;
      if (reversedTuples && (approval.test(prose) ||
        /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:do not|don't|never) (?:align|unify|standardize|change|make|require) (?:either|both|the|these) (?:functions?|signatures?|arguments?)\b/i.test(prose))) return false;
      if (guardedDeclaration && /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:this|that|the) (?:option|action|correction) (?:is|was|has been) (?:cancelled|canceled|superseded|withdrawn|rejected|(?:not|no longer) current)\b/i.test(prose)) return false;
      if (guardedDeclaration && /^(?:Assuming|Provided)\b/im.test(prose)) return false;
      if (decision && new RegExp(`(?:^|[.!?\\n]\\s*)(?:Correction:\\s*)?D\\s*${decision[1]} (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|superseded|(?:not|no longer) current)\\b`, 'i').test(prose)) return false;
      return !/^(?:>|"|“)|^`[^`]*`$/.test(option.label.trim()) && !sourceFrame.test(prose) &&
        !/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:this|the) (?:option|action|correction) (?:is|was|has been) (?:withdrawn|rejected|cancelled)\b/i.test(prose);
    });
    // Preserve inline tuple evidence for the stricter signature parser.
    offered = signatureOptions.map(option => ({ ...option, label: action(option.label), description: action(option.description ?? '') }));
  }
  const options = offered.map(o => `${o.label} ${o.description ?? ''}`);
  const ownUpgradeAlias = (option: string) => !(upgradeTransition || vanishingUpgrade) || (
    /(?<![\w.])(?:Client\.)?evaluate\(\) (?:stays|remains) (?:as )?(?:a |an )?(?:thin |deprecated |compatibility )?alias\b|\b(?:keep|retain|preserve) (?<![\w.])(?:Client\.)?evaluate\(\) as (?:a |an )?(?:deprecated |compatibility )?alias\b/i.test(option) &&
    !/\b(?:no |without (?:a )?)(?:compatibility )?alias\b|\b(?:do not|don't|never) (?:keep|retain|preserve) (?:Client\.)?evaluate\(\)/i.test(option));
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(recommended\)$/i, '').toLowerCase());
  const yesNo = labels.length === 2 && labels.includes('yes') && labels.includes('no');
  // A terse Yes/No panel still resolves an action explicitly asked in the
  // main question; action words in background prose never supply this arm.
  const directAction = (verbs: string) => yesNo && new RegExp(
    `^(?:should|shall|can|do|would) (?:we|I) (?:${verbs})\\b[^?]*\\?$`, 'i').test(title);

  const found: DevexSeededGap[] = [];
  if (/\bCI\b/i.test(title) && /\b(?:local|demo|first)\b/i.test(title) &&
      /\b(?:gate|check|blocks?|waits?|bypass|mandatory|required)\b/i.test(title) &&
      (options.some(o => /\b(?:no CI gate|remove|move|skip|bypass|gate)\b/i.test(o) && /\b(?:CI|check|gate|local|demo)\b/i.test(o)) || directAction('remove|move|skip|bypass|gate'))) found.push('local-ci-gate');
  if (/\bquickstart\b|examples\/first_eval\.py/i.test(title) &&
      /\b(?:README|file|example|demo|missing|absent|package|wheel|ship|point)\b|first_eval\.py/i.test(title) &&
      (!declaration || absentReference || /\b(?:not (?:shipped|included|available|present)|missing|absent|nonexistent|does not exist)\b/i.test(title)) &&
      (options.some(o => /\b(?:point|ship|add|demo is)\b/i.test(o) && /\bquickstart\b|first_eval\.py/i.test(o)) || directAction('point|ship|add|replace|fix'))) found.push('missing-quickstart');
  if (explainedReversedSignatures({ ...q, options: signatureOptions }, title) || (/\brun_eval\b/i.test(title) && /\brun_batch\b/i.test(title) &&
      /\b(?:arguments?|order|positional|reversed|opposite|consistent|align|unify|dataset|evaluator)\b/i.test(title) &&
      (!declaration || reversedTuples || /\b(?:reversed|opposite|swapped|inconsistent)\b/i.test(title)) &&
      (options.some(o => (!reversedTuples || /\bboth functions\b|\brun_eval\b[^\n]*\brun_batch\b/i.test(o)) &&
        /\b(?:align|unify|standardize|keyword|swap)\b/i.test(o) && /\b(?:order|dataset|arguments?|positional)\b/i.test(o)) || directAction('align|unify|standardize|enforce|make')))) found.push('reversed-arguments');
  if ((opaqueAuthentication || /\bAuthError\b|\binvalid API key\b/i.test(title)) &&
      /\b(?:error|message|code|cause|fix|guidance|opaque|explain)\b|request failed/i.test(title) &&
      (!declaration || opaqueAuthentication || /\b(?:no (?:cause|fix|explanation|code)|opaque)\b|request failed/i.test(title)) &&
      (options.some(o => (!opaqueAuthentication || /\bAuthError\b/i.test(o)) && (/\bcodes?\b/i.test(o) || /^(?:[A-D]\)\s*)?Coded\b/i.test(o)) && /\b(?:cause|fix|link)\b/i.test(o)) || directAction('add|include|explain|replace|report|give'))) found.push('opaque-auth-error');
  if (/Client\.evaluate\b/i.test(title) &&
      /Client\.run\b|\b(?:v\d+|version \d+|alias|deprecation|migration)\b/i.test(title) &&
      (upgradeVocabulary || upgradeTransition) &&
      (!declaration || /\b(?:no |without (?:a )?)(?:compatibility )?(?:alias|warning|migration (?:guide|path))\b/i.test(title)) &&
      (options.some(o => ownUpgradeAlias(o) && /\balias\b/i.test(o) && /\b(?:warning|DeprecationWarning|migration)\b/i.test(o)) || directAction('keep|add|preserve|provide|retain'))) found.push('breaking-upgrade');
  return found;
}

/** Extra real decisions are permitted; each seeded gap needs its own completed native call. */
export function devexSeedCoverage(transcript: PlanCountTranscript) {
  const decisions = Object.fromEntries(DEVEX_SEEDED_GAPS.map(gap => [gap, []])) as Record<DevexSeededGap, string[]>;
  const batched: string[] = [];
  const invalid: string[] = [];
  const sessions = new Set(transcript.calls.map(c => c.sessionId));
  if (transcript.status !== 'ready' || sessions.size !== 1 || sessions.has('')) invalid.push('missing or mixed native session');
  const ids = new Set<string>();
  for (const call of transcript.calls) {
    const id = `${call.sessionId}:${call.toolUseId}`;
    if (!call.toolUseId || ids.has(id)) { invalid.push(`missing or repeated native call: ${id}`); continue; }
    ids.add(id);
    const gaps = call.questions.flatMap(decisionGaps);
    if (!gaps.length) continue;
    if (call.questions.length !== 1 || gaps.length !== 1 || call.questions[0]!.multiSelect) {
      batched.push(id); continue;
    }
    const q = call.questions[0]!;
    const labels = q.options.map(o => o.label);
    const complete = call.answered === true && call.failed === false &&
      Array.isArray(call.unansweredQuestionIndices) && call.unansweredQuestionIndices.length === 0 &&
      Number.isFinite(Date.parse(call.answeredAt ?? '')) && q.options.length >= 2 && q.options.length <= 4 &&
      new Set(labels).size === labels.length && labels.every(Boolean) &&
      Object.keys(call.answers ?? {}).length === 1 && labels.includes(call.answers?.[q.question] ?? '');
    if (complete) decisions[gaps[0]!]!.push(id);
  }
  const missing = DEVEX_SEEDED_GAPS.filter(gap => decisions[gap].length === 0);
  const matchedIds = new Set(Object.values(decisions).flat());
  return {
    complete: invalid.length === 0 && batched.length === 0 && missing.length === 0 && matchedIds.size >= DEVEX_SEEDED_GAPS.length,
    missing, decisions, batched, invalid,
  };
}
