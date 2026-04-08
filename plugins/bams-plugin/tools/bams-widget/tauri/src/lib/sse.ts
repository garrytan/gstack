/**
 * src/lib/sse.ts
 * TASK-009: SSE 클라이언트 — EventSource + exponential backoff + 폴링 fallback
 *
 * 특징:
 * - EventSource로 /api/events/stream?pipeline=global 구독
 * - exponential backoff: 3s → 6s → 12s → 24s → 48s (5회)
 * - 5회 실패 시 30초 폴링 모드 전환
 * - 이벤트 버퍼 최대 100개
 * - 연결 상태: connecting | connected | reconnecting | polling | closed
 */

import { BAMS_SERVER_BASE } from "./api";
import type {
  AgentEndEvent,
  AgentStartEvent,
  PipelineEndEvent,
  PipelineEvent,
} from "./types";

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

const MAX_RETRY = 5;
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_MAX_MS = 48_000;
const POLL_INTERVAL_MS = 30_000;
const EVENT_BUFFER_LIMIT = 100;

// ─────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────

export type SseConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "polling"
  | "closed";

export type SseEventHandler = (type: string, data: unknown) => void;

export interface SseClientOptions {
  pipeline?: string;
  onEvent: SseEventHandler;
  onStateChange?: (state: SseConnectionState) => void;
  onError?: (err: unknown) => void;
}

export interface BufferedEvent {
  type: string;
  data: unknown;
  ts: number;
}

// ─────────────────────────────────────────────────────────────
// SSE 클라이언트 클래스
// ─────────────────────────────────────────────────────────────

export class SseClient {
  private es: EventSource | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private state: SseConnectionState = "connecting";
  private buffer: BufferedEvent[] = [];
  private closed = false;

  // SSE에서 구독하는 이벤트 타입 (sse-broker.ts SseEventType 기준)
  private readonly EVENT_TYPES = [
    "connected",
    "agent_start",
    "agent_end",
    "pipeline_end",
    "error_event",
    "task_updated",
    "heartbeat",
    "replay_complete",
  ] as const;

  constructor(private readonly opts: SseClientOptions) {}

  // ── 공개 API ─────────────────────────────────────────────

  /** SSE 연결 시작 */
  connect(): void {
    if (this.closed) return;
    this.setState("connecting");
    this.openEventSource();
  }

  /** SSE 연결 종료 */
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.destroyEventSource();
    this.setState("closed");
  }

  /** 현재 연결 상태 반환 */
  getState(): SseConnectionState {
    return this.state;
  }

  /** 버퍼된 이벤트 스냅샷 반환 */
  getBuffer(): BufferedEvent[] {
    return [...this.buffer];
  }

  /** 버퍼 초기화 */
  clearBuffer(): void {
    this.buffer = [];
  }

  // ── 내부 로직 ─────────────────────────────────────────────

  private buildUrl(): string {
    const qs = new URLSearchParams();
    qs.set("pipeline", this.opts.pipeline ?? "global");
    return `${BAMS_SERVER_BASE}/api/events/stream?${qs.toString()}`;
  }

  private openEventSource(): void {
    if (this.closed) return;

    this.destroyEventSource();

    const es = new EventSource(this.buildUrl());
    this.es = es;

    // 연결 성공
    es.addEventListener("connected", () => {
      this.retryCount = 0;
      this.setState("connected");
    });

    // 이벤트 핸들러 등록
    for (const eventType of this.EVENT_TYPES) {
      es.addEventListener(eventType, (e: Event) => {
        try {
          const raw = (e as MessageEvent).data as string;
          const data = JSON.parse(raw) as unknown;
          this.pushToBuffer(eventType, data);
          this.opts.onEvent(eventType, data);
        } catch {
          // JSON 파싱 실패 무시
        }
      });
    }

    // 에러 처리 → reconnect
    es.addEventListener("error", (e: Event) => {
      if (this.closed) return;
      this.opts.onError?.(e);
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    if (this.closed) return;
    this.destroyEventSource();

    if (this.retryCount >= MAX_RETRY) {
      // 5회 실패 → 폴링 모드 전환
      this.switchToPolling();
      return;
    }

    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.retryCount),
      BACKOFF_MAX_MS
    );
    this.retryCount++;
    this.setState("reconnecting");

    this.retryTimer = setTimeout(() => {
      if (!this.closed) {
        this.openEventSource();
      }
    }, delay);
  }

  private switchToPolling(): void {
    this.setState("polling");

    // 즉시 1회 폴링 후 주기적 반복
    void this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  private async pollOnce(): Promise<void> {
    if (this.closed) return;
    try {
      const url = `${BAMS_SERVER_BASE}/api/workunits/active`;
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as unknown;
        // 폴링 데이터를 가상 이벤트로 emit
        this.pushToBuffer("poll_active", data);
        this.opts.onEvent("poll_active", data);
      }
    } catch {
      // 폴링 실패는 무시 (다음 주기에 재시도)
    }
  }

  private pushToBuffer(type: string, data: unknown): void {
    this.buffer.push({ type, data, ts: Date.now() });
    if (this.buffer.length > EVENT_BUFFER_LIMIT) {
      this.buffer.shift(); // 가장 오래된 이벤트 제거
    }
  }

  private destroyEventSource(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private setState(next: SseConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }
}

// ─────────────────────────────────────────────────────────────
// 이벤트 타입 가드
// ─────────────────────────────────────────────────────────────

export function isAgentStartEvent(e: unknown): e is AgentStartEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as PipelineEvent).type === "agent_start"
  );
}

export function isAgentEndEvent(e: unknown): e is AgentEndEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as PipelineEvent).type === "agent_end"
  );
}

export function isPipelineEndEvent(e: unknown): e is PipelineEndEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as PipelineEvent).type === "pipeline_end"
  );
}
