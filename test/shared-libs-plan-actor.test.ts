/** Public selector replay only; these captures are not passing lifecycle evidence. */
import { describe, expect, test } from 'bun:test';
import { createSharedPlanReuseSelector } from './helpers/shared-libs-plan-actor';
import { createSharedInteractiveToolHandler } from './helpers/shared-libs-eval-fixture';

// Exact native R1 from the September 22 timeout. R2 was saved in an Edit, but
// never sent as a native AUQ; its public draft fields are reconstructed below.
// No thinking events or model-private reasoning are read into these fixtures.
const capturedR1 = {
  "questions": [
    {
      "question": "D1 — Reuse the existing Retry-After helper, or give each new caller its own parser?\nProject/branch/task: repo on branch main; planning src/import-worker.ts and src/sync-route.ts (PLAN.md).\nELI10: The plan says each new file should get its own copy of the code that reads a \"Retry-After\" header and turns it into a number of seconds to wait. The repo already has exactly that code in lib/retry-after.ts, the scheduler already uses it, and a test locks in its behavior. Copying it twice more means three or four places that must be kept identical by hand forever.\nStakes if we pick wrong: Copies drift silently, so one worker could wait a different time than the scheduler for the same header, and the plan's \"must match the existing scheduler semantics\" requirement can only be enforced by eyeballing.\nRecommendation: A because the helper already meets every stated requirement (string|null input, injected now, 3600-second cap, caller fallback) and is itself the definition of the scheduler semantics the plan must match.\nCompleteness: A=10/10, B=5/10\nPros / cons: see options.\nNet: Trading one import line per caller against ~30 duplicated lines and a permanent \"keep these identical\" obligation. Effort (human: A ~15 min / B ~1-2 h incl. tests; CC: A ~1 min / B ~5 min).",
      "header": "Parser source",
      "options": [
        {
          "label": "Reuse lib/retry-after.ts (recommended)",
          "description": "✅ Zero new parser code: one import line per caller, and behavior is identical to the scheduler by construction rather than by review.\n✅ The existing contract test (test/retry-after.test.ts) already guards the cap, fallback, trimming and date paths for all three callers.\n❌ A future helper bug or change affects the scheduler and both new callers at once, so helper edits must keep the contract test honest."
        },
        {
          "label": "Local parser per caller",
          "description": "✅ Each caller is self-contained and can diverge later without coordinating with the scheduler.\n✅ Matches the plan text as written, so no plan amendment is needed.\n❌ Adds two more byte-identical 15-line copies (four total counting src/retry-route.ts and src/retry-worker.ts) with no shared test, so drift is unguarded."
        }
      ],
      "multiSelect": false
    }
  ]
};

const draftedR2 = {
  "questions": [
    {
      "question": "D2 — Should the shared helper stop treating \"1.5\" or \"-5\" as a date and use the caller fallback instead?\nProject/branch/task: repo on branch main; lib/retry-after.ts, which D1 made the parser for the scheduler and both new callers (PLAN.md).\nELI10: The helper first checks whether the header is a plain whole number. If not, it hands the text to JavaScript's date parser. That parser happily reads \"1.5\" or \"-5\" as a date in the year 2001, so the helper thinks the deadline is long past and says \"retry now\" (0 seconds). A broken header should instead fall back to the caller's default wait, as \"invalid\" already does.\nStakes if we pick wrong: A server sending a malformed Retry-After makes the scheduler and both new callers retry immediately with no delay, which is the opposite of what the header asked for and can hammer an already-struggling upstream.\nRecommendation: A because one explicit guard line closes the gap for all three callers at once, the contract test proves it, and every valid input keeps its current result.\nCompleteness: A=10/10, B=3/10\nPros / cons: see options.\nNet: One guard line plus three test assertions versus leaving an immediate-retry path open to malformed headers; A changes scheduler behavior on those inputs from 0 s to its 5 s fallback. Effort (human: A ~30 min / B 0; CC: A ~2 min / B 0).",
      "header": "Bad numerics",
      "options": [
        {
          "label": "Guard in helper + tests",
          "description": "✅ Malformed numeric strings return the caller fallback for the scheduler and both new callers with one explicit line, no per-caller code.\n✅ Three new contract assertions lock the behavior in, and every currently valid input (digits, IMF-fixdate, ISO) is provably untouched.\n❌ Existing scheduler behavior changes for those inputs (0 s becomes its 5 s fallback), so the plan must call this out as a deliberate change."
        },
        {
          "label": "Leave as-is",
          "description": "✅ No change to the proven helper or to current scheduler behavior; smallest possible diff.\n✅ Malformed numeric Retry-After values are rare from well-behaved servers.\n❌ Any upstream that emits \"1.5\" or a negative value triggers immediate retries with zero delay from all three callers, and nothing tests for it."
        }
      ],
      "multiSelect": false
    }
  ]
};

