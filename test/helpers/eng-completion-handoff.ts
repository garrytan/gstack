import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** Count a completed review-navigation choice separately; never choose pending input. */
export function isEngCompletionHandoff(fp: AskUserQuestionFingerprint, reviewedPlan: string): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      Object.keys(call.answers ?? {}).length !== 1 || !Number.isFinite(Date.parse(call.answeredAt ?? ''))) return false;
  if (isPublishedPrerequisiteHandoff(fp, reviewedPlan)) return true;
  const q = call.questions[0]!;
  if (q.multiSelect || q.header.trim() !== 'Next steps' || q.options.length !== 2 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question]) || /<gstack-qid/i.test(q.question)) return false;
  const body = q.question.trim().replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length !== 4 ||
      !/^Next steps: Eng Review is CLEAR\. This is a backend auth refactor with no UI scope, so \/plan-design-review does not apply\. No CEO review exists, but the plan changes no product direction\. What next\?$/.test(lines[0]!) ||
      !/^Recommendation: [1-9]\d*[A-Z] because the plan is implementation-ready and a CEO review would add little to a pure infrastructure refactor\.$/.test(lines[1]!) ||
      !/^Note: options differ in kind, not coverage [—–-] no completeness score\.$/.test(lines[2]!) ||
      !/^Net: start building now versus one more optional review pass on scope\.$/.test(lines[3]!)) return false;
  const label = (s: string) => s.trim().replace(/^[1-9]\d*[A-Z]\)\s*/, '').replace(/\s*\(recommended\)$/, '');
  const ready = q.options.find(o => /^Ready to implement [—–-] run \/ship when done$/.test(label(o.label)));
  const ceo = q.options.find(o => label(o.label) === 'Run /plan-ceo-review first');
  if (!ready || !ceo) return false;
  const task = /^Exit plan mode with the reviewed plan; implement T([1-9]\d*)[–-]T([1-9]\d*) \(record T([1-9]\d*) regression fixtures first\)\. ✅ All required reviews complete and logged\. ✅ Tasks JSONL and QA test plan are already written for \/autoplan and \/qa\. ❌ No second-opinion pass since codex reviews are disabled\.$/.exec(ready.description ?? '');
  // Bind implementation references to the published reviewed task catalog.
  // A new task or a newly proposed regression step is still substantive work.
  if (!task || Number(task[1]) !== 1 || Number(task[2]) < Number(task[3]) || Number(task[3]) < Number(task[1])) return false;
  const tasks = [...reviewedPlan.matchAll(/^- \[ \] \*\*T([1-9]\d*)\b[^\n]+$/gm)];
  const ids = tasks.map(t => Number(t[1])).sort((a, b) => a - b);
  if (ids.length !== Number(task[2]) || ids.some((id, i) => id !== i + 1)) return false;
  const regression = tasks.find(t => t[1] === task[3])?.[0] ?? '';
  if (!/ [—–] Record regression(?: characterization)? fixtures before\b/i.test(regression)) return false;
  return ceo.description === 'Optional scope and strategy pass before implementing. ✅ Catches product-level questions the eng review does not ask. ✅ Adds a CEO row to the dashboard. ❌ Little product surface here; likely confirms the current scope.';
}

/** A finished backend review may recap an already-published author prerequisite.
 * This classifies only its completed navigation; the runner still independently
 * requires the owned report, fresh modifying decisions and a later native exit.
 */
