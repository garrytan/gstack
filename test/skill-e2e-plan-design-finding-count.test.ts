/**
 * /plan-design-review per-finding AskUserQuestion count (periodic, paid, real-PTY).
 *
 * Same shape as skill-e2e-plan-ceo-finding-count: drives /plan-design-review
 * against a 5-finding seeded plan and asserts review-phase AUQ count ∈ [N-1, N+2].
 * Plus D19: review report at bottom of produced plan file.
 *
 * Tier: periodic (~25 min, ~$5/run). Sequential by default per plan §D15.
 */

import { test } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPlanSkillCounting,
  designStep0Boundary,
  designFirstReviewAUQ,
  assertReviewReportAtBottom,
} from './helpers/claude-pty-runner';

const describeE2E = describeE2ETier('periodic');

const N = 5;
const FLOOR = N - 1;
const CEILING = N + 2;

// A known surrounding design prevents missing layout/journey/state contracts
// from becoming legitimate extra findings unrelated to the five seeded gaps.
const designSystem = [
  '# Approved account-settings design system',
  '',
  'Reuse the existing single-column settings shell: persistent app navigation,',
  'page title and description, action group, then Profile and Notifications fieldsets.',
  'The form has a 640px maximum width. Reuse existing Button, Field, InlineStatus,',
  'ErrorSummary and ConfirmationDialog components; no new component family is needed.',
  'Profile contains Display name (text) and Email (email). Notifications contains',
  'Weekly digest and Product tips switches. Existing server defaults are the',
  'account name/email, Weekly digest on, and Product tips off; labels/order stay fixed.',
  'The page title “Account settings” is h1. Profile and Notifications are h2',
  'headings that label their fieldsets via aria-labelledby; no heading level is skipped.',
  'The existing DOM and visual order are:',
  '```text',
  'Persistent app navigation',
  'main: Account settings (h1) + description',
  '  Save | Reset | Cancel | Export',
  '  InlineStatus',
  '  Profile (h2): Display name, Email',
  '  Notifications (h2): Weekly digest, Product tips',
  '```',
  '',
  'Save is the only filled primary action (#1d4ed8 with white text). Reset, Cancel',
  'and Export are neutral ghost buttons; destructive intent is explained in the',
  'existing confirmation dialog, whose default is Cancel. All targets are at least 44px.',
  'Spacing uses an 8px base: sections 32px, field groups 24px, label-to-input 8px.',
  'Typography has two roles: 16px body/form labels/helper text, 20px section headings.',
  'Use error.text #991b1b on error.surface #fef2f2 with an icon and explicit text.',
  'All text must meet WCAG AA contrast; never communicate status through color alone.',
  'Focus-visible is the existing 2px solid #1d4ed8 outline, offset 2px on white;',
  'its measured contrast exceeds 3:1. Reuse it on all controls and dialog actions.',
  '',
  'The established pending-action pattern is an inline spinner beside “Saving…”',
  'inside the disabled Save button, aria-busy=true, with reduced-motion support.',
  'Success uses the persistent inline status “Saved” plus the save time (aria-live=polite).',
  'The existing formatter renders “Saved at HH:mm” in the user’s local 24-hour time.',
  'Editing a field away from its saved value changes that same persistent status',
  'to “Unsaved changes” (role=status, aria-live=polite, aria-atomic=true); text',
  'communicates the dirty state without relying on color or button enabled state.',
  'Reverting all edits or confirming Reset restores “Saved at HH:mm” for the',
  'last successful save. Failed saves retain “Unsaved changes” alongside the error.',
  'Reset dialog: “Discard unsaved changes?” / “Your saved preferences will be restored.”',
  'Its actions are “Keep editing” (default) and “Discard changes”. Cancel navigation',
  'uses the same dialog with “Keep editing” (default) and “Discard and leave”.',
  'Validation errors appear beside fields and in a linked error summary; focus the',
  'first invalid field. Network errors preserve edits and show Retry in that status area.',
].join('\n');

