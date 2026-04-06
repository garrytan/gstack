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
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  TASKS_TABLE_DDL,
  TASKS_INDEXES_DDL,
  TASK_EVENTS_TABLE_DDL,
  WORK_UNITS_TABLE_DDL,
  PIPELINES_TABLE_DDL,
  RUN_LOGS_TABLE_DDL,
  HR_REPORTS_TABLE_DDL,
  type Task,
  type TaskEvent,
  type TaskStatus,
  type TaskPriority,
  type TaskSize,
  type PipelineRow,
  type HrReportRow,
  type WorkUnitRow,
} from "./schema.ts";

/** DB 파일 기본 경로 — 글로벌 단일 DB */
const DEFAULT_DB_PATH = join(homedir(), ".claude", "plugins", "marketplaces", "my-claude", "bams.db");

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
    // work_units must be created before pipelines (FK dependency)
    this.db.exec(WORK_UNITS_TABLE_DDL);
    // pipelines must be created before tasks and run_logs (FK dependency)
    this.db.exec(PIPELINES_TABLE_DDL);
    this.db.exec(TASKS_TABLE_DDL);
    this.db.exec(TASK_EVENTS_TABLE_DDL);
    this.db.exec(TASKS_INDEXES_DDL);
    this.db.exec(RUN_LOGS_TABLE_DDL);
  }

  // ─────────────────────────────────────────────────────────────
  // Pipeline CRUD
  // ─────────────────────────────────────────────────────────────

  /**
   * 파이프라인을 생성하거나 기존 파이프라인을 업데이트한다 (slug 기준 upsert).
   * @returns pipeline id
   */
  upsertPipeline(input: {
    slug: string;
    work_unit_id?: string;
    type: string;
    command?: string;
    status?: string;
    arguments?: string;
    started_at?: string;
  }): string {
    const existing = this.getPipelineBySlug(input.slug);
    if (existing) {
      // UPDATE existing pipeline
      this.db.prepare(`
        UPDATE pipelines
        SET work_unit_id = COALESCE(?, work_unit_id),
            type = ?,
            command = COALESCE(?, command),
            status = COALESCE(?, status),
            arguments = COALESCE(?, arguments),
            started_at = COALESCE(?, started_at),
            updated_at = datetime('now')
        WHERE slug = ?
      `).run(
        input.work_unit_id ?? null,
        input.type,
        input.command ?? null,
        input.status ?? null,
        input.arguments ?? null,
        input.started_at ?? null,
        input.slug
      );
      return existing.id;
    }

    // INSERT new pipeline
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO pipelines (id, slug, work_unit_id, type, command, status, arguments, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.slug,
      input.work_unit_id ?? null,
      input.type,
      input.command ?? null,
      input.status ?? "running",
      input.arguments ?? null,
      input.started_at ?? null
    );
    return id;
  }

  /**
   * 파이프라인 상태를 업데이트한다.
   */
  updatePipelineStatus(
    slug: string,
    status: string,
    endedAt?: string,
    durationMs?: number
  ): void {
    this.db.prepare(`
      UPDATE pipelines
      SET status = ?,
          ended_at = COALESCE(?, ended_at),
          duration_ms = COALESCE(?, duration_ms),
          updated_at = datetime('now')
      WHERE slug = ?
    `).run(status, endedAt ?? null, durationMs ?? null, slug);
  }

  /**
   * 전체 파이프라인 목록 조회 (생성일 내림차순)
   */
  getPipelines(): PipelineRow[] {
    return this.db
      .prepare<PipelineRow>("SELECT * FROM pipelines ORDER BY created_at DESC")
      .all();
  }

  /**
   * slug로 파이프라인 조회
   */
  getPipelineBySlug(slug: string): PipelineRow | null {
    return (
      this.db
        .prepare<PipelineRow>("SELECT * FROM pipelines WHERE slug = ?")
        .get(slug) ?? null
    );
  }

  /**
   * Work Unit에 연결된 파이프라인 목록 조회 (work_unit_id 기반)
   */
  getPipelinesByWorkUnit(workUnitId: string): PipelineRow[] {
    return this.db
      .prepare<PipelineRow>(
        "SELECT * FROM pipelines WHERE work_unit_id = ? ORDER BY created_at ASC"
      )
      .all(workUnitId);
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
    pipeline_id: string;
    title: string;
    description?: string;
    phase?: number;
    step?: string;
    priority?: TaskPriority;
    size?: TaskSize;
    assignee_agent?: string;
    deps?: string[];
    tags?: string[];
    model?: string;
    label?: string;
    duration_ms?: number;
    summary?: string;
  }): string {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, pipeline_id, phase, step, title, description,
        priority, size, assignee_agent, deps, tags,
        model, label, duration_ms, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      input.pipeline_id,
      input.phase ?? null,
      input.step ?? null,
      input.title,
      input.description ?? null,
      input.priority ?? "medium",
      input.size ?? null,
      input.assignee_agent ?? null,
      input.deps ? JSON.stringify(input.deps) : null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.model ?? null,
      input.label ?? null,
      input.duration_ms ?? null,
      input.summary ?? null
    );
    return id;
  }

  /**
   * 상태별 태스크 조회 (≤10ms 목표)
   */
  getTasksByStatus(pipelineId: string, status: TaskStatus): Task[] {
    return this.db
      .prepare<Task>(`
        SELECT * FROM tasks
        WHERE pipeline_id = ? AND status = ?
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          created_at ASC
      `)
      .all(pipelineId, status);
  }

  /**
   * 파이프라인의 모든 태스크 조회 (pipeline_id 기반)
   */
  getTasksByPipelineId(pipelineId: string): Task[] {
    return this.db
      .prepare<Task>(`
        SELECT * FROM tasks
        WHERE pipeline_id = ?
        ORDER BY phase ASC, created_at ASC
      `)
      .all(pipelineId);
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
   * 파이프라인 요약 통계 (pipeline_id 기반)
   */
  getPipelineSummary(pipelineId: string): {
    total: number;
    backlog: number;
    in_progress: number;
    in_review: number;
    done: number;
    blocked: number;
    cancelled: number;
  } {
    const row = this.db
      .prepare<{
        total: number;
        backlog: number;
        in_progress: number;
        in_review: number;
        done: number;
        blocked: number;
        cancelled: number;
      }>(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'backlog'     THEN 1 ELSE 0 END) AS backlog,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN status = 'in_review'   THEN 1 ELSE 0 END) AS in_review,
          SUM(CASE WHEN status = 'done'        THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'blocked'     THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN status = 'cancelled'   THEN 1 ELSE 0 END) AS cancelled
        FROM tasks
        WHERE pipeline_id = ?
      `)
      .get(pipelineId);

    return row ?? {
      total: 0,
      backlog: 0,
      in_progress: 0,
      in_review: 0,
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
   * 파이프라인을 work unit에 연결한다 (pipelines.work_unit_id 설정).
   */
  linkPipelineToWorkUnit(pipelineSlug: string, workUnitSlug: string): void {
    // work_unit의 id를 조회
    const wu = this.db
      .prepare<{ id: string }>("SELECT id FROM work_units WHERE slug = ?")
      .get(workUnitSlug);
    if (!wu) return;

    this.db.prepare(`
      UPDATE pipelines SET work_unit_id = ?, updated_at = datetime('now')
      WHERE slug = ?
    `).run(wu.id, pipelineSlug);
  }

  /**
   * work unit에 연결된 파이프라인 목록을 조회한다.
   */
  getWorkUnitPipelines(workUnitSlug: string): PipelineRow[] {
    return this.db
      .prepare<PipelineRow>(`
        SELECT p.* FROM pipelines p
        INNER JOIN work_units wu ON p.work_unit_id = wu.id
        WHERE wu.slug = ?
        ORDER BY p.created_at ASC
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
export type { Task, TaskEvent, TaskStatus, TaskPriority, TaskSize, PipelineRow } from "./schema.ts";

// ─────────────────────────────────────────────────────────────
// HrReportDB — HR 보고서 CRUD
// ─────────────────────────────────────────────────────────────

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
    this.db.exec(PIPELINES_TABLE_DDL);
    // 마이그레이션: 이미 컬럼이 존재하면 무시
    try { this.db.exec("ALTER TABLE work_units ADD COLUMN deleted_at TEXT"); } catch {}
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

  /**
   * Work Unit을 소프트 삭제한다. (deleted_at 타임스탬프 설정)
   */
  deleteWorkUnit(slug: string): void {
    this.db
      .prepare(
        "UPDATE work_units SET deleted_at = datetime('now') WHERE slug = ? AND deleted_at IS NULL"
      )
      .run(slug);
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

export type { WorkUnitRow } from "./schema.ts";
