import type { TemplateContext } from './types';

// Test value bar shared by plan-eng-review and ship (through the coverage audit),
// qa/qa-only ({{TEST_VALUE_BAR:qa}}) and test-audit ({{TEST_VALUE_BAR:audit}}).
// The static review/specialists/testing.md repeats these constants and is kept
// in sync by test/test-value-bar.test.ts.
// Adapted from openclaw/openclaw@a214e76, .agents/skills/test-audit/SKILL.md.

export const TEST_VALUE_BAR_MODES = ['plan', 'ship', 'qa', 'audit'] as const;
export type TestValueBarMode = (typeof TEST_VALUE_BAR_MODES)[number];

export const QUESTIONS = [
  'What observable behavior, invariant or independent contract does it protect?',
  'What credible regression makes it fail?',
  'Why does existing coverage not already catch that? Prefer adding a row to an existing table-driven test or shared fixture over a near-duplicate.',
  'Does it need a production seam (export, flag, wrapper, injection hook) that no production caller needs? If yes, test at the real boundary instead.',
] as const;

export const VALUE_CARD_FIELDS = ['protects', 'fails_when', 'why_new', 'seam'] as const;
export const CARD_FIELD_MAX_BYTES = 160;

export const CATALOG = [
  'assertion-free coverage probes',
  'self-comparisons and identity copies',
  'copied fixtures, inventories or export lists',
  'exact source, import or string greps that are not a declared contract',
  'private predicate or call-shape tests duplicated at a real boundary',
  'duplicate invocations of the same contract',
  "per-caller replays of a shared helper's tests",
  'tests whose only purpose is keeping a test-only export, global or wrapper alive',
  'production code whose only callers are tests',
] as const;

export const RETIREMENT_FIELDS = ['test', 'detects', 'non_test_callers', 'search_command', 'stronger_proof', 'history', 'unlocks', 'validation'] as const;
export const REVIEW_EVIDENCE_FIELDS = ['detects', 'non_test_callers', 'search_command', 'stronger_proof'] as const;
export const REASON_CODES = ['duplicate_protects', 'needs_seam', 'incomplete_card', 'no_credible_regression', 'covered_elsewhere', 'implementation_coupled'] as const;
export const WEAK_REASONS = ['star_one', 'gate_failed', 'unrated'] as const;
export const PRAGMA = 'gstack:test-value keep';
export const SWEEP_POINTER = 'Repo-wide sweep: run /test-audit.';

export const RETENTION_ONE_LINER = 'Retention bar: keep a test that independently enforces a public API, protocol, config, migration, storage, security, platform, default, prompt-byte, generated-output (golden), package, release or architecture contract; static or slow is no reason to delete.';

export const CALLER_SEARCH_COMMAND = "git grep -n -F -w -e '<symbol>' -- . ':!test/' ':!tests/' ':!spec/' ':!**/__tests__/**' ':!**/*.test.*' ':!**/*.spec.*' ':!**/*_test.*' ':!**/test_*.py'";
export const CALLER_SYMBOL_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

export const DOCS_PAGE = 'docs/test-value-bar.md';