const planDesign5Findings = (planPath: string) => [
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${planPath} (use Edit/Write to that exact path).`,
  // The skill explicitly supports this opt-out. The cadence test measures
  // review findings; generated-variant preference questions have separate evals.
  'Text-only review; skip mockups. Review all seven design dimensions.',
  '',
  '# Plan: Settings Page UI redesign',
  '',
  '## Existing product and accepted behavior',
  'This updates an existing account-settings form using the checked-in DESIGN.md.',
  'The shell and components already exist. Profile and Notifications are the only',
  'sections, with visible headings and associated field labels. The page header',
  'contains the title, a short description, and Save/Reset/Cancel/Export actions.',
  'Preserve the approved single-column structure and component behavior.',
  'The page title “Account settings” is h1. Profile and Notifications are h2',
  'headings that label their fieldsets via aria-labelledby; no heading level is skipped.',
  'The existing DOM and visual order are:',
  '```text',
  'Persistent app navigation',
  'main: Account settings (h1) + description',
  '  Save | Reset | Cancel | Export',
  '  InlineStatus',
  '  Profile (h2): Display name, Email',
  '  Notifications (h2): Weekly digest, Product tips',
  '```',
  '',
  'Journey: a user arrives from account navigation wanting to adjust preferences,',
  'edits the labeled fields, saves, and reads the inline Saved timestamp before',
  'leaving. The feedback preserves confidence that their preferences were stored.',
  'The persistent InlineStatus has role=status, aria-live=polite, aria-atomic=true.',
  'After success it reads “Saved at HH:mm” in the user’s local 24-hour time.',
  'Editing away from a saved value changes its text to “Unsaved changes”, so',
  'dirty state never relies on color or the Save button being enabled. Reverting',
  'all edits or confirming Reset restores the last successful save timestamp.',
  'Failed saves retain “Unsaved changes” alongside the error message.',
  'Initial loading uses the existing form skeleton. A new account sees useful',
  'default preferences as specified in DESIGN.md rather than an empty page. Read failures show Retry.',
  'Save is atomic: all fields persist together or none do, so partial success is',
  'not exposed. Field validation, network failure, and successful-save feedback',
  'use the exact existing DESIGN.md patterns. Preserve unsaved values after errors.',
  'Disable repeat Save submissions while pending. Reset restores saved values only',
  'after confirmation; Cancel confirms discarding dirty edits before returning to',
  'the previous page; Export downloads the current saved preferences as JSON.',
  '',
  'Responsive behavior: above 640px keep the header action group in one row; at',
  '640px and below, place full-width Save first and the three secondary actions',
  'below it, preserving DOM/tab order. The form fits 320px without horizontal scroll.',
  'All controls have visible focus rings and 44px targets. Use semantic fieldsets,',
  'labels, a main landmark and heading order; errors link through aria-describedby.',
  'Focus-visible on every control and dialog action is the existing 2px solid',
  '#1d4ed8 outline, offset 2px on white, with measured contrast above 3:1.',
  'Dialogs trap focus and restore it on close; Escape cancels. Export remains a',
  'clearly labeled button. Respect reduced motion. No additional visual exploration',
  'or component replacement is part of this established form update.',
  '',
  '## Planned implementation gaps',
  'The proposed form still has the following inconsistencies with that design:',
  '',
  '## Visual Hierarchy',
  'The "Save" button is rendered with the same size, weight, and color as',
  'three other buttons in the page header (Reset, Cancel, Export). Nothing',
  'tells the user which is the primary action.',
  '',
  '## Spacing',
  'Between sections we have 24px in some places, 32px in others, and 16px',
  'in a third — no consistent vertical rhythm.',
  '',
  '## Color',
  'The error message uses red text on a light pink background. Contrast',
  'ratio is approximately 3:1 (below WCAG AA).',
  '',
  '## Typography',
  'We use 14px, 16px, and 18px font sizes across the form labels. Two',
  'sizes would suffice and create stronger hierarchy.',
  '',
  '## Motion',
  'The "Save" action takes 2-5 seconds with no loading indicator. Users',
  'see a frozen page; we should add a spinner or skeleton state.',
].join('\n');