function isPublishedPrerequisiteHandoff(fp: AskUserQuestionFingerprint, reviewedPlan: string): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  if (q.multiSelect || q.header.trim() !== 'Next' || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !q.options.some(o => o.label === call.answers?.[q.question]) || /<gstack-qid/i.test(q.question)) return false;
  const lines = q.question.trim().split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length !== 7 || !/^D[1-9]\d* [—–-] Next step after this eng review\?$/.test(lines[0]!) ||
      !/^Project\/branch\/task: [\w.-]+ on [\w./-]+, reviewed plan written to gstack-test-plan-eng\.md\.$/.test(lines[1]!) ||
      lines[2] !== 'ELI10: The eng review is the only gate that blocks shipping and it is clear. No UI is touched, so a design review does not apply. A CEO review is optional and normally for product-direction changes; this is a backend auth refactor, so it is a soft mention only.' ||
      lines[3] !== 'Stakes if we pick wrong: Low either way; the CEO review would cost time on a change with no product-facing scope decision left open.' ||
      lines[5] !== 'Note: options differ in kind, not coverage — no completeness score.' ||
      lines[6] !== 'Net: start implementing versus an optional strategy pass on a backend refactor.') return false;
  const recommendation = /^Recommendation: ([A-Z]) because all required reviews are complete and the plan's remaining blocker is the author confirming the Context section, not another review\.$/.exec(lines[4]!);
  const ready = q.options.find(o => /^[A-Z]\) Ready to implement \(recommended\)$/.test(o.label));
  const ceo = q.options.find(o => /^[A-Z]\) Run \/plan-ceo-review$/.test(o.label));
  if (!recommendation || !ready || !ceo || ready.label[0] !== recommendation[1] || ready.label[0] === ceo.label[0]) return false;
  const task = /^✅ All relevant reviews complete; run \/ship when the work is done\. ✅ The first task is the author confirming Context, then T([1-9]\d*) characterization tests\. ❌ No second strategic opinion on whether the refactor is the right thing to build now\.$/.exec(ready.description ?? '');
  if (!task || ceo.description !== '✅ Adds a scope-and-strategy pass before any code is written. ✅ Useful if the refactor\'s business motivation is contested. ❌ Backend-only refactor with no product-direction choice; likely low yield for the time.') return false;

  // Only the published Context and Implementation Tasks sections own the
  // references. Quoted or fenced examples cannot supply a prerequisite/task.
  const published: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of reviewedPlan.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1]![0] !== '`' || !open[2]!.includes('`'))) {
      fence = { marker: open[1]![0]!, length: open[1]!.length }; continue;
    }
    if (!/^(?: {4}|\t| {0,3}>)/.test(line)) published.push(line);
  }
  if (fence) return false;
  const section = (heading: string): string | undefined => {
    const hits = published.flatMap((line, i) => line === `## ${heading}` ? [i] : []);
    if (hits.length !== 1) return undefined;
    const start = hits[0]!;
    const preceding = published.slice(0, start).filter(s => s.trim()).at(-1) ?? '';
    if (/[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(preceding)) return undefined;
    const end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const context = section('Context'), tasks = section('Implementation Tasks');
  if (!context || !tasks) return false;
  const prerequisite = /^### Prerequisite P(\d+) \(decision D[1-9]\d* → [1-9]\d*[A-Z]\)\nImplementation does not start until the author confirms or edits the Problem, Goal,\nInvariants and Latency target above\./m.exec(context);
  if (!prerequisite || !context.includes(`author must confirm — see Prerequisite P${prerequisite[1]} below`)) return false;
  const entries = [...tasks.matchAll(/^- \[ \] \*\*T([1-9]\d*)\b[^\n]+$/gm)];
  const referenced = entries.filter(t => t[1] === task[1]);
  if (referenced.length !== 1 || !/ — auth\/legacy — Write characterization tests for `legacyAuthFlow\(\)` before any rewrite$/.test(referenced[0]![0])) return false;
  const prerequisiteTail = context.slice(prerequisite.index!);
  const nextPrerequisiteHeading = prerequisiteTail.indexOf('\n### ', 1);
  const prerequisiteOwner = nextPrerequisiteHeading < 0 ? prerequisiteTail : prerequisiteTail.slice(0, nextPrerequisiteHeading);
  const taskStart = referenced[0]!.index!;
  const nextTask = entries.find(entry => entry.index! > taskStart)?.index ?? tasks.length;
  // A later correction inside the same owner can withdraw its earlier rule.
  // Unrelated prerequisite/task bodies cannot supply or revoke this reference.
  const withdrawn = (owner: string, id: string) => new RegExp(
    `\\b(?:Prerequisite )?${id}\\b(?: (?:requirement|task))? (?:is |was |has been )?(?:cancelled|canceled|withdrawn|rejected|not (?:required|needed|necessary))\\b`, 'i').test(owner);
  return !withdrawn(prerequisiteOwner, `P${prerequisite[1]}`) &&
    !/\b(?:the )?author no longer needs to confirm Context\b|\bContext confirmation is (?:not required|cancelled|withdrawn)\b/i.test(prerequisiteOwner) &&
    !withdrawn(tasks.slice(taskStart, nextTask), `T${task[1]}`) &&
    !/\bno characterization tests (?:are )?required\b|\bcharacterization tests are (?:not required|cancelled|withdrawn)\b/i.test(tasks.slice(taskStart, nextTask));
}
