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
import type { NativePlanQuestionCall, PlanCountTranscript } from './plan-count-transcript';

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

/** Match only finalized assistant prose after the actual mode answer. */
export function hasNativePostAnswerCeoPosture(
  transcript: PlanCountTranscript,
  targetMode: CeoMode,
  posture: RegExp,
  selectionStartedAt: number,
): boolean {
  const selected = nativeCeoModeAnswer(transcript, targetMode, selectionStartedAt);
  if (!selected) return false;
  const answeredAt = Date.parse(selected.answeredAt!);
  return transcript.assistantMessages.some(message => {
    if (message.sessionId !== selected.sessionId || Date.parse(message.timestamp) <= answeredAt) return false;
    const prose = message.text.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => {
      if (/^\s*>/.test(line)) return false;
      const plain = line.replace(/[*_`]/g, '').trim().replace(/^#+\s*/, '');
      // A repeated menu or bare confirmation is still only an answer echo.
      if (/^(?:[-+]|\d+[.)]|[A-D][.)])\s*(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)\b/i.test(plain)) return false;
      return !/^(?:(?:You\s+)?selected(?:\s+(?:option|mode))?\s*[:：]?\s*)?(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)(?:\s+mode)?(?:\s+confirmed)?(?:\s*\(recommended\))?[.!]?$/i.test(plain);
    }).join('\n');
    return hasPostAnswerCeoPosture(`● ${prose}`, posture);
  });
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
): 'permission' | 'question' | 'submission' | null {
  const pending = transcript.calls.find(call => !call.answered && !call.failed);
  const permission = pending && matchesNativePlanQuestion(visible, pending) ? null : ceoPermissionAction(visible, seenQuestions, completionHistory);
  if (permission !== null) return permission === 'grant' ? 'permission' : null;
  const selected = nativeCeoModeAnswer(transcript, targetMode, selectionStartedAt);
  if (!selected) return null;
  const modeId = `${selected.sessionId}:${selected.toolUseId}`;
  const state = postureContinuations.get(seenQuestions);
  if (state && state.modeId !== modeId) return null;
  const bar = posturePacketBar(visible);
  const packet = state?.packet;
  if (state || alreadyContinued) {
    if (!packet || packet.submitted || !bar ||
        JSON.stringify(bar.headers) !== JSON.stringify(packet.headers) ||
        !bar.answered.every((answered, i) => answered === (i < packet.next))) return null;
    const sameHeaders = (call: NativePlanQuestionCall) => JSON.stringify(call.questions.map(q =>
      q.header.trim().replace(/\s+/g, ' '))) === JSON.stringify(packet.headers);
    const recorded = transcript.calls.slice(transcript.calls.indexOf(selected) + 1).find(sameHeaders);
    const call = packet.nativeId
      ? transcript.calls.find(call => `${call.sessionId}:${call.toolUseId}` === packet.nativeId)
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
      if (planCountSubmissionInput(visible) !== '\r') return null;
      packet.submitted = true;
      return 'submission';
    }
  } else if (bar && bar.answered.some(Boolean)) return null;
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
