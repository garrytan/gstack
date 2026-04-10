/**
 * bams-plugin/server/src/app.ts
 *
 * Control Plane 서버 — Bun HTTP 서버 (포트 3099)
 *
 * Paperclip의 서버 패턴을 bams-plugin에 적용:
 * - Bun.serve() 기반 (Express 의존성 없음)
 * - REST API + SSE 스트리밍
 * - SQLite TaskDB 직접 연동 (FK 기반) — DB가 primary data source
 * - CORS: * (개발 환경, 모든 origin 허용)
 *
 * 엔드포인트:
 *   GET  /api/pipelines                   — 파이프라인 목록 (DB)
 *   GET  /api/pipelines/:slug             — 파이프라인 상세 (DB)
 *   GET  /api/pipelines/:slug/tasks       — 파이프라인 하위 task 조회
 *   GET  /api/tasks                       — 태스크 목록 (쿼리: pipeline=, status=)
 *   PATCH /api/tasks/:id                  — 태스크 상태 업데이트 (atomic)
 *   GET  /api/agents                      — 에이전트 목록
 *   GET  /api/agents/:slug/status         — 에이전트 실행 상태
 *   GET  /api/events/stream               — SSE 스트리밍 (C2용, 쿼리: pipeline=, agent=)
 *   GET  /api/workunits                   — work unit 목록 (파이프라인 수 포함)
 *   GET  /api/workunits/active            — 활성 work unit 목록
 *   GET  /api/workunits/:slug             — work unit 상세 (이벤트 + 파이프라인 + task_summary)
 *   GET  /api/workunits/:slug/tasks       — work unit 하위 전체 task 목록
 *   GET  /api/workunits/:slug/agents      — 에이전트 통계 (이벤트 파일 기반)
 *   GET  /api/workunits/:slug/agents/active — 현재 실행 중 에이전트만
 *   GET  /api/workunits/:slug/retro       — retro 자동 요약 (이벤트 기반)
 *   PATCH /api/workunits/:slug            — work unit 상태 업데이트 (completed/abandoned)
 *   PATCH /api/workunits/:slug/pipelines/:pipelineSlug — pipeline 강제 종료
 *   DELETE /api/workunits/:slug           — work unit 소프트 삭제
 *   POST /api/events                      — 범용 이벤트 수신 (emit.sh → DB 기록)
 *   GET  /api/hr/reports                  — HR 보고서 목록
 *   GET  /api/hr/reports/:id              — HR 보고서 상세
 */

import { readFileSync, existsSync, readdirSync } from "fs"; // Used by parseAgentInfo(), getAgentSlugs()
import { join } from "path";
import { getDefaultDB, getDefaultWorkUnitDB, getDefaultHrReportDB } from "../../tools/bams-db/index.ts";
import { getBroker } from "./sse-broker.ts";
import type { TaskStatus } from "../../tools/bams-db/schema.ts";

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BAMS_SERVER_PORT ?? "3099", 10);
const AGENTS_DIR = "plugins/bams-plugin/agents";

/** SSE 이벤트 push — SseBroker 경유 (DB 영구 보존 + 스트리밍) */
export function pushSseEvent(
  pipelineSlug: string,
  eventType: string,
  data: Record<string, unknown>
): void {
  const broker = getBroker();
  broker.pushEvent({
    type: eventType as import("./sse-broker.ts").SseEventType,
    pipeline_slug: pipelineSlug,
    agent_slug: (data as { agent_slug?: string; agent_type?: string }).agent_slug
      ?? (data as { agent_type?: string }).agent_type
      ?? "system",
    run_id: (data as { run_id?: string }).run_id,
    ts: new Date().toISOString(),
    payload: data,
  });
}

// ─────────────────────────────────────────────────────────────
// CORS 헤더
// ─────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ─────────────────────────────────────────────────────────────
// 파이프라인 이벤트 타입 (DB 기반, JSONL 파싱 제거됨)
// ─────────────────────────────────────────────────────────────

interface PipelineEvent {
  type: string;
  pipeline_slug?: string;
  ts?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// 에이전트 목록 파싱
// ─────────────────────────────────────────────────────────────

interface AgentInfo {
  slug: string;
  name: string;
  department: string;
}

function parseAgentInfo(slug: string): AgentInfo {
  const filePath = join(AGENTS_DIR, `${slug}.md`);
  if (!existsSync(filePath)) {
    return { slug, name: slug, department: "unknown" };
  }
  const content = readFileSync(filePath, "utf-8");
  const nameMatch = content.match(/^#\s+(.+)$/m);
  const deptMatch = content.match(/(?:부서|department)[:\s]+([^\n]+)/i);
  return {
    slug,
    name: nameMatch?.[1]?.trim() ?? slug,
    department: deptMatch?.[1]?.trim() ?? "unknown",
  };
}

function getAgentSlugs(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  try {
    return readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 라우터 (DB가 primary data source — JSONL sync 제거됨)
// ─────────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── GET /api/pipelines ──────────────────────────────────────
  if (method === "GET" && path === "/api/pipelines") {
    const db = getDefaultDB();
    const dbPipelines = db.getPipelines();

    // DB에 있는 파이프라인을 slug → row 맵으로 변환
    const dbMap = new Map(dbPipelines.map((p) => [p.slug, p]));

    // work_unit_slug 보충 (DB FK → work_units 테이블 조회)
    // M-05: getWorkUnits()를 루프 밖에서 1회만 호출하여 N+1 쿼리 방지
    const wuDb = getDefaultWorkUnitDB();
    const allWorkUnits = wuDb.getWorkUnits();
    const wuById = new Map(allWorkUnits.map((wu) => [wu.id, wu]));

    // DB 기반 결과
    const pipelines = dbPipelines.map((p) => {
      const summary = db.getPipelineSummary(p.id);
      const wu = p.work_unit_id ? wuById.get(p.work_unit_id) : undefined;
      return {
        slug: p.slug,
        pipeline_type: p.type ?? "unknown",
        started_at: p.started_at ?? null,
        last_event_at: p.updated_at ?? p.started_at ?? null,
        work_unit_slug: wu?.slug ?? null,
        status: p.status ?? "active",
        task_summary: summary,
      };
    });

    return jsonResponse({ pipelines });
  }

  // ── GET /api/pipelines/:slug/tasks ──────────────────────────
  // NOTE: 더 구체적인 경로이므로 /api/pipelines/:slug 앞에 위치
  const pipelineTasksMatch = path.match(/^\/api\/pipelines\/([^/]+)\/tasks$/);
  if (method === "GET" && pipelineTasksMatch) {
    const slug = decodeURIComponent(pipelineTasksMatch[1]);
    const db = getDefaultDB();
    const pipeline = db.getPipelineBySlug(slug);
    if (!pipeline) {
      return errorResponse(`Pipeline not found: ${slug}`, 404);
    }
    const tasks = db.getTasksByPipelineId(pipeline.id);
    const summary = db.getPipelineSummary(pipeline.id);
    return jsonResponse({ pipeline_slug: slug, tasks, count: tasks.length, summary });
  }

  // ── GET /api/pipelines/:slug ────────────────────────────────
  const pipelineDetailMatch = path.match(/^\/api\/pipelines\/([^/]+)$/);
  if (method === "GET" && pipelineDetailMatch) {
    const slug = decodeURIComponent(pipelineDetailMatch[1]);
    const db = getDefaultDB();
    const pipeline = db.getPipelineBySlug(slug);

    if (!pipeline) {
      return errorResponse(`Pipeline not found: ${slug}`, 404);
    }

    const tasks = db.getTasksByPipelineId(pipeline.id);
    const summary = db.getPipelineSummary(pipeline.id);
    // 이벤트를 DB에서 조회하고 프론트엔드 호환 형식으로 매핑
    const dbEvents = db.getPipelineEvents(slug);
    const events = dbEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: slug,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      department: e.department,
      model: e.model,
      step_number: e.step_number,
      step_name: e.step_name,
      phase: e.phase,
      status: e.status,
      duration_ms: e.duration_ms,
      description: e.description,
      result_summary: e.result_summary,
      message: e.message,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));
    return jsonResponse({ slug, pipeline, events, tasks, summary });
  }

  // ── GET /api/tasks ──────────────────────────────────────────
  if (method === "GET" && path === "/api/tasks") {
    const pipelineSlug = url.searchParams.get("pipeline");
    const status = url.searchParams.get("status") as TaskStatus | null;
    const db = getDefaultDB();

    if (!pipelineSlug) {
      return errorResponse("pipeline query parameter is required");
    }

    // pipeline slug → pipeline id 변환
    const pipeline = db.getPipelineBySlug(pipelineSlug);
    if (!pipeline) {
      return jsonResponse({ tasks: [], count: 0 });
    }

    const tasks = status
      ? db.getTasksByStatus(pipeline.id, status)
      : db.getTasksByPipelineId(pipeline.id);

    return jsonResponse({ tasks, count: tasks.length });
  }

  // ── PATCH /api/tasks/:id ────────────────────────────────────
  const taskPatchMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "PATCH" && taskPatchMatch) {
    const taskId = taskPatchMatch[1];
    let body: { status?: TaskStatus; agent_slug?: string; run_id?: string };
    try {
      body = await req.json() as { status?: TaskStatus; agent_slug?: string; run_id?: string };
    } catch {
      return errorResponse("Invalid JSON body");
    }

    if (!body.status) {
      return errorResponse("status is required in body");
    }

    const db = getDefaultDB();
    const task = db.getTask(taskId);
    if (!task) {
      return errorResponse(`Task not found: ${taskId}`, 404);
    }

    // Atomic checkout 특별 처리
    if (body.status === "in_progress" && task.status === "backlog") {
      const runId = body.run_id ?? `api-${Date.now()}`;
      const agentSlug = body.agent_slug ?? "api";
      const ok = db.checkoutTask(taskId, runId, agentSlug);
      if (!ok) {
        return errorResponse("Task already checked out or not in backlog", 409);
      }
    } else {
      db.updateTaskStatus(
        taskId,
        body.status,
        body.agent_slug ?? "api",
        body.run_id
      );
    }

    // SSE 이벤트 push
    const updatedTask = db.getTask(taskId);
    if (updatedTask) {
      // 새 스키마: Task에 pipeline_slug 컬럼 없음, pipeline_id FK만 존재
      // pipeline_id → pipeline slug 역조회 (getPipelines 전체 조회 후 id 매칭)
      const pipelineForTask = db.getPipelines().find((p) => p.id === updatedTask.pipeline_id);
      const pipelineSlugForSse = pipelineForTask?.slug ?? updatedTask.pipeline_id;
      pushSseEvent(pipelineSlugForSse, "task_updated", updatedTask as unknown as Record<string, unknown>);
    }

    return jsonResponse({ task: updatedTask });
  }

