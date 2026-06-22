export type AutopilotMode = 'off' | 'suggest' | 'strict';

export type AutopilotAction = 'invoke' | 'stop' | 'none';

export type SkillSource = 'gstack' | 'external';

export interface SawyerSkillAutopilotInput {
  prompt?: string;
  lastSkill?: string;
  lastOutcome?: string;
  prState?: string;
  deployStatus?: string;
  runtimeProof?: boolean | 'present' | 'missing' | 'unknown';
  docsChanged?: boolean;
  developerFacing?: boolean;
}

export interface SawyerSkillAutopilotRecommendation {
  action: AutopilotAction;
  skill?: string;
  skillSource?: SkillSource;
  reason: string;
  phase: 'first-skill' | 'post-skill' | 'none';
  confidence: 'high' | 'medium' | 'low';
  permissionBoundary?: 'push-pr' | 'merge-deploy' | 'live-runtime' | 'global-surface';
  evidence: string[];
}

interface Rule {
  skill: string;
  skillSource?: SkillSource;
  reason: string;
  patterns: RegExp[];
  permissionBoundary?: SawyerSkillAutopilotRecommendation['permissionBoundary'];
}

const PR_OPEN_RE = /\b(open|created|ready|draft)\b/;
const SHIP_INTENT_RE = /\b(ship|push|open (a )?pr|create (a )?pr|pull request)\b/;
const LAND_INTENT_RE = /\b(land|merge|deploy|production)\b/;
const SIMPLIFY_CLOSEOUT_INTENT_RE = /\b(review|ship|push|open (a )?pr|create (a )?pr|pull request|pr-ready|ready for pr|closeout|finish)\b/;
const SIMPLIFY_DIFF_READY_RE = /\b(diff[- ]ready|ready for review|ready to ship|implemented|finished|complete|done)\b/;
const SIMPLIFY_CLOSEOUT_STAGE_RE = /\b(executing|execution|implement|implementation|coding|qa)\b/;
const NON_TRIVIAL_DIFF_RE = /\b(non[- ]trivial|large diff|multi[- ]file|several files?|3\+ files?|[3-9][ -]files?|[1-9][0-9]+[ -]files?)\b/;
const SIMPLIFY_CONCERN_RE = /\b(helper|helpers|abstraction|abstractions|config|configuration|workflow|agent[- ]surface|agent surface|global surface|reuse|complexity|simplif(y|ication))\b/;
const GLOBAL_SURFACE_RE = /\b(global surface|agent[- ]surface|agent surface|workflow surface|profile|\.codex|\.claude|agents\.md|claude\.md)\b/;

