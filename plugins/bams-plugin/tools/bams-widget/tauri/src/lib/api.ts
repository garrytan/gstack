/**
 * src/lib/api.ts
 * bams-server (Control Plane) API 클라이언트 레이어 — 위젯 전용
 * bams-viz/src/lib/bams-api.ts 이식 (Next.js 의존성 제거, baseURL 고정)
 *
 * SWR fetcher 포함:
 *   import { fetcher, bamsApi } from "@/lib/api";
 *   const { data } = useSWR("/api/workunits/active", fetcher);
 */

import type {
  WorkUnit,
  WorkUnitsResponse,
  WorkUnitDetailResponse,
  ActiveAgentsResponse,
  HealthResponse,
  PipelineDetail,
} from "./types";

export const BAMS_SERVER_BASE = "http://localhost:3099";

// ─────────────────────────────────────────────────────────────
// SWR fetcher
// ─────────────────────────────────────────────────────────────

/**
 * SWR용 범용 fetcher
 * path가 "/" 로 시작하면 BAMS_SERVER_BASE를 prefix로 붙임
 */
export async function fetcher<T = unknown>(path: string): Promise<T> {
  const url = path.startsWith("/") ? `${BAMS_SERVER_BASE}${path}` : path;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    const error = new Error(
      `bams-api: ${res.status} ${res.statusText} — ${body}`
    );
    throw error;
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────
// 공통 fetch 래퍼
// ─────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
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

// ─────────────────────────────────────────────────────────────
// API 클라이언트
// ─────────────────────────────────────────────────────────────

export const bamsApi = {
  // ── Health ──────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    return apiFetch<HealthResponse>("/health");
  },

  // ── Work Units ───────────────────────────────────────────────

  async getWorkUnits(): Promise<WorkUnitsResponse> {
    return apiFetch<WorkUnitsResponse>("/api/workunits");
  },

  async getActiveWorkUnit(): Promise<{ workunit: WorkUnit | null }> {
    return apiFetch<{ workunit: WorkUnit | null }>("/api/workunits/active");
  },

  async getWorkUnitDetail(
    slug: string
  ): Promise<WorkUnitDetailResponse & { pipelines?: PipelineDetail[] }> {
    return apiFetch<WorkUnitDetailResponse & { pipelines?: PipelineDetail[] }>(
      `/api/workunits/${encodeURIComponent(slug)}`
    );
  },

  // ── Active Agents ────────────────────────────────────────────

  async getWorkUnitAgentsActive(
    slug: string
  ): Promise<ActiveAgentsResponse> {
    return apiFetch<ActiveAgentsResponse>(
      `/api/workunits/${encodeURIComponent(slug)}/agents/active`
    );
  },

  // ── SSE 스트리밍 ─────────────────────────────────────────────

  connectEventStream(params: {
    pipeline?: string;
    onEvent: (type: string, data: unknown) => void;
    onError?: (err: Event) => void;
  }): EventSource {
    const qs = new URLSearchParams();
    if (params.pipeline) qs.set("pipeline", params.pipeline);
    const url = `${BAMS_SERVER_BASE}/api/events/stream?${qs.toString()}`;

    const es = new EventSource(url);

    const eventTypes = [
      "connected",
      "task_updated",
      "agent_start",
      "agent_end",
      "pipeline_end",
      "error_event",
    ];

    for (const eventType of eventTypes) {
      es.addEventListener(eventType, (e: Event) => {
        try {
          const data = JSON.parse((e as MessageEvent).data as string) as unknown;
          params.onEvent(eventType, data);
        } catch {
          // parse 실패 무시
        }
      });
    }

    if (params.onError) {
      es.addEventListener("error", params.onError as EventListener);
    }

    return es;
  },
};

// ─────────────────────────────────────────────────────────────
// SWR 키 상수
// ─────────────────────────────────────────────────────────────

export const SWR_KEYS = {
  health: "/health",
  workUnits: "/api/workunits",
  activeWorkUnit: "/api/workunits/active",
  workUnitDetail: (slug: string) => `/api/workunits/${encodeURIComponent(slug)}`,
  workUnitAgentsActive: (slug: string) =>
    `/api/workunits/${encodeURIComponent(slug)}/agents/active`,
} as const;
