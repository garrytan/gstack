import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-count-native-issue-fields.json';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const accepts = (call: NativePlanQuestionCall) => isDesignCountFirstReview(fingerprint(call));
type Question = NativePlanQuestionCall['questions'][number];
function changed(index: number, edit: (question: Question) => void) {
  const call = calls()[index]!, question = call.questions[0]!;
  edit(question);
  call.answers = { [question.question]: question.options[0]!.label };
  return call;
}

describe('native numbered design gaps with complete decision fields', () => {
  test('the exact first four findings each establish review independently', () => {
    for (const index of [1, 2, 3, 4]) expect(accepts(calls()[index]!)).toBe(true);
  });

  test('all eight public calls retain one setup and seven review decisions without mutation', () => {
    const input = calls(), before = JSON.stringify(input);
    let started = false;
    const phases = input.map(call => {
      const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
        isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      return phase;
    });
    expect(input).toHaveLength(8);
    expect(captured.assistantMessages).toHaveLength(3);
    expect(phases.map(phase => phase.preReview)).toEqual([true, false, false, false, false, false, false, false]);
    expect(phases.filter(phase => phase.administrative)).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('a finding keeps its identity across descriptive headers, ordinals and offered answers', () => {
    for (const index of [1, 2, 3, 4]) {
      const call = changed(index, question => {
        question.header = 'Current design requirement';
        question.question = question.question.replace(/Issue [1-9]\d*/, 'Issue 17')
          .replace(/\bG[1-9]\d*\b/g, 'G29').replace(/\b[1-9]\d*([ABC])\b/g, '17$1');
        question.options = question.options.map(option => ({
          label: option.label.replace(/^[1-9]\d*/, '17'),
          description: option.description?.replace(/\bG[1-9]\d*\b/g, 'G29'),
        })).reverse();
      });
      for (const option of call.questions[0]!.options) {
        call.answers = { [call.questions[0]!.question]: option.label };
        expect(accepts(call)).toBe(true);
      }
    }
  });

  test('decision fields tolerate prose layout and equivalent current defect descriptions', () => {
    const descriptions = [
      'The header buttons currently share the same visual weight; the primary action is not distinguishable.',
      'The Save request currently gives no visible feedback while it is pending; users try again.',
      'The form labels currently mix 14px, 16px and 18px with no consistent role; the hierarchy is unclear.',
      'The form currently mixes 24px, 32px and 16px section gaps without a spacing rule.',
    ];
    for (const [offset, assessment] of descriptions.entries()) {
      const call = changed(offset + 1, question => {
        question.question = question.question.replace(/^ELI10: .+$/m, `ELI10: ${assessment} DESIGN.md specifies the existing treatment.`)
          .replace(/\n(?=(?:Stakes if we pick wrong|Recommendation|Completeness|Net):)/g, '\n\n');
      });
      expect(accepts(call)).toBe(true);
    }
  });

  test('bare gap IDs, scores, or setup menus cannot replace the current design defect', () => {
    for (const index of [1, 2, 3, 4]) for (const edit of [
      (q: Question) => { q.header = 'Focus'; },
      (q: Question) => { q.header = 'Issue 99'; },
      (q: Question) => { q.question = q.question.replace(/^D\d+[^\n]+/, 'D2 — Issue 1 (G1): Are we ready to review the design?'); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: .+$/m, 'ELI10: G1 is a design finding with a score of 6/10.'); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: .+$/m, 'ELI10: The form already follows every design requirement and has no current defect.'); },
      (q: Question) => { q.options = [{ label: `${index}A Start review`, description: 'Continue the review.' }, { label: `${index}B Wait`, description: 'Keep the gap open.' }]; },
    ]) expect(accepts(changed(index, edit))).toBe(false);
  });

  test('source, quoted, conditional, withdrawn and duplicate evidence does not establish review', () => {
    for (const index of [1, 2, 3, 4]) for (const edit of [
      (q: Question) => { q.question = `Historical example:\n${q.question}`; },
      (q: Question) => { q.question = `\`\`\`\n${q.question}\n\`\`\``; },
      (q: Question) => { q.question = q.question.replace('ELI10: ', 'ELI10: If approved, '); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'); },
      (q: Question) => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: Earlier review example: '); },
      (q: Question) => { q.question += '\nELI10: No current defect exists.'; },
      (q: Question) => { q.question += '\nCorrection: this finding is withdrawn.'; },
      (q: Question) => { q.question += '\nCorrection: this gap is already resolved.'; },
      (q: Question) => { q.options[0]!.description = `If approved later, ${q.options[0]!.description}`; },
      (q: Question) => { q.options[0]!.description = `> ${q.options[0]!.description}`; },
      (q: Question) => { q.options[0]!.description += ' This amendment is withdrawn.'; },
      (q: Question) => { q.options[2]!.description += ' This gap is now closed.'; },
    ]) expect(accepts(changed(index, edit))).toBe(false);
  });

  test('the offered remedy and retained gap must belong to this decision', () => {
    for (const index of [1, 2, 3, 4]) for (const edit of [
      (q: Question) => { q.options[0]!.label = '99A A different issue'; },
      (q: Question) => { q.options[0]!.description = 'Record a finding after the next review.'; },
      (q: Question) => { q.options[2]!.description = q.options[2]!.description!.replace(/G\d+/, 'G999'); },
      (q: Question) => { q.options[2]!.description = 'The gap is resolved; nothing remains open.'; },
      (q: Question) => { q.options[2]!.label = `${index}C Choose the next workflow`; },
      (q: Question) => { q.question = q.question.replace('Recommendation:', 'Previous recommendation:'); },
      (q: Question) => { q.question = q.question.replace(/^Recommendation: [1-9]\d*[A-Z]/m, 'Recommendation: 99A'); },
    ]) expect(accepts(changed(index, edit))).toBe(false);
  });

  test('owned quoted status scalars still withdraw a decision; quoted history does not', () => {
    for (const index of [1, 2, 3, 4]) for (const target of ['question', 'remedy', 'deferral']) {
      const append = (q: Question, text: string) => {
        if (target === 'question') q.question += text;
        else q.options[target === 'remedy' ? 0 : 2]!.description += text;
      };
      for (const [left, right] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['`', '`']]) {
        expect(accepts(changed(index, q => append(q, `\nThis finding is ${left}withdrawn${right}.`)))).toBe(false);
      }
      expect(accepts(changed(index, q => append(q, '\nPrior note: "This finding is withdrawn."')))).toBe(true);
      expect(accepts(changed(index, q => append(q, '\n> This finding is withdrawn.')))).toBe(true);
    }
  });

  test('only a completed, successful native call with its actual selected answer can start review', () => {
    const changes = [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { delete c.answeredAt; },
      (c: NativePlanQuestionCall) => { c.sessionId = ''; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'not offered' }; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ];
    for (const index of [1, 2, 3, 4]) {
      for (const change of changes) { const call = calls()[index]!; change(call); expect(accepts(call)).toBe(false); }
      for (const change of [
        (fp: ReturnType<typeof fingerprint>) => { fp.signature = 'other:call'; },
        (fp: ReturnType<typeof fingerprint>) => { fp.nativeQuestionIndex = 1; },
        (fp: ReturnType<typeof fingerprint>) => { fp.options.reverse(); },
      ]) { const fp = fingerprint(calls()[index]!); change(fp); expect(isDesignCountFirstReview(fp)).toBe(false); }
    }
  });
});