const FIRST_SKILL_RULES: Rule[] = [
  {
    skill: 'context-restore',
    reason: 'Sawyer low-signal continuation should recover branch state and handoff context before acting.',
    patterns: [
      /^(continue|resume|status|go|do it|keep going|where were we)\b/i,
      /\b(continue this branch|continue .*work|resume .*handoff|hot[- ]thread recovery)\b/i,
    ],
  },
  {
    skill: 'post-merge-runtime-closeout',
    skillSource: 'external',
    reason: 'The prompt asks for proof after merge rather than a new code change.',
    permissionBoundary: 'live-runtime',
    patterns: [
      /\bpost[- ]merge\b.*\b(closeout|runtime|proof|live|verify)\b/i,
      /\bmerged?\b.*\b(runtime|live|production|deploy(ed)? proof)\b/i,
      /\bruntime proof\b.*\bmissing|missing\b.*\bruntime proof\b/i,
    ],
  },
  {
    skill: 'autoplan',
    reason: 'The prompt asks for the full review pipeline instead of one narrow review.',
    patterns: [
      /\b(autoplan|auto[- ]?plan|run all reviews|review everything|full review pipeline)\b/i,
      /\b(plan[- ]eng[- ]review|plan eng review|eng review)\b.*\b(plan[- ]design[- ]review|plan design review|design review)\b/i,
    ],
  },
  {
    skill: 'landing-report',
    reason: 'The prompt asks which review gates have already run or whether the branch is cleared.',
    patterns: [/\b(review status|readiness|did we .*review|was .*reviewed|what reviews ran|cleared to ship|review dashboard)\b/i],
  },
  {
    skill: 'review',
    reason: 'The prompt asks for a diff or code review before landing.',
    patterns: [/\b(check my diff|code review|pr review|look at this diff|review my diff|review this diff)\b/i],
  },
  {
    skill: 'land-and-deploy',
    reason: 'The prompt asks to land, merge, deploy, or verify a PR after approval.',
    permissionBoundary: 'merge-deploy',
    patterns: [
      /\b(land|merge|deploy)\b.*\b(pr|branch|it|this)\b/i,
      /\b(wait for ci|verify deploy|production health)\b/i,
    ],
  },
  {
    skill: 'ship',
    reason: 'The prompt asks to package local work into a PR or push-ready branch.',
    permissionBoundary: 'push-pr',
    patterns: [
      /\b(ship|push|open (a )?pr|create (a )?pr|pull request)\b/i,
      /\bcommit\b.*\bpush\b/i,
    ],
  },
  {
    skill: 'investigate',
    reason: 'The prompt is a bug, error, or unexplained failure.',
    patterns: [/\b(bug|broken|error|fails?|failing|500|regression|why is this)\b/i],
  },
  {
    skill: 'cso',
    reason: 'The prompt asks for security review or threat modeling.',
    patterns: [/\b(security|secure|owasp|threat model|vulnerab|xss|csrf|sql injection|secret leak|replay attack|webhook secure)\b/i],
  },
  {
    skill: 'qa-only',
    reason: 'The prompt asks for QA findings without changing code.',
    patterns: [/\b(qa-only|report only|do not change|no code changes|find bugs without fixing)\b/i],
  },
  {
    skill: 'qa',
    reason: 'The prompt asks to test behavior in the actual app or site.',
    patterns: [/\b(qa|test the site|find bugs|does this work|try the flow)\b/i],
  },
  {
    skill: 'document-release',
    reason: 'The prompt asks to update docs after shipped behavior changed.',
    patterns: [/\b(update docs|document release|docs after ship|release docs)\b/i],
  },
  {
    skill: 'devex-review',
    reason: 'The prompt asks to test real developer experience or onboarding.',
    patterns: [/\b(devex|developer experience|try the onboarding|tthw|get(ting)? started flow)\b/i],
  },
  {
    skill: 'plan-eng-review',
    reason: 'The prompt asks for architecture or implementation-plan review.',
    patterns: [/\b(architecture|eng review|technical plan|implementation plan)\b/i],
  },
  {
    skill: 'design-review',
    reason: 'The prompt asks for visual QA or design polish.',
    patterns: [/\b(visual audit|design polish|design review|ui polish|ui looks off|looks off)\b/i],
  },
  {
    skill: 'design-consultation',
    reason: 'The prompt asks for brand or design-system direction.',
    patterns: [/\b(design system|brand system|brand direction)\b/i],
  },
  {
    skill: 'context-save',
    reason: 'The prompt asks to save a checkpoint or handoff.',
    patterns: [/\b(save progress|checkpoint|handoff|save context)\b/i],
  },
  {
    skill: 'context-restore',
    reason: 'The prompt asks to resume from saved context.',
    patterns: [/\b(resume context|restore context|continue from context)\b/i],
  },
  {
    skill: 'spec',
    reason: 'The prompt asks for a backlog-ready spec or issue.',
    patterns: [/\b(spec|backlog-ready|github issue|write an issue)\b/i],
  },
  {
    skill: 'office-hours',
    reason: 'The prompt is an idea or worth-building question.',
    patterns: [/\b(is this worth building|product idea|brainstorm|should we build)\b/i],
  },
];

