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
  type Task,
  type TaskEvent,
  type TaskStatus,
  type TaskPriority,
  type TaskSize,
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

      // 현재 사용량 계산 (window_kind에 따라 기간 필터)
      const windowFilter =
        policy.window_kind === "session"
          ? "1=1" // 세션: 전체 (파이프라인 단위)
          : policy.window_kind === "daily"
            ? "date(created_at) = date('now')"
            : "strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')";

      if (policy.metric === "billed_cents") {
        const whereClause =
          scopeType === "agent"
            ? `agent_slug = '${scopeId}' AND ${windowFilter}`
            : scopeType === "pipeline"
              ? `pipeline_slug = '${scopeId}' AND ${windowFilter}`
              : windowFilter;

        const row = this.db
          .prepare<{ val: number }>(
            `SELECT COALESCE(SUM(billed_cents), 0) AS val FROM token_usage WHERE ${whereClause}`
          )
          .get();
        current = row?.val ?? 0;
      } else {
        const whereClause =
          scopeType === "agent"
            ? `agent_slug = '${scopeId}' AND ${windowFilter}`
            : scopeType === "pipeline"
              ? `pipeline_slug = '${scopeId}' AND ${windowFilter}`
              : windowFilter;

        const row = this.db
          .prepare<{ val: number }>(
            `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS val FROM token_usage WHERE ${whereClause}`
          )
          .get();
        current = row?.val ?? 0;
      }

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
