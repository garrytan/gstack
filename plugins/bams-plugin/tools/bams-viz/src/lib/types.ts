// Pipeline events
export interface PipelineEvent {
  type: string
  pipeline_slug?: string
  ts: string
  [key: string]: unknown
}

export interface PipelineStartEvent extends PipelineEvent {
  type: 'pipeline_start'
  pipeline_type: string
  command?: string
  arguments?: string
}

export interface PipelineEndEvent extends PipelineEvent {
  type: 'pipeline_end'
  status: 'completed' | 'failed' | 'paused' | 'rolled_back'
  total_steps?: number
  completed_steps?: number
  failed_steps?: number
  skipped_steps?: number
  duration_ms?: number
}

export interface StepStartEvent extends PipelineEvent {
  type: 'step_start'
  step_number: number
  step_name: string
  phase: string
}

export interface StepEndEvent extends PipelineEvent {
  type: 'step_end'
  step_number: number
  status: 'done' | 'fail' | 'skipped'
  duration_ms?: number
}

export interface AgentStartEvent extends PipelineEvent {
  type: 'agent_start'
  call_id: string
  agent_type: string
  model?: string
  description?: string
  prompt_summary?: string
  background?: boolean
  step_number?: number
  parallel_group?: string | null
  // Enhanced tracing fields
  trace_id?: string
  input?: string
  department?: string
  skill_name?: string
  parent_span_id?: string | null
}

export interface AgentEndEvent extends PipelineEvent {
  type: 'agent_end'
  call_id: string
  agent_type: string
  is_error?: boolean
  duration_ms?: number
  result_summary?: string
  error_message?: string
  // Enhanced tracing fields
  output?: string
  token_usage?: { input: number; output: number }
  status?: 'success' | 'error'
}

export interface ErrorEvent extends PipelineEvent {
  type: 'error'
  message: string
  step_number?: number
  error_code?: string
  call_id?: string | null
}

// Parsed structures
export interface Pipeline {
  slug: string
  type: string
  status: string
  command: string
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  steps: PipelineStep[]
  agents: AgentCall[]
  errors: PipelineError[]
  workUnitSlug?: string
}

export interface PipelineStep {
  number: number
  name: string
  phase: string
  status: string
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  agentCallIds: string[]
}

export interface AgentCall {
  callId: string
  agentType: string
  model: string
  stepNumber?: number
  description: string
  promptSummary: string
  parallelGroup: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  isError: boolean
  // Enhanced fields
  traceId?: string
  input?: string
  output?: string
  department?: string
  skillName?: string
  parentSpanId?: string | null
  tokenUsage?: { input: number; output: number }
  resultSummary?: string
  errorMessage?: string
  background?: boolean
  pipelineSlug?: string | null
}

export interface PipelineError {
  message: string
  stepNumber?: number
  errorCode?: string
  callId?: string | null
  ts: string
}

export interface AgentData {
  calls: AgentCall[]
  stats: AgentTypeStat[]
  collaborations: Collaboration[]
  totalCalls: number
  totalErrors: number
  runningCount: number
}

export interface AgentTypeStat {
  agentType: string
  dept: string
  callCount: number
  errorCount: number
  totalDurationMs: number
  avgDurationMs: number
  minDurationMs: number
  maxDurationMs: number
  errorRate: number
  models: Record<string, number>
}

export interface Collaboration {
  from: string
  to: string
  count: number
}

// Trace/Span types (Langfuse-style)
export interface Trace {
  traceId: string
  pipelineSlug: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  status: 'running' | 'completed' | 'error'
  spans: Span[]
  totalInputTokens: number
  totalOutputTokens: number
}

export interface Span {
  spanId: string
  traceId: string
  parentSpanId: string | null
  agentType: string
  model: string
  department: string
  skillName: string | null
  input: string
  output: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  status: 'running' | 'success' | 'error'
  tokenUsage: { input: number; output: number } | null
  description: string
}

// HR Report types
export interface HRReportSummary {
  total_pipelines: number
  total_invocations: number
  overall_success_rate: number | null
}

export interface HRDepartment {
  department_id: string
  agent_count: number
  avg_success_rate: number | null
  total_invocations: number
}

export interface HRAgent {
  agent_id: string
  department: string
  grade: string
  invocation_count: number
  success_rate: number | null
  avg_duration_ms: number
  retry_count: number
  escalation_count: number
  trend: 'improving' | 'declining' | 'stable'
}

export interface AgentImprovement {
  agent_id: string
  grade_before: string
  grade_target: string
  changes: string[]
}

export interface RetroMetadata {
  analyzed_pipelines: number
  retro_date: string
  action_items: string[]
  keep_count: number
  problem_count: number
  try_count: number
  grade_distribution?: Record<string, number>
  improvements?: AgentImprovement[]
}

export interface HRReport {
  report_date: string | null
  source?: 'weekly' | 'retro'
  retro_slug?: string
  period: { start: string | null; end: string | null }
  summary: HRReportSummary
  departments: HRDepartment[]
  agents: HRAgent[]
  alerts: string[]
  recommendations: string[]
  retro_metadata?: RetroMetadata
}

