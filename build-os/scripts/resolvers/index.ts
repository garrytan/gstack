import type { ResolverFn } from './types.ts';
import { generatePreamble } from './preamble.ts';
import { generateArchVoice, generatePMVoice, generateEstimatorVoice, generateMarketingVoice, generatePartnerVoice, generateTeamBriefing } from './team.ts';
import { generatePhaseStatus, generateDecisionLogRecent, generateScopeGuard, generateBudgetStatus } from './project.ts';

export const RESOLVERS: Record<string, ResolverFn> = {
  PREAMBLE: generatePreamble,
  ARCH_VOICE: generateArchVoice,
  PM_VOICE: generatePMVoice,
  ESTIMATOR_VOICE: generateEstimatorVoice,
  MARKETING_VOICE: generateMarketingVoice,
  PARTNER_VOICE: generatePartnerVoice,
  TEAM_BRIEFING: generateTeamBriefing,
  PHASE_STATUS: generatePhaseStatus,
  DECISION_LOG_RECENT: generateDecisionLogRecent,
  SCOPE_GUARD: generateScopeGuard,
  BUDGET_STATUS: generateBudgetStatus,
};
