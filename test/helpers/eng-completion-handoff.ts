import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import type { NativePlanQuestionCall } from './plan-count-transcript';

// A header may repeat its own native decision ID. A foreign ordinal cannot
// rename a substantive question into navigation.
function navigationHeader(q: NativePlanQuestionCall['questions'][number]): string {
  const header=/^(D[1-9]\d*)\s+(.+)$/.exec(q.header.trim());
  if(!header)return q.header.trim();
  return new RegExp(`^${header[1]}\\s*[—–:-]`).test(q.question) ? header[2]! : '';
}

/** Count a completed review-navigation choice separately; never choose pending input. */
export function isEngCompletionHandoff(fp: AskUserQuestionFingerprint, reviewedPlan: string,
  priorCalls: readonly NativePlanQuestionCall[] = []): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      Object.keys(call.answers ?? {}).length !== 1 || !Number.isFinite(Date.parse(call.answeredAt ?? ''))) return false;
  if (isPublishedTaskPauseNavigation(fp, reviewedPlan, priorCalls) || isCurrentLedgerNavigation(fp, reviewedPlan, priorCalls) || isApprovedInvestigationRecap(fp, reviewedPlan, priorCalls) || isPublishedReadyNavigation(fp, reviewedPlan, priorCalls) || isApprovedMaintenanceRecap(fp, reviewedPlan, priorCalls) || isPublishedPrerequisiteHandoff(fp, reviewedPlan)) return true;
  const q = call.questions[0]!;
  if (q.multiSelect || navigationHeader(q) !== 'Next steps' || q.options.length !== 2 ||
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

/** A completed report can retain critical implementation gaps (ISSUES OPEN).
 * Its current decision states, actual earlier answers and published task order
 * must still agree. This route supplies navigation credit only. */
function isCurrentLedgerNavigation(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s.replace(/\*\*/g, '')).replace(/^(?:[1-9]\d*)?[A-Z]\s*[).:—–-]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  const currentText = (s: string) => s.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(navigationHeader(q)) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo || call.answers?.[q.question] !== ready.label) return false;
  const context = currentText([q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n'));
  const positive = context.replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’/g, '');
  const status = context.replace(/["“”'‘’]/g, '');
  const badStatus = /\b(?:review|decisions?(?: [A-Z][1-9]\d*)?|readiness|state|accepted scope)\s*(?:(?:is|are|remains?|has been)\s+|:\s*)?(?:now |still )?(?:incomplete|unfinished|pending|unanswered|unresolved|reopened|withdrawn|superseded|cancelled|canceled|rejected|revoked|denied|unapproved|(?:not|no longer) (?:complete|completed|done|finished|approved|answered|settled))\b|\b(?:not all|not every) decisions?\b|\b[1-9]\d* unresolved decisions?\b/i;
  if (badStatus.test(status) || /`{3}|~{3}|(?:^|\n)\s*>/.test(context) ||
      !/\breview (?:is |has been )?(?:complete[d]?|done|finished)\b/i.test(positive) ||
      !/\bwhat next\b|\bnext steps?\b/i.test(positive) ||
      !/\b(?:every decision is|all decisions are) (?:answered|settled)\b/i.test(positive) ||
      /\breview\b[^.!?;\n]{0,60}\b(?:will|would|may|might|could|should) (?:be )?(?:complete|done|finished)\b|\breview\b[^.!?;\n]{0,60}\b(?:complete|done|finished)\b[^.!?;\n]{0,60}\b(?:if|when|once|unless|provided|assuming|after)\b|\b(?:if|when|once|unless|provided|assuming)\b[^.!?;\n]{0,60}\breview\b[^.!?;\n]{0,60}\b(?:complete|done|finished)\b/i.test(status)) return false;

  // Fences, quoted lines and explicitly historical sections cannot establish a
  // current owner. Keep the heading hierarchy so an archived parent is inert.
  const lines: string[] = [], headings: { depth: number; inactive: boolean }[] = [];
  let fence: string | undefined;
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (fence || /^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) {
      while (headings.at(-1) && headings.at(-1)!.depth >= h[1]!.length) headings.pop();
      headings.push({ depth: h[1]!.length, inactive: /\b(?:history|historical|archived?|withdrawn|superseded|example|quoted|template)\b/i.test(h[2]!) });
    }
    if (!headings.some(h => h.inactive)) lines.push(line);
  }
  if (fence) return false;
  const current = currentText(lines.join('\n'));
  const section = (name: string) => {
    const starts = lines.flatMap((line, i) => new RegExp(`^#{2,3} ${escape(name)}$`, 'i').test(line) ? [i] : []);
    if (starts.length !== 1) return undefined;
    const start = starts[0]!, depth = /^#+/.exec(lines[start]!)![0].length;
    const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${depth}} `).test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const titles = [...current.matchAll(/^# (?:Plan: )?(.+?)(?: \(reviewed\))?$/gm)];
  const targets = [...current.matchAll(/^Reviewed target: `([^`\n]+\.md)` \("([^"]+)"\)[^\n]*, branch `([^`\n]+)`[^\n]*$/gm)];
  if (titles.length !== 1 || targets.length !== 1 ||
      compact(titles[0]![1]!) !== compact(targets[0]![2]!.replace(/^Plan: /i, ''))) return false;
  const source = targets[0]![1]!, branch = targets[0]![3]!;
  const metadata = q.question.split('\n').filter(s => /^Project\/branch\/task:/.test(s));
  if (metadata.length !== 1 || !new RegExp(`^Project/branch/task: ${escape(branch)}; /plan-eng-review of ${escape(source)} (?:finished|completed|done),`).test(metadata[0]!)) return false;
  const ledger = section('Decision ledger'), tasks = section('Implementation Tasks'), lanes = section('Worktree parallelization strategy'), report = section('GSTACK REVIEW REPORT');
  if (!ledger || !tasks || !lanes || !report || badStatus.test(currentText(report).replace(/["“”'‘’]/g, '')) ||
      report.trim().split('\n').at(-1) !== 'NO UNRESOLVED DECISIONS') return false;
  const reportRows = report.split('\n').filter(s => /^\| Eng Review \|/.test(s));
  const verdicts = report.split('\n').filter(s => /^(?:- )?\*\*VERDICT:\*\*/.test(s));
  const gaps = reportRows.length === 1 ? /\| (CLEAR|ISSUES OPEN) \|[^\n]*\b(\d+) critical gaps\b/.exec(reportRows[0]!) : null;
  if (!gaps || verdicts.length !== 1 || !new RegExp(`\\bEng Review (?:is )?${gaps[1]}\\b`, 'i').test(verdicts[0]!) ||
      !/\b0 unresolved decisions\b/.test(verdicts[0]!) || (gaps[1] === 'CLEAR') !== (+gaps[2]! === 0) ||
      !new RegExp(`\\b${gaps[2]} critical gaps\\b`).test(metadata[0]!)) return false;

  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  if (!prior.length || new Set(identities).size !== prior.length || prior.some(c => c.sessionId !== call.sessionId ||
      !c.toolUseId || c.toolUseId === call.toolUseId || c.answered !== true || c.failed !== false ||
      !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
      !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length || c.questions.length !== 1 ||
      Object.keys(c.answers ?? {}).length !== 1 || c.questions[0]!.multiSelect ||
      new Set(c.questions[0]!.options.map(o => o.label)).size !== c.questions[0]!.options.length ||
      !c.questions[0]!.options.some(o => o.label === c.answers?.[c.questions[0]!.question]))) return false;
  const approvals = prior.map(c => ({ call: c, q: c.questions[0]!, id: /^(D[1-9]\d*)\s*[—–:-]/.exec(c.questions[0]!.question)?.[1], selected: label(c.answers![c.questions[0]!.question]!) }));
  const finalId = /^(D[1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
  if (!finalId || approvals.some(a => !a.id || a.id === finalId) || new Set(approvals.map(a => a.id)).size !== approvals.length) return false;
  const rows = ledger.split(/\n(?=### )/).filter(s => /^### /.test(s.trim()));
  const rowIds = rows.map(s => /^### ([A-Z][1-9]\d*):/.exec(s.trim())?.[1]);
  const states = [...ledger.matchAll(/^State: (.+)$/gm)];
  const owned = new Map<string, string>();
  if (!rows.length || rowIds.some(id => !id) || new Set(rowIds).size !== rows.length || states.length !== rows.length || states.some(s => s[1] !== 'approved')) return false;
  for (const row of rows) {
    const field = (name: string) => { const matches = [...row.matchAll(new RegExp(`^${name}: (.+)$`, 'gm'))]; return matches.length === 1 ? matches[0]![1]! : undefined; };
    const answer = field('Actual answer'), scope = field('Accepted scope');
    const question = [...row.matchAll(/^Question (D[1-9]\d*): (.+)$/gm)];
    if (field('State') !== 'approved' || !answer || !scope || question.length !== 1 || badStatus.test(currentText(row).replace(/["“”'‘’]/g, ''))) return false;
    const id = question[0]![1]!, a = approvals.find(a => a.id === id);
    if (!a || owned.has(id) || !answer.endsWith(`(${id})`) || label(answer.slice(0, -id.length - 3)) !== a.selected) return false;
    const meta = a.q.question.split('\n').filter(s => /^Project\/branch\/task:/.test(s));
    if (meta.length !== 1 || !new RegExp(`^Project/branch/task: ${escape(branch)}; [^;\n]*\\bon ${escape(source)}(?=[ ,;])`).test(meta[0]!) ||
        /\b(?:compare|comparison|historical|archived?|withdrawn|superseded)\b/i.test(meta[0]!.split(`on ${source}`)[0]!) ||
        [...meta[0]!.split(`on ${source}`)[0]!.matchAll(/[\w./-]+\.md\b/g)].some(m => m[0] !== 'TODOS.md')) return false;
    const owner = /^### ([A-Z][1-9]\d*):/.exec(row)![1]!;
    const changed = new RegExp(`\\b(?:${owner}|${id})\\b(?: (?:decision|scope|state|approval))?\\s*(?::|is|was|has been|remains)?\\s*(?:now |still )?(?:pending|withdrawn|superseded|reopened|cancelled|canceled|rejected|revoked|denied|unapproved|not approved|no longer approved)\\b`, 'i');
    if (changed.test(currentText(row).replace(/["“”'‘’]/g, '')) || prior.some(c => Date.parse(c.answeredAt!) > Date.parse(a.call.answeredAt!) && changed.test(currentText(c.questions[0]!.question).replace(/["“”'‘’]/g, '')))) return false;
    owned.set(id, row);
  }
  const readiness = ledger.split('\n').filter(s => /^Approval readiness:/.test(s));
  const readyRefs = readiness.length === 1 ? [...readiness[0]!.matchAll(/\b([A-Z][1-9]\d*) \((D[1-9]\d*)\)/g)] : [];
  if (readiness.length !== 1 || !/^Approval readiness: PASS\b/.test(readiness[0]!) ||
      readyRefs.length !== rows.length || new Set(readyRefs.map(r => r[2])).size !== rows.length ||
      readyRefs.some(r => !owned.get(r[2]!)?.startsWith(`### ${r[1]}:`))) return false;
  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]+/gm)];
  const ids = entries.map(e => e[1]!);
  if (!ids.length || new Set(ids).size !== ids.length) return false;
  for (const ref of context.matchAll(/\bT([1-9]\d*)(?:\s*(?:[–-]|through|to)\s*T([1-9]\d*))?\b/g)) {
    const first = +ref[1]!, last = +(ref[2] ?? ref[1])!;
    if (last < first || last - first >= ids.length) return false;
    for (let n = first; n <= last; n++) if (!ids.includes(`T${n}`)) return false;
  }
  const taskBody = (id: string) => { const e = entries.find(e => e[1] === id); return e ? tasks.slice(e.index!, entries.find(v => v.index! > e.index!)?.index ?? tasks.length) : ''; };
  if (/\bT[1-9]\d*\b[^.!?\n]*\b(?:withdrawn|cancelled|canceled|rejected|not approved|pending approval)\b/i.test(currentText(tasks).replace(/["“”'‘’]/g, ''))) return false;
  const count = /\bimplement (?:the )?(\d+) tasks\b/i.exec(positive);
  if (!count || +count[1]! !== ids.length) return false;
  const laneIds = [...lanes.matchAll(/\bLane ([A-Z]):/g)].map(m => m[1]!);
  const execution = lanes.split('\n').filter(s => /^Execution(?: order)?:/.test(s));
  const menuOrder = [...context.matchAll(/\blane order \(([^)]+)\)/gi)];
  const groups = (text: string) => text.split(/,?\s*then\s+|\s*→\s*/i).map(s => s.trim().replace(/\s+parallel$|\s+sequential(?:ly)?$/i, '').split(/\s*\+\s*|\s+and\s+/).sort());
  const publishedGroups = execution.length === 1 ? [...execution[0]!.matchAll(/\b(?:launch|then) ([A-Z](?:\s*(?:\+|and)\s*[A-Z])*)(?: in parallel(?: worktrees)?| sequentially)?(?=[.,]|$)/gi)].map(m => groups(m[1]!)[0]!) : [];
  if (!laneIds.length || new Set(laneIds).size !== laneIds.length || !publishedGroups.length || menuOrder.length !== 1 ||
      JSON.stringify(groups(menuOrder[0]![1]!)) !== JSON.stringify(publishedGroups) ||
      JSON.stringify(publishedGroups.flat().sort()) !== JSON.stringify([...laneIds].sort())) return false;

  // Strip only already-owned implementation/navigation recaps before applying
  // the established action veto. Approval references are read from this packet.
  let actions = context.replace(/\bimplement (?:the )?\d+ tasks in the lane order given\b/gi, '')
    .replace(/\bimplement T[1-9]\d*[-–]T[1-9]\d* in lane order \([^)]+\)/gi, '');
  const maintenance = /(?:First two edits after exit|Post-exit|After exiting): ((?:append|add) (?:gstack )?routing rules to CLAUDE\.md) \((D[1-9]\d*)\) and ((?:create|write) TODOS\.md) \((D[1-9]\d*)\)\./i.exec(actions);
  if (maintenance) {
    const routing = approvals.find(a => a.id === maintenance[2]), todo = approvals.find(a => a.id === maintenance[4]);
    const sameTask = entries.some(e => { const b = taskBody(e[1]!); return /\bCLAUDE\.md\b/.test(b) && /\bTODOS\.md\b/.test(b) && [maintenance[2], maintenance[4]].every(id => new RegExp(`\\b${id}\\b`).test(b)); });
    if (!routing || !todo || routing.q.header !== 'Routing' || !/^(?:Add|Append) (?:gstack )?routing rules(?: to CLAUDE\.md)?$/i.test(routing.selected) ||
        !/\bCLAUDE\.md\b/.test(routing.q.question) || !/^TODO(?: [1-9]\d*)?$/.test(todo.q.header) || todo.selected !== 'Add to TODOS.md' || !owned.has(todo.id!) || !sameTask ||
        !new RegExp(`^Project/branch/task: ${escape(branch)}(?: branch|;)`).test(routing.q.question.split('\n')[1] ?? '')) return false;
    for (const a of [routing, todo]) {
      const withdrawn = new RegExp(`\\b${a.id}\\b(?: (?:decision|scope|state|approval))?\\s*(?::|is|was|has been|remains)?\\s*(?:now |still )?(?:pending|withdrawn|superseded|reopened|cancelled|canceled|rejected|revoked|denied|unapproved|not approved|no longer approved)\\b`, 'i');
      if (withdrawn.test(current.replace(/["“”'‘’]/g, '')) || prior.some(c => Date.parse(c.answeredAt!) >= Date.parse(a.call.answeredAt!) && withdrawn.test(currentText(c.questions[0]!.question).replace(/["“”'‘’]/g, '')))) return false;
    }
    actions = actions.replace(maintenance[0], '');
  }
  actions = actions.replace(/\bAdds? a scope\/strategy pass(?: and a (?:written )?([a-z]+(?: [a-z]+)+) the plan currently lacks \((T[1-9]\d*)\))?(?=[.!?]|$)/gi, (whole, noun, id) =>
    !noun || new RegExp(`\\b${escape(noun)}\\b`, 'i').test(taskBody(id).split('\n')[0] ?? '') ? '' : whole);
  const action = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:adds?|adding|append(?:s|ing)?|remov(?:e|es|ing)|delet(?:e|es|ing)|cut(?:s|ting)?|drop(?:s|ping)?|replac(?:e|es|ing)|rewrit(?:e|es|ing)|chang(?:e|es|ing)|alter(?:s|ing)?|modif(?:y|ies|ying)|enabl(?:e|es|ing)|disabl(?:e|es|ing)|implement(?:s|ing)?|install(?:s|ing)?|introduc(?:e|es|ing)|build(?:s|ing)?|writ(?:e|es|ing)|record(?:s|ing)?|captur(?:e|es|ing)|creat(?:e|es|ing)|switch(?:es|ing)?|migrat(?:e|es|ing)|externaliz(?:e|es|ing)|refactor(?:s|ing)?|expand(?:s|ing)?|reduc(?:e|es|ing)|deploy(?:s|ing)?|approv(?:e|es|ing))\b/i;
  return !action.test(actions) && !/\brun\s+(?!\/(?:ship|plan-ceo-review)\b)|\b(?:new|additional|extra) (?:work|task|requirement|dependency|feature)\b|\b(?:must|shall|should|needs? to|required to)\s+[a-z]/i.test(actions);
}

/** A ready menu may recap one previously approved investigation. The completed
 * native answer, current ledger and published task jointly own that exception;
 * it never supplies seed credit or replaces the runner's report/exit checks. */
function isApprovedInvestigationRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s).replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(navigationHeader(q)) || q.options.length < 2 || q.options.length > 3 ||
      fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      new Set(q.options.map(o => label(o.label))).size !== q.options.length) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^(?:CEO review \(\/plan-ceo-review\)|Run \/plan-ceo-review(?: first)?)$/i.test(label(o.label)));
  const design = q.options.find(o => /^Design review \(\/plan-design-review\)$/i.test(label(o.label)));
  if (!ready || !ceo || q.options.length === 3 && !design || call.answers?.[q.question] !== ready.label) return false;
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const body = compact(q.question.replace(/"[^"\n]*"|“[^”\n]*”/g, ''));
  const issue = /\b(?:follow-up|investigation)\s*\((R[1-9]\d*)\)/i.exec(body)?.[1];
  const task = /\b(?:follow-up|investigation) task\s*\((T[1-9]\d*)\)\s*,?\s*(?:is )?not a blocker\b/i.exec(body)?.[1];
  if (!issue || !task || !/^D[1-9]\d*\s*[—–:-]\s*Next steps? after this eng(?:ineering)? review\?/i.test(body) ||
      !/\b(?:eng(?:ineering)? review|review) is (?:done|complete[d]?|finished)\b/i.test(body) ||
      !/\b(?:every|all) P1 (?:fix(?:es)?|remed(?:y|ies)) (?:is|are) approved and specified\b/i.test(body) ||
      !/\bremaining choice is whether another review pass\b|\bonly (?:remaining )?choice is (?:the )?next (?:review|workflow)\b/i.test(body) ||
      !/\b(?:one|1) (?:\w+ )?(?:follow-up|investigation)\b/i.test(body) ||
      design && !/\bno UI\b[\s\S]*\bdesign review does not apply\b/i.test(body) ||
      /(?:^|\n)\s*>|`{3}|~{3}|\b(?:Example|Historical|Quoted)\s*:/i.test(context)) return false;
  // Descriptions can explain existing work. New commands, including commands
  // hidden in quoted/conjoined prose, are not navigation on either option.
  const action = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|cut(?:ting)?|drop(?:ping)?|replac(?:e|ing)|rewrit(?:e|ing)|chang(?:e|ing)|alter(?:ing)?|modif(?:y|ying)|enabl(?:e|ing)|disabl(?:e|ing)|implement(?:ing)?|install(?:ing)?|introduc(?:e|ing)|build(?:ing)?|writ(?:e|ing)|record(?:ing)?|captur(?:e|ing)|creat(?:e|ing)|switch(?:ing)?|migrat(?:e|ing)|externaliz(?:e|ing)|refactor(?:ing)?|expand(?:ing)?|reduc(?:e|ing)|deploy(?:ing)?|approv(?:e|ing))\b/i;
  const statusText = (s: string) => s.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '').replace(/["“”'‘’]/g, '');
  const eng = String.raw`(?:(?:the |this )?(?:eng(?:ineering)? review|eng gate)|this review|the review|the verdict|all required reviews)`;
  const complete = String.raw`(?:clear(?:ed)?|complete[d]?|done|finished)`;
  const invalidCompletion = (s: string) => {
    const v = statusText(s);
    return new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b(?:incomplete|unfinished|pending|withdrawn|superseded|cancelled|canceled|reopened|rejected|not (?:done|complete|completed|clear|cleared|finished))\b`, 'i').test(v) ||
      new RegExp(String.raw`\b${eng}\s+(?:will|would|may|might|can|could|should)\s+(?:be |become )?${complete}\b`, 'i').test(v) ||
      new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b${complete}\b[^.!?;\n]{0,100}\b(?:if|when|once|unless|provided|assuming|after)\b`, 'i').test(v) ||
      new RegExp(String.raw`\b(?:if|when|once|unless|provided|assuming)\b[^.!?;\n]{0,100}\b${eng}\b[^.!?;\n]{0,60}\b${complete}\b`, 'i').test(v) ||
      /\bnot (?:all|every) P1 (?:fix(?:es)?|remed(?:y|ies))\b|\bP1 (?:fix(?:es)?|remed(?:y|ies))\b[^.!?;\n]{0,80}\b(?:not approved|unapproved|pending|reopened|withdrawn|superseded|cancelled|canceled|rejected)\b/i.test(v);
  };
  const changedInvestigation = (s: string, owner = `${issue}|${task}|(?:the |this )?(?:investigation|follow-up|open item|pending item)`, genericApproval = true) => {
    const v = statusText(s).replace(/\bnot a blocker\b|\bNo (?:[\w-]+ )*implementation approved\./gi, '');
    return new RegExp(String.raw`\b(?:${owner})\b(?: (?:task|decision|requirement|status|implementation))?\s*(?::|is|was|has been|remains)?\s*(?:now |still )?(?:a blocker|blocking|withdrawn|cancelled|canceled|rejected|reopened|superseded|not (?:required|approved)|no longer (?:optional|approved|nonblocking)|required before (?:implementation|building|work)|implementation (?:is )?(?:now )?approved)\b`, 'i').test(v) ||
      genericApproval && /\bimplementation (?:is |now |is now )?approved\b/i.test(v);
  };
  const allowedReask = new RegExp(`\\b${issue}(?: (?:stays|remains) (?:open|unresolved) and)? must be re-asked after ${task}\\b`, 'gi');
  const actions = context.replace(allowedReask, '');
  if (invalidCompletion(context) || changedInvestigation(context) || action.test(actions) || /\brun\s+(?!\/(?:ship|plan-ceo-review|plan-design-review)\b)/i.test(actions) || /\bimplementation (?:is |now |is now )?approved\b/i.test(actions) || /\b(?:new|additional|extra) (?:work|task|requirement|dependency|feature)\b|\b(?:must|shall|should|needs? to|required to)\s+[a-z]/i.test(actions) ||
      /\b(?:review|P1 (?:fixes|remedies))\b[^.!?;\n]*\b(?:not done|not complete|not approved|pending approval|reopened|withdrawn)\b/i.test(context)) return false;

  const published: string[] = [];
  let fence: string | undefined;
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (!fence && !/^(?: {0,3}>| {4}|\t)/.test(line)) published.push(line);
  }
  if (fence) return false;
  const current = published.filter(line => !/^(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/i.test(line)).join('\n');
  const section = (heading: RegExp): string | undefined => {
    const hits = published.flatMap((line, i) => heading.test(line) ? [i] : []);
    if (hits.length !== 1) return undefined;
    const start = hits[0]!, before = published.slice(0, start).filter(s => s.trim()).at(-1) ?? '';
    if (/[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(before)) return undefined;
    const end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const titles = [...current.matchAll(/^# Plan: (.+?)(?: \(reviewed\))?$/gm)];
  const targets = [...current.matchAll(/^Reviewed target: `([^`]+\.md)` on `([^`]+)`.*$/gm)];
  const sourceLines = q.question.split('\n').filter(line => /^Project\/branch\/task:/.test(line));
  if (titles.length !== 1 || targets.length !== 1 || sourceLines.length !== 1) return false;
  const title = titles[0]![1]!, source = targets[0]![1]!, branch = targets[0]![2]!;
  if (!new RegExp(`^Project/branch/task: [\\w.-]+ on ${escape(branch)}, ${escape(title)}(?: plan)?[.;]`).test(sourceLines[0]!)) return false;
  const ledger = section(/^## Decision ledger$/i), tasks = section(/^## Implementation Tasks$/), lanes = section(/^## Worktree parallelization strategy$/i), report = section(/^## GSTACK REVIEW REPORT$/);
  if (!ledger || !tasks || !lanes || !report) return false;
  const rows = ledger.split(/\n(?=### )/).filter(s => /^### /.test(s.trim()));
  const owned = rows.filter(s => new RegExp(`^### ${issue}: `).test(s.trim()));
  if (owned.length !== 1 || [...ledger.matchAll(/^State: pending\b/gmi)].length !== 1) return false;
  const row = owned[0]!;
  const field = (name: string) => { const found = [...row.matchAll(new RegExp(`^${name}: (.+)$`, 'gm'))]; return found.length === 1 ? found[0]![1]! : undefined; };
  const finding = field('Finding'), state = field('State'), answer = field('Actual answer'), scope = field('Accepted scope');
  if (!finding || !new RegExp(`(?:^|[ ,])${escape(source)}:\\d+\\b`).test(finding) ||
      [...finding.matchAll(/[\w./-]+\.md:\d+/g)].some(m => !m[0].startsWith(source + ':')) ||
      !/^pending \(Investigate\)$/i.test(state ?? '') || !answer || !scope ||
      !/^bounded investigation only:/i.test(scope) || !/\bNo (?:[\w-]+ )*implementation approved\./i.test(scope) ||
      !new RegExp(`\\b${issue} remains unresolved until re-asked\\b`, 'i').test(scope)) return false;
  const scopeRemainder = scope.replace(/\bNo (?:[\w-]+ )*implementation approved\./gi, '');
  if (changedInvestigation(row) || action.test(scopeRemainder) || /\bimplementation (?:is |now |is now )?approved\b|\brun\s+/i.test(scopeRemainder)) return false;
  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  if (!prior.length || new Set(identities).size !== prior.length || prior.some(c => c.sessionId !== call.sessionId ||
      !c.toolUseId || c.toolUseId === call.toolUseId || c.answered !== true || c.failed !== false ||
      !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
      !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length || !c.questions.length ||
      Object.keys(c.answers ?? {}).length !== c.questions.length || new Set(c.questions.map(v => v.question)).size !== c.questions.length ||
      c.questions.some(v => v.multiSelect || v.options.length < 2 || v.options.length > 4 ||
        new Set(v.options.map(o => o.label)).size !== v.options.length || !v.options.some(o => o.label === c.answers?.[v.question])))) return false;
  const approvals = prior.flatMap(c => c.questions.map(v => ({call:c, question:v}))).filter(({question:v}) =>
    new RegExp(`^D[1-9]\\d*\\s*[—–:-]\\s*${issue}:`).test(v.question));
  if (approvals.length !== 1) return false;
  const approved = approvals[0]!, priorQuestion = approved.question, selected = approved.call.answers![priorQuestion.question]!;
  const decision = /^(D[1-9]\d*)\s*[—–:-]/.exec(priorQuestion.question)![1]!;
  if (prior.some(c => Date.parse(c.answeredAt!) > Date.parse(approved.call.answeredAt!) && c.questions.some(v => {
    const text = statusText(v.question);
    return new RegExp(`\\b${issue}\\b`).test(text) && changedInvestigation(text, issue, false);
  }))) return false;
  const priorTitle = priorQuestion.question.split('\n')[0]!.replace(new RegExp(`^${decision}\\s*[—–:-]\\s*${issue}:\\s*`), '');
  const priorSource = priorQuestion.question.split('\n').filter(line => /^Project\/branch\/task:/.test(line));
  const savedQuestions = [...row.matchAll(/^Question (D[1-9]\d*): "([^"\n]+)" Options: .+$/gm)];
  if (!/^Investigate before choosing$/i.test(label(selected)) || priorSource.length !== 1 ||
      !new RegExp('^Project/branch/task: `' + escape(branch) + '`, ' + escape(source) + ' ' + escape(title) + ';').test(priorSource[0]!) ||
      savedQuestions.length !== 1 || savedQuestions[0]![1] !== decision || savedQuestions[0]![2] !== priorTitle ||
      label(answer.replace(new RegExp(` \\(${decision}\\)$`), '')) !== label(selected) || !answer.endsWith(`(${decision})`)) return false;
  const approvedDescription = priorQuestion.options.find(o => o.label === selected)?.description ?? '';
  if (!/\bre-asked\b/i.test(approvedDescription) || action.test(approvedDescription) || /\brun\s+|\bimplementation (?:is |now |is now )?approved\b/i.test(approvedDescription)) return false;

  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]+$/gm)];
  const ids = entries.map(m => m[1]!);
  const target = entries.filter(m => m[1] === task);
  const count = /\b([1-9]\d*) tasks\b/i.exec(ready.description ?? '');
  const laneCount = /\b([1-9]\d*) (?:parallel )?lanes\b/i.exec(ready.description ?? '');
  const laneIds = [...lanes.matchAll(/\bLane ([A-Z]):/g)].map(m => m[1]);
  if (!entries.length || new Set(ids).size !== ids.length || target.length !== 1 || !count || +count[1]! !== ids.length ||
      !laneCount || +laneCount[1]! !== laneIds.length || new Set(laneIds).size !== laneIds.length) return false;
  for (const ref of context.matchAll(/\b(T[1-9]\d*)(?:\s*[-–]\s*(T[1-9]\d*))?\b/g)) {
    const first = +ref[1]!.slice(1), last = +(ref[2] ?? ref[1]!).slice(1);
    if (last < first || last - first >= ids.length) return false;
    for (let id = first; id <= last; id++) if (!ids.includes(`T${id}`)) return false;
  }
  const start = target[0]!.index!, end = entries.find(m => m.index! > start)?.index ?? tasks.length;
  const taskLines = tasks.slice(start, end).trim().split('\n').filter(s => s.trim() && !/^_/.test(s));
  const taskBody = taskLines.join('\n');
  const taskField = (name: string) => { const found = taskLines.filter(line => line.startsWith(`  - ${name}: `)); return found.length === 1 ? found[0] : undefined; };
  const surfaced = taskField('Surfaced by'), files = taskField('Files'), verify = taskField('Verify');
  if (taskLines.length !== 4 || !/ — plan — (?:Enumerate|List|Inventory|Document)\b/i.test(taskLines[0]!) ||
      !surfaced || !new RegExp(`^  - Surfaced by: .*\\b${issue} / ${decision}\\b`).test(surfaced) ||
      !files || !/^  - Files: this plan, /i.test(files) || !verify || !new RegExp(`^  - Verify: .+; ${issue} re-asked$`, 'i').test(verify) ||
      action.test(taskBody) || /\b(?:implement|build|deploy|delete|add|approve)\b/i.test(taskBody)) return false;
  const table = /\bin (?:the|this) plan's "([^"\n]+)" table\./i.exec(scope)?.[1];
  if (!table || !files.includes('"' + table + '" table') ||
      !new RegExp(`\\b${issue}\\b`).test(taskLines[0]!) || !/\b(?:enumerate|list|inventory|document)\b/i.test(taskLines[0]!)) return false;
  const status = new RegExp(`\\b(?:${issue}|${decision}|${task})\\b(?: (?:task|decision|requirement|status))?\\s*(?::|is|was|has been|remains)?\\s*(?:now |still )?(?:withdrawn|cancelled|canceled|rejected|reopened|superseded|not (?:required|approved)|implementation approved)\\b`, 'i');
  if (status.test(current.replace(/["“”]/g, '')) || changedInvestigation(current, `${issue}|${decision}|${task}`, false) || invalidCompletion(report)) return false;
  const unresolved = report.split(/\*\*UNRESOLVED DECISIONS:\*\*/);
  if (unresolved.length !== 2 || !/\bEng Review ISSUES OPEN \(1 unresolved decision, 0 critical gaps\)/.test(report) ||
      !/\b(?:All|Every) P1 (?:remedies|fixes) (?:are|is) approved and specified\b/i.test(report) ||
      !/\bnot a blocker\b/i.test(report)) return false;
  const remaining = unresolved[1]!.trim().split('\n').filter(s => s.trim());
  return remaining.length === 1 && new RegExp(`^- ${issue} / ${decision} [—–-] .+: Investigate; re-ask .+\\(${task}\\)$`, 'i').test(remaining[0]!);
}

function hasCompleteEarlierNativeAnswers(call: NativePlanQuestionCall,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const identities = prior.map(c => `${c.sessionId}:${c.toolUseId}`);
  return !!prior.length && new Set(identities).size === prior.length && !prior.some(c => c.sessionId !== call.sessionId ||
    c.toolUseId === call.toolUseId || !c.toolUseId || c.answered !== true || c.failed !== false ||
    !Number.isFinite(Date.parse(c.answeredAt ?? '')) || Date.parse(c.answeredAt!) >= Date.parse(call.answeredAt!) ||
    !Array.isArray(c.unansweredQuestionIndices) || c.unansweredQuestionIndices.length ||
    !c.questions.length || c.questions.length > 4 || Object.keys(c.answers ?? {}).length !== c.questions.length ||
    new Set(c.questions.map(q => q.question)).size !== c.questions.length ||
    c.questions.some(q => q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
      new Set(q.options.map(o => o.label)).size !== q.options.length ||
      !q.options.some(o => o.label === c.answers?.[q.question])));
}

function introducesSourceContext(line: string): boolean {
  return /[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(line);
}

/** Navigation may repeat already-approved post-review bookkeeping, but cannot
 * authorize it afresh or hide new implementation work behind a completion label. */
function isApprovedMaintenanceRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  if (isRecordedMaintenanceRecap(fp, plan, prior)) return true;
  const call = fp.nativeCall!, q = call.questions[0]!;
  const label = (s: string) => s.replace(/^[1-9]\d*[A-Z]\)\s*/, '').replace(/\s*\(recommended\)$/, '').trim();
  const current = (s: string) => !/^(?:\s*>|\s*`{3,}|\s*~{3,})|(?:^|\n)\s*(?:source|example|historical|quoted)\b|["“”]|\b(?:withdrawn|cancelled|canceled|rejected|superseded|no longer current|not approved|no longer approved|pending approval|if approved|once approved|assuming approval|provided approval)\b/i.test(s);
  if (q.multiSelect || !/^Next steps?$/i.test(q.header) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      !/^D[1-9]\d*\s*[—–:-]\s*Next steps?[.:]/i.test(q.question) ||
      !/\bEng(?:ineering)? review is (?:clear(?:ed)?|complete[d]?)\b/i.test(q.question) ||
      !/\bno UI scope\b/i.test(q.question) || !/\bCEO review is optional\b/i.test(q.question) ||
      /\b(?:add|implement|rewrite|build|require|if|unless|assuming|provided|pending)\b/i.test(q.question) ||
      !current([q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n'))) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo || call.answers?.[q.question] !== ready.label) return false;
  const recap = /^Exit plan mode with the reviewed plan\. (?:Post-exit|After exiting): (.+)\.$/i.exec(ready.description ?? '');
  const actions = recap?.[1]?.split(/\s+and\s+|;\s*/);
  if (!actions || actions.length !== 2) return false;
  const routing = actions.filter(a => /^(?:append|add) (?:the )?(?:gstack )?routing rules to CLAUDE\.md$/i.test(a));
  const todos = actions.map(a => /^(?:create|write) TODOS\.md with (?:the )?(one|two|three|four|five|six|seven|eight|nine|[1-9]) accepted items?$/i.exec(a)).filter(Boolean);
  if (routing.length !== 1 || todos.length !== 1) return false;
  const count = Number(todos[0]![1]) || ['one','two','three','four','five','six','seven','eight','nine'].indexOf(todos[0]![1]!.toLowerCase()) + 1;
  if (!hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const approved = prior.flatMap(c => c.questions.map(q => ({ q, selected: label(c.answers![q.question]!) })));
  const routingCalls = approved.filter(({q}) => q.header === 'Routing');
  if (routingCalls.length !== 1 || routingCalls.filter(({q, selected}) => current(q.question) &&
      /\bskill routing rules\b/.test(q.question) && /CLAUDE\.md/.test(q.question) &&
      /^(?:Add|Append) (?:gstack )?routing rules to CLAUDE\.md$/.test(selected)).length !== 1) return false;
  const accepted = approved.filter(({q, selected}) => /^TODO [1-9]\d*$/.test(q.header) &&
    selected === 'Add to TODOS.md' && current(q.question) &&
    /\bCaptured in the plan's TODOS section now\b/.test(q.options.find(o => label(o.label) === selected)?.description ?? ''));
  if (accepted.length !== count || approved.filter(({q}) => /^TODO [1-9]\d*$/.test(q.header)).length !== count ||
      new Set(accepted.map(a => a.q.header)).size !== count) return false;
  // Only current, unfenced TODO headings in the published report bind the recap.
  let fence: string | undefined;
  const lines = plan.split(/\r?\n/).filter(line => {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; return false; }
    return !fence && !/^(?: {0,3}>| {4}|\t)/.test(line);
  });
  if (fence) return false;
  const starts = lines.flatMap((line, i) => /^## TODOS?(?:\.md)?\b/i.test(line) ? [i] : []);
  if (starts.length !== 1 || !current(lines[starts[0]!]!) || /:\s*$/.test(lines.slice(0, starts[0]).filter(s => s.trim()).at(-1) ?? '')) return false;
  const tail = lines.slice(starts[0]! + 1), end = tail.findIndex(line => /^## /.test(line));
  const blocks = (end < 0 ? tail : tail.slice(0, end)).join('\n').trim().split(/\n(?=### )/);
  return blocks.length === count && accepted.every(({q}) => {
    const subjects = q.question.split('\n')[0]!.match(/\b(?:[a-z]+|[A-Z][a-z]+)(?:[A-Z][A-Za-z0-9]*)+\b/g) ?? [];
    return subjects.length === 1 && blocks.filter(b => /^### /.test(b) && current(b) &&
      new RegExp(`\\b${subjects[0]}\\b`).test(b.split('\n')[0]!)).length === 1;
  });
}

/** Reference-bearing navigation can repeat approved post-exit maintenance and
 * the published first task. Bind each D/T reference to the current report and
 * actual earlier native answers; this never supplies report or exit evidence. */
function isRecordedMaintenanceRecap(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => s.trim().replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '')
    .replace(/\s*\((?:recommended|optional|soft(?:: optional)?)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(navigationHeader(q)) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      Date.parse(call.answeredAt!) > Date.now()) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^Run \/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  if (!ready || !ceo || call.answers?.[q.question] !== ready.label || !/^Optional (?:strategy|scope)/i.test(ceo.description ?? '')) return false;
  const recap = /^Exit plan mode[.;] (?:start|begin) with (T[1-9]\d*) (?:fixtures|characterization tests), then (?:write|create) CLAUDE\.md routing rules \((D[1-9]\d*)\) and TODOS\.md \((D[1-9]\d*(?:\/D[1-9]\d*)*)\)\.$/i.exec(ready.description ?? '');
  if (!recap) return false;
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const positive = q.question.replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const eng = '(?:(?:the |this )?eng(?:ineering)? review|the review|this review)';
  const completed = '(?:clear(?:ed)?|complete[d]?|done|finished)';
  const invalid = new RegExp(`\\b${eng}\\b[^.!?;\\n]{0,100}\\b(?:not|never|incomplete|unfinished|pending|withdrawn|superseded|cancelled|canceled|reopened)\\b|\\b${eng}\\s+(?:will|would|may|might|could|should) (?:be )?${completed}\\b|\\b${eng}\\b[^.!?;\\n]{0,100}\\b${completed}\\b[^.!?;\\n]{0,80}\\b(?:if|when|once|unless|provided|assuming|after)\\b|\\b(?:if|when|once|unless|provided|assuming)\\b[^.!?;\\n]{0,80}\\b${eng}\\b`, 'i');
  if (!/\b(?:where next|next steps?)\b/i.test(positive) ||
      !new RegExp(`\\b${eng} (?:is |has been )?${completed}\\b`, 'i').test(positive) ||
      !/\b(?:every finding has an approved fix|all decisions (?:are )?(?:answered|settled))\b/i.test(positive) ||
      !/\b(?:remaining|only) choice is whether\b/i.test(positive) ||
      invalid.test(context) || /(?:^|\n)\s*>|`{3}|~{3}|\b(?:example|quoted|historical)\s*:/i.test(context) ||
      /\b(?:not every finding|not all decisions|unanswered|unresolved|unapproved|pending approval)\b/i.test(context)) return false;
  // Only the already-bound selected recap may contain implementation commands.
  const actions = context.replace(ready.description!, '');
  // A new obligation is substantive whether phrased as a command, a need,
  // a dependency or a declared requirement. Only the bound recap is exempt.
  const obligation = /\b(?:must|shall|should|requires?|needs?)\s+\S|\b(?:depends on|required to)\s+\S|\b(?:is|are|becomes?|remains?)\s+(?:now |still )?(?:required|mandatory|a prerequisite)\b/i;
  if (/(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while)\s+)(?:please\s+)?(?:add|remove|delete|replace|rewrite|change|alter|modify|enable|disable|implement|install|introduce|build|write|record|capture|create|switch|migrate|refactor|expand|reduce|deploy|approve)\b/i.test(actions) ||
      /\brun\s+(?!\/(?:ship|plan-ceo-review)\b)|\b(?:new|additional|extra) (?:work|implementation|scope|task|requirement|dependency|feature|datastore|database|cache|test|prerequisite)\b/i.test(actions) || obligation.test(actions)) return false;

  const published: string[] = [], hierarchy: { depth: number; inactive: boolean }[] = [];
  let fence: string | undefined, preceding = '';
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (fence || /^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) { while (hierarchy.at(-1) && hierarchy.at(-1)!.depth >= h[1]!.length) hierarchy.pop(); hierarchy.push({depth:h[1]!.length,inactive:introducesSourceContext(preceding) || /\b(?:history|historical|archived?|example|quoted|template|withdrawn|superseded)\b/i.test(h[2]!)}); }
    // Keep the preceding visible line even in an inactive section, so source
    // context follows its heading's descendants and ends at the next sibling.
    if (line.trim()) preceding = line;
    if (!hierarchy.some(h => h.inactive)) published.push(line);
  }
  if (fence) return false;
  const current = published.join('\n'), titles = [...current.matchAll(/^# Plan: (.+) \(reviewed\)$/gm)];
  const owners = [...current.matchAll(/^(?:<!-- )?Reviewed target: ([\w./-]+\.md) \("Plan: ([^"\n]+)"\) in (\/[\w./-]+), branch ([\w./-]+), commit [a-f0-9]+\./gm)];
  const metadata = [...q.question.matchAll(/^Project\/branch\/task: ([\w.-]+) @ ([\w./-]+) [—–-] ([^,\n]+),/gm)];
  if (titles.length !== 1 || owners.length !== 1 || metadata.length !== 1 || titles[0]![1] !== owners[0]![2] ||
      metadata[0]![1] !== owners[0]![3]!.split('/').at(-1) || metadata[0]![2] !== owners[0]![4] || metadata[0]![3] !== titles[0]![1]) return false;
  const source = owners[0]![1]!, branch = owners[0]![4]!;
  const section = (heading: RegExp) => {
    const hits = published.flatMap((line, i) => heading.test(line) ? [i] : []);
    if (hits.length !== 1) return undefined;
    const start = hits[0]!, end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const report = section(/^## GSTACK REVIEW REPORT$/), ledger = section(/^## Decision ledger$/), tasks = section(/^## Implementation Tasks$/), todos = section(/^## Accepted TODOs(?: \([^\n]*\))?$/);
  if (!report || !ledger || !tasks || !todos || report.trim().split('\n').at(-1) !== 'NO UNRESOLVED DECISIONS' ||
      !/^\| Eng Review \|[^\n]*\| CLEAR \|[^\n]*\b0 critical gaps\b/m.test(report) ||
      !/^- \*\*VERDICT:\*\* ENG CLEARED\b/m.test(report) || invalid.test(report) ||
      !/^Approval readiness: PASS\b/m.test(ledger)) return false;
  if (!hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const answers = prior.flatMap(c => c.questions.map(q => ({q,id:/^(D[1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1],selected:c.answers![q.question]!})));
  if (answers.some(a => !a.id) || new Set(answers.map(a => a.id)).size !== answers.length) return false;
  const withdrawn = /\b(?:approval|decision|scope|task|TODO|routing rules)\s*(?:is|was|has been|:)?\s*(?:now )?(?:withdrawn|revoked|rejected|cancelled|canceled|reopened|superseded|not approved|pending approval)\b/i;
  if (withdrawn.test(context) || withdrawn.test(current) || answers.some(a => withdrawn.test(a.q.question))) return false;
  const rows = ledger.split(/\n(?=### )/).filter(row => /^### R[1-9]\d*:/.test(row.trim()));
  const bound = new Set<string>();
  for (const row of rows) {
    const states = [...row.matchAll(/^State: (.+)$/gm)], decision = [...row.matchAll(/^Question (D[1-9]\d*):/gm)];
    const selected = [...row.matchAll(/^Actual answer: ([A-Z]) [—–-] (D[1-9]\d*) answer "([^"\n]+)"$/gm)];
    if (states.length !== 1 || states[0]![1] !== 'approved' || decision.length !== 1 || selected.length !== 1 || decision[0]![1] !== selected[0]![2]) return false;
    const answer = answers.find(a => a.id === decision[0]![1]);
    if (!answer || bound.has(answer.id!) || selected[0]![3] !== answer.selected ||
        answer.q.options.findIndex(o => o.label === answer.selected) !== selected[0]![1]!.charCodeAt(0) - 65 ||
        !new RegExp(`^Project/branch/task: ${escape(branch)}[,;] ${escape(source)}\\b`, 'm').test(answer.q.question)) return false;
    bound.add(answer.id!);
  }
  if (!rows.length || [...ledger.matchAll(/^State: /gm)].length !== rows.length) return false;
  const routing = answers.find(a => a.id === recap[2]), todoIds = recap[3]!.split('/');
  if (!routing || routing.q.header !== 'Routing' || label(routing.selected) !== 'Add routing rules to CLAUDE.md' ||
      !new RegExp(`^Project/branch/task: ${escape(branch)} branch[^\\n]*\\b${escape(source)}\\b`, 'm').test(routing.q.question) ||
      !new RegExp(`\\b${recap[2]} \\(CLAUDE\\.md routing rules, setup, answered A;`).test(ledger) || new Set(todoIds).size !== todoIds.length) return false;
  const blocks = todos.split(/\n(?=### )/).filter(block => /^### TODO [1-9]\d*:/.test(block.trim()));
  if (blocks.length !== todoIds.length) return false;
  for (const id of todoIds) {
    const a = answers.find(a => a.id === id), number = a && new RegExp(`^Project/branch/task: ${escape(branch)}, ${escape(source)} ${escape(titles[0]![1]!)}, TODO ([1-9]\\d*) of ([1-9]\\d*)\\b`, 'm').exec(a.q.question);
    if (!a || a.q.header !== 'TODO' || label(a.selected) !== 'Add to TODOS.md' || !number || +number[2]! !== todoIds.length ||
        blocks.filter(block => block.trim().startsWith(`### TODO ${number[1]}:`)).length !== 1 ||
        !new RegExp(`\\b${id}/A\\b`).test(ledger) || !new RegExp(`\\b${id}\\b`).test(tasks)) return false;
  }
  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]+/gm)];
  if (!entries.length || new Set(entries.map(e => e[1])).size !== entries.length) return false;
  for (const ref of context.matchAll(/\bT([1-9]\d*)(?:[–-]T([1-9]\d*))?\b/g)) {
    const first = +ref[1]!, last = +(ref[2] ?? ref[1])!;
    if (last < first || last - first >= entries.length) return false;
    for (let n = first; n <= last; n++) if (!entries.some(e => e[1] === `T${n}`)) return false;
  }
  const firstTask = entries.filter(e => e[1] === recap[1]);
  return firstTask.length === 1 && /\bRecord\b[^\n]*\bcharacterization fixtures\b[^\n]*\bbefore any rewrite\b/.test(firstTask[0]![0]) &&
    new RegExp(`^1\\. Record characterization fixtures[^\\n]*\\(${recap[1]}\\)\\. Commit\\.$`, 'm').test(current);
}

/** A finished backend review may recap an already-published author prerequisite.
 * This classifies only its completed navigation; the runner still independently
 * requires the owned report, fresh modifying decisions and a later native exit.
 */
function isPublishedPrerequisiteHandoff(fp: AskUserQuestionFingerprint, reviewedPlan: string): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  if (q.multiSelect || navigationHeader(q) !== 'Next' || q.options.length !== 2 || fp.options.length !== 2 ||
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
    if (introducesSourceContext(preceding)) return undefined;
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

/** A completed ready/optional-review menu may recap the already-published task
 * and lane catalog. This classifies administration; the runner still proves the
 * owned, fresh report and the later native ExitPlanMode independently. */
function isPublishedReadyNavigation(fp: AskUserQuestionFingerprint, reviewedPlan: string,
  prior: readonly NativePlanQuestionCall[] = []): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const label = (s: string) => compact(s).replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(navigationHeader(q)) || q.options.length < 2 || q.options.length > 3 || fp.options.length !== q.options.length ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      new Set(q.options.map(o => label(o.label))).size !== q.options.length ||
      !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  const ready = q.options.find(o => /^Ready to implement(?: [—–-] run \/ship when done)?$/i.test(label(o.label)));
  const ceo = q.options.find(o => /^(?:Run )?\/plan-ceo-review(?: first)?$/i.test(label(o.label)));
  const devex = q.options.find(o => /^(?:Run )?\/plan-devex-review(?: first)?$/i.test(label(o.label)));
  const design = q.options.find(o => /^(?:Run )?\/plan-design-review(?: first)?$/i.test(label(o.label)));
  const outside=q.options.find(o=>/^(?:Re-)?enable (?:the )?outside (?:voice|review)(?: first)?$/i.test(label(o.label)));
  const outsideCommand=/\bRun gstack-config set codex_reviews enabled and re-run \/plan-eng-review(?=[.;, ]|$)/;
  if (!ready || q.options.some(o => ![ready, ceo, devex, design, outside].includes(o)) ||
      outside && !outsideCommand.test(outside.description ?? '')) return false;
  // Only the current prose can assert completion; quoted examples cannot.
  const body = compact(q.question.replace(/"[^"]*"|“[^”]*”/g, '')).replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  // Keep raw instructions for vetoes: quoted commands cannot disappear merely
  // because quoted text cannot establish positive completion evidence.
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const statusContext = context.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '').replace(/["“”'‘’]/g, '');
  if (/\bnot (?:all|every) decisions?\b|\bdecisions?\s+(?:(?:is|are|remains?)\s+|status:\s*)?(?:still\s+)?(?:unanswered|unresolved|pending|reopened|not answered|not settled|open)\b/i.test(statusContext)) return false;
  // These are assertions about a finished review and an action-only next-step
  // choice, not a required seven-line transcript or a particular risk sentence.
  const eng = String.raw`(?:(?:the |this )?(?:eng(?:ineering)? review|eng gate)|this review|the review|the verdict|all required reviews)`;
  const complete = String.raw`(?:clear(?:ed)?|complete[d]?|done|finished)`;
  const explicitNavigation = /\b(?:navigation|routing) only\b|\bonly (?:selects?|chooses?|changes?) (?:the )?next (?:step|workflow|review)\b/i.test(body) &&
    /\b(?:approves?|authorizes?|adds?|makes?) no (?:new )?(?:implementation|scope) (?:changes?|work)\b|\b(?:does not|doesn't|will not|won't|neither) (?:authorize|approve|add|change|alter|modify)(?: nor (?:authorize|approve|add|change|alter|modify))? (?:any )?(?:new )?(?:implementation|scope|requirements?|work)\b|\bwithout (?:any )?(?:new )?(?:implementation|scope) changes?\b/i.test(body);
  // A completed two-route menu need not repeat a no-change disclaimer. Its
  // settled decisions, sole remaining workflow choice and named reviewed plan
  // supply the same boundary; task ownership and new-work vetoes still apply.
  const metadata = [...q.question.matchAll(/^Project\/branch\/task: ([^\n]+)$/gm)];
  // The current native ledger can own a menu which names the project, branch
  // and plan title. Earlier calls in that same session bind the source path.
  // Option count and an unquoted lane count are presentation, not approval.
  const ledgerOwner = metadata.length === 1 ? /^(?:([^\s,;]+) on )?([^\s,;]+) [—–-] (.+?)(?: plan)?, (?:(?:eng|engineering) review|reviewed plan saved with ENG CLEARED)\b/i.exec(metadata[0]![1]!) : null;
  const namedSource = ledgerOwner && /^(.*?) (?:plan )?\(([\w./-]+\.md)\)$/.exec(ledgerOwner[3]!);
  if (namedSource) ledgerOwner![3] = namedSource[1]!;
  const approvedCount = /\b([1-9]\d*) approved decisions\b/i.exec(body);
  const settled = /\bevery (?:open )?call (?:was|is) decided\b|\b(?:all (?:[\w]+ )?decisions (?:are |were )?(?:answered|settled|approved)|every decision (?:is |was )?(?:answered|settled|locked))\b/i.test(body);
  const recordedOrder = /\bImplement T([1-9]\d*)[–-]T([1-9]\d*) in the recorded lane order\b/.exec(ready.description ?? '');
  const ledgerChoice = Boolean(ledgerOwner && (settled || explicitNavigation && recordedOrder));
  if ((devex || design || ledgerOwner) && !ledgerChoice) return false;
  const scopeRecap = ledgerChoice ? prior.find(c => c.questions[0]?.header === 'Structure')?.questions[0] : undefined;
  const scopeCount = scopeRecap && /\b([1-9]\d*) new classes\b/.exec(scopeRecap.question)?.[1];
  const chosenScope = scopeRecap && prior.find(c => c.questions[0] === scopeRecap)?.answers?.[scopeRecap.question];
  const reducedCount = chosenScope && /\bCollapse to ([1-9]\d*) units\b/.exec(chosenScope)?.[1];
  const currentScope = metadata.length === 1 ? /^([^\s,;]+), (PLAN\.md) ["“]([^"”\n]+)["”](?:;|$)/.exec(metadata[0]![1]!) : null;
  const catalogMenu = /\b(?:0|no) unresolved decisions\b/i.test(body)
    && /\b(?:navigation|routing) only\b/i.test(body)
    && /\bnothing (?:here )?(?:changes|alters|modifies) (?:the|this) plan (?:or|and) (?:its|the) tasks\b|\b(?:the|this) plan and its tasks remain unchanged\b/i.test(body);
  if (catalogMenu && !currentScope) return false;
  const catalogChoice = Boolean(catalogMenu && currentScope);
  if ((catalogChoice || ledgerChoice) && (
      [...metadata[0]![1]!.matchAll(/[^\s,;"“”()]+\.md\b/g)].some(m=>m[0]!=='PLAN.md')
      || /\b(?:review|eng gate|verdict) (?:is |has been |remains? )?(?:no longer|not) (?:clear|complete|done|finished)\b|\b[1-9]\d* unresolved decisions\b/i.test(statusContext)
      || /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|while)\s+)(?:approve|deploy)(?:ing)?\b/i.test(statusContext))) return false;
  const completedChoice = ledgerChoice || Boolean(catalogChoice) || /\b(?:all decisions (?:are )?(?:answered|settled)|every decision (?:is )?(?:answered|settled))\b/i.test(body) &&
    /\b(?:the only question left is whether to (?:start building|implement) or (?:first )?get (?:a )?(?:strategy-level second look|strategy review)|only the next (?:step|workflow) remains: implementation or an optional strategy review)\b/i.test(body);
  const namedPlans = [...q.question.matchAll(/\breviewed\s+[\w./-]+\.md\s+["“]([^"”\n]+)["”]/gi)];
  if (!/\b(?:what(?:['’]s| is)? (?:the )?next|next steps?|where next|where (?:do|should) we go)\b/i.test(body) ||
      !new RegExp(String.raw`\b${eng}\s+(?:(?:is|are|has been|have been)\s+)?(?:(?:now|saved and)\s+)?${complete}\b`, 'i').test(body) ||
      !(explicitNavigation || completedChoice && (namedPlans.length === 1 || catalogChoice || ledgerChoice))) return false;
  if (/`{3}|~{3}|(?:^|\n)\s*>|\b(?:example|sample|quoted|historical)\s*:/i.test(context) ||
      new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b(?:not|never|incomplete|unfinished|pending|withdrawn|revoked|superseded|cancelled|canceled|reopened)\b`, 'i').test(context) ||
      new RegExp(String.raw`\b${eng}\s+(?:will|would|may|might|can|could|should)\s+(?:be |become )?${complete}\b`, 'i').test(context) ||
      new RegExp(String.raw`\b${eng}\b[^.!?;\n]{0,100}\b${complete}\b[^.!?;\n]{0,100}\b(?:if|when|once|unless|provided|assuming|after)\b`, 'i').test(context) ||
      new RegExp(String.raw`\b(?:if|when|once|unless|provided|assuming)\b[^.!?;\n]{0,100}\b${eng}\b[^.!?;\n]{0,60}\b${complete}\b`, 'i').test(context)) return false;
  // Finite offered actions are navigation. Descriptions may explain their
  // tradeoffs, but cannot append a new implementation command or obligation.
  const proposedWork = /\b(?:new|additional|extra)\s+(?:implementation|scope|requirement|task|dependency|feature|datastore|database|cache|test|prerequisite)\b|\b(?:must|shall|should|needs? to|have to|has to|required to)\s+(?!run \/plan-ceo-review\b|run \/ship\b)[a-z]/i;
  const implementationAction = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|cut(?:ting)?|drop(?:ping)?|replac(?:e|ing)|rewrit(?:e|ing)|chang(?:e|ing)|alter(?:ing)?|modif(?:y|ying)|enabl(?:e|ing)|disabl(?:e|ing)|implement(?:ing)?|install(?:ing)?|introduc(?:e|ing)|build(?:ing)?|writ(?:e|ing)|record(?:ing)?|captur(?:e|ing)|creat(?:e|ing)|switch(?:ing)?|migrat(?:e|ing)|externaliz(?:e|ing)|refactor(?:ing)?|expand(?:ing)?|reduc(?:e|ing))\b/i;
  // An explicit negative is inert only within its clause; appended work after
  // a conjunction or punctuation remains subject to the same action checks.
  const actionContext=context.replace(/\b(?:approves?|authorizes?|adds?|makes?) no (?:new )?(?:implementation|scope) (?:changes?|work)\b/gi,'')
    .replace(/\b(?:does not|doesn't|will not|won't|neither) (?:authorize|approve|add|change|alter|modify)(?: nor (?:authorize|approve|add|change|alter|modify))? (?:any )?(?:new )?(?:implementation|scope|requirements?|work)(?: changes?)?\b/gi,'')
    .replace(/\bwithout (?:any )?(?:new )?(?:implementation|scope) changes?\b/gi,'')
    .replace(outside ? outsideCommand : /$^/, '')
    .replace(recordedOrder ? recordedOrder[0] : /$^/, '')
    .replace(ledgerChoice ? /\brun (?:another|an optional) (?:kind of )?review first\b/gi : /$^/, '')
    .replace(ledgerChoice && ceo ? /\brun (?:a |the )?(?:CEO(?:-style)?|strategic|strategy) review\b/gi : /$^/, '')
    .replace(ledgerChoice && scopeCount && reducedCount ? /\bthe scope was already challenged and cut in Step 0\b/gi : /$^/, '')
    .replace(ledgerChoice && scopeCount && reducedCount ? new RegExp(`\\bStep 0 already ran the scope challenge and cut ${scopeCount} classes to ${reducedCount}\\b`, 'gi') : /$^/, '');
  const commands = new Set(['/ship', ...(ceo ? ['/plan-ceo-review'] : []), ...(ledgerChoice && devex ? ['/plan-devex-review'] : []), ...(ledgerChoice && design ? ['/plan-design-review'] : []), ...(outside ? ['/plan-eng-review'] : [])]);
  // Compare whole command tokens. Sentence punctuation may follow a route;
  // a suffix, path, extension or query names a different command.
  const runAction = [...actionContext.matchAll(/\brun\s+([^\s]+)/gi)].some(m => !commands.has(m[1]!.replace(/[.!?,;:)]+$/, '')));
  if(proposedWork.test(actionContext)||implementationAction.test(actionContext)||runAction ||
      ledgerChoice && /\b(?:approve|deploy)(?:ing)?\b|\bdepends on\b|\b(?:only|skip|drop|omit) (?:the )?(?:tasks?|T[1-9]\d*)\b|\bT[1-9]\d*\s*(?:→|before|after|first|last)\b/i.test(actionContext))return false;
  const taskRefs=[...context.matchAll(/\bT([1-9]\d*)(?:\s*(?:[–-]|through|to)\s*T([1-9]\d*))?\b/g)];
  if(!taskRefs.length)return false;
  const laneRefs=[...context.matchAll(/\b[Ll]anes?\s+([A-Z](?:\s*\+\s*[A-Z])*(?:(?:,?\s*then\s+|\s*→\s*)[A-Z](?:\s*\+\s*[A-Z])*)*)/g)];
  if(!laneRefs.length && !completedChoice)return false;
  // Only active, unfenced sections own a recap. A copied report/task list cannot.
  const published: string[] = [];
  const hierarchy: { depth: number; inactive: boolean }[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of reviewedPlan.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1]![0] !== '`' || !open[2]!.includes('`'))) { fence = {marker:open[1]![0]!,length:open[1]!.length}; continue; }
    if (/^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      while (hierarchy.at(-1) && hierarchy.at(-1)!.depth >= heading[1]!.length) hierarchy.pop();
      hierarchy.push({ depth: heading[1]!.length, inactive: /\b(?:history|historical|archived?|withdrawn|superseded|example|quoted|template)\b/i.test(heading[2]!) });
    }
    if (!hierarchy.some(entry => entry.inactive)) published.push(line);
  }
  if (fence) return false;
  if (!explicitNavigation || catalogChoice || ledgerChoice) {
    const titles = published.filter(line => /^# /.test(line) && line !== '# Review output');
    // A reviewed wrapper may retain its same-title original plan. Neither a
    // second wrapper nor a foreign original may supply current ownership.
    if (titles.length === 2 && /^# Reviewed (?:Implementation )?Plan: /.test(titles[0]!) && titles[1] === titles[0]!.replace(/^# Reviewed (?:Implementation )?Plan:/, '# Plan:')) titles.pop();
    const named = ledgerChoice ? ledgerOwner![3]! : catalogChoice ? currentScope![3]! : namedPlans[0]![1]!;
    if (titles.length !== 1 || compact(titles[0]!.replace(/^# (?:(?:Reviewed (?:Implementation )?)?Plan: )?/i, '').replace(/\s+\(reviewed\)$|\s+[—–-] Reviewed Implementation Plan$/i, '')) !== compact(named)) return false;
    if (catalogChoice) {
      const targets = published.filter(line => /^Review(?:ed)? target:/.test(line));
      const target = targets.length === 1 ? /^Reviewed target: `?([\w./-]+\.md)`? \(repo root, branch `?([^`\s)]+)`?\)/.exec(targets[0]!) : null;
      if (!target || target[1] !== currentScope![2] || target[2] !== currentScope![1]) return false;
    }
  }
  const section = (heading: string) => {
    const starts=published.flatMap((line,i)=>/^#{2,3} /.test(line) && line.replace(/^#+ /,'').toLowerCase()===heading.toLowerCase()?[i]:[]);
    if(starts.length!==1)return undefined;
    const start=starts[0]!;
    if(/[:：]$|\b(?:example|sample|hypothetical|template|quoted)\b/i.test(published.slice(0,start).filter(s=>s.trim()).at(-1)??''))return undefined;
    const depth=/^#+/.exec(published[start]!)![0].length;
    const end=published.findIndex((line,i)=>i>start && /^#+ /.test(line) && /^#+/.exec(line)![0].length<=depth);
    return published.slice(start+1,end<0?undefined:end).join('\n');
  };
  const tasks=section('Implementation Tasks'), lanes=section('Worktree parallelization strategy'), report=section('GSTACK REVIEW REPORT');
  if(!tasks||!lanes||!report||!hasReadyReviewRow(report)||
      outside && !/\| Outside Review \|[^\n]*\bDISABLED\b/.test(report)||
      !/^(?:[-*] )?(?:\*\*)?VERDICT:(?:\*\*)? ENG CLEARED\b/m.test(report)||
      report.trim().split('\n').at(-1)!=='NO UNRESOLVED DECISIONS')return false;
  // The newly supported saved-and-complete assertion is an admission class.
  // Its ownership proof is mandatory even if a caller drops or renames fields.
  const savedCompletion = /\bsaved and (?:clear(?:ed)?|complete[d]?|done|finished)\b/i.test(body);
  const currentLedger = section('Decision ledger');
  const targetLines = published.filter(line => /^Review(?:ed)? target:/.test(line));
  const ownedTarget = targetLines.length === 1 ? /^Reviewed target: `([^`]+)` \("([^"\n]+)"\)[^\n]*, branch `([^`]+)`[^\n]*$/m.exec(targetLines[0]!) : null;
  if (ledgerChoice) {
    const targetLine = targetLines.length === 1 ? targetLines[0]! : '';
    const target = /^Reviewed target: `([^`\n]+\.md)` \("([^"\n]+)"\) on branch `([^`\n]+)`, commit `[a-f0-9]+`\.$/.exec(targetLine);
    const located = /^Reviewed target: `([^`\n]+\.md)` \(`(\/[^`\n]+)`, branch `([^`\n]+)`, commit `[a-f0-9]+`\)$/.exec(targetLine);
    const inDirectory = /^Reviewed target: `([^`\n]+\.md)` \("(?:Plan: )?([^"\n]+)"\) in `(\/[^`\n]+)`, branch `([^`\n]+)`, commit `[a-f0-9]+`\.$/.exec(targetLine);
    const inRepo=/^Review(?:ed)? target: `([^`\n]+\.md)` \("(?:Plan: )?([^"\n]+)"\) in repo `[^`\n]+`, branch `([^`\n]+)`, commit [a-f0-9]+\.$/.exec(targetLine);
    const source = target?.[1] ?? located?.[1] ?? inDirectory?.[1] ?? inRepo?.[1], title = target?.[2] ?? inDirectory?.[2] ?? inRepo?.[2] ?? ledgerOwner![3], branch = target?.[3] ?? located?.[3] ?? inDirectory?.[4] ?? inRepo?.[3];
    if (!source || namedSource && namedSource[2] !== source || title !== ledgerOwner![3] || branch !== ledgerOwner![2] || located && !located[2]!.endsWith('/' + source) || !currentLedger || approvedCount && +approvedCount[1]! !== prior.length ||
        !hasCompletedOwnedLedger(call, prior, currentLedger, report, { source, title: title!, branch: branch!, publication: published.join('\n') })) return false;
  }
  if (savedCompletion && (!currentScope ||
      [...q.question.matchAll(/^ELI10: (.+)$/gm)].length !== 1 || !ownedTarget || ownedTarget[1] !== currentScope[2] || ownedTarget[2] !== currentScope[3] || ownedTarget[3] !== currentScope[1] ||
      published.filter(line => /^# (?:Reviewed )?Plan: /i.test(line)).length !== 1 || compact(published.find(line => /^# (?:Reviewed )?Plan: /i.test(line))!.replace(/^# (?:Reviewed )?Plan: /i, '')) !== compact(currentScope[3]!) ||
      !currentLedger || !hasCompletedOwnedLedger(call, prior, currentLedger, report))) return false;
  const entries=[...tasks.matchAll(/^- \[ \] \*\*T([1-9]\d*)\b[^\n]+/gm)];
  const todoRecaps = [...context.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|[1-9]\d*) TODOS\.md entries\b/gi)];
  if (ledgerChoice && ([...context.matchAll(/[^\s,;"“”()]+\.md\b/g)].some(m => !['PLAN.md', 'TODOS.md'].includes(m[0])) ||
      /\bTODOS\.md\b/.test(context) && !todoRecaps.length)) return false;
  if (todoRecaps.length && (!ledgerChoice || todoRecaps.length !== 1 ||
      !hasRecordedTodoEntries(published, prior, Number(todoRecaps[0]![1]) || 'zero one two three four five six seven eight nine'.split(' ').indexOf(todoRecaps[0]![1]!.toLowerCase())))) return false;
  for(const ref of taskRefs) {
    const first=Number(ref[1]),last=Number(ref[2]??ref[1]);
    if(last<first||last-first+1>entries.length)return false;
    for(let id=first;id<=last;id++) {
      const own=entries.filter(e=>Number(e[1])===id);
      if(own.length!==1)return false;
      const end=entries.find(e=>e.index!>own[0]!.index!)?.index??tasks.length;
      if(new RegExp(`\\bT${id}\\b[^.!?\\n]*\\b(?:withdrawn|cancelled|canceled|rejected|not approved|pending approval)\\b`,'i').test(tasks.slice(own[0]!.index!,end)))return false;
    }
  }
  if (ledgerChoice) {
    if (recordedOrder) {
      // A recap of the recorded order is not a new launch schedule. Validate
      // the claims actually made against owned tasks and dependency rows; the
      // explicit Start/Launch menus below keep their full schedule proof.
      if (/\b(?:start|launch) (?:lanes?|T[1-9]\d*)\b/i.test(context) || laneRefs.length) return false;
      const recapped = new Set(taskRefs.flatMap(ref => Array.from({length: +(ref[2] ?? ref[1])! - +ref[1]! + 1}, (_, i) => +ref[1]! + i)));
      if (entries.length !== recapped.size || new Set(entries.map(e => e[1])).size !== entries.length) return false;
      const task = (id: string) => { const row = entries.find(e => e[1] === id); return row ? tasks.slice(row.index, entries.find(e => e.index! > row.index!)?.index ?? tasks.length) : ''; };
      const graph = lanes.replace(/`/g, '');
      const steps = [...graph.matchAll(/^\| ([1-9]\d*)\.? ([^|\n]+) \| ([^|\n]+) \| ([^|\n]+) \|$/gm)];
      const rows = [...graph.matchAll(/\bLane ([A-Z]): (?:step )?([1-9]\d*(?: → (?:step )?[1-9]\d*)*) \(([^)]+)\)/g)];
      const count = [...context.matchAll(/\b([1-9]\d*) (?:worktree )?lanes\b/g)];
      const stepIds = steps.map(s => s[1]!), laneSteps = rows.flatMap(row => row[2]!.match(/[1-9]\d*/g) ?? []);
      if (!steps.length || new Set(stepIds).size !== steps.length || !rows.length || new Set(rows.map(row => row[1])).size !== rows.length ||
          count.length !== 1 || +count[0]![1]! !== rows.length || new Set(laneSteps).size !== laneSteps.length ||
          JSON.stringify([...laneSteps].sort()) !== JSON.stringify([...stepIds].sort())) return false;
      const dependencies = (row: RegExpMatchArray) => /^[—–-](?: \([^)]*\))?$/.test(row[4]!) ? [] : row[4]!.split(/,\s*/);
      if (steps.some(row => dependencies(row).some(id => !stepIds.includes(id) || +id >= +row[1]!))) return false;
      const taskStep = (id: string) => {
        const files = /^  - Files: ([^\n]+)$/m.exec(task(id))?.[1];
        const file = files && /`([\w/.*-]+)`/.exec(files)?.[1];
        const module = file?.includes('/__tests__/') ? file.slice(0, file.indexOf('/__tests__/') + 11) : file?.replace(/\.ts$/, '');
        const owners = module ? steps.filter(row => row[3]!.split(/,\s*/).some(value => value.replace(/ \([^)]*\)$/, '') === module)) : [];
        return owners.length === 1 ? owners[0] : undefined;
      };
      const lane = (id: string) => rows.find(row => (row[2]!.match(/[1-9]\d*/g) ?? []).includes(id));
      const precedes = (before: string, after: string): boolean => dependencies(steps.find(row => row[1] === after)!).some(id => id === before || precedes(before, id));
      const execution = graph.split('\n').filter(line => /^Execution order:/.test(line));
      const launches = execution.length === 1 ? [...execution[0]!.matchAll(/\blaunch ([A-Z](?:(?:\s*\+\s*|,\s*| and )[A-Z])*) in parallel/gi)] : [];
      const launchOf = (name: string) => launches.find(group => (group[1]!.match(/[A-Z]/g) ?? []).includes(name));
      const ordering = [...context.matchAll(/\bT([1-9]\d*)(?: \([^)]*\))? (before|after) T([1-9]\d*)(?: \([^)]*\))?/g)];
      for (const claim of ordering) {
        const before = taskStep(claim[1]!), after = taskStep(claim[3]!);
        if (claim[2] !== 'before' || !before || !after || !new RegExp(`\\bbefore T${claim[3]}\\b`).test(task(claim[1]!)) || !precedes(before[1]!, after[1]!)) return false;
        const first = lane(before[1]!)!, last = lane(after[1]!)!;
        if (first === last) {
          const order = first[2]!.match(/[1-9]\d*/g)!;
          if (order.indexOf(before[1]!) >= order.indexOf(after[1]!)) return false;
        } else {
          const firstLaunch = launchOf(first[1]!), lastLaunch = launchOf(last[1]!);
          if (!firstLaunch || !lastLaunch || firstLaunch.index! >= lastLaunch.index!) return false;
          const between = execution[0]!.slice(firstLaunch.index! + firstLaunch[0].length, lastLaunch.index);
          if (!new RegExp(`\\bMerge (?:all(?: (?:two|three|four|five|[1-9]\\d*))?|${first[1]})\\b`).test(between)) return false;
        }
      }
      const independent = [...context.matchAll(/\b(T[1-9]\d*(?:\/T[1-9]\d*)+) are independent lanes\b/g)];
      for (const claim of independent) {
        const owners = claim[1]!.split('/').map(id => taskStep(id.slice(1)));
        if (owners.some(row => !row || dependencies(row).length) || new Set(owners.map(row => lane(row![1]!)![1])).size !== owners.length) return false;
      }
      const conditions = [...context.matchAll(/\b(\w+) code waits on the plan paragraph \(T([1-9]\d*)\)/g)];
      for (const condition of conditions) {
        if (!task(condition[2]!).includes(`blocks any ${condition[1]} code`) || !prior.some(c => {
          const q = c.questions[0]!, choice = q.options.find(o => o.label === c.answers![q.question]);
          return choice?.description?.includes(`${condition[1]}'s responsibility`) && /Class stays pending until written\. Approves no implementation\./.test(choice.description);
        })) return false;
      }
      // The optional review route changes review configuration only. A second
      // command or new prerequisite still fails the earlier action veto.
      return true;
    }
    // Parse the published dependency graph once. A conditional lane belongs to
    // the later schedule, but never to the menu's unconditional start set.
    const graph = lanes.replace(/`/g, '');
    const steps = [...graph.matchAll(/^\| ([ST]?[1-9]\d*) ([^|\n]+) \| ([^|\n]+) \| ([^|\n]+) \|$/gm)];
    const laneRows = [...graph.matchAll(/\bLane ([A-Z]): ([ST]?[1-9]\d*(?: → [ST]?[1-9]\d*)*) \(([^)]+)\)/g)];
    const launch = [...graph.matchAll(/\bLaunch ([A-Z](?:(?: \+ |, )[A-Z])*)(?: \(\+ ([A-Z]) when ([^)]+)\))? in parallel(?: worktrees)?\. Merge(?: all(?: (?:two|three|four|five|[1-9]\d*))?)?\. Then ([ST]?[1-9]\d*(?: → [ST]?[1-9]\d*)*|[A-Z])(?: sequentially)?\./gi)];
    const ids = steps.map(s => s[1]!), laneIds = laneRows.map(l => l[1]!);
    const recapped = new Set(taskRefs.flatMap(ref => Array.from({length: +(ref[2] ?? ref[1])! - +ref[1]! + 1}, (_, i) => +ref[1]! + i)));
    const counts = [...context.matchAll(/\b([1-9]\d*) lanes\b/g)];
    if (!steps.length || new Set(ids).size !== ids.length || !laneRows.length || new Set(laneIds).size !== laneRows.length || launch.length !== 1 ||
        counts.length > 1 || counts.length === 1 && +counts[0]![1]! !== laneRows.length ||
        entries.length !== recapped.size || new Set(entries.map(e => e[1])).size !== entries.length) return false;
    const initial = launch[0]![1]!.split(/ \+ |, /), conditional = launch[0]![2], later = launch[0]![4]!;
    const laterLane = laneRows.find(l => l[1] === later);
    const allLanes = [...initial, ...(conditional ? [conditional] : []), ...(laterLane ? [later] : [])];
    if (new Set(allLanes).size !== allLanes.length || JSON.stringify(allLanes.sort()) !== JSON.stringify([...laneIds].sort())) return false;
    const position = new Map<string, {phase: number; lane: string; index: number}>();
    for (const [lane, sequence, phase] of [...laneRows.map(l => [l[1]!, l[2]!, l === laterLane ? 1 : 0] as const), ...(!laterLane ? [['', later, 1] as const] : [])]) {
      for (const [index, id] of sequence.split(' → ').entries()) {
        if (!ids.includes(id) || position.has(id)) return false;
        position.set(id, {phase, lane, index});
      }
    }
    for (const step of steps) {
      const own = position.get(step[1]!);
      // Cross-cutting documentation may accompany every step; it cannot become
      // a newly launched lane or an omitted implementation dependency.
      if (!own) { if (step[4] !== 'with each step' || !entries.some(e => `T${e[1]}` === step[1])) return false; continue; }
      const external = step[4] === 'author input';
      const deps = /^[—–-](?: \([^)]*\))?$/.test(step[4]!) || external ? [] : step[4]!.split(/,\s*/).map(d => d.replace(/ recorded$/, ''));
      if (external && own.lane !== conditional || new Set(deps).size !== deps.length || deps.some(id => {
        const dep = position.get(id);
        return !dep || !(dep.phase < own.phase || dep.phase === own.phase && dep.lane === own.lane && dep.index < own.index);
      })) return false;
    }
    if (conditional) {
      if (hasWithdrawnPrerequisite(context)) return false;
      const blocked = laneRows.filter(l => /\bblocked\b/i.test(l[3]!));
      const held = blocked.length === 1 && blocked[0]![1] === conditional ? blocked[0]! : undefined;
      const subject = /^(\w+) is defined$/.exec(launch[0]![3] ?? '')?.[1];
      const task = held && entries.find(e => `T${e[1]}` === held[2]);
      const selected = /\b(?:Start|Launch) lanes ([^.]+?) now\b/i.exec(ready.description ?? '');
      const offered = selected && [...selected[1]!.matchAll(/(?:^|,\s*|\s+and\s+)([A-Z])(?: \([^)]*\))?(?=,|$)/g)].map(m => m[1]!);
      const condition = /\b(\w+) lane (?:stays|remains) blocked until you write its (?:one-paragraph )?responsibility\./i.exec(context);
      if (!held || !subject || !task || !/author input/.test(held[3]!) || !/author input/.test(task[0]) ||
          !task[0].includes('`' + subject + '`') || !/Author writes .*responsibility.*then implement/.test(task[0]) ||
          !steps.some(s => s[1] === held[2] && s[4] === 'author input') ||
          !condition || condition[1] !== subject || !offered || new Set(offered).size !== offered.length ||
          JSON.stringify([...offered].sort()) !== JSON.stringify([...initial].sort()) ||
          !prior.some(c => { const q = c.questions[0]!, choice = q.options.find(o => o.label === c.answers![q.question]); return choice?.description?.includes(subject) && /must add a written responsibility/.test(choice.description); })) return false;
      // Exempt just the already-bound blocked prerequisite from the action veto.
      // New commands and newly started lanes elsewhere remain substantive.
      const rest = context.replace(selected![0], '').replace(condition[0], '');
      if (/\b(?:start|launch)\b/i.test(rest) || /\blane [A-Z]\b/.test(rest)) return false;
    } else if (laneRows.some(l => /\bblocked\b/i.test(l[3]!)) || counts.length > 1 ||
        laneRefs.some(ref => JSON.stringify(ref[1]!.split(/\s*\+\s*/).sort()) !== JSON.stringify([...laneIds].sort()))) return false;
    return true;
  }
  const parallel = [...context.matchAll(/\blanes ([A-Z](?:[+/][A-Z])+) in parallel\b/gi)];
  if (parallel.length) {
    const launches = [...lanes.matchAll(/\blaunch ([A-Z](?: \+ [A-Z])+) in parallel\b/g)];
    const names = (value: string) => value.split(/\s*[+/]\s*/).sort();
    return parallel.length === 1 && launches.length === 1 && JSON.stringify(names(parallel[0]![1]!)) === JSON.stringify(names(launches[0]![1]!)) &&
      names(parallel[0]![1]!).every(id => new RegExp(`\\bLane ${id}:`).test(lanes));
  }
  const groups=(text:string)=>[...text.matchAll(/\b[A-Z](?:\s*\+\s*[A-Z])*\b/g)].map(m=>m[0].replace(/\s/g,''));
  const execution=lanes.split('\n').filter(line=>/^Execution:/.test(line));
  return execution.length===1 && /\bLane [A-Z]:/.test(lanes) && laneRefs.every(ref=>
    JSON.stringify(groups(execution[0]!))===JSON.stringify(groups(ref[1]!)) &&
    groups(ref[1]!).flatMap(s=>s.split('+')).every(id=>new RegExp(`\\bLane ${id}:`).test(lanes)));
}

/** A completed implementation-or-pause menu can recap a published task graph
 * and previously answered bookkeeping. It grants navigation credit only. */
function isPublishedTaskPauseNavigation(fp: AskUserQuestionFingerprint, plan: string,
  prior: readonly NativePlanQuestionCall[]): boolean {
  const call = fp.nativeCall!, q = call.questions[0]!;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s.replace(/\*\*/g, '')).replace(/^(?:[1-9]\d*)?[A-Z][).:]\s*/, '').replace(/\s*\((?:recommended|optional)\)$/i, '');
  if (q.multiSelect || !/^Next(?: steps?)?$/i.test(navigationHeader(q)) || q.options.length !== 2 || fp.options.length !== 2 ||
      !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) || !hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const ready = q.options.find(o => /^Ready to implement(?:\s*[,—–-]\s*run \/ship when done)?$/i.test(label(o.label)));
  const pause = q.options.find(o => /^Pause here(?:, no further action this session)?$/i.test(label(o.label)));
  if (!ready || !pause || !q.options.some(o => o.label === call.answers?.[q.question])) return false;
  const context = [q.question, ...q.options.map(o => `${o.label}\n${o.description ?? ''}`)].join('\n');
  const currentText = (s: string) => s.replace(/(?:^|\n)(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gmi, '');
  const status = currentText(context).replace(/["“”'‘’]/g, '');
  const positive = currentText(q.question).replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  const eng = '(?:(?:the |this )?(?:eng(?:ineering)? review|eng gate)|the review|this review|all required reviews)';
  const complete = '(?:clear(?:ed)?|complete[d]?|done|finished)';
  const incomplete = new RegExp(`\\b${eng}\\b[^.!?;\\n]{0,100}\\b(?:not|never|incomplete|unfinished|pending|withdrawn|revoked|superseded|cancelled|canceled|reopened)\\b|\\b${eng}\\s+(?:will|would|may|might|could|should) (?:be )?${complete}\\b|\\b${eng}\\b[^.!?;\\n]{0,100}\\b${complete}\\b[^.!?;\\n]{0,80}\\b(?:if|when|once|unless|provided|assuming|after)\\b|\\b(?:if|when|once|unless|provided|assuming)\\b[^.!?;\\n]{0,80}\\b${eng}\\b`, 'i');
  if (!/^D[1-9]\d*\s*[—–:-]\s*Next steps? after this eng(?:ineering)? review\?/i.test(positive) ||
      !new RegExp(`\\b${eng} (?:is |has been )?${complete}\\b`, 'i').test(positive) ||
      !/\b(?:(?:every decision is|all decisions are) (?:answered|settled)|(?:0|no) unresolved decisions)\b/i.test(positive) ||
      !/\b(?:navigation|routing) only\b/i.test(positive) ||
      !/\b(?:approves?|authorizes?) no (?:new )?implementation changes?\b/i.test(positive) ||
      /(?:^|\n)\s*>|`{3}|~{3}|\b(?:example|sample|quoted|historical)\s*:/i.test(context) || incomplete.test(status) ||
      /\bnot (?:all|every) decisions?\b|\bdecisions?\s+(?:(?:is|are|remains?)\s+|status:\s*)?(?:still )?(?:unanswered|unresolved|pending|reopened|not answered|not settled|open)\b/i.test(status)) return false;

  const published: string[] = [], hierarchy: { depth: number; inactive: boolean }[] = [];
  let fence: string | undefined, preceding = '';
  for (const line of plan.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) { if (!fence) fence = mark[1]; else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined; continue; }
    if (fence || /^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) { while (hierarchy.at(-1) && hierarchy.at(-1)!.depth >= h[1]!.length) hierarchy.pop(); hierarchy.push({depth:h[1]!.length,inactive:introducesSourceContext(preceding) || /\b(?:history|historical|archived?|example|quoted|template|withdrawn|superseded)\b/i.test(h[2]!)}); }
    if (line.trim()) preceding = line;
    if (!hierarchy.some(h => h.inactive)) published.push(line);
  }
  if (fence) return false;
  const current = published.join('\n');
  const titles = [...current.matchAll(/^# Plan: (.+) \(reviewed\)$/gm)];
  const owners = [...current.matchAll(/^Reviewed target: `([^`\n]+\.md)` \("Plan: ([^"\n]+)"\) in repo `([^`\n]+)`, branch `([^`\n]+)`, commit `[a-f0-9]+`\.$/gm)];
  if (titles.length !== 1 || owners.length !== 1 || titles[0]![1] !== owners[0]![2]) return false;
  const metadata = `Project/branch/task: ${owners[0]![3]} on ${owners[0]![4]}, reviewing ${owners[0]![1]} (${owners[0]![2]}).`;
  const sameOwner = (text: string) => {
    const found = text.split('\n').filter(s => /^Project\/branch\/task:/.test(s));
    if (found.length !== 1) return false;
    if (found[0] === metadata) return true;
    const value = found[0]!.slice('Project/branch/task: '.length);
    const paths = [...value.matchAll(/[^\s,;"“”()]+\.md\b/g)].map(m => m[0]);
    const namedRepos = [...value.matchAll(/\brepo(?:sitory)?[ :]+`?([\w./-]+)`?/gi)].map(m=>m[1]);
    return value.startsWith(`${owners[0]![4]} branch`) && /^(?:$|[ ,;])/.test(value.slice(`${owners[0]![4]} branch`.length)) &&
      namedRepos.every(repo=>repo===owners[0]![3]) && paths.length > 0 && paths.every(path => path === owners[0]![1]) &&
      (!/PLAN\.md ["“]/.test(value) || value.includes(`PLAN.md "${owners[0]![2]}"`)) &&
      !/\b(?:other|another|foreign|different|quoted|historical) (?:branch|repo|project|plan)\b/i.test(value);
  };
  if (!sameOwner(q.question) || prior.some(c => c.questions.length !== 1 || !sameOwner(c.questions[0]!.question))) return false;
  const section = (heading: RegExp) => {
    const starts = published.flatMap((line, i) => heading.test(line) ? [i] : []);
    if (starts.length !== 1) return undefined;
    const start = starts[0]!, end = published.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    return published.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  const ledger = section(/^## Decision ledger$/), tasks = section(/^## Implementation Tasks$/), graph = section(/^## Worktree parallelization strategy$/), report = section(/^## GSTACK REVIEW REPORT$/);
  if (!ledger || !tasks || !graph || !report || report.trim().split('\n').at(-1) !== 'NO UNRESOLVED DECISIONS' || incomplete.test(report) || /\b[1-9]\d* unresolved decisions?\b/i.test(report) ||
      report.split('\n').filter(s => /^\| Eng Review \|/.test(s)).length !== 1 ||
      !/^\| Eng Review \|[^\n]*\| CLEAR(?: \([^\n|]*\))? \|[^\n]*\b0 critical gaps\b/m.test(report) ||
      report.split('\n').filter(s => /^(?:- )?\*\*VERDICT:\*\*/.test(s)).length !== 1 ||
      !/^(?:- )?\*\*VERDICT:\*\* ENG CLEARED\b/m.test(report)) return false;
  const finalId = /^(D[1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
  const approvals = prior.map(c => ({call:c,q:c.questions[0]!,id:/^(D[1-9]\d*)\s*[—–:-]/.exec(c.questions[0]!.question)?.[1],selected:c.answers![c.questions[0]!.question]!}));
  if (!finalId || approvals.some(a => !a.id || a.id === finalId) || new Set(approvals.map(a => a.id)).size !== approvals.length) return false;
  const selectedLetter = (a: typeof approvals[number]) => {
    const explicit = /^(?:[1-9]\d*)?([A-Z])[).:]\s/.exec(a.selected)?.[1];
    const named = [...a.q.question.matchAll(/^([A-Z])\) (.+)$/gm)].filter(m => label(m[2]!.replace(/\s+\(human:.*$/, '')) === label(a.selected));
    const recommendation = [...a.q.question.matchAll(/^Recommendation: ([A-Z]) because\b/gm)];
    return explicit ?? (named.length === 1 ? named[0]![1]! : /\(recommended\)$/i.test(a.selected) && recommendation.length === 1 ? recommendation[0]![1] : String.fromCharCode(65 + a.q.options.findIndex(o => o.label === a.selected)));
  };
  if (approvals.some(a => !selectedLetter(a))) return false;
  const initialScope = (a: typeof approvals[number]) => {
    const text = a.q.question;
    const otherRemediesPending = /\b(?:remedies|coverage)\b[^\n]*(?:pending|own decision|own sections)/i.test(text);
    const scopeOnly = /\b(?:this question is scope only|this question chooses structure only)\b/i.test(text);
    const chosen = a.q.options.find(o=>o.label===a.selected)?.description ?? '';
    // This exception chooses only scope/structure. A selected current approval
    // of a remedy cannot borrow the question's pending-remedies disclaimer.
    const optionClaims = chosen.replace(/"[^"\n]*"|“[^”\n]*”/g,'').split(/[✅❌\n]|[.!?;]\s+|\bCorrection:\s*/i);
    const bundledApproval = optionClaims.some(statement => {
      if (/^\s*(?:If|Unless|When|Once|Assuming|Historically|Previously|Example:)\b/i.test(statement)) return false;
      return statement.split(/\s+(?:but|however|and(?: then)?)\s+/i).some(clause => {
        const claim = clause.trim().replace(/^(?:also|instead)\s+/i,'');
        return /^(?:(?:(?:this|the|that|selected) (?:option|choice)|we|it)\s+)?(?:approves?|accepts?|authorizes?|fix(?:es)?|implements?)\b/i.test(claim) &&
          /\b(?:remed(?:y|ies)|regression|invalidation|error handling|performance fix)\b/i.test(claim);
      });
    });

    const structural = /\bclass arrangement\b/i.test(text.split('\n')[0]!) && /\b[2-9]\d* new classes\b/i.test(text) &&
      a.q.options.some(o => /^[1-9]\d* classes?/.test(o.label));
    const cut = /\b(?:keep|split|defer)\b/i.test(text.split('\n')[0]!) &&
      a.q.options.some(o => /\b(?:defer|follow-up)\b/i.test(o.label)) &&
      a.q.options.some(o => /\b(?:keep|rewrite|bundle)\b/i.test(o.label));
    return sameOwner(text) && scopeOnly && otherRemediesPending && !bundledApproval && (structural || cut) &&
      !/\b(?:also|now) (?:approve|accept|implement) (?:the )?(?:regression|cache|error|performance)/i.test(text);
  };
  const scopeAgrees = (a: typeof approvals[number], scope: string): boolean => {
    if (introducesSourceContext(scope) || /^(?:[>\"“]|Earlier|History|Historical|Previous)\b/.test(scope)) return false;
    const value = scope.replace(/`/g,'');
    const selected = a.q.options.find(o=>o.label===a.selected)!;
    if (/\b(?:defer|follow-up)\b/i.test(selected.label)) {
      const functions = [...a.q.question.split('\n')[0]!.matchAll(/\b([A-Za-z]\w*)\(\)/g)].map(m=>m[1]!);
      if (new Set(functions).size !== 1) return false;
      const fn = escape(functions[0]!)+'\\(\\)';
      return new RegExp(`\\bthis PR does not (?:modify|rewrite|change) ${fn}`).test(value) &&
        /\b(?:rewrite|swap)(?:\/swap)? moves to a follow-up PR\b/.test(value) &&
        !new RegExp(`\\b(?:this PR|we) (?:now )?(?:modif(?:y|ies)|rewrites?|changes?) ${fn}`).test(value) &&
        !/\b(?:follow-up|deferral|rewrite|swap) (?:is |has been |remains )?(?:cancelled|canceled|withdrawn|not deferred)|\b(?:do not|don't|never) defer\b/i.test(value);
    }
    const count = /^([1-9]\d*) classes? \+ ([1-9]\d*) functions?\b/.exec(selected.label);
    const retained = /\b([A-Z]\w*(?:, [A-Z]\w*)+) as classes\b/.exec(selected.description ?? '')?.[1]?.split(', ');
    const scoped = /([A-Z]\w*(?:, [A-Z]\w*)+) as classes\b/.exec(value)?.[1]?.split(', ');
    const policy = /\b([A-Z]\w*) as a pure function\b/.exec(a.q.question.split('\n')[0]! )?.[1];
    const absorbed = /\b([A-Z]\w*) folded into ([A-Z]\w*)\b/.exec(a.q.question.split('\n')[0]!);
    return Boolean(count && count[2]==='1' && retained && scoped && +count[1]! === retained.length &&
      new Set(scoped).size===retained.length && retained.every(name=>scoped.includes(name)) && policy && absorbed &&
      new RegExp(`\\b${policy} implemented as pure function [A-Za-z]\\w*\\(`).test(value) &&
      new RegExp(`\\b${absorbed[1]} not created[;,.][^\\n]*\\babsorbed by ${absorbed[2]}\\b`).test(value) &&
      /\bcache adapter contract unchanged\b/.test(value) &&
      !new RegExp(`\\b(?:${policy}|${absorbed[1]}) (?:is |remains |has |now )*(?:a class|stateful|independent state|created)\\b`).test(value) &&
      !/\b(?:do not|not|never|no longer) (?:preserve|retain|absorb)|\badapter contract (?:is )?(?:changed|modified|replaced)\b/i.test(value));
  };
  const firstRemedy = approvals.findIndex(a => !/^(?:Routing|Learnings|Cross-project)$/i.test(a.q.header) && !initialScope(a));
  const revoked = /\b(?:[DRT][1-9]\d*|approval|decision|scope|task|TODO|routing rules)(?: (?:decision|scope|state|approval|task))?\s*(?::|is|was|has been|remains)?\s*(?:now |still )?(?:withdrawn|revoked|cancelled|canceled|rejected|reopened|superseded|not approved|no longer approved|pending approval|pending|unanswered|unresolved)\b/i;
  if ([status, currentText(current), ...approvals.map(a => currentText(a.q.question))].some(s => revoked.test(s.replace(/["“”'‘’]/g, '')))) return false;
  const rows = ledger.split(/\n(?=### )/).filter(s => /^### R[1-9]\d*:/.test(s.trim()));
  const rowIds = rows.map(s => /^### (R[1-9]\d*):/.exec(s.trim())![1]!);
  if (!rows.length || new Set(rowIds).size !== rows.length ||
      ledger.split(/\n(?=### )/).filter(row => !/^### (?:R[1-9]\d*:|TODO decision \(D[1-9]\d*\))/.test(row.trim())).some(row => /^State:/m.test(row))) return false;
  const owned = new Map<string, string>();
  const rowLetters = new Map<string, string>();
  for (const row of rows) {
    const states = [...row.matchAll(/^State: (.+)$/gm)], ids = [...row.matchAll(/^Question (D[1-9]\d*):(?: .*|)$/gm)];
    // An explicit past dispatch annotation can accompany exactly one current
    // state. Duplicate current states and contradictory updates stay invalid.
    if (states.filter(s => s[1] === 'approved').length !== 1 || states.length > 2 ||
        states.some(s => s[1] !== 'approved' && s[1] !== 'approved (was pending at dispatch; see Actual answer)') || ids.length !== 1) return false;
    const id = ids[0]![1]!, a = approvals.find(a => a.id === id);
    const answers = [...row.matchAll(/^Actual answer: (.+)$/gm)];
    const answer = answers.length === 1 ? /^(?:\*\*)?([A-Z]) [—–-] (?:"(.+)"|(.+?)\*\*) \((?:answer to (D[1-9]\d*)|(D[1-9]\d*) answer)\)\.?$/.exec(answers[0]![1]!) : null;
    const selector = a && initialScope(a) && (firstRemedy < 0 || approvals.indexOf(a) < firstRemedy);
    const acceptedScope = [...row.matchAll(/^Accepted scope: (.+)$/gm)];
    if (selector && (acceptedScope.length !== 1 || !scopeAgrees(a,acceptedScope[0]![1]!))) return false;
    if (!a || owned.has(id) || !answer || (!selector && answer[1] !== selectedLetter(a) || selector && !new RegExp(`^${answer[1]}\\) ${escape(a.selected)}$`, 'm').test(row)) || (answer[4] ?? answer[5]) !== id || label(answer[2] ?? answer[3]!) !== label(a.selected) ||
        !selector && row.split(a.q.question).length !== 2 || row.split('\n').filter(s => /^Accepted scope: \S/.test(s)).length !== 1) return false;
    const payload = selector ? row.slice(row.indexOf('Question ')) : row.slice(row.indexOf(a.q.question) + a.q.question.length);
    const headers = [...payload.matchAll(/^Header: (.+)$/gm)], optionFields = [...payload.matchAll(/^Options:\s*$/gm)];
    if (headers.length !== 1 || headers[0]![1] !== a.q.header || optionFields.length !== 1) return false;
    const optionText = payload.slice(optionFields[0]!.index! + optionFields[0]![0].length).split(/\n(?:State|Actual answer|Accepted scope|History):/)[0]!;
    const offered = [...optionText.matchAll(/^([A-Z])\) (.+)\n?([\s\S]*?)(?=^[A-Z]\) |$(?![\s\S]))/gm)];
    if (offered.length !== a.q.options.length || new Set(offered.map(o=>o[1])).size !== offered.length ||
        new Set(offered.map(o=>o[2])).size !== offered.length || offered.some(o => {
          const native = a.q.options.find(n=>n.label===o[2]);
          return !native || !selector && compact(o[3]!) !== compact(native.description ?? '');
        })) return false;
    owned.set(id, rowIds[rows.indexOf(row)]!); rowLetters.set(id, answer[1]!);
  }
  const readiness = ledger.split('\n').filter(s => /^(?:\*\*)?Approval readiness:/.test(s));
  if (readiness.length !== 1 || !/^Approval readiness: PASS(?:\.| —)/.test(readiness[0]!.replace(/\*\*/g,''))) return false;
  for (const ref of readiness[0]!.matchAll(/\b(D[1-9]\d*) → ([A-Z])/g)) {
    const a = approvals.find(a => a.id === ref[1]);
    if (!a || selectedLetter(a) !== ref[2]) return false;
  }
  const readyRows = [...readiness[0]!.matchAll(/\b(R[1-9]\d*) \((D[1-9]\d*)(?: →|:) ([A-Z])\)/g)];
  if (readyRows.length !== rows.length || new Set(readyRows.map(r => r[1])).size !== rows.length ||
      readyRows.some(r => owned.get(r[2]!) !== r[1] || rowLetters.get(r[2]!) !== r[3])) return false;

  const maintenance = /Routing rules \((D[1-9]\d*)\) and TODOS\.md \((D[1-9]\d*)\) still need writing once plan mode exits/i.exec(context);
  const routing = approvals.find(a => a.q.header === 'Routing'), todo = approvals.find(a => a.q.header === 'TODO');
  if (!routing || !todo || !/^Add routing rules(?: to CLAUDE\.md)?$/.test(label(routing.selected)) ||
      label(todo.selected) !== 'Add to TODOS.md' || !/CLAUDE\.md/.test(routing.q.question) || !/TODOS\.md/.test(todo.q.question)) return false;
  if (maintenance) {
    if (routing.id !== maintenance[1] || todo.id !== maintenance[2] ||
        !new RegExp(`^- \\*\\*${routing.id}\\*\\* routing rules in CLAUDE\\.md → ${selectedLetter(routing)} \\(add\\)\\.`, 'm').test(ledger)) return false;
    const todos = section(/^## TODOS\.md \(not persisted in plan mode; write after exit\)$/);
    const todoRows = ledger.split(/\n(?=### )/).filter(s => new RegExp(`^### ${todo.id}: TODO [—–-]`).test(s.trim()));
    const subject = /^D[1-9]\d*\s*[—–:-]\s*Capture "([^"\n]+)" as a TODO\?/.exec(todo.q.question)?.[1];
    if (!todos || !subject || todoRows.length !== 1 || !new RegExp(`^Actual answer: \\*\\*${selectedLetter(todo)} [—–-] Add to TODOS\\.md\\.\\*\\*`, 'm').test(todoRows[0]!) ||
        !new RegExp(`^- \\*\\*${escape(subject)}\\*\\* \\(${todo.id} → ${selectedLetter(todo)}\\)$`, 'mi').test(todos)) return false;
  } else {
    const todoRows = ledger.split(/\n(?=### )/).filter(s => new RegExp(`^### TODO decision \\(${todo.id}\\)`).test(s.trim()));
    if (todoRows.length !== 1 ||
        !new RegExp(`^State: approved\\. Actual answer: ${selectedLetter(todo)} — "${escape(todo.selected)}" \\(answer to ${todo.id}\\)\\. Accepted scope: [^\\n]+$`, 'm').test(todoRows[0]!) ||
        !new RegExp(`^### TODO item \\(accepted ${todo.id}; \\*\\*not persisted\\*\\*`, 'm').test(current) ||
        !/deferred CLAUDE\.md\/TODOS\.md writes happen right after plan mode exits/i.test(context) ||
        !/Deferred CLAUDE\.md routing rules and TODOS\.md entry stay unwritten/i.test(context)) return false;
  }
  for (const a of approvals.filter(a => !owned.has(a.id!) && a !== todo)) {
    const setup = ledger.split('\n').filter(line => /^Setup questions \(not remedies\):/.test(line));
    const saved = [...ledger.matchAll(new RegExp(`^- \\*\\*${a.id}\\*\\* [^\\n]*?→ (?:\\*\\*)?([A-Z])(?=[ :(.])`, 'gm')), ...setup.flatMap(line => [...line.matchAll(new RegExp(`\\b${a.id} [^.;]*?→ ([A-Z])(?= \\()`, 'g'))])];
    if (saved.length !== 1 || saved[0]![1] !== selectedLetter(a)) return false;
  }

  const entries = [...tasks.matchAll(/^- \[ \] \*\*(T[1-9]\d*)\b[^\n]*?\*\* [—–-] (.+?) [—–-] (.+)$/gm)];
  const ids = entries.map(e => e[1]!);
  if (!entries.length || new Set(ids).size !== ids.length) return false;
  for (const ref of context.matchAll(/\bT([1-9]\d*)(?:\s*(?:[–-]|through|to)\s*T([1-9]\d*))?\b/g)) {
    const first = +ref[1]!, last = +(ref[2] ?? ref[1])!;
    if (last < first || last - first >= ids.length) return false;
    for (let n = first; n <= last; n++) if (!ids.includes(`T${n}`)) return false;
  }
  const action = /(?:^|[.!?;]\s+|\n|[✅❌]\s*|["“'‘]\s*|\b(?:and|but|also|first|then|now|next|while|before (?:implementation|building|review))\s+)(?:please\s+)?(?:adds?|adding|append(?:s|ing)?|remov(?:e|es|ing)|delet(?:e|es|ing)|cut(?:s|ting)?|drop(?:s|ping)?|replac(?:e|es|ing)|rewrit(?:e|es|ing)|chang(?:e|es|ing)|alter(?:s|ing)?|modif(?:y|ies|ying)|enabl(?:e|es|ing)|disabl(?:e|es|ing)|implement(?:s|ing)?|install(?:s|ing)?|introduc(?:e|es|ing)|build(?:s|ing)?|writ(?:e|es|ing)|record(?:s|ing)?|captur(?:e|es|ing)|creat(?:e|es|ing)|switch(?:es|ing)?|migrat(?:e|es|ing)|externaliz(?:e|es|ing)|refactor(?:s|ing)?|expand(?:s|ing)?|reduc(?:e|es|ing)|deploy(?:s|ing)?|approv(?:e|es|ing))\b/i;
  // A lane recap binds the published step graph rather than inventing a second
  // ordering of task IDs. Every task remains in the catalog; each dependency
  // must precede its consumer, including dependencies within a serial lane.
  const laneOrder = /\blanes ([A-Z](?:\s*[-/+,]\s*[A-Z])*)\s+(?:can start )?in parallel(?: worktrees)?, then ([A-Z])\b/i.exec(context);
  if (laneOrder) {
    const steps = [...graph.matchAll(/^\| ([A-Z][1-9]\d*) ([^|\n]+) \| ([^|\n]+) \| ([^|\n]+) \|$/gm)];
    const stepIds = steps.map(step => step[1]!);
    const lanes = [...graph.matchAll(/\bLane ([A-Z]): ([A-Z][1-9]\d*(?: → [A-Z][1-9]\d*)*) \(([^)]+)\)/g)];
    if (!steps.length || new Set(stepIds).size !== steps.length || !lanes.length || new Set(lanes.map(l => l[1])).size !== lanes.length) return false;
    const range = /^([A-Z])-([A-Z])$/.exec(laneOrder[1]!.replace(/\s/g,''));
    if (range && (range[2]! < range[1]! || range[2]!.charCodeAt(0)-range[1]!.charCodeAt(0)>=lanes.length)) return false;
    const parallel = range ? Array.from({length:range[2]!.charCodeAt(0)-range[1]!.charCodeAt(0)+1},(_,i)=>String.fromCharCode(range[1]!.charCodeAt(0)+i)) : laneOrder[1]!.split(/\s*[/+,]\s*/);
    const orderedLanes = [...parallel,laneOrder[2]!];
    if (new Set(orderedLanes).size !== lanes.length || lanes.some(l => !orderedLanes.includes(l[1]!))) return false;
    const positions = new Map<string,[number,number]>();
    for (const lane of lanes) for (const [i,id] of lane[2]!.split(' → ').entries()) {
      if (!stepIds.includes(id) || positions.has(id)) return false;
      positions.set(id,[parallel.includes(lane[1]!) ? 0 : 1,i]);
    }
    if (positions.size !== steps.length) return false;
    const earlier = (a:string,b:string) => { const x=positions.get(a),y=positions.get(b); return Boolean(x&&y&&(x[0]<y[0] || x[0]===y[0] &&
      lanes.some(l=>l[2]!.split(' → ').includes(a)&&l[2]!.split(' → ').includes(b)) && x[1]<y[1])); };
    for (const step of steps) {
      const deps = /^[—–-]$/.test(step[4]!) ? [] : step[4]!.split(/,\s*/);
      if (new Set(deps).size !== deps.length || deps.some(dep => !earlier(dep,step[1]!))) return false;
    }
    // Task-module identity is independent of its T ordinal. Auxiliary artifacts
    // explicitly tied to catalog tasks or the acknowledged TODO are retained.
    for (let i=0;i<entries.length;i++) {
      const body=tasks.slice(entries[i]!.index!,entries[i+1]?.index??tasks.length);
      const module=entries[i]![2]!;
      const direct=steps.filter(step=>step[3]!.split(/,\s*/).some(m=>m.replace(/ \([^)]*\)$/,'')===module));
      const sameFiles = /^  - Files: same as (T[1-9]\d*(?:, T[1-9]\d*)*)$/m.exec(body);
      const references = sameFiles?.[1]?.split(', ') ?? [];
      if (!direct.length && !(references.length && references.every(id=>id!==entries[i]![1] && ids.includes(id) &&
          steps.some(step=>step[3]!.split(/,\s*/).some(m=>m.replace(/ \([^)]*\)$/,'')===entries.find(e=>e[1]===id)![2])))) &&
          !(module==='repo' && body.includes('TODOS.md') && body.includes(todo.id!))) return false;
    }
    const actions=currentText(context).replace(laneOrder[0],'')
      .replace(/\b(?:approves?|authorizes?) no (?:new )?implementation changes?\b/gi,'');
    return !action.test(actions) && !/\b(?:new|additional|extra) (?:work|implementation|scope|task|requirement|dependency|feature|datastore|database|cache|test|prerequisite)\b|\b(?:must|shall|should|needs? to|required to|depends on)\s+\S|\b(?:only|skip|drop|omit) (?:the )?tasks?\b/i.test(actions) &&
      !/\brun\s+(?!\/ship\b)/i.test(actions.replace(/\byou can run (?:any )?(?:other|another|optional) review later\b/gi,''));
  }
  const orders = [...context.matchAll(/\b(?:order the plan specifies|published task order) \(([^)]+)\)/gi)];
  if (orders.length !== 1) return false;
  const groups: string[][] = [];
  for (const raw of orders[0]![1]!.split(/,?\s*then\s+|\s*→\s*|\s*->\s*/i)) {
    const group = raw.trim().replace(/,?\s+(?:(?:in )?parallel|last)$/i, '');
    if (!/^T[1-9]\d*(?:\s*[+/]\s*T[1-9]\d*)*$/.test(group)) return false;
    groups.push(group.split(/\s*[+/]\s*/));
  }
  const ordered = groups.flat(), included = new Set(ordered);
  if (!ordered.length || included.size !== ordered.length || ids.slice(0, ordered.length).some(id => !included.has(id))) return false;
  const bodyFor = (i: number) => tasks.slice(entries[i]!.index!, entries[i + 1]?.index ?? tasks.length);
  // Auxiliary catalog entries remain obligations: a prerequisite explicitly tied
  // to a recapped task, or work in each implementation commit, is not dropped.
  if (entries.slice(ordered.length).some((e, j) => {
    const body = bodyFor(ordered.length + j), before = /^  - Verify: .+ before (T[1-9]\d*) merges$/m.exec(body);
    return !(before && included.has(before[1]!)) && !/^  - Verify: .+ in the same commit$/m.test(body);
  })) return false;
  const steps = [...graph.matchAll(/^\| (S[1-9]\d*) ([^|\n]+) \| ([^|\n]+) \| ([^|\n]+) \|$/gm)];
  const stepIds = steps.map(s => s[1]!);
  if (!steps.length || new Set(stepIds).size !== steps.length || !/^\| Step \| Modules touched \| Depends on \|$/m.test(graph)) return false;
  const module = (s: string) => compact(s.replace(/`/g, '').replace(/\s*\([^)]*\)/g, '')).replace(/\/$/, '');
  const stepModules = steps.map(s => s[3]!.split(',').map(module));
  const deps = steps.map(s => /^[—–-]$/.test(s[4]!) ? [] : s[4]!.split(/,\s*/));
  if (deps.some((d, i) => new Set(d).size !== d.length || d.some(id => !stepIds.includes(id) || stepIds.indexOf(id) >= i))) return false;
  // Task/module and step/module fields bind the two independently numbered
  // catalogs. Require a unique contiguous partition; shared paths alone cannot
  // choose between ambiguous steps. No semantic caption guessing is involved.
  const mappings: number[][] = [];
  const assign = (at: number, step: number, mapping: number[]) => {
    if (mappings.length > 1) return;
    if (at === ordered.length) { if (step === steps.length - 1) mappings.push(mapping); return; }
    for (const next of at === 0 ? [0] : [step, step + 1]) {
      if (next >= steps.length || !entries[at]![2]!.split(/\s+\+\s+/).map(module).every(m => stepModules[next]!.includes(m))) continue;
      assign(at + 1, next, [...mapping, next]);
    }
  };
  assign(0, 0, []);
  if (mappings.length !== 1) return false;
  const mapped = new Map(ids.slice(0, ordered.length).map((id, i) => [id, mappings[0]![i]!]));
  const positions = steps.map(() => [] as number[]);
  for (let i = 0; i < groups.length; i++) {
    const members = groups[i]!.map(id => mapped.get(id)!);
    if (new Set(members).size !== members.length) return false;
    for (const s of members) positions[s]!.push(i);
  }
  if (deps.some((d, i) => d.some(id => Math.max(...positions[stepIds.indexOf(id)]!) >= Math.min(...positions[i]!)))) return false;
  for (let i = 0; i < ordered.length; i++) {
    const id = ids[i]!, pos = groups.findIndex(g => g.includes(id));
    for (const m of bodyFor(i).matchAll(/\bafter (T[1-9]\d*) (?:is )?green\b/gi)) if (!included.has(m[1]!) || groups.findIndex(g => g.includes(m[1]!)) >= pos) return false;
  }
  let actions = currentText(context).replace(orders[0]![0], '').replace(maintenance[0], '')
    .replace(/\b(?:this question|this choice) (?:approves?|authorizes?) no (?:new )?implementation changes?\b/gi, '');

  return !action.test(actions) && !/\brun\s+(?!\/ship\b)|\b(?:new|additional|extra) (?:work|implementation|scope|task|requirement|dependency|feature|datastore|database|cache|test|prerequisite)\b|\b(?:must|shall|should|needs? to|required to|depends on)\s+\S|\b(?:only|skip|drop|omit) (?:the )?tasks?\b/i.test(actions);
}

/** A published author prerequisite remains required even when other lanes may
 * start. A later current waiver cannot borrow the earlier blocked schedule. */
function hasWithdrawnPrerequisite(text: string): boolean {
  return /\b(?:author input|responsibility|prerequisite|condition)\b[^.;\n]{0,80}\b(?:waived|withdrawn|revoked|cancelled|canceled|optional|not required|no longer required|can be skipped)\b/i.test(text);
}

/** Navigation reads table roles, not the writer's six-column presentation.
 * This does not replace the report/terminal checks or supply seed coverage. */
function hasReadyReviewRow(report: string): boolean {
  const lines = report.split('\n'), cells = (line: string) => line.trim().slice(1, -1).split('|').map(s => s.trim());
  const headers = lines.flatMap((line, i) => /^\|.*\|$/.test(line) && cells(line).some(c => /^Review$/i.test(c)) ? [i] : []);
  if (headers.length !== 1) return false;
  const at = headers[0]!, header = cells(lines[at]!), separator = lines[at + 1];
  const role = (name: RegExp) => header.flatMap((cell, i) => name.test(cell) ? [i] : []);
  const roles = [role(/^Review$/i), role(/^Runs$/i), role(/^Status$/i), role(/^(?:Findings|Key finding)$/i)];
  if (roles.some(r => r.length !== 1) || !separator || !/^\|.*\|$/.test(separator) ||
      cells(separator).length !== header.length || cells(separator).some(c => !/^:?-+:?$/.test(c))) return false;
  const rows: string[][] = [];
  for (let i = at + 2; i < lines.length && /^\|.*\|$/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
  if (rows.some(row => row.length !== header.length)) return false;
  const eng = rows.filter(row => row[roles[0]![0]!] === 'Eng Review');
  return eng.length === 1 && lines.filter(line => /^\|.*\|$/.test(line) && cells(line)[roles[0]![0]!] === 'Eng Review').length === 1 &&
    /^CLEAR(?: \([^\n|]*\))?$/.test(eng[0]![roles[2]![0]!]!) &&
    /^[1-9]\d*(?: runs?)?$/.test(eng[0]![roles[1]![0]!]!) &&
    /\b0 critical gaps\b/.test(eng[0]![roles[3]![0]!]!) && !/\b[1-9]\d* critical gaps?\b/.test(eng[0]![roles[3]![0]!]!);
}

/** The count in a menu refers to saved dispositions, never newly invented work. */
function hasRecordedTodoEntries(published: readonly string[], prior: readonly NativePlanQuestionCall[], count: number): boolean {
  const starts = published.flatMap((line, i) => /^## TODOS\.md updates\b/.test(line) ? [i] : []);
  if (starts.length !== 1) return false;
  const at = starts[0]!, end = published.findIndex((line, i) => i > at && /^## /.test(line));
  const section = published.slice(at + 1, end < 0 ? undefined : end).join('\n');
  const entries = [...section.matchAll(/^\*\*TODO ([1-9]\d*) [—–-] (.+)\*\* \((D[1-9]\d*): add\)\n([^]*?)(?=^\*\*TODO |$(?![\s\S]))/gm)];
  const calls = prior.filter(c => /^D[1-9]\d* [—–-] TODO:/.test(c.questions[0]!.question));
  if (entries.length !== count || calls.length !== count || new Set(entries.map(e => e[1])).size !== count || new Set(entries.map(e => e[3])).size !== count) return false;
  const action = (s: string) => s.replace(/`/g, '').split(/;|\b(?:where|inside)\b/)[0]!.replace(/\s+/g, ' ').trim();
  // A summary can split a native clause or omit its explanatory tail, but
  // every saved clause must still come from that proposal. The primary action
  // alone cannot authorize an appended action or a different location/actor.
  const words = (s: string) => (s.replace(/`/g, '').replace(/\bfor (?:the same|one) key\b/g, 'for key')
    .match(/[a-z0-9]+(?:\.[a-z0-9]+)*/gi) ?? []).map(w => w.toLowerCase()).filter(w => !['a','the','are','then','afterwards'].includes(w));
  const clausesOwned = (saved: string, native: string) => {
    const offered = native.split(';').map(words), clauses = saved.split(';').map(words);
    return clauses.every(clause => clause.length >= 2 && offered.some(source =>
      source.some((_, i) => clause.every((word, j) => source[i + j] === word))));
  };
  return entries.every(entry => {
    const call = calls.find(c => c.questions[0]!.question.startsWith(entry[3] + ' —'));
    if (!call) return false;
    const q = call.questions[0]!, selected = q.options.find(o => o.label === call.answers![q.question]);
    const native = [...q.question.matchAll(/^What: (.+)$/gm)], saved = [...entry[4]!.matchAll(/^- What: (.+)$/gm)];
    return selected?.label.replace(/^[A-Z]\) /, '').replace(/ \(recommended\)$/, '') === 'Add to TODOS.md' &&
      /\bNo implementation now\./.test(selected.description ?? '') && native.length === 1 && saved.length === 1 &&
      hasTodoTopic(entry[2]!, q.question.split('\n')[0]!) && action(native[0]![1]!) === action(saved[0]![1]!) &&
      clausesOwned(saved[0]![1]!, native[0]![1]!);
  });
}

function hasTodoTopic(summary: string, complete: string): boolean {
  const words = (text: string) => (text.replace(/\b(?:then|after)\b[\s\S]*/i, '').replace(/\+/g, ' and ').match(/[a-z0-9]+(?:\.[a-z0-9]+)*/gi) ?? [])
    .map(w => w.toLowerCase()).filter(w => !['the', 'of', 'in', 'vs', 'against'].includes(w));
  const needed = words(summary), offered = words(complete); let index = 0;
  for (const word of offered) if (word === needed[index]) index++;
  return needed.length >= 3 && index === needed.length;
}

/** Current field ownership is independent of navigation wording. A superseded
 * status is inert only in an explicit History field/child section. */
function hasCompletedOwnedLedger(call: NativePlanQuestionCall, prior: readonly NativePlanQuestionCall[],
  ledger: string, report: string,
  owner?: { source: string; title: string; branch: string; publication?: string }): boolean {
  if (!hasCompleteEarlierNativeAnswers(call, prior)) return false;
  const field = (s: string, name: string) => { const all = [...s.matchAll(new RegExp(`^(?:\\*\\*)?${name}:(?:\\*\\*)? (.+)$`, 'gm'))]; return all.length === 1 ? all[0]![1]! : undefined; };
  const approvals = new Map(prior.map(previous => [/^(D[1-9]\d*)\s*[—–:-]/.exec(previous.questions[0]?.question ?? '')?.[1], previous]));
  const finalOrdinal = /^D([1-9]\d*)\s*[—–:-]/.exec(call.questions[0]!.question)?.[1];
  if (!finalOrdinal || approvals.size !== +finalOrdinal - 1 || Array.from({ length: +finalOrdinal - 1 }, (_, i) => `D${i + 1}`).some(id => !approvals.has(id))) return false;
  const records = ledger.split(/\n(?=### [SRT](?:0|[1-9]\d*):|### Approval readiness:)/).filter(row => (owner ? /^### [SRT](?:0|[1-9]\d*):/ : /^### R[1-9]\d*:/).test(row.trim()));
  const ids = new Set<string>(), answers = new Set<string>(), owned = new Map<string, string>();
  if (!records.length) return false;
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = (s: string) => compact(s).replace(/^[A-Z][).:]\s*/, '').replace(/\s*\(recommended\)$/i, '');
  const selectedLetters = new Map<string, string>();
  const currentNative = (s: string) => s.replace(/^(?:Earlier|Previous|Historical|Example|Quoted)\b[^\n]*:\s*(?:"[^"\n]*"|“[^”\n]*”)\s*$/gm, '').replace(/["“”'‘’]/g, '');
  if (owner) {
    const source = new RegExp(`^Project/branch/task: ${escape(owner.branch)} [—–-] (?:(?:reviewing )?${escape(owner.source)} "${escape(owner.title)}"(?:[;,]|$)|${escape(owner.title)}(?: plan)? \\(${escape(owner.source)}\\)[.,;]|${escape(owner.title)}, ${escape(owner.source)}(?: |,|;|$))`);
    if (records.length !== prior.length || prior.some(c => {
      const metadata = c.questions[0]!.question.split('\n').filter(l => /^Project\/branch\/task:/.test(l));
      return c.questions.length !== 1 || metadata.length !== 1 || !source.test(metadata[0]!) ||
        [...metadata[0]!.matchAll(/[^\s,;"“”()]+\.md\b/g)].some(m => m[0] !== owner.source);
    })) return false;
  }
  for (const record of records) {
    const id = /^### ([SRT](?:0|[1-9]\d*)):/.exec(record.trim())![1]!;
    if (ids.has(id)) return false; ids.add(id);
    // Only History's explicit child section or indented continuation is inert.
    const current = record.replace(/^#### History\n[\s\S]*?(?=^#### |$(?![\s\S]))/gm, '')
      .replace(/^History: [^\n]*(?:\n(?: {2,}|\t)[^\n]*)*/gm, '');
    const state = field(current, 'State'), answer = field(current, 'Actual answer'), scope = field(current, 'Accepted scope');
    // The selected letter is the native option identity; a copied caption is
    // optional, and when present must still match that selected native label.
    const referenced = owner && answer ? /^([A-Z])[).:] (.+?) [—–-] user answer to (D[1-9]\d*)(?: \([^\n]+\))?\.$/.exec(answer) : null;
    const captionReference = owner && answer ? /^([A-Z])(?:(?: [—–-] "(.+)")|(?:[).:] (.+)))? \((D[1-9]\d*) answer(?:, this session)?\)(?: [—–-] [^\n]+)?$/.exec(answer) : null;
    const selection = referenced ?? (captionReference ? ['', captionReference[1], captionReference[2] ?? captionReference[3], captionReference[4]] : null);
    const answered = selection ? ['', selection[2], selection[3]!] : answer && /^"(.+)" \((D[1-9]\d*)\)$/.exec(answer);
    const previous = answered ? approvals.get(answered[2]!) : undefined;
    const questions = [...current.matchAll(/^Question (D[1-9]\d*):(?: (.*))?$/gm)];
    if ((!state || !/^approved(?: \([^\n]+\))?$/.test(state)) || !scope || /^(?:unknown|pending|unanswered|reopened|withdrawn|cancelled|canceled|rejected|revoked|none|not approved)\b/i.test(scope) || !answered || answers.has(answered[2]!) || !previous ||
        (owner ? answered[1] !== undefined && label(previous.answers![previous.questions[0]!.question]!) !== label(answered[1]!) : previous.answers?.[previous.questions[0]!.question] !== answered[1]) ||
        (owner ? !field(current, 'Finding') : !/^Finding: [^\n]*\bPLAN\.md:[1-9]\d*/m.test(current)) ||
        questions.length !== 1 || questions[0]![1] !== answered[2] ||
        /^(?:State|Accepted scope|Actual answer): (?:unknown|pending|unanswered|reopened|withdrawn|cancelled|canceled|rejected|revoked|none|not approved)\b/im.test(current)) return false;
    if (owner) {
      const q = previous.questions[0]!, selected = q.options.find(o => o.label === previous.answers![q.question])!;
      const letter = /^([A-Z])\) /.exec(selected.label)?.[1] ??
        (/\(recommended\)$/i.test(selected.label) ? /^Recommendation: ([A-Z]) because\b/m.exec(q.question)?.[1] : undefined);
      const summary = questions[0]![2];
      // Initial Scope Challenge selectors record the actual answer and accepted
      // scope, before the later full-brief procedure begins. Bind the selected
      // action and its conditions; a summary caption cannot grant this exception.
      const initialSummary = summary !== undefined && /^Scope Challenge (?:initial|structural) selector\b/.test(summary) &&
        new RegExp(`^${answered[2]} \\S`).test(q.header) && prior.slice(0, prior.indexOf(previous)).every(c =>
          /^D[1-9]\d* \S/.test(c.questions[0]!.header) && !/^D[1-9]\d* [—–-] (?:TODO:|Next step)/.test(c.questions[0]!.question));
      const nativeScope = selected.description?.split(/ Effort:/)[0] ?? '';
      const cleanScope = scope.replace(/`/g, '');
      const functionScope = /^(\w+\.ts) exports (\w+\([^)]*\))/.exec(nativeScope);
      const adapterScope = /^Keep (\w+\(\)) signature; its body delegates to (\w+)\./.exec(nativeScope);
      const conditionScope = /one paragraph stating (\w+)'s responsibility, who owns ([\w-]+) logic, and its relationship to (\w+)\./.exec(nativeScope);
      const deferredScope = /^Defer\b/.test(label(selected.label)) && /Refactor stays structural only\./.test(nativeScope) && /separate .*PR .*after, once (.+) exist\./.exec(nativeScope);
      const classes = /New class count (?:drops|falls|reduces) (\d+) to (\d+)\./.exec(nativeScope);
      const initialRole = initialSummary && (
        deferredScope && /\bno (?:IDP )?call ordering or concurrency\b/.test(cleanScope) && /follow-up PR.*after this refactor lands/.test(cleanScope) &&
          cleanScope.includes(deferredScope[1]!) ||
        adapterScope && new RegExp(`${escape(adapterScope[1]!)} keeps its exported signature and callers`).test(cleanScope) &&
          new RegExp(`body delegates to ${escape(adapterScope[2]!)}(?:\\.\\w+\\([^)]*\\))?`).test(cleanScope) && /delete.*follow-up.*after production (?:proves )?equivalence/i.test(cleanScope) ||
        functionScope && classes && cleanScope.startsWith(`${functionScope[1]} exports ${functionScope[2]}`) && /own file.*table(?:-driven)?(?: unit)? tests/.test(cleanScope) &&
          new RegExp(`Class count ${classes[1]} (?:→|to) ${classes[2]}[.;]`).test(cleanScope) ||
        conditionScope && /Class stays pending until written\. Approves no implementation\./.test(nativeScope) &&
          cleanScope.includes(conditionScope[1]!) && /\bresponsibility\b/.test(cleanScope) && cleanScope.includes(conditionScope[2]! + ' ownership') && cleanScope.includes('relationship to ' + conditionScope[3]) &&
          /plan amendment.*required/i.test(cleanScope) && new RegExp(`before any ${escape(conditionScope[1]!)} code`).test(cleanScope) && /No implementation approved\./.test(cleanScope));
      if (initialSummary && (!initialRole || hasWithdrawnPrerequisite(current) || /(?:^|[.;]\s+|\b(?:also|instead|then|now)\s+)(?:add|create|implement|restore|build|rewrite|install|introduce)\b/i.test(cleanScope))) return false;
      if (state !== 'approved' && !(initialRole && conditionScope && state === `approved (as an investigate/define step; ${conditionScope[1]} implementation itself remains pending)`)) return false;
      if (initialRole && deferredScope) {
        const subject = /^D[1-9]\d* (\S+)$/.exec(q.header)?.[1];
        if (!subject || !q.question.includes(subject)) return false;
        const reversal = new RegExp(`\\b${escape(subject)}\\b[^.;\\n]{0,80}\\b(?:stays|remains|kept|included|reintroduced)\\b[^.;\\n]{0,40}\\b(?:refactor|this (?:PR|branch))\\b`, 'i');
        if (reversal.test(current) || reversal.test(report) || reversal.test(currentNative(call.questions[0]!.question)) ||
            prior.some(c => Date.parse(c.answeredAt!) > Date.parse(previous.answeredAt!) && reversal.test(currentNative(c.questions[0]!.question)))) return false;
      }

      // Scope Challenge records actual answers after its initial selectors;
      // unlike substantive briefs it need not save Header/Options fields.
      // Bind the native arrangement's action roles, not a caption alone.
      const arrangement = previous === prior[0] && summary !== undefined &&
        /^D[1-9]\d* [—–-] Complexity gate: /i.test(q.question) && /\b(?:classes|modules|units)\b/i.test(q.question.split('\n')[0]!) &&
        q.options.length >= 2 && q.options.length <= 3;
      const arrangementScope = (text: string) => {
        const value = compact(text.replace(/`/g, '').replace(/\bpure exported function\b/g, 'pure function'));
        if (!/^[\w, ]+ as classes[.;] \w+ becomes (?:a )?pure function \w+\([^)]*\)(?: in a policy module)?[.;] \w+ folds into \w+(?: \(one facade over the one backing adapter\))?\. (?:Structure only; all other remedies stay pending|No other remedy approved by this answer)\.$/.test(value)) return undefined;
        const classes = /^([\w, ]+) as classes[.;]/.exec(value)?.[1]?.split(/,\s*/).sort();
        const functions = [...value.matchAll(/\b(\w+) becomes (?:a )?pure function (\w+\([^)]*\))/g)].map(m => `${m[1]}:${m[2]!.replace(/\s/g, '')}`);
        const folds = [...value.matchAll(/\b(\w+) folds into (\w+)\b/g)].map(m => `${m[1]}:${m[2]}`);
        return classes?.length && functions.length === 1 && folds.length === 1 ? {classes, functions, folds} : undefined;
      };
      const initialArrangement = arrangement && arrangementScope(selected.description ?? '');
      if (arrangement) {
        const title = q.question.split('\n')[0]!.replace(/^D[1-9]\d* [—–-] /, '');
        const offered = q.options.map(o => o.label).join(', ');
        if (!initialArrangement || summary !== title + ' Options ' + offered + '. Structure only; all other remedies stayed pending.' ||
            JSON.stringify(arrangementScope(scope)) !== JSON.stringify(initialArrangement) ||
            !/\bNo other remedy approved by this answer\.$/.test(scope)) return false;
      }
      const disposition = /^D[1-9]\d* TODO$/.test(q.header) && /^D[1-9]\d* [—–-] TODO: /.test(q.question) &&
        summary?.startsWith('TODO question (TODOS-format). Options: ') && /^TODO recorded in ["“][^"”]+["”] below\.$/.test(scope);
      if (!selection || selection[1] !== letter || (field(current, 'Header') !== q.header && !((disposition || arrangement || initialRole) && field(current, 'Header') === undefined)) ||
          /^(?:[>"“'‘]|(?:If|When|Once|Unless|Historical|Example|Quoted)\b)/i.test(scope)) return false;
      const options = [...current.matchAll(/^Options:\s*$/gm)];
      if (options.length !== (disposition || arrangement || initialRole ? 0 : 1)) return false;
      if (disposition) {
        const offered = [...summary!.slice(summary!.indexOf('Options: ') + 9).replace(/\.$/,'').matchAll(/(?:^| )([A-Z])\) (.*?)(?= [A-Z]\) |$)/g)];
        if (label(selected.label) !== 'Add to TODOS' || offered.length !== q.options.length || offered.some((o,i) => o[1] !== String.fromCharCode(65+i) || label(o[2]!) !== label(q.options[i]!.label))) return false;
        // A disposition summary owns the proposal it records, not merely the
        // common Add/Skip/Build menu. Bind its shortened action/topic caption
        // and native What action to one active published proposal.
        const topic = /^### T[1-9]\d*: TODO [—–-] (.+)$/m.exec(current)?.[1];
        const caption = /^D[1-9]\d* [—–-] TODO: (.+)$/m.exec(q.question)?.[1];
        const action = (text: string) => compact(text.replace(/`/g, '').split(/[;(]/)[0]!);
        const nativeWhats = [...q.question.matchAll(/^What: (.+)$/gm)];
        const nativeWhat = nativeWhats.length === 1 ? nativeWhats[0]![1] : undefined;
        const proposals = [...(owner.publication ?? '').matchAll(/^### ([^\n]+)\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gm)]
          .filter(p => !introducesSourceContext((owner.publication ?? '').slice(0,p.index).trimEnd().split('\n').at(-1) ?? '') && topic && hasTodoTopic(topic, p[1]!) && [...p[2]!.matchAll(/^\*\*What:\*\* (.+)$/gm)].length === 1);
        const savedWhat = proposals.length === 1 ? /^\*\*What:\*\* (.+)$/m.exec(proposals[0]![2]!)?.[1] : undefined;
        if (!topic || !caption || !hasTodoTopic(topic, caption) || !nativeWhat || !savedWhat || action(nativeWhat) !== action(savedWhat)) return false;
      } else if (!arrangement && !initialRole) {
        const initialHeader = (h: string) => /^(?:Perf scope|Structure|D[1-9]\d* (?:scope|structure))$/.test(h);
        const initial = initialHeader(q.header) && prior.slice(0, prior.indexOf(previous)).every(c => initialHeader(c.questions[0]!.header));
        // Initial feature-deferral and structure selectors are saved after their
        // answers as scope summaries (review-sections.md.tmpl, Scope Challenge).
        // Their labels and selected scope bind approval; the later substantive
        // brief's verbatim-description contract does not apply to these records.
        const deferredFeature = /^Remove the ([\w.]+) change from this refactor\./.exec(selected.description ?? '')?.[1];
        const keptClasses = /^Keep ([1-9]\d*) classes$/.exec(label(selected.label))?.[1];
        const responsibility = /Plan must add a written responsibility for (\w+) distinct from (\w+)\./.exec(selected.description ?? '');
        const scopeSummary = initial && /^D[1-9]\d* (?:scope|structure)$/.test(q.header) && (
          /^Defer \S/.test(label(selected.label)) && deferredFeature &&
            new RegExp(`^${escape(deferredFeature)}[^.;]* removed from this refactor; follow-up\\b`).test(scope) ||
          keptClasses && responsibility && new RegExp(`^${keptClasses}-class arrangement retained; plan must state ${escape(responsibility[1]!)}'s responsibility distinct from ${escape(responsibility[2]!)} \\(author input pending,`).test(scope));
        if (initial && /^D[1-9]\d* (?:scope|structure)$/.test(q.header) && (!scopeSummary || hasWithdrawnPrerequisite(current))) return false;
        if (scopeSummary && deferredFeature) {
          const reversed = new RegExp(`\\b${escape(deferredFeature)}\\b[^.;\\n]{0,80}\\b(?:stays|remains|kept|included|reintroduced)\\b[^.;\\n]{0,40}\\b(?:refactor|this (?:PR|branch))\\b`, 'i');
          if (reversed.test(current) || reversed.test(report) || reversed.test(currentNative(call.questions[0]!.question)) ||
              prior.some(c => Date.parse(c.answeredAt!) > Date.parse(previous.answeredAt!) && reversed.test(currentNative(c.questions[0]!.question)))) return false;
        }
        const optionText = current.slice(options[0]!.index! + options[0]![0].length).split(/\n(?:\*\*)?(?:State|Actual answer|Accepted scope|History):/)[0]!;
        const offered = [...optionText.matchAll(/^([A-Z])\) (.+)\n([\s\S]*?)(?=^[A-Z]\) |$(?![\s\S]))/gm)];
        if (offered.length !== q.options.length || new Set(offered.map(o => o[1])).size !== offered.length ||
            new Set(offered.map(o => label(o[2]!))).size !== offered.length || offered.some(o => {
              const native = q.options.find(n => label(n.label) === label(o[2]!));
              return !native || !scopeSummary && compact(native.description ?? '') !== compact(o[3]!);
            }) || !offered.some(o => o[1] === letter && label(o[2]!) === label(selected.label))) return false;
        // Initial scope and TODO disposition records can summarize their question.
        // This verifies record ownership, not implementation correctness or seed
        // coverage. Substantive records retain the complete native question.
        const todo = /^TODO: /.test(q.header) && /^D[1-9]\d* [—–-] TODO: /.test(q.question);
        const caption = (s: string) => s.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '').replace(/^\(initial scope selector[^)]*\) /, '').replace(/ Recommendation:.*$/, '').replace(/^"(.*)"$/, '$1').replace(/ \((?:follow-up|from)[^)]*\)/g, '');
        if (summary !== undefined ? !(initial || todo) || caption(summary) !== caption(q.question.split('\n')[0]!) : current.split(q.question).length !== 2) return false;
      }
      selectedLetters.set(answered[2]!, letter!);
    }
    const revoked = new RegExp(`\\b(?:${id}|${answered[2]}|(?:this|the|that) (?:decision|approval|scope))(?:(?: decision| approval| scope| state))?\\s*(?::|is|was|has been|remains)\\s*(?:now |still )?(?:pending|unanswered|reopened|withdrawn|cancelled|canceled|rejected|revoked|not approved|no longer approved)\\b`, 'i');
    if (revoked.test(current) || revoked.test(report) || owner && (revoked.test(currentNative(call.questions[0]!.question)) ||
        prior.some(c => Date.parse(c.answeredAt!) > Date.parse(previous.answeredAt!) && revoked.test(currentNative(c.questions[0]!.question))))) return false;
    answers.add(answered[2]!); owned.set(id, answered[2]!);
  }
  const headingReadiness = [...ledger.matchAll(/^### Approval readiness: (.+)\n([^]*?)(?=^### |^## |$(?![\s\S]))/gm)];
  const readinessFields = [...ledger.matchAll(/^(?:\*\*)?Approval readiness:(?:\*\*)? (.+)$/gm)];
  if (headingReadiness.length + readinessFields.length !== 1) return false;
  const readiness = field(ledger, 'Approval readiness')?.replace(/\*\*/g, '') ?? (headingReadiness.length === 1 ? headingReadiness[0]![1] : undefined);
  const readyRefs = readiness ? [...readiness.matchAll(owner ? /\b([SRT][1-9]\d*) \((D[1-9]\d*)\s*(?:=|→)\s*([A-Z])(?:, [^()\n]+)?\)/g : /\b(R[1-9]\d*) \((D[1-9]\d*)\)/g)] : [];
  const summarizedReadiness = owner && headingReadiness.length === 1 && readiness === 'PASS' &&
    /\bEvery record\b/.test(headingReadiness[0]![2]!) && /\bno record is pending\b/.test(headingReadiness[0]![2]!);
  if (summarizedReadiness) {
    const range = /\bEvery record ([SRT])(0|[1-9]\d*)[–-]([SRT])(0|[1-9]\d*) has\b/.exec(headingReadiness[0]![2]!);
    const decisions = /\bactual answer \(D([1-9]\d*)[–-]D([1-9]\d*)\)/.exec(headingReadiness[0]![2]!);
    if (!range || range[1] !== range[3] || +range[4]! - +range[2]! + 1 !== ids.size ||
        Array.from({length: ids.size}, (_, i) => `${range[1]}${+range[2]! + i}`).some(id => !ids.has(id)) ||
        !decisions || +decisions[1]! !== 1 || +decisions[2]! !== prior.length ||
        /\b(?:[SRT](?:0|[1-9]\d*)|D[1-9]\d*|approval|scope) (?:is|was|has been) (?:revoked|withdrawn|pending|reopened|rejected|cancelled|canceled)\b/i.test(currentNative(headingReadiness[0]![2]!))) return false;
  }
  if (!readiness?.startsWith('PASS') || !summarizedReadiness && (readyRefs.length !== ids.size || new Set(readyRefs.map(r => r[1])).size !== ids.size || readyRefs.some(r => owned.get(r[1]!) !== r[2]!))) return false;
  if (owner && /\b(?:[SRT](?:0|[1-9]\d*)|D[1-9]\d*|approval|scope) (?:is|was|has been) (?:revoked|withdrawn|pending|reopened|rejected|cancelled|canceled)\b/i.test(currentNative(readiness))) return false;
  const counts = [...report.matchAll(/\b(?:all )?([1-9]\d*) decisions (?:approved|answered)\b/g)];
  return !owner || (summarizedReadiness || readyRefs.every(r => selectedLetters.get(r[2]!) === r[3])) &&
    hasReadyReviewRow(report) && counts.length <= 1 && (counts.length === 0 || +counts[0]![1]! === records.length);
}