  // ── GET /api/agents ─────────────────────────────────────────
  if (method === "GET" && path === "/api/agents") {
    const slugs = getAgentSlugs();
    const agents = slugs.map((slug) => parseAgentInfo(slug));
    return jsonResponse({ agents, count: agents.length });
  }

  // ── GET /api/agents/:slug/status ────────────────────────────
  const agentStatusMatch = path.match(/^\/api\/agents\/([^/]+)\/status$/);
  if (method === "GET" && agentStatusMatch) {
    const slug = agentStatusMatch[1];
    const db = getDefaultDB();

    // DB에서 해당 에이전트의 최근 이벤트 조회 (agent_type 또는 call_id에 slug 포함)
    const allAgentEvents = db.getAllPipelineEvents();
    const agentEvents = allAgentEvents.filter(
      (e) =>
        (e.event_type === "agent_start" || e.event_type === "agent_end") &&
        (e.agent_type === slug || (e.call_id?.includes(slug) ?? false))
    );

    if (agentEvents.length === 0) {
      return jsonResponse({ slug, status: "idle", last_event: null });
    }

    const lastEvent = agentEvents[agentEvents.length - 1];
    const status =
      lastEvent.event_type === "agent_start"
        ? "running"
        : lastEvent.is_error
          ? "error"
          : "idle";

    return jsonResponse({
      slug,
      status,
      pipeline_slug: lastEvent.pipeline_slug ?? null,
      last_event: {
        type: lastEvent.event_type,
        pipeline_slug: lastEvent.pipeline_slug,
        ts: lastEvent.ts,
        call_id: lastEvent.call_id,
        agent_type: lastEvent.agent_type,
        is_error: lastEvent.is_error ? true : false,
        status: lastEvent.status,
        duration_ms: lastEvent.duration_ms,
        description: lastEvent.description,
        result_summary: lastEvent.result_summary,
      },
    });
  }

