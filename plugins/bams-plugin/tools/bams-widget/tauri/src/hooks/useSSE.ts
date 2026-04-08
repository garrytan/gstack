/**
 * src/hooks/useSSE.ts
 * TASK-009: SSE React hook — SseClient 생명주기 관리
 *
 * 사용법:
 *   const { state, buffer, clearBuffer } = useSSE({ pipeline: "global", onEvent });
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SseClient, type SseClientOptions, type SseConnectionState, type BufferedEvent } from "@/lib/sse";

// ─────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────

export interface UseSSEOptions {
  /** 구독할 파이프라인 slug (기본값: "global") */
  pipeline?: string;
  /** 이벤트 수신 콜백 */
  onEvent: (type: string, data: unknown) => void;
  /** 에러 콜백 (선택) */
  onError?: (err: unknown) => void;
  /** false이면 연결 안 함 (선택, 기본 true) */
  enabled?: boolean;
}

export interface UseSSEReturn {
  /** 현재 연결 상태 */
  state: SseConnectionState;
  /** 버퍼된 이벤트 스냅샷 (최대 100개) */
  buffer: BufferedEvent[];
  /** 버퍼 초기화 */
  clearBuffer: () => void;
  /** 수동으로 연결 재시도 (폴링 모드에서 SSE 재시도) */
  reconnect: () => void;
}

// ─────────────────────────────────────────────────────────────
// Hook 구현
// ─────────────────────────────────────────────────────────────

export function useSSE({
  pipeline = "global",
  onEvent,
  onError,
  enabled = true,
}: UseSSEOptions): UseSSEReturn {
  const [state, setState] = useState<SseConnectionState>("connecting");
  const [buffer, setBuffer] = useState<BufferedEvent[]>([]);

  // onEvent를 ref로 감싸 stale closure 방지
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const clientRef = useRef<SseClient | null>(null);

  const createClient = useCallback(() => {
    const opts: SseClientOptions = {
      pipeline,
      onEvent: (type, data) => {
        onEventRef.current(type, data);
      },
      onStateChange: (nextState) => {
        setState(nextState);
      },
      onError: (err) => {
        onErrorRef.current?.(err);
      },
    };

    const client = new SseClient(opts);
    clientRef.current = client;
    return client;
  }, [pipeline]);

  // buffer 동기화 — 상태가 바뀔 때마다 클라이언트에서 스냅샷 반영
  const syncBuffer = useCallback(() => {
    if (clientRef.current) {
      setBuffer(clientRef.current.getBuffer());
    }
  }, []);

  const clearBuffer = useCallback(() => {
    clientRef.current?.clearBuffer();
    setBuffer([]);
  }, []);

  const reconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close();
    }
    if (!enabled) return;
    const client = createClient();
    client.connect();
  }, [enabled, createClient]);

  useEffect(() => {
    if (!enabled) return;

    const client = createClient();

    // buffer를 이벤트 수신 시마다 갱신 (SseClient onEvent wrap)
    const origOnEvent = client["opts" as keyof typeof client] as unknown;
    void origOnEvent; // 사용 안 함 — 아래에서 직접 패치

    // SseClient의 onEvent를 래핑하여 buffer 동기화 추가
    // (SseClient 내부 buffer에 pushToBuffer 후 syncBuffer 호출)
    // → SseClient는 이미 onEvent 호출 전 buffer에 push하므로, onEvent에서 syncBuffer 호출
    const wrappedOpts: SseClientOptions = {
      pipeline,
      onEvent: (type, data) => {
        onEventRef.current(type, data);
        // buffer 동기화는 SseClient 내부에서 push 완료 후이므로 동기 OK
        setBuffer(clientRef.current?.getBuffer() ?? []);
      },
      onStateChange: (nextState) => {
        setState(nextState);
        syncBuffer();
      },
      onError: (err) => {
        onErrorRef.current?.(err);
      },
    };

    const finalClient = new SseClient(wrappedOpts);
    clientRef.current = finalClient;
    finalClient.connect();

    return () => {
      finalClient.close();
      clientRef.current = null;
    };
  }, [pipeline, enabled, createClient, syncBuffer]);

  return { state, buffer, clearBuffer, reconnect };
}
