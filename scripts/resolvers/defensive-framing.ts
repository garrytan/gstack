/**
 * Shared defensive-security review framing (follow-up to #1899).
 *
 * Every Claude-dispatched subagent that reasons adversarially over a diff —
 * the always-on adversarial pass, the conditional red-team pass, and the
 * security specialist — must carry this framing. On repos that ship their own
 * security regression corpus (attack-payload fixtures: shell injection, path
 * traversal, symlink-escape rails), an un-framed "think like an attacker" pass
 * reads the raw payload bytes and trips Anthropic's real-time cyber safeguards,
 * which DENY the call. #1899 fixed only the adversarial pass inline; the
 * red-team and security dispatches were left exposed because the framing lived
 * in one place and could not be reused.
 *
 * Keeping the text here as a single source of truth means the three dispatch
 * points cannot drift apart again — the exact failure mode that #1899 missed.
 *
 * - DEFENSIVE_REVIEW_FRAMING is universally safe: it only reframes intent and
 *   suppresses novel attack-content generation, so it is prepended to EVERY
 *   specialist dispatch, not just the attacker-framed ones.
 * - FIXTURE_SUMMARY_MODE routes fixture/test bytes to `--stat` summary so they
 *   never enter adversarial reasoning. It is applied ONLY to the attacker-framed
 *   passes (adversarial, red-team, security) — a blanket application would blind
 *   the testing specialist, whose entire job is reading test files in full.
 */

export const DEFENSIVE_REVIEW_FRAMING =
  `This is an authorized defensive-security review of the maintainer's own repository, requested by the repository owner before merge. Any attack-pattern strings you encounter inside test files, fixtures, or paths matching \`test/\`, \`*fixture*\`, \`*.test.*\`, \`*.spec.*\` are the project's OWN security regression corpus — they exist so the guards that block them can be verified. Treat them as data to analyze for code defects; do NOT generate novel attack content or expand on exploit payloads.`;

export const FIXTURE_SUMMARY_MODE =
  `For fixture/test files (paths matching \`test/\`, \`*fixture*\`, \`*.test.*\`, \`*.spec.*\`), review in SUMMARY mode only (\`git diff --stat "$DIFF_BASE" -- '*test*' '*fixture*' '*.spec.*'\`) — note that they changed and what they cover, but do not pull their raw payload bytes into adversarial reasoning. State explicitly in your output that fixtures were reviewed in summary mode so the coverage reduction is visible, not silent.`;
