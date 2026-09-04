/**
 * RESOLVERS record — maps {{PLACEHOLDER}} names to generator functions
 * or gated entries.
 *
 * Each resolver takes a TemplateContext and returns the replacement string.
 * Resolvers may be either a bare function (always fires) or a gated entry
 * ({ resolve, appliesTo }) where appliesTo can return false to skip the
 * resolver for a given skill. See ./types.ts: ResolverEntry.
 *
 * Most resolvers don't need a gate — the {{NAME}} placeholder system is
 * already conditional at the template level (the resolver only fires for
 * skills that reference it). Use a gate when you want a structural
 * guardrail that says "this placeholder is meaningful only in skills X, Y, Z"
 * even if someone later adds {{NAME}} to skill W.
 */

import type { TemplateContext, ResolverFn } from './types';

// Domain modules
import { generatePreamble } from './preamble';
import { generateTestFailureTriage } from './preamble';
import { generateCommandReference, generateSnapshotFlags, generateBrowseSetup, generateUntrustedContentWarning } from './browse';
import { generateDesignMethodology, generateDesignHardRules, generateDesignOutsideVoices, generateDesignReviewLite, generateDesignSketch, generateDesignSetup, generateDesignMockup, generateDesignShotgunLoop, generateTasteProfile, generateUXPrinciples } from './design';
import { generateTestBootstrap, generateTestCoverageAuditPlan, generateTestCoverageAuditShip } from './testing';
import { generateReviewDashboard, generatePlanFileReviewReport, generateExitPlanModeGate, generateAntiShortcutClause, generateSpecReviewLoop, generateBenefitsFrom, generateCodexSecondOpinion, generateAdversarialStep, generateCodexPlanReview, generateCodexDocReview, generatePlanCompletionAuditShip, generatePlanCompletionAuditReview, generatePlanVerificationExec, generateScopeDrift, generateCrossReviewDedup } from './review';
import { generateSlugEval, generateSlugSetup, generateBaseBranchDetect, generateDeployBootstrap, generateQAMethodology, generateCoAuthorTrailer, generateChangelogWorkflow, generateCodexWebSearchFlag, generateSetupCommand } from './utility';
import { generateLearningsSearch, generateLearningsLog } from './learnings';
import { generateConfidenceCalibration } from './confidence';
import { generateInvokeSkill } from './composition';
import { generateReviewArmy } from './review-army';
import { generateDxFramework } from './dx';
import { generateGBrainContextLoad, generateGBrainSaveResults, generateBrainPreflight, generateBrainCacheRefresh, generateBrainWriteBack } from './gbrain';
import { generateTasksSectionEmit, generateTasksSectionAggregate } from './tasks-section';
import { SECTION, SECTION_INDEX } from './sections';
import { generateRedactInvocationBlock } from './redact-doc';
import { FOREGROUND_DISPATCH_NOTE } from './constants';
import { generateThirdPartyActions } from './third-party-actions';
import { generateDesignDocDiscovery } from './design-doc-discovery';

export const RESOLVERS: Record<string, ResolverFn> = {
  SLUG_EVAL: generateSlugEval,
  SLUG_SETUP: generateSlugSetup,
  CODEX_WEB_SEARCH_FLAG: generateCodexWebSearchFlag,
  REDACT_INVOCATION_BLOCK: generateRedactInvocationBlock,
  THIRD_PARTY_ACTIONS: generateThirdPartyActions,
  DESIGN_DOC_DISCOVERY: generateDesignDocDiscovery,
  COMMAND_REFERENCE: generateCommandReference,
  SNAPSHOT_FLAGS: generateSnapshotFlags,
  UNTRUSTED_CONTENT_WARNING: generateUntrustedContentWarning,
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
  EXIT_PLAN_MODE_GATE: generateExitPlanModeGate,
  ANTI_SHORTCUT_CLAUSE: generateAntiShortcutClause,
  TEST_BOOTSTRAP: generateTestBootstrap,
  TEST_COVERAGE_AUDIT_PLAN: generateTestCoverageAuditPlan,
  TEST_COVERAGE_AUDIT_SHIP: generateTestCoverageAuditShip,
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
  CODEX_DOC_REVIEW: generateCodexDocReview,
  PLAN_COMPLETION_AUDIT_SHIP: generatePlanCompletionAuditShip,
  PLAN_COMPLETION_AUDIT_REVIEW: generatePlanCompletionAuditReview,
  PLAN_VERIFICATION_EXEC: generatePlanVerificationExec,
  CO_AUTHOR_TRAILER: generateCoAuthorTrailer,
  SETUP_COMMAND: generateSetupCommand,
  LEARNINGS_SEARCH: generateLearningsSearch,
  LEARNINGS_LOG: generateLearningsLog,
  CONFIDENCE_CALIBRATION: generateConfidenceCalibration,
  INVOKE_SKILL: generateInvokeSkill,
  CHANGELOG_WORKFLOW: generateChangelogWorkflow,
  REVIEW_ARMY: generateReviewArmy,
  CROSS_REVIEW_DEDUP: generateCrossReviewDedup,
  DX_FRAMEWORK: generateDxFramework,
  TASTE_PROFILE: generateTasteProfile,
  BIN_DIR: (ctx) => ctx.paths.binDir,
  FOREGROUND_DISPATCH_NOTE: () => FOREGROUND_DISPATCH_NOTE,
  GBRAIN_CONTEXT_LOAD: generateGBrainContextLoad,
  GBRAIN_SAVE_RESULTS: generateGBrainSaveResults,
  BRAIN_PREFLIGHT: generateBrainPreflight,
  BRAIN_CACHE_REFRESH: generateBrainCacheRefresh,
  BRAIN_WRITE_BACK: generateBrainWriteBack,
  TASKS_SECTION_EMIT: generateTasksSectionEmit,
  TASKS_SECTION_AGGREGATE: generateTasksSectionAggregate,
  SECTION,
  SECTION_INDEX,
};
