/**
 * Result codes for the plain-English title check (lib/plain-title.ts,
 * bin/gstack-plain-title, the "Plain title" CI check; R76). Kept beside
 * lib/result-codes.ts (which spreads this table into RESULT_CODES) so the owner
 * module stays within the module-size ratchet; the same rules apply: one stable
 * docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const PLAIN_RESULT_CODES = {
  PLAIN_TITLE_REFUSED: {
    anchor: 'plain-title-refused',
    summary: 'the PR title has a tracker code, a project-only word or a type(scope): prefix before its trailing reference group',
    fix: 'rewrite the title as a plain sentence about what changed for someone using the project; keep at most one trailing group like (ABC-123)',
  },
  PLAIN_BRANCH_REFUSED: {
    anchor: 'plain-branch-refused',
    summary: 'the branch name has a tracker code or a project-only word before its last segment',
    fix: 'name the branch in plain words, with at most one tracker code at the very end (owner/what-changed-abc-123)',
  },
  PLAIN_OPENING_REFUSED: {
    anchor: 'plain-opening-refused',
    summary: 'the PR body does not open with one or two plain sentences',
    fix: 'start the body with one or two sentences saying what changed and which goal of the project it serves; move codes and records to the Agent notes section at the end',
  },
  PLAIN_CHANGELOG_REFUSED: {
    anchor: 'plain-changelog-refused',
    summary: 'the changelog entry has a tracker code, or a project-only word in its bold lead',
    fix: 'drop tracker codes from the entry and rewrite the bold lead in everyday words',
  },
  PLAIN_COMMIT_REFUSED: {
    anchor: 'plain-commit-refused',
    summary: 'a commit subject has a tracker code, a project-only word or a type(scope): prefix before its trailing reference group',
    fix: 'write later commit subjects as plain sentences; the squash commit takes the PR title, so this is a warning only',
  },
  PLAIN_POLICY_INVALID: {
    anchor: 'plain-policy-invalid',
    summary: '.gstack/plain-titles.json is not valid JSON or breaks the schema; the line names the key',
    fix: 'fix the named key (codes, terms, allow, since, exempt_branch_prefixes), then run gstack-plain-title validate',
  },
} as const satisfies Record<string, ResultCode>;
