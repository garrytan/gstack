/** Single source of truth for agent list and department metadata */

export const ALL_AGENTS: Array<{ agentType: string; department: string }> = [
  // Executive (management)
  { agentType: 'pipeline-orchestrator', department: 'management' },
  { agentType: 'cross-department-coordinator', department: 'management' },
  { agentType: 'executive-reporter', department: 'management' },
  { agentType: 'resource-optimizer', department: 'management' },
  { agentType: 'hr-agent', department: 'management' },
  // Planning
  { agentType: 'product-strategy', department: 'planning' },
  { agentType: 'business-analysis', department: 'planning' },
  { agentType: 'ux-research', department: 'planning' },
  { agentType: 'project-governance', department: 'planning' },
  // Engineering (3-dept split matching bams-viz-emit.sh dept_map)
  { agentType: 'frontend-engineering', department: 'engineering-frontend' },
  { agentType: 'backend-engineering', department: 'engineering-backend' },
  { agentType: 'platform-devops', department: 'engineering-platform' },
  { agentType: 'data-integration', department: 'engineering-platform' },
  // Design
  { agentType: 'design-director', department: 'design' },
  { agentType: 'ui-designer', department: 'design' },
  { agentType: 'ux-designer', department: 'design' },
  { agentType: 'graphic-designer', department: 'design' },
  { agentType: 'motion-designer', department: 'design' },
  { agentType: 'design-system-agent', department: 'design' },
  // Evaluation
  { agentType: 'product-analytics', department: 'evaluation' },
  { agentType: 'experimentation', department: 'evaluation' },
  { agentType: 'performance-evaluation', department: 'evaluation' },
  { agentType: 'business-kpi', department: 'evaluation' },
  // QA
  { agentType: 'qa-strategy', department: 'qa' },
  { agentType: 'automation-qa', department: 'qa' },
  { agentType: 'defect-triage', department: 'qa' },
  { agentType: 'release-quality-gate', department: 'qa' },
]

export const DEPT_INFO: Record<string, { color: string; label: string }> = {
  management: { color: '#ec4899', label: 'Executive' },
  planning: { color: '#3b82f6', label: 'Planning' },
  'engineering-frontend': { color: '#22c55e', label: 'Eng-Frontend' },
  'engineering-backend':  { color: '#14b8a6', label: 'Eng-Backend' },
  'engineering-platform': { color: '#06b6d4', label: 'Eng-Platform' },
  design: { color: '#ec4899', label: 'Design' },
  evaluation: { color: '#f97316', label: 'Evaluation' },
  qa: { color: '#a855f7', label: 'QA' },
}

/** Build agent-type → department mapping from ALL_AGENTS */
export const AGENT_DEPT_MAP: Record<string, string> = Object.fromEntries(
  ALL_AGENTS.map(a => [a.agentType, a.department])
)