export function recommendSawyerSkillAutopilot(input: SawyerSkillAutopilotInput): SawyerSkillAutopilotRecommendation {
  const prompt = String(input.prompt ?? '').trim().toLowerCase();
  const lastSkill = normalizeSkill(input.lastSkill);

  const chained = recommendFromReceipt(input, prompt, lastSkill);
  if (chained) return chained;

  if (!prompt) {
    return {
      action: 'none',
      reason: 'No prompt or receipt signal was provided.',
      phase: 'none',
      confidence: 'low',
      evidence: [],
    };
  }

  for (const rule of FIRST_SKILL_RULES) {
    const matched = rule.patterns.find((pattern) => pattern.test(prompt));
    if (!matched) continue;
    return {
      action: 'invoke',
      skill: rule.skill,
      skillSource: rule.skillSource ?? 'gstack',
      reason: rule.reason,
      phase: 'first-skill',
      confidence: 'high',
      permissionBoundary: rule.permissionBoundary,
      evidence: [`prompt matched ${matched}`],
    };
  }

  return {
    action: 'none',
    reason: 'No Sawyer autopilot rule matched. Answer normally or ask a narrow routing question.',
    phase: 'none',
    confidence: 'low',
    evidence: ['no rule match'],
  };
}

function recommendFromReceipt(
  input: SawyerSkillAutopilotInput,
  prompt: string,
  lastSkill: string,
): SawyerSkillAutopilotRecommendation | null {
  const outcome = String(input.lastOutcome ?? '').trim().toLowerCase();
  const prState = String(input.prState ?? '').trim().toLowerCase();
  const deployStatus = String(input.deployStatus ?? '').trim().toLowerCase();

  if (lastSkill === 'simplify-checkpoint' && outcomeLooksClean(outcome)) {
    return {
      action: 'invoke',
      skill: 'review',
      skillSource: 'gstack',
      reason: 'The simplify checkpoint is clean, so the next gated closeout step is review.',
      phase: 'post-skill',
      confidence: 'high',
      evidence: [`lastSkill=${lastSkill}`, `lastOutcome=${outcome || 'clean'}`],
    };
  }

  if (lastSkill === 'simplify-checkpoint' && SIMPLIFY_CLOSEOUT_INTENT_RE.test(prompt)) {
    return {
      action: 'stop',
      reason: 'The simplify checkpoint does not have a clean outcome yet.',
      phase: 'post-skill',
      confidence: 'high',
      evidence: [`lastSkill=${lastSkill}`, `lastOutcome=${outcome || 'missing'}`],
    };
  }

  if (lastSkill === 'review' && SHIP_INTENT_RE.test(prompt) && !outcomeLooksClean(outcome)) {
    return {
      action: 'stop',
      reason: 'Review must finish cleanly before shipping.',
      phase: 'post-skill',
      confidence: 'high',
      permissionBoundary: 'push-pr',
      evidence: [`lastSkill=${lastSkill}`, `lastOutcome=${outcome || 'missing'}`],
    };
  }

  const simplify = simplifyCheckpointSignal(prompt, outcome, lastSkill);
  if (simplify.needed) {
    return {
      action: 'stop',
      reason: 'Run a simplify checkpoint before review or ship, then rerun proof if it changes anything.',
      phase: lastSkill ? 'post-skill' : 'first-skill',
      confidence: 'high',
      permissionBoundary: simplify.globalSurface ? 'global-surface' : undefined,
      evidence: simplify.evidence,
    };
  }

  if (runtimeProofMissing(input.runtimeProof) && (lastSkill === 'land-and-deploy' || prompt.includes('runtime') || prompt.includes('post merge'))) {
    return {
      action: 'invoke',
      skill: 'post-merge-runtime-closeout',
      skillSource: 'external',
      reason: 'The last receipt points at merged/deployed work without runtime proof.',
      phase: 'post-skill',
      confidence: 'high',
      permissionBoundary: 'live-runtime',
      evidence: ['runtimeProof=missing'],
    };
  }

  if (lastSkill === 'review' && outcomeLooksClean(outcome) && SHIP_INTENT_RE.test(prompt)) {
    return {
      action: 'invoke',
      skill: 'ship',
      skillSource: 'gstack',
      reason: 'Review finished cleanly and the user asked to ship the work.',
      phase: 'post-skill',
      confidence: 'high',
      permissionBoundary: 'push-pr',
      evidence: [`lastSkill=${lastSkill}`, `lastOutcome=${outcome || 'clean'}`],
    };
  }

  if (lastSkill === 'ship' && PR_OPEN_RE.test(prState)) {
    if (LAND_INTENT_RE.test(prompt)) {
      return {
        action: 'invoke',
        skill: 'land-and-deploy',
        skillSource: 'gstack',
        reason: 'Ship produced an open PR and the user asked to land or deploy it.',
        phase: 'post-skill',
        confidence: 'high',
        permissionBoundary: 'merge-deploy',
        evidence: [`lastSkill=${lastSkill}`, `prState=${prState}`],
      };
    }
    return {
      action: 'stop',
      reason: 'Ship produced an open PR. Merging or deploying is a separate permission boundary.',
      phase: 'post-skill',
      confidence: 'high',
      permissionBoundary: 'merge-deploy',
      evidence: [`lastSkill=${lastSkill}`, `prState=${prState}`],
    };
  }

  if (lastSkill === 'land-and-deploy' && deployLooksHealthy(deployStatus) && input.developerFacing) {
    return {
      action: 'invoke',
      skill: 'devex-review',
      skillSource: 'gstack',
      reason: 'A developer-facing change is deployed, so the next useful proof is real onboarding/DX readback.',
      phase: 'post-skill',
      confidence: 'medium',
      evidence: [`deployStatus=${deployStatus || 'healthy'}`, 'developerFacing=true'],
    };
  }

  if ((lastSkill === 'ship' || lastSkill === 'land-and-deploy') && input.docsChanged) {
    return {
      action: 'invoke',
      skill: 'document-release',
      skillSource: 'gstack',
      reason: 'The receipt says docs changed or need to be synchronized after shipping.',
      phase: 'post-skill',
      confidence: 'medium',
      evidence: ['docsChanged=true'],
    };
  }

  return null;
}

