import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** A native choice may carry the CEO-specific recap beside a generic completion question. */
function closedCeoRecap(description: string): boolean {
  const clause = /(?:^|[.!?]\s+)((?:The\s+)?CEO\s+review\b[^.!?]{0,240})(?=[.!?]|$)/i.exec(description)?.[1];
  if (!clause || /\b(?:if|unless|until|once|when|after|not|never)\b|n['’]t\b/i.test(clause)) return false;
  return /\b(?:all(?:\s+(?:gaps?|issues?|findings?))?(?:\s+(?:are|were))?\s+resolved|(?:no|0)\s+unresolved\s+(?:decisions|gaps|issues|findings))(?=\s*\)?\s*(?:;|$))/i.test(clause);
}

/** Past-tense resolution can close a native next-review recap without the word "complete". */
function resolvedCeoRecap(description: string): boolean {
  const clause = /(?:^|[.!?]\s+)((?:(?:This|The)\s+)?CEO\s+review\s+resolved\s+[^.!?;]{1,180}\b(?:bugs|gaps|issues|findings))(?=\s*(?:[.!?;]|$))/i.exec(description)?.[1];
  return Boolean(clause && !/\b(?:if|unless|until|once|when|after|not|never|some|most|partially|only|of|but|several|few)\b|n['’]t\b/i.test(clause));
}

/** A closed-review declaration plus one direct navigation query, even when its recap follows it. */
function closedReviewNavigation(declaration: string, context: string): boolean {
  const question = declaration.replace(/<gstack-qid:[^>]+>/gi, '');
  return /^CEO review (?:is )?(?:complete|done|cleared|clean)[.!](?:\s|$)/i.test(question) &&
    /(?:^|[.!]\s+)What(?:['’]s)? next\?(?:\s|$)/i.test(question) && closedNavigationContext(context);
}

/** The metadata recap is native question text, not a new substantive choice. */
function isMetadataNavigationQuestion(declaration: string): boolean {
  return /^What(?:['’]s|\s+is)\s+(?:the\s+)?next(?:\s+(?:step|review))?\s+after\s+(?:this|the)\s+CEO\s+review\?\s*$/i.test(declaration.trim().split('\n')[0]!);
}

function metadataClosedReviewNavigation(declaration: string, context: string): boolean {
  const question = declaration.replace(/<gstack-qid:[^>]+>/gi, '').trim();
  return isMetadataNavigationQuestion(question) &&
    /^[ \t]{0,3}ELI10:\s*(?:The\s+)?CEO\s+review\s+(?:is\s+)?(?:complete|cleared|clean|done(?:\s+and\s+clear(?:ed)?)?)[.!](?:\s|$)/im.test(question) &&
    !/`{3}|~{3}|(?:^|[.!?]\s+)[ \t]*>|\b(?:example|quoted source)\s*:/im.test(context) &&
    !/\b(?:incomplete|unfinished)\b|\b(?:review|decisions|findings|issues|gaps)\b[^.!?\n]{0,60}\b(?:not|never)\b|\b(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\b/i.test(context) &&
    !/(?:^|[.!?;:]\s+|\b(?:proceed to|continue to|should|must|will|need to|can|could|would|may|might)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|repair|implement|resolve|decide)\b/im.test(context) &&
    closedNavigationContext(context);
}

/** Scope/risk explanations can contain "if" and "not" without reopening CEO work. */
function explainedMetadataNavigation(declaration: string, descriptions: string[]): boolean {
  const question = declaration.replace(/<gstack-qid:[^>]+>/gi, '').trim();
  if (!isMetadataNavigationQuestion(question)) return false;
  const sentences = [question.split('\n').slice(1).join('\n'), ...descriptions]
    .flatMap(text => text.trim().split(/[.!](?:\s+|$)/).map(sentence => sentence.trim()).filter(Boolean));
  const resolved = /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) assertion spec gaps were caught and resolved$/i;
  const noDesignScope = /^No UI scope was detected, so a design review is not needed$/i;
  const stakes = /^Stakes if we pick wrong: skipping the eng review means shipping without an architecture \+ code quality pass$/i;
  // Validate every whole sentence before discounting the two inert phrases.
  // Additional repair, conditional closure, or a different review denial is
  // substantive even when it follows a valid metadata heading or recap.
  if (sentences.filter(sentence => resolved.test(sentence)).length !== 1 ||
      !sentences.every(sentence => resolved.test(sentence) || noDesignScope.test(sentence) || stakes.test(sentence) ||
        /^ELI10: The CEO review is (?:done|complete|cleared|clean)$/i.test(sentence) ||
        /^The plan is now ready for the Eng Review, which is the required gate before shipping$/i.test(sentence) ||
        /^For test code this is lower risk than production code, but the eng review also validates that the test infrastructure is used correctly$/i.test(sentence) ||
        /^Recommendation: [A-Z] because eng review is the required shipping gate, and this plan is ready for it$/i.test(sentence) ||
        /^Required gate$/i.test(sentence) ||
        /^Validates architecture, test infrastructure usage, code quality, and that the \d+-test plan will be implementable without hidden issues$/i.test(sentence) ||
        /^Proceed to implementation without the eng review$/i.test(sentence) ||
        /^Lower confidence that the test infrastructure is wired correctly, but acceptable for low-risk test coverage work$/i.test(sentence))) return false;
  const normalized = [question.split('\n')[0]!, ...sentences
    .filter(sentence => !noDesignScope.test(sentence))
    .map(sentence => stakes.test(sentence) ? sentence.replace(/^Stakes if we pick wrong:/i, 'Stakes:') : sentence)]
    .join('\n');
  return metadataClosedReviewNavigation(question, normalized);
}

/** A direct Eng/manual choice can put its unconditional CEO recap in a native description. */
function describedEngNavigation(question: string, descriptions: string[], context: string): boolean {
  if (!/^Run\s+\/plan-eng-review\s+(?:next|now)\s*\((?:the\s+)?required(?:\s+shipping)?\s+gate\),?\s+or\s+handle\s+reviews\s+manually\?$/i.test(question)) return false;
  const recap = /^(?:The\s+)?CEO\s+review\s+is\s+(?:clear|complete|cleared|clean|done)(?:\s+but\s+eng\s+review\s+is\s+the\s+(?:required\s+)?shipping\s+gate)?$/i;
  const topics = String.raw`(?:test isolation|factory patterns|test coverage|architecture|dependencies)`;
  const reviewExplanation = new RegExp(String.raw`^(?:Validates|Checks|Reviews)\s+${topics}(?:,\s+${topics})*(?:,?\s+and\s+(?:${topics}|confirms no hidden dependencies))?$`, 'i');
  const sentences = descriptions.flatMap(description => description.trim().split(/[.!](?:\s+|$)/).map(sentence => sentence.trim()).filter(Boolean));
  const closedRecap = sentences.some(sentence => recap.test(sentence));
  // Every sentence must explain this closed handoff. Arbitrary prose after
  // a valid recap could add work (including verbs no blacklist anticipates).
  if (!sentences.every(sentence => recap.test(sentence) || reviewExplanation.test(sentence) ||
      /^Required(?:\s+shipping)?\s+gate\s+before\s+(?:shipping|merging|implementation)$/i.test(sentence) ||
      /^(?:You['’]ll|You will)\s+need\s+to\s+run\s+\/plan-eng-review\s+(?:separately\s+)?before\s+(?:merging|shipping)$/i.test(sentence) ||
      /^Run\s+\/plan-eng-review\s+(?:next|now|before\s+(?:merging|shipping)|after\s+implementation\s+and\s+before\s+shipping)$/i.test(sentence) ||
      /^(?:Fast|Quick|Short)\s+(?:run|review)\s+expected\s+given\s+(?:zero|no|0)\s+CEO\s+findings$/i.test(sentence))) return false;
  if (!closedRecap || /`{3}|~{3}|(?:^|\n)[ \t]*>|\b(?:example|quoted source)\s*:/im.test(context) ||
      /\b(?:incomplete|unfinished|not|never)\b|n['’]t\b/i.test(context)) return false;
  // "Clear" is also a closure claim here; a future condition cannot supply it.
  const clearClosure = String.raw`(?:(?:the\s+)?CEO|the)\s+review\s+(?:(?:is|was|becomes?|became|(?:will|would|can|could|may|might)\s+(?:be|become))\s+)?clear`;
  if (new RegExp(String.raw`\b(?:once|when|after)\b[^.!?]{0,180}\b${clearClosure}\b|\b${clearClosure}\b[^.!?]{0,100}\b(?:once|when|after)\b`, 'i').test(context)) return false;
  return !/(?:^|[.!?;:]\s+|\b(?:proceed to|continue to|should|must|will|need to|can|could|would|may|might)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|repair|implement|resolve|decide)\b/im.test(context) &&
    closedNavigationContext(context);
}

/** The next sentence may name the required gate with "it" after the Eng query. */
function pronounEngGate(question: string, descriptions: string[], context: string): boolean {
  if (!/^(?:The\s+)?CEO\s+review\s+is\s+(?:complete|cleared|clean|done)[.!]\s+Run\s+\/plan-eng-review\s+next\?\s+It(?:['’]s|\s+is)\s+the\s+required(?:\s+shipping)?\s+gate\.$/i.test(question)) return false;
  const topics = String.raw`(?:architecture|security|test quality|performance)`;
  const covers = new RegExp(String.raw`^Covers\s+${topics}(?:,\s+${topics})*(?:,?\s+and\s+${topics})?$`, 'i');
  const sentences = descriptions.flatMap(description => description.trim().split(/[.!](?:\s+|$)/)
    .map(sentence => sentence.trim()).filter(Boolean));
  return sentences.every(sentence => covers.test(sentence) ||
    /^Required\s+gate\s+before\s+shipping$/i.test(sentence) ||
    /^This\s+CEO\s+review\s+found\s+no\s+architecture\s+concerns,\s+so\s+eng\s+review\s+should\s+be\s+fast$/i.test(sentence) ||
    /^Proceed\s+without\s+the\s+eng\s+review\s+gate$/i.test(sentence) ||
    /^You\s+own\s+ensuring\s+correctness\s+before\s+shipping$/i.test(sentence)) &&
    closedNavigationContext(context);
}

/** A next-review question may explain completed CEO work only in its choices. */
function describedPostReviewNavigation(question: string, descriptions: string[], context: string): boolean {
  if (!/^What(?:['’]s|\s+is)\s+the\s+next\s+review\s+step\s+after\s+(?:this|the)\s+CEO\s+review\?$/i.test(question) ||
      /`{3}|~{3}|(?:^|\n)[ \t]*>|\b(?:example|quoted source)\s*:/im.test(context)) return false;
  const closed = /^(?:The|This) CEO review resolved all findings, but the eng review validates the approach at a lower implementation level$/i;
  const topics = String.raw`(?:[\w-]+ integration|parameterized queries|async [\w-]+ queue)`;
  const changedApproach = new RegExp(String.raw`^This CEO review changed the implementation approach \(Approach [A-Z]: ${topics}(?:, ${topics})*\) [—–-] a fresh eng review should validate the new approach before implementation begins$`, 'i');
  const sentences = descriptions.flatMap(description => description.trim().split(/[.!](?:\s+|$)/)
    .map(sentence => sentence.trim()).filter(Boolean));
  // Whole sentences keep extra work out of the recap, including actions that
  // an imperative-verb blacklist would miss. Only the next review is offered.
  return sentences.filter(sentence => closed.test(sentence)).length === 1 &&
    sentences.every(sentence => closed.test(sentence) || changedApproach.test(sentence) ||
      /^Eng review is the required shipping gate$/i.test(sentence) ||
      /^It covers architecture details, code quality, and test verification$/i.test(sentence) ||
      /^Proceed to implementation without the eng review gate$/i.test(sentence) ||
      /^Skipping is not recommended for a handler that processes payment webhooks$/i.test(sentence)) &&
    closedNavigationContext(context);
}

/** A resolved-gap count may qualify completion before the required next gate. */
function countedCeoNavigation(question: string, descriptions: string[]): boolean {
  if (!/^(?:The )?CEO review is complete \(0 critical gaps, [1-9]\d* (?:spec )?gaps resolved\)\. Eng Review is the required shipping gate\. What['’]s next\?$/i.test(question)) return false;
  const topics = String.raw`(?:architecture|code quality|tests|performance)`;
  const covers = new RegExp(String.raw`^Covers ${topics}(?:, ${topics})*(?:,? and ${topics})?$`, 'i');
  return descriptions.flatMap(description => description.trim().split(/[.!](?:\s+|$)/)
    .map(sentence => sentence.trim()).filter(Boolean)).every(sentence => covers.test(sentence) ||
      /^Required gate before shipping$/i.test(sentence) ||
      /^This is a test-only plan so eng review should be fast$/i.test(sentence) ||
      /^You manage the eng review yourself$/i.test(sentence) ||
      /^The dashboard will show NOT CLEARED until it runs$/i.test(sentence));
}

/** An unconditional CLEAR recap followed by one direct required-Eng query. */
function clearRequiredEngNavigation(question: string, descriptions: string[], context: string): boolean {
  if (!/^(?:The\s+)?CEO\s+review\s+is\s+CLEAR\.\s+Eng\s+review\s+is\s+the\s+required\s+shipping\s+gate\s+[—–-]\s+run\s+it\s+next\?$/i.test(question) ||
      descriptions.some(description => !description.trim())) return false;
  const topics = String.raw`(?:architecture|code quality|tests|performance)`;
  const topicsReview = new RegExp(String.raw`^${topics}(?:,\s+${topics})*(?:,?\s+and\s+${topics})?\s+review$`, 'i');
  const resolved = /^This\s+CEO\s+review\s+held\s+scope\s+and\s+resolved\s+[1-9]\d*\s+assertion\s+gaps\s+[—–-]\s+eng\s+review\s+verifies\s+the\s+test\s+structure\s+is\s+sound$/i;
  const sentences = descriptions.flatMap(description => description.trim().split(/[.!](?:\s+|$)/)
    .map(sentence => sentence.trim()).filter(Boolean));
  // CLEAR is accepted only with this complete navigation grammar. Do not add
  // it to the permissive legacy completion regex or discard appended prose.
  return sentences.filter(sentence => resolved.test(sentence)).length === 1 &&
    sentences.every(sentence => resolved.test(sentence) || topicsReview.test(sentence) ||
      /^Required\s+gate\s+before\s+shipping$/i.test(sentence) ||
      /^You\s+manage\s+the\s+review\s+pipeline\s+yourself$/i.test(sentence) ||
      /^Note:\s+eng\s+review\s+is\s+required\s+to\s+CLEAR\s+for\s+\/ship$/i.test(sentence)) &&
    closedNavigationContext(context);
}

/** A bare next-workflow choice is administration, never proof of completed review. */
function bareEngNavigation(question: string, descriptions: string[]): boolean {
  if (!/^run \/plan-eng-review\?$/i.test(question) || descriptions.some(s => !s.trim())) return false;
  const sentences = descriptions.flatMap(s => s.trim().split(/\n+|[.!](?:\s+|$)/))
    .map(s => s.trim().replace(/^\[[+-]\]\s*/, '')).filter(Boolean);
  const approved = /^Proceed directly to implementation with the approved changes from this CEO review$/i;
  const gate = /^Eng Review is the required shipping gate$/i;
  // Consume the complete offered context. Past findings and already-approved
  // changes are recaps; an added remedy or unfinished-review choice is not.
  return sentences.some(s => approved.test(s)) && sentences.some(s => gate.test(s)) &&
    sentences.every(s => approved.test(s) || gate.test(s) ||
      /^It covers architecture depth, code quality, test gaps, and performance [—–-] complementing what this CEO review found$/i.test(s) ||
      /^Since this CEO review expanded the plan \(added [a-z0-9_ +/-]{1,120} requirements\), a fresh eng review is especially valuable$/i.test(s) ||
      /^Required before shipping; catches implementation issues the plan-level review cannot$/i.test(s) ||
      /^This CEO review found critical issues \([a-z0-9_ +/-]{1,80}\) [—–-] eng review will verify the fix approach is architecturally sound$/i.test(s) ||
      /^Adds another review session before implementation starts$/i.test(s) ||
      /^Faster path to implementation$/i.test(s) ||
      /^Eng review is the required shipping gate [—–-] skipping it means less confidence before enabling the feature flag$/i.test(s));
}

/** A completed CEO review may distinguish the still-unrun Eng shipping gate. */
function unrunEngNavigation(fp: AskUserQuestionFingerprint, question: string): number | null {
  const call = fp.nativeCall!;
  const q = call.questions[0]!;
  if (!call.sessionId || !call.toolUseId || call.failed !== false ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !/^Next review$/i.test(q.header.trim()) ||
      !/^CEO Review is CLEAR\. Eng Review is the required shipping gate and (?:hasn['’]t|has not) run yet\. What(?:['’]s| is) next\?$/i.test(question)) return null;
  if (call.answered === false) {
    if (call.answers !== undefined || call.answeredAt !== undefined ||
        (call.unansweredQuestionIndices !== undefined &&
          (call.unansweredQuestionIndices.length !== 1 || call.unansweredQuestionIndices[0] !== 0))) return null;
  } else if (call.answered !== true || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '').trim());
  const run = labels.findIndex(s => /^Run \/plan-eng-review(?: next| now)?$/i.test(s));
  const manual = labels.findIndex(s => /^Skip\s*[—–-]\s*I['’]ll handle reviews manually$/i.test(s));
  if (run < 0 || manual < 0 || run === manual) return null;
  const topics = String.raw`(?:architecture|code quality|test design|performance|deployment)`;
  const runDescription = new RegExp(String.raw`^${topics}(?:,\s+${topics})*(?:,?\s+and\s+${topics})?\s+review\.\s+The required gate before shipping\.\s+Run this before implementation begins to catch any structural issues in how the tests are wired up\.$`, 'i');
  // Consume each complete description in its own offered role. The temporal
  // qualification is about the next review, not an unfinished CEO decision.
  if (!runDescription.test(q.options[run]!.description?.trim() ?? '') ||
      !/^Proceed to implementation directly\.\s+You can run \/plan-eng-review later if needed\.\s+Eng Review is required before shipping but not before starting implementation\.$/i.test(q.options[manual]!.description?.trim() ?? '')) return null;
  return manual + 1;
}

/** A completed review can explain the cost of skipping its next required gate. */
function explainedRequiredEngNavigation(fp: AskUserQuestionFingerprint, question: string): number | null {
  const call = fp.nativeCall!, q = call.questions[0]!;
  if (!call.sessionId || !call.toolUseId || call.failed !== false ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      q.header.trim() !== 'Next step' || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return null;
  if (call.answered === false) {
    if (call.answers !== undefined || call.answeredAt !== undefined ||
        (call.unansweredQuestionIndices !== undefined &&
          (call.unansweredQuestionIndices.length !== 1 || call.unansweredQuestionIndices[0] !== 0))) return null;
  } else if (call.answered !== true || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || Object.keys(call.answers ?? {}).length !== 1) return null;
  const compact = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const match = /^What(?:['’]s| is) next after this CEO review\? ELI10: The CEO review is done and the plan is CLEARED\. But Eng Review is the required shipping gate [—–-] it covers architecture, test plan rigor, and implementation correctness in more depth\. Running it next locks in the plan before implementation starts\. Stakes if we pick wrong: Skipping eng review means the plan goes to implementation without a required gate check [—–-] leaving architecture and test-correctness gaps unverified\. Recommendation: ([A-Z]) because the dashboard shows Eng Review at 0 runs [—–-] required gate, not yet cleared\. Note: options differ in kind, not coverage [—–-] no completeness score\.$/.exec(compact(question));
  if (!match) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/, '').replace(/\s*\(Recommended\)$/, ''));
  const run = labels.indexOf('Run /plan-eng-review next'), manual = labels.indexOf('Skip — handle reviews manually');
  if (run < 0 || manual < 0 || run === manual || !q.options[run]!.label.startsWith(`${match[1]}) `)) return null;
  // All question prose and each role-specific description must be closed
  // navigation. The risk explanation is not a new CEO repair decision.
  if (!/^Required shipping gate\. Covers implementation correctness, test plan rigor, and any architecture concerns\. Takes ~[1-9]\d* minutes\.$/.test(compact(q.options[run]!.description)) ||
      compact(q.options[manual]!.description) !== 'Proceed to implementation without the eng review gate. CEO review findings still apply.') return null;
  return manual + 1;
}

/** Shared closed-review guards; next-review sequencing is still navigation. */
function closedNavigationContext(context: string): boolean {
  const unfinished = context.replace(/\b(?:no|0)\s+unresolved\s+(?:decisions|gaps|issues|findings)\b/gi, '');
  // Conditional closure of this review is unfinished work. Sequencing the
  // next review after implementation does not reopen the completed CEO review.
  const stateVerb = String.raw`(?:is|are|was|were|becomes?|became|(?:will|would|can|could|may|might)\s+(?:be|become))`;
  const closure = String.raw`(?:(?:all\s+)?(?:decisions|gaps|issues|findings)\s+(?:${stateVerb}\s+)?resolved|(?:the\s+)?CEO\s+review\s+(?:${stateVerb}\s+)?(?:complete|done|cleared|clean)|the\s+review\s+(?:${stateVerb}\s+)?(?:complete|done|cleared|clean))`;
  const conditionalClosure = new RegExp(String.raw`\b(?:once|when|after)\b[^.!?]{0,180}\b${closure}\b|\b${closure}\b[^.!?]{0,100}\b(?:once|when|after)\b`, 'i');
  return (context.match(/\?/g)?.length ?? 0) === 1 &&
    !/\b(?:unresolved|outstanding|remaining|pending|if|unless|until)\b|\b(?:gap|issue|finding|decision)s?\s+(?:still\s+)?remains?\b|\bstill\s+open\b/i.test(unfinished) &&
    !/\bnot\s+(?:all|no|0)\b/i.test(context) &&
    !conditionalClosure.test(context) &&
    !/(?:^|[.!?;]\s+|\b(?:proceed to|continue to|should|must|will|need to|can|could|would)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|implement|resolve|decide)\b/im.test(context);
}

/** A pure next-review menu remains navigation when question tuning is off. */
function sequencedReviewNavigation(fp: AskUserQuestionFingerprint): number | null {
  const call = fp.nativeCall!, q = call.questions[0]!;
  if (call.failed !== false || !call.sessionId || !call.toolUseId || q.header.trim() !== 'Next review' ||
      q.options.length !== 2 || fp.options.length !== 2 || q.multiSelect ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0)) return null;
  if (call.answered === false) {
    if (call.answers !== undefined || call.answeredAt !== undefined ||
        (call.unansweredQuestionIndices !== undefined &&
          (call.unansweredQuestionIndices.length !== 1 || call.unansweredQuestionIndices[0] !== 0))) return null;
  } else if (call.answered !== true || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || Object.keys(call.answers ?? {}).length !== 1) return null;
  const lines = q.question.trim().split('\n').map(line => line.trim()).filter(Boolean);
  if (!/^D[1-9]\d* [—–-] Which review runs next\?$/.test(lines[0] ?? '')) return null;
  // Consume the entire brief, including the displayed option explanations.
  // Only the next gate is open; adding a new remedy anywhere rejects this arm.
  const grammar = [
    /^Project\/branch\/task: [\w.-]+ on [\w./-]+; CEO review of [\w./-]+ is complete and clean \(HOLD SCOPE, 0 critical gaps, [1-9]\d* P1 tasks\)\.$/,
    /^ELI10: gstack chains reviews\. The CEO review just settled scope and strategy\. The engineering review is the required gate before shipping: it checks architecture, test design, and code quality in detail\. skip_eng_review is false, so it is still required\. No UI scope was detected, so the design review does not apply here\.$/,
    /^Stakes if we pick wrong: skipping eng review leaves the ship gate NOT CLEARED; the plan is small, so the eng review should be quick\.$/,
    /^Recommendation: A because eng review is the required gate and the plan now has exact assertions worth a second structured pass on test design\.$/,
    /^Note: options differ in kind, not coverage [—–-] no completeness score\.$/,
    /^A\) Run \/plan-eng-review next \(recommended\)$/,
    /^✅ Clears the required shipping gate on a plan that is small and already decided$/,
    /^✅ Gives the three tasks a test-design pass focused on the assertion mechanics \(mock implementation, sleeper record shape\)$/,
    /^❌ One more review session before implementation starts \(human ~[1-9]\d* min \/ CC ~[1-9]\d* min\)$/,
    /^B\) Skip, handle reviews manually$/,
    /^✅ Move straight to implementing T[1-9]\d* to T[1-9]\d* in the real repo$/,
    /^✅ No further review time on a three-task change$/,
    /^❌ Dashboard verdict stays NOT CLEARED until an eng review is logged$/,
    /^Net: gate discipline versus getting to the code faster on a change that is already tightly specified\.$/,
  ];
  if (lines.length !== grammar.length + 1 || !grammar.every((re, i) => re.test(lines[i + 1]!))) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z]:\s*/, '').replace(/\s*\(recommended\)$/, ''));
  const run = labels.indexOf('Run /plan-eng-review next'), manual = labels.indexOf('Skip, manual reviews');
  if (run < 0 || manual < 0 || run === manual ||
      q.options[run]!.description !== 'Required gate; runs after this plan is approved.' ||
      q.options[manual]!.description !== 'Proceed to implementation; eng gate remains open.') return null;
  return manual + 1;
}

/** Closed CEO next-review navigation; native terminal/report checks prove completion separately. */
function manualHandoffIndex(fp: AskUserQuestionFingerprint): number | null {
  const call = fp.nativeCall;
  // The capture path assigns this native identity only after matching the
  // active question. UI-only and mismatched pending records cannot steer it.
  if (!call || call.failed || fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)];
  if (ids.length > 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== ids.length) return null;
  const id = ids[0]?.[1]?.toLowerCase();
  if (!id) {
    const sequenced = sequencedReviewNavigation(fp);
    if (sequenced !== null) return sequenced;
  }
  if (id && !/^(?:plan-ceo-(?:review-)?next-(?:steps?|review)|ceo-review-next-(?:steps?|review)|ceo-next-step-eng-review|ceo-plan-next-steps)$/.test(id)) return null;
  const declaration = q.question.replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/^next\s+(?:review|steps?)\s*:\s*/i, '');
  const gateContext = [q.question, ...q.options.map(option => option.description ?? '')].join('\n');
  const explicitCompletion = /(?:^|[.!?]\s+)(?:ELI10:\s*)?(?:The\s+)?CEO\s+review\s+(?:is\s+)?(?:complete|cleared|clean|done(?:\s+and\s+the\s+plan\s+is\s+cleared)?)(?:\s+with\s+0\s+unresolved\s+decisions)?(?=\s*(?:[.!?—–]|$))/i.test(declaration);
  const genericCompletion = /(?:^|[.!?]\s+)(?:The\s+)?review\s+(?:is\s+)?(?:complete|cleared|clean|done)(?=\s*(?:[.!?—–]|$))/i.test(declaration);
  const questionText = declaration.replace(/<gstack-qid:[^>]+>/gi, '').trim();
  const unrunNavigation = id ? unrunEngNavigation(fp, questionText) : null;
  if (unrunNavigation !== null) return unrunNavigation;
  const explainedNavigation = id ? explainedRequiredEngNavigation(fp, questionText) : null;
  if (explainedNavigation !== null) return explainedNavigation;
  const recappedNavigation = Boolean(id) &&
    /^What(?:['’]s|\s+is)\s+the\s+next\s+(?:steps?|review)\s+after\s+(?:this|the)\s+CEO\s+review\?$/i.test(questionText) &&
    q.options.some(option => resolvedCeoRecap(option.description ?? ''));
  const unfinished = gateContext.replace(/\b(?:no|0)\s+unresolved\s+(?:decisions|gaps|issues|findings)\b/gi, '');
  const describedCompletion = (recappedNavigation || (genericCompletion && q.options.some(option => closedCeoRecap(option.description ?? '')))) &&
    !/\b(?:unresolved|outstanding|remains?|remaining|pending)\b/i.test(unfinished) &&
    !/(?:^|[.!?;]\s+|\b(?:please|must|need\s+to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|implement|resolve|decide)\b/im.test(gateContext);
  const metadataCompletion = Boolean(id) && (metadataClosedReviewNavigation(declaration, gateContext) ||
    (call.failed === false && q.options.length === 2 &&
      explainedMetadataNavigation(declaration, q.options.map(option => option.description ?? ''))));
  if (isMetadataNavigationQuestion(questionText) && /\n[ \t]*ELI10:/i.test(questionText) && !metadataCompletion) return null;
  const describedEngCompletion = q.options.length === 2 &&
    describedEngNavigation(questionText, q.options.map(option => option.description ?? ''), gateContext);
  const describedPostReviewCompletion = !id && q.options.length === 2 &&
    describedPostReviewNavigation(questionText, q.options.map(option => option.description ?? ''), gateContext);
  const countedCompletion = !id && call.failed === false && q.options.length === 2 &&
    countedCeoNavigation(questionText, q.options.map(option => option.description ?? ''));
  const clearCompletion = !id && call.failed === false && q.options.length === 2 &&
    clearRequiredEngNavigation(questionText, q.options.map(option => option.description ?? ''), gateContext);
  const completion = explicitCompletion || describedCompletion || metadataCompletion || describedEngCompletion || describedPostReviewCompletion || countedCompletion || clearCompletion;
  const bareNavigation = Boolean(id) && call.failed === false && q.options.length === 2 &&
    (fp.nativeQuestionIndex === undefined || fp.nativeQuestionIndex === 0) &&
    fp.options.length === 2 && fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) &&
    bareEngNavigation(questionText, q.options.map(o => o.description ?? ''));
  const requiredEng = /(?:\bEng(?:ineering)?\s+review|\/plan-eng-review)\b[^.!?]{0,180}\brequired(?:\s+shipping)?\s+gate\b/i.test(gateContext) ||
    /\brequired(?:\s+shipping)?\s+gate\s+is\s+(?:an?\s+)?(?:Eng(?:ineering)?\s+review|\/plan-eng-review)\b/i.test(gateContext) ||
    pronounEngGate(questionText, q.options.map(option => option.description ?? ''), gateContext);
  // These native next-review identities share a closed navigation contract;
  // the question or a following recap cannot hide a new repair obligation.
  if (id && /^(?:ceo-plan-next-steps|ceo-review-next-(?:steps?|review))$/.test(id) &&
      !closedReviewNavigation(declaration, gateContext)) return null;
  // A qid alone cannot authorize another fix. The bare navigation arm grants
  // no completion credit; native Exit, report freshness and finding floor remain independent.
  if (!/^next\s+(?:review|steps?)$/i.test(q.header.trim()) || !(completion || bareNavigation) || !requiredEng) return null;

  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '').trim());
  if (clearCompletion && !labels.some(label => /^Run\s+\/plan-eng-review(?:\s+(?:next|now))?$/i.test(label))) return null;
  const runs = labels.map(label => /^Run\s+\/plan-(?:eng|design)-review(?:\s+(?:next|now))?(?:\s*\(required gate\))?$/i.test(label));
  const manual = labels.map(label => /^(?:Skip|Done)\s*[—–-]\s*(?:I['’]ll\s+)?handle\s+(?:reviews\s+)?manually$/i.test(label));
  // Deferring the next review until after already-approved implementation is
  // navigation too. A new fix/TODO/task choice remains substantive. The picker
  // always selects manual, never this implementation route.
  const deferred = labels.map((label, i) => /^Implement\s+now,\s+eng\s+review\s+later$/i.test(label) &&
    /^Proceed to implementation with (?:the )?(?:\d+ )?(?:already )?approved (?:tasks|plan|changes)(?: \([A-Z0-9–-]+\))?\. Run \/plan-eng-review before (?:the PR is merged|shipping)\.(?: Acceptable if implementation is expected to be fast with CC\.)?$/i.test(q.options[i]!.description?.trim() ?? ''));
  if (!runs.some(Boolean) || manual.filter(Boolean).length !== 1 || !labels.every((_, i) => runs[i] || manual[i] || deferred[i])) return null;
  return manual.findIndex(Boolean) + 1;
}

/** Every offered explanation must remain a clause about this review handoff. */
function closedNextReviewExplanations(question: string, descriptions: string[]): boolean {
  // Validate each complete sentence/line, rather than discarding prose under
  // an accepted heading. A new imperative has no navigation subject and
  // cannot borrow the preceding sentence's administrative classification.
  const navigation = [
    /^(?:The )?CEO review (?:is (?:done|complete|cleared)(?: and clears scope and strategy)?|cleared scope and strengthened both test assertions)$/i,
    /^The engineering review is the one gate that must pass before shipping \(skip_eng_review is false\)$/i,
    /^It checks architecture, code quality, and test design in depth$/i,
    /^gstack['’]s shipping gate is the eng review, which checks architecture and test design$/i,
    /^it has not run for this plan yet$/i,
    /^(?:There is no UI|No UI scope was found), so a design review does not apply$/i,
    /^Skipping (?:the )?eng review leaves the (?:required gate unmet, so the readiness dashboard stays NOT CLEARED until someone runs it later|ship dashboard NOT CLEARED)$/i,
    /^running it costs a few minutes on a two-test plan$/i,
    /^[A-Z] because eng review is the required (?:shipping gate and this plan is now precise enough for it to run quickly|gate and the plan changed since it was written \(two assertions strengthened\), so the tests deserve a second read)$/i,
    /^options differ in kind(?: \(which workflow runs next\))?, not coverage [—–-] no completeness score$/i,
    /^clear the (?:required )?gate now versus (?:handling reviews on your own schedule|implement first and review later)$/i,
    /^Clears the required (?:engineering gate while the plan and its two approved remedies are fresh|shipping gate on the review readiness dashboard)$/i,
    /^A second structured pass over the test design catches anything the scope review did not$/i,
    /^One more interactive review session before implementation starts$/i,
    /^Ends the review chain here$/i,
    /^you decide when the eng review runs$/i,
    /^No further (?:questions this session|review prompts in this session)$/i,
    /^(?:The required eng gate stays unmet and the dashboard remains NOT CLEARED|Dashboard stays NOT CLEARED until an eng review runs)$/i,
    /^Second read of the exact assertions and the await-then-count ordering before code is written$/i,
    /^A few extra minutes on a plan that is already two tests against existing probes$/i,
    /^Move straight to implementing T[1-9]\d* and T[1-9]\d* now$/i,
    /^Start the eng review against the updated plan after this review exits$/i,
    /^End here$/i,
    /^run reviews yourself later$/i,
  ];
  const duration = String.raw`~?\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)`;
  const timing = new RegExp(String.raw`\s*\(human:\s*${duration}\s*/\s*CC:\s*${duration}\)$`, 'i');
  let metadata = 0;
  const body = question.split('\n').slice(1).concat(descriptions.flatMap(text => text.split('\n')));
  for (const raw of body) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Project\/branch\/task:/.test(line)) {
      // Only the project/mode recap is metadata, never a repair paragraph.
      if (++metadata !== 1 || !/^Project\/branch\/task: (?:[\w-]+ on [\w/-]+, \/plan-ceo-review \(HOLD SCOPE\) finished on the payment test-coverage plan|`[\w/-]+`, CEO review of PLAN\.md complete \(HOLD SCOPE, 0 critical gaps, [1-9]\d* assertion fixes approved\))\.$/.test(line)) return false;
      continue;
    }
    if (line === 'Pros / cons:') continue;
    if (/^[A-Z][):] /.test(line)) {
      const offered = line.replace(/^[A-Z][):] /, '').replace(timing, '').replace(/ \(recommended\)$/, '');
      if (!/^(?:Run \/plan-eng-review next|Skip, handle reviews manually)$/.test(offered)) return false;
      continue;
    }
    const prose = line.replace(/^(?:ELI10|Stakes if we pick wrong|Recommendation|Note|Net):\s*/, '')
      .replace(/^[✅❌]\s*/, '').replace(timing, '');
    const clauses = prose.split(/[.;]\s+|[.]$/).map(s => s.trim()).filter(Boolean);
    if (!clauses.length || !clauses.every(clause => navigation.some(pattern => pattern.test(clause)))) return false;
  }
  return metadata === 1;
}

/** Evidence-only next-review accounting; this never selects a pending option. */
function completedNextReviewBrief(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 1 || !Number.isFinite(Date.parse(call.answeredAt ?? ''))) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Next (?:step|review)$/i.test(q.header.trim()) || q.options.length !== 2 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question]) || /<gstack-qid/i.test(q.question)) return false;
  const question = q.question.trim().replace(/^D\d+\s*[—–-]\s*/i, '');
  const lines = question.split('\n').map(line => line.trim()).filter(Boolean);
  // Numbered headings and echoed pros/cons are presentation. Require the
  // actual navigation query, explicit current CEO closure, and a final brief
  // boundary; a new question or directive after that boundary stays work.
  if (!/^(?:CEO review (?:is )?(?:complete|done|cleared)\. )?Which review runs next\?$/i.test(lines[0]!) ||
      !/^Net:\s+[^\n]+[.!]$/.test(lines.at(-1) ?? '') ||
      !/(?:^|[.!?]\s+|^ELI10:\s*)(?:The\s+)?CEO\s+review\s+(?:is\s+)?(?:complete|done|cleared)\b/im.test(question)) return false;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).:]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, ''));
  if (labels.filter(label => /^Run \/plan-eng-review next$/i.test(label)).length !== 1 ||
      labels.filter(label => /^Skip\s*[,—–-]\s*(?:(?:I['’]ll\s+)?handle reviews manually|manual reviews)$/i.test(label)).length !== 1) return false;
  const context = [question, ...q.options.map(o => o.description ?? '')].join('\n')
    .replace(/^Stakes if we pick wrong:/m, 'Stakes:');
  // Only the next Eng gate can keep the readiness dashboard uncleared.
  // Its temporal explanation is not a condition on current CEO closure;
  // every other unfinished-work and conditional-closure guard still applies.
  const navigationContext = context.replace(
    /\b((?:(?:readiness|ship)\s+)?dashboard\s+(?:stays|remains)\s+NOT\s+CLEARED)\s+until\s+(?:someone\s+runs\s+it|(?:an?|the)\s+eng(?:ineering)?\s+review\s+runs)(?:\s+later)?(?=[.!]|\n|$)/gi,
    '$1',
  );
  return q.options.every(o => o.description?.trim()) &&
    closedNextReviewExplanations(question, q.options.map(o => o.description ?? '')) &&
    !/`{3}|~{3}|(?:^|\n)\s*>|\b(?:example|quoted source)\s*:/im.test(context) &&
    !/\bCEO\s+review\b[^.!?\n]{0,80}\b(?:not|never|incomplete|unfinished)\b/i.test(context) &&
    /\b(?:Eng|engineering) review\b[^.!?]{0,180}\bgate\b/i.test(context) && closedNavigationContext(navigationContext);
}

/** Classification happens only after one real, successful, fully answered native call. */
export function isCeoCompletionHandoff(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length) return false;
  if (completedNextReviewBrief(fp)) return true;
  if (manualHandoffIndex(fp) === null) return false;
  const q = call.questions[0]!;
  // A free-form answer can introduce a new substantive request. Do not
  // silently discard it merely because the menu itself was administrative.
  return q.options.some(option => option.label === call.answers?.[q.question]);
}

/** Finish this CEO fixture instead of starting another skill; reuse the existing caller-pick hook. */
export function pickCeoCompletionHandoff(
  fp: AskUserQuestionFingerprint,
  activeCapture: AskUserQuestionFingerprint = fp,
): number | null {
  return activeCapture.nativeCall?.answered ? null : manualHandoffIndex(activeCapture);
}
