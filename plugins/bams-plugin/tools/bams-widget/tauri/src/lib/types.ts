/**
 * src/lib/types.ts
 * bams-viz/src/lib/types.ts 에서 위젯에 필요한 타입만 이식
 */

// Pipeline events
export interface PipelineEvent {
  type: string;
  pipeline_slug?: string;
  ts: string;
  [key: string]: unknown;
}

export interface PipelineStartEvent extends PipelineEvent {
  type: "pipeline_start";
  pipeline_type: string;
  command?: string;
  arguments?: string;
}

export interface PipelineEndEvent extends PipelineEvent {
  type: "pipeline_end";
  status: "completed" | "failed" | "paused" | "rolled_back";
  total_steps?: number;
  completed_steps?: number;
  failed_steps?: number;
  duration_ms?: number;
}

export interface AgentStartEvent extends PipelineEvent {
  type: "agent_start";
  call_id: string;
  agent_type: string;
  model?: string;
  description?: string;
  step_number?: number;
  department?: string;
}

export interface AgentEndEvent extends PipelineEvent {
  type: "agent_end";
  call_id: string;
  agent_type: string;
  is_error?: boolean;
  duration_ms?: number;
  result_summary?: string;
  status?: "success" | "error";
}

// Domain types
export type WorkUnitStatus = "active" | "completed" | "paused" | "cancelled";

export interface WorkUnit {
  id: number;
  slug: string;
  name: string;
  description?: string;
  status: WorkUnitStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export type PipelineStatus =
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "rolled_back"
  | "pending";

export interface Pipeline {
  slug: string;
  type: string;
  status: PipelineStatus;
  command: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  steps: PipelineStep[];
  agents: AgentCall[];
  errors: PipelineError[];
  workUnitSlug?: string;
}

export interface PipelineStep {
  number: number;
  name: string;
  phase: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  agentCallIds: string[];
}

export interface AgentCall {
  callId: string;
  agentType: string;
  model: string;
  stepNumber?: number;
  description: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  isError: boolean;
  department?: string;
  resultSummary?: string;
}

export interface PipelineError {
  message: string;
  stepNumber?: number;
  callId?: string | null;
  ts: string;
}

// API response types
export interface WorkUnitsResponse {
  workunits: WorkUnit[];
}

export interface WorkUnitDetailResponse {
  workunit: WorkUnit;
  pipelines?: PipelineDetail[];
}

export interface PipelineDetail {
  slug: string;
  type: string;
  status: PipelineStatus;
  started_at: string | null;
  last_event_at: string | null;
}

export interface ActiveAgentsResponse {
  active_agents: ActiveAgent[];
  count: number;
}

export interface ActiveAgent {
  call_id: string;
  agent_type: string;
  department?: string;
  description?: string;
  started_at: string;
  elapsed_ms: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  port: number;
}