export const MESSAGES = {
  ratingUnavailable: {
    message: 'rating unavailable: the read-only rating dispatch failed or timed out, so the coverage gate is skipped for this run. Re-run Step 7 to re-rate the tests.',
    anchor: 'rating-unavailable',
  },
  valueCoverageUnavailable: {
    message: 'value-weighted coverage unavailable (outdated installed skill); run /gstack-upgrade. The gate used coverage_pct (any test) this run.',
    anchor: 'value-weighted-coverage-unavailable',
  },
  inconsistentCoverage: {
    message: 'inconsistent coverage inputs: coverage_pct_value was above coverage_pct, so it was clamped to coverage_pct. Re-run Step 7 if the numbers look wrong.',
    anchor: 'inconsistent-coverage-inputs',
  },
  malformedKey: {
    message: 'malformed <key> ignored: the audit returned the wrong type, so it counts as empty. The likely cause is an outdated installed skill; run /gstack-upgrade.',
    anchor: 'malformed-key-ignored',
  },
  allRejected: {
    message: 'all <N> generated tests rejected by machine checks; see tests_rejected. The gate proceeds with the unchanged value-weighted coverage.',
    anchor: 'all-generated-tests-rejected',
  },
  baseControlUnavailable: {
    message: 'base control unavailable: <reason>. The fails-at-HEAD result still stands. To check by hand: `git worktree add --detach <tmp> <base>`; copy the test and its new fixtures to the same paths; run the detected test command in <tmp>; `git worktree remove --force <tmp>`. Then report `passes at base: manual`.',
    anchor: 'base-control-unavailable',
  },
  callerCheckUnavailable: {
    message: 'caller check unavailable: <command or "unsupported symbol">. The finding stays INFORMATIONAL and nothing is proposed for deletion; run the search by hand to complete the evidence.',
    anchor: 'caller-check-unavailable',
  },
  unknownMode: {
    message: 'Unknown TEST_VALUE_BAR mode <x>; expected plan|ship|qa|audit. Fix the placeholder or add the mode in scripts/resolvers/test-value.ts.',
    anchor: 'unknown-test-value-bar-mode',
  },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function degradedMessage(ctx: TemplateContext, key: MessageKey): string {
  const { message, anchor } = MESSAGES[key];
  return `${message} (see ${ctx.paths.skillRoot}/${DOCS_PAGE}#${anchor})`;
}

export function generateTestValueMessage(ctx: TemplateContext, args?: string[]): string {
  const key = args?.[0] ?? '';
  if (!(key in MESSAGES)) throw new Error(`Unknown TEST_VALUE_MESSAGE key ${key}; expected ${Object.keys(MESSAGES).join('|')} (scripts/resolvers/test-value.ts)`);
  return degradedMessage(ctx, key as MessageKey);
}

// Measured renders plus 15%: plan 1897, ship 2742, qa 1036, audit 3712 bytes.
export const TEST_VALUE_BAR_MAX_BYTES: Record<TestValueBarMode, number> = { plan: 2182, ship: 3154, qa: 1192, audit: 4269 };

export function clampCardField(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= CARD_FIELD_MAX_BYTES) return value;
  let end = CARD_FIELD_MAX_BYTES - 3;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}...`;
}

export function renderValueCard(card: Record<(typeof VALUE_CARD_FIELDS)[number], string>): string {
  return `Value: ${VALUE_CARD_FIELDS.map(field => `${field}=${clampCardField(card[field])}`).join('; ')}`;
}

const EXAMPLE_CARD = renderValueCard({
  protects: 'refundPayment rejects an empty reason',
  fails_when: 'the reason guard is removed or inverted',
  why_new: 'billing.test.ts covers processPayment only',
  seam: 'none',
});

const EXAMPLE_REJECTED = 'Rejected (covered_elsewhere): "checkout renders"; checkout.e2e.ts:15 covers it, so extend that test.';

function questionList(mode: TestValueBarMode): string {
  const questions = mode === 'qa' ? QUESTIONS.slice(2) : QUESTIONS;
  return questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
}

function cardRules(mode: TestValueBarMode, skillName: string): string {
  const where = {
    plan: 'One card per Critical Path and Edge Case in the Test Plan Artifact.',
    ship: 'Write it as a header comment in each generated test, next to the attribution (wrap, do not truncate); with no known comment syntax, put it in the PR body\'s Test value details.',
    qa: skillName === 'qa-only' ? 'Put it under each proposed test.' : 'Put it in the 8e.5 record.',
    audit: 'Read cards from test header comments when present.',
  }[mode];
  return `Value card: \`Value: protects=<...>; fails_when=<...>; why_new=<...>; seam=none\` (seam: \`none\` or its name); each field at most ${CARD_FIELD_MAX_BYTES} UTF-8 bytes here (clamp to 157 plus \`...\`; written JSON keeps full values). ${where} A missing upstream card never blocks: derive it; ignore unknown fields.

Example: ${EXAMPLE_CARD}
${EXAMPLE_REJECTED}`;
}