describe('dacc95ea current Issue decisions without a G or Pass label', () => {
  const actual = () => structuredClone(captured.dacc95eaFirstAttempt.calls) as NativePlanQuestionCall[];
  for (const index of [2, 3, 4, 5, 6]) test(`actual retained Issue ${index - 1} independently starts review`, () => {
    expect(accepts(actual()[index]!)).toBe(true);
  });
  test('actual eight-call phase replay preserves two setup calls and six later decisions', () => {
    let started = false;
    const input = actual(), before = JSON.stringify(input);
    const phases = input.map(call => {
      const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
        isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      return phase;
    });
    expect(phases.map(phase => phase.preReview)).toEqual([true, true, false, false, false, false, false, false]);
    expect(phases.filter(phase => phase.administrative)).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe('dacc95ea numbered Finding decisions with an owned detailed comparison', () => {
  const actual = () => structuredClone(captured.dacc95eaRetry.calls) as NativePlanQuestionCall[];
  for (const index of [3, 4, 5, 6, 7]) test(`actual retained Finding call ${index - 2} independently starts review`, () => {
    expect(accepts(actual()[index]!)).toBe(true);
  });
  test('nine retained retry calls preserve three setup calls and six later decisions', () => {
    let started = false;
    const input = actual(), before = JSON.stringify(input);
    const phases = input.map(call => {
      const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
        isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      return phase;
    });
    expect(phases.map(phase => phase.preReview)).toEqual([true, true, true, false, false, false, false, false, false]);
    expect(JSON.stringify(input)).toBe(before);
  });
});


describe('current native design decision boundaries', () => {
  const specimens = () => [
    ...structuredClone(captured.dacc95eaFirstAttempt.calls).slice(2, 7),
    ...structuredClone(captured.dacc95eaRetry.calls).slice(3, 8),
  ] as NativePlanQuestionCall[];
  const edit = (input: NativePlanQuestionCall, mutate: (q: Question) => void) => {
    const call = structuredClone(input), q = call.questions[0]!;
    mutate(q); call.answers = { [q.question]: q.options[0]!.label }; return call;
  };
  for (const [name, mutate] of Object.entries({
    'whole quoted brief': (q: Question) => { q.question = q.question.split('\n').map(line => '> ' + line).join('\n'); },
    'whole fenced brief': (q: Question) => { q.question = '\x60\x60\x60md\n' + q.question + '\n\x60\x60\x60'; },
    'historical preface': (q: Question) => { q.question = 'Historical example:\n' + q.question; },
    'foreign source': (q: Question) => { q.question = q.question.replaceAll('PLAN.md', 'OTHER.md'); },
    'quoted source': (q: Question) => { q.question = q.question.replaceAll('PLAN.md', '"PLAN.md"'); },
    'conditional assessment': (q: Question) => { q.question = q.question.replace('ELI10: ', 'ELI10: If approved later, '); },
    'quoted assessment': (q: Question) => { q.question = q.question.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'); },
    'duplicate assessment': (q: Question) => { q.question += '\nELI10: Another assessment.'; },
    'explicitly closed gap': (q: Question) => { q.question += '\nThis finding is now resolved.'; },
    'withdrawn current scalar': (q: Question) => { q.question += '\nThis finding is "withdrawn".'; },
    'setup header': (q: Question) => { q.header = 'Focus'; },
    'wrong header identity': (q: Question) => { q.header = 'Issue 99'; },
    'wrong option identity': (q: Question) => { q.options[0]!.label = q.options[0]!.label.replace(/^\d+/, '99'); },
    'foreign recommendation': (q: Question) => { q.question = q.question.replace(/^Recommendation: \d+[A-Z]/m, 'Recommendation: 99A'); },
    'withdrawn remedy': (q: Question) => { q.options[0]!.description += '\nThis amendment is withdrawn.'; },
    'closed deferral': (q: Question) => { q.options.at(-1)!.description += '\nThis gap is now closed.'; },
  })) test('both captured classes reject ' + name, () => {
    for (const call of specimens()) expect(accepts(edit(call, mutate))).toBe(false);
  });
  test('every offered answer and recommendation-first ordering retains the same owned decision', () => {
    for (const input of specimens()) {
      const call = structuredClone(input), q = call.questions[0]!;
      q.options.reverse();
      for (const option of q.options) { call.answers = { [q.question]: option.label }; expect(accepts(call)).toBe(true); }
    }
  });
  for (const [name, mutate] of Object.entries({
    unanswered: (c: NativePlanQuestionCall) => { c.answered = false; },
    failed: (c: NativePlanQuestionCall) => { c.failed = true; },
    'pending index': (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
    'missing timestamp': (c: NativePlanQuestionCall) => { delete c.answeredAt; },
    'unoffered answer': (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Recommendation A' }; },
    'multiple questions': (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
  })) test('both captured classes reject native ' + name, () => {
    for (const call of specimens()) { mutate(call); expect(accepts(call)).toBe(false); }
  });
  test('the expanded comparison must keep complete current option ownership', () => {
    const original = specimens()[5]!;
    for (const mutate of [
      (q: Question) => { q.question = q.question.replace(/\nPros \/ cons:[\s\S]*?\nNet:/, '\nNet:'); },
      (q: Question) => { q.question = q.question.replace(/(\nPros \/ cons:\n)([\s\S]*?)(\nNet:)/, '$1\x60\x60\x60md\n$2\n\x60\x60\x60$3'); },
      (q: Question) => { q.question = q.question.replace(/(\nPros \/ cons:\n)/, '$1Historical example:\n'); },
      (q: Question) => { q.question = q.question.replace(/^1A\)/m, '99A)'); },
      (q: Question) => { q.question = q.question.replace(/^1B\)/m, '1A)'); },
      (q: Question) => { q.question = q.question.replace(/\n1C\)[\s\S]*?\nNet:/, '\nNet:'); },
    ]) expect(accepts(edit(original, mutate))).toBe(false);
  });
  test('only the bound native decision status can withdraw its current finding', () => {
    for (const original of specimens()) {
      const title = original.questions[0]!.question.split('\n')[0]!;
      const owner = /^D[1-9]\d*/.exec(title)?.[0] ?? /Finding [1-9]\d*/.exec(title)![0];
      for (const status of ['withdrawn', '"withdrawn"', '\x60withdrawn\x60']) {
        expect(accepts(edit(original, q => { q.question += `\n${owner} is ${status}.`; }))).toBe(false);
      }
      expect(accepts(edit(original, q => { q.question += `\nPrior note: "${owner} is withdrawn."`; }))).toBe(true);
      expect(accepts(edit(original, q => { q.question += `\n> ${owner} is withdrawn.`; }))).toBe(true);
    }
  });
  test('a conforming contrast ratio cannot borrow a low-contrast classification', () => {
    const original = specimens()[2]!;
    expect(accepts(edit(original, q => { q.question = q.question.replaceAll('3:1', '4.5:1'); }))).toBe(false);
  });
});


import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyPlanCountFrame, hasNativePlanTerminal, isQuestionlessNativePlanExit, assertReviewReportAtBottom } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

test('full first attempt reaches owned completion and passes every unchanged paid callback assertion', () => {
  const actual = captured.dacc95eaFirstAttempt, ending = actual.completion;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-dacc-completion-'));
  const file = path.join(dir, path.basename(ending.provenance.file));
  const transcript: PlanCountTranscript = { status: 'ready', calls: structuredClone(actual.calls) as NativePlanQuestionCall[],
    assistantMessages: structuredClone(ending.assistantMessages), planReadyRequests: structuredClone(ending.planReadyRequests) };
  const startedAt = Math.min(...transcript.calls.map(call => Date.parse(call.answeredAt!))) - 1_000;
  const modifiedAt = Date.parse(ending.provenance.mutations.at(-1)!.at) / 1_000;
  const write = (body = ending.report) => { fs.writeFileSync(file, body); fs.utimesSync(file, modifiedAt, modifiedAt); };
  let started = false; const counts = { step0: 0, review: 0, administrative: 0 }, nonReview = new Set<string>();
  const fingerprints = transcript.calls.map(call => {
    const fp = fingerprint(call), phase = planCountQuestionPhase(fp, started, designStep0Boundary,
      isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
    started = phase.reviewStarted;
    counts[phase.administrative ? 'administrative' : phase.preReview ? 'step0' : 'review']++;
    if (phase.preReview || phase.administrative) nonReview.add(fp.signature);
    return { ...fp, preReview: phase.preReview };
  });
  const caller = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-design-finding-count.test.ts'), 'utf8');
  const constants = /^const N = .+;\nconst FLOOR = .+;\nconst CEILING = .+;/m.exec(caller)![0];
  // Bind the actual callback's complete validation block, without importing
  // the paid registration or changing its assertions, prompt or work limits.
  const start = caller.indexOf("        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome))");
  const end = caller.indexOf('\n      } finally {', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const validate = new Function('fs', 'planPath', 'obs', 'assertReviewReportAtBottom',
    new Bun.Transpiler({ loader: 'ts' }).transformSync(constants + '\n' + caller.slice(start, end)));
  try {
    write();
    expect(createHash('sha256').update(ending.report).digest('hex')).toBe(ending.reportSha256);
    expect(counts).toEqual({ step0: 2, review: 6, administrative: 0 });
    const frame = classifyPlanCountFrame(ending.screen);
    expect(frame).toBe('plan_ready');
    expect(hasNativePlanTerminal(transcript, file, startedAt, 'plan_ready')).toBe(true);
    expect(isQuestionlessNativePlanExit(transcript, file, startedAt, ending.screen, nonReview)).toBe(false);
    expect(assertReviewReportAtBottom(ending.report).ok).toBe(true);
    const replayed = { outcome: frame, step0Count: counts.step0, reviewCount: counts.review, fingerprints, elapsedMs: 0, evidence: ending.screen };
    expect(() => validate(fs, file, replayed, assertReviewReportAtBottom)).not.toThrow();
    for (const [delta, error] of [
      [{ outcome: 'no_review_questions' }, 'finding-count FAILED'],
      [{ reviewCount: 3 }, 'BAND FAIL (below floor)'],
      [{ reviewCount: 8 }, 'BAND FAIL (above ceiling)'],
    ] as const) expect(() => validate(fs, file, { ...replayed, ...delta }, assertReviewReportAtBottom)).toThrow(error);
    write(ending.report + '\n## Work after report\n');
    expect(() => validate(fs, file, replayed, assertReviewReportAtBottom)).toThrow('D19 FAIL');
    write(); fs.rmSync(file);
    expect(() => validate(fs, file, replayed, assertReviewReportAtBottom)).toThrow('D19 FAIL');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