// Exact public native question refused by the September 22 19:48 capture.
const capturedProofChoices = {
  "questions": [
    {
      "question": "D1 — Where should the two new callers get their Retry-After parser?\nProject/branch/task: main — plan \"Import and synchronization retry planning\" for the future src/import-worker.ts and src/sync-route.ts.\nELI10: Both new files need to turn a Retry-After header (a number of seconds, a date, or nothing) into \"wait this many seconds, at most one hour\", exactly the way the scheduler already does. The scheduler does this by calling one small shared function in lib/retry-after.ts that has its own test. The plan instead writes a fresh copy of that logic inside each new file, so three places would have to be kept identical by hand.\nStakes if we pick wrong: a copy drifts (different cap, fallback or date handling), a caller retries at the wrong time, and nothing catches it because no test compares the copies to the scheduler.\nRecommendation: A because lib/retry-after.ts already implements the fixed contract, is imported by src/scheduler.ts:1-2 and tested in test/retry-after.test.ts; reusing it avoids ~26 implementation lines and lets one extended test guard all three callers.\nCompleteness: A=10/10, B=7/10, C=5/10\nPros / cons:\nA) Reuse lib helper, full proof (recommended)\n  ✅ Both callers import retrySeconds from lib/retry-after.ts: zero new parser code, semantics identical to the scheduler by construction\n  ✅ Shared-contract test gains the fixed-contract edges the probe confirmed (whitespace-only → fallback, \"0\" → 0, non-safe integer → fallback, past date → 0, date branch capped at 3600, fractional second rounds up); each caller's integration test asserts fallback and injected now are passed through\n  ❌ A bug in lib/retry-after.ts now affects scheduler, import worker and sync route at once (three first-party callers) (human: ~2 h / CC: ~5 min)\nB) Reuse lib helper, basic proof\n  ✅ Same import wiring as A; still no duplicated parser code in the new callers\n  ✅ Smallest test diff: keeps the existing 5-expectation contract test and adds only the two integration tests the plan already lists\n  ❌ Contract edges the new callers rely on (past date → 0, date-branch ceiling, non-safe integer → fallback) stay unasserted, so drift there would go unnoticed (human: ~1 h / CC: ~3 min)\nC) Local parser per caller\n  ✅ Follows the plan as drafted; each caller is self-contained with no dependency on lib\n  ✅ A later change to one caller's parser cannot affect the scheduler\n  ❌ Adds ~28 lines duplicated from lib/retry-after.ts, joining the two existing untested copies in src/retry-route.ts and src/retry-worker.ts; equivalence with the scheduler rests on hand-copied code with no shared test (human: ~3 h / CC: ~10 min)\nNet: one tested function guarding three callers versus two more hand-maintained copies; the only cost of A is the shared blast radius, which the extended contract test exists to catch.",
      "header": "Parser source",
      "multiSelect": false,
      "options": [
        {
          "label": "Reuse lib helper, full proof (Recommended)",
          "description": "✅ Both callers import retrySeconds from lib/retry-after.ts: zero new parser code, semantics identical to the scheduler by construction. ✅ Shared-contract test gains the fixed-contract edges the probe confirmed (whitespace-only → fallback, \"0\" → 0, non-safe integer → fallback, past date → 0, date branch capped at 3600, fractional second rounds up); each caller's integration test asserts fallback and injected now are passed through. ❌ A bug in lib/retry-after.ts now affects scheduler, import worker and sync route at once (three first-party callers). Completeness 10/10. Effort human ~2 h / CC ~5 min. lib semantics and the existing copies in retry-route.ts / retry-worker.ts stay unchanged."
        },
        {
          "label": "Reuse lib helper, basic proof",
          "description": "✅ Same import wiring as A; still no duplicated parser code in the new callers. ✅ Smallest test diff: keeps the existing 5-expectation contract test and adds only the two integration tests the plan already lists. ❌ Contract edges the new callers rely on (past date → 0, date-branch ceiling, non-safe integer → fallback) stay unasserted, so drift there would go unnoticed. Completeness 7/10. Effort human ~1 h / CC ~3 min. lib semantics and the existing copies stay unchanged."
        },
        {
          "label": "Local parser per caller",
          "description": "✅ Follows the plan as drafted; each caller is self-contained with no dependency on lib. ✅ A later change to one caller's parser cannot affect the scheduler. ❌ Adds ~28 lines duplicated from lib/retry-after.ts, joining the two existing untested copies in src/retry-route.ts and src/retry-worker.ts; equivalence with the scheduler rests on hand-copied code with no shared test. Completeness 5/10. Effort human ~3 h / CC ~10 min. lib semantics and the existing copies stay unchanged."
        }
      ]
    }
  ]
};

