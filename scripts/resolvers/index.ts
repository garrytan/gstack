/**
 * RESOLVERS record — maps {{PLACEHOLDER}} names to generator functions.
 * Each resolver takes a TemplateContext and returns the replacement string.
 */

import type { ResolverFn } from './types';

// Core modules (kept from gstack)
import { generatePreamble } from './preamble';
import { generateTestFailureTriage } from './preamble';
import { generateTestBootstrap } from './testing';
import { generateSlugEval, generateSlugSetup, generateBaseBranchDetect, generateCoAuthorTrailer } from './utility';
import { generateLearningsSearch, generateLearningsLog } from './learnings';
import { generateConfidenceCalibration } from './confidence';
import { generateInvokeSkill } from './composition';

// Research modules (new)
import { generateResearchConventions, generateProvenanceSpec, generateExperimentStructure } from './research';

export const RESOLVERS: Record<string, ResolverFn> = {
  // Core
  SLUG_EVAL: generateSlugEval,
  SLUG_SETUP: generateSlugSetup,
  PREAMBLE: generatePreamble,
  BASE_BRANCH_DETECT: generateBaseBranchDetect,
  TEST_BOOTSTRAP: generateTestBootstrap,
  TEST_FAILURE_TRIAGE: generateTestFailureTriage,
  CO_AUTHOR_TRAILER: generateCoAuthorTrailer,

  // Knowledge
  LEARNINGS_SEARCH: generateLearningsSearch,
  LEARNINGS_LOG: generateLearningsLog,
  CONFIDENCE_CALIBRATION: generateConfidenceCalibration,
  INVOKE_SKILL: generateInvokeSkill,

  // Research
  RESEARCH_CONVENTIONS: generateResearchConventions,
  PROVENANCE_SPEC: generateProvenanceSpec,
  EXPERIMENT_STRUCTURE: generateExperimentStructure,
};
