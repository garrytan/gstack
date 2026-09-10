/** Match CEO mode labels after the PTY capture strips cursor-spacing escapes. */
import {
  capturePlanCountQuestion,
  createPlanCountPermissionGuard,
  parseQuestionPrompt,
  parseNumberedOptions,
  auqFingerprint,
  classifyPlanCountFrame,
  isNumberedOptionListVisible,
  matchesNativePlanQuestion,
  planCountSubmissionInput,
  planCountPrerequisitePick,
  type AskUserQuestionFingerprint,
} from './claude-pty-runner';
import type { NativePlanQuestionCall, NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

type CeoMode = 'HOLD SCOPE' | 'SCOPE EXPANSION' | 'SELECTIVE EXPANSION' | 'SCOPE REDUCTION';

function modeTitle(label: string): string | undefined {
  const title = label.split(/[│┌\r\n]/, 1)[0]!.trim().replace(/^[A-Z][).]\s*/i, '').replace(/\s+/g, '').toUpperCase();
  return /^(HOLDSCOPE|SCOPEEXPANSION|SELECTIVEEXPANSION|SCOPEREDUCTION)(?:$|[^A-Z])/.exec(title)?.[1];
}

export function findCeoModeOption(
  options: ReadonlyArray<{ index: number; label: string }>,
  targetMode: CeoMode,
): number | null {
  const modes = options.map(option => {
    // The CLI renders a description pane beside the options. Its text may
    // mention a different mode, so match only the leading option title.
    return { index: option.index, mode: modeTitle(option.label) };
  });
  if (!modes.some(option => option.mode)) return null;
  const recognized = modes.map(option => option.mode).filter(Boolean);
  if (new Set(recognized).size !== recognized.length) {
    throw new Error('Mode AskUserQuestion has duplicate mode choices');
  }

  const target = modes.find(option => option.mode === targetMode.replace(/\s+/g, ''));
  if (!target) {
    throw new Error(
      `Mode AskUserQuestion rendered but target "${targetMode}" not in option labels:\n` +
      options.map(option => `  ${option.index}. ${option.label}`).join('\n'),
    );
  }
  return target.index;
}

type ModeNavigationAction =
  | { kind: 'wait' }
  | { kind: 'permission' | 'submission'; input: string }
  | { kind: 'question'; index: number; question: AskUserQuestionFingerprint }
  | { kind: 'mode'; index: number; question: AskUserQuestionFingerprint };

// Permission state follows the navigation session without entering its AUQ
// dedup set. A file-tool result can reopen an identical permission prompt.
const permissionStates = new WeakMap<Set<string>, {
  file: ReturnType<typeof createPlanCountPermissionGuard>;
  other: Set<string>;
}>();
function ceoPermissionAction(visible: string, seenQuestions: Set<string>, completionHistory = visible): 'grant' | 'handled' | null {
  let state = permissionStates.get(seenQuestions);
  if (!state) {
    state = { file: createPlanCountPermissionGuard(), other: new Set() };
    permissionStates.set(seenQuestions, state);
  }
  const file = state.file(visible, completionHistory);
  if (file !== null) return file;
  if (classifyPlanCountFrame(visible) !== 'permission') return null;
  const signature = auqFingerprint(parseQuestionPrompt(visible), parseNumberedOptions(visible));
  if (state.other.has(signature)) return 'handled';
  state.other.add(signature);
  return 'grant';
}