// Exact public native question refused by the September 22 19:58 capture.
const capturedBriefRecommendation = {
  "questions": [
    {
      "question": "D1 — Should the two new callers import the existing Retry-After parser or each carry a local copy?\nProject/branch/task: gstack-shared-plan-callers fixture, branch main, plan \"Import and synchronization retry planning\" (PLAN.md).\nELI10: The plan adds two new files that each need to turn a Retry-After header into a wait time exactly the way the scheduler already does. The scheduler gets that from one small, tested helper in lib/retry-after.ts. The draft says each new file should write its own copy of that logic instead. We need to decide whether the new files call the existing helper, and how much test proof we add that the shared behavior holds.\nStakes if we pick wrong: with local copies, a future tweak to one parser silently desynchronizes retry timing across scheduler, import worker and sync route; with the helper but thin tests, the edge cases the plan calls fixed (ceiling, past dates, fallback) stay unproven.\nRecommendation: A because the helper already exists, is proven by the scheduler and its test, matches the required contract exactly, and the extra contract assertions cost minutes while locking down the edges the plan declares fixed.\nCompleteness: A=10/10, B=7/10, C=5/10\nPros / cons:\nA) Reuse helper + full proof (recommended)\n  ✅ Both callers import lib/retry-after.ts, so scheduler and callers share one code path (~26 implementation lines saved)\n  ✅ Shared test gains the missing edge assertions (empty, past date → 0, date ceiling, unsafe int, exact 3600) that the plan calls fixed\n  ✅ Integration tests prove each caller forwards header, now and its own fallback (human: ~1-2 h / CC: ~5 min)\n  ❌ Total diff grows by roughly 8-10 test lines beyond the two planned integration tests\nB) Reuse helper, planned tests only\n  ✅ Same shared code path and same ~26 implementation lines saved as option A\n  ✅ Smallest diff: two import lines plus the two integration tests already in the plan (human: ~1 h / CC: ~3 min)\n  ❌ Past date → 0, date ceiling, empty string and unsafe integer stay unasserted for the helper all three sites now rely on\nC) Keep local parsers\n  ✅ Matches the current draft text; no change to the plan wording is needed\n  ✅ Each caller could later diverge from the scheduler without touching lib/ (only useful if divergence is wanted, which the plan forbids)\n  ❌ Adds ~28 duplicated implementation lines and three copies to keep in sync; no test proves the copies match the scheduler\nNet: one existing, tested helper already satisfies the fixed contract, so the real trade is a few extra assertions now versus three parsers to keep identical forever.",
      "header": "Parser source",
      "multiSelect": false,
      "options": [
        {
          "label": "Reuse helper + full proof",
          "description": "Both new callers import `retrySeconds` from `lib/retry-after.ts` (no local parser). Extend `test/retry-after.test.ts` with assertions for '' and whitespace → fallback, explicit fallback for null, past HTTP-date → 0, date beyond 3600 s → 3600, exact '3600' → 3600, non-safe integer → fallback, and ceil rounding. Add one integration test per caller asserting it forwards the header, injected now and its own fallback, and observes the 3600 ceiling and null → own fallback. Helper semantics and existing callers unchanged. Completeness 10/10. human: ~1-2 h / CC: ~5 min."
        },
        {
          "label": "Reuse helper, planned tests only",
          "description": "Both new callers import `retrySeconds` from `lib/retry-after.ts` (no local parser). Shared test unchanged (5 assertions). One happy-path integration test per caller (header value → scheduled seconds). Helper semantics and existing callers unchanged. Completeness 7/10. human: ~1 h / CC: ~3 min."
        },
        {
          "label": "Keep local parsers",
          "description": "Each new caller implements its own copy of the parser as drafted (~14 lines each). Shared test unchanged and does not cover the copies. One happy-path integration test per caller; no parity proof against the scheduler. Helper and existing callers unchanged. Completeness 5/10. human: ~2 h / CC: ~5 min, plus ongoing sync maintenance."
        }
      ]
    }
  ]
};