function normalizeSkill(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^\/+/, '').replace(/^gstack-/, '');
}

function runtimeProofMissing(value: SawyerSkillAutopilotInput['runtimeProof']): boolean {
  return value === false || value === 'missing';
}

function outcomeLooksClean(outcome: string): boolean {
  const text = outcome.trim().toLowerCase();
  if (!text) return false;
  if (
    /\b(?:not\s+(?:clean|approved|success(?:ful)?|done)|unclean|done with concerns|with concerns|concerns?|unresolved|blocked|failed?|failure|errors?|issues? found|findings? found|p[0-9])\b/.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(clean|approved|success(?:ful)?|done|no findings|no issues)\b/.test(text);
}

function deployLooksHealthy(deployStatus: string): boolean {
  return !deployStatus || /\b(healthy|success|deployed|verified|green)\b/.test(deployStatus);
}

function simplifyCheckpointSignal(prompt: string, outcome: string, lastSkill: string): {
  needed: boolean;
  globalSurface: boolean;
  evidence: string[];
} {
  if (lastSkill === 'simplify-checkpoint') {
    return { needed: false, globalSurface: false, evidence: [] };
  }

  const text = `${prompt} ${outcome}`;
  const hasCloseoutIntent =
    SIMPLIFY_CLOSEOUT_INTENT_RE.test(prompt) ||
    SIMPLIFY_DIFF_READY_RE.test(prompt) ||
    SIMPLIFY_DIFF_READY_RE.test(outcome) ||
    SIMPLIFY_CLOSEOUT_STAGE_RE.test(lastSkill);
  const hasNonTrivialSignal = NON_TRIVIAL_DIFF_RE.test(text) || SIMPLIFY_CONCERN_RE.test(text);
  const globalSurface = GLOBAL_SURFACE_RE.test(prompt);
  const evidence: string[] = [];

  if (lastSkill) evidence.push(`lastSkill=${lastSkill}`);
  if (outcome) evidence.push(`lastOutcome=${outcome}`);
  if (SIMPLIFY_CLOSEOUT_INTENT_RE.test(prompt)) evidence.push('prompt has review/ship/closeout intent');
  if (hasNonTrivialSignal) evidence.push('non-trivial diff signal present');
  if (globalSurface) evidence.push('global/workflow surface signal present');

  return {
    needed: hasCloseoutIntent && hasNonTrivialSignal,
    globalSurface,
    evidence,
  };
}
