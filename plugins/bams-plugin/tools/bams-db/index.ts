/**
 * bams-db/index.ts
 *
 * DB 초기화 및 핵심 쿼리 함수 export
 * Bun 네이티브 SQLite API (bun:sqlite) 사용
 *
 * 사용 예시:
 *   import { TaskDB } from "./plugins/bams-plugin/tools/bams-db/index.ts";
 *   const db = new TaskDB();
 *   const ok = db.checkoutTask("ref-a1", "run-001", "platform-devops");
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  TASKS_TABLE_DDL,
  TASKS_INDEXES_DDL,
  TASK_EVENTS_TABLE_DDL,
  WORK_UNITS_TABLE_DDL,
  PIPELINE_WORK_UNIT_TABLE_DDL,
  type Task,
  type TaskEvent,
  type TaskStatus,
  type TaskPriority,
  type TaskSize,
  type PipelineWorkUnitRow,
} from "./schema.ts";

/** DB 파일 기본 경로 */
const DEFAULT_DB_PATH = ".crew/db/bams.db";

export class TaskDB {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // .crew/db/ 디렉터리가 없으면 생성
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) {
      const fs = require("fs");
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath, { create: true });

    // WAL 모드: 동시 읽기/쓰기 성능 향상 (Paperclip 패턴)
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

    this.initSchema();
  }

  /** 스키마 초기화 (idempotent — 이미 존재하면 건드리지 않음) */
  private initSchema(): void {
    this.db.exec(TASKS_TABLE_DDL);
    this.db.exec(TASK_EVENTS_TABLE_DDL);
    this.db.exec(TASKS_INDEXES_DDL);
    this.db.exec(WORK_UNITS_TABLE_DDL);
    this.db.exec(PIPELINE_WORK_UNIT_TABLE_DDL);
  }

  // ─────────────────────────────────────────────────────────────
  // Atomic Checkout (Paperclip의 execution_locked_at 패턴)
  // ─────────────────────────────────────────────────────────────

  /**
   * 태스크를 원자적으로 체크아웃한다.
   * 여러 에이전트가 동시에 시도해도 1건만 성공한다 (SQLite 단일 파일 잠금 보장).
   *
   * @returns true: 체크아웃 성공, false: 이미 체크아웃됨 또는 태스크 없음
   */
  checkoutTask(taskId: string, runId: string, agentSlug: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status             = 'in_progress',
          checkout_run_id    = ?,
          checkout_locked_at = datetime('now'),
          assignee_agent     = ?,
          started_at         = COALESCE(started_at, datetime('now')),
          updated_at         = datetime('now')
      WHERE id = ? AND status = 'backlog' AND checkout_run_id IS NULL
    `);
    const result = stmt.run(runId, agentSlug, taskId);

    if (result.changes === 1) {
      // 체크아웃 성공 — 이벤트 기록
      this.insertEvent({
        task_id: taskId,
        event_type: "checkout",
        from_status: "backlog",
        to_status: "in_progress",
        agent_slug: agentSlug,
        run_id: runId,
        payload: null,
      });
      return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // 상태 전환 (트랜잭션)
  // ─────────────────────────────────────────────────────────────

  /**
   * 태스크 상태를 전환하고 이벤트를 기록한다. 트랜잭션으로 원자적 처리.
   */
  updateTaskStatus(
    taskId: string,
    toStatus: TaskStatus,
    agentSlug: string,
    runId?: string,
    payload?: Record<string, unknown>
  ): void {
    // 현재 상태 조회
    const current = this.db
      .prepare<Task>("SELECT status FROM tasks WHERE id = ?")
      .get(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);

    const fromStatus = current.status;

    const updateTask = this.db.prepare(`
      UPDATE tasks
      SET status       = ?,
          updated_at   = datetime('now'),
          completed_at = CASE
            WHEN ? IN ('done', 'cancelled') THEN COALESCE(completed_at, datetime('now'))
            ELSE completed_at
          END
      WHERE id = ?
    `);

    const transaction = this.db.transaction(() => {
      updateTask.run(toStatus, toStatus, taskId);
      this.insertEvent({
        task_id: taskId,
        event_type: "status_change",
        from_status: fromStatus,
        to_status: toStatus,
        agent_slug: agentSlug,
        run_id: runId ?? null,
        payload: payload ? JSON.stringify(payload) : null,
      });
    });

    transaction();
  }

  // ─────────────────────────────────────────────────────────────
  // 태스크 생성/조회
  // ─────────────────────────────────────────────────────────────

  /**
   * 새 태스크를 생성한다.
   */
  createTask(input: {
    pipeline_slug: string;
    title: string;
    description?: string;
    phase?: number;
    step?: string;
    priority?: TaskPriority;
    size?: TaskSize;
    assignee_agent?: string;
    deps?: string[];
    tags?: string[];
  }): string {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, pipeline_slug, phase, step, title, description,
        priority, size, assignee_agent, deps, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      input.pipeline_slug,
      input.phase ?? null,
      input.step ?? null,
      input.title,
      input.description ?? null,
      input.priority ?? "medium",
      input.size ?? null,
      input.assignee_agent ?? null,
      input.deps ? JSON.stringify(input.deps) : null,
      input.tags ? JSON.stringify(input.tags) : null
    );
    return id;
  }

  /**
   * 상태별 태스크 조회 (≤10ms 목표)
   */
  getTasksByStatus(pipelineSlug: string, status: TaskStatus): Task[] {
    return this.db
      .prepare<Task>(`
        SELECT * FROM tasks
        WHERE pipeline_slug = ? AND status = ?
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          created_at ASC
      `)
      .all(pipelineSlug, status);
  }

  /**
   * 파이프라인의 모든 태스크 조회
   */
  getTasksByPipeline(pipelineSlug: string): Task[] {
    return this.db
      .prepare<Task>(`
        SELECT * FROM tasks
        WHERE pipeline_slug = ?
        ORDER BY phase ASC, created_at ASC
      `)
      .all(pipelineSlug);
  }

  /**
   * 단일 태스크 조회
   */
  getTask(taskId: string): Task | null {
    return (
      this.db.prepare<Task>("SELECT * FROM tasks WHERE id = ?").get(taskId) ??
      null
    );
  }

  /**
   * 태스크 이벤트 이력 조회
   */
  getTaskEvents(taskId: string): TaskEvent[] {
    return this.db
      .prepare<TaskEvent>(`
        SELECT * FROM task_events
        WHERE task_id = ?
        ORDER BY created_at ASC
      `)
      .all(taskId);
  }

  /**
   * 파이프라인 요약 통계
   */
  getPipelineSummary(pipelineSlug: string): {
    total: number;
    backlog: number;
    in_progress: number;
    done: number;
    blocked: number;
    cancelled: number;
  } {
    const row = this.db
      .prepare<{
        total: number;
        backlog: number;
        in_progress: number;
        done: number;
        blocked: number;
        cancelled: number;
      }>(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'backlog'     THEN 1 ELSE 0 END) AS backlog,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN status = 'done'        THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'blocked'     THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN status = 'cancelled'   THEN 1 ELSE 0 END) AS cancelled
        FROM tasks
        WHERE pipeline_slug = ?
      `)
      .get(pipelineSlug);

    return row ?? {
      total: 0,
      backlog: 0,
      in_progress: 0,
      done: 0,
      blocked: 0,
      cancelled: 0,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 내부 유틸리티
  // ─────────────────────────────────────────────────────────────

  private insertEvent(event: Omit<TaskEvent, "id" | "created_at">): void {
    const stmt = this.db.prepare(`
      INSERT INTO task_events (id, task_id, event_type, from_status, to_status, agent_slug, run_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      randomUUID(),
      event.task_id,
      event.event_type,
      event.from_status ?? null,
      event.to_status ?? null,
      event.agent_slug ?? null,
      event.run_id ?? null,
      event.payload ?? null
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Work Unit 연결 (TaskDB 경량 래퍼)
  // ─────────────────────────────────────────────────────────────

  /**
   * work unit을 생성한다. 이미 존재하면 무시 (idempotent).
   */
  upsertWorkUnit(slug: string, name?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO work_units (id, slug, name, status, started_at)
      VALUES (?, ?, ?, 'active', datetime('now'))
    `).run(randomUUID(), slug, name ?? slug);
  }

  /**
   * 파이프라인을 work unit에 연결한다. 이미 연결되어 있으면 무시 (idempotent).
   */
  linkPipelineToWorkUnit(pipelineSlug: string, workUnitSlug: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO pipeline_work_unit (pipeline_slug, work_unit_slug, linked_at)
      VALUES (?, ?, datetime('now'))
    `).run(pipelineSlug, workUnitSlug);
  }

  /**
   * work unit에 연결된 파이프라인 목록을 조회한다.
   */
  getWorkUnitPipelines(workUnitSlug: string): PipelineWorkUnitRow[] {
    return this.db
      .prepare<PipelineWorkUnitRow>(`
        SELECT pipeline_slug, work_unit_slug, linked_at
        FROM pipeline_work_unit
        WHERE work_unit_slug = ?
        ORDER BY linked_at ASC
      `)
      .all(workUnitSlug);
  }

  /** DB 연결 종료 */
  close(): void {
    this.db.close();
  }
}

// ─────────────────────────────────────────────────────────────
// 기본 export: 싱글턴 인스턴스 (프로세스당 1개)
// ─────────────────────────────────────────────────────────────

let _defaultDb: TaskDB | null = null;

export function getDefaultDB(): TaskDB {
  if (!_defaultDb) {
    _defaultDb = new TaskDB();
  }
  return _defaultDb;
}

export { TASK_STATUS, TASK_PRIORITY, TASK_SIZE } from "./schema.ts";
export type { Task, TaskEvent, TaskStatus, TaskPriority, TaskSize } from "./schema.ts";

// ─────────────────────────────────────────────────────────────
// B4: CostDB — 비용 관리
// 참조: reference/paperclip/packages/db/src/schema/budget_policies.ts
// ─────────────────────────────────────────────────────────────

import {
  TOKEN_USAGE_TABLE_DDL,
  BUDGET_POLICIES_TABLE_DDL,
  getPricing,
  type TokenUsage,
  type BudgetPolicy,
  type BudgetStatus,
} from "./schema.ts";

export class CostDB {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(TOKEN_USAGE_TABLE_DDL);
    this.db.exec(BUDGET_POLICIES_TABLE_DDL);
  }

  // ── 토큰 사용량 기록 ────────────────────────────────────────

  /**
   * 에이전트 실행 후 토큰 사용량을 기록한다.
   * billed_cents는 모델별 단가를 자동 적용하여 계산한다.
   */
  recordUsage(input: {
    pipeline_slug: string;
    agent_slug: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    phase?: number;
    step?: string;
    run_id?: string;
  }): string {
    const id = randomUUID();
    const pricing = getPricing(input.model);
    const cacheRead = input.cache_read_tokens ?? 0;
    const cacheWrite = input.cache_write_tokens ?? 0;

    // USD cents 계산
    const billedCents =
      (input.input_tokens / 1000) * pricing.input_per_1k +
      (input.output_tokens / 1000) * pricing.output_per_1k +
      (cacheRead / 1000) * pricing.cache_read_per_1k;

    this.db
      .prepare(
        `INSERT INTO token_usage (
          id, pipeline_slug, phase, step, agent_slug, model, run_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, billed_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.pipeline_slug,
        input.phase ?? null,
        input.step ?? null,
        input.agent_slug,
        input.model,
        input.run_id ?? null,
        input.input_tokens,
        input.output_tokens,
        cacheRead,
        cacheWrite,
        billedCents
      );

    return id;
  }

  /** 파이프라인별 비용 집계 */
  getPipelineCost(pipelineSlug: string): {
    total_cents: number;
    total_tokens: number;
    by_agent: Array<{ agent_slug: string; cents: number; tokens: number }>;
  } {
    const total = this.db
      .prepare<{ total_cents: number; total_tokens: number }>(
        `SELECT
          COALESCE(SUM(billed_cents), 0) AS total_cents,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
        FROM token_usage WHERE pipeline_slug = ?`
      )
      .get(pipelineSlug) ?? { total_cents: 0, total_tokens: 0 };

    const byAgent = this.db
      .prepare<{ agent_slug: string; cents: number; tokens: number }>(
        `SELECT
          agent_slug,
          COALESCE(SUM(billed_cents), 0) AS cents,
          COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
        FROM token_usage
        WHERE pipeline_slug = ?
        GROUP BY agent_slug
        ORDER BY cents DESC`
      )
      .all(pipelineSlug);

    return {
      total_cents: total.total_cents,
      total_tokens: total.total_tokens,
      by_agent: byAgent,
    };
  }

  // ── 예산 정책 ─────────────────────────────────────────────────

  /** 예산 정책 생성 */
  createPolicy(input: Omit<BudgetPolicy, "id" | "created_at" | "updated_at">): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO budget_policies (
          id, scope_type, scope_id, metric, window_kind,
          amount, warn_percent, hard_stop_enabled, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.scope_type,
        input.scope_id ?? null,
        input.metric,
        input.window_kind,
        input.amount,
        input.warn_percent,
        input.hard_stop_enabled,
        input.is_active
      );
    return id;
  }

  /**
   * 예산 상태 조회 — 현재 사용량 vs 정책 한도
   * scope_type: "agent" | "pipeline" | "global"
   * scope_id: agent_slug 또는 pipeline_slug
   */
  getBudgetStatus(
    scopeType: BudgetPolicy["scope_type"],
    scopeId?: string
  ): BudgetStatus[] {
    const policies = this.db
      .prepare<BudgetPolicy>(
        `SELECT * FROM budget_policies
        WHERE scope_type = ? AND (scope_id = ? OR scope_id IS NULL) AND is_active = 1`
      )
      .all(scopeType, scopeId ?? null);

    return policies.map((policy) => {
      let current = 0;

      // window_kind 화이트리스트 검증 (DB 열거형이지만 방어적으로 처리)
      const VALID_WINDOW_KINDS = ["session", "daily", "monthly"] as const;
      const windowKind = VALID_WINDOW_KINDS.includes(policy.window_kind as typeof VALID_WINDOW_KINDS[number])
        ? policy.window_kind
        : "session";

      // 현재 사용량 계산 (window_kind에 따라 기간 필터)
      const windowFilter =
        windowKind === "session"
          ? "1=1" // 세션: 전체 (파이프라인 단위)
          : windowKind === "daily"
            ? "date(created_at) = date('now')"
            : "strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')";

      // scope별 WHERE 절과 파라미터를 prepared statement로 구성
      const scopeColumn =
        scopeType === "agent"
          ? "agent_slug"
          : scopeType === "pipeline"
            ? "pipeline_slug"
            : null;

      const whereClause = scopeColumn
        ? `${scopeColumn} = ? AND ${windowFilter}`
        : windowFilter;

      const params = scopeColumn ? [scopeId ?? null] : [];

      // metric 화이트리스트 검증
      const metricExpr =
        policy.metric === "billed_cents"
          ? "COALESCE(SUM(billed_cents), 0)"
          : policy.metric === "total_tokens"
            ? "COALESCE(SUM(input_tokens + output_tokens), 0)"
            : "COALESCE(SUM(input_tokens + output_tokens), 0)"; // 안전한 기본값

      const row = this.db
        .prepare<{ val: number }>(
          `SELECT ${metricExpr} AS val FROM token_usage WHERE ${whereClause}`
        )
        .get(...params);
      current = row?.val ?? 0;

      const percent = policy.amount > 0 ? (current / policy.amount) * 100 : 0;

      return {
        policy,
        current,
        percent,
        warn: percent >= policy.warn_percent,
        hard_stop: policy.hard_stop_enabled === 1 && percent >= 100,
      };
    });
  }

  /**
   * 예산 경고/차단 체크 — 파이프라인 실행 전 호출
   * @returns { warn: string[], block: string[] }
   */
  checkBudgetAlert(
    pipelineSlug: string,
    agentSlug?: string
  ): { warn: string[]; block: string[] } {
    const checks: BudgetStatus[] = [
      ...this.getBudgetStatus("global"),
      ...this.getBudgetStatus("pipeline", pipelineSlug),
      ...(agentSlug ? this.getBudgetStatus("agent", agentSlug) : []),
    ];

    const warn: string[] = [];
    const block: string[] = [];

    for (const status of checks) {
      if (status.hard_stop) {
        block.push(
          `[HARD STOP] ${status.policy.scope_type}/${status.policy.scope_id ?? "global"}: ` +
          `${status.current.toFixed(2)} / ${status.policy.amount} ${status.policy.metric} ` +
          `(${status.percent.toFixed(1)}%)`
        );
      } else if (status.warn) {
        warn.push(
          `[WARN] ${status.policy.scope_type}/${status.policy.scope_id ?? "global"}: ` +
          `${status.current.toFixed(2)} / ${status.policy.amount} ${status.policy.metric} ` +
          `(${status.percent.toFixed(1)}%)`
        );
      }
    }

    return { warn, block };
  }


  /**
   * 여러 파이프라인의 비용을 집계하여 Work Unit 비용 요약을 반환한다.
   * pipelineSlugs는 Work Unit에 연결된 파이프라인 목록이다.
   */
  getWorkUnitCost(pipelineSlugs: string[]): {
    total_billed_cents: number;
    by_pipeline: Array<{
      pipeline_slug: string;
      billed_cents: number;
      input_tokens: number;
      output_tokens: number;
    }>;
    by_agent: Array<{
      agent_slug: string;
      model: string;
      billed_cents: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>;
  } {
    if (pipelineSlugs.length === 0) {
      return { total_billed_cents: 0, by_pipeline: [], by_agent: [] };
    }

    // pipeline별 집계 (parameterized: IN 절 placeholders)
    const placeholders = pipelineSlugs.map(() => "?").join(", ");

    const byPipeline = this.db
      .prepare<{
        pipeline_slug: string;
        billed_cents: number;
        input_tokens: number;
        output_tokens: number;
      }>(
        `SELECT
          pipeline_slug,
          COALESCE(SUM(billed_cents), 0)              AS billed_cents,
          COALESCE(SUM(input_tokens), 0)              AS input_tokens,
          COALESCE(SUM(output_tokens), 0)             AS output_tokens
        FROM token_usage
        WHERE pipeline_slug IN (${placeholders})
        GROUP BY pipeline_slug
        ORDER BY billed_cents DESC`
      )
      .all(...pipelineSlugs);

    const byAgent = this.db
      .prepare<{
        agent_slug: string;
        model: string;
        billed_cents: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
      }>(
        `SELECT
          agent_slug,
          model,
          COALESCE(SUM(billed_cents), 0)              AS billed_cents,
          COALESCE(SUM(input_tokens), 0)              AS input_tokens,
          COALESCE(SUM(output_tokens), 0)             AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0)         AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0)        AS cache_write_tokens
        FROM token_usage
        WHERE pipeline_slug IN (${placeholders})
        GROUP BY agent_slug, model
        ORDER BY billed_cents DESC`
      )
      .all(...pipelineSlugs);

    const totalCents = byPipeline.reduce((sum, p) => sum + p.billed_cents, 0);

    return {
      total_billed_cents: totalCents,
      by_pipeline: byPipeline,
      by_agent: byAgent,
    };
  }

  /**
   * HR 보고서 목록을 조회한다.
   * hr_reports 테이블이 없으면 빈 배열을 반환한다 (graceful degradation).
   */
  getHRReports(): Array<{
    id: string;
    retro_slug: string;
    report_date: string;
    source: string;
    period_start: string | null;
    period_end: string | null;
  }> {
    try {
      return this.db
        .prepare<{
          id: string;
          retro_slug: string;
          report_date: string;
          source: string;
          period_start: string | null;
          period_end: string | null;
        }>(
          `SELECT id, retro_slug, report_date, source, period_start, period_end
           FROM hr_reports
           ORDER BY report_date DESC, created_at DESC`
        )
        .all();
    } catch {
      // hr_reports 테이블이 없을 때 graceful degradation
      return [];
    }
  }

  /**
   * 특정 HR 보고서를 id로 조회한다 (data JSON 포함).
   * 없으면 null 반환.
   */
  getHRReport(id: string): {
    id: string;
    retro_slug: string;
    report_date: string;
    source: string;
    period_start: string | null;
    period_end: string | null;
    data: Record<string, unknown>;
  } | null {
    try {
      const row = this.db
        .prepare<{
          id: string;
          retro_slug: string;
          report_date: string;
          source: string;
          period_start: string | null;
          period_end: string | null;
          data: string;
        }>("SELECT * FROM hr_reports WHERE id = ?")
        .get(id);

      if (!row) return null;

      return {
        id: row.id,
        retro_slug: row.retro_slug,
        report_date: row.report_date,
        source: row.source,
        period_start: row.period_start,
        period_end: row.period_end,
        data: (() => {
          try { return JSON.parse(row.data) as Record<string, unknown>; }
          catch { return {}; }
        })(),
      };
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

// 싱글턴 CostDB
let _defaultCostDb: CostDB | null = null;
export function getDefaultCostDB(): CostDB {
  if (!_defaultCostDb) {
    _defaultCostDb = new CostDB();
  }
  return _defaultCostDb;
}

export type { TokenUsage, BudgetPolicy, BudgetStatus };

// ─────────────────────────────────────────────────────────────
// HrReportDB — HR 보고서 CRUD
// ─────────────────────────────────────────────────────────────

import {
  HR_REPORTS_TABLE_DDL,
  type HrReportRow,
} from "./schema.ts";

export class HrReportDB {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const fs = require("fs");
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(HR_REPORTS_TABLE_DDL);
  }

  /**
   * HR 보고서를 upsert한다 (retro_slug 기준 INSERT OR REPLACE).
   * convertRetroToHR() 완료 후 호출.
   *
   * @param retroSlug  retro 파이프라인 슬러그 (e.g. "retro-all-20260404")
   * @param reportDate 보고서 날짜 (YYYY-MM-DD)
   * @param data       전체 HRReport 객체 (JSON 직렬화되어 저장됨)
   * @returns 삽입/교체된 레코드의 id
   */
  upsertHrReport(
    retroSlug: string,
    reportDate: string,
    data: Record<string, unknown>
  ): string {
    const id = randomUUID();
    const periodStart = (data.period as { start?: string } | undefined)?.start ?? null;
    const periodEnd = (data.period as { end?: string } | undefined)?.end ?? null;
    const source = typeof data.source === "string" ? data.source : "retro";

    this.db
      .prepare(
        `INSERT OR REPLACE INTO hr_reports
          (id, retro_slug, report_date, source, period_start, period_end, data, updated_at)
         VALUES (
           COALESCE((SELECT id FROM hr_reports WHERE retro_slug = ?), ?),
           ?, ?, ?, ?, ?, ?, datetime('now')
         )`
      )
      .run(retroSlug, id, retroSlug, reportDate, source, periodStart, periodEnd, JSON.stringify(data));

    const row = this.db
      .prepare<{ id: string }>("SELECT id FROM hr_reports WHERE retro_slug = ?")
      .get(retroSlug);

    return row?.id ?? id;
  }

  /**
   * 전체 HR 보고서 목록 조회 (날짜 내림차순)
   */
  getHrReports(): HrReportRow[] {
    return this.db
      .prepare<HrReportRow>(
        "SELECT * FROM hr_reports ORDER BY report_date DESC, created_at DESC"
      )
      .all();
  }

  /**
   * 가장 최근 HR 보고서 1건 조회
   */
  getHrReportLatest(): HrReportRow | null {
    return (
      this.db
        .prepare<HrReportRow>(
          "SELECT * FROM hr_reports ORDER BY report_date DESC, created_at DESC LIMIT 1"
        )
        .get() ?? null
    );
  }

  /**
   * retro_slug로 특정 보고서 조회
   * (기존 JSON API의 ?filename= 파라미터와 동일한 역할)
   */
  getHrReportBySlug(retroSlug: string): HrReportRow | null {
    return (
      this.db
        .prepare<HrReportRow>("SELECT * FROM hr_reports WHERE retro_slug = ?")
        .get(retroSlug) ?? null
    );
  }

  /**
   * retro source 보고서만 조회하여 retro-journal 형식으로 반환.
   * UI의 /api/hr/retro-journal 엔드포인트가 사용함.
   */
  getRetroJournal(): HrReportRow[] {
    return this.db
      .prepare<HrReportRow>(
        `SELECT * FROM hr_reports
         WHERE source = 'retro'
         ORDER BY report_date DESC, created_at DESC`
      )
      .all();
  }

  /** DB 연결 종료 */
  close(): void {
    this.db.close();
  }
}

// 싱글턴 HrReportDB
let _defaultHrReportDb: HrReportDB | null = null;
export function getDefaultHrReportDB(): HrReportDB {
  if (!_defaultHrReportDb) {
    _defaultHrReportDb = new HrReportDB();
  }
  return _defaultHrReportDb;
}

export type { HrReportRow } from "./schema.ts";

// ─────────────────────────────────────────────────────────────
// WorkUnitDB — Work Unit CRUD
// ─────────────────────────────────────────────────────────────

import {
  WORK_UNITS_TABLE_DDL,
  PIPELINE_WORK_UNIT_TABLE_DDL,
  type WorkUnitRow,
  type PipelineWorkUnitRow,
} from "./schema.ts";

export class WorkUnitDB {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const fs = require("fs");
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(WORK_UNITS_TABLE_DDL);
    this.db.exec(PIPELINE_WORK_UNIT_TABLE_DDL);
  }

  /** Work Unit 생성 (idempotent — slug 중복 시 무시) */
  createWorkUnit(slug: string, name: string, startedAt: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO work_units (id, slug, name, status, started_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), slug, name, "active", startedAt);
  }

  /** Work Unit 종료 */
  endWorkUnit(slug: string, status: string, endedAt: string): void {
    this.db
      .prepare("UPDATE work_units SET status = ?, ended_at = ? WHERE slug = ?")
      .run(status, endedAt, slug);
  }

  /** 전체 Work Unit 목록 조회 (생성일 내림차순) */
  getWorkUnits(): WorkUnitRow[] {
    return this.db
      .prepare<WorkUnitRow>("SELECT * FROM work_units ORDER BY created_at DESC")
      .all();
  }

  /** slug로 단일 Work Unit 조회 */
  getWorkUnit(slug: string): WorkUnitRow | null {
    return (
      this.db
        .prepare<WorkUnitRow>("SELECT * FROM work_units WHERE slug = ?")
        .get(slug) ?? null
    );
  }

  /** 현재 활성 Work Unit 조회 (가장 최근 1건) */
  getActiveWorkUnit(): WorkUnitRow | null {
    return (
      this.db
        .prepare<WorkUnitRow>(
          "SELECT * FROM work_units WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
        )
        .get() ?? null
    );
  }

  /** 파이프라인을 Work Unit에 연결 (idempotent — 중복 시 무시) */
  linkPipeline(workUnitSlug: string, pipelineSlug: string, linkedAt: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pipeline_work_unit (pipeline_slug, work_unit_slug, linked_at) VALUES (?, ?, ?)"
      )
      .run(pipelineSlug, workUnitSlug, linkedAt);
  }

  /** Work Unit에 연결된 파이프라인 목록 조회 */
  getPipelinesByWorkUnit(workUnitSlug: string): PipelineWorkUnitRow[] {
    return this.db
      .prepare<PipelineWorkUnitRow>(
        "SELECT * FROM pipeline_work_unit WHERE work_unit_slug = ? ORDER BY linked_at"
      )
      .all(workUnitSlug);
  }

  /** 파이프라인이 속한 Work Unit 조회 */
  getWorkUnitByPipeline(pipelineSlug: string): WorkUnitRow | null {
    return (
      this.db
        .prepare<WorkUnitRow>(
          `SELECT wu.* FROM work_units wu
           JOIN pipeline_work_unit pwu ON wu.slug = pwu.work_unit_slug
           WHERE pwu.pipeline_slug = ?`
        )
        .get(pipelineSlug) ?? null
    );
  }

  /** DB 연결 종료 */
  close(): void {
    this.db.close();
  }
}

// 싱글턴 WorkUnitDB
let _defaultWorkUnitDb: WorkUnitDB | null = null;
export function getDefaultWorkUnitDB(): WorkUnitDB {
  if (!_defaultWorkUnitDb) {
    _defaultWorkUnitDb = new WorkUnitDB();
  }
  return _defaultWorkUnitDb;
}

export type { WorkUnitRow, PipelineWorkUnitRow } from "./schema.ts";