export interface RetroJournalEntry {
  retro_slug: string
  report_date: string
  period: { start: string | null; end: string | null }
  agent_count: number
  alert_count: number
  retro_metadata: RetroMetadata
  agents: HRAgent[]
}

// ── Work Unit types ──────────────────────────────────
export interface WorkUnitEvent {
  type: 'work_unit_start' | 'work_unit_end' | 'pipeline_linked'
  work_unit_slug: string
  ts: string
  work_unit_name?: string
  status?: string
  pipeline_slug?: string
  pipeline_type?: string
}

export interface WorkUnit {
  slug: string
  name: string
  status: 'active' | 'completed' | 'abandoned'
  startedAt: string
  endedAt: string | null
  pipelines?: WorkUnitPipeline[]  // 상세 API에서만 포함, 목록 API에는 없음
  pipelineCount?: number           // 목록 API에서 제공
}

export interface WorkUnitPipeline {
  id: string
  slug: string
  type: string
  linkedAt: string
  status?: string
  durationMs: number | null
  totalSteps: number
  completedSteps: number
  failedSteps: number
  command: string | null
  arguments: string | null
}

export interface PipelineDetail {
  id: string
  slug: string
  workUnitId: string | null
  type: string
  command: string | null
  status: string
  arguments: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  totalSteps: number
  completedSteps: number
  failedSteps: number
  tasks: Task[]
}


// ── bams-db Task 타입 (프론트엔드용 — cross-package import 없이 정의) ──
export interface Task {
  id: string
  pipeline_id: string | null
  phase: number | null
  step: string | null
  title: string
  description: string | null
  status: 'backlog' | 'in_progress' | 'done' | 'blocked' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
  size: 'XS' | 'S' | 'M' | 'L' | 'XL' | null
  assignee_agent: string | null
  checkout_locked_at: string | null
  deps: string | null   // JSON string: '["TASK-A1","TASK-A2"]'
  tags: string | null   // JSON string: '["backend","auth"]'
  model: string | null
  label: string | null
  duration_ms: number | null
  summary: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

// ── Work Unit API Response 타입 ──────────────────────────────
export interface WorkUnitTasksResponse {
  work_unit_slug: string
  pipelines: Array<{
    slug: string
    tasks: Task[]
  }>
  total_count: number
  summary: {
    backlog: number
    in_progress: number
    in_review: number
    done: number
    blocked: number
    cancelled: number
  }
}

export interface HRReportsResponse {
  reports: Array<{
    id: string
    retro_slug: string
    report_date: string
    source: string
    period_start: string | null
    period_end: string | null
  }>
}

export interface HRReportDetailResponse {
  id: string
  retro_slug: string
  report_date: string
  source: string
  period_start: string | null
  period_end: string | null
  data: Record<string, unknown>
}

export interface WorkUnitDetailResponse {
  workunit: WorkUnit & {
    task_summary: {
      total: number
      backlog: number
      in_progress: number
      in_review: number
      done: number
    }
  }
}

// ── Work Unit 상세 탭 타입 ──────────────────────────────────
export type DetailTab = 'pipelines' | 'agents' | 'timeline' | 'dag' | 'logs' | 'retro' | 'metaverse'

// ── Work Unit Agents API 응답 타입 ──────────────────────────
// BE 응답: { work_unit_slug, stats, active_agents }
export interface WorkUnitAgentStat {
  agent_type: string
  call_count: number
  error_count: number
  avg_duration_ms: number | null
}

export interface WorkUnitActiveAgent {
  call_id: string
  agent_type: string
  pipeline_slug: string
  started_at: string
  duration_ms?: number | null  // 완료된 경우에만 존재 (active 시에는 null)
}

export interface WorkUnitAgentsResponse {
  work_unit_slug: string
  stats: WorkUnitAgentStat[]           // /agents 엔드포인트에서만 제공
  active_agents: WorkUnitActiveAgent[]
}

// /agents/active 엔드포인트 응답 (stats 없음)
export interface WorkUnitAgentsActiveResponse {
  work_unit_slug: string
  active_agents: WorkUnitActiveAgent[]
}

// ── Work Unit Retro API 응답 타입 ───────────────────────────
// BE 응답: { work_unit_slug, auto_summary }
export interface WorkUnitRetroResponse {
  work_unit_slug: string
  auto_summary: {
    total_pipelines: number
    completed_pipelines: number
    failed_pipelines: number
    active_pipelines: number
    total_agents: number
    total_agent_calls: number
    agent_errors: number
    total_duration_ms: number
    pipelines: Array<{
      slug: string
      type: string
      status: string
      started_at: string | null
      ended_at: string | null
      duration_ms: number | null
      step_count: number
      agent_calls: number
      agent_errors: number
    }>
    top_agents: Array<{
      agent_type: string
      call_count: number
      error_count: number
      avg_duration_ms: number | null
    }>
  } | null
}

// ── Work Unit PATCH 요청 타입 ───────────────────────────────
export interface WorkUnitPatchRequest {
  status: 'completed' | 'abandoned'
}