function actor() {
  const questions: unknown[] = [], answers: unknown[] = [], refusals: Error[] = [];
  const controller = new AbortController();
  const callback = createSharedInteractiveToolHandler(createSharedPlanReuseSelector(), {
    nonQuestion: (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    onQuestion: input => { questions.push(input); },
    onAnswer: (input, answer) => { answers.push({ input, answer }); },
    onRefusal: error => { refusals.push(error); controller.abort(); },
  });
  return { callback, questions, answers, refusals, controller };
}

describe('bounded shared-code planning actor', () => {
  test('actual native brief-only recommendation and implicit PLAN callers are supported', async () => {
    const run = actor();
    expect(await run.callback('AskUserQuestion', capturedBriefRecommendation)).toEqual({ behavior: 'allow', updatedInput: {
      ...capturedBriefRecommendation, answers: { [capturedBriefRecommendation.questions[0].question]: capturedBriefRecommendation.questions[0].options[0].label },
    } });
    expect(run.refusals).toEqual([]);
  });

  test('actual native full/basic proof choices preserve evidence and unchanged existing callers', async () => {
    const run = actor();
    expect(await run.callback('AskUserQuestion', capturedProofChoices)).toEqual({ behavior: 'allow', updatedInput: {
      ...capturedProofChoices, answers: { [capturedProofChoices.questions[0].question]: capturedProofChoices.questions[0].options[0].label },
    } });
    expect(run.refusals).toEqual([]);
  });

  test('both proof alternatives may name the helper explicitly; unique recommendation selects full proof', async () => {
    const input = structuredClone(capturedProofChoices);
    input.questions[0].options[1].description += ' Both callers reuse retrySeconds from lib/retry-after.ts.';
    const result = await actor().callback('AskUserQuestion', input);
    expect(result.updatedInput.answers).toEqual({ [input.questions[0].question]: input.questions[0].options[0].label });
  });

  test.each(['missing recommendation', 'multiple recommendations', 'independent runtime change'])('proof-depth alternatives refuse %s', async mutation => {
    const input = structuredClone(capturedProofChoices);
    if (mutation === 'missing recommendation') {
      input.questions[0].options[0].label = 'Reuse lib helper, full proof';
      input.questions[0].question = input.questions[0].question.replace(/^Recommendation:.*\n/m, '').replace(/\s*\(recommended\)/ig, '');
    }
    if (mutation === 'multiple recommendations') input.questions[0].options[1].label += ' (Recommended)';
    if (mutation === 'independent runtime change') input.questions[0].options[1].description += ' Change retrySeconds so malformed inputs use the fallback.';
    const run = actor();
    await expect(run.callback('AskUserQuestion', input)).rejects.toThrow('shared-libs-plan-callers actor:');
    expect(run.answers).toEqual([]);
    expect(run.controller.signal.aborted).toBe(true);
  });

  for (const placement of ['native label', 'brief selector', 'brief label', 'copied menu', 'all channels'] as const) {
    test.each(['captured context', 'implicit plan references', 'contract in brief', 'neutral labels'] as const)(`${placement} works with %s`, async context => {
      const input = structuredClone(capturedBriefRecommendation);
      const question = input.questions[0];
      if (context === 'implicit plan references') {
        question.question = question.question.replace(/two new callers/gi, 'the planned components').replace(/two new files/gi, 'the planned components');
        question.options.forEach(option => { option.description = option.description.replace(/Both new callers/gi, 'The planned components'); });
      }
      if (context === 'contract in brief') question.options.forEach(option => {
        option.description = option.description.replace(/Helper semantics and existing callers unchanged\./g, '').replace(/Helper and existing callers unchanged\./g, '');
      });
      if (context === 'neutral labels') {
        question.options[0].label = 'Full proof';
        question.options[1].label = 'Basic proof';
      }
      const label = question.options[0].label;
      if (placement !== 'all channels' && placement !== 'copied menu') question.question = question.question.replace(/\s*\(recommended\)/ig, '');
      if (placement === 'native label' || placement === 'copied menu') question.question = question.question.replace(/^Recommendation:.*\n/m, '');
      if (placement === 'native label' || placement === 'all channels') question.options[0].label += ' (recommended)';
      if (placement === 'brief label') question.question = question.question.replace(/^Recommendation: A because/m, `Recommendation: ${label} because`);
      const run = actor();
      expect(await run.callback('AskUserQuestion', input)).toEqual({ behavior: 'allow', updatedInput: {
        ...input, answers: { [question.question]: question.options[0].label },
      } });
      expect(run.refusals).toEqual([]);
    });
  }

  test('native schema permits a fourth proof-depth option without changing the chosen commitment', async () => {
    const input = structuredClone(capturedBriefRecommendation);
    input.questions[0].options.push({ label: 'Reuse helper, intermediate proof',
      description: 'Import retrySeconds from lib/retry-after.ts under unchanged scheduler semantics. Add compatibility tests and both caller integration tests with intermediate proof depth.' });
    expect(await actor().callback('AskUserQuestion', input)).toMatchObject({ behavior: 'allow', updatedInput: {
      answers: { [input.questions[0].question]: input.questions[0].options[0].label },
    } });
  });

  test('implicit plan references do not permit a foreign caller migration', async () => {
    const input = structuredClone(capturedBriefRecommendation);
    input.questions[0].options[0].description += ' src/unrelated-worker.ts will import the helper too.';
    const run = actor();
    await expect(run.callback('AskUserQuestion', input)).rejects.toThrow('question expands');
    expect(run.answers).toEqual([]);
    expect(run.controller.signal.aborted).toBe(true);
  });

  test.each(['negated recommended label', 'negated unmarked label', 'conflicting brief recommendation'])('never silently selects basic proof after %s', async mutation => {
    const input = structuredClone(capturedProofChoices);
    if (mutation === 'negated recommended label') input.questions[0].options[0].label = 'Do not reuse lib/retry-after.ts (Recommended)';
    if (mutation === 'negated unmarked label') input.questions[0].options[0].label = 'Do not reuse lib/retry-after.ts';
    if (mutation === 'conflicting brief recommendation') input.questions[0].question = input.questions[0].question.replace('Recommendation: A', 'Recommendation: B');
    const run = actor();
    await expect(run.callback('AskUserQuestion', input)).rejects.toThrow('explicit recommendation does not identify');
    expect(run.answers).toEqual([]);
    expect(run.controller.signal.aborted).toBe(true);
  });

  test('copied unchosen options may explain different commitments without approving them', async () => {
    const input = structuredClone(capturedProofChoices);
    input.questions[0].question = input.questions[0].question.replace('C) Local parser per caller', 'C) Local parser per caller\n  ❌ This alternative would change the helper semantics and migrate existing callers.');
    input.questions[0].options[2].description += ' This alternative would change the helper semantics and migrate existing callers.';
    expect(await actor().callback('AskUserQuestion', input)).toMatchObject({ behavior: 'allow' });
  });

  test('general recommendation commitments remain checked outside a copied option menu', async () => {
    const input = structuredClone(capturedProofChoices);
    input.questions[0].question = input.questions[0].question.replace('Recommendation: A because', 'Recommendation: A to harden helper parsing because');
    await expect(actor().callback('AskUserQuestion', input)).rejects.toThrow('question expands');
  });

  test.each([
    ['The implementation saves lines; extended tests guard the fixed contract.', true],
    ['Add shared-contract tests to guard current scheduler behavior.', true],
    ['Existing retry-worker.ts and retry-route.ts remain evidence only and stay unchanged.', true],
    ['Implement a validation guard in the helper.', false],
    ['Fix the scheduler fallback for malformed headers.', false],
  ] as const)('distinguishes evidence and proof from a behavioral change: %s', async (extra, allowed) => {
    const input = structuredClone(capturedR1);
    input.questions[0].options[0].description += '\n✅ ' + extra;
    const run = actor();
    if (allowed) expect(await run.callback('AskUserQuestion', input)).toMatchObject({ behavior: 'allow' });
    else await expect(run.callback('AskUserQuestion', input)).rejects.toThrow('question expands');
  });

  test('actual callback copies the exact public native R1 answer and preserves all fields', async () => {
    const run = actor();
    const result = await run.callback('AskUserQuestion', capturedR1);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { ...capturedR1,
      answers: { [capturedR1.questions[0].question]: capturedR1.questions[0].options[0].label } } });
    expect(run.questions).toEqual([capturedR1]);
    expect(run.answers).toHaveLength(1);
    expect(run.refusals).toEqual([]);
    expect(run.controller.signal.aborted).toBe(false);
  });

  test('public R2 draft cannot be answered as a reuse choice, even before R1', async () => {
    const run = actor();
    await expect(run.callback('AskUserQuestion', draftedR2)).rejects.toThrow('shared-libs-plan-callers actor:');
    expect(run.answers).toEqual([]);
    expect(run.refusals).toHaveLength(1);
    expect(run.controller.signal.aborted).toBe(true);
  });

  test('a second question fails the actor contract instead of acquiring broader authority', async () => {
    const run = actor();
    await run.callback('AskUserQuestion', capturedR1);
    await expect(run.callback('AskUserQuestion', draftedR2)).rejects.toThrow('only the bounded parser-reuse choice');
    expect(run.answers).toHaveLength(1);
    expect(run.refusals).toHaveLength(1);
    expect(run.controller.signal.aborted).toBe(true);
  });

  test.each([
    'Do not change the existing parser or migrate existing callers; only add required tests.',
    'Hardening is outside this decision. Required shared-contract and caller tests remain included.',
    'Reuse without tightening semantics; add shared-contract characterization and caller integration tests.',
    'Add compatibility tests for malformed numeric inputs under current scheduler semantics.',
    'A future helper bug or change affects all callers; this shared failure risk remains.',
  ])('explicit boundaries and required proof remain valid: %s', async extra => {
    const input = structuredClone(capturedR1);
    input.questions[0].options[0].description += '\n✅ ' + extra;
    const run = actor();
    await run.callback('AskUserQuestion', input);
    expect(run.answers).toHaveLength(1);
    expect(run.refusals).toEqual([]);
  });

  test('caller identity can be supplied by the selected option rather than repeated in the question', async () => {
    const input = structuredClone(capturedR1);
    input.questions[0].question = input.questions[0].question.replace('src/import-worker.ts and src/sync-route.ts', 'the planned callers');
    input.questions[0].options[0].description += '\n✅ src/import-worker.ts and src/sync-route.ts use the existing helper with unchanged scheduler behavior.';
    expect(await actor().callback('AskUserQuestion', input)).toMatchObject({ behavior: 'allow' });
  });

  test.each(['Share existing helper', 'Call retrySeconds', 'Use existing retrySeconds', 'Import lib/retry-after.ts'])('equivalent reuse label: %s', async label => {
    const input = structuredClone(capturedR1);
    input.questions[0].options[0].label = label;
    input.questions[0].options[0].description += '\n✅ Both planned callers use lib/retry-after.ts with unchanged scheduler semantics.';
    expect(await actor().callback('AskUserQuestion', input)).toMatchObject({ behavior: 'allow' });
  });

  const expansions = [
    'Harden malformed-header parsing.',
    'Add a validation guard to the existing helper.',
    'Change the scheduler fallback behavior.',
    'Migrate existing retry-worker.ts and retry-route.ts.',
    'Increase the ceiling to 7200 seconds.',
    'Malformed header values now return the fallback instead of zero.',
    'Existing retry-worker.ts and retry-route.ts will import the helper too.',
    'Change retrySeconds so malformed numeric strings use the fallback.',
    'Do not change the cap, but tighten helper validation.',
  ];
  for (const surface of ['question', 'label', 'description'] as const) {
    test.each(expansions)(`mixed commitment in ${surface} is refused: %s`, async extra => {
      const input = structuredClone(capturedR1);
      if (surface === 'question') input.questions[0].question += '\n' + extra;
      else input.questions[0].options[0][surface] += '\n' + extra;
      const run = actor();
      await expect(run.callback('AskUserQuestion', input)).rejects.toThrow('shared-libs-plan-callers actor:');
      expect(run.answers).toEqual([]);
      expect(run.refusals).toHaveLength(1);
      expect(run.controller.signal.aborted).toBe(true);
    });
  }

  test.each(['negated reuse', 'negated compatibility', 'ambiguous option', 'batched questions', 'multiselect'])('%s cannot supply approval', async mutation => {
    const input = structuredClone(capturedR1);
    const question = input.questions[0];
    if (mutation === 'negated reuse') question.options[0].label = 'Do not reuse lib/retry-after.ts';
    if (mutation === 'negated compatibility') question.options[0].description = question.options[0].description.replace('behavior is identical', 'behavior is not identical');
    if (mutation === 'ambiguous option') question.options.push(structuredClone(question.options[0]));
    if (mutation === 'batched questions') input.questions.push(structuredClone(question));
    if (mutation === 'multiselect') question.multiSelect = true;
    const run = actor();
    await expect(run.callback('AskUserQuestion', input)).rejects.toThrow('shared-libs-plan-callers actor:');
    expect(run.answers).toEqual([]);
    expect(run.controller.signal.aborted).toBe(true);
  });
});
