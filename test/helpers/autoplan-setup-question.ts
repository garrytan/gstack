import { capturePlanCountQuestion, planCountPrerequisitePick, planCountQuestionInput } from './claude-pty-runner';

import type { NativePlanQuestionCall } from './plan-count-transcript';

/** A copied native panel is not actionable after prose or inside a code example. */
function activePrerequisitePanel(visible: string): boolean {
  const lines = visible.replace(/\r+\n?/g, '\n').trimEnd().split('\n');
  if (!/^Enter[\t ]+to[\t ]+select[\t ]*·[\t ]*↑\/↓[\t ]+to[\t ]+navigate[\t ]*·[\t ]*Esc[\t ]+to[\t ]+cancel$/i.test(lines.at(-1)?.trim() ?? '')) return false;
  const header = lines.findLastIndex(line => /^ {0,3}[☐□][^\n]+$/.test(line));
  if (header < 0) return false;
  let fence: { char: string; length: number } | undefined;
  for (const line of lines.slice(0, header)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { char: match[1]![0]!, length: match[1]!.length };
    else if (match[1]![0] === fence.char && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
  }
  if (fence) return false;
  const introduction = lines.slice(0, header).findLast(line => !/^[\t ─━-]*$/.test(line)) ?? '';
  return !/\b(?:example|sample|quot(?:e[sd]?|ed)|template|source)\b.*\b(?:panel|menu|choices?|prompt|question|below|following)\b/i.test(introduction);
}

/** Handle routing and the optional design-doc prerequisite in this isolated fixture. */
export function autoplanRoutingSetupInput(visible: string, seen: Set<string>, pending?: NativePlanQuestionCall): string | null {
  // Box borders are terminal decoration, not part of an untagged native
  // question's wrapped text. Keep its full content for identity matching.
  const display = visible.replace(/(^|[\r\n])[\t ]*[│┃][\t ]?/g, '$1');
  // A rejected/mismatched menu has received no input. Keep its identities
  // available when the actual native call arrives after the visible prompt.
  const captured = new Set(seen);
  const question = capturePlanCountQuestion(display, captured, 0, true, pending);
  if (!question) return null;
  const answered = (input: string | null) => {
    if (input !== null) for (const signature of captured) seen.add(signature);
    return input;
  };

  const prerequisite = planCountPrerequisitePick(question);
  if (prerequisite !== null) {
    // The canonical offer has two opposed choices. A known native call must
    // match this one-question panel; no mixed packet or substantive choice
    // may borrow its skip. Before JSONL flushes, require the complete native
    // single-select UI and the existing prerequisite premise/action guard.
    const choices = question.options.filter(option =>
      !/^(?:Type something\.|Chat about this)$/.test(option.label));
    if (choices.length !== 2 || (pending &&
        (!question.nativeCall || pending.questions.length !== 1 || pending.questions[0]?.multiSelect))) return null;
    const input = planCountQuestionInput(display, question, prerequisite);
    if (!/^[1-9]\d*$/.test(input ?? '') || !activePrerequisitePanel(display)) return null;
    return answered(input);
  }

  // The model rephrases the setup question's closing sentence. Its routing
  // identity/premise and two opposed setup actions establish what is being
  // asked; an exact "Add them now?" sentence is not a stable interface.
  // Keep the actual question/premise separate from its header and later ELI10
  // prose, which may mention CLAUDE.md even on an unrelated question.
  const primary = question.promptSnippet.replace(/^(?:Routing\s*rules|CLAUDE\.md)\s*/i, '').split('?', 1)[0]!;
  const prompt = primary.replace(/\s+/g, '');
  const options = question.options.map(option => ({
    index: option.index,
    title: option.label.split(/[│┌\r\n]/, 1)[0]!.replace(/\s+/g, ''),
  }));
  const add = options.filter(option => /^Add(?:routingrules(?:toCLAUDE\.md)?|toCLAUDE\.md)(?:\(Recommended\))?$/i.test(option.title));
  // Match the declined setup action, not every English label separately:
  // No thanks/Skip may stand alone or opt into manual invocation. A manual
  // migration, deletion, or unrelated workflow is not the opposed action.
  const decline = options.filter(option => {
    const title = option.title.replace(/\(Recommended\)$/i, '');
    // The action can stand alone or follow a short courtesy ('No thanks').
    // Cursor redraws can damage that courtesy while leaving 'invoke skills
    // manually' intact. Match the complete action, not the spelling of No;
    // arbitrary preceding instructions and extra trailing actions still fail.
    const manual = title.replace(/^[a-z]{0,3}thanks[,—–-]/i, '');
    if (/^(?:manualinvocation|(?:I['’]ll)?invoke(?:skills)?manually)$/i.test(manual)) return true;
    const prefix = /^(?:Nothanks|Skip)(?:[,—–-])?/i.exec(title);
    if (!prefix) return false;
    // 'No thanks' can be followed by the same explicit Skip action. Strip
    // that decline verb before checking any optional manual-invocation text.
    const action = title.slice(prefix[0].length).replace(/^skip(?:[,—–-])?/i, '');
    return action === '' || /^(?:manual(?:invocation)?|(?:I['’]ll)?invoke(?:skills)?manually)$/i.test(action);
  });
  if (add.length !== 1 || decline.length !== 1 || add[0]!.index === decline[0]!.index) return null;
  const routingId = /<gstack-qid:routing-injection>/i.test(question.promptSnippet);
  const routingPremise = /gstack/i.test(prompt) && /CLAUDE\.md/i.test(prompt) && /skillroutingrules/i.test(prompt);
  // A qid can replace the longer premise, but cannot override a question
  // about a different target. The Add action and question must agree on
  // project setup rather than a product routing or taste decision.
  const claudeTarget = /CLAUDE\.md/i.test(prompt);
  const quotedPremise = /\b(?:plan|spec|document)\s+(?:quotes?|cites?|references?)\b/i.test(primary);
  if (!claudeTarget || quotedPremise || (!routingId && !routingPremise)) return null;
  return answered(planCountQuestionInput(display, question, add[0]!.index));
}
