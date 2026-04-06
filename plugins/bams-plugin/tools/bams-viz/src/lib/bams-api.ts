/**
 * bams-viz/src/lib/bams-api.ts
 *
 * bams-server (Control Plane) API 클라이언트 레이어
 * PRD §2.6.4 인수기준 6번: bams-viz의 API 클라이언트 레이어 신규 작성
 *
 * 사용:
 *   import { bamsApi } from "@/lib/bams-api";
 *   const { pipelines } = await bamsApi.getPipelines();
 */

import type {
  WorkUnit,
  WorkUnitTasksResponse,
  Task,
  HRReportsResponse,
  HRReportDetailResponse,
  WorkUnitDetailResponse,
  WorkUnitAgentsResponse,
  WorkUnitAgentsActiveResponse,
  WorkUnitRetroResponse,
  PipelineDetail,
  WorkUnitPatchRequest,
} from "./types";

const BAMS_SERVER_BASE =
  process.env.NEXT_PUBLIC_BAMS_SERVER_URL ?? "http://localhost:3099";

/** 공통 fetch 래퍼 — bams-server 직접 호출 (GET 전용) */
async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BAMS_SERVER_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`bams-api: ${res.status} ${res.statusText} — ${body}`);
  }

  return res.json() as Promise<T>;
}

