/**
 * RESOLVERS record — maps {{PLACEHOLDER}} names to generator functions.
 * Each resolver takes a TemplateContext and returns the replacement string.
 */

import type { ResolverFn } from './types';

import { generatePreamble } from './preamble';
import { generateSlugEval } from './utility';
import { generateLearningsSearch, generateLearningsLog } from './learnings';
import { generateResearchConventions, generateResearchLogSpec, generateExperimentStructure } from './research';

export const RESOLVERS: Record<string, ResolverFn> = {
  SLUG_EVAL: generateSlugEval,
  PREAMBLE: generatePreamble,

  // Knowledge
  LEARNINGS_SEARCH: generateLearningsSearch,
  LEARNINGS_LOG: generateLearningsLog,

  // Research
  RESEARCH_CONVENTIONS: generateResearchConventions,
  RESEARCH_LOG_SPEC: generateResearchLogSpec,
  EXPERIMENT_STRUCTURE: generateExperimentStructure,
};
