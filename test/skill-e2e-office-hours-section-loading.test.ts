/**
 * Full office-hours startup workflow, isolated from the generic carve shard.
 * A fixed interview exercises real opinion/design/review/approval/handoff work.
 * Free completion regressions live in office-hours-completion.test.ts.
 */
import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeE2ETier } from './helpers/e2e-gate';
import { setupSkillDir, skillFromWorktree, captureSectionReads } from './helpers/auq-sdk-capture';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { validateOfficeHoursCompletion, validateOfficeHoursReviewerHandoffs, validateOfficeHoursReviewArtifacts, validateOfficeHoursReviewPreservation } from './helpers/office-hours-completion';

const describeE2E = describeE2ETier('periodic');
const runId = `office-hours-section-loading-${process.env.EVALS_RUN_ID ?? 'local'}`;

// Full startup diagnosis + outside opinion + up to three spec reviews exceeds
// the generic carve's 480s capture (reproduced inside the second review). Keep
// this exception local: the valid three-review path exceeded 840s before
// approval/reporting. One 1200s capture plus a 45s preservation judgment fits
// the 1260s outer guard, leaving 540s in the 1800s shard wall. Disable retries
// for this case: a second full attempt would exceed that wall. A 900s diagnostic
// exhausted 25 turns after writing its report at 790s; permit 40 turns.
// The capture model and other cases' work budgets are unchanged.
const OFFICE_HOURS_CAPTURE_MS = 1_200_000;
const OFFICE_HOURS_TEST_MS = 1_260_000;

describeE2E('/office-hours full section-loading workflow (periodic)', () => {
  test('a real startup review reads its sections and completes the approved design and handoff', async () => {
    const guard = CARVE_GUARDS['office-hours'];
    const { skillMd, sectionsFrom } = skillFromWorktree(guard.skill);
    const planDir = setupSkillDir({
      skillName: guard.skill, skillMd, sectionsFrom, tmpPrefix: 'gstack-office-hours-secload-',
    });
    // Copy the real formatter and its small dependency set into the fixture.
    // This exercises production code while keeping all outputs in the sandbox.
    for (const relative of ['bin/gstack-office-hours-review', 'lib/office-hours-review.ts', 'lib/fs-atomic.ts']) {
      const target = path.join(planDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.resolve(__dirname, '..', relative), target);
    }
    const formatter = path.join(planDir, 'bin/gstack-office-hours-review');
    fs.chmodSync(formatter, 0o755);
    const capture = await captureSectionReads({
      planDir, skillName: guard.skill, scenario: guard.scenario,
      artifactCommands: `Use ${formatter} for prepare/check/finalize; Bash is only for those commands and creating the local review directory. Use Read for skills, sections, reviewer prompts and designs, never Bash. Reviewers must save verdicts with Write as the prepared contract requires. Use targeted Edit for local design revisions, preserving every finding and remedy. Do not inspect formatter source unless its command fails. Keep all artifacts inside this fixture.
Delivery throughout this non-interactive run: keep chat to brief progress and actual decision acknowledgements. Write the complete diagnostic, premise challenge, alternatives, independent opinion and rationale into the design instead of first publishing a separate walkthrough in chat. After design approval, write the full relationship closing and handoff directly into REPORT.md. These file writes deliver the required content; do not narrate it in full and then transcribe it again.
Completion delivery, after the full workflow and design approval:
1. Compose REPORT.md as a completion record: summarize each phase's outcome and actual decisions with their rationale, and link the approved design and saved review evidence. The design retains the detailed diagnostic, alternatives, and independent opinion; do not replay those as a second transcript. Include the full actual Assignment, coaching/relationship closing, approval outcome, and Handoff, including the user's declined downstream launch. This changes delivery only; complete every required phase and preserve all findings.
2. Run the same formatter finalize with --design docs/designs/roster-check.md and --report REPORT.md, supplying the completed round files and any actual unreviewed failure exactly as the skill requires. Wait for its successful result: it must persist the complete managed Spec Review section, all problems/remedies, Disposition, and computed metrics. Do not write or paraphrase that section yourself, or replace it afterward.
3. Only after the report finalization succeeds, finish with the brief native acknowledgement naming the report path and verdict. A failed command remains a failure, not a completed report.`,
      reportMarker: /report|review|summary|design doc|handoff/i,
      testName: 'office-hours-section-loading', runId, timeout: OFFICE_HOURS_CAPTURE_MS,
      maxTurns: 40,
    });
    const designPath = path.join(planDir, 'docs/designs/roster-check.md');
    const reviewEvidence = validateOfficeHoursCompletion({
      ...capture, designPath,
      designContent: fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf-8') : null,
    });
    const artifactPaths = [...new Set(capture.toolCalls.filter(call => call.tool === 'Write'
      && /(?:^|[\\/])round-[123]\.json$/.test(String(call.input?.file_path ?? '')))
      .map(call => path.resolve(planDir, String(call.input.file_path))))];
    const artifacts = artifactPaths.map(artifactPath => ({ path: artifactPath,
      content: fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf-8') : null,
    }));
    validateOfficeHoursReviewArtifacts({
      ...capture, designPath,
      designContent: fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf-8') : null,
    }, artifacts);
    validateOfficeHoursReviewerHandoffs({
      ...capture, designPath,
      designContent: fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf-8') : null,
    }, artifacts);
    const missing = guard.requiredReads.filter(section => !capture.readSections.has(section));
    expect({ reportProduced: capture.reportProduced, read: [...capture.readSections], missing }).toEqual({
      reportProduced: true, read: expect.any(Array), missing: [],
    });
    expect(capture.output.trim().length).toBeGreaterThan(200);
    // The user's preanswered handoff ends office-hours, before another skill.
    expect(capture.toolCalls.filter(call => call.tool === 'Skill')).toEqual([]);
    const ownSkillPath = path.join(planDir, guard.skill, 'SKILL.md');
    expect(capture.toolCalls.filter(call => call.tool === 'Read'
      && /(?:^|\/)SKILL\.md$/.test(String(call.input?.file_path ?? ''))
      && path.resolve(planDir, call.input.file_path) !== ownSkillPath)).toEqual([]);
    if (reviewEvidence) {
      const { callJudge } = await import('./helpers/llm-judge');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('Review preservation judge exceeded 45 seconds')), 45_000);
      try {
        // Nine missing findings exhausted the shared 1024-token default and
        // truncated JSON. Keep this output allowance local to the comparison.
        await validateOfficeHoursReviewPreservation(reviewEvidence,
          prompt => callJudge(prompt, undefined, { max_tokens: 2048, signal: abort.signal }));
      } finally {
        clearTimeout(timer);
      }
    }
  }, { timeout: OFFICE_HOURS_TEST_MS, retry: 0 });
});
