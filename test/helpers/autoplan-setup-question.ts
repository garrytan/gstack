import { capturePlanCountQuestion, planCountPrerequisitePick, planCountQuestionInput, type AskUserQuestionFingerprint } from './claude-pty-runner';

import type { NativePlanQuestionCall } from './plan-count-transcript';

/** A copied native panel is not actionable after prose or inside a code example. */
function activeSetupPanel(visible: string): boolean {
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

export type AutoplanSetupDecision =
  | { kind: 'input'; input: string; signatures: string[] }
  | { kind: 'waiting' | 'unrelated' }
  | { kind: 'unsupported_setup'; setup: 'routing' | 'prerequisite'; prompt: string;
      options: Array<{ index: number; label: string }>; identitySource: 'native-bound' | 'current-native-panel' };

/** Fail only a complete current setup panel; absence or stale/partial metadata is not failure. */
function completeSetupOptions(visible: string, pending?: NativePlanQuestionCall): Array<{ index: number; label: string }> | null {
  if (!activeSetupPanel(visible)) return null;
  const lines = visible.replace(/\r+\n?/g, '\n').trimEnd().split('\n');
  const header = lines.findLastIndex(line => /^ {0,3}[☐□][^\n]+$/.test(line));
  const introduction = lines.slice(0, header).findLast(line => !/^[\t ─━-]*$/.test(line)) ?? '';
  if (/\b(?:example|sample|quot(?:e[sd]?|ed)|template|source)\b[^\n]*:\s*$/i.test(introduction)) return null;
  const panel = lines.slice(header);
  if (/[←→☒]|✔\s*Submit/.test(panel[0]!) ||
      panel.some(line => /(?:^|\s)[1-9]\.\s*\[[ ✓✔xX]\]/.test(line))) return null;
  if (panel.filter(line => /^ {0,3}❯\s*1\./.test(line)).length !== 1 ||
      panel.filter(line => /❯\s*[1-9]\./.test(line)).length !== 1) return null;
  const rows = panel.flatMap(line => {
    const match = /^ {0,3}(?:❯\s*)?([1-9])\.[\t ]*(\S.*?)\s*$/.exec(line);
    return match ? [{ index: Number(match[1]), label: match[2]! }] : [];
  });
  const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase();
  if (rows.length < 4 || rows.some((row, index) => row.index !== index + 1) ||
      compact(rows.at(-2)!.label) !== 'typesomething.' || compact(rows.at(-1)!.label) !== 'chataboutthis') return null;
  const options = rows.slice(0, -2);
  if (pending) {
    const native = pending.questions[0];
    const cursor = panel.findIndex(line => /^ {0,3}❯\s*1\./.test(line));
    if (pending.answered || pending.failed || pending.questions.length !== 1 || native?.multiSelect ||
        compact(panel[0]!.replace(/^ {0,3}[☐□]/, '')) !== compact(native!.header) ||
        !compact(panel.slice(1, cursor).join(' ')).includes(compact(native!.question)) ||
        options.length !== native!.options.length || options.some((row, index) => compact(row.label) !== compact(native!.options[index]!.label))) return null;
  }
  return options;
}

function unsupportedSetup(visible: string, question: AskUserQuestionFingerprint,
  setup: 'routing' | 'prerequisite', pending?: NativePlanQuestionCall): AutoplanSetupDecision {
  const options = completeSetupOptions(visible, pending);
  return options ? { kind: 'unsupported_setup', setup, prompt: question.promptSnippet, options,
    identitySource: pending ? 'native-bound' : 'current-native-panel' } : { kind: 'waiting' };
}

/** Pure classification: only the caller that sends input commits returned identities. */
export function autoplanSetupDecision(visible: string, seen: ReadonlySet<string>, pending?: NativePlanQuestionCall): AutoplanSetupDecision {
  if (pending && (pending.answered || pending.failed || pending.questions.length !== 1 || pending.questions[0]?.multiSelect)) return { kind: 'waiting' };
  // Box borders are terminal decoration, not part of an untagged native
  // question's wrapped text. Keep its full content for identity matching.
  const display = visible.replace(/(^|[\r\n])[\t ]*[│┃][\t ]?/g, '$1');
  // A rejected/mismatched menu has received no input. Keep its identities
  // available when the actual native call arrives after the visible prompt.
  const captured = new Set(seen);
  const question = capturePlanCountQuestion(display, captured, 0, true, pending);
  if (!question) return { kind: 'waiting' };
  const answered = (input: string | null): AutoplanSetupDecision => input === null
    ? { kind: 'waiting' }
    : { kind: 'input', input, signatures: [...captured].filter(signature => !seen.has(signature)) };

  const prerequisite = planCountPrerequisitePick(question);
  const prerequisitePrompt = /\/office-hours/i.test(question.promptSnippet) &&
    /(?:no\s*design\s*doc|produce\s*a\s*design\s*doc)/i.test(question.promptSnippet);
  if (prerequisitePrompt) {
    // The canonical offer has two opposed choices. A known native call must
    // match this one-question panel; no mixed packet or substantive choice
    // may borrow its skip. Before JSONL flushes, require the complete native
    // single-select UI and the existing prerequisite premise/action guard.
    const choices = question.options.filter(option =>
      !/^(?:Type something\.|Chat about this)$/.test(option.label));
    if (choices.length !== 2 || (pending &&
        (!question.nativeCall || pending.questions.length !== 1 || pending.questions[0]?.multiSelect))) return { kind: 'waiting' };
    if (prerequisite === null) {
      // Mentioning a missing design doc or /office-hours in a product/taste
      // question does not make it setup. Independently identify an offer to
      // run that prerequisite even when its opposed skip is unsupported.
      const run = choices.filter(({ label }) => /^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(label));
      // UI fingerprints abbreviate long questions; inspect the current
      // question before its cursor, with full-panel validation below.
      const beforeOptions = display.slice(0, display.search(/❯\s*1\./));
      const offer = /\brun\s*\/office-hours\s*(?:now|first)\s*\?(?:\s*<gstack-qid:[^>]+>)?\s*$/i.test(beforeOptions);
      return run.length === 1 && offer ? unsupportedSetup(display, question, 'prerequisite', pending) : { kind: 'unrelated' };
    }
    const input = planCountQuestionInput(display, question, prerequisite);
    if (!/^[1-9]\d*$/.test(input ?? '') || !activeSetupPanel(display)) return { kind: 'waiting' };
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
  // "Only" limits the same manual action; it does not add a second action.
  // Use one whole-label grammar with and without a courtesy/Skip prefix.
  const manualAction = /^(?:manual(?:invocation)?|(?:I['’]ll)?invoke(?:skills)?manually)(?:[-–—]?only)?$/i;
  const decline = options.filter(option => {
    const title = option.title.replace(/\(Recommended\)$/i, '');
    // The action can stand alone or follow a short courtesy ('No thanks').
    // Cursor redraws can damage that courtesy while leaving 'invoke skills
    // manually' intact. Match the complete action, not the spelling of No;
    // arbitrary preceding instructions and extra trailing actions still fail.
    const manual = title.replace(/^[a-z]{0,3}thanks[,—–-]/i, '');
    if (manualAction.test(manual)) return true;
    const prefix = /^(?:Nothanks|Skip)(?:[,—–-])?/i.exec(title);
    if (!prefix) return false;
    // 'No thanks' can be followed by the same explicit Skip action. Strip
    // that decline verb before checking any optional manual-invocation text.
    const action = title.slice(prefix[0].length).replace(/^skip(?:[,—–-])?/i, '');
    return action === '' || manualAction.test(action);
  });
  const routingId = /<gstack-qid:routing-injection>/i.test(question.promptSnippet);
  const routingPremise = /gstack/i.test(prompt) && /CLAUDE\.md/i.test(prompt) && /skillroutingrules/i.test(prompt);
  // A qid can replace the longer premise, but cannot override a question
  // about a different target. The Add action and question must agree on
  // project setup rather than a product routing or taste decision.
  const claudeTarget = /CLAUDE\.md/i.test(prompt);
  const quotedPremise = /\b(?:plan|spec|document)\s+(?:quotes?|cites?|references?)\b/i.test(primary);
  if (!claudeTarget || quotedPremise || (!routingId && !routingPremise)) return { kind: 'unrelated' };
  if (pending && (!question.nativeCall || pending.questions.length !== 1 || pending.questions[0]?.multiSelect)) return { kind: 'waiting' };
  // An intact Add-to-CLAUDE.md action identifies this setup offer even if
  // its opposed decline is unsupported. A qid or premise alone must not
  // turn substantive/ambiguous choices into an early setup failure.
  if (add.length !== 1) return { kind: 'waiting' };
  if (decline.length !== 1 || add[0]!.index === decline[0]!.index) return unsupportedSetup(display, question, 'routing', pending);
  return answered(planCountQuestionInput(display, question, add[0]!.index));
}

/** Compatibility wrapper: preserve the existing input-only API. */
export function autoplanRoutingSetupInput(visible: string, seen: Set<string>, pending?: NativePlanQuestionCall): string | null {
  const decision = autoplanSetupDecision(visible, seen, pending);
  if (decision.kind !== 'input') return null;
  for (const signature of decision.signatures) seen.add(signature);
  return decision.input;
}
