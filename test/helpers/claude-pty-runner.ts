/**
 * Public entry point of the PTY test harness. Tests (117 importers, and the
 * mock.module fixture tests) import this path; the code lives in
 * test/helpers/pty/* and those modules import each other directly, never
 * through this barrel. To add a helper: put it in the owning pty/ module and
 * re-export it here by name. Size ratchet (c): pty/ modules stay at or under
 * 800 lines and 150 lines per top-level function; this barrel must not grow.
 * Moved from the former 5,047-line claude-pty-runner.ts.
 */
export { resolveClaudeBinary } from './pty/binary';
export { stripAnsi, isRejectedSlashCommand, isPlanReadyVisible, isAutoDecidedVisible, extractPlanFilePath, planFileHasDecisionsSection, TAIL_SCAN_BYTES, isPermissionDialogVisible, stripPtyResidue, isNumberedOptionListVisible, API_ERROR_PANEL, idleTurnEnd } from './pty/screen';
export { selectPtyNumberedOption, launchClaudePty } from './pty/launch';
export type { ClaudePtyOptions, ClaudePtySession } from './pty/launch';
export { runPtySession, realPtyDriver } from './pty/session';
export type { PtyDriver, PtyStep, PtySessionPlan } from './pty/session';
export { logPtySnapshot, judgePtyState } from './pty/judge';
export type { PtyStateVerdict } from './pty/judge';
export { isProseAUQVisible, isScopeGateQuestionVisible, isScopeGateAutoSelectVisible, parseNumberedOptions, MODE_RE, optionsSignature, classifyVisible, COMPLETION_SUMMARY_RE, classifyPlanCountFrame, planCountSubmissionInput } from './pty/classify';
export type { ClassifyResult } from './pty/classify';
export { nativePlanCallFingerprint, planCountQuestionPhase, parseQuestionPrompt, auqFingerprint, planCountQuestionInput, matchesNativePlanQuestion, capturePlanCountQuestion, createPlanCountPermissionGuard, planCountPrerequisitePick } from './pty/auq';
export type { AskUserQuestionFingerprint, Step0BoundaryPredicate } from './pty/auq';
export { assertReviewReportAtBottom, hasCompletePlanReport, hasNativePlanCompletion, isQuestionlessNativePlanExit, evaluateOwnedNativePlanTerminal, hasNativePlanTerminal, assertReportAtBottomIfPlanWritten } from './pty/plan-native';
export type { ReviewReportAtBottomResult, NativePlanTerminalReview, NativePlanTerminalAssessment, NativePlanTerminalEvaluator } from './pty/plan-native';
export { ceoStep0Boundary, engSetupAUQ, engFirstReviewAUQ, engStep0Boundary, pickDesignFocusAll } from './pty/boundaries';
export { runPlanSkillObservation } from './pty/runners/observation';
export type { PlanSkillObservation, PlanSkillObservationOptions } from './pty/runners/observation';
export { runPlanSkillCounting, countingCapture, isNativeCompletionSummary, readEngTestPlans } from './pty/runners/counting';
export type { EngTestPlan, PlanSkillCountObservation, PlanSkillCountingOptions, CountingRun } from './pty/runners/counting';
export { planFloorDXPane, planFloorDXReplyInput, runPlanSkillFloorCheck } from './pty/runners/floor';
export type { PlanSkillFloorObservation, PlanFloorDXReply } from './pty/runners/floor';
