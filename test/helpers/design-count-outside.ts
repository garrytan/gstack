import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** Seeded-count fixtures cover native review cadence; outside voices have separate evals. */
export function pickDesignCountOutsideVoices(
  _routing: AskUserQuestionFingerprint,
  active: AskUserQuestionFingerprint,
): number | null {
  const call = active.nativeCall;
  let question: string;
  let labels: string[];
  if (call) {
    if (call.answered || call.failed) return null;
    const index = active.nativeQuestionIndex ?? (call.questions.length === 1 ? 0 : undefined);
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= call.questions.length) return null;
    const identity = `${call.sessionId}:${call.toolUseId}` +
      (call.questions.length > 1 ? `:question:${index}` : '');
    if (active.signature !== identity) return null;
    const q = call.questions[index]!;
    if (q.multiSelect || !/^outside(?: design)? voices$/i.test(q.header.trim()) ||
        !/<gstack-qid:outside-voices-design>/.test(q.question)) return null;
    question = q.question;
    labels = q.options.map(option => option.label);
  } else {
    // Native JSONL can arrive after the answer. The caller supplies the
    // active viewport fingerprint; a known but unmatched packet is blocked
    // before this hook. Require the specific opt-in premise and both actions.
    question = active.promptSnippet;
    const packetBar = /^←[^→]*[☐☒]\s+Outside voices\b[^→]*✔\s*Submit\s*→\s*[│┃]?\s*/i.exec(question);
    if (packetBar) question = question.slice(packetBar[0].length);
    else if (!/^(?:[☐□]\s*)?outside(?: design)? voices\b/i.test(question)) return null;
    labels = active.options.map(option => option.label);
    while (labels.length > 2 && /^(?:Type something\.?|Chat about this)$/i.test(labels.at(-1)!.trim())) labels.pop();
  }
  if (!/\b(?:want|run|include|enable)\b[^?]{0,90}\boutside design voices\b/i.test(question) ||
      !/\b(?:before|for)\s+(?:the\s+)?(?:detailed\s+)?(?:design\s+)?review\b/i.test(question)) return null;
  labels = labels.map(label => label.trim().replace(/\s*\(recommended\)\s*$/i, ''));
  if (labels.length !== 2) return null;
  const yes = labels.map(label => /^Yes,?\s+run outside design voices$/i.test(label));
  const no = labels.map(label => /^No,?\s+proceed without$/i.test(label));
  if (yes.filter(Boolean).length !== 1 || no.filter(Boolean).length !== 1) return null;
  return no.findIndex(Boolean) + 1;
}
