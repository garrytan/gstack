/**
 * A /plan-eng-review resume point: the working plan plus the review record the
 * real skill saves (Scope Challenge result, section dispositions and the
 * Decision ledger in review-sections.md's record format), built from actual
 * native AskUserQuestion calls and their actual answers. A checkpoint case
 * hands it to the live skill, which continues at Section 3 (Test review).
 */
export type EngResumeCall = {
  toolUseId: string;
  answeredAt?: string;
  ledgerId: string;
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  answer: string;
};

const SELECTORS = ['A', 'B', 'C', 'D'];
const title = (question: string) => question.split('\n', 1)[0]!.replace(/^D\d+\s*—\s*/, '');

export function engResumeReport(plan: string, calls: EngResumeCall[]): string {
  const ids = calls.map(call => call.ledgerId).join(', ');
  const records = calls.map((call, index) => {
    const selected = call.options.findIndex(option => option.label === call.answer);
    return [
      `### ${call.ledgerId}: ${call.header} — ${title(call.question)}`,
      `Finding: S${index + 1}, Scope Challenge, reviewer: Claude (plan-eng-review)`,
      'Plan baseline: original proposal (Plan: Add Dashboard)',
      `Runtime evidence: as stated in D${index + 1}`,
      'State: approved',
      '',
      'Comparison grid:',
      '',
      `| Choice | Current | ${call.options.map((_, i) => SELECTORS[i]).join(' | ')} |`,
      `|---|---|${call.options.map(() => '---|').join('')}`,
      `| ${call.ledgerId} ${call.header.toLowerCase()} | pending | ${call.options.map(option => option.label).join(' | ')} |`,
      '',
      `Question D${index + 1}:`,
      call.question,
      `Header: ${call.header}`,
      'Options:',
      ...call.options.flatMap((option, i) => [`${SELECTORS[i]}) ${option.label}`, option.description]),
      '',
      `Actual answer: ${SELECTORS[selected]}) ${call.answer} (D${index + 1}${call.answeredAt ? `, answered ${call.answeredAt}` : ''})`,
      `Accepted scope: ${call.options[selected]!.description}`,
      'History: —',
    ].join('\n');
  });
  return [
    plan.trimEnd(),
    '',
    '## Scope Challenge record',
    '',
    'Scope Challenge result: scope accepted as-is (complexity gate skipped: 2 changed files, no new classes/services).',
    `Findings S1–S${calls.length} resolved through D1–D${calls.length}; dispositions: ${ids} approved.`,
    '',
    '## Review progress',
    '',
    `- Scope Challenge: complete (D1–D${calls.length} answered).`,
    `- Section 1, Architecture review: complete. No new or reopened choices; dispositions: ${ids} carried forward.`,
    '- Section 2, Code quality review: complete. No new or reopened choices.',
    '- Next: Section 3, Test review.',
    '',
    '## Decision ledger',
    '',
    records.join('\n\n'),
    '',
  ].join('\n');
}

/** Why a report is not a valid resume point for these calls; empty when it is. */
export function engResumeProblems(report: string, calls: EngResumeCall[]): string[] {
  const problems: string[] = [];
  if (report.split('\n## Decision ledger\n').length !== 2) problems.push('expected exactly one Decision ledger');
  if (!/^Scope Challenge result: scope accepted as-is\b/m.test(report)) problems.push('missing Scope Challenge result');
  for (const section of ['Section 1, Architecture review: complete', 'Section 2, Code quality review: complete', 'Next: Section 3, Test review'])
    if (!report.includes(section)) problems.push(`missing progress: ${section}`);
  const ledger = report.split('\n## Decision ledger\n')[1] ?? '';
  const records = ledger.split(/^(?=### R\d+: )/m).filter(record => record.startsWith('### R'));
  if (records.length !== calls.length) problems.push(`expected ${calls.length} ledger records, found ${records.length}`);
  if (new Set(calls.map(call => call.ledgerId)).size !== calls.length) problems.push('ledger ids repeat');
  calls.forEach((call, index) => {
    const record = records.find(text => text.startsWith(`### ${call.ledgerId}: `));
    const d = `D${index + 1}`;
    if (!record) { problems.push(`${call.ledgerId}: missing record`); return; }
    if (!call.question.startsWith(`${d} —`)) problems.push(`${call.ledgerId}: question is not ${d}`);
    if (!record.includes(`Question ${d}:\n${call.question}\nHeader: ${call.header}\nOptions:\n`)) problems.push(`${call.ledgerId}: question or header differs from the native call`);
    call.options.forEach((option, i) => {
      if (!record.includes(`\n${SELECTORS[i]}) ${option.label}\n${option.description}\n`)) problems.push(`${call.ledgerId}: option ${SELECTORS[i]} differs from the native call`);
    });
    const selected = call.options.findIndex(option => option.label === call.answer);
    if (selected < 0) problems.push(`${call.ledgerId}: actual answer is not an offered label`);
    else if (!record.includes(`\nActual answer: ${SELECTORS[selected]}) ${call.answer} (${d}`)) problems.push(`${call.ledgerId}: actual answer not recorded`);
    if (!/^State: approved$/m.test(record)) problems.push(`${call.ledgerId}: not approved`);
    if (!/^Accepted scope: \S/m.test(record)) problems.push(`${call.ledgerId}: missing accepted scope`);
  });
  return problems;
}
