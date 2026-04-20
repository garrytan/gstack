/**
 * RESOLVERS record — maps {{PLACEHOLDER}} names to generator functions.
 * Each resolver takes a TemplateContext and returns the replacement string.
 */

import type { TemplateContext, ResolverFn } from './types';

// Domain modules
import { generatePreamble } from './preamble';
import { generateTestFailureTriage } from './preamble';
import { generateCommandReference, generateSnapshotFlags, generateBrowseSetup } from './browse';
import { generateDesignMethodology, generateDesignHardRules, generateDesignOutsideVoices, generateDesignReviewLite, generateDesignSketch, generateDesignSetup, generateDesignMockup, generateDesignShotgunLoop, generateTasteProfile, generateUXPrinciples } from './design';
import { generateTestBootstrap, generateTestCoverageAuditPlan, generateTestCoverageAuditShip, generateTestCoverageAuditReview } from './testing';
import { generateReviewDashboard, generatePlanFileReviewReport, generateSpecReviewLoop, generateBenefitsFrom, generateCodexSecondOpinion, generateAdversarialStep, generateCodexPlanReview, generatePlanCompletionAuditShip, generatePlanCompletionAuditReview, generatePlanVerificationExec, generateScopeDrift, generateCrossReviewDedup } from './review';
import { generateSlugEval, generateSlugSetup, generateBaseBranchDetect, generateDeployBootstrap, generateQAMethodology, generateCoAuthorTrailer, generateChangelogWorkflow } from './utility';
import { generateLearningsSearch, generateLearningsLog } from './learnings';
import { generateConfidenceCalibration } from './confidence';
import { generateInvokeSkill } from './composition';
import { generateReviewArmy } from './review-army';
import { generateDxFramework } from './dx';
import { generateModelOverlay } from './model-overlay';
import { generateGBrainContextLoad, generateGBrainSaveResults } from './gbrain';
import { generateQuestionPreferenceCheck, generateQuestionLog, generateInlineTuneFeedback } from './question-tuning';
import { generateMakePdfSetup } from './make-pdf';

export const RESOLVERS: Record<string, ResolverFn> = {
  SLUG_EVAL: generateSlugEval,
  SLUG_SETUP: generateSlugSetup,
  COMMAND_REFERENCE: generateCommandReference,
  SNAPSHOT_FLAGS: generateSnapshotFlags,
  PREAMBLE: generatePreamble,
  BROWSE_SETUP: generateBrowseSetup,
  BASE_BRANCH_DETECT: generateBaseBranchDetect,
  QA_METHODOLOGY: generateQAMethodology,
  DESIGN_METHODOLOGY: generateDesignMethodology,
  DESIGN_HARD_RULES: generateDesignHardRules,
  UX_PRINCIPLES: generateUXPrinciples,
  DESIGN_OUTSIDE_VOICES: generateDesignOutsideVoices,
  DESIGN_REVIEW_LITE: generateDesignReviewLite,
  REVIEW_DASHBOARD: generateReviewDashboard,
  PLAN_FILE_REVIEW_REPORT: generatePlanFileReviewReport,
  TEST_BOOTSTRAP: generateTestBootstrap,
  TEST_COVERAGE_AUDIT_PLAN: generateTestCoverageAuditPlan,
  TEST_COVERAGE_AUDIT_SHIP: generateTestCoverageAuditShip,
  TEST_COVERAGE_AUDIT_REVIEW: generateTestCoverageAuditReview,
  TEST_FAILURE_TRIAGE: generateTestFailureTriage,
  SPEC_REVIEW_LOOP: generateSpecReviewLoop,
  DESIGN_SKETCH: generateDesignSketch,
  DESIGN_SETUP: generateDesignSetup,
  DESIGN_MOCKUP: generateDesignMockup,
  DESIGN_SHOTGUN_LOOP: generateDesignShotgunLoop,
  BENEFITS_FROM: generateBenefitsFrom,
  CODEX_SECOND_OPINION: generateCodexSecondOpinion,
  ADVERSARIAL_STEP: generateAdversarialStep,
  SCOPE_DRIFT: generateScopeDrift,
  DEPLOY_BOOTSTRAP: generateDeployBootstrap,
  CODEX_PLAN_REVIEW: generateCodexPlanReview,
  PLAN_COMPLETION_AUDIT_SHIP: generatePlanCompletionAuditShip,
  PLAN_COMPLETION_AUDIT_REVIEW: generatePlanCompletionAuditReview,
  PLAN_VERIFICATION_EXEC: generatePlanVerificationExec,
  CO_AUTHOR_TRAILER: generateCoAuthorTrailer,
  LEARNINGS_SEARCH: generateLearningsSearch,
  LEARNINGS_LOG: generateLearningsLog,
  CONFIDENCE_CALIBRATION: generateConfidenceCalibration,
  INVOKE_SKILL: generateInvokeSkill,
  CHANGELOG_WORKFLOW: generateChangelogWorkflow,
  REVIEW_ARMY: generateReviewArmy,
  CROSS_REVIEW_DEDUP: generateCrossReviewDedup,
  DX_FRAMEWORK: generateDxFramework,
  MODEL_OVERLAY: generateModelOverlay,
  TASTE_PROFILE: generateTasteProfile,
  BIN_DIR: (ctx) => ctx.paths.binDir,
  GBRAIN_CONTEXT_LOAD: generateGBrainContextLoad,
  GBRAIN_SAVE_RESULTS: generateGBrainSaveResults,
  QUESTION_PREFERENCE_CHECK: generateQuestionPreferenceCheck,
  QUESTION_LOG: generateQuestionLog,
  INLINE_TUNE_FEEDBACK: generateInlineTuneFeedback,
  MAKE_PDF_SETUP: generateMakePdfSetup,
};
