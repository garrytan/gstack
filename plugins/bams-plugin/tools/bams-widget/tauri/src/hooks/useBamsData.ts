/**
 * src/hooks/useBamsData.ts
 * TASK-009: SWR + SSE 통합 hook — bams-server 데이터 구독
 *
 * 역할:
 * - SWR로 REST API 초기 데이터 로드
 * - SSE 이벤트 수신 시 SWR cache mutate로 즉시 업데이트
 * - 연결 상태에 따른 UI 표시 지원
 *
 * 사용법:
 *   const { workUnit, agents, pipeline, sseState } = useBamsData();
 */

import useSWR, { useSWRConfig } from "swr";
import { useCallback } from "react";
import { fetcher, SWR_KEYS } from "@/lib/api";
import { useSSE } from "./useSSE";
import {
  isAgentStartEvent,
  isAgentEndEvent,
  isPipelineEndEvent,
} from "@/lib/sse";
import type {
  WorkUnit,
  ActiveAgentsResponse,
  PipelineDetail,
  AgentStartEvent,
  AgentEndEvent,
  PipelineEndEvent,
  ActiveAgent,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────

export interface UseBamsDataReturn {
  /** 현재 활성 Work Unit (없으면 null) */
  workUnit: WorkUnit | null;
  /** 현재 활성 에이전트 목록 */
  agents: ActiveAgent[];
  /** 최근 파이프라인 목록 */
  pipelines: PipelineDetail[];
  /** 로딩 상태 */
  isLoading: boolean;
  /** 에러 상태 */
  error: unknown;
  /** SSE 연결 상태 */
  sseState: ReturnType<typeof useSSE>["state"];
  /** 수동 새로고침 */
  refresh: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Hook 구현
// ─────────────────────────────────────────────────────────────

export function useBamsData(): UseBamsDataReturn {
  const { mutate } = useSWRConfig();

  // ── SWR 구독 ─────────────────────────────────────────────

  const {
    data: activeWUData,
    error: wuError,
    isLoading: wuLoading,
  } = useSWR<{ workunit: WorkUnit | null }>(
    SWR_KEYS.activeWorkUnit,
    fetcher,
    {
      refreshInterval: 60_000, // SSE가 실패하면 1분마다 폴링
      revalidateOnFocus: false,
    }
  );

  const workUnit = activeWUData?.workunit ?? null;
  const wuSlug = workUnit?.slug;

  const {
    data: agentsData,
    error: agentsError,
    isLoading: agentsLoading,
  } = useSWR<ActiveAgentsResponse>(
    wuSlug ? SWR_KEYS.workUnitAgentsActive(wuSlug) : null,
    fetcher,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
    }
  );

  const {
    data: wuDetailData,
    isLoading: detailLoading,
  } = useSWR(
    wuSlug ? SWR_KEYS.workUnitDetail(wuSlug) : null,
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: false,
    }
  );

  // ── SSE 이벤트 핸들러 ────────────────────────────────────

  const handleSSEEvent = useCallback(
    (type: string, data: unknown) => {
      switch (type) {
        case "agent_start": {
          if (!isAgentStartEvent(data) || !wuSlug) break;
          const event = data as AgentStartEvent;

          // 활성 에이전트 목록에 즉시 추가
          void mutate(
            SWR_KEYS.workUnitAgentsActive(wuSlug),
            (current: ActiveAgentsResponse | undefined) => {
              if (!current) return current;
              const newAgent: ActiveAgent = {
                call_id: event.call_id,
                agent_type: event.agent_type,
                department: event.department,
                description: event.description,
                started_at: event.ts,
                elapsed_ms: 0,
              };
              // 중복 방지
              const exists = current.active_agents.some(
                (a) => a.call_id === event.call_id
              );
              if (exists) return current;
              return {
                ...current,
                active_agents: [...current.active_agents, newAgent],
                count: current.count + 1,
              };
            },
            { revalidate: false }
          );
          break;
        }

        case "agent_end": {
          if (!isAgentEndEvent(data) || !wuSlug) break;
          const event = data as AgentEndEvent;

          // 완료된 에이전트를 목록에서 제거
          void mutate(
            SWR_KEYS.workUnitAgentsActive(wuSlug),
            (current: ActiveAgentsResponse | undefined) => {
              if (!current) return current;
              const filtered = current.active_agents.filter(
                (a) => a.call_id !== event.call_id
              );
              return {
                ...current,
                active_agents: filtered,
                count: filtered.length,
              };
            },
            { revalidate: false }
          );
          break;
        }

        case "pipeline_end": {
          if (!isPipelineEndEvent(data)) break;
          const event = data as PipelineEndEvent;

          // pipeline_end 수신 시 WU 상세 및 에이전트 목록 재검증
          if (wuSlug) {
            void mutate(SWR_KEYS.workUnitDetail(wuSlug));
            void mutate(SWR_KEYS.workUnitAgentsActive(wuSlug));
          }

          // 완료된 파이프라인의 상태가 completed이면 WU 상태도 갱신
          if (event.status === "completed" || event.status === "failed") {
            void mutate(SWR_KEYS.activeWorkUnit);
          }
          break;
        }

        case "poll_active": {
          // 폴링 모드에서 수신 — SWR 강제 재검증
          void mutate(SWR_KEYS.activeWorkUnit);
          if (wuSlug) {
            void mutate(SWR_KEYS.workUnitAgentsActive(wuSlug));
          }
          break;
        }

        default:
          break;
      }
    },
    [mutate, wuSlug]
  );

  // ── SSE 연결 ─────────────────────────────────────────────

  const { state: sseState } = useSSE({
    pipeline: "global",
    onEvent: handleSSEEvent,
  });

  // ── 수동 새로고침 ──────────────────────────────────────────

  const refresh = useCallback(async () => {
    await mutate(SWR_KEYS.activeWorkUnit);
    if (wuSlug) {
      await mutate(SWR_KEYS.workUnitAgentsActive(wuSlug));
      await mutate(SWR_KEYS.workUnitDetail(wuSlug));
    }
  }, [mutate, wuSlug]);

  // ── 반환값 조합 ──────────────────────────────────────────

  const pipelines =
    (wuDetailData as { pipelines?: PipelineDetail[] } | undefined)
      ?.pipelines ?? [];

  return {
    workUnit,
    agents: agentsData?.active_agents ?? [],
    pipelines,
    isLoading: wuLoading || agentsLoading || detailLoading,
    error: wuError ?? agentsError ?? null,
    sseState,
    refresh,
  };
}
