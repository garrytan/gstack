/**
 * bams-db/schema.ts
 *
 * SQLite 태스크 관리 스키마 (Bun 네이티브 sqlite API)
 * Paperclip의 issues 테이블(PostgreSQL + Drizzle ORM) 패턴을 SQLite + Bun 네이티브로 포팅
 *
 * 참조: reference/paperclip/packages/db/src/schema/issues.ts
 */

/**
 * tasks 테이블 DDL
 *
 * Paperclip issues 테이블의 핵심 패턴 적용:
 * - execution_locked_at → checkout_locked_at (atomic checkout용)
 * - checkout_run_id (잠금 소유자 식별)
 * - status: backlog|in_progress|done|blocked|cancelled
 */
export const TASKS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id                  TEXT PRIMARY KEY,           -- UUID (crypto.randomUUID())
    pipeline_id         TEXT NOT NULL REFERENCES pipelines(id),  -- 파이프라인 FK
    phase               INTEGER,                    -- Phase 번호 (1, 2, 3, 4, 5)
    step                TEXT,                       -- Step 식별자 (e.g. "design", "implement")
    title               TEXT NOT NULL,              -- 태스크 제목
    description         TEXT,                       -- 상세 설명 (Markdown)
    status              TEXT NOT NULL DEFAULT 'backlog',  -- backlog|in_progress|in_review|done|blocked|cancelled
    priority            TEXT NOT NULL DEFAULT 'medium',   -- high|medium|low
    size                TEXT,                       -- XS|S|M|L|XL
    assignee_agent      TEXT,                       -- 담당 에이전트 슬러그
    checkout_run_id     TEXT,                       -- 체크아웃한 실행 ID (atomic lock 소유자)
    checkout_locked_at  TEXT,                       -- ISO-8601 타임스탬프 (잠금 시각)
    deps                TEXT,                       -- JSON 배열: ["REF-A1", "REF-A2"]
    tags                TEXT,                       -- JSON 배열: ["backend", "infra"]
    model               TEXT,                       -- 사용 모델 (e.g. "claude-sonnet-4")
    label               TEXT,                       -- 태스크 라벨
    duration_ms         INTEGER,                    -- 소요 시간 (ms)
    summary             TEXT,                       -- 태스크 요약
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    started_at          TEXT,
    completed_at        TEXT
  );
`;

/**
 * tasks 인덱스 DDL
 * Paperclip의 issues 테이블 인덱스 패턴 참조
 */
export const TASKS_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS tasks_pipeline_id_status_idx
    ON tasks(pipeline_id, status);

  CREATE INDEX IF NOT EXISTS tasks_assignee_status_idx
    ON tasks(assignee_agent, status);

  CREATE INDEX IF NOT EXISTS tasks_phase_idx
    ON tasks(pipeline_id, phase);
`;

/**
 * task_events 테이블 DDL
 *
 * 태스크 상태 전환 이력을 영구 보존한다.
 * Paperclip의 이벤트 소싱 패턴 적용.
 */
export const TASK_EVENTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS task_events (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id),
    event_type  TEXT NOT NULL,    -- status_change|checkout|assign|comment
    from_status TEXT,             -- 이전 상태
    to_status   TEXT,             -- 다음 상태
    agent_slug  TEXT,             -- 변경을 수행한 에이전트
    run_id      TEXT,             -- 파이프라인 실행 ID
    payload     TEXT,             -- JSON: 추가 데이터
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS task_events_task_idx
    ON task_events(task_id);

  CREATE INDEX IF NOT EXISTS task_events_created_idx
    ON task_events(created_at);