/** Handle native controls before deduping actual navigation questions. */
export function nextCeoModeNavigation(
  visible: string,
  targetMode: CeoMode,
  seenQuestions: Set<string>,
  pending?: NativePlanQuestionCall,
  completionHistory = visible,
): ModeNavigationAction {
  const permission = pending && matchesNativePlanQuestion(visible, pending) ? null : ceoPermissionAction(visible, seenQuestions, completionHistory);
  if (permission !== null) return permission === 'grant'
    ? { kind: 'permission', input: '1\r' } : { kind: 'wait' };
  const frame = classifyPlanCountFrame(visible);
  const submission = frame === null ? planCountSubmissionInput(visible) : null;
  if (submission !== null) return { kind: 'submission', input: submission };
  if (!isNumberedOptionListVisible(visible)) return { kind: 'wait' };
  const question = capturePlanCountQuestion(visible, seenQuestions, 0, true, pending);
  if (!question) return { kind: 'wait' };
  const index = findCeoModeOption(question.options, targetMode);
  // Preserve the seeded review plan by declining the existing optional
  // office-hours offer. Other navigation questions keep their first choice.
  return index === null
    ? { kind: 'question', index: planCountPrerequisitePick(question) ?? 1, question }
    : { kind: 'mode', index, question };
}

