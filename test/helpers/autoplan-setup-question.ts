import { capturePlanCountQuestion, parseNumberedOptions, planCountPrerequisitePick, planCountQuestionInput, planCountSubmissionInput, type AskUserQuestionFingerprint } from './claude-pty-runner';

import type { NativePlanQuestion, NativePlanQuestionCall, NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';
import type { readPendingQuestion } from './plan-count-pending-question';

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

/** A long boxed routing question can retain its title after only the header scrolls away. */
function clippedRoutingTitle(visible: string, question: AskUserQuestionFingerprint): string | null {
  const lines = visible.replace(/\r+\n?/g, '\n').trimEnd().split('\n');
  const title = /^ {0,3}[│┃][\t ]*(.+)$/.exec(lines[0] ?? '')?.[1];
  if (!title || !/^(?:D\s*\d+\s*[—–:-]\s*)?Add\s+(?:gstack\s+)?skill\s+routing\s+rules\s+to\s+CLAUDE\.md\?\s*<gstack-qid:routing-injection>$/i.test(title)) return null;
  const cursors = lines.flatMap((line, index) => /❯\s*[1-9]\./.test(line) ? [index] : []);
  if (cursors.length !== 1 || !/^ {0,3}❯\s*1\./.test(lines[cursors[0]!]!)) return null;
  const before = lines.slice(0, cursors[0]);
  if (before.some(line => line.trim() && !/^ {0,3}[│┃](?:[\t ]|$)/.test(line)) ||
      before.some(line => /^ {0,3}[│┃][\t ]*(?:`{3,}|~{3,}|>)/.test(line)) ||
      (before.join('\n').match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      /[☐□☒]|←[^\n]*Submit|(?:^|\n)[^\n]*[1-9]\.\s*\[[ ✓✔xX]\]/.test(visible)) return null;
  if (!/^Enter[\t ]+to[\t ]+select[\t ]*·[\t ]*↑\/↓[\t ]+to[\t ]+navigate[\t ]*·[\t ]*Esc[\t ]+to[\t ]+cancel$/i.test(lines.at(-1)?.trim() ?? '')) return null;
  const rows = lines.slice(cursors[0]).flatMap(line => {
    const match = /^ {0,3}(?:❯\s*)?([1-9])\.[\t ]*(\S.*?)\s*$/.exec(line);
    return match ? [{ index: Number(match[1]), label: match[2]! }] : [];
  });
  if (rows.length !== 4 || rows.some((row, index) => row.index !== index + 1) ||
      rows[2]!.label !== 'Type something.' || rows[3]!.label !== 'Chat about this' ||
      JSON.stringify(rows) !== JSON.stringify(question.options)) return null;
  return title;
}

/** Identify a complete current setup panel; absence or stale/partial metadata is insufficient. */
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

/** Pure routing policy; native packet validation still requires every displayed identity. */
function routingSetupActions(question: AskUserQuestionFingerprint, allowTemporarySkip: boolean, knownSetupOffer = false) {
  const primary = question.promptSnippet.replace(/^(?:Routing\s*rules|CLAUDE\.md)\s*/i, '').split('?', 1)[0]!;
  const prompt = primary.replace(/\s+/g, '');
  const options = question.options.map(option => {
    const label = option.label.split(/[│┌\r\n]/, 1)[0]!.trim();
    // A native label may repeat its menu letter. Remove one corresponding
    // marker only for action matching; keep the original display identity.
    const marker = /^([A-Z])\)[\t ]+/i.exec(label);
    const action = marker && marker[1]!.toUpperCase().charCodeAt(0) - 64 === option.index
      ? label.slice(marker[0].length) : label;
    return { index: option.index, title: action.replace(/\s+/g, '') };
  });
  const add = options.filter(option => /^Add(?:routingrules(?:toCLAUDE\.md)?|toCLAUDE\.md)(?:\(Recommended\))?$/i.test(option.title));
  // Match the declined setup action, not every English label separately:
  // No thanks/Skip may stand alone or opt into manual invocation. A manual
  // migration, deletion, or unrelated workflow is not the opposed action.
  // "Only" limits the same manual action; it does not add a second action.
  // Use one whole-label grammar with and without a courtesy/Skip prefix.
  const manualAction = /^(?:manual(?:invocation|skills)?|(?:I['’]ll)?invoke(?:skills)?manually)(?:[-–—]?only)?$/i;
  // A temporary Skip is the same opposed setup action only on an intact
  // two-choice panel. Its description may corroborate manual invocation;
  // the routing premise and unique Add action below establish its scope.
  const decline = options.filter(option => {
    const title = option.title.replace(/\(Recommended\)$/i, '');
    if (/^Skipfornow$/i.test(title)) return allowTemporarySkip;
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
  if (!claudeTarget || quotedPremise || (!knownSetupOffer && !routingId && !routingPremise)) return null;
  return { add, decline };
}

/** A direct setup offer can carry a decision brief without changing its actions. */
function contextualPacketSetup(question: NativePlanQuestion, pending: NativePlanQuestionCall) {
  if (pending.answered !== false || pending.failed !== false || !pending.sessionId || !pending.toolUseId ||
      question.options.length !== 2 || question.options.some(option => !option.description?.trim())) return null;
  const ids = [...question.question.matchAll(/<gstack-qid:[a-z0-9-]+>/gi)];
  const text = question.question.replace(/<gstack-qid:[a-z0-9-]+>/gi, '').trim();
  const split = /^([^?]+\?)([\s\S]+)$/.exec(text);
  if (!split || !split[2]!.trim() || split[2]!.includes('?')) return null;
  // Strip one presentation label, then match the complete substantive offer.
  // A quoted/conditional/adjacent offer cannot borrow another tab's actions.
  const offer = split[1]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '').replace(/\s+/g, ' ').trim();
  const context = [split[2]!.trim(), ...question.options.map(option => option.description!.trim())].join('\n');
  if (/(?:^|\n|[.!]\s+)(?:Also|Then)\b|\bonly\s+(?:if|after)\b|\bunless\b|\bprovided\s+that\b/i.test(context) ||
      /\b(?:must|need\s+to|have\s+to)\s+(?:run|complete|finish)\s*\/office-hours\b/i.test(context) ||
      /(?:\/office-hours|design\s+doc(?:ument)?)\s+(?:is\s+)?(?:required|mandatory)\b/i.test(context) ||
      /\breview\s+is\s+(?:forbidden|blocked)\b|\b(?:skip|bypass|omit)\s+(?:(?:the|this|full|standard|entire|CEO|design|DX|engineering)\s+)*review\b/i.test(context)) return null;
  const descriptions = question.options.map(option => option.description!.trim().replace(/^[✅❌]\s*/, ''));
  const fp: AskUserQuestionFingerprint = { signature: '', observedAtMs: 0, preReview: true,
    promptSnippet: `${question.header} ${question.question}`,
    options: question.options.map((option, index) => ({ index: index + 1, label: option.label })) };
  if (/^Routing(?: rules)?$/i.test(question.header.trim()) &&
      /^Add\s+(?:gstack\s+)?(?:skill\s+)?routing\s+rules\s+to\s+CLAUDE\.md\?$/i.test(offer) &&
      (!ids.length || ids.length === 1 && ids[0]![0].toLowerCase() === '<gstack-qid:routing-injection>')) {
    const actions = routingSetupActions(fp, true, true);
    if (!actions || actions.add.length !== 1 || actions.decline.length !== 1 ||
        actions.add[0]!.index === actions.decline[0]!.index) return null;
    const add = actions.add[0]!.index, decline = actions.decline[0]!.index;
    if (/^(?:Do not|Don't|Never|Skip|Decline)\s+(?:add(?:ing)?\s+)?routing\s+rules\b/i.test(descriptions[add - 1]!) ||
        /^Add\s+(?:skill\s+)?routing\s+rules\b/i.test(descriptions[decline - 1]!)) return null;
    return { kind: 'routing', pick: add };
  }
  if (!/^(?:Design doc|Prerequisites?(?: doc)?)$/i.test(question.header.trim()) || ids.length ||
      !/^Run\s*\/office-hours\s+(?:now|first)(?:\s+for\s+(?:a|the)\s+design\s+doc(?:ument)?)?\?$/i.test(offer)) return null;
  const run = question.options.findIndex(option => /^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(option.label));
  const skip = question.options.findIndex(option => /^Skip\s*[—–-]\s*(?:proceed\s+with\s+)?standard\s+review(?:\s*\(recommended\))?$/i.test(option.label));
  if (run < 0 || skip < 0 || run === skip ||
      /^(?:Skip|Don't|Do not)\b/i.test(descriptions[run]!) ||
      /^Run\s*\/office-hours\b/i.test(descriptions[skip]!)) return null;
  // Corroborate the selected label with its short action clause; the rest
  // of the description may explain tradeoffs without changing that action.
  const sentence = /^([^.!?]+)([.!?]|$)/.exec(descriptions[skip]!);
  const action = sentence?.[1]?.trim() ?? '';
  if (sentence?.[2] === '?' || !/^(?:Review\s+(?:starts?|begins?)\s+(?:immediately|now)|(?:Start|Begin)\s+(?:the\s+)?(?:standard\s+)?review\s+(?:immediately|now)|Proceed\s+(?:directly\s+)?with\s+(?:the\s+)?standard\s+review)(?:\s+(?:using|with|on)\s+[^.!?]+)?$/i.test(action) ||
      /\b(?:after|when|once|until|if|unless|provided|not|never)\b|n['’]t\b/i.test(action)) return null;
  return { kind: 'prerequisite', pick: skip + 1 };
}

/** Numbered setup wording may vary; newly admitted forms still consume every description. */
function numberedPacketSetup(question: NativePlanQuestion, pending: NativePlanQuestionCall) {
  if (pending.answered !== false || pending.failed !== false || !pending.sessionId || !pending.toolUseId || question.options.length !== 2) return null;
  const compact = (value: string | undefined) => (value ?? '').trim().replace(/\s+/g, ' ');
  const ids = [...question.question.matchAll(/<gstack-qid:[a-z0-9-]+>/gi)];
  const text = compact(question.question.replace(/<gstack-qid:[a-z0-9-]+>/gi, ''))
    .replace(/^D[1-9]\d*\s*[—–:-]\s*/, '');
  const fp: AskUserQuestionFingerprint = { signature: '', observedAtMs: 0, preReview: true,
    promptSnippet: `${question.header} ${question.question}`,
    options: question.options.map((option, index) => ({ index: index + 1, label: option.label })) };
  const routing = routingSetupActions(fp, true);
  if (ids.length === 1 && ids[0]![0].toLowerCase() === '<gstack-qid:routing-injection>' &&
      /^Add\s+(?:gstack\s+)?skill\s+routing\s+rules\s+to\s+CLAUDE\.md\?$/i.test(text) &&
      routing?.add.length === 1 && routing.decline.length === 1 && routing.add[0]!.index !== routing.decline[0]!.index) {
    const add = question.options[routing.add[0]!.index - 1]!;
    const decline = question.options[routing.decline[0]!.index - 1]!;
    if (/^Appends a skill routing section to CLAUDE\.md so future sessions automatically invoke the right skill(?: \(e\.g\. \/autoplan for reviews, \/ship for deploys\))? without you needing to type the command each time\. One-time setup per project\.$/i.test(compact(add.description)) &&
        /^No change to CLAUDE\.md\. You['’]ll continue calling skills yourself with \/skill-name as you do now\.$/i.test(compact(decline.description))) {
      return { kind: 'routing', pick: routing.add[0]!.index };
    }
  }
  if (ids.length || !/^No design doc (?:found|exists) for (?:this|the) (?:branch|project)\. Run \/office-hours (?:first|now)(?: to sharpen (?:the|this) review input)?\?$/i.test(text)) return null;
  const run = question.options.findIndex(option => /^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(option.label));
  const skip = question.options.findIndex(option => /^Skip\s*[,—–-]\s*proceed\s+with\s+(?:standard\s+)?review(?:\s*\(recommended\))?$/i.test(option.label));
  if (run < 0 || skip < 0 || run === skip ||
      !/^Start the full CEO (?:→|->) Design (?:→|->) DX (?:→|->) Eng review pipeline now using the plan as-is\. (?:Recommended when the plan context is already rich enough\. ?)?(?:\(Recommended\))?$/i.test(compact(question.options[skip]!.description)) ||
      !/^Produces a structured problem statement, premise challenge, and explored alternatives before the review\. (?:Takes ~?\d+(?:[–-]\d+)? min\. )?Gives the review sharper, better-grounded input\.$/i.test(compact(question.options[run]!.description))) return null;
  return { kind: 'prerequisite', pick: skip + 1 };
}

/** Answer only the known pair of setup offers, using the actual native active tab. */
function setupPacketDecision(visible: string, seen: ReadonlySet<string>, pending: NativePlanQuestionCall): AutoplanSetupDecision {
  const waiting: AutoplanSetupDecision = { kind: 'waiting' };
  // Validate all questions before touching any tab: a setup question cannot
  // lend its policy to an adjacent finding, taste decision or checkbox.
  if (pending.questions.length !== 2) return waiting;
  const policies = pending.questions.map(question => {
    if (question.options.length !== 2) return null;
    const ids = [...question.question.matchAll(/<gstack-qid:[a-z0-9-]+>/gi)];
    if (ids.length > 1 || (question.question.match(/<gstack-qid/gi)?.length ?? 0) !== ids.length) return null;
    const offerText = question.question.replace(/<gstack-qid:[a-z0-9-]+>/gi, '').trim();
    const fp: AskUserQuestionFingerprint = { signature: '', observedAtMs: 0, preReview: true,
      promptSnippet: `${question.header} ${question.question}`,
      options: question.options.map((option, index) => ({ index: index + 1, label: option.label })) };
    const routing = routingSetupActions(fp, true);
    // A packet must contain only setup. Scope the entire question, including
    // any premise, rather than borrowing the first question mark's identity
    // while a later sentence asks for an unrelated approval.
    const routingOffer = /^(?:gstack\s+works\s+best\s+when\s+(?:your|this|the)\s+project['’]s\s+CLAUDE\.md\s+includes\s+skill\s+routing\s+rules\.\s*)?(?:(?:Should|Can)\s+(?:I|gstack)\s+|Would\s+you\s+like\s+(?:me|gstack)\s+to\s+)?Add\s+(?:(?:gstack\s+)?skill\s+routing\s+rules\s+to\s+(?:this\s+project['’]s\s+)?CLAUDE\.md|(?:skill\s+)?routing\s+rules(?:\s+to\s+CLAUDE\.md)?|them)(?:\s+now)?\?$/i.test(offerText);
    if (routingOffer && routing?.add.length === 1 && routing.decline.length === 1 && routing.add[0]!.index !== routing.decline[0]!.index) {
      return { kind: 'routing', pick: routing.add[0]!.index };
    }
    const prerequisite = planCountPrerequisitePick(fp);
    const run = question.options.filter(option => /^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(option.label));
    // Require an actual prerequisite offer, not a product question that
    // happens to mention the absence of an office-hours design document.
    const offer = /^No\s+design\s+doc\s+(?:found|exists)(?:\s+for\s+(?:this|the)\s+(?:branch|project))?\.\s*(?:\/office-hours\s+(?:produces|creates|provides)\s+(?:a\s+)?(?:structured\s+)?(?:design\s+doc(?:ument)?|problem\s+statement)(?:,?\s+(?:and\s+)?(?:premise\s+challenge|(?:explored\s+)?alternatives))*(?:\s*[—–-]\s*(?:sharper|better)\s+input\s+for\s+(?:the|this)\s+review)?\.\s*)?(?:Want\s+to\s+|Would\s+you\s+like\s+to\s+)?Run\s+(?:it|\/office-hours)\s+(?:now|first)(?:\s+or\s+proceed\s+with\s+standard\s+review)?\s*\?$/i.test(offerText);
    return prerequisite !== null && run.length === 1 && offer ? { kind: 'prerequisite', pick: prerequisite }
      : numberedPacketSetup(question, pending) ?? contextualPacketSetup(question, pending);
  });
  if (policies.some(policy => !policy) || new Set(policies.map(policy => policy!.kind)).size !== 2) return waiting;

  const text = visible.replace(/\r+\n?/g, '\n').trimEnd();
  const bars = [...text.matchAll(/^ {0,3}←([^\n]*[☐☒][^\n]*)✔\s*Submit\s*→[\t ]*$/gm)];
  const footer = /Enter[\t ]+to[\t ]+select[\t ]*·[\t ]*Tab\/Arrow[\t ]+keys[\t ]+to[\t ]+navigate[\t ]*·[\t ]*Esc[\t ]+to[\t ]+cancel$/i;
  if (bars.length !== 1 || !footer.test(text)) return waiting;
  const bar = bars[0]!;
  const tabs = [...bar[1]!.matchAll(/([☐☒])\s*([^☐☒]+)/g)];
  const compact = (value: string) => value.replace(/\s+/g, '');
  const introduction = text.slice(0, bar.index).split('\n').findLast(line => !/^[\t ─━-]*$/.test(line)) ?? '';
  if (/\b(?:example|sample|quot(?:e[sd]?|ed)|template|source)\b[^\n]*:\s*$/i.test(introduction) ||
      compact(bar[1]!) !== tabs.map(tab => compact(tab[0])).join('') ||
      tabs.length !== pending.questions.length || tabs.some((tab, index) => compact(tab[2]!) !== compact(pending.questions[index]!.header)) ||
      /(?:^|\n)[^\n]*[1-9]\.\s*\[[ ✓✔xX]\]/.test(text)) return waiting;
  // Project only this actual pane's decoration for the existing full-panel
  // validator. The question, labels and native identity remain unchanged.
  const project = (header: string) => (text.slice(0, bar.index) + '☐ ' + header +
    text.slice(bar.index + bar[0].length).replace(footer, 'Enter to select · ↑/↓ to navigate · Esc to cancel'))
    .replace(/(^|\n)[\t ]*[│┃][\t ]?/g, '$1');
  if (!activeSetupPanel(project('Setup packet'))) return waiting;
  const packetKey = 'autoplan-setup-packet:' + JSON.stringify({sessionId:pending.sessionId,toolUseId:pending.toolUseId,questions:pending.questions});
  const choiceKey = (index: number) => `${packetKey}:choice:${index}:${policies[index]!.pick}`;
  const submitKey = packetKey + ':submit';
  if (planCountSubmissionInput(text) === '\r') {
    // Checked tabs are corroboration. Only choices this caller actually
    // sent for this same native packet can authorize its final submission.
    const options = parseNumberedOptions(text);
    if (!/Ready\s+to\s+submit\s+your\s+answers\?\s*❯\s*1\./.test(text) ||
        options.length !== 2 || options[0]?.index !== 1 || options[0]?.label !== 'Submit answers' ||
        options[1]?.index !== 2 || options[1]?.label !== 'Cancel' || seen.has(submitKey) ||
        tabs.some((tab, index) => tab[1] !== '☒' || !seen.has(choiceKey(index)))) return waiting;
    return { kind: 'input', input: '\r', signatures: [submitKey] };
  }

  const captured = new Set(seen);
  const fp = capturePlanCountQuestion(text, captured, 0, true, pending);
  const index = fp?.nativeQuestionIndex;
  if (!fp || fp.nativeCall !== pending || index === undefined || tabs[index]?.[1] !== '☐' || seen.has(choiceKey(index))) return waiting;
  const question = pending.questions[index]!;
  if (!completeSetupOptions(project(question.header), { ...pending, questions: [question] })) return waiting;
  return { kind: 'input', input: planCountQuestionInput(text, fp, policies[index]!.pick),
    signatures: [...captured].filter(signature => !seen.has(signature)).concat(choiceKey(index)) };
}

/** Pure classification: only the caller that sends input commits returned identities. */
export function autoplanSetupDecision(visible: string, seen: ReadonlySet<string>, pending?: NativePlanQuestionCall): AutoplanSetupDecision {
  if (pending && (pending.answered || pending.failed || !pending.questions.length || pending.questions.some(question => question.multiSelect))) return { kind: 'waiting' };
  if (pending && pending.questions.length > 1) return setupPacketDecision(visible, seen, pending);
  // A visible packet without its complete native metadata cannot prove that
  // its other tabs are setup. Wait for persistence instead of guessing.
  if (/←[^\r\n]*[☐☒][^\r\n]*✔\s*Submit\s*→|Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate/.test(visible)) return { kind: 'waiting' };
  // Box borders are terminal decoration, not part of an untagged native
  // question's wrapped text. Keep its full content for identity matching.
  const display = visible.replace(/(^|[\r\n])[\t ]*[│┃][\t ]?/g, '$1');
  // A rejected/mismatched menu has received no input. Keep its identities
  // available when the actual native call arrives after the visible prompt.
  const captured = new Set(seen);
  const question = capturePlanCountQuestion(display, captured, 0, true, pending);
  if (!question) return { kind: 'waiting' };
  // Recover only a still-visible direct routing title from this complete
  // boxed native panel. A present native call keeps its existing binding.
  const clippedTitle = !pending ? clippedRoutingTitle(visible, question) : null;
  if (clippedTitle) question.promptSnippet = clippedTitle;
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
  const temporarySkipPanel = question.options.some(option => /^Skip\s*for\s*now(?:\s*\(Recommended\))?$/i.test(option.label))
    ? completeSetupOptions(display, pending) : null;
  const actions = routingSetupActions(question, temporarySkipPanel?.length === 2);
  if (!actions) return { kind: 'unrelated' };
  // Lettered labels are a new action presentation, not permission to use
  // the older damaged-option fallback. Match the complete original menu.
  if (question.options.some(option => /^[A-Z]\)[\t ]+/i.test(option.label.trim())) &&
      completeSetupOptions(display, pending)?.length !== 2) return { kind: 'waiting' };
  const { add, decline } = actions;
  if (pending && (!question.nativeCall || pending.questions.length !== 1 || pending.questions[0]?.multiSelect)) return { kind: 'waiting' };
  // An intact Add-to-CLAUDE.md action identifies this setup offer even if
  // its opposed decline is unsupported. A qid or premise alone must not
  // turn substantive/ambiguous choices into an early setup failure.
  if (add.length !== 1) return { kind: 'waiting' };
  if (decline.length !== 1 || add[0]!.index === decline[0]!.index) return unsupportedSetup(display, question, 'routing', pending);
  // Newly admitted shorthand still needs the complete two-choice setup
  // panel; a qid alone cannot lend it stale or mismatched native metadata.
  if (/manualskills/i.test(decline[0]!.title) && completeSetupOptions(display, pending)?.length !== 2) return { kind: 'waiting' };
  // The verified clipped panel has the same native numeric shortcut. Do
  // not queue Enter behind it when the single-select header is offscreen.
  return answered(clippedTitle ? String(add[0]!.index) : planCountQuestionInput(display, question, add[0]!.index));
}

/** Compatibility wrapper: preserve the existing input-only API. */
export function autoplanRoutingSetupInput(visible: string, seen: Set<string>, pending?: NativePlanQuestionCall): string | null {
  const decision = autoplanSetupDecision(visible, seen, pending);
  if (decision.kind !== 'input') return null;
  for (const signature of decision.signatures) seen.add(signature);
  return decision.input;
}

/** Identify a remaining native human wait. The caller must treat it as failure, never phase credit. */
export function autoplanBlockingQuestionBoundary(visible: string, context: {
  commandStartedAt: number; viewportCapturedAt: number;
  /** Both projections must come from the same owned readPlanCountTranscript poll. */
  transcript: PlanCountTranscript; publicTools: NativePublicToolEvent[];
  /** Only the current return from the owned, post-command readPendingQuestion. */
  pending?: ReturnType<typeof readPendingQuestion>;
}): { sessionId: string; toolUseId: string; source: 'native' | 'pre_tool_use' } | null {
  const {transcript, commandStartedAt, viewportCapturedAt, publicTools} = context;
  if (transcript.status !== 'ready' || !Number.isFinite(commandStartedAt) ||
      !Number.isFinite(viewportCapturedAt) || commandStartedAt < 0 || viewportCapturedAt < commandStartedAt) return null;
  const sessions = new Set([...transcript.calls.map(call => call.sessionId),
    ...transcript.assistantMessages.map(message => message.sessionId)]);
  if (sessions.size !== 1 || ![...sessions][0]) return null;
  const unanswered = transcript.calls.filter(call => !call.answered && !call.failed);
  if (unanswered.length > 1) return null;
  const call = unanswered[0] ?? context.pending;
  if (!call || !sessions.has(call.sessionId) || !call.toolUseId || call.answered !== false ||
      call.failed !== false || call.questions.length !== 1 || call.questions[0]!.multiSelect) return null;
  const identity = (questions: unknown): string | null => Array.isArray(questions) && questions.every(q =>
    q && typeof q.header === 'string' && typeof q.question === 'string' && Array.isArray(q.options) &&
    q.options.every((o: any) => o && typeof o.label === 'string' &&
      (o.description === undefined || typeof o.description === 'string')))
    ? JSON.stringify(questions.map(q => [q.header,q.question,q.multiSelect ?? false,
        q.options.map((o: any) => [o.label,o.description ?? ''])])) : null;
  if (identity(call.questions) === null) return null;
  const uses = publicTools.filter(event => event.sessionId === call.sessionId && event.toolUseId === call.toolUseId && event.kind === 'use');
  if (publicTools.some(event => event.sessionId === call.sessionId && event.toolUseId === call.toolUseId && event.kind === 'result')) return null;
  let source: 'native' | 'pre_tool_use';
  if (unanswered.length) {
    const use = uses[0], at = Date.parse(use?.timestamp ?? '');
    if (uses.length !== 1 || use?.name !== 'AskUserQuestion' || !Number.isFinite(at) ||
        at < commandStartedAt || at > viewportCapturedAt || !Array.isArray(use.input?.questions) ||
        identity(use.input.questions as NativePlanQuestion[]) !== identity(call.questions)) return null;
    source = 'native';
  } else {
    // The reader has already checked cwd/config, parent session, timestamp,
    // recorder poison/lock state and absence of a published result or call.
    if (context.pending?.source !== 'pre_tool_use' || uses.length ||
        transcript.calls.some(row => row.sessionId === call.sessionId && row.toolUseId === call.toolUseId)) return null;
    source = 'pre_tool_use';
  }
  const display = visible.replace(/(^|[\r\n])[\t ]*[│┃][\t ]?/g, '$1');
  const headerAt = display.search(/^ {0,3}[☐□]/m);
  if (headerAt < 0 || /^(?:Source|Example|Quoted|Historical|Template)\b[^\n]*:/im.test(display.slice(0, headerAt)) ||
      !completeSetupOptions(display, call)) return null;
  return {sessionId:call.sessionId,toolUseId:call.toolUseId,source};
}
