/**
 * bams-plugin/server/src/app.ts
 *
 * Control Plane 서버 — Bun HTTP 서버 (포트 3099)
 *
 * Paperclip의 서버 패턴을 bams-plugin에 적용:
 * - Bun.serve() 기반 (Express 의존성 없음)
 * - REST API + SSE 스트리밍
 * - SQLite TaskDB 직접 연동 (B2)
 * - CORS: localhost:3000 (bams-viz)
 *
 * 엔드포인트:
 *   GET  /api/pipelines                   — 파이프라인 목록
 *   GET  /api/pipelines/:slug             — 파이프라인 상세
 *   GET  /api/tasks                       — 태스크 목록 (쿼리: pipeline=, status=)
 *   PATCH /api/tasks/:id                  — 태스크 상태 업데이트 (atomic)
 *   GET  /api/agents                      — 에이전트 목록
 *   GET  /api/agents/:slug/status         — 에이전트 실행 상태
 *   POST /api/costs                       — 토큰 사용량 기록 (B4 구현 후 활성화)
 *   GET  /api/costs                       — 비용 조회 (쿼리: scope=, window=)
 *   GET  /api/events/stream               — SSE 스트리밍 (C2용, 쿼리: pipeline=, agent=)
 *   GET  /api/workunits                    — work unit 목록 (파이프라인 수 포함)
 *   GET  /api/workunits/active             — 활성 work unit 목록
 *   GET  /api/workunits/:slug              — work unit 상세 (이벤트 + 파이프라인 + task_summary + total_billed_cents)
 *   GET  /api/workunits/:slug/tasks        — work unit 하위 전체 task 목록
 *   GET  /api/workunits/:slug/costs        — work unit 비용 집계
 *   GET  /api/budget/status               — 전역 예산 현황
 *   GET  /api/hr/reports                  — HR 보고서 목록
 *   GET  /api/hr/reports/:id              — HR 보고서 상세
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getDefaultDB, getDefaultCostDB } from "../../tools/bams-db/index.ts";
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
    "Access-Control-Allow-Origin": "http://localhost:3000",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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
  // 첫 번째 H1 제목 추출
  const nameMatch = content.match(/^#\s+(.+)$/m);
  // 부서 추출 (## 부서 또는 department 키)
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
    const slugs = getPipelineSlugs();
    const pipelines = slugs.map((slug) => {
      const events = parsePipelineEvents(slug);
      const startEvent = events.find((e) => e.type === "pipeline_start");
      const lastEvent = events[events.length - 1];
      const db = getDefaultDB();
      const summary = db.getPipelineSummary(slug);
      return {
        slug,
        pipeline_type: startEvent?.pipeline_type ?? "unknown",
        started_at: startEvent?.ts ?? null,
        last_event_at: lastEvent?.ts ?? null,
        work_unit_slug: (startEvent?.work_unit_slug as string) ?? null,
        task_summary: summary,
      };
    });
    return jsonResponse({ pipelines });
  }

  // ── GET /api/pipelines/:slug ────────────────────────────────
  const pipelineDetailMatch = path.match(/^\/api\/pipelines\/([^/]+)$/);
  if (method === "GET" && pipelineDetailMatch) {
    const slug = pipelineDetailMatch[1];
    const events = parsePipelineEvents(slug);
    if (events.length === 0) {
      return errorResponse(`Pipeline not found: ${slug}`, 404);
    }
    const db = getDefaultDB();
    const tasks = db.getTasksByPipeline(slug);
    const summary = db.getPipelineSummary(slug);
    return jsonResponse({ slug, events, tasks, summary });
  }

  // ── GET /api/tasks ──────────────────────────────────────────
  if (method === "GET" && path === "/api/tasks") {
    const pipelineSlug = url.searchParams.get("pipeline");
    const status = url.searchParams.get("status") as TaskStatus | null;
    const db = getDefaultDB();

    if (!pipelineSlug) {
      return errorResponse("pipeline query parameter is required");
    }

    const tasks = status
      ? db.getTasksByStatus(pipelineSlug, status)
      : db.getTasksByPipeline(pipelineSlug);

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
      pushSseEvent(updatedTask.pipeline_slug, "task_updated", updatedTask);
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
    // 최근 이벤트 파일에서 해당 에이전트의 마지막 이벤트 조회
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

  // ── POST /api/costs ─────────────────────────────────────────
  if (method === "POST" && path === "/api/costs") {
    // B4 구현 후 CostDB 연동 — 현재는 수신 후 SSE broadcast만
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON body");
    }

    const pipelineSlug = body.pipeline_slug as string | undefined;
    try {
      const costDb = getDefaultCostDB();
      const id = costDb.recordUsage({
        pipeline_slug: body.pipeline_slug as string ?? "unknown",
        agent_slug: body.agent_slug as string ?? "unknown",
        model: body.model as string ?? "sonnet",
        input_tokens: (body.input_tokens as number) ?? 0,
        output_tokens: (body.output_tokens as number) ?? 0,
        cache_read_tokens: (body.cache_read_tokens as number) ?? 0,
        cache_write_tokens: (body.cache_write_tokens as number) ?? 0,
        phase: body.phase as number | undefined,
        step: body.step as string | undefined,
        run_id: body.run_id as string | undefined,
      });
      if (pipelineSlug) {
        pushSseEvent(pipelineSlug, "cost_recorded", { ...body, id });
      }
      return jsonResponse({ ok: true, id }, 201);
    } catch (err) {
      return errorResponse(`Failed to record cost: ${err}`, 500);
    }
  }

  // ── GET /api/costs ──────────────────────────────────────────
  if (method === "GET" && path === "/api/costs") {
    // B4 구현 후 실제 DB 조회 — 현재는 stub
    const scope = url.searchParams.get("scope");
    const window = url.searchParams.get("window");
    try {
      const costDb = getDefaultCostDB();
      if (scope === "pipeline" && url.searchParams.get("slug")) {
        const pslug = url.searchParams.get("slug")!;
        const summary = costDb.getPipelineCost(pslug);
        return jsonResponse({ scope, slug: pslug, ...summary });
      }
      if (scope === "budget") {
        const scopeType = (url.searchParams.get("scope_type") ?? "global") as "agent" | "pipeline" | "global";
        const scopeId = url.searchParams.get("scope_id") ?? undefined;
        const statuses = costDb.getBudgetStatus(scopeType, scopeId);
        return jsonResponse({ statuses });
      }
      return jsonResponse({
        scope,
        window,
        message: "Use ?scope=pipeline&slug={slug} or ?scope=budget&scope_type=agent&scope_id={slug}",
      });
    } catch (err) {
      return errorResponse(`Failed to query costs: ${err}`, 500);
    }
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
    const active = wuSlugs
      .map((wuSlug) => {
        const events = parseWorkUnitEvents(wuSlug);
        const startEvent = events.find((e) => e.type === "work_unit_start");
        const endEvent = events.find((e) => e.type === "work_unit_end");
        if (!startEvent || endEvent) return null; // not active
        // Count linked pipelines
        const pipelineSlugs = getPipelineSlugs();
        const linkedPipelines = pipelineSlugs.filter((ps) => {
          const pEvents = parsePipelineEvents(ps);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          return pStart?.work_unit_slug === wuSlug;
        });
        return {
          slug: wuSlug,
          name: (startEvent.name as string) ?? wuSlug,
          status: "active" as const,
          startedAt: startEvent.ts ?? null,
          endedAt: null,
          pipelineCount: linkedPipelines.length,
        };
      })
      .filter(Boolean);
    return jsonResponse({ workunits: active });
  }

  // ── GET /api/workunits ──────────────────────────────────────
  if (method === "GET" && path === "/api/workunits") {
    const wuSlugs = getWorkUnitSlugs();
    const pipelineSlugs = getPipelineSlugs();
    const workunits = wuSlugs.map((wuSlug) => {
      const events = parseWorkUnitEvents(wuSlug);
      const startEvent = events.find((e) => e.type === "work_unit_start");
      const endEvent = events.find((e) => e.type === "work_unit_end");
      // Count linked pipelines
      const linkedCount = pipelineSlugs.filter((ps) => {
        const pEvents = parsePipelineEvents(ps);
        const pStart = pEvents.find((e) => e.type === "pipeline_start");
        return pStart?.work_unit_slug === wuSlug;
      }).length;
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
    // Find linked pipelines — DB join 우선, JSONL fallback
    let pipelines: Array<{ slug: string; type: string; linkedAt: string | null }> = [];
    try {
      const wuDb = getDefaultDB();
      const dbRows = wuDb.getWorkUnitPipelines(wuSlug);
      if (dbRows.length > 0) {
        // DB 기반: pipeline_work_unit 테이블에서 조회
        pipelines = dbRows.map((row) => {
          const pEvents = parsePipelineEvents(row.pipeline_slug);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          return {
            slug: row.pipeline_slug,
            type: (pStart?.pipeline_type as string) ?? "unknown",
            linkedAt: row.linked_at ?? null,
          };
        });
      }
    } catch {
      // DB 조회 실패 시 JSONL fallback으로 진행
    }
    // JSONL fallback: DB 레코드 없으면 기존 방식 사용
    if (pipelines.length === 0) {
      const pipelineSlugs = getPipelineSlugs();
      pipelines = pipelineSlugs
        .map((ps) => {
          const pEvents = parsePipelineEvents(ps);
          const pStart = pEvents.find((e) => e.type === "pipeline_start");
          if (pStart?.work_unit_slug !== wuSlug) return null;
          return {
            slug: ps,
            type: (pStart.pipeline_type as string) ?? "unknown",
            linkedAt: pStart.ts ?? null,
          };
        })
        .filter((p): p is { slug: string; type: string; linkedAt: string | null } => p !== null);
    }
    // Work Unit task_summary + 비용 집계 추가
    const db = getDefaultDB();
    const pipelineSlugsList = pipelines.map((p) => (p as { slug: string }).slug);
    let taskSummary = { total: 0, backlog: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0 };
    for (const ps of pipelineSlugsList) {
      const s = db.getPipelineSummary(ps);
      taskSummary = {
        total: taskSummary.total + s.total,
        backlog: taskSummary.backlog + s.backlog,
        in_progress: taskSummary.in_progress + s.in_progress,
        done: taskSummary.done + s.done,
        blocked: taskSummary.blocked + s.blocked,
        cancelled: taskSummary.cancelled + s.cancelled,
      };
    }
    const costDb = getDefaultCostDB();
    let totalBilledCents = 0;
    for (const ps of pipelineSlugsList) {
      const cost = costDb.getPipelineCost(ps);
      totalBilledCents += cost.total_cents;
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
      total_billed_cents: totalBilledCents,
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
    // 연결된 파이프라인 조회
    const pipelineSlugs = getPipelineSlugs().filter((ps) => {
      const pEvents = parsePipelineEvents(ps);
      const pStart = pEvents.find((e) => e.type === "pipeline_start");
      return pStart?.work_unit_slug === wuSlug;
    });
    const db = getDefaultDB();
    const pipelinesWithTasks = pipelineSlugs.map((ps) => ({
      slug: ps,
      tasks: db.getTasksByPipeline(ps),
    }));
    const allTasks = pipelinesWithTasks.flatMap((p) => p.tasks);
    const summary = {
      backlog: allTasks.filter((t) => t.status === "backlog").length,
      in_progress: allTasks.filter((t) => t.status === "in_progress").length,
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

  // ── GET /api/workunits/:slug/costs ───────────────────────────────
  const workunitCostsMatch = path.match(/^\/api\/workunits\/([^/]+)\/costs$/);
  if (method === "GET" && workunitCostsMatch) {
    const wuSlug = decodeURIComponent(workunitCostsMatch[1]);
    const events = parseWorkUnitEvents(wuSlug);
    if (events.length === 0) {
      return errorResponse(`Work unit not found: ${wuSlug}`, 404);
    }
    const pipelineSlugs = getPipelineSlugs().filter((ps) => {
      const pEvents = parsePipelineEvents(ps);
      const pStart = pEvents.find((e) => e.type === "pipeline_start");
      return pStart?.work_unit_slug === wuSlug;
    });
    const costDb = getDefaultCostDB();
    const result = costDb.getWorkUnitCost(pipelineSlugs);
    return jsonResponse({ work_unit_slug: wuSlug, ...result });
  }

  // ── GET /api/budget/status ───────────────────────────────────────
  if (method === "GET" && path === "/api/budget/status") {
    try {
      const costDb = getDefaultCostDB();
      const statuses = costDb.getBudgetStatus("global");
      return jsonResponse({ statuses });
    } catch (err) {
      return errorResponse(`Failed to get budget status: ${err}`, 500);
    }
  }

  // ── GET /api/hr/reports ─────────────────────────────────────────
  if (method === "GET" && path === "/api/hr/reports") {
    try {
      const costDb = getDefaultCostDB();
      const reports = costDb.getHRReports();
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
      const costDb = getDefaultCostDB();
      const report = costDb.getHRReport(reportId);
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
  // 에이전트가 직접 이벤트를 push하는 엔드포인트
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

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
  error(err) {
    console.error("[bams-server] Unhandled error:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`[bams-server] Control Plane running on http://localhost:${PORT}`);
console.log(`[bams-server] CORS allowed: http://localhost:3000 (bams-viz)`);

export { server };