`;

/**
 * 유효한 status 값
 */
export const TASK_STATUS = {
  BACKLOG: "backlog",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  DONE: "done",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/**
 * 유효한 priority 값
 */
export const TASK_PRIORITY = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export type TaskPriority = (typeof TASK_PRIORITY)[keyof typeof TASK_PRIORITY];

/**
 * 유효한 size 값
 */
export const TASK_SIZE = {
  XS: "XS",
  S: "S",
  M: "M",
  L: "L",
  XL: "XL",
} as const;

export type TaskSize = (typeof TASK_SIZE)[keyof typeof TASK_SIZE];

/**
 * Task 레코드 타입
 */
export interface Task {
  id: string;
  pipeline_id: string;
  phase: number | null;
  step: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  size: TaskSize | null;
  assignee_agent: string | null;
  checkout_run_id: string | null;
  checkout_locked_at: string | null;
  deps: string | null;          // JSON string: string[]
  tags: string | null;          // JSON string: string[]
  model: string | null;
  label: string | null;
  duration_ms: number | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * TaskEvent 레코드 타입
 */
export interface TaskEvent {
  id: string;
  task_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  agent_slug: string | null;
  run_id: string | null;
  payload: string | null;       // JSON string
  created_at: string;
}

// ─────────────────────────────────────────────────────────────
// C2: 실시간 실행 로그 스키마
// ─────────────────────────────────────────────────────────────

/**
 * run_logs 테이블 DDL
 * 에이전트 실행 이벤트를 DB에 영구 보존 (SSE 스트리밍 + 재생용)
 * 보존 정책: 최근 30일 또는 1,000건 (초과 시 자동 삭제)
 */
export const RUN_LOGS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS run_logs (
    id              TEXT PRIMARY KEY,
    pipeline_id     TEXT NOT NULL REFERENCES pipelines(id),
    run_id          TEXT,
    agent_slug      TEXT NOT NULL,
    event_type      TEXT NOT NULL,   -- agent_start | tool_call | tool_result | text_chunk | agent_end | error
    payload         TEXT,            -- JSON 직렬화된 이벤트 데이터
    created_at      DATETIME NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS run_logs_pipeline_id_idx
    ON run_logs(pipeline_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS run_logs_agent_idx
    ON run_logs(agent_slug, created_at DESC);

  -- 자동 정리 트리거: 30일 초과 또는 파이프라인당 1,000건 초과 시 삭제
  CREATE TRIGGER IF NOT EXISTS run_logs_cleanup
    AFTER INSERT ON run_logs
    BEGIN
      DELETE FROM run_logs
      WHERE created_at < datetime('now', '-30 days');
    END;
`;

export interface RunLog {
  id: string;
  pipeline_id: string;
  run_id: string | null;
  agent_slug: string;
  event_type: string;
  payload: string | null;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────
// HR Reports 스키마
// retro 파이프라인 완료 시 자동 저장되는 HR 보고서 테이블
// ─────────────────────────────────────────────────────────────

/**
 * hr_reports 테이블 DDL
 * retro 완료 시 convertRetroToHR()가 생성한 HRReport를 DB에 영구 저장.
 * JSON 파일(~/.bams/artifacts/hr/)과 병렬 저장하며, DB가 primary source로 사용됨.
 */
export const HR_REPORTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS hr_reports (
    id              TEXT PRIMARY KEY,
    retro_slug      TEXT NOT NULL UNIQUE,
    report_date     TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'retro',
    period_start    TEXT,
    period_end      TEXT,
    data            TEXT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at      DATETIME NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS hr_reports_date_idx ON hr_reports(report_date DESC);
`;

/**
 * HrReport DB 레코드 타입
 * data 컬럼에는 전체 HRReport JSON이 직렬화되어 저장됨
 */
export interface HrReportRow {
  id: string;
  retro_slug: string;
  report_date: string;
  source: string;
  period_start: string | null;
  period_end: string | null;
  data: string;           // JSON serialized HRReport
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────
// Pipelines 스키마
// 파이프라인 실행 인스턴스 — Work Unit에 연결되는 실행 단위
// ─────────────────────────────────────────────────────────────

/**
 * pipelines 테이블 DDL
 * 파이프라인 실행 인스턴스. work_units와 N:1 관계.
 * tasks, run_logs가 pipeline_id로 FK 참조한다.
 */
export const PIPELINES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS pipelines (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    work_unit_id    TEXT REFERENCES work_units(id),
    type            TEXT NOT NULL,
    command         TEXT,
    status          TEXT NOT NULL DEFAULT 'running',
    arguments       TEXT,
    started_at      TEXT,
    ended_at        TEXT,
    duration_ms     INTEGER,
    total_steps     INTEGER DEFAULT 0,
    completed_steps INTEGER DEFAULT 0,
    failed_steps    INTEGER DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at      DATETIME NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS pipelines_work_unit_idx ON pipelines(work_unit_id);
  CREATE INDEX IF NOT EXISTS pipelines_status_idx ON pipelines(status);
`;

/**
 * PipelineRow 레코드 타입
 */
export interface PipelineRow {
  id: string;
  slug: string;
  work_unit_id: string | null;
  type: string;
  command: string | null;
  status: string;
  arguments: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  total_steps: number;
  completed_steps: number;
  failed_steps: number;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────
// Work Unit 스키마
// 작업 단위(Work Unit) — 여러 파이프라인을 하나의 논리적 작업으로 묶는다
// ─────────────────────────────────────────────────────────────

/**
 * work_units 테이블 DDL
 * 논리적 작업 단위. 여러 파이프라인이 하나의 work unit에 연결될 수 있다.
 */
export const WORK_UNITS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS work_units (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    deleted_at      TEXT,                                         -- 소프트 삭제 타임스탬프 (NULL=활성)
    created_at      DATETIME NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * WorkUnit 레코드 타입
 */
export interface WorkUnitRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  deleted_at: string | null;
  created_at: string;
}
