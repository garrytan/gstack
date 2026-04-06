/**
 * bams-plugin/server/src/app.ts
 *
 * Control Plane 서버 — Bun HTTP 서버 (포트 3099)
 *
 * Paperclip의 서버 패턴을 bams-plugin에 적용:
 * - Bun.serve() 기반 (Express 의존성 없음)
 * - REST API + SSE 스트리밍
 * - SQLite TaskDB 직접 연동 (FK 기반)
 * - CORS: * (개발 환경, 모든 origin 허용)
 *
 * 엔드포인트:
 *   GET  /api/pipelines                   — 파이프라인 목록 (DB 우선, JSONL fallback)
 *   GET  /api/pipelines/:slug             — 파이프라인 상세 (DB 우선)
 *   GET  /api/pipelines/:slug/tasks       — 파이프라인 하위 task 조회 (신규)
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
 *   GET  /api/hr/reports                  — HR 보고서 목록
 *   GET  /api/hr/reports/:id              — HR 보고서 상세
 */

import { readFileSync, existsSync, readdirSync, appendFileSync } from "fs";
import { join } from "path";
import { getDefaultDB, getDefaultWorkUnitDB, getDefaultHrReportDB } from "../../tools/bams-db/index.ts";
import { getBroker } from "./sse-broker.ts";
import type { TaskStatus } from "../../tools/bams-db/schema.ts";

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BAMS_SERVER_PORT ?? "3099", 10);
// 글로벌 bams 루트: BAMS_ROOT 환경변수 → $HOME/.bams (emit.sh, event-store.ts와 동일 로직)
const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? "";
const GLOBAL_ROOT = process.env.BAMS_ROOT ?? (HOME_DIR ? `${HOME_DIR}/.bams` : ".crew");
const PIPELINE_EVENTS_DIR = `${GLOBAL_ROOT}/artifacts/pipeline`;
const AGENTS_DIR = "plugins/bams-plugin/agents";

/** SSE 이벤트 push — SseBroker 경유 (DB 영구 보존 + 스트리밍) */
export function pushSseEvent(
  pipelineSlug: string,
  eventType: string,
  data: unknown & { agent_slug?: string; run_id?: string }
): void {
  const broker = getBroker();
  broker.pushEvent({
    type: eventType as import("./sse-broker.ts").SseEventType,
    pipeline_slug: pipelineSlug,
    agent_slug: (data as { agent_slug?: string }).agent_slug ?? "system",
    run_id: (data as { run_id?: string }).run_id,
    ts: new Date().toISOString(),
    payload: data,
  });
}

// ─────────────────────────────────────────────────────────────
// CORS 헤더
// ─────────────────────────────────────────────────────────────

function corsHeaders(): HeadersInit {
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
// 파이프라인 이벤트 파일 파싱
// ─────────────────────────────────────────────────────────────

interface PipelineEvent {
  type: string;
  pipeline_slug?: string;
  ts?: string;
  [key: string]: unknown;
}

function parsePipelineEvents(slug: string): PipelineEvent[] {
  const filePath = join(PIPELINE_EVENTS_DIR, `${slug}-events.jsonl`);
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PipelineEvent);
  } catch {
    return [];
  }
}

function getPipelineSlugs(): string[] {
  if (!existsSync(PIPELINE_EVENTS_DIR)) return [];
  try {
    return readdirSync(PIPELINE_EVENTS_DIR)
      .filter((f) => f.endsWith("-events.jsonl"))
      .map((f) => f.replace("-events.jsonl", ""));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Work Unit 이벤트 파일 파싱
// ─────────────────────────────────────────────────────────────

interface WorkUnitEvent {
  type: string;
  work_unit_slug?: string;
  name?: string;
  ts?: string;
  [key: string]: unknown;
}

function parseWorkUnitEvents(slug: string): WorkUnitEvent[] {
  const file = join(PIPELINE_EVENTS_DIR, `${slug}-workunit.jsonl`);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkUnitEvent);
  } catch {
    return [];
  }
}