const STAR_RULE = 'Weak tests (★ smoke/existence/trivial, gate-failing or unrated) never count as coverage. X = paths with a ★★/★★★ test / total paths (value-weighted; the gate uses X); Y = paths with any test / total paths.';

const WEAK_PATH_RULE = `Total paths = the diff's codepath trace, max 30; zero skips the gate. A path with only weak tests is uncovered in X, covered in Y, and goes to \`weak_gaps\` (reason \`${WEAK_REASONS.join('|')}\`), not \`gaps\`. Rate stars only for tests reachable from changed paths.`;

const RED_PROOF = `Regression proof: a regression test must fail at HEAD before any repair, in its own assertion (a pass at HEAD drops the regression label; an import, fixture or env failure is a test defect: correct once or drop). It must pass at base as the control (an assertion failure there marks it invalid; any other failure is "base control unavailable: collection error") and pass after the repair. Record: \`Regression proof — fails at HEAD: yes · passes at base: yes | unavailable (<reason>) | manual · passes after fix: yes | pending\`.`;

function auditSections(): string {
  return `Low-value catalog (a match fails the gate unless the retention bar names the contract it guards):
${CATALOG.map(entry => `- ${entry}`).join('\n')}

Retention bar: keep a test that independently enforces a public API, protocol, config, migration, storage, security, platform, default, prompt-byte, generated-output (SKILL.md golden), package, release or architecture contract; call order when order is observable; source inspection when it is the cheapest independent guard. Never retire anything reachable from the package entrypoint (\`package.json\` exports/main, index re-exports). Static or slow is not a reason to delete. Skip a test carrying \`${PRAGMA} reason="<why>"\` and list it as suppressed.

Retirement card, complete before any edit: ${RETIREMENT_FIELDS.map(field => `\`${field}\``).join(', ')}. Caller check for a symbol matching \`${CALLER_SYMBOL_PATTERN}\` (otherwise "caller check unavailable: unsupported symbol"): \`${CALLER_SEARCH_COMMAND}\`; record the command, exclusions and hit count. The evidence is grep-only (no re-exports, dynamic dispatch or generated code), so production code is retired only when the repo's typecheck/build or dead-code tool passes with it removed in a scratch worktree.`;
}

export function generateTestValueBar(ctx: TemplateContext, args?: string[]): string {
  const mode = args?.[0] as TestValueBarMode;
  if (!TEST_VALUE_BAR_MODES.includes(mode)) throw new Error(MESSAGES.unknownMode.message.replace('<x>', String(args?.[0])));
  const parts = [
    `**Test value bar.** ${mode === 'qa' ? 'Before writing or proposing a test, the reproduced bug already answers what it protects and what makes it fail; also answer:' : 'Propose or write a test only with all four answers; otherwise extend an existing test or drop it:'}`,
    questionList(mode),
    cardRules(mode, ctx.skillName),
  ];
  if (mode !== 'qa') parts.splice(2, 0, 'A test that breaks under a behavior-preserving refactor asserts implementation: rewrite it at the owning boundary, unless exact output is the declared contract (goldens, prompt bytes, wire formats).');
  if (mode === 'plan') parts.push(`${STAR_RULE} /ship computes them; here every proposed test needs a card.`, RETENTION_ONE_LINER);
  if (mode === 'ship') parts.push(`${STAR_RULE} ${WEAK_PATH_RULE}`, RETENTION_ONE_LINER);
  if (mode === 'ship' || mode === 'audit') parts.push(RED_PROOF);
  if (mode === 'audit') parts.push(auditSections());
  const rendered = parts.join('\n\n');
  const bytes = Buffer.byteLength(rendered, 'utf8');
  const budget = TEST_VALUE_BAR_MAX_BYTES[mode];
  if (bytes > budget) throw new Error(`TEST_VALUE_BAR mode '${mode}' renders ${bytes} bytes, budget ${budget} (over by ${bytes - budget}). Trim the mode's section in scripts/resolvers/test-value.ts or raise the ceiling with a reason.`);
  return rendered;
}
