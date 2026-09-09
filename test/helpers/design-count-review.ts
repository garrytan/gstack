import { designFirstReviewAUQ } from './claude-pty-runner';
import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { pickDesignCountOutsideVoices } from './design-count-outside';

/** Choosing reviewer participation is setup, even when numbered or asked late. */
export function isDesignCountSetup(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || call.questions.length !== 1 ||
      call.unansweredQuestionIndices?.length || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^outside(?: design)? voices$/i.test(q.header.trim()) ||
      (q.question.match(/<gstack-qid:/g)?.length ?? 0) !== 1 ||
      !/<gstack-qid:(?:plan-design-review-outside-voices|outside-voices-design)>\s*$/.test(q.question) ||
      (q.question.match(/\?/g)?.length ?? 0) !== 1 ||
      !/^(?:D\s*\d+(?:\s*\(Step\s*0[A-Z]?\))?\s*[—–:-]\s*)?(?:Run|Want|Include|Enable)\s+outside(?: design)? voices\s+(?:before|for)\s+the\s+(?:detailed\s+)?(?:design\s+)?review(?:\s+passes)?\?/i.test(q.question.trim())) return false;
  const labels = q.options.map(option => option.label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  // Consume the entire menu, not just its opening question or action labels.
  // Unknown explanatory prose can contain a second product decision.
  const remainder = q.question.slice(q.question.indexOf('?') + 1).replace(/<gstack-qid:[^>]+>\s*$/, '').trim();
  if (remainder && !/^(?:Codex evaluates the design; a Claude subagent reviews completeness\.|Codex evaluates against OpenAI's design hard rules \+ litmus checks; a Claude subagent does an independent completeness review\. \(Requires Codex CLI to be installed\.\))$/.test(remainder)) return false;
  const descriptions = q.options.map(option => (option.description ?? '').trim().replace(/\s+/g, ' '));
  const noDescription = /^(?:Skip Codex \+ Claude subagent outside pass\. Best for this case: it's a scoped settings form update with a complete DESIGN\.md; hard-rejection checks apply to marketing surfaces, not OPERATE\/settings UI\.|Skip outside voices and go straight to the 7 review passes\. Faster; sufficient for most plans\.)$/;
  const yesDescription = /^(?:Run Codex against OpenAI design hard rules \+ litmus checks, and a separate Claude subagent for an independent completeness review\. Adds time but catches anything a single-model pass misses\.|Launches Codex design critique \+ Claude subagent completeness review in parallel before the 7 passes\. Adds 1[–-]2 minutes\.)$/;
  if (labels.some((label, index) => descriptions[index] &&
      !(/^No\b/.test(label) ? noDescription : yesDescription).test(descriptions[index]!))) return false;
  const no = labels.filter(label => /^No(?:\s*[,—–-]\s*|\s+)proceed without$/i.test(label));
  const yes = labels.filter(label => /^Yes(?:\s*[,—–-]\s*|\s+)run (?:outside(?: design)? voices|Codex \+ Claude subagent)$/i.test(label));
  return labels.length === 2 && no.length === 1 && yes.length === 1 &&
    q.options.some(option => option.label === call.answers?.[q.question]);
}

/** A completed finding can start the passes when the caller already supplied the focus. */
export function isDesignCountFirstReview(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  if (isDesignCountSetup(fp)) return false;
  if (designFirstReviewAUQ(fp)) return true;
  return call.questions.some(q => {
    if (!call.answers?.[q.question] || q.options.length < 2) return false;
    if (/^(?:focus|scope|learnings|routing|next steps?|outside(?: design)? voices)$/i.test(q.header.trim())) return false;
    const id = /<gstack-qid:\s*([a-z0-9-]+)\s*>/i.exec(q.question)?.[1] ?? '';
    if (/(?:^|-)(?:focus|scope|setup|routing|learnings|onboarding|next-steps?|posture|mockups?|target)(?:-|$)/i.test(id)) return false;
    // Native fingerprints prepend the menu header. Inspect the actual question
    // for an explicit finding that offers a plan amendment and deferral.
    if (call.answered === true && call.failed === false && /^Pass\s*[1-7]\s*\([^)]*\)\s*[—–:]\s*Finding\s*[1-9]\d*:\s+\S/i.test(q.question.trim()) &&
        /^plan-design-review-[a-z0-9-]+$/i.test(id) &&
        (q.question.match(/<gstack-qid/gi)?.length ?? 0) === 1 &&
        /\b(?:Apply|Add|Fix|Specify|Define|Restore)\b[^?\n]*\b(?:to|in) the plan\?\s*<gstack-qid:[^>]+>\s*$/i.test(q.question) &&
        q.options.some(option => /^(?:Apply|Add|Fix|Specify|Define|Restore)\b/i.test(option.label)) &&
        q.options.some(option => /^(?:Defer|Leave|Keep as-is|Accept the gap)\b/i.test(option.label)) &&
        q.options.some(option => option.label === call.answers?.[q.question]) &&
        Array.isArray(call.unansweredQuestionIndices) && !call.unansweredQuestionIndices.length &&
        fp.signature === `${call.sessionId}:${call.toolUseId}`) return true;
    // A named or scored pass can ask for a missing design requirement before a
    // numbered finding heading appears. Its actual decision and opposed
    // choices establish review; a score or familiar qid alone cannot.
    const scoredPass = /^(?:D\s*\d+\s*[—–:-]\s*)?Pass\s*[1-7]\s*\([^)]*\)\s*[—–:-]\s*(?:10|[0-9])(?:\.[0-9]+)?\/10[.!:]/i.test(q.question.trim());
    const namedPass = /^(?:D\s*\d+\s*[—–:-]\s*)?Pass\s*[1-7]\s*[—–:-]\s*[A-Za-z][A-Za-z ]{3,60}:\s+/i.test(q.question.trim());
    const chosen = q.options.some(option => option.label === call.answers?.[q.question]);
    const fixChoice = q.options.some(option => /^(?:Add|Fix|Specify|Define|Restore)\b/i.test(option.label));
    const leaveChoice = q.options.some(option => /^(?:Leave as-is|Keep as-is|Defer|Accept the gap)\b/i.test(option.label) ||
      /^Skip\s*[—–-]\s*implied by\s+[^.!?]+\bgap$/i.test(option.label));
    if ((scoredPass || namedPass) && /^plan-design-review-[a-z0-9-]+$/i.test(id) &&
        (q.question.match(/<gstack-qid/gi)?.length ?? 0) === 1 &&
        /\b(?:gap|problem|defect|missing|inconsisten\w*)\b|\b(?:doesn['’]t|does not)\s+(?:record|specify|define|describe)\b/i.test(q.question) &&
        /\bShould I (?:add|fix|specify|define|restore)\b[^?]+\?\s*<gstack-qid:[^>]+>\s*$/i.test(q.question) &&
        fixChoice && leaveChoice && chosen &&
        !(call.unansweredQuestionIndices?.length) &&
        fp.signature === `${call.sessionId}:${call.toolUseId}`) return true;
    // Native pass decisions can carry a D-number before the pass title and
    // use plan-design-passN rather than plan-design-review-... identities.
    // Bind both forms to the same explicit pass and an offered choice that
    // leaves a named gap unresolved. Pass readiness is only setup.
    const numberedPass = /^D\s*\d+\s*[—–:-]\s*Pass\s*([1-7])\s*\([^)]*\)\s*:/i.exec(q.question.trim());
    const passId = /^plan-design-pass([1-7])-/i.exec(id);
    const unresolvedChoice = q.options.some(option =>
      /\b(?:leave|keep|defer|accept)\b/i.test(option.label) &&
      /\b(?:gap|problem|defect|inconsisten\w*)\b/i.test(`${option.label} ${option.description ?? ''}`));
    if (numberedPass && passId && numberedPass[1] === passId[1] && unresolvedChoice && /\?/.test(q.question)) return true;
    // These are issue-bearing pass statements in actual answered calls,
    // not a setup request that merely mentions the seven review passes.
    return /^Pass\s*[1-7]\s+(?:surfaces|(?:also\s+)?(?:found|flagged))\b/i.test(q.question.trim()) &&
      /\?/.test(q.question);
  });
}

/** A closed recap may explain why Eng is next; it cannot request another fix. */
function closedDesignGateRecap(tail: string, descriptions: string[]): boolean {
  const navigation = /\bWhat(?:['’]s)?\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.exec(tail);
  if (!navigation) return false;
  const body = tail.slice(0, navigation.index).trim();
  const gate = /^(?:Eng(?:ineering)? Review is (?:the )?required (?:shipping gate|gate before shipping))[.!]?$/i;
  const sentences = (text: string) => text.split(/[.!]\s+|[.!]$/).map(s => s.trim()).filter(Boolean);
  const recap = (text: string): boolean => {
    // Each count describes completed or explicitly absent work. A positive
    // deferred/open count is not a closed review, regardless of its title.
    const count = /^(?:(?:\d+|all)\s+(?:design\s+)?(?:decisions|findings|issues)\s+(?:(?:are|were)\s+)?(?:resolved|approved|addressed|closed)|\d+\s+(?:implementation\s+)?tasks\s+(?:(?:are|were)\s+)?(?:added|recorded|ready)|(?:no|zero|0)\s+(?:deferred(?:\s+(?:decisions|findings|issues|tasks|items))?|(?:unresolved|open|pending|outstanding)\s+(?:decisions|findings|issues|tasks|items)))$/i;
    if (text.split(/,\s*(?:and\s+)?|\s+and\s+/i).every(part => count.test(part))) return true;
    // Only a declarative completed-review subject can introduce explanatory
    // content. Separate clauses, questions and conditional/future work fail.
    if (!/^(?:The|This)\s+(?:design\s+)?review\s+(?:has\s+)?(?:added|recorded|approved|addressed|specified|covered|resolved)\s+\S/i.test(text)) return false;
    if (/[;?<>]|\b(?:if|unless|until|once|when|should|must|need|needs|will|would|could|please|then|also|still|missing|unresolved)\b|\b(?:and|but)\s+(?:first\s+)?(?:do|add|fix|repair|implement|resolve|decide|configure|remove|delete|pick|choose)\b/i.test(text)) return false;
    const clauses = text.split(/\s+[—–]\s+/);
    return clauses.length <= 2 && (clauses.length === 1 || /^(?:architectural|engineering|implementation)\s+(?:implications|considerations|details)\b/i.test(clauses[1]!));
  };
  const parts = sentences(body);
  if (parts.filter(part => gate.test(part)).length !== 1 ||
      !parts.every(part => gate.test(part) || recap(part))) return false;
  return descriptions.every(description => sentences(description).every(part =>
    gate.test(part) || recap(part) ||
    /^Exit plan mode and proceed on your own$/i.test(part) ||
    /^You have \d+ (?:concrete )?(?:implementation )?tasks ready to build from$/i.test(part)));
}

/** A qidless closed handoff must consume every question/description clause. */
function resolvedDesignHandoff(q: NonNullable<AskUserQuestionFingerprint['nativeCall']>['questions'][number]): number | null {
  if (!/^next review$/i.test(q.header.trim()) || q.options.length !== 2) return null;
  const completed = /^Design review complete [—–-] (?:10|[0-9](?:\.\d+)?)\/10 (?:→|->) (?:10|[0-9](?:\.\d+)?)\/10\. All ([1-9]\d*) decisions resolved\. The plan is design-complete; next is the required shipping gate\. What['’]s next\?$/.exec(q.question.trim());
  if (!completed) return null;
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  const review = labels.findIndex(label => /^Run \/plan-eng-review$/i.test(label));
  const manual = labels.findIndex(label => /^Skip\s*[—–-]\s*I['’]ll handle next steps manually$/i.test(label));
  if (review < 0 || manual < 0 || review === manual) return null;
  const description = (index: number) => (q.options[index]!.description ?? '').trim().replace(/\s+/g, ' ');
  const topics = '(?:spinner|skeleton|(?:button|switch|field) (?:keyboard|focus|loading|error|disabled|pending|success)|(?:keyboard|focus|loading|error|disabled|pending|success) (?:states?|behavior|navigation))';
  const recap = new RegExp('^Eng review is the required shipping gate\\. It validates architecture, component wiring, tests, and accessibility implementation against the ' + completed[1] + ' approved design decisions\\. This design review added interaction specs \\(' + topics + '(?:, ' + topics + ')*\\), so eng review needs to validate their architectural fit\\.$');
  if (!recap.test(description(review)) ||
      !/^End the review workflow here\. The improved plan is at the (?:e2e output|approved plan) path; implementation can begin\. Run \/plan-eng-review later before shipping\.$/.test(description(manual))) return null;
  return manual + 1;
}

function designHandoff(fp: AskUserQuestionFingerprint): { manualIndex: number | null } | null {
  const call = fp.nativeCall;
  if (!call || call.failed || call.questions.length !== 1 ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2) return null;
  const pending = call.answered === false && call.answers === undefined && call.answeredAt === undefined &&
    (call.unansweredQuestionIndices === undefined || (Array.isArray(call.unansweredQuestionIndices) &&
      call.unansweredQuestionIndices.length === 1 && call.unansweredQuestionIndices[0] === 0));
  const resolvedManual = call.failed === false && (call.answered === true || pending) ? resolvedDesignHandoff(q) : null;
  if (resolvedManual !== null) return { manualIndex: resolvedManual };
  if (!/^next\s+steps?$/i.test(q.header.trim())) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)].map(match => match[1]);
  if ((q.question.match(/<gstack-qid\b/gi) ?? []).length !== 1 || ids.length !== 1 || !/^plan-design-(?:review-)?next-steps?$/i.test(ids[0]!)) return null;
  const declaration = q.question.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/^next\s+steps?\s*:\s*/i, '');
  // Scores and a completed decision count describe a closed review. A
  // condition or unresolved gap cannot masquerade as its next-step menu.
  const completed = /^Design\s+review\s+(?:is\s+)?complete(?:[.!]|\s+\((?:\d+(?:\.\d+)?(?:\/10)?\s*(?:→|->|to)\s*)?\d+(?:\.\d+)?\/10(?:,\s*\d+\s+decisions?(?:\s+(?:made|added))?)?\)[.!])(?:\s|$)/i.exec(declaration);
  if (!completed) return null;
  const requiredGateOffer = /^The required next gate is Eng(?:ineering)? Review\s*[—–-]\s*want me to run it now\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim());
  const closedRecap = q.options.length === 2 && closedDesignGateRecap(
    declaration.slice(completed[0].length).trim(), q.options.map(option => option.description ?? ''));
  const requiredGateQuestion = requiredGateOffer || closedRecap || /^(?:\d+ implementation tasks ready\.\s*)?Eng(?:ineering)? Review is the required shipping gate\.\s*What next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim());
  // The offered Eng action can carry the required-gate declaration while the
  // closed question asks only what is next. Its descriptions remain part of
  // the decision, so they cannot conceal a new repair or conditional closure.
  const describedRequiredGate = /^What['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim()) &&
    q.options.some(option => /^Run \/plan-eng-review(?:\s*\(recommended\))?$/i.test(option.label.trim()) &&
      /^Required gate before shipping[.!]/i.test(option.description ?? ''));
  const guardedNavigation = requiredGateQuestion || describedRequiredGate;
  if (!requiredGateQuestion && !/\bWhat['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration)) return null;
  // A routing label cannot conceal a new repair in its description.
  if (guardedNavigation && q.options.some(option =>
    /(?:^|[.!?;]\s+|\b(?:proceed to|continue to|must|need to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|repair|implement|resolve|decide)\b|\b(?:(?:should|could|can|would)\s+(?:we|I)|(?:we|I)\s+(?:should|could|can|would))\s+(?:add|fix|repair|implement|resolve|decide)\b/i.test(option.description ?? '') ||
    /\b(?:Design|the|this)\s+review\s+(?:(?:is|remains)\s+)?(?:not\s+(?:complete|done|resolved)|incomplete|unfinished)\b|\bnot\s+all\s+(?:decisions|findings|issues|gaps)\s+(?:are\s+)?(?:resolved|complete|done)\b|\b(?:decisions|findings|issues|gaps)\s+(?:are\s+)?not\s+(?:resolved|complete|done)\b/i.test(option.description ?? '') ||
    /\b(?:once|after|when|if|unless|until)\b[^.!?]*\b(?:review|decisions?|findings?|issues?|gaps?)\b[^.!?]*\b(?:complete|done|resolved)\b|\b(?:review|decisions?|findings?|issues?|gaps?)\b[^.!?]*\b(?:complete|done|resolved)\b[^.!?]*\b(?:once|after|when|if|unless|until)\b/i.test(option.description ?? ''))) return null;
  // A closed heading does not override an affirmative outstanding-work claim
  // in its recap. Zero/no outstanding work is a compatible completion claim.
  const outstanding = (guardedNavigation ? [declaration, ...q.options.map(o => o.description ?? '')].join('\n') : declaration)
    .replace(/\b(?:no|zero|0)\s+(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b/gi, '')
    .replace(/\bno\s+(?:gaps?|issues?|decisions?|requirements?|work)\s+remains?\b/gi, '');
  if (/\b(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:still\s+)?remains?\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:is|are)\s+still\s+(?:unresolved|open|pending|unaddressed)\b/i.test(outstanding)) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '')
    .replace(/\s*\(recommended\)\s*$/i, '').trim());
  const manual = labels.map(label => /^(?:Handle next steps manually|Skip\s*[—–-]\s*I['’]ll handle next steps manually)$/i.test(label) ||
    (guardedNavigation && /^Skip\s*[—–-]\s*handle (?:next steps )?manually$/i.test(label)));
  const review = labels.map(label => /^Run \/plan-eng-review(?: next)?(?: \(required gate\))?$/i.test(label));
  const navigation = labels.map(label => /^(?:Skip to implementation|Run \/plan-ceo-review(?: first)?|Run \/design-(?:shotgun|html))$/i.test(label));
  if (manual.filter(Boolean).length > 1 || !review.some(Boolean) ||
      !labels.every((_, i) => manual[i] || review[i] || navigation[i])) return null;
  // Classification does not invent a missing stop option. Only an offered
  // manual action can steer a pending question away from another workflow.
  const index = manual.findIndex(Boolean);
  return { manualIndex: index < 0 ? null : index + 1 };
}

/** Completed handoffs retain raw evidence and their own administrative count. */
export function isDesignCompletionHandoff(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || designHandoff(fp) === null) return false;
  const q = call.questions[0]!;
  return q.options.some(option => call.answers?.[q.question] === option.label);
}

/** Preserve the native-only outside opt-out, then finish this review at its actual handoff. */
export function pickDesignCountQuestion(
  routing: AskUserQuestionFingerprint,
  active: AskUserQuestionFingerprint,
): number | null {
  const outside = pickDesignCountOutsideVoices(routing, active);
  if (outside !== null) return outside;
  return active.nativeCall?.answered ? null : designHandoff(active)?.manualIndex ?? null;
}
