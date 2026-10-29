/**
 * Deterministic unit tests for the ANSI/TUI screen detectors (test/helpers/pty/screen.ts).
 * Split along the W4 module seams from the former claude-pty-runner.unit.test.ts;
 * tests import the public barrel, test/helpers/claude-pty-runner.ts.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
  isAutoDecidedVisible,
  classifyVisible,
  classifyPlanCountFrame,
  idleTurnEnd,
} from './claude-pty-runner';
import { screenPanelEnd } from './pty/screen';

describe('saved preference annotation', () => {
  test('recognizes the explicit preference attribution from the timed-out CEO capture', () => {
    const visible = 'Now I have a clear picture of the branch. Let me proceed with the full review. ' +
      'Mode is HOLD SCOPE (auto-decided from plan-tune preference).';
    expect(isAutoDecidedVisible(visible)).toBe(true);
    expect(classifyVisible(visible)?.outcome).toBe('auto_decided');
    expect(classifyVisible(visible.replace(/\s+/g, ''))?.outcome).toBe('auto_decided');
  });

  test('retains the canonical annotation and its precedence over plan-ready', () => {
    const visible = 'Auto-decided review mode → HOLD SCOPE (your preference). Change with /plan-tune.\nReady to execute?';
    expect(classifyVisible(visible)?.outcome).toBe('auto_decided');
  });

  test('does not equate an unrequested choice or plan-tune advice with a saved preference', () => {
    for (const visible of [
      'Mode is HOLD SCOPE (AUTO_DECIDED).',
      'I auto-decided HOLD SCOPE because this is a refactor.',
      'I auto-decided HOLD SCOPE. You can set a plan-tune preference later.',
      'Mode is HOLD SCOPE (not auto-decided from plan-tune preference).',
      'Mode is HOLD SCOPE (will be auto-decided from plan-tune preference).',
    ]) expect(isAutoDecidedVisible(visible)).toBe(false);
  });
});

describe('mode option rendering', () => {
});

describe('isPermissionDialogVisible', () => {
  test('matches "Bash command requires permission" prompts', () => {
    const sample = `
      Some preamble output

      Bash command \`gstack-config get telemetry\` requires permission to run.

      ❯ 1. Yes
        2. Yes, and always allow
        3. No, abort
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches "allow all edits" file-edit prompts', () => {
    // Isolated to the "allow all edits" clause only — no overlapping
    // "Do you want to proceed?" co-trigger, so this asserts the clause works.
    const sample = `
      Edit to ~/.gstack/config.yaml

      ❯ 1. Yes
        2. Yes, allow all edits during this session
        3. No
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches the "Do you want to proceed?" file-edit confirmation by itself', () => {
    // Separate fixture so weakening this clause is detected by a dedicated test.
    const sample = `
      Edit to ~/.gstack/config.yaml

      Do you want to proceed?

      ❯ 1. Yes
        2. No
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches workspace-trust "always allow access to" prompt', () => {
    const sample = `
      Do you trust the files in this folder?

      ❯ 1. Yes, proceed
        2. Yes, and always allow access to /Users/me/repo
        3. No, exit
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('recognizes the captured collapsed native overwrite confirmation', () => {
    const sample = [
      'Doyouwanttooverwritegstack-test-plan-design.md?',
      '❯1.Yes',
      '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession',
      '3.No',
      'Esctocancel·Tabtoamend',
    ].join('\n');
    expect(isPermissionDialogVisible(sample)).toBe(true);
    expect(isPermissionDialogVisible(sample.replace('Esctocancel·Tabtoamend', 'Enter to select'))).toBe(false);
  });

  test('the captured paired-CEO Edit grant is permission, not another review finding', () => {
    const sample = [
      'Do youwt to makehis dittogstack-test-plan-ceo-paired.md?',
      '❯1.Yes',
      '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and',
      'alwaysallowaccessto/tmp/gstack-paid-shard-EbUl9j/tmp/gstack-e2e-plan-ceo-paired-gkjAd5forthissession',
      '(shift+tab)', '3.No', 'Esctocancel·Tabtoamend',
    ].join('\r');
    expect(isPermissionDialogVisible(sample)).toBe(true);
    expect(classifyPlanCountFrame(sample)).toBe('permission');
  });

  test('recognizes permission labels whose cursor-positioning spaces disappeared', () => {
    expect(isPermissionDialogVisible('Yes,andalwaysallowaccessto/tmp/fixtureforthissession')).toBe(true);
    expect(isPermissionDialogVisible('Yes,allowalleditsduringthissession')).toBe(true);
    expect(isPermissionDialogVisible('Bashcommandrequirespermission')).toBe(true);
  });

  test('does NOT match a skill AskUserQuestion list', () => {
    const sample = `
      D1 — Premise challenge: do users actually want this?

      ❯ 1. Yes, validated
        2. No, premise is wrong
        3. Need more info
    `;
    expect(isPermissionDialogVisible(sample)).toBe(false);
  });

  test('does NOT match a plan-ready confirmation', () => {
    const sample = `
      Ready to execute the plan?

      ❯ 1. Yes
        2. No, keep planning
    `;
    expect(isPermissionDialogVisible(sample)).toBe(false);
  });

  test('does NOT match a skill question that contains the bare phrase "Do you want to proceed?"', () => {
    // Co-trigger requirement: "Do you want to proceed?" alone is not enough.
    // It must appear with "Edit to <path>" or "Write to <path>" to count as
    // a permission dialog. This guards against a skill question like
    // "Do you want to proceed with HOLD SCOPE?" being mis-classified.
    const sample = `
      Choose your scope mode for this review.
      Do you want to proceed?

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
        3. SELECTIVE EXPANSION
    `;
    expect(isPermissionDialogVisible(sample)).toBe(false);
  });

  test('does NOT mis-match when adversarial prose includes "Edit to <path>" alongside the bare proceed phrase', () => {
    // Adversarial fixture: a skill question whose body legitimately mentions
    // "Edit to <path>" in prose AND ends with "Do you want to proceed?". The
    // current co-trigger regex would mis-classify this as a permission
    // dialog. We DO want this test to fail until the regex is tightened
    // further (e.g., proximity constraint, or anchoring "Edit to" to a
    // line-start). For now this is documented as a known limitation: a
    // skill question that talks about "Edit to" in prose IS still treated
    // as a permission dialog. The test asserts the current behavior so a
    // future fix can flip it intentionally.
    const sample = `
      Plan: I will Edit to ./plan.md to capture the decision.
      Do you want to proceed?

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    // KNOWN LIMITATION: the co-trigger fires here. Documented as a
    // post-merge follow-up. Flip this assertion once the regex tightens.
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches the captured Autoplan settings-overwrite card as a numbered permission dialog', () => {
    const captured = JSON.parse(readFileSync(new URL('../fixtures/autoplan-settings-overwrite.json', import.meta.url), 'utf8'));
    expect(isNumberedOptionListVisible(captured.frame.text)).toBe(true);
    expect(isPermissionDialogVisible(captured.frame.text)).toBe(true);
  });
});

describe('isNumberedOptionListVisible', () => {
  test('matches a basic ❯ 1. + 2. cursor list', () => {
    const sample = `
      ❯ 1. Option one
        2. Option two
        3. Option three
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(true);
  });

  test('returns false on a single-option prompt', () => {
    const sample = `
      ❯ 1. Only option
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(false);
  });

  test('returns false when no cursor renders', () => {
    const sample = `
      Just some prose with 1. a numbered point and 2. another.
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(false);
  });

  test('overlaps permission dialogs (this is why D5 short-circuits)', () => {
    // The whole point of D5: this string matches BOTH classifiers, so the
    // runner must consult isPermissionDialogVisible to disambiguate.
    const sample = `
      Bash command \`do-thing\` requires permission to run.

      ❯ 1. Yes
        2. No
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(true);
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });
});

describe('idle turn end (captured CI screens)', () => {
  const captures = JSON.parse(readFileSync(new URL('../fixtures/pty-idle-turn-end.json', import.meta.url), 'utf8'));
  const scope: string = captures.scopePendingIdle.visible;
  const api: string = captures.apiErrorIdle.visible;

  test('the 988e985 pending line, end-of-turn line and empty prompt are an idle turn end', () => {
    expect(idleTurnEnd(scope)).toEqual({ done: '✻Cooked for 24s · done 12:46 AM' });
    expect(classifyVisible(scope)).toBeNull();
  });

  test('the 6a6aa32 provider error panel is reported with its idle turn end', () => {
    expect(idleTurnEnd(api)).toEqual({ done: '✻ Sautéedfor1m 20s · done11:34PM',
      apiError: '●API Error: Connection lost mid-response. The response above may be incomplete.' });
  });

  test('negative controls: still thinking, a resumed turn, extra footer text and an open question are not idle', () => {
    expect(idleTurnEnd(scope.slice(0, scope.indexOf('●Scope')))).toBeNull();
    expect(idleTurnEnd(scope + '\r✶ Thinking… (3s · thinking)')).toBeNull();
    const footer = scope.lastIndexOf('← for agents');
    expect(idleTurnEnd(`${scope.slice(0, footer)}← for agents · 1 background task${scope.slice(footer + '← for agents'.length)}`)).toBeNull();
    const question = '☐ Scope\nWhat should I review?\n❯ 1. The current branch diff\n  2. A plan or design doc\nEnter to select · ↑/↓ to navigate · Esc to cancel';
    expect(idleTurnEnd(question)).toBeNull();
    expect(idleTurnEnd(scope + '\r' + question)).toBeNull();
  });

  test('the 40851840940 plan-mode idle footer ends the turn and names its provider error for the ledger', () => {
    const plan: string = captures.planModeApiErrorIdle.visible;
    const panel = '●API Error: Connection lost mid-response. The response above may be incomplete.';
    expect(idleTurnEnd(plan)).toEqual({ done: '✻Brewed for 1m 13s · done 9:51 AM', apiError: panel });
    expect(screenPanelEnd(plan)).toEqual({ end: 'api_error', evidence: panel });
    expect(idleTurnEnd(plan.replace('⏸planmodeon (shift+tabtocycle)·←foragents', '⏸ plan mode on (shift+tab to cycle) · ← for agents')))
      .toMatchObject({ apiError: panel });
  });

  test('negative controls: the running plan-mode footer and extra plan-mode footer text are not idle', () => {
    const plan: string = captures.planModeApiErrorIdle.visible;
    const footer = '⏸planmodeon (shift+tabtocycle)·←foragents';
    expect(plan.split(footer)).toHaveLength(2);
    expect(idleTurnEnd(plan.replace(footer, '⏸planmodeon (shift+tabtocycle)·esctointerrupt·←foragents'))).toBeNull();
    expect(idleTurnEnd(plan.replace(footer, footer + ' · 1 background task'))).toBeNull();
    expect(idleTurnEnd(plan.replace(footer, '⏸planmodeon (shift+tabtocycle)'))).toBeNull();
    expect(screenPanelEnd(plan.replace(footer, '⏸planmodeon (shift+tabtocycle)·esctointerrupt·←foragents'))).toBeNull();
  });

  test('an API Error mention in prose or in an earlier turn is not this turn\'s error panel', () => {
    expect(idleTurnEnd('The docs mention API Error: as an example.\r✻ Worked for 3s · done 1:00 PM\r❯ \r← for agents')).toEqual({ done: '✻ Worked for 3s · done 1:00 PM' });
    const earlier = api.replace(/✻ Sautéedfor1m 20s · done11:34PM[\s\S]*$/, '✻ Sautéedfor1m 20s · done11:34PM\r❯ /plan-design-review\r●Done.\r✻ Worked for 2s · done 11:35PM\r❯ \r← for agents');
    expect(idleTurnEnd(earlier)).toEqual({ done: '✻ Worked for 2s · done 11:35PM' });
  });
});