function getWorkUnitSlugs(): string[] {
  if (!existsSync(PIPELINE_EVENTS_DIR)) return [];
  try {
    return readdirSync(PIPELINE_EVENTS_DIR)
      .filter((f) => f.endsWith("-workunit.jsonl"))
      .map((f) => f.replace("-workunit.jsonl", ""));
  } catch {
    return [];
  }
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
// 이벤트 → DB 동기화 (e5f6a7b8)
// ─────────────────────────────────────────────────────────────

/**
 * JSONL 이벤트 파일에서 DB에 없는 파이프라인을 자동으로 sync한다.
 * 서버 시작 시 1회 호출.
 */
function syncPipelinesFromEvents(): void {
  const db = getDefaultDB();
  const wuDb = getDefaultWorkUnitDB();

  // Phase 1: WorkUnit sync (Pipeline보다 먼저 — FK 의존성)
  const wuSlugs = getWorkUnitSlugs();
  for (const wuSlug of wuSlugs) {
    const existing = wuDb.getWorkUnit(wuSlug);
    if (existing) continue; // 이미 DB에 있으면 스킵

    const wuEvents = parseWorkUnitEvents(wuSlug);
    const startEvt = wuEvents.find((e) => e.type === "work_unit_start");
    if (!startEvt) continue;

    wuDb.createWorkUnit(
      wuSlug,
      (startEvt.name as string) ?? (startEvt.work_unit_name as string) ?? wuSlug,
      (startEvt.ts as string) ?? new Date().toISOString()
    );

    const endEvt = wuEvents.find((e) => e.type === "work_unit_end");
    if (endEvt) {
      wuDb.endWorkUnit(
        wuSlug,
        (endEvt.status as string) ?? "completed",
        (endEvt.ts as string) ?? new Date().toISOString()
      );
    }
  }

  // Phase 2: Pipeline sync
  const slugs = getPipelineSlugs();

  for (const slug of slugs) {
    const events = parsePipelineEvents(slug);
    const startEvt = events.find((e) => e.type === "pipeline_start");
    if (!startEvt) continue;

    // work_unit_id 매칭
    let workUnitId: string | undefined = undefined;
    if (startEvt.work_unit_slug) {
      const wu = wuDb.getWorkUnit(startEvt.work_unit_slug as string);
      workUnitId = wu?.id ?? undefined;
    }

    // upsertPipeline은 slug UNIQUE로 idempotent — 기존 레코드의 work_unit_id도 업데이트
    db.upsertPipeline({
      slug,
      type: (startEvt.pipeline_type as string) ?? "unknown",
      command: (startEvt.command as string) ?? undefined,
      arguments: (startEvt.arguments as string) ?? undefined,
      started_at: (startEvt.ts as string) ?? undefined,
      work_unit_id: workUnitId,
    });

    // pipeline_end 이벤트가 있으면 상태 업데이트
    const endEvt = events.find((e) => e.type === "pipeline_end");
    if (endEvt) {
      db.updatePipelineStatus(
        slug,
        (endEvt.status as string) ?? "completed",
        (endEvt.ts as string) ?? null,
        (endEvt.duration_ms as number) ?? null
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 라우터
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

    // DB 기반 결과
    const pipelines = dbPipelines.map((p) => {
      const summary = db.getPipelineSummary(p.id);
      return {
        slug: p.slug,
        pipeline_type: p.type ?? "unknown",
        started_at: p.started_at ?? null,
        last_event_at: p.updated_at ?? p.started_at ?? null,
        work_unit_slug: null as string | null, // 아래에서 보충
        status: p.status ?? "active",
        task_summary: summary,
      };
    });

    // work_unit_slug 보충 (DB FK → work_units 테이블 조회)
    // M-05: getWorkUnits()를 루프 밖에서 1회만 호출하여 N+1 쿼리 방지
    const wuDb = getDefaultWorkUnitDB();
    const allWorkUnits = wuDb.getWorkUnits();
    const wuById = new Map(allWorkUnits.map((wu) => [wu.id, wu]));
    for (const p of pipelines) {
      const dbRow = dbMap.get(p.slug);
      if (dbRow?.work_unit_id) {
        const wu = wuById.get(dbRow.work_unit_id);
        p.work_unit_slug = wu?.slug ?? null;
      }
    }

    // JSONL fallback: DB에 없는 파이프라인만 보충
    const jsonlSlugs = getPipelineSlugs();
    for (const slug of jsonlSlugs) {
      if (dbMap.has(slug)) continue; // 이미 DB에 있음
      const events = parsePipelineEvents(slug);
      const startEvent = events.find((e) => e.type === "pipeline_start");
      const lastEvent = events[events.length - 1];
      pipelines.push({
        slug,
        pipeline_type: (startEvent?.pipeline_type as string) ?? "unknown",
        started_at: startEvent?.ts ?? null,
        last_event_at: lastEvent?.ts ?? null,
        work_unit_slug: (startEvent?.work_unit_slug as string) ?? null,
        status: events.some((e) => e.type === "pipeline_end") ? "completed" : "active",
        task_summary: { total: 0, backlog: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 },
      });
    }

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
      // JSONL fallback 확인
      const events = parsePipelineEvents(slug);
      if (events.length === 0) {
        return errorResponse(`Pipeline not found: ${slug}`, 404);
      }
      return jsonResponse({ pipeline_slug: slug, tasks: [], count: 0 });
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

    if (pipeline) {
      // DB 우선
      const tasks = db.getTasksByPipelineId(pipeline.id);
      const summary = db.getPipelineSummary(pipeline.id);
      const events = parsePipelineEvents(slug); // 이벤트는 여전히 JSONL에서 읽음
      return jsonResponse({ slug, pipeline, events, tasks, summary });
    }

    // JSONL fallback
    const events = parsePipelineEvents(slug);
    if (events.length === 0) {
      return errorResponse(`Pipeline not found: ${slug}`, 404);
    }
    return jsonResponse({ slug, pipeline: null, events, tasks: [], summary: { total: 0, backlog: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 } });
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
      body = await req.json();
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
      pushSseEvent(pipelineSlugForSse, "task_updated", updatedTask);
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
    const slugs = getPipelineSlugs();
    let lastEvent: PipelineEvent | null = null;
    let pipelineSlug: string | null = null;

    for (const ps of slugs) {
      const events = parsePipelineEvents(ps);
      const agentEvents = events.filter(
        (e) =>
          (e.type === "agent_start" || e.type === "agent_end") &&
          (e.agent_type === slug || e.call_id?.toString().includes(slug))
      );
      if (agentEvents.length > 0) {
        lastEvent = agentEvents[agentEvents.length - 1];
        pipelineSlug = ps;
      }
    }

    if (!lastEvent) {
      return jsonResponse({ slug, status: "idle", last_event: null });
    }

    const status =
      lastEvent.type === "agent_start"
        ? "running"
        : lastEvent.is_error
          ? "error"
          : "idle";

    return jsonResponse({
      slug,
      status,
      pipeline_slug: pipelineSlug,
      last_event: lastEvent,
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
    const wuSlugs = getWorkUnitSlugs();
    const db = getDefaultDB();
    const active = wuSlugs
      .map((wuSlug) => {
        const events = parseWorkUnitEvents(wuSlug);
        const startEvent = events.find((e) => e.type === "work_unit_start");
        const endEvent = events.find((e) => e.type === "work_unit_end");
        if (!startEvent || endEvent) return null; // not active
        // Count linked pipelines via DB FK
        const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
        let pipelineCount = dbPipelines.length;
        // JSONL fallback if DB has no records
        if (pipelineCount === 0) {
          const pipelineSlugs = getPipelineSlugs();
          pipelineCount = pipelineSlugs.filter((ps) => {
            const pEvents = parsePipelineEvents(ps);
            const pStart = pEvents.find((e) => e.type === "pipeline_start");
            return pStart?.work_unit_slug === wuSlug;
          }).length;
        }
        return {
          slug: wuSlug,
          name: (startEvent.name as string) ?? wuSlug,
          status: "active" as const,
          startedAt: startEvent.ts ?? null,
          endedAt: null,
          pipelineCount,
        };
      })
      .filter(Boolean);
    return jsonResponse({ workunits: active });
  }

  // ── GET /api/workunits ──────────────────────────────────────
  if (method === "GET" && path === "/api/workunits") {
    const wuSlugs = getWorkUnitSlugs();
    const workunits = wuSlugs.map((wuSlug) => {
      const events = parseWorkUnitEvents(wuSlug);
      const startEvent = events.find((e) => e.type === "work_unit_start");
      const endEvent = events.find((e) => e.type === "work_unit_end");
      // Count linked pipelines via DB FK
      const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
      let linkedCount = dbPipelines.length;
      // JSONL fallback if DB has no records
      if (linkedCount === 0) {
        const pipelineSlugs = getPipelineSlugs();
        linkedCount = pipelineSlugs.filter((ps) => {
          const pEvents = parsePipelineEvents(ps);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          return pStart?.work_unit_slug === wuSlug;
        }).length;
      }
      return {
        slug: wuSlug,
        name: (startEvent?.name as string) ?? wuSlug,
        status: endEvent ? "completed" : startEvent ? "active" : "unknown",
        startedAt: startEvent?.ts ?? null,
        endedAt: endEvent?.ts ?? null,
        pipelineCount: linkedCount,
      };
    });
    return jsonResponse({ workunits });
  }

  // ── GET /api/workunits/:slug ────────────────────────────────
  const workunitDetailMatch = path.match(/^\/api\/workunits\/([^/]+)$/);
  if (method === "GET" && workunitDetailMatch) {
    const wuSlug = decodeURIComponent(workunitDetailMatch[1]);
    const events = parseWorkUnitEvents(wuSlug);
    if (events.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }
    const startEvent = events.find((e) => e.type === "work_unit_start");
    const endEvent = events.find((e) => e.type === "work_unit_end");

    // Find linked pipelines — DB FK 우선, JSONL fallback
    let pipelines: Array<{
      slug: string; type: string; linkedAt: string | null; status: string;
      id: string | null; totalSteps: number; completedSteps: number; failedSteps: number;
      durationMs: number | null; command: string | null; arguments: string | null;
    }> = [];
    try {
      const dbRows = getDefaultDB().getWorkUnitPipelines(wuSlug);
      if (dbRows.length > 0) {
        // DB FK 기반: pipelines.work_unit_id → work_units.id
        pipelines = dbRows.map((row) => {
          const pEvents = parsePipelineEvents(row.slug);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          const pEnd = pEvents.filter((e) => e.type === "pipeline_end").pop();
          return {
            slug: row.slug,
            type: row.type ?? (pStart?.pipeline_type as string) ?? "unknown",
            linkedAt: row.created_at ?? null,
            status: row.status ?? (pEnd ? (pEnd.status as string) : "active"),
            id: row.id ?? null,
            totalSteps: row.total_steps ?? 0,
            completedSteps: row.completed_steps ?? 0,
            failedSteps: row.failed_steps ?? 0,
            durationMs: row.duration_ms ?? null,
            command: row.command ?? null,
            arguments: row.arguments ?? null,
          };
        });
      }
    } catch {
      // DB 조회 실패 시 JSONL fallback으로 진행
    }

    // JSONL fallback: DB 레코드 없으면 기존 방식 사용
    if (pipelines.length === 0) {
      const pipelineSlugs = getPipelineSlugs();
      const fallbackDb = getDefaultDB();
      pipelines = pipelineSlugs
        .map((ps) => {
          const pEvents = parsePipelineEvents(ps);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          if (pStart?.work_unit_slug !== wuSlug) return null;
          const pEnd = pEvents.filter((e) => e.type === "pipeline_end").pop();
          const dbRow = fallbackDb.getPipelineBySlug(ps);
          return {
            slug: ps,
            type: (pStart.pipeline_type as string) ?? "unknown",
            linkedAt: pStart.ts ?? null,
            status: pEnd ? (pEnd.status as string) : "active",
            id: dbRow?.id ?? null,
            totalSteps: dbRow?.total_steps ?? 0,
            completedSteps: dbRow?.completed_steps ?? 0,
            failedSteps: dbRow?.failed_steps ?? 0,
            durationMs: dbRow?.duration_ms ?? null,
            command: dbRow?.command ?? null,
            arguments: dbRow?.arguments ?? null,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
    }

    // Work Unit task_summary 집계 (DB FK 기반)
    const db = getDefaultDB();
    let taskSummary = { total: 0, backlog: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 };
    for (const p of pipelines) {
      const dbPipeline = db.getPipelineBySlug(p.slug);
      if (dbPipeline) {
        const s = db.getPipelineSummary(dbPipeline.id);
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
      name: (startEvent?.name as string) ?? wuSlug,
      status: endEvent ? "completed" : startEvent ? "active" : "unknown",
      startedAt: startEvent?.ts ?? null,
      endedAt: endEvent?.ts ?? null,
      events,
      pipelines,
      task_summary: taskSummary,
    });
  }

  // ── GET /api/workunits/:slug/tasks ─────────────────────────────
  const workunitTasksMatch = path.match(/^\/api\/workunits\/([^/]+)\/tasks$/);
  if (method === "GET" && workunitTasksMatch) {
    const wuSlug = decodeURIComponent(workunitTasksMatch[1]);
    const events = parseWorkUnitEvents(wuSlug);
    if (events.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    const db = getDefaultDB();

    // DB FK 기반: work_unit에 연결된 pipelines 조회
    const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
    let pipelinesWithTasks: Array<{ slug: string; tasks: unknown[] }>;

    if (dbPipelines.length > 0) {
      pipelinesWithTasks = dbPipelines.map((p) => ({
        slug: p.slug,
        tasks: db.getTasksByPipelineId(p.id),
      }));
    } else {
      // JSONL fallback
      const pipelineSlugs = getPipelineSlugs().filter((ps) => {
        const pEvents = parsePipelineEvents(ps);
        const pStart = pEvents.find((e) => e.type === "pipeline_start");
        return pStart?.work_unit_slug === wuSlug;
      });
      pipelinesWithTasks = pipelineSlugs.map((ps) => {
        const pipeline = db.getPipelineBySlug(ps);
        return {
          slug: ps,
          tasks: pipeline ? db.getTasksByPipelineId(pipeline.id) : [],
        };
      });
    }

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
    const wuEvents = parseWorkUnitEvents(wuSlug);
    if (wuEvents.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    // DB FK 기반 + JSONL fallback
    const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
    let pipelineSlugs: string[];
    if (dbPipelines.length > 0) {
      pipelineSlugs = dbPipelines.map((p) => p.slug);
    } else {
      pipelineSlugs = getPipelineSlugs().filter((ps) => {
        const pEvents = parsePipelineEvents(ps);
        const pStart = pEvents.find((e) => e.type === "pipeline_start");
        return pStart?.work_unit_slug === wuSlug;
      });
    }

    const activeAgents: Array<{ call_id: string; agent_type: string; pipeline_slug: string; started_at: string | null }> = [];
    for (const ps of pipelineSlugs) {
      const pEvents = parsePipelineEvents(ps);
      const startEvents = pEvents.filter((e) => e.type === "agent_start" && e.call_id);
      for (const se of startEvents) {
        const hasEnd = pEvents.some(
          (e) => e.type === "agent_end" && e.call_id === se.call_id
        );
        if (!hasEnd) {
          activeAgents.push({
            call_id: se.call_id as string,
            agent_type: (se.agent_type as string) ?? "unknown",
            pipeline_slug: ps,
            started_at: (se.ts as string) ?? null,
          });
        }
      }
    }
    return jsonResponse({ work_unit_slug: wuSlug, active_agents: activeAgents });
  }

  // ── GET /api/workunits/:slug/agents ─────────────────────────────
  const workunitAgentsMatch = path.match(/^\/api\/workunits\/([^/]+)\/agents$/);
  if (method === "GET" && workunitAgentsMatch) {
    const wuSlug = decodeURIComponent(workunitAgentsMatch[1]);
    const wuEvents = parseWorkUnitEvents(wuSlug);
    if (wuEvents.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    // DB FK 기반 + JSONL fallback
    const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
    let pipelineSlugs: string[];
    if (dbPipelines.length > 0) {
      pipelineSlugs = dbPipelines.map((p) => p.slug);
    } else {
      pipelineSlugs = getPipelineSlugs().filter((ps) => {
        const pEvents = parsePipelineEvents(ps);
        const pStart = pEvents.find((e) => e.type === "pipeline_start");
        return pStart?.work_unit_slug === wuSlug;
      });
    }

    // 이벤트 파일 기반 agent 통계 집계
    const agentStatsMap = new Map<string, { call_count: number; error_count: number; total_duration_ms: number; duration_count: number }>();
    for (const ps of pipelineSlugs) {
      const pEvents = parsePipelineEvents(ps);
      const agentEndEvents = pEvents.filter((e) => e.type === "agent_end");
      for (const ae of agentEndEvents) {
        const agentType = (ae.agent_type as string) ?? "unknown";
        const existing = agentStatsMap.get(agentType) ?? { call_count: 0, error_count: 0, total_duration_ms: 0, duration_count: 0 };
        existing.call_count += 1;
        if (ae.is_error) existing.error_count += 1;
        const dur = ae.duration_ms as number | undefined;
        if (dur != null) {
          existing.total_duration_ms += dur;
          existing.duration_count += 1;
        }
        agentStatsMap.set(agentType, existing);
      }
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
    const activeAgents: Array<{ call_id: string; agent_type: string; pipeline_slug: string; started_at: string | null }> = [];
    for (const ps of pipelineSlugs) {
      const pEvents = parsePipelineEvents(ps);
      const startEvents = pEvents.filter((e) => e.type === "agent_start" && e.call_id);
      for (const se of startEvents) {
        const hasEnd = pEvents.some(
          (e) => e.type === "agent_end" && e.call_id === se.call_id
        );
        if (!hasEnd) {
          activeAgents.push({
            call_id: se.call_id as string,
            agent_type: (se.agent_type as string) ?? "unknown",
            pipeline_slug: ps,
            started_at: (se.ts as string) ?? null,
          });
        }
      }
    }
    return jsonResponse({ work_unit_slug: wuSlug, stats, active_agents: activeAgents });
  }

  // ── GET /api/workunits/:slug/retro ──────────────────────────────
  const workunitRetroMatch = path.match(/^\/api\/workunits\/([^/]+)\/retro$/);
  if (method === "GET" && workunitRetroMatch) {
    const wuSlug = decodeURIComponent(workunitRetroMatch[1]);
    const wuEvents = parseWorkUnitEvents(wuSlug);
    if (wuEvents.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }

    // ── auto_summary: 파이프라인 이벤트 기반 자동 회고 요약 ──
    // DB FK 기반 + JSONL fallback
    const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
    let pipelineSlugs: string[];
    if (dbPipelines.length > 0) {
      pipelineSlugs = dbPipelines.map((p) => p.slug);
    } else {
      pipelineSlugs = getPipelineSlugs().filter((ps) => {
        const pEvents = parsePipelineEvents(ps);
        const pStart = pEvents.find((e) => e.type === "pipeline_start");
        return pStart?.work_unit_slug === wuSlug;
      });
    }

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

    if (pipelineSlugs.length > 0) {
      const pipelinesData: NonNullable<typeof autoSummary>["pipelines"] = [];
      const agentStatsMap = new Map<string, { call_count: number; error_count: number; total_duration_ms: number; duration_count: number }>();
      const uniqueAgentTypes = new Set<string>();
      let totalAgentCalls = 0;
      let totalAgentErrors = 0;
      let totalDurationMs = 0;
      let completedCount = 0;
      let failedCount = 0;
      let activeCount = 0;

      for (const ps of pipelineSlugs) {
        const pEvents = parsePipelineEvents(ps);
        const pStart = pEvents.find((e) => e.type === "pipeline_start");
        const pEnd = pEvents.find((e) => e.type === "pipeline_end");

        let status: "completed" | "failed" | "active" | "paused" = "active";
        if (pEnd) {
          const endStatus = (pEnd.status as string) ?? "completed";
          if (endStatus === "failed") status = "failed";
          else if (endStatus === "paused") status = "paused";
          else status = "completed";
        }

        if (status === "completed") completedCount++;
        else if (status === "failed") failedCount++;
        else activeCount++;

        const startedAt = (pStart?.ts as string) ?? null;
        const endedAt = (pEnd?.ts as string) ?? null;
        let durationMs: number | null = null;
        if (startedAt && endedAt) {
          durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
          if (durationMs > 0) totalDurationMs += durationMs;
        }

        const stepCount = pEvents.filter((e) => e.type === "step_start").length;
        const agentEndEvents = pEvents.filter((e) => e.type === "agent_end");
        let pipelineAgentCalls = 0;
        let pipelineAgentErrors = 0;

        for (const ae of agentEndEvents) {
          const agentType = (ae.agent_type as string) ?? "unknown";
          uniqueAgentTypes.add(agentType);
          pipelineAgentCalls++;
          totalAgentCalls++;

          const isError = ae.is_error || ae.status === "error";
          if (isError) {
            pipelineAgentErrors++;
            totalAgentErrors++;
          }

          const existing = agentStatsMap.get(agentType) ?? { call_count: 0, error_count: 0, total_duration_ms: 0, duration_count: 0 };
          existing.call_count += 1;
          if (isError) existing.error_count += 1;
          const dur = ae.duration_ms as number | undefined;
          if (dur != null) {
            existing.total_duration_ms += dur;
            existing.duration_count += 1;
          }
          agentStatsMap.set(agentType, existing);
        }

        const pipelineType = (pStart?.pipeline_type as string) ?? ps.split("_")[0] ?? "unknown";

        pipelinesData.push({
          slug: ps,
          type: pipelineType,
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
        total_pipelines: pipelineSlugs.length,
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
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body");
    }
    if (!body.status || !["completed", "failed", "paused"].includes(body.status)) {
      return errorResponse("status must be 'completed', 'failed', or 'paused'");
    }

    const now = new Date().toISOString();
    const eventsFile = join(PIPELINE_EVENTS_DIR, `${pipelineSlug}-events.jsonl`);

    if (!existsSync(eventsFile)) {
      return errorResponse(`Pipeline not found: ${pipelineSlug}`, 404);
    }

    // pipeline_end 이벤트 append (forced: true)
    try {
      appendFileSync(
        eventsFile,
        JSON.stringify({
          type: "pipeline_end",
          pipeline_slug: pipelineSlug,
          work_unit_slug: wuSlug,
          status: body.status,
          forced: true,
          ts: now,
        }) + "\n",
        "utf-8"
      );
    } catch (err) {
      return errorResponse(`Failed to write pipeline_end: ${err}`, 500);
    }

    // DB 동기화: pipeline 상태 업데이트
    try {
      const db = getDefaultDB();
      db.updatePipelineStatus(pipelineSlug, body.status, now, null);
    } catch {
      // DB 업데이트 실패해도 JSONL은 기록됨
    }

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
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body");
    }
    if (!body.status || !["completed", "abandoned"].includes(body.status)) {
      return errorResponse("status must be 'completed' or 'abandoned'");
    }

    // status='completed' 시 활성 파이프라인 존재 여부 확인
    if (body.status === "completed") {
      // DB FK 기반 확인
      const dbPipelines = getDefaultDB().getWorkUnitPipelines(wuSlug);
      let activePipelines: string[];
      if (dbPipelines.length > 0) {
        activePipelines = dbPipelines
          .filter((p) => p.status === "active" || p.status === "running")
          .map((p) => p.slug);
      } else {
        // JSONL fallback
        const pipelineSlugs = getPipelineSlugs().filter((ps) => {
          const pEvents = parsePipelineEvents(ps);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          return pStart?.work_unit_slug === wuSlug;
        });
        activePipelines = pipelineSlugs.filter((ps) => {
          const pEvents = parsePipelineEvents(ps);
          const hasStart = pEvents.some((e) => e.type === "pipeline_start");
          const hasEnd = pEvents.some((e) => e.type === "pipeline_end");
          return hasStart && !hasEnd;
        });
      }
      if (activePipelines.length > 0) {
        return errorResponse("active_pipelines_exist", 400);
      }
    }

    const db = getDefaultWorkUnitDB();
    const now = new Date().toISOString();
    db.endWorkUnit(wuSlug, body.status, now);

    // JSONL append
    const wuFile = `${PIPELINE_EVENTS_DIR}/${wuSlug}-workunit.jsonl`;
    try {
      appendFileSync(
        wuFile,
        JSON.stringify({ type: "work_unit_end", work_unit_slug: wuSlug, status: body.status, ts: now }) + "\n",
        "utf-8"
      );
    } catch {
      // JSONL append 실패해도 DB 업데이트는 완료됨
    }

    pushSseEvent("system", "work_unit_end", { slug: wuSlug, status: body.status });
    return jsonResponse({ ok: true });
  }

  // ── DELETE /api/workunits/:slug ─────────────────────────────────
  const workunitDeleteMatch = path.match(/^\/api\/workunits\/([^/]+)$/);
  if (method === "DELETE" && workunitDeleteMatch) {
    const wuSlug = decodeURIComponent(workunitDeleteMatch[1]);
    const wuEvents = parseWorkUnitEvents(wuSlug);
    if (wuEvents.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }
    const db = getDefaultWorkUnitDB();
    db.deleteWorkUnit(wuSlug);

    // JSONL append
    const wuFile = `${PIPELINE_EVENTS_DIR}/${wuSlug}-workunit.jsonl`;
    const now = new Date().toISOString();
    try {
      appendFileSync(
        wuFile,
        JSON.stringify({ type: "work_unit_archived", work_unit_slug: wuSlug, ts: now }) + "\n",
        "utf-8"
      );
    } catch {
      // graceful
    }

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

  // ── POST /api/runs/events ───────────────────────────────────────
  if (method === "POST" && path === "/api/runs/events") {
    let body: {
      type: string;
      pipeline_slug: string;
      agent_slug: string;
      run_id?: string;
      payload?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body");
    }
    const broker = getBroker();
    broker.pushEvent({
      type: body.type as import("./sse-broker.ts").SseEventType,
      pipeline_slug: body.pipeline_slug,
      agent_slug: body.agent_slug,
      run_id: body.run_id,
      ts: new Date().toISOString(),
      payload: body.payload,
    });
    return jsonResponse({ ok: true }, 201);
  }

  // 404
  return errorResponse(`Not found: ${method} ${path}`, 404);
}

// ─────────────────────────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────────────────────────

// 이벤트 → DB 동기화 (서버 시작 시 1회)
try {
  syncPipelinesFromEvents();
  console.log("[bams-server] Pipeline sync from JSONL completed");
} catch (err) {
  console.error("[bams-server] Pipeline sync failed (non-fatal):", err);
}

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