/** Next.js 프록시 경유 fetch — PATCH/DELETE/POST 뮤테이션용 (CORS 우회) */
async function proxyFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`bams-api: ${res.status} ${res.statusText} — ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────
// 파이프라인
// ─────────────────────────────────────────────────────────────

export interface PipelineSummary {
  slug: string;
  pipeline_type: string;
  started_at: string | null;
  last_event_at: string | null;
  task_summary: {
    total: number;
    backlog: number;
    in_progress: number;
    in_review: number;
    done: number;
    blocked: number;
    cancelled: number;
  };
}

export interface PipelineLegacyDetail extends PipelineSummary {
  events: unknown[];
  tasks: unknown[];
}

export const bamsApi = {
  // ── 파이프라인 ───────────────────────────────────────────────

  async getPipelines(): Promise<{ pipelines: PipelineSummary[] }> {
    return apiFetch<{ pipelines: PipelineSummary[] }>("/api/pipelines");
  },

  async getPipeline(slug: string): Promise<PipelineLegacyDetail> {
    return apiFetch<PipelineLegacyDetail>(`/api/pipelines/${slug}`);
  },

  // ── 태스크 ───────────────────────────────────────────────────

  async getTasks(params: {
    pipelineId: string;
    status?: string;
  }): Promise<{ tasks: Task[]; count: number }> {
    const qs = new URLSearchParams({ pipeline_id: params.pipelineId });
    if (params.status) qs.set("status", params.status);
    return apiFetch<{ tasks: Task[]; count: number }>(
      `/api/tasks?${qs.toString()}`
    );
  },

  async getPipelineTasks(pipelineSlug: string): Promise<{ tasks: Task[]; count: number }> {
    return apiFetch<{ tasks: Task[]; count: number }>(
      `/api/pipelines/${encodeURIComponent(pipelineSlug)}/tasks`
    );
  },


  async updateTaskStatus(
    taskId: string,
    body: { status: string; agent_slug?: string; run_id?: string }
  ): Promise<{ task: unknown }> {
    return apiFetch<{ task: unknown }>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  // ── 에이전트 ─────────────────────────────────────────────────

  async getAgents(): Promise<{ agents: unknown[]; count: number }> {
    return apiFetch<{ agents: unknown[]; count: number }>("/api/agents");
  },

  async getAgentStatus(
    slug: string
  ): Promise<{ slug: string; status: string; last_event: unknown }> {
    return apiFetch<{ slug: string; status: string; last_event: unknown }>(
      `/api/agents/${slug}/status`
    );
  },

  // ── 트레이스 ─────────────────────────────────────────────────

  async getTraces(params?: {
    pipeline?: string;
    agent?: string;
    from?: string;
    to?: string;
  }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.pipeline) qs.set("pipeline", params.pipeline);
    if (params?.agent) qs.set("agent", params.agent);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch<unknown>(`/api/traces${query}`);
  },

  async getTrace(traceId: string): Promise<unknown> {
    return apiFetch<unknown>(`/api/traces/${traceId}`);
  },

  // ── 통계 ─────────────────────────────────────────────────────

  async getAgentStats(): Promise<unknown> {
    return apiFetch<unknown>("/api/stats/agents");
  },

  // ── SSE 스트리밍 (C2) ─────────────────────────────────────────

  connectEventStream(params: {
    pipeline?: string;
    agent?: string;
    onEvent: (type: string, data: unknown) => void;
    onError?: (err: Event) => void;
  }): EventSource {
    const qs = new URLSearchParams();
    if (params.pipeline) qs.set("pipeline", params.pipeline);
    if (params.agent) qs.set("agent", params.agent);
    const url = `${BAMS_SERVER_BASE}/api/events/stream?${qs.toString()}`;

    const es = new EventSource(url);

    es.addEventListener("connected", (e: MessageEvent) => {
      params.onEvent("connected", JSON.parse(e.data));
    });

    es.addEventListener("task_updated", (e: MessageEvent) => {
      params.onEvent("task_updated", JSON.parse(e.data));
    });

es.addEventListener("agent_start", (e: MessageEvent) => {
      params.onEvent("agent_start", JSON.parse(e.data));
    });

    es.addEventListener("agent_end", (e: MessageEvent) => {
      params.onEvent("agent_end", JSON.parse(e.data));
    });

    es.addEventListener("tool_call", (e: MessageEvent) => {
      params.onEvent("tool_call", JSON.parse(e.data));
    });

    es.addEventListener("tool_result", (e: MessageEvent) => {
      params.onEvent("tool_result", JSON.parse(e.data));
    });

    es.addEventListener("text_chunk", (e: MessageEvent) => {
      params.onEvent("text_chunk", JSON.parse(e.data));
    });

    es.addEventListener("error_event", (e: MessageEvent) => {
      params.onEvent("error_event", JSON.parse(e.data));
    });

    if (params.onError) {
      es.addEventListener("error", params.onError as EventListener);
    }

    return es;
  },

  // ── 워크유닛 ─────────────────────────────────────────────────

  async getWorkUnits(): Promise<{ workunits: WorkUnit[] }> {
    return apiFetch<{ workunits: WorkUnit[] }>("/api/workunits");
  },

  async getWorkUnit(slug: string): Promise<{ workunit: WorkUnit | null }> {
    return apiFetch<{ workunit: WorkUnit | null }>(`/api/workunits/${slug}`);
  },

  async getActiveWorkUnit(): Promise<{ workunit: WorkUnit | null }> {
    return apiFetch<{ workunit: WorkUnit | null }>("/api/workunits/active");
  },

  // ── Work Unit 확장 API ────────────────────────────────────────

  async getWorkUnitTasks(slug: string): Promise<WorkUnitTasksResponse> {
    return apiFetch<WorkUnitTasksResponse>(`/api/workunits/${encodeURIComponent(slug)}/tasks`);
  },

  async getWorkUnitDetail(slug: string): Promise<WorkUnitDetailResponse & { pipelines?: PipelineDetail[] }> {
    return apiFetch<WorkUnitDetailResponse & { pipelines?: PipelineDetail[] }>(`/api/workunits/${encodeURIComponent(slug)}`);
  },

  // ── HR 보고서 ─────────────────────────────────────────────────

  async getHRReports(): Promise<HRReportsResponse> {
    return apiFetch<HRReportsResponse>("/api/hr/reports");
  },

  async getHRReport(id: string): Promise<HRReportDetailResponse> {
    return apiFetch<HRReportDetailResponse>(`/api/hr/reports/${encodeURIComponent(id)}`);
  },

  // ── Work Unit 조작 (PATCH / DELETE) ─────────────────────────────

  async patchWorkUnit(
    slug: string,
    body: WorkUnitPatchRequest
  ): Promise<{ workunit: WorkUnit }> {
    return proxyFetch<{ workunit: WorkUnit }>(
      `/api/workunits/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      }
    );
  },

  async deleteWorkUnit(slug: string): Promise<{ ok: boolean }> {
    return proxyFetch<{ ok: boolean }>(
      `/api/workunits/${encodeURIComponent(slug)}`,
      { method: "DELETE" }
    );
  },


  async patchWorkUnitPipeline(
    wuSlug: string,
    pipelineSlug: string,
    body: { status: "completed" | "failed" | "paused" }
  ): Promise<{ ok: boolean }> {
    return proxyFetch<{ ok: boolean }>(
      `/api/workunits/${encodeURIComponent(wuSlug)}/pipelines/${encodeURIComponent(pipelineSlug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      }
    );
  },
  // ── Work Unit 에이전트 통계 ───────────────────────────────────────

  async getWorkUnitAgents(slug: string): Promise<WorkUnitAgentsResponse> {
    return proxyFetch<WorkUnitAgentsResponse>(
      `/api/workunits/${encodeURIComponent(slug)}/agents`
    );
  },

  async getWorkUnitAgentsActive(slug: string): Promise<WorkUnitAgentsActiveResponse> {
    return proxyFetch<WorkUnitAgentsActiveResponse>(
      `/api/workunits/${encodeURIComponent(slug)}/agents/active`
    );
  },

  // ── Work Unit Retro 연결 ─────────────────────────────────────────

  async getWorkUnitRetro(slug: string): Promise<WorkUnitRetroResponse> {
    return proxyFetch<WorkUnitRetroResponse>(
      `/api/workunits/${encodeURIComponent(slug)}/retro`
    );
  },


  // ── Health ───────────────────────────────────────────────────

  async health(): Promise<{ ok: boolean; version: string; port: number }> {
    return apiFetch<{ ok: boolean; version: string; port: number }>("/health");
  },
};
