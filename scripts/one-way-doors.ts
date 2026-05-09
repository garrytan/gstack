/**
 * One-Way Door Classifier — belt-and-suspenders safety layer.
 *
 * Primary safety gate is the `door_type` field in scripts/question-registry.ts.
 * Every registered AskUserQuestion declares whether it is one-way (always ask,
 * never auto-decide) or two-way (can be suppressed by explicit user preference).
 *
 * This file is a SECONDARY keyword-pattern check for questions that fire
 * WITHOUT a registry id (ad-hoc question_ids generated at runtime). If the
 * question_summary contains any of the destructive keyword patterns, treat
 * it as one-way regardless of what the (absent or unknown) registry entry says.
 *
 * Codex correctly pointed out (design doc Decision C) that prose-parsing is
 * too weak to be the PRIMARY safety gate — wording can change. The registry
 * is primary. This is the fallback for questions not yet catalogued, and it
 * errs on the side of asking the user even when tuning preferences say skip.
 *
 * Ordering
 * --------
 * isOneWayDoor() is called by gstack-question-sensitivity --check in this
 * order:
 *   1. Look up registry by id → use registry.door_type if found
 *   2. If not in registry: apply keyword patterns below
 *   3. Default to ASK_NORMALLY (safer than AUTO_DECIDE)
 */

import { getQuestion } from './question-registry';

/**
 * Keyword patterns that identify one-way-door questions when the registry
 * doesn't have an entry for the question_id. Case-insensitive substring match
 * against the question_summary passed into AskUserQuestion.
 *
 * Additions here should be conservative — a false positive means the user
 * gets asked an extra question they might have preferred to auto-decide.
 * A false negative could mean auto-approving a destructive operation.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // File system destruction
  /\brm\s+-rf\b/i,
  /\bdelete\b/i,
  /\bremove\s+(directory|folder|files?)\b/i,
  /\bwipe\b/i,
  /\bpurge\b/i,
  /\btruncate\b/i,

  // Database destruction
  /\bdrop\s+(table|database|schema|index|column)\b/i,
  /\bdelete\s+from\b/i,

  // Git / VCS destruction
  /\bforce[- ]push\b/i,
  /\bpush\s+--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bcheckout\s+--\b/i,
  /\brestore\s+\.\b/i,
  /\bclean\s+-f\b/i,
  /\bbranch\s+-D\b/i,

  // Deploy / infra destruction
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+destroy\b/i,
  /\brollback\b/i,

  // Credentials / auth — allow filler words ("the", "my") between verb and noun
  /\brevoke\s+[\w\s]*\b(api key|token|credential|access key|password)\b/i,
  /\breset\s+[\w\s]*\b(api key|token|password|credential)\b/i,
  /\brotate\s+[\w\s]*\b(api key|token|secret|credential|access key)\b/i,

  // Scope / architecture forks (reversible with effort — still deserve confirmation)
  /\barchitectur(e|al)\s+(change|fork|shift|decision)\b/i,
  /\bdata\s+model\s+change\b/i,
  /\bschema\s+migration\b/i,
  /\bbreaking\s+change\b/i,
];

/**
 * Skill-category combinations that are always one-way even when the question
 * body looks benign. Matches the ownership model: certain skill actions are
 * inherently high-stakes.
 */
const ONE_WAY_SKILL_CATEGORIES = new Set<string>([
  'cso:approval', // security-audit findings
  'land-and-deploy:approval', // anything /land-and-deploy asks
]);

export interface ClassifyInput {
  /** Registry id OR ad-hoc id; looked up first */
  question_id?: string;
  /** Skill firing the question (for skill-category fallback) */
  skill?: string;
  /** Question category (approval | clarification | routing | cherry-pick | feedback-loop) */
  category?: string;
  /** Free-form question summary — pattern-matched against destructive keywords */
  summary?: string;
}

export interface ClassifyResult {
  /** true = treat as one-way door (always ask, never auto-decide) */
  oneWay: boolean;
  /** Which check triggered the classification (for audit/debug) */
  reason: 'registry' | 'skill-category' | 'keyword' | 'default-safe' | 'default-two-way';
  /** Matched pattern if reason is 'keyword' */
  matched?: string;
}

/**
 * Classify a question as one-way (always ask) or two-way (can be suppressed).
 * Returns {oneWay: false, reason: 'default-two-way'} only when no evidence of
 * one-way nature is found. Errs conservatively otherwise.
 */
export function classifyQuestion(input: ClassifyInput): ClassifyResult {
  // 1. Registry lookup (primary)
  if (input.question_id) {
    const registered = getQuestion(input.question_id);
    if (registered) {
      return {
        oneWay: registered.door_type === 'one-way',
        reason: 'registry',
      };
    }
  }

  // 2. Skill-category fallback (certain combos are always one-way)
  if (input.skill && input.category) {
    const key = `${input.skill}:${input.category}`;
    if (ONE_WAY_SKILL_CATEGORIES.has(key)) {
      return { oneWay: true, reason: 'skill-category' };
    }
  }

  // 3. Keyword pattern match (catch destructive questions without registry entry)
  if (input.summary) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(input.summary)) {
        return {
          oneWay: true,
          reason: 'keyword',
          matched: pattern.toString(),
        };
      }
    }
  }

  // 4. No evidence either way — treat as two-way (can be preference-suppressed).
  return { oneWay: false, reason: 'default-two-way' };
}

/**
 * Convenience wrapper for the sensitivity check binary.
 * Returns true if the question must be asked regardless of user preferences.
 */
export function isOneWayDoor(input: ClassifyInput): boolean {
  return classifyQuestion(input).oneWay;
}

/**
 * Export patterns for tests and audit tooling.
 */
export const DESTRUCTIVE_PATTERN_LIST = DESTRUCTIVE_PATTERNS;
export const ONE_WAY_SKILL_CATEGORY_SET = ONE_WAY_SKILL_CATEGORIES;
