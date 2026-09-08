/** Match CEO mode labels after the PTY capture strips cursor-spacing escapes. */
import {
  capturePlanCountQuestion,
  classifyPlanCountFrame,
  isNumberedOptionListVisible,
  planCountSubmissionInput,
  type AskUserQuestionFingerprint,
} from './claude-pty-runner';

type CeoMode = 'HOLD SCOPE' | 'SCOPE EXPANSION' | 'SELECTIVE EXPANSION' | 'SCOPE REDUCTION';

export function findCeoModeOption(
  options: ReadonlyArray<{ index: number; label: string }>,
  targetMode: CeoMode,
): number | null {
  const modes = options.map(option => {
    // The CLI renders a description pane beside the options. Its text may
    // mention a different mode, so match only the leading option title.
    const title = option.label.split(/[│┌\r\n]/, 1)[0]!
      .replace(/\s+/g, '').toUpperCase();
    const mode = /^(HOLDSCOPE|SCOPEEXPANSION|SELECTIVEEXPANSION|SCOPEREDUCTION)(?:$|[^A-Z])/.exec(title)?.[1];
    return { index: option.index, mode };
  });
  if (!modes.some(option => option.mode)) return null;

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
  | { kind: 'question'; question: AskUserQuestionFingerprint }
  | { kind: 'mode'; index: number; question: AskUserQuestionFingerprint };

/** Handle native controls before deduping actual navigation questions. */
export function nextCeoModeNavigation(
  visible: string,
  targetMode: CeoMode,
  seenQuestions: Set<string>,
): ModeNavigationAction {
  const frame = classifyPlanCountFrame(visible);
  if (frame === 'permission') return { kind: 'permission', input: '1\r' };
  const submission = frame === null ? planCountSubmissionInput(visible) : null;
  if (submission !== null) return { kind: 'submission', input: submission };
  if (!isNumberedOptionListVisible(visible)) return { kind: 'wait' };
  const question = capturePlanCountQuestion(visible, seenQuestions, 0, true);
  if (!question) return { kind: 'wait' };
  const index = findCeoModeOption(question.options, targetMode);
  return index === null ? { kind: 'question', question } : { kind: 'mode', index, question };
}

/** Match new assistant prose, never the native mode menu or answer echo. */
export function hasPostAnswerCeoPosture(visible: string, posture: RegExp): boolean {
  let assistant: string[] | null = null;
  const matches = () => {
    if (!assistant?.length) return false;
    const compact = assistant.join('').replace(/\s+/g, '');
    // Tool headings use the same bullet as assistant messages. Their output
    // can quote the selected mode or the skill's posture instructions.
    if (/^(?:UseransweredClaude['’]squestions|[A-Za-z][\w.:_-]*\(|(?:high|medium|low)·\/effort)/i.test(compact)) return false;
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