describeE2E('/plan-design-review per-finding AskUserQuestion count (periodic)', () => {
  test(
    `5-finding plan emits ${FLOOR}-${CEILING} review-phase AskUserQuestions`,
    async () => {
      // Per-run artifact dir: a hardcoded shared /tmp path collides under
      // --retry, EVALS_JOBS>1, or concurrent worktrees (a sibling's finally-
      // rmSync deletes this run's artifact → spurious D19 failure).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-e2e-plan-design-'));
      const planPath = path.join(tmpDir, 'gstack-test-plan-design.md');

      try {
        const obs = await runPlanSkillCounting({
          skillName: 'plan-design-review',
          slashCommand: '/plan-design-review',
          followUpPrompt: planDesign5Findings(planPath),
          isLastStep0AUQ: designStep0Boundary,
          isFirstReviewAUQ: designFirstReviewAUQ,
          fixtureFiles: { 'DESIGN.md': designSystem },
          reviewCountCeiling: CEILING + 1,
          timeoutMs: 1_500_000,
          env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
        });

        if (!['plan_ready', 'completion_summary', 'ceiling_reached'].includes(obs.outcome)) {
          throw new Error(
            `plan-design-review finding-count FAILED: outcome=${obs.outcome}\n` +
              `step0=${obs.step0Count} review=${obs.reviewCount} elapsed=${obs.elapsedMs}ms\n` +
              `fingerprints (last 8):\n` +
              obs.fingerprints
                .slice(-8)
                .map(
                  (f, i) =>
                    `  ${i}. preReview=${f.preReview} sig=${f.signature.slice(0, 12)} prompt="${f.promptSnippet.slice(0, 60)}"`,
                )
                .join('\n') +
              `\n--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        if (obs.reviewCount < FLOOR) {
          throw new Error(
            `BAND FAIL (below floor): reviewCount=${obs.reviewCount} < FLOOR=${FLOOR}.\n` +
              `outcome=${obs.outcome} step0=${obs.step0Count} elapsed=${obs.elapsedMs}ms\n` +
              `summary: ${obs.summary}\n` +
              `All captured fingerprints (including Step 0):\n` +
              obs.fingerprints
                .map(
                  (f) =>
                    `  - preReview=${f.preReview} sig=${f.signature.slice(0, 12)} prompt="${f.promptSnippet}"`,
                )
                .join('\n') +
              `\n--- evidence (last 3KB) ---\n${obs.evidence}`,
          );
        }
        if (obs.reviewCount > CEILING) {
          throw new Error(
            `BAND FAIL (above ceiling): reviewCount=${obs.reviewCount} > CEILING=${CEILING}.\n` +
              `Captured observation:\n${JSON.stringify(obs, null, 2)}`,
          );
        }

        if (!fs.existsSync(planPath)) {
          throw new Error(
            `D19 FAIL: agent did not produce expected plan file at ${planPath}. ` +
              `outcome=${obs.outcome} review=${obs.reviewCount}`,
          );
        }
        const planContent = fs.readFileSync(planPath, 'utf-8');
        const verdict = assertReviewReportAtBottom(planContent);
        if (!verdict.ok) {
          throw new Error(
            `D19 FAIL: plan file at ${planPath} ${verdict.reason}\n` +
              (verdict.trailingHeadings
                ? `Trailing headings: ${verdict.trailingHeadings.join(' | ')}\n`
                : '') +
              `--- plan content (last 1KB) ---\n${planContent.slice(-1024)}`,
          );
        }
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    1_500_000 /* physical ceiling: the 25-min CI job + 1800s shard wall cap what can actually execute */,
  );
});