  // ── GET /api/events/stream ───────────────────────────────────
  if (method === "GET" && path === "/api/events/stream") {
    const pipelineParam = url.searchParams.get("pipeline") ?? "global";
    const agentParam = url.searchParams.get("agent");

    const broker = getBroker();
    const stream = broker.createStream({
      pipeline: pipelineParam !== "global" ? pipelineParam : undefined,
      agent: agentParam ?? undefined,
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      },
    });
  }

  // ── GET /api/workunits/active ──────────────────────────────────
  // NOTE: /active must match BEFORE the /:slug route
  if (method === "GET" && path === "/api/workunits/active") {
    const wuDb = getDefaultWorkUnitDB();
    const db = getDefaultDB();
    const allWu = wuDb.getWorkUnits().filter(
      (wu) => wu.status === "active" && !wu.deleted_at
    );
    const active = allWu.map((wu) => {
      const dbPipelines = db.getWorkUnitPipelines(wu.slug);
      return {
        slug: wu.slug,
        name: wu.name ?? wu.slug,
        status: "active" as const,
        startedAt: wu.started_at ?? null,
        endedAt: null,
        pipelineCount: dbPipelines.length,
      };
    });
    return jsonResponse({ workunits: active });
  }

  // ── GET /api/workunits ──────────────────────────────────────
  if (method === "GET" && path === "/api/workunits") {
    const wuDb = getDefaultWorkUnitDB();
    const db = getDefaultDB();
    const allWu = wuDb.getWorkUnits().filter((wu) => !wu.deleted_at);
    const workunits = allWu.map((wu) => {
      const dbPipelines = db.getWorkUnitPipelines(wu.slug);
      return {
        slug: wu.slug,
        name: wu.name ?? wu.slug,
        status: wu.status ?? "unknown",
        startedAt: wu.started_at ?? null,
        endedAt: wu.ended_at ?? null,
        pipelineCount: dbPipelines.length,
      };
    });
    return jsonResponse({ workunits });
  }

  // ── GET /api/workunits/:slug ────────────────────────────────
  const workunitDetailMatch = path.match(/^\/api\/workunits\/([^/]+)$/);
  if (method === "GET" && workunitDetailMatch) {
    const wuSlug = decodeURIComponent(workunitDetailMatch[1]);
    const wuDb = getDefaultWorkUnitDB();
    const wu = wuDb.getWorkUnit(wuSlug);
    if (!wu) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    const db = getDefaultDB();

    // WU 이벤트를 DB에서 조회하고 프론트엔드 호환 형식으로 매핑
    const dbWuEvents = db.getWorkUnitEvents(wuSlug);
    const events = dbWuEvents.map((e) => ({
      type: e.event_type,
      work_unit_slug: wuSlug,
      ts: e.ts,
      pipeline_slug: e.pipeline_slug,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));

    // Find linked pipelines — DB FK 기반
    const dbRows = db.getWorkUnitPipelines(wuSlug);
    const pipelines = dbRows.map((row) => ({
      slug: row.slug,
      type: row.type ?? "unknown",
      linkedAt: row.created_at ?? null,
      status: row.status ?? "active",
      id: row.id ?? null,
      totalSteps: row.total_steps ?? 0,
      completedSteps: row.completed_steps ?? 0,
      failedSteps: row.failed_steps ?? 0,
      durationMs: row.duration_ms ?? null,
      command: row.command ?? null,
      arguments: row.arguments ?? null,
    }));

    // Work Unit task_summary 집계 (DB FK 기반)
    let taskSummary = { total: 0, backlog: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 };
    for (const p of pipelines) {
      if (p.id) {
        const s = db.getPipelineSummary(p.id);
        taskSummary = {
          total: taskSummary.total + s.total,
          backlog: taskSummary.backlog + s.backlog,
          in_progress: taskSummary.in_progress + s.in_progress,
          in_review: taskSummary.in_review + (s.in_review ?? 0),
          done: taskSummary.done + s.done,
          blocked: taskSummary.blocked + s.blocked,
          cancelled: taskSummary.cancelled + s.cancelled,
        };
      }
    }

    return jsonResponse({
      slug: wuSlug,
      name: wu.name ?? wuSlug,
      status: wu.status ?? "unknown",
      startedAt: wu.started_at ?? null,
      endedAt: wu.ended_at ?? null,
      events,
      pipelines,
      task_summary: taskSummary,
    });
  }

  // ── GET /api/workunits/:slug/tasks ─────────────────────────────
  const workunitTasksMatch = path.match(/^\/api\/workunits\/([^/]+)\/tasks$/);
  if (method === "GET" && workunitTasksMatch) {
    const wuSlug = decodeURIComponent(workunitTasksMatch[1]);
    const wuDb = getDefaultWorkUnitDB();
    const wu = wuDb.getWorkUnit(wuSlug);
    if (!wu) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    const db = getDefaultDB();
    const dbPipelines = db.getWorkUnitPipelines(wuSlug);
    const pipelinesWithTasks = dbPipelines.map((p) => ({
      slug: p.slug,
      tasks: db.getTasksByPipelineId(p.id),
    }));

    const allTasks = pipelinesWithTasks.flatMap((p) => p.tasks) as Array<{ status: string }>;
    const summary = {
      backlog: allTasks.filter((t) => t.status === "backlog").length,
      in_progress: allTasks.filter((t) => t.status === "in_progress").length,
      in_review: allTasks.filter((t) => t.status === "in_review").length,
      done: allTasks.filter((t) => t.status === "done").length,
      blocked: allTasks.filter((t) => t.status === "blocked").length,
      cancelled: allTasks.filter((t) => t.status === "cancelled").length,
    };
    return jsonResponse({
      work_unit_slug: wuSlug,
      pipelines: pipelinesWithTasks,
      total_count: allTasks.length,
      summary,
    });
  }

  // ── GET /api/workunits/:slug/agents/active ─────────────────────
  // NOTE: /agents/active must match BEFORE /agents
  const workunitAgentsActiveMatch = path.match(/^\/api\/workunits\/([^/]+)\/agents\/active$/);
  if (method === "GET" && workunitAgentsActiveMatch) {
    const wuSlug = decodeURIComponent(workunitAgentsActiveMatch[1]);
    const wuDb = getDefaultWorkUnitDB();
    const wu = wuDb.getWorkUnit(wuSlug);
    if (!wu) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    const db = getDefaultDB();
    const wuPipelineEvents = db.getPipelineEventsByWorkUnit(wuSlug);

    // agent_start가 있고 agent_end가 없는 call_id를 찾음
    const startedCallIds = new Map<string, { call_id: string; agent_type: string; pipeline_slug: string; started_at: string | null }>();
    const endedCallIds = new Set<string>();
    const endedPipelines = new Set<string>();

    for (const e of wuPipelineEvents) {
      if (e.event_type === "pipeline_end") {
        endedPipelines.add(e.pipeline_slug);
      }
      if (e.event_type === "agent_start" && e.call_id) {
        startedCallIds.set(e.call_id, {
          call_id: e.call_id,
          agent_type: e.agent_type ?? "unknown",
          pipeline_slug: e.pipeline_slug,
          started_at: e.ts ?? null,
        });
      }
      if (e.event_type === "agent_end" && e.call_id) {
        endedCallIds.add(e.call_id);
      }
    }

    const activeAgents = Array.from(startedCallIds.values()).filter(
      (a) => !endedCallIds.has(a.call_id) && !endedPipelines.has(a.pipeline_slug)
    );

    return jsonResponse({ work_unit_slug: wuSlug, active_agents: activeAgents });
  }

  // ── GET /api/workunits/:slug/agents ─────────────────────────────
  const workunitAgentsMatch = path.match(/^\/api\/workunits\/([^/]+)\/agents$/);
  if (method === "GET" && workunitAgentsMatch) {
    const wuSlug = decodeURIComponent(workunitAgentsMatch[1]);
    const wuDb = getDefaultWorkUnitDB();
    const wu = wuDb.getWorkUnit(wuSlug);
    if (!wu) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    const db = getDefaultDB();
    const wuPipelineEvents = db.getPipelineEventsByWorkUnit(wuSlug);

    // agent 통계 집계 (agent_end 이벤트 기반)
    const agentStatsMap = new Map<string, { call_count: number; error_count: number; total_duration_ms: number; duration_count: number }>();
    for (const ae of wuPipelineEvents) {
      if (ae.event_type !== "agent_end") continue;
      const agentType = ae.agent_type ?? "unknown";
      const existing = agentStatsMap.get(agentType) ?? { call_count: 0, error_count: 0, total_duration_ms: 0, duration_count: 0 };
      existing.call_count += 1;
      if (ae.is_error) existing.error_count += 1;
      if (ae.duration_ms != null) {
        existing.total_duration_ms += ae.duration_ms;
        existing.duration_count += 1;
      }
      agentStatsMap.set(agentType, existing);
    }
    const stats = Array.from(agentStatsMap.entries())
      .map(([agent_type, s]) => ({
        agent_type,
        call_count: s.call_count,
        error_count: s.error_count,
        avg_duration_ms: s.duration_count > 0 ? Math.round(s.total_duration_ms / s.duration_count) : null,
      }))
      .sort((a, b) => b.call_count - a.call_count);

    // 활성 에이전트 집계
    const startedCallIds = new Map<string, { call_id: string; agent_type: string; pipeline_slug: string; started_at: string | null }>();
    const endedCallIds = new Set<string>();
    const endedPipelines = new Set<string>();

    for (const e of wuPipelineEvents) {
      if (e.event_type === "pipeline_end") endedPipelines.add(e.pipeline_slug);
      if (e.event_type === "agent_start" && e.call_id) {
        startedCallIds.set(e.call_id, {
          call_id: e.call_id,
          agent_type: e.agent_type ?? "unknown",
          pipeline_slug: e.pipeline_slug,
          started_at: e.ts ?? null,
        });
      }
      if (e.event_type === "agent_end" && e.call_id) endedCallIds.add(e.call_id);
    }
    const activeAgents = Array.from(startedCallIds.values()).filter(
      (a) => !endedCallIds.has(a.call_id) && !endedPipelines.has(a.pipeline_slug)
    );

    return jsonResponse({ work_unit_slug: wuSlug, stats, active_agents: activeAgents });
  }

  // ── GET /api/workunits/:slug/retro ──────────────────────────────
  const workunitRetroMatch = path.match(/^\/api\/workunits\/([^/]+)\/retro$/);
  if (method === "GET" && workunitRetroMatch) {
    const wuSlug = decodeURIComponent(workunitRetroMatch[1]);
    const wuDb = getDefaultWorkUnitDB();
    const wu = wuDb.getWorkUnit(wuSlug);
    if (!wu) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    const db = getDefaultDB();
    const dbPipelines = db.getWorkUnitPipelines(wuSlug);

    let autoSummary: {
      total_pipelines: number;
      completed_pipelines: number;
      failed_pipelines: number;
      active_pipelines: number;
      total_agents: number;
      total_agent_calls: number;
      agent_errors: number;
      total_duration_ms: number;
      pipelines: Array<{
        slug: string;
        type: string;
        status: "completed" | "failed" | "active" | "paused";
        started_at: string | null;
        ended_at: string | null;
        duration_ms: number | null;
        step_count: number;
        agent_calls: number;
        agent_errors: number;
      }>;
      top_agents: Array<{
        agent_type: string;
        call_count: number;
        error_count: number;
        avg_duration_ms: number | null;
      }>;
    } | null = null;

    if (dbPipelines.length > 0) {
      // 한 번의 쿼리로 WU 하위 모든 이벤트 가져오기
      const wuPipelineEvents = db.getPipelineEventsByWorkUnit(wuSlug);

      // 파이프라인 slug별 이벤트를 그룹화
      const eventsByPipeline = new Map<string, typeof wuPipelineEvents>();
      for (const e of wuPipelineEvents) {
        const ps = e.pipeline_slug;
        if (!eventsByPipeline.has(ps)) eventsByPipeline.set(ps, []);
        eventsByPipeline.get(ps)!.push(e);
      }

      type PipelineDataItem = {
        slug: string;
        type: string;
        status: "completed" | "failed" | "active" | "paused";
        started_at: string | null;
        ended_at: string | null;
        duration_ms: number | null;
        step_count: number;
        agent_calls: number;
        agent_errors: number;
      };
      const pipelinesData: PipelineDataItem[] = [];
      const agentStatsMap = new Map<string, { call_count: number; error_count: number; total_duration_ms: number; duration_count: number }>();
      const uniqueAgentTypes = new Set<string>();
      let totalAgentCalls = 0;
      let totalAgentErrors = 0;
      let totalDurationMs = 0;
      let completedCount = 0;
      let failedCount = 0;
      let activeCount = 0;

      for (const pRow of dbPipelines) {
        const pEvents = eventsByPipeline.get(pRow.slug) ?? [];

        let status: "completed" | "failed" | "active" | "paused" = "active";
        const pEndStatus = pRow.status;
        if (pEndStatus === "completed" || pEndStatus === "failed" || pEndStatus === "paused") {
          status = pEndStatus as "completed" | "failed" | "paused";
        } else if (pEndStatus !== "running" && pEndStatus !== "active") {
          // Check events for pipeline_end
          const pEnd = pEvents.find((e) => e.event_type === "pipeline_end");
          if (pEnd) {
            const endStatus = pEnd.status ?? "completed";
            if (endStatus === "failed") status = "failed";
            else if (endStatus === "paused") status = "paused";
            else status = "completed";
          }
        }

        if (status === "completed") completedCount++;
        else if (status === "failed") failedCount++;
        else activeCount++;

        const startedAt = pRow.started_at ?? null;
        const endedAt = pRow.ended_at ?? null;
        let durationMs: number | null = pRow.duration_ms ?? null;
        if (!durationMs && startedAt && endedAt) {
          durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
        }
        if (durationMs && durationMs > 0) totalDurationMs += durationMs;

        const stepCount = pEvents.filter((e) => e.event_type === "step_start").length;
        const agentEndEvents = pEvents.filter((e) => e.event_type === "agent_end");
        let pipelineAgentCalls = 0;
        let pipelineAgentErrors = 0;

        for (const ae of agentEndEvents) {
          const agentType = ae.agent_type ?? "unknown";
          uniqueAgentTypes.add(agentType);
          pipelineAgentCalls++;
          totalAgentCalls++;

          const isError = !!ae.is_error || ae.status === "error";
          if (isError) {
            pipelineAgentErrors++;
            totalAgentErrors++;
          }

          const existing = agentStatsMap.get(agentType) ?? { call_count: 0, error_count: 0, total_duration_ms: 0, duration_count: 0 };
          existing.call_count += 1;
          if (isError) existing.error_count += 1;
          if (ae.duration_ms != null) {
            existing.total_duration_ms += ae.duration_ms;
            existing.duration_count += 1;
          }
          agentStatsMap.set(agentType, existing);
        }

        pipelinesData.push({
          slug: pRow.slug,
          type: pRow.type ?? pRow.slug.split("_")[0] ?? "unknown",
          status,
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: durationMs,
          step_count: stepCount,
          agent_calls: pipelineAgentCalls,
          agent_errors: pipelineAgentErrors,
        });
      }

      const topAgents = Array.from(agentStatsMap.entries())
        .map(([agent_type, s]) => ({
          agent_type,
          call_count: s.call_count,
          error_count: s.error_count,
          avg_duration_ms: s.duration_count > 0 ? Math.round(s.total_duration_ms / s.duration_count) : null,
        }))
        .sort((a, b) => b.call_count - a.call_count);

      autoSummary = {
        total_pipelines: dbPipelines.length,
        completed_pipelines: completedCount,
        failed_pipelines: failedCount,
        active_pipelines: activeCount,
        total_agents: uniqueAgentTypes.size,
        total_agent_calls: totalAgentCalls,
        agent_errors: totalAgentErrors,
        total_duration_ms: totalDurationMs,
        pipelines: pipelinesData,
        top_agents: topAgents,
      };
    }

    return jsonResponse({
      work_unit_slug: wuSlug,
      auto_summary: autoSummary,
    });
  }

  // ── PATCH /api/workunits/:slug/pipelines/:pipelineSlug ────────────
  // NOTE: 더 구체적인 경로이므로 PATCH /api/workunits/:slug 앞에 위치해야 함
  const workunitPipelinePatchMatch = path.match(/^\/api\/workunits\/([^/]+)\/pipelines\/([^/]+)$/);
  if (method === "PATCH" && workunitPipelinePatchMatch) {
    const wuSlug = decodeURIComponent(workunitPipelinePatchMatch[1]);
    const pipelineSlug = decodeURIComponent(workunitPipelinePatchMatch[2]);

    let body: { status?: "completed" | "failed" | "paused" };
    try {
      body = await req.json() as { status?: "completed" | "failed" | "paused" };
    } catch {
      return errorResponse("Invalid JSON body");
    }
    if (!body.status || !["completed", "failed", "paused"].includes(body.status)) {
      return errorResponse("status must be 'completed', 'failed', or 'paused'");
    }

    const now = new Date().toISOString();
    const db = getDefaultDB();

    // DB에서 파이프라인 존재 확인
    const pipeline = db.getPipelineBySlug(pipelineSlug);
    if (!pipeline) {
      return errorResponse(`Pipeline not found: ${pipelineSlug}`, 404);
    }

    // DB: pipeline 상태 업데이트
    db.updatePipelineStatus(pipelineSlug, body.status, now, undefined);

    // DB: pipeline_end 이벤트 기록 (forced: true)
    db.insertPipelineEvent({
      pipeline_slug: pipelineSlug,
      event_type: "pipeline_end",
      status: body.status,
      ts: now,
      payload: {
        work_unit_slug: wuSlug,
        forced: true,
      },
    });

    pushSseEvent(pipelineSlug, "pipeline_end", {
      slug: pipelineSlug,
      work_unit_slug: wuSlug,
      status: body.status,
      forced: true,
    });

    return jsonResponse({ ok: true });
  }

  // ── PATCH /api/workunits/:slug ──────────────────────────────────
  const workunitPatchMatch = path.match(/^\/api\/workunits\/([^/]+)$/);
  if (method === "PATCH" && workunitPatchMatch) {
    const wuSlug = decodeURIComponent(workunitPatchMatch[1]);
    let body: { status?: "completed" | "abandoned" };
    try {
      body = await req.json() as { status?: "completed" | "abandoned" };
    } catch {
      return errorResponse("Invalid JSON body");
    }
    if (!body.status || !["completed", "abandoned"].includes(body.status)) {
      return errorResponse("status must be 'completed' or 'abandoned'");
    }

    const taskDb = getDefaultDB();

    // status='completed' 시 활성 파이프라인 존재 여부 확인 (DB 기반)
    if (body.status === "completed") {
      const dbPipelines = taskDb.getWorkUnitPipelines(wuSlug);
      const activePipelines = dbPipelines
        .filter((p) => p.status === "active" || p.status === "running")
        .map((p) => p.slug);
      if (activePipelines.length > 0) {
        return errorResponse("active_pipelines_exist", 400);
      }
    }

    const wuDb = getDefaultWorkUnitDB();
    const now = new Date().toISOString();
    wuDb.endWorkUnit(wuSlug, body.status, now);

    // DB: work_unit_end 이벤트 기록
    taskDb.insertWorkUnitEvent({
      work_unit_slug: wuSlug,
      event_type: "work_unit_end",
      payload: { status: body.status },
      ts: now,
    });

    pushSseEvent("system", "work_unit_end", { slug: wuSlug, status: body.status });
    return jsonResponse({ ok: true });
  }

  // ── DELETE /api/workunits/:slug ─────────────────────────────────
  const workunitDeleteMatch = path.match(/^\/api\/workunits\/([^/]+)$/);
  if (method === "DELETE" && workunitDeleteMatch) {
    const wuSlug = decodeURIComponent(workunitDeleteMatch[1]);

    // WU 존재 확인 (DB 기반)
    const wuDb = getDefaultWorkUnitDB();
    const wuFromDb = wuDb.getWorkUnit(wuSlug);
    if (!wuFromDb) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }
    wuDb.deleteWorkUnit(wuSlug);

    // orphan pipeline 처리: WU 삭제 시 연결된 pipeline의 work_unit_id를 null로 초기화
    const taskDb = getDefaultDB();
    try {
      taskDb.unlinkPipelinesFromWorkUnit(wuSlug);
    } catch (orphanErr) {
      console.warn("[bams-server] orphan pipeline cleanup failed (non-fatal):", orphanErr);
    }

    // DB: work_unit_archived 이벤트 기록
    const now = new Date().toISOString();
    taskDb.insertWorkUnitEvent({
      work_unit_slug: wuSlug,
      event_type: "work_unit_archived",
      ts: now,
    });

    pushSseEvent("system", "work_unit_archived", { slug: wuSlug });
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── GET /api/hr/reports ─────────────────────────────────────────
  if (method === "GET" && path === "/api/hr/reports") {
    try {
      const hrDb = getDefaultHrReportDB();
      const reports = hrDb.getHrReports();
      return jsonResponse({ reports });
    } catch (err) {
      return errorResponse(`Failed to get HR reports: ${err}`, 500);
    }
  }

  // ── GET /api/hr/reports/:id ─────────────────────────────────────
  const hrReportDetailMatch = path.match(/^\/api\/hr\/reports\/([^/]+)$/);
  if (method === "GET" && hrReportDetailMatch) {
    const reportId = hrReportDetailMatch[1];
    try {
      const hrDb = getDefaultHrReportDB();
      const report = hrDb.getHrReportBySlug(reportId);
      if (!report) {
        return errorResponse(`HR report not found: ${reportId}`, 404);
      }
      return jsonResponse(report);
    } catch (err) {
      return errorResponse(`Failed to get HR report: ${err}`, 500);
    }
  }

  // ── GET /api/events/raw/:slug ──────────────────────────────────
  // Raw pipeline events for a specific slug (DB → JSONL-compatible array)
  const eventsRawSlugMatch = path.match(/^\/api\/events\/raw\/([^/]+)$/);
  if (method === "GET" && eventsRawSlugMatch && eventsRawSlugMatch[1] !== "all") {
    const slug = decodeURIComponent(eventsRawSlugMatch[1]);
    const db = getDefaultDB();
    const dbEvents = db.getPipelineEvents(slug);
    const events = dbEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: slug,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      department: e.department,
      model: e.model,
      step_number: e.step_number,
      step_name: e.step_name,
      phase: e.phase,
      status: e.status,
      duration_ms: e.duration_ms,
      description: e.description,
      result_summary: e.result_summary,
      message: e.message,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));
    return jsonResponse(events);
  }

  // ── GET /api/events/raw/all ──────────────────────────────────
  // All raw pipeline events across all pipelines (DB-based)
  if (method === "GET" && path === "/api/events/raw/all") {
    const db = getDefaultDB();
    const dbEvents = db.getAllPipelineEvents();
    const events = dbEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: e.pipeline_slug ?? null,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      department: e.department,
      model: e.model,
      step_number: e.step_number,
      step_name: e.step_name,
      phase: e.phase,
      status: e.status,
      duration_ms: e.duration_ms,
      description: e.description,
      result_summary: e.result_summary,
      message: e.message,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));
    return jsonResponse(events);
  }

  // ── GET /api/events/poll?since= ──────────────────────────────
  // Polling endpoint: events since a given ISO timestamp
  if (method === "GET" && path === "/api/events/poll") {
    const since = url.searchParams.get("since");
    if (!since) {
      return errorResponse("Missing required query parameter: since (ISO timestamp)");
    }
    const pipelineFilter = url.searchParams.get("pipeline") ?? undefined;
    const db = getDefaultDB();
    const allEvents = db.getAllPipelineEvents(since);
    let events = allEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: e.pipeline_slug ?? null,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      status: e.status,
      duration_ms: e.duration_ms,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));
    if (pipelineFilter) {
      events = events.filter((e) => e.pipeline_slug === pipelineFilter);
    }
    return jsonResponse({ events, serverTime: new Date().toISOString() });
  }

  // ── GET /api/agents/data ─────────────────────────────────────
  // Agent event data (DB-based, replaces JSONL agent file parsing)
  // Query params: date=YYYY-MM-DD, pipeline=slug, work_unit=slug
  if (method === "GET" && path === "/api/agents/data") {
    const date = url.searchParams.get("date") ?? undefined;
    const pipelineFilter = url.searchParams.get("pipeline") ?? undefined;
    const workUnitFilter = url.searchParams.get("work_unit") ?? undefined;
    const db = getDefaultDB();

    let agentEvents: Array<PipelineEvent & { pipeline_slug?: string }>;

    if (workUnitFilter) {
      // WU-scoped agent events
      const wuEvents = db.getPipelineEventsByWorkUnit(workUnitFilter);
      agentEvents = wuEvents
        .filter((e) => e.event_type === "agent_start" || e.event_type === "agent_end")
        .map((e) => ({
          type: e.event_type,
          pipeline_slug: e.pipeline_slug,
          ts: e.ts,
          call_id: e.call_id,
          agent_type: e.agent_type,
          department: e.department,
          model: e.model,
          status: e.status,
          duration_ms: e.duration_ms,
          description: e.description,
          result_summary: e.result_summary,
          is_error: e.is_error ? true : false,
          ...(e.payload ? JSON.parse(e.payload) : {}),
        })) as Array<PipelineEvent & { pipeline_slug?: string }>;
    } else {
      const rawEvents = db.getAgentEvents(
        date && date !== "all" ? date : undefined,
        pipelineFilter ?? undefined
      );
      agentEvents = rawEvents.map((e) => ({
        type: e.event_type,
        pipeline_slug: (e as unknown as { pipeline_slug?: string }).pipeline_slug ?? undefined,
        ts: e.ts,
        call_id: e.call_id,
        agent_type: e.agent_type,
        department: e.department,
        model: e.model,
        status: e.status,
        duration_ms: e.duration_ms,
        description: e.description,
        result_summary: e.result_summary,
        is_error: e.is_error ? true : false,
        ...(e.payload ? JSON.parse(e.payload) : {}),
      })) as Array<PipelineEvent & { pipeline_slug?: string }>;
    }

    // Build agent calls from paired start/end events
    const startMap = new Map<string, Record<string, unknown>>();
    const calls: Record<string, unknown>[] = [];

    for (const e of agentEvents) {
      const callId = (e as Record<string, unknown>).call_id as string | undefined;
      if (!callId) continue;

      if (e.type === "agent_start") {
        startMap.set(callId, {
          callId,
          agentType: (e as Record<string, unknown>).agent_type ?? "unknown",
          department: (e as Record<string, unknown>).department ?? "unknown",
          model: (e as Record<string, unknown>).model ?? null,
          pipelineSlug: (e as Record<string, unknown>).pipeline_slug ?? null,
          description: (e as Record<string, unknown>).description ?? null,
          startedAt: e.ts,
          endedAt: null,
          durationMs: null,
          isError: false,
          status: "running",
          resultSummary: null,
        });
      } else if (e.type === "agent_end") {
        const start = startMap.get(callId);
        if (start) {
          start.endedAt = e.ts;
          start.durationMs = (e as Record<string, unknown>).duration_ms ?? null;
          start.isError = !!(e as Record<string, unknown>).is_error;
          start.status = (e as Record<string, unknown>).status ?? "success";
          start.resultSummary = (e as Record<string, unknown>).result_summary ?? null;
          calls.push(start);
          startMap.delete(callId);
        } else {
          // orphan agent_end
          calls.push({
            callId,
            agentType: (e as Record<string, unknown>).agent_type ?? "unknown",
            department: (e as Record<string, unknown>).department ?? "unknown",
            model: (e as Record<string, unknown>).model ?? null,
            pipelineSlug: (e as Record<string, unknown>).pipeline_slug ?? null,
            description: null,
            startedAt: null,
            endedAt: e.ts,
            durationMs: (e as Record<string, unknown>).duration_ms ?? null,
            isError: !!(e as Record<string, unknown>).is_error,
            status: (e as Record<string, unknown>).status ?? "success",
            resultSummary: (e as Record<string, unknown>).result_summary ?? null,
          });
        }
      }
    }
    // Running agents (started but not ended)
    for (const start of startMap.values()) {
      calls.push(start);
    }

    // Build stats
    const statsByType: Record<string, { agentType: string; dept: string; callCount: number; errorCount: number; totalDurationMs: number; minDurationMs: number; maxDurationMs: number; errorRate: number; models: Record<string, number> }> = {};
    for (const call of calls) {
      const c = call as { agentType: string; department: string; isError: boolean; durationMs: number | null; model: string | null };
      if (!statsByType[c.agentType]) {
        statsByType[c.agentType] = {
          agentType: c.agentType,
          dept: c.department || "unknown",
          callCount: 0, errorCount: 0, totalDurationMs: 0,
          minDurationMs: Infinity, maxDurationMs: 0, errorRate: 0, models: {},
        };
      }
      const s = statsByType[c.agentType];
      s.callCount++;
      if (c.isError) s.errorCount++;
      if (c.durationMs != null && !c.isError) {
        s.totalDurationMs += c.durationMs;
        s.minDurationMs = Math.min(s.minDurationMs, c.durationMs);
        s.maxDurationMs = Math.max(s.maxDurationMs, c.durationMs);
      }
      if (c.model) {
        s.models[c.model] = (s.models[c.model] || 0) + 1;
      }
    }

    const stats = Object.values(statsByType).map((s) => {
      const completed = s.callCount - s.errorCount;
      return {
        ...s,
        avgDurationMs: completed > 0 ? Math.round(s.totalDurationMs / completed) : 0,
        minDurationMs: s.minDurationMs === Infinity ? 0 : s.minDurationMs,
        errorRate: s.callCount > 0 ? Math.round((s.errorCount / s.callCount) * 100) : 0,
      };
    }).sort((a, b) => b.callCount - a.callCount);

    // Build collaborations (from/to pairs in same pipeline)
    const pipelineAgents = new Map<string, Set<string>>();
    for (const call of calls) {
      const c = call as { agentType: string; pipelineSlug: string | null };
      if (!c.pipelineSlug) continue;
      if (!pipelineAgents.has(c.pipelineSlug)) pipelineAgents.set(c.pipelineSlug, new Set());
      pipelineAgents.get(c.pipelineSlug)!.add(c.agentType);
    }
    const collabPairs = new Map<string, { from: string; to: string; count: number }>();
    for (const agents of pipelineAgents.values()) {
      const arr = Array.from(agents);
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const key = [arr[i], arr[j]].sort().join("|");
          const existing = collabPairs.get(key);
          if (existing) { existing.count++; }
          else { collabPairs.set(key, { from: arr[i], to: arr[j], count: 1 }); }
        }
      }
    }
    const collaborations = Array.from(collabPairs.values());

    const runningCount = calls.filter((c) => (c as { endedAt: unknown }).endedAt === null).length;
    const totalErrors = calls.filter((c) => (c as { isError: boolean }).isError).length;

    return jsonResponse({
      calls,
      stats,
      collaborations,
      totalCalls: calls.length,
      totalErrors,
      runningCount,
    });
  }

  // ── GET /api/agents/dates ────────────────────────────────────
  // Agent event dates (DB-based)
  if (method === "GET" && path === "/api/agents/dates") {
    const db = getDefaultDB();
    const dates = db.getAgentEventDates();
    return jsonResponse(dates);
  }

  // ── GET /api/mermaid/:slug ───────────────────────────────────
  // @deprecated 2026-04-09 — Dead code. Next.js viz DAG 탭은 /api/events/raw/:slug를
  // 호출하여 로컬에서 parseEvents() + generateFlowchart() 수행.
  // 이 엔드포인트를 호출하는 클라이언트 없음. 향후 활용 가능성 위해 삭제하지 않고 보존.
  // Mermaid flowchart + gantt for a pipeline (from DB events)
  const mermaidMatch = path.match(/^\/api\/mermaid\/([^/]+)$/);
  if (method === "GET" && mermaidMatch) {
    const slug = decodeURIComponent(mermaidMatch[1]);
    const db = getDefaultDB();
    const pipeline = db.getPipelineBySlug(slug);
    if (!pipeline) {
      return errorResponse(`Pipeline not found: ${slug}`, 404);
    }
    // Return raw events; viz can compute mermaid locally using its parser
    const dbEvents = db.getPipelineEvents(slug);
    const events = dbEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: slug,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      department: e.department,
      model: e.model,
      step_number: e.step_number,
      step_name: e.step_name,
      phase: e.phase,
      status: e.status,
      duration_ms: e.duration_ms,
      description: e.description,
      result_summary: e.result_summary,
      message: e.message,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));
    return jsonResponse({ slug, events });
  }

  // ── GET /api/traces ──────────────────────────────────────────
  // Trace data (from DB events — viz can compute traces locally)
  if (method === "GET" && path === "/api/traces") {
    const pipelineFilter = url.searchParams.get("pipeline") ?? undefined;
    const db = getDefaultDB();
    let dbEvents: Array<{ event_type: string; pipeline_slug?: string | null; ts?: string | null; call_id?: string | null; agent_type?: string | null; department?: string | null; model?: string | null; step_number?: number | null; step_name?: string | null; phase?: string | null; status?: string | null; duration_ms?: number | null; description?: string | null; result_summary?: string | null; message?: string | null; is_error?: number | null; payload?: string | null }>;

    if (pipelineFilter) {
      dbEvents = db.getPipelineEvents(pipelineFilter);
    } else {
      dbEvents = db.getAllPipelineEvents();
    }

    const events = dbEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: (e as Record<string, unknown>).pipeline_slug ?? pipelineFilter ?? null,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      department: e.department,
      model: e.model,
      step_number: e.step_number,
      step_name: e.step_name,
      phase: e.phase,
      status: e.status,
      duration_ms: e.duration_ms,
      description: e.description,
      result_summary: e.result_summary,
      message: e.message,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));

    return jsonResponse({ events });
  }

  // ── GET /api/traces/:traceId ─────────────────────────────────
  // Single trace lookup (returns all events; viz computes trace locally)
  const traceDetailMatch = path.match(/^\/api\/traces\/([^/]+)$/);
  if (method === "GET" && traceDetailMatch) {
    const traceId = decodeURIComponent(traceDetailMatch[1]);
    // traceId is typically a pipeline_slug — return its events
    const db = getDefaultDB();
    const dbEvents = db.getPipelineEvents(traceId);
    const events = dbEvents.map((e) => ({
      type: e.event_type,
      pipeline_slug: traceId,
      ts: e.ts,
      call_id: e.call_id,
      agent_type: e.agent_type,
      department: e.department,
      model: e.model,
      step_number: e.step_number,
      step_name: e.step_name,
      phase: e.phase,
      status: e.status,
      duration_ms: e.duration_ms,
      description: e.description,
      result_summary: e.result_summary,
      message: e.message,
      is_error: e.is_error ? true : false,
      ...(e.payload ? JSON.parse(e.payload) : {}),
    }));
    return jsonResponse({ traceId, events });
  }

  // ── GET /api/stats/agents ────────────────────────────────────
  // Agent statistics (DB-based)
  if (method === "GET" && path === "/api/stats/agents") {
    const db = getDefaultDB();
    const allEvents = db.getAllPipelineEvents();
    const agentEndEvents = allEvents.filter((e) => e.event_type === "agent_end");

    const statsMap = new Map<string, { count: number; errorCount: number; totalDurationMs: number; durationCount: number }>();
    for (const e of agentEndEvents) {
      const agentType = e.agent_type ?? "unknown";
      const existing = statsMap.get(agentType) ?? { count: 0, errorCount: 0, totalDurationMs: 0, durationCount: 0 };
      existing.count++;
      if (e.is_error) existing.errorCount++;
      if (e.duration_ms != null) {
        existing.totalDurationMs += e.duration_ms;
        existing.durationCount++;
      }
      statsMap.set(agentType, existing);
    }

    const byAgentType = Array.from(statsMap.entries())
      .map(([agentType, s]) => ({
        agentType,
        count: s.count,
        avgDurationMs: s.durationCount > 0 ? Math.round(s.totalDurationMs / s.durationCount) : 0,
        errorRate: s.count > 0 ? s.errorCount / s.count : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return jsonResponse({ byAgentType });
  }

  // ── Health Check ─────────────────────────────────────────────
  if (method === "GET" && path === "/health") {
    return jsonResponse({ ok: true, version: "1.0.0", port: PORT });
  }

  // ── GET /api/runs/:pipeline/logs ──────────────────────────────
  const runsLogsMatch = path.match(/^\/api\/runs\/([^/]+)\/logs$/);
  if (method === "GET" && runsLogsMatch) {
    const pipelineSlug = runsLogsMatch[1];
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const broker = getBroker();
    const logs = broker.getRecentLogs(pipelineSlug, limit);
    return jsonResponse({ pipeline_slug: pipelineSlug, logs, count: logs.length });
  }

  // ── GET /api/runs/agent/:slug/logs ─────────────────────────────
  const agentLogsMatch = path.match(/^\/api\/runs\/agent\/([^/]+)\/logs$/);
  if (method === "GET" && agentLogsMatch) {
    const agentSlug = agentLogsMatch[1];
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const broker = getBroker();
    const logs = broker.getAgentLogs(agentSlug, limit);
    return jsonResponse({ agent_slug: agentSlug, logs, count: logs.length });
  }

  // ── POST /api/events ────────────────────────────────────────────
  // 범용 이벤트 수신 엔드포인트: emit.sh가 JSONL append 직후 호출
  // 모든 이벤트 타입을 수신하여 DB에 기록 (pipeline_events, work_unit_events, tasks 등)
  if (method === "POST" && path === "/api/events") {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return errorResponse("Invalid JSON body");
    }

    const eventType = body.type as string | undefined;
    if (!eventType) {
      return errorResponse("type field is required");
    }

    try {
      const db = getDefaultDB();
      const wuDb = getDefaultWorkUnitDB();
      const pipelineSlug = (body.pipeline_slug as string) ?? "";
      const ts = (body.ts as string) ?? new Date().toISOString();
      let eventId: string | undefined;

      switch (eventType) {
        // ── pipeline_start ──────────────────────────────────────────
        case "pipeline_start": {
          const pType = (body.pipeline_type as string) ?? "unknown";
          const command = (body.command as string) ?? undefined;
          const args = (body.arguments as string) ?? undefined;
          const wuSlug = (body.work_unit_slug as string) ?? "";

          // 1. pipeline upsert (FK 해석을 위해 먼저 생성)
          db.upsertPipeline({
            slug: pipelineSlug,
            type: pType,
            command,
            arguments: args,
            status: "running",
            started_at: ts,
          });

          // 2. pipeline_events 기록
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "pipeline_start",
            status: "running",
            ts,
            payload: body,
          });

          // 3. work unit 연결
          if (wuSlug) {
            db.upsertWorkUnit(wuSlug);
            db.linkPipelineToWorkUnit(pipelineSlug, wuSlug);
            db.insertWorkUnitEvent({
              work_unit_slug: wuSlug,
              event_type: "pipeline_linked",
              pipeline_slug: pipelineSlug,
              payload: { pipeline_type: pType },
              ts,
            });
          }

          // SSE push
          pushSseEvent(pipelineSlug, "pipeline_start", body);
          break;
        }

        // ── pipeline_end ────────────────────────────────────────────
        case "pipeline_end": {
          const status = (body.status as string) ?? "completed";
          const durationMs = (body.duration_ms as number) ?? undefined;

          db.updatePipelineStatus(pipelineSlug, status, ts, durationMs);
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "pipeline_end",
            status,
            duration_ms: durationMs,
            ts,
            payload: body,
          });

          pushSseEvent(pipelineSlug, "pipeline_end", body);
          break;
        }

        // ── step_start ──────────────────────────────────────────────
        case "step_start": {
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "step_start",
            step_number: (body.step_number as number) ?? undefined,
            step_name: (body.step_name as string) ?? undefined,
            phase: (body.phase as string) ?? undefined,
            ts,
          });

          // run_logs 기록 — Logs 탭에서 step 흐름 표시
          if (pipelineSlug) {
            try {
              db.insertRunLog({
                pipeline_slug: pipelineSlug,
                agent_slug: "pipeline",
                event_type: "step_start",
                payload: body,
              });
            } catch (runLogErr) {
              console.error("[bams-server] step_start run_log insert failed (non-fatal):", runLogErr);
            }
          }

          pushSseEvent(pipelineSlug, "step_start", body);
          break;
        }

        // ── step_end ────────────────────────────────────────────────
        case "step_end": {
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "step_end",
            step_number: (body.step_number as number) ?? undefined,
            status: (body.status as string) ?? "done",
            duration_ms: (body.duration_ms as number) ?? undefined,
            ts,
          });

          // run_logs 기록 — Logs 탭에서 step 흐름 표시
          if (pipelineSlug) {
            try {
              db.insertRunLog({
                pipeline_slug: pipelineSlug,
                agent_slug: "pipeline",
                event_type: "step_end",
                payload: body,
              });
            } catch (runLogErr) {
              console.error("[bams-server] step_end run_log insert failed (non-fatal):", runLogErr);
            }
          }

          pushSseEvent(pipelineSlug, "step_end", body);
          break;
        }

        // ── agent_start ─────────────────────────────────────────────
        case "agent_start": {
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "agent_start",
            call_id: (body.call_id as string) ?? undefined,
            agent_type: (body.agent_type as string) ?? undefined,
            department: (body.department as string) ?? undefined,
            model: (body.model as string) ?? undefined,
            step_number: (body.step_number as number) ?? undefined,
            description: (body.description as string) ?? undefined,
            ts,
          });

          // run_logs 기록 — Logs 탭 데이터 소스
          if (pipelineSlug) {
            try {
              db.insertRunLog({
                pipeline_slug: pipelineSlug,
                run_id: (body.call_id as string) ?? undefined,
                agent_slug: (body.agent_type as string) ?? "unknown",
                event_type: "agent_start",
                payload: body,
              });
            } catch (runLogErr) {
              console.error("[bams-server] agent_start run_log insert failed (non-fatal):", runLogErr);
            }
          }

          pushSseEvent(pipelineSlug, "agent_start", body);
          break;
        }

        // ── agent_end ───────────────────────────────────────────────
        case "agent_end": {
          const agentType = (body.agent_type as string) ?? "unknown";
          const callId = (body.call_id as string) ?? "";
          const resultSummary = (body.result_summary as string) ?? "";
          const durationMs = (body.duration_ms as number) ?? undefined;
          const isError = body.is_error === true || body.is_error === "true";
          const agentStatus = (body.status as string) ?? "success";

          // pipeline_events 기록
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "agent_end",
            call_id: callId || undefined,
            agent_type: agentType,
            status: agentStatus,
            duration_ms: durationMs,
            result_summary: resultSummary || undefined,
            is_error: isError,
            ts,
          });

          // run_logs 기록 — Logs 탭 데이터 소스
          if (pipelineSlug) {
            try {
              db.insertRunLog({
                pipeline_slug: pipelineSlug,
                run_id: callId || undefined,
                agent_slug: agentType,
                event_type: "agent_end",
                payload: body,
              });
            } catch (runLogErr) {
              console.error("[bams-server] agent_end run_log insert failed (non-fatal):", runLogErr);
            }
          }

          // tasks 테이블 기록 (기존 POST /api/runs/events 로직 통합)
          if (pipelineSlug) {
            try {
              const pipeline = db.getPipelineBySlug(pipelineSlug);
              if (pipeline) {
                const taskTitle = `[${agentType}] ${resultSummary.slice(0, 120) || "작업 완료"}`;
                const taskDesc = resultSummary || `Agent: ${agentType}, Call ID: ${callId}`;
                db.createTask({
                  pipeline_id: pipeline.id,
                  title: taskTitle,
                  description: taskDesc,
                  assignee_agent: agentType,
                  label: callId || undefined,
                  duration_ms: durationMs ?? undefined,
                  summary: resultSummary || undefined,
                  tags: [agentType, isError ? "error" : agentStatus],
                });
              }
            } catch (taskErr) {
              console.error("[bams-server] agent_end task logging failed (non-fatal):", taskErr);
            }
          }

          pushSseEvent(pipelineSlug, "agent_end", body);
          break;
        }

        // ── error ───────────────────────────────────────────────────
        case "error": {
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "error",
            message: (body.message as string) ?? undefined,
            step_number: (body.step_number as number) ?? undefined,
            ts,
            payload: body,
          });
          pushSseEvent(pipelineSlug, "error", body);
          break;
        }

        // ── work_unit_start ─────────────────────────────────────────
        case "work_unit_start": {
          const wuSlug = (body.work_unit_slug as string) ?? pipelineSlug;
          const wuName = (body.work_unit_name as string) ?? (body.name as string) ?? wuSlug;
          wuDb.createWorkUnit(wuSlug, wuName, ts);
          eventId = db.insertWorkUnitEvent({
            work_unit_slug: wuSlug,
            event_type: "work_unit_start",
            payload: body,
            ts,
          });
          break;
        }

        // ── work_unit_end ───────────────────────────────────────────
        case "work_unit_end": {
          const wuSlug = (body.work_unit_slug as string) ?? pipelineSlug;
          const wuStatus = (body.status as string) ?? "completed";
          wuDb.endWorkUnit(wuSlug, wuStatus, ts);
          eventId = db.insertWorkUnitEvent({
            work_unit_slug: wuSlug,
            event_type: "work_unit_end",
            payload: { status: wuStatus },
            ts,
          });
          break;
        }

        // ── pipeline_linked ─────────────────────────────────────────
        case "pipeline_linked": {
          const wuSlug = (body.work_unit_slug as string) ?? "";
          if (wuSlug && pipelineSlug) {
            db.upsertWorkUnit(wuSlug);
            db.linkPipelineToWorkUnit(pipelineSlug, wuSlug);
            eventId = db.insertWorkUnitEvent({
              work_unit_slug: wuSlug,
              event_type: "pipeline_linked",
              pipeline_slug: pipelineSlug,
              payload: body,
              ts,
            });
          }
          break;
        }

        // ── recover ─────────────────────────────────────────────────
        case "recover": {
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: "recover",
            ts,
            payload: body,
          });
          break;
        }

        // ── unknown event type — still record it ────────────────────
        default: {
          eventId = db.insertPipelineEvent({
            pipeline_slug: pipelineSlug,
            event_type: eventType,
            ts,
            payload: body,
          });
          break;
        }
      }

      return jsonResponse({ ok: true, id: eventId ?? null });
    } catch (err) {
      console.error("[bams-server] POST /api/events error:", err);
      return jsonResponse({ ok: false, error: String(err) }, 500);
    }
  }

  // 404
  return errorResponse(`Not found: ${method} ${path}`, 404);
}

// ─────────────────────────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────────────────────────

// DB is the primary data source — JSONL legacy sync and helpers removed
console.log("[bams-server] DB is primary data source");

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
  error(err) {
    console.error("[bams-server] Unhandled error:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`[bams-server] Control Plane running on http://localhost:${PORT}`);
console.log(`[bams-server] CORS allowed: * (dev mode)`);

export { server };