/** Match new assistant prose, never the native mode menu or answer echo. */
export function hasPostAnswerCeoPosture(visible: string, posture: RegExp): boolean {
  let assistant: string[] | null = null;
  const matches = () => {
    if (!assistant?.length) return false;
    const compact = assistant.join('').replace(/\s+/g, '');
    // Tool headings use the same bullet as assistant messages. Their output
    // can quote the selected mode or the skill's posture instructions. Keep
    // word boundaries when detecting a call: ordinary prose can contain parentheses.
    if (/^(?:UseransweredClaude['’]squestions|(?:high|medium|low)·\/effort)/i.test(compact) ||
        /^[A-Za-z][\w.:_-]*[ \t]*\(/.test(assistant[0]!.trim())) return false;
    // A bare selected title gains no evidentiary value when the next terminal
    // update appends a spinner or other chrome to the same captured block.
    const prose = assistant.filter(line =>
      !/^(?:(?:You)?selected(?:option|mode)?[:：]?)?(?:HOLDSCOPE|SCOPEEXPANSION|SELECTIVEEXPANSION|SCOPEREDUCTION)(?:\(recommended\))?\.?$/i.test(line.replace(/\s+/g, '')) &&
      !/^[✶✻✽✢·]/.test(line),
    ).join('\n');
    return prose.search(posture) !== -1;
  };

  for (const line of visible.replace(/\r\n?/g, '\n').split('\n')) {
    const text = line.trim();
    const message = /^[●⏺]\s*(.*)$/.exec(text);
    if (message) {
      if (matches()) return true;
      assistant = message[1] ? [message[1]] : [];
    } else if (/^(?:[☐☒❯⎿│┌└─⏸]|←|\d+[.)]\s*|Enter\s*to\s*select)/i.test(text)) {
      if (matches()) return true;
      assistant = null;
    } else if (assistant && text) {
      assistant.push(text);
    }
  }
  return matches();
}

/** Apply the same echo/quotation exclusions to native prose and decision rationale. */
function hasNativePostureProse(text: string, posture: RegExp): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => {
    if (/^\s*>/.test(line)) return false;
    const plain = line.replace(/[*_`]/g, '').trim().replace(/^#+\s*/, '');
    // A repeated menu or bare confirmation is still only an answer echo.
    if (/^(?:[-+]|\d+[.)]|[A-D][.)])\s*(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(plain)) return false;
    return !/^(?:(?:You\s+)?selected(?:\s+(?:option|mode))?\s*[:：]?\s*)?(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)(?:\s+mode)?(?:\s+confirmed)?(?:\s*\(recommended\))?[.!]?$/i.test(plain);
  }).join('\n');
  return hasPostAnswerCeoPosture(`● ${prose}`, posture);
}

/** Current scope lock + exclusion + hardening can apply HOLD without naming it. */
function hasCurrentHoldScopePosture(text: string, selected: NativePlanQuestionCall): boolean {
  const plain = text.replace(/\*\*/g, '').replace(/’/g, "'").trim();
  // Require the declaration itself, not a quote, promise, example or comparison.
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? '';
  if (/\b(?:not|never|won't|can't|don't|isn't|aren't|if|unless|until|may|might|could|would|will|later|example|hypothetical)\b/i.test(sentence)) return false;
  const declaration = /^(?:I'm|I am|We're|We are) (?:locking|keeping|holding) (?:the )?scope (?:to|at) ([^,\n]+),\s*(?:flagging|treating|marking) (?:anything|everything) (?:beyond|outside) that(?: \([^()\n]+\))? as out of scope,? and (?:hunting|checking|looking) for (?:silent )?(?:failure modes|errors|edge cases)\b([^.!?\n]*)\.$/i.exec(sentence);
  if (!declaration) return false;
  // A later current correction can withdraw the declaration. Quoted examples
  // cannot; the opening declaration was matched before removing quoted blocks.
  const currentProse = plain.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  if (/\b(?:expand\w*|widen\w*|reduc(?:e|ing)|shrink\w*)\s+(?:the\s+)?scope\b/i.test(currentProse) ||
      /\b(?:add|adding)\b[^.!?\n]*\b(?:to|into)\s+(?:the\s+)?scope\b/i.test(currentProse) ||
      /\b(?:no longer|not)\s+(?:locking|keeping|holding)\s+(?:the\s+)?scope\b/i.test(currentProse) ||
      /\b(?:previously|formerly) excluded\b[^.!?\n]*\b(?:now )?in scope\b/i.test(currentProse)) return false;
  const context = selected.questions.map(q => /^Project\/branch\/task:([^\n]*)/im.exec(q.question)?.[1] ?? '').join(' ');
  const plans = new Set(context.match(/\b[\w./-]+\.md\b/gi) ?? []);
  const baseline = declaration[1]!.trim();
  const namedPlan = /^(?:the )?(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) )?([\w./-]+\.md) (?:bullets|requirements|scope)(?: from approach [A-Z])?$/i.exec(baseline);
  if (namedPlan ? plans.size !== 1 || !plans.has(namedPlan[1]!)
    : !/^the (?:current|agreed|approved|existing) (?:plan|scope)$/i.test(baseline)) return false;
  // Concrete failure surfaces distinguish review rigor from merely retaining scope.
  const hardening = declaration[2]!;
  return [/\bconstraints\b/i, /\berror handling\b/i, /\bedge cases\b/i,
    /\baccess(?:-rule)? leaks\b/i, /\bsecurity\b/i, /\btest(?:ing|s)\b/i]
    .filter(surface => surface.test(hardening)).length >= 2;
}

/** A native successful answer, not the key we intended to send to the menu. */
export function nativeCeoModeAnswer(
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  selectionStartedAt: number,
): NativePlanQuestionCall | null {
  if (transcript.status !== 'ready') return null;
  const choices = transcript.calls.flatMap(call => {
    const at = Date.parse(call.answeredAt ?? '');
    if (!call.answered || call.failed || !Number.isFinite(at) || at < selectionStartedAt) return [];
    return call.questions.flatMap(question => {
      const recognized = question.options.map(option => modeTitle(option.label)).filter(Boolean);
      const modes = new Set(recognized);
      if (modes.size !== recognized.length) return [{ call, at, mode: undefined }];
      const answer = call.answers?.[question.question];
      return modes.size >= 2 && typeof answer === 'string'
        ? [{ call, at, mode: modeTitle(answer) }] : [];
    });
  }).sort((a, b) => b.at - a.at);
  const latest = choices[0];
  return latest?.mode === targetMode.replace(/\s+/g, '') ? latest.call : null;
}

/** An answered AUQ must have one matching native request and successful reply. */
function completedQuestionTimes(call: NativePlanQuestionCall, events: ReadonlyArray<NativePublicToolEvent>) {
  if (!call.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length) return null;
  const own = events.filter(event => event.sessionId === call.sessionId && event.toolUseId === call.toolUseId);
  const requests = own.filter(event => event.kind === 'use');
  const replies = own.filter(event => event.kind === 'result');
  if (requests.length !== 1 || replies.length !== 1) return null;
  const request = requests[0]!;
  const reply = replies[0]!;
  const requestedAt = Date.parse(request.timestamp);
  const answeredAt = Date.parse(reply.timestamp);
  if (request.name !== 'AskUserQuestion' || reply.isError ||
      JSON.stringify(request.input?.questions) !== JSON.stringify(call.questions) ||
      reply.timestamp !== call.answeredAt || !Number.isFinite(requestedAt) ||
      !Number.isFinite(answeredAt) || requestedAt >= answeredAt) return null;
  return { requestedAt, answeredAt };
}

/** New shorthand forms must be one complete decision, not a mode mention or extra question. */
function singleScopeBrief(text: string, descriptions: readonly string[], comparison = true): boolean {
  if ([text, ...descriptions].some(value => /(?:^|[.!?]\s+|\n)\s*(?:Also|Separately|Additionally)\b|\b(?:Please|We must|You must|The plan must)\b/i.test(value))) return false;
  // Query parameter names such as ?view= are not another decision prompt.
  const questions = text.replace(/\?[A-Za-z_][\w-]*=/g, '=').match(/\?/g);
  if (questions?.length !== 1 || /```|~~~|^\s*>/m.test(text)) return false;
  const markers = [/Project\/branch\/task:/gi, /ELI10:/gi, /Stakes if (?:we pick )?wrong:/gi,
    /Recommendation:/gi, /Completeness:/gi, /Net:/gi];
  let previous = -1;
  const complete = markers.every(marker => {
    const matches = [...text.matchAll(marker)];
    if (matches.length !== 1 || matches[0]!.index! <= previous) return false;
    previous = matches[0]!.index!;
    return true;
  });
  // Net closes this decision brief. A following instruction is not part of its
  // comparison; this is not a general classifier of instructions inside prose.
  const net = text.slice(previous + 'Net:'.length).trim();
  return complete && (comparison ? /^[^.!?;\n]+ (?:vs|versus) [^.!?;\n]+\.$/.test(net)
    : /^[^.!?;\n]+\.$/.test(net.replace(/\bvs\./gi, 'vs')));
}

/** HOLD can apply its boundary in a completed defer decision, before standalone prose. */
function hasAnsweredHoldPosture(transcript: PlanCountTranscript, selected: NativePlanQuestionCall,
  posture: RegExp, events: ReadonlyArray<NativePublicToolEvent>): boolean {
  const modeTimes = completedQuestionTimes(selected, events);
  if (!modeTimes) return false;
  return transcript.calls.some(call => {
    if (call === selected || call.sessionId !== selected.sessionId || call.questions.length !== 1) return false;
    const times = completedQuestionTimes(call, events);
    if (!times || times.requestedAt <= modeTimes.answeredAt) return false;
    const q = call.questions[0]!;
    // A substantive review decision can apply HOLD in its rationale before
    // standalone prose is published. Metadata and answer echoes do not count.
    // This recognizes posture language; it does not validate every scope choice.
    const context = /Project\/branch\/task:([\s\S]*?)(?=ELI10:)/i.exec(q.question)?.[1] ?? '';
    const rationale = /ELI10:([\s\S]*?)(?=Stakes if (?:we pick )?wrong:)/i.exec(q.question)?.[1]?.trim() ?? '';
    const offered = q.options.map(o => o.label.trim());
    if (!q.multiSelect && q.options.length >= 2 && q.options.length <= 4 && new Set(offered).size === offered.length &&
        offered.includes(call.answers?.[q.question] ?? '') && /\bHOLD SCOPE\b/i.test(context) &&
        !/\b(?:SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(context) &&
        singleScopeBrief(q.question, q.options.map(o => o.description ?? ''), false) &&
        hasNativePostureProse(rationale, posture)) return true;
    if (q.multiSelect || q.options.length !== 3 || !singleScopeBrief(q.question, q.options.map(o => o.description ?? ''))) return false;
    const title = /^D\d+\s*[—–-]\s*Under HOLD SCOPE, keep or defer the (\w+)\b([\s\S]+?)\?\s+Project\/branch\/task:/i.exec(q.question);
    if (!title || !/\bnot in the plan text\b/i.test(title[2]!) ||
        !/\bwritten scope is the baseline\b/i.test(q.question) ||
        !/\bpure additions,\s*not repairs to meet a stated invariant\b/i.test(q.question)) return false;
    const labels = q.options.map(o => o.label.trim().replace(/^[A-C][):.]\s*/i, '')
      .replace(/\s*\(recommended\)\s*$/i, '').toLowerCase());
    const count = title[1]!.toLowerCase();
    const defer = labels.findIndex(label => label === `defer all ${count} to todos` || label === `defer all ${count} to todos.md`);
    const subset = labels.find(label => /^keep .+ only$/.test(label));
    if (new Set(labels).size !== 3 || defer < 0 || !labels.includes(`keep all ${count}`) ||
        !subset || !title[2]!.toLowerCase().includes(subset.slice(5, -5)) ||
        call.answers?.[q.question] !== q.options[defer]!.label) return false;
    return hasPostAnswerCeoPosture(`● ${q.question}`, posture);
  });
}

/** A concrete, opted-in expansion brief is itself assistant posture evidence. */
function hasAnsweredExpansionPosture(
  transcript: PlanCountTranscript, selected: NativePlanQuestionCall,
  posture: RegExp, events: ReadonlyArray<NativePublicToolEvent>,
): boolean {
  const modeTimes = completedQuestionTimes(selected, events);
  if (!modeTimes) return false;
  return transcript.calls.some(call => {
    if (call === selected || call.sessionId !== selected.sessionId || call.questions.length !== 1) return false;
    const times = completedQuestionTimes(call, events);
    if (!times || times.requestedAt <= modeTimes.answeredAt) return false;
    const question = call.questions[0]!;
    // This is evidence that the selected mode produced a concrete scope
    // decision, not authority to answer it. Numbering and heading names vary.
    const title = question.question.split('\n')[0]!
      .replace(/\s*<gstack-qid:[a-z0-9-]+>\s*$/i, '').replace(/^D\d+\s*[—–-]\s*/i, '');
    const context = /\nProject\/branch\/task:([^\n]+)/i.exec(question.question)?.[1] ?? '';
    if (question.multiSelect || question.options.length !== 3 ||
        !/^[\p{L}\p{N}][^?\n]+\?$/u.test(title) ||
        /\b(?:review\s+(?:mode|posture)|(?:selected|confirmed)\s+(?:mode|option))\b/i.test(title) ||
        /\b(?:HOLD SCOPE|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(context) ||
        !/\b(?:SCOPE\s+EXPANSION|EXPANSION\s+(?:mode|opt[ -]in))\b/i.test(context) ||
        !singleScopeBrief(question.question, question.options.map(o => o.description ?? ''), false)) return false;
    const labels = question.options.map(option => option.label.trim()
      .replace(/^[A-C][):.]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '').toLowerCase()
      .replace(/^add to (?:(?:this|the) plan['’]s )?scope$/, 'add to scope'));
    if (new Set(labels).size !== 3 || !['add to scope', 'defer to todos.md', 'skip'].every(label => labels.includes(label)) ||
        !question.options.some(option => option.label === call.answers?.[question.question])) return false;
    // Never search quoted instructions, tool output or a menu for posture.
    const prose = question.question.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^\s*>.*$/gm, '');
    return hasPostAnswerCeoPosture(`● ${prose}`, posture);
  });
}

/** Match finalized prose or a completed concrete scope decision after the actual mode answer. */
export function hasNativePostAnswerCeoPosture(
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  posture: RegExp,
  selectionStartedAt: number,
  publicTools: ReadonlyArray<NativePublicToolEvent> = [],
): boolean {
  const selected = nativeCeoModeAnswer(transcript, targetMode, selectionStartedAt);
  if (!selected) return false;
  const answeredAt = Date.parse(selected.answeredAt!);
  return transcript.assistantMessages.some(message => {
    if (message.sessionId !== selected.sessionId || Date.parse(message.timestamp) <= answeredAt) return false;
    return hasNativePostureProse(message.text, posture) ||
      (targetMode === 'HOLD SCOPE' && Number.isFinite(Date.parse(message.timestamp)) &&
        Date.parse(message.timestamp) <= Date.now() &&
        hasCurrentHoldScopePosture(message.text, selected));
  }) || (targetMode === 'SCOPE EXPANSION' && hasAnsweredExpansionPosture(transcript, selected, posture, publicTools)) ||
    (targetMode === 'HOLD SCOPE' && hasAnsweredHoldPosture(transcript, selected, posture, publicTools));
}

type PosturePacket = { headers: string[]; screens: string[]; next: number; nativeId?: string; submitted: boolean };
const postureContinuations = new WeakMap<Set<string>, { modeId: string; packet?: PosturePacket }>();

/** The complete native bar binds delayed-JSONL tabs to one bounded AUQ. */
function posturePacketBar(visible: string): { headers: string[]; answered: boolean[] } | null {
  const bars = [...visible.matchAll(/←([^\r\n]+)✔\s*Submit\s*→/g)];
  const bar = bars.at(-1);
  if (!bar) return null;
  const tabs = [...bar[1]!.matchAll(/([☐☒])\s*([^☐☒]+)/g)];
  if (tabs.length < 2 || tabs.length > 4 || bar[1]!.slice(0, tabs[0]!.index).trim()) return null;
  const headers = tabs.map(tab => tab[2]!.trim().replace(/\s+/g, ' '));
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) return null;
  return { headers, answered: tabs.map(tab => tab[1] === '☒') };
}

const BARLESS_SUBMIT_END = 'Readytosubmityouranswers?❯1.Submitanswers2.Cancel';

/** The barless review must reproduce every observed question and chosen option. */
function barlessPostureSubmit(visible: string, packet: PosturePacket): boolean {
  if (packet.next !== packet.headers.length || packet.screens.length !== packet.next) return false;
  const compact = (text: string) => text.replace(/^[\t │┃]*[●⏺][\t ]*/gm, '')
    .replace(/[│┃\s]/g, '');
  let prefix = '';
  const answers: string[] = [];
  for (const screen of packet.screens) {
    const bar = [...screen.matchAll(/←[^\r\n]+✔\s*Submit\s*→/g)].at(-1);
    const cursor = [...screen.matchAll(/❯\s*1\./g)].at(-1);
    const choice = parseNumberedOptions(screen).find(option => option.index === 1)?.label;
    if (!bar || !cursor || !choice || cursor.index! <= bar.index! + bar[0].length) return false;
    const question = compact(screen.slice(bar.index! + bar[0].length, cursor.index));
    if (!question || /[←☐☒❯]/.test(question)) return false;
    // The caller answers option 1 for each of this one bounded call's tabs.
    answers.push(`${question}→${compact(choice)}`);
    prefix = compact(screen.slice(0, bar.index));
  }
  const panel = compact(visible);
  if (!panel.startsWith(prefix)) return false;
  const body = panel.slice(prefix.length).replace(/^Reviewyouranswers/, '');
  return body === answers.join('') + BARLESS_SUBMIT_END;
}

/**
 * Claude can defer persisting assistant prose until the next AUQ resolves.
 * Permit one fresh downstream call, including its remaining tabs and Submit.
 * Native completion still supplies all posture evidence; UI only drives input.
 */
export function nextCeoPostureContinuation(
  visible: string,
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  selectionStartedAt: number,
  seenQuestions: Set<string>,
  alreadyContinued: boolean,
  completionHistory = visible,
  pendingQuestion?: NativePlanQuestionCall & {source:'pre_tool_use'},
): 'permission' | 'question' | 'submission' | null {
  const supplied = pendingQuestion?.source === 'pre_tool_use' && !pendingQuestion.answered && !pendingQuestion.failed &&
    !transcript.calls.some(call => call.sessionId === pendingQuestion.sessionId && call.toolUseId === pendingQuestion.toolUseId)
    ? pendingQuestion : undefined;
  const pending = transcript.calls.find(call => !call.answered && !call.failed) ?? supplied;
  const permission = pending && matchesNativePlanQuestion(visible, pending) ? null : ceoPermissionAction(visible, seenQuestions, completionHistory);
  if (permission !== null) return permission === 'grant' ? 'permission' : null;
  const selected = nativeCeoModeAnswer(transcript, targetMode, selectionStartedAt);
  if (!selected) return null;
  if (pending && pending.sessionId !== selected.sessionId) return null;
  const modeId = `${selected.sessionId}:${selected.toolUseId}`;
  const state = postureContinuations.get(seenQuestions);
  if (state && state.modeId !== modeId) return null;
  const bar = posturePacketBar(visible);
  const packet = state?.packet;
  if (state || alreadyContinued) {
    if (!packet || packet.submitted) return null;
    const barless = !bar && barlessPostureSubmit(visible, packet);
    if (!barless && (!bar || JSON.stringify(bar.headers) !== JSON.stringify(packet.headers) ||
        !bar.answered.every((answered, i) => answered === (i < packet.next)))) return null;
    const sameHeaders = (call: NativePlanQuestionCall) => JSON.stringify(call.questions.map(q =>
      q.header.trim().replace(/\s+/g, ' '))) === JSON.stringify(packet.headers);
    const recorded = transcript.calls.slice(transcript.calls.indexOf(selected) + 1).find(sameHeaders);
    const call = packet.nativeId
      ? transcript.calls.find(call => `${call.sessionId}:${call.toolUseId}` === packet.nativeId) ??
        (pending && `${pending.sessionId}:${pending.toolUseId}` === packet.nativeId ? pending : undefined)
      : pending ?? recorded;
    if (packet.nativeId && !call) return null;
    if (call) {
      if (call.sessionId !== selected.sessionId || call.answered || call.failed ||
          !sameHeaders(call) || (pending && pending !== call) ||
          !packet.screens.every((screen, i) => capturePlanCountQuestion(
            screen, new Set(), 0, false, call)?.nativeQuestionIndex === i)) return null;
      packet.nativeId = `${call.sessionId}:${call.toolUseId}`;
    }
    if (packet.next === packet.headers.length) {
      if (!barless && planCountSubmissionInput(visible) !== '\r') return null;
      packet.submitted = true;
      return 'submission';
    }
  } else if (bar && bar.answered.some(Boolean)) return null;
  // An unbound Submit panel is never a fresh question to answer with option 1.
  if (!bar && visible.replace(/[│┃\s]/g, '').endsWith(BARLESS_SUBMIT_END)) return null;
  // With native metadata present, require the same call and exact displayed
  // tab. Without it, the complete bar, footer and ordered answered transitions
  // are required; another menu cannot spend this call's remaining tab budget.
  if (bar) {
    if (!/Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel/i.test(visible)) return null;
    if (pending && (pending.sessionId !== selected.sessionId ||
        !matchesNativePlanQuestion(visible, pending) ||
        JSON.stringify(pending.questions.map(q => q.header.trim().replace(/\s+/g, ' '))) !== JSON.stringify(bar.headers))) return null;
  }
  const action = nextCeoModeNavigation(visible, targetMode, seenQuestions, pending, completionHistory);
  if (action.kind !== 'question') return null;
  if (bar) {
    const current = packet ?? { headers: bar.headers, screens: [], next: 0, submitted: false };
    if (action.question.nativeCall) {
      const nativeId = `${action.question.nativeCall.sessionId}:${action.question.nativeCall.toolUseId}`;
      if ((current.nativeId && current.nativeId !== nativeId) || action.question.nativeQuestionIndex !== current.next) return null;
      current.nativeId = nativeId;
    }
    current.screens.push(visible);
    current.next++;
    postureContinuations.set(seenQuestions, { modeId, packet: current });
  } else postureContinuations.set(seenQuestions, { modeId });
  return 'question';
}
