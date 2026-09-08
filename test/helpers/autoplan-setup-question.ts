import { capturePlanCountQuestion, planCountQuestionInput } from './claude-pty-runner';

import type { NativePlanQuestionCall } from './plan-count-transcript';

/** Answer only gstack's routing setup prompt in the isolated autoplan fixture. */
export function autoplanRoutingSetupInput(visible: string, seen: Set<string>, pending?: NativePlanQuestionCall): string | null {
  const question = capturePlanCountQuestion(visible, seen, 0, true, pending);
  if (!question) return null;

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
  return planCountQuestionInput(visible, question, add[0]!.index);
}
