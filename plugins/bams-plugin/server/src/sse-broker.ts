/**
 * bams-plugin/server/src/sse-broker.ts
 *
 * SSE 이벤트 브로커 — push/subscribe 패턴
 * PRD §2.7: 실시간 실행 뷰어 (C2)
 *
 * 아키텍처:
 * - bams-viz-emit.sh가 파이프라인 이벤트를 JSONL 파일에 기록
 * - 에이전트/파이프라인 코드가 pushEvent()를 호출하여 SSE 스트리밍
 * - bams-viz의 /runs 탭이 EventSource로 구독
 *
 * DB 스키마:
 * - run_logs 테이블은 schema.ts의 RUN_LOGS_TABLE_DDL로 정의됨
 * - pipeline_id 컬럼은 pipelines 테이블의 id를 참조 (FK)
 * - sse-broker는 pipeline_slug를 pipeline_id로 변환하여 저장
 * - FK 대상이 없는 경우(시스템 이벤트 등) "system" 값으로 저장
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { RunLog } from "../../tools/bams-db/schema.ts";

// ─────────────────────────────────────────────────────────────
// 이벤트 유형
// ─────────────────────────────────────────────────────────────

export type SseEventType =
  | "agent_start"
  | "tool_call"
  | "tool_result"
  | "text_chunk"
  | "agent_end"
  | "error"
  | "connected"
  | "heartbeat";

export interface SseEvent {
  type: SseEventType;
  pipeline_slug: string;
  agent_slug: string;
  run_id?: string;
  ts: string;
  payload?: unknown;
}

// ─────────────────────────────────────────────────────────────
// SSE 브로커 클래스
// ─────────────────────────────────────────────────────────────

export class SseBroker {
  /** pipeline_slug → Set<controller> */
  private clients = new Map<string, Set<ReadableStreamDefaultController<string>>>();
  /** agent_slug → Set<controller> */
  private agentClients = new Map<string, Set<ReadableStreamDefaultController<string>>>();

  private db: Database;
  /** pipeline_slug → pipeline_id 캐시 */
  private pipelineIdCache = new Map<string, string>();

  constructor(dbPath = join(homedir(), ".claude", "plugins", "marketplaces", "my-claude", "bams.db")) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
  }

  private initSchema(): void {
    // run_logs 테이블은 TaskDB가 schema.ts의 RUN_LOGS_TABLE_DDL로 이미 생성함.
    // CREATE TABLE IF NOT EXISTS이므로 중복 실행해도 안전.
    // 여기서는 테이블이 없는 경우(TaskDB 미초기화 시)에만 생성.
    // pipeline_id 컬럼 사용 (Batch 1에서 pipeline_slug → pipeline_id로 변경됨)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_logs (
        id              TEXT PRIMARY KEY,
        pipeline_id     TEXT NOT NULL,
        run_id          TEXT,
        agent_slug      TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        payload         TEXT,
        created_at      DATETIME NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS run_logs_pipeline_id_idx
        ON run_logs(pipeline_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS run_logs_agent_idx
        ON run_logs(agent_slug, created_at DESC);
    `);
  }

  /**
   * pipeline_slug를 pipeline_id로 변환한다.
   * 캐시 우선, 캐시 미스 시 DB 조회, DB에도 없으면 slug를 그대로 사용.
   */
  private resolvePipelineId(pipelineSlug: string): string {
    if (this.pipelineIdCache.has(pipelineSlug)) {
      return this.pipelineIdCache.get(pipelineSlug)!;
    }
    try {
      const row = this.db
        .prepare<{ id: string }>("SELECT id FROM pipelines WHERE slug = ?")
        .get(pipelineSlug);
      if (row) {
        this.pipelineIdCache.set(pipelineSlug, row.id);
        return row.id;
      }
    } catch {
      // pipelines 테이블이 없거나 조회 실패 시 slug 그대로 사용
    }
    // DB에 pipeline이 없으면 slug를 id로 사용 (FK 없이 저장)
    return pipelineSlug;
  }

  // ── 이벤트 push ────────────────────────────────────────────

  /**
   * 이벤트를 push한다:
   * 1. DB run_logs에 영구 보존
   * 2. 구독 중인 SSE 클라이언트에 브로드캐스트
   */
  pushEvent(event: SseEvent): void {
    const id = randomUUID();
    const pipelineId = this.resolvePipelineId(event.pipeline_slug);

    // DB 저장
    try {
      this.db
        .prepare(
          `INSERT INTO run_logs (id, pipeline_id, run_id, agent_slug, event_type, payload)
          VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          pipelineId,
          event.run_id ?? null,
          event.agent_slug,
          event.type,
          event.payload ? JSON.stringify(event.payload) : null
        );
    } catch {
      // FK 제약 실패 시에도 SSE 브로드캐스트는 계속 진행
      // (시스템 이벤트 등 pipeline이 DB에 없는 경우)
    }

    // SSE 직렬화
    const ssePayload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    // 파이프라인 구독자에게 broadcast
    this.broadcast(this.clients, event.pipeline_slug, ssePayload);
    // "global" 구독자에게 broadcast
    this.broadcast(this.clients, "global", ssePayload);
    // 에이전트 구독자에게 broadcast
    this.broadcast(this.agentClients, event.agent_slug, ssePayload);
  }

  private broadcast(
    map: Map<string, Set<ReadableStreamDefaultController<string>>>,
    key: string,
    payload: string
  ): void {
    const clients = map.get(key);
    if (!clients) return;
    const dead = new Set<ReadableStreamDefaultController<string>>();
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(payload);
      } catch {
        dead.add(ctrl);
      }
    }
    for (const d of dead) clients.delete(d);
  }

  // ── SSE 스트림 생성 ─────────────────────────────────────────

  /**
   * 클라이언트 SSE 구독 스트림 반환
   * filter: { pipeline?: string; agent?: string }
   */
  createStream(filter: {
    pipeline?: string;
    agent?: string;
  }): ReadableStream<string> {
    const pipelineKey = filter.pipeline ?? "global";
    const agentKey = filter.agent;

    return new ReadableStream<string>({
      start: (controller) => {
        // 파이프라인 채널 등록
        if (!this.clients.has(pipelineKey)) {
          this.clients.set(pipelineKey, new Set());
        }
        this.clients.get(pipelineKey)!.add(controller);

        // 에이전트 채널 등록
        if (agentKey) {
          if (!this.agentClients.has(agentKey)) {
            this.agentClients.set(agentKey, new Set());
          }
          this.agentClients.get(agentKey)!.add(controller);
        }

        // 초기 연결 이벤트
        controller.enqueue(
          `event: connected\ndata: ${JSON.stringify({
            pipeline: pipelineKey,
            agent: agentKey,
            ts: new Date().toISOString(),
          })}\n\n`
        );

        // heartbeat
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(": heartbeat\n\n");
          } catch {
            clearInterval(heartbeat);
            this.cleanup(controller, pipelineKey, agentKey);
          }
        }, 30_000);

        // 최근 로그 replay (최대 50건)
        if (filter.pipeline) {
          const recentLogs = this.getRecentLogs(filter.pipeline, 50);
          for (const log of recentLogs) {
            try {
              const payload = log.payload ? JSON.parse(log.payload) : null;
              controller.enqueue(
                `event: ${log.event_type}\ndata: ${JSON.stringify({
                  ...payload,
                  _replayed: true,
                  _log_id: log.id,
                  _created_at: log.created_at,
                })}\n\n`
              );
            } catch {
              // 파싱 실패 무시
            }
          }
          controller.enqueue(
            `event: replay_complete\ndata: ${JSON.stringify({ count: recentLogs.length })}\n\n`
          );
        }

        return () => {
          clearInterval(heartbeat);
          this.cleanup(controller, pipelineKey, agentKey);
        };
      },
    });
  }

  private cleanup(
    ctrl: ReadableStreamDefaultController<string>,
    pipelineKey: string,
    agentKey?: string
  ): void {
    this.clients.get(pipelineKey)?.delete(ctrl);
    if (agentKey) {
      this.agentClients.get(agentKey)?.delete(ctrl);
    }
  }

  // ── 로그 조회 ─────────────────────────────────────────────────

  /** 파이프라인의 최근 실행 로그 조회 (slug 또는 id로 검색) */
  getRecentLogs(pipelineSlug: string, limit = 100): RunLog[] {
    const pipelineId = this.resolvePipelineId(pipelineSlug);
    return this.db
      .prepare<RunLog>(
        `SELECT * FROM run_logs
        WHERE pipeline_id = ?
        ORDER BY created_at ASC
        LIMIT ?`
      )
      .all(pipelineId, limit);
  }

  /** 에이전트의 최근 실행 로그 조회 */
  getAgentLogs(agentSlug: string, limit = 50): RunLog[] {
    return this.db
      .prepare<RunLog>(
        `SELECT * FROM run_logs
        WHERE agent_slug = ?
        ORDER BY created_at DESC
        LIMIT ?`
      )
      .all(agentSlug, limit);
  }

  close(): void {
    this.db.close();
  }
}

// 싱글턴
let _broker: SseBroker | null = null;
export function getBroker(): SseBroker {
  if (!_broker) {
    _broker = new SseBroker();
  }
  return _broker;
}
