/**
 * src/hooks/useNotifications.ts
 * TASK-013: macOS 네이티브 알림 시스템
 *
 * - @tauri-apps/plugin-notification 사용
 * - pipeline_end SSE 이벤트 수신 시 Notification Center 알림 발송
 * - 10초 debounce (같은 pipeline_slug 중복 방지)
 * - macOS 알림 권한 요청 처리 (isPermissionGranted → requestPermission)
 *
 * 사용법:
 *   const { permissionGranted, handleEvent } = useNotifications();
 *   const { state } = useSSE({ pipeline: "global", onEvent: handleEvent });
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isPipelineEndEvent } from "@/lib/sse";

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

/** 같은 pipeline_slug에 대한 중복 알림 방지 시간 (10초) */
const DEBOUNCE_MS = 10_000;

// ─────────────────────────────────────────────────────────────
// 알림 결정 테이블 (§4.5.3)
// ─────────────────────────────────────────────────────────────

type NotifiableStatus = "completed" | "failed" | "rolled_back";

const NOTIFICATION_MAP: Record<NotifiableStatus, { title: string }> = {
  completed: { title: "✅ Pipeline Completed" },
  failed: { title: "❌ Pipeline Failed" },
  rolled_back: { title: "⚠️ Pipeline Rolled Back" },
};

function isNotifiableStatus(
  status: string
): status is NotifiableStatus {
  return status === "completed" || status === "failed" || status === "rolled_back";
}

// ─────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────

export interface UseNotificationsOptions {
  /**
   * 알림 클릭 시 콜백 (옵션).
   * 향후 Tauri v2 notification action listener 안정화 후 바인딩 예정.
   */
  onNotificationClick?: (pipelineSlug: string) => void;
  /** false이면 알림 기능 비활성화 (기본값: true) */
  enabled?: boolean;
}

export interface UseNotificationsReturn {
  /** macOS 알림 권한 허용 여부 */
  permissionGranted: boolean;
  /**
   * pipeline_end 이벤트 처리 함수.
   * useSSE의 onEvent 콜백으로 직접 전달 가능.
   *
   * @example
   * const { handleEvent } = useNotifications();
   * const { state } = useSSE({ pipeline: "global", onEvent: handleEvent });
   */
  handleEvent: (type: string, data: unknown) => void;
}

// ─────────────────────────────────────────────────────────────
// Hook 구현
// ─────────────────────────────────────────────────────────────

export function useNotifications({
  onNotificationClick,
  enabled = true,
}: UseNotificationsOptions = {}): UseNotificationsReturn {
  const [permissionGranted, setPermissionGranted] = useState(false);

  // pipeline_slug → debounce timer
  const debounceMapRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // 콜백 ref — stale closure 방지
  const onClickRef = useRef(onNotificationClick);
  onClickRef.current = onNotificationClick;

  // ── 권한 초기화 ──────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function initPermission() {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const permission = await requestPermission();
          granted = permission === "granted";
        }
        if (!cancelled) {
          setPermissionGranted(granted);
        }
      } catch {
        // 권한 API 에러는 무시 (데스크탑 이외 환경 대비)
      }
    }

    void initPermission();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // ── debounce 타이머 cleanup ───────────────────────────────

  useEffect(() => {
    const map = debounceMapRef.current;
    return () => {
      for (const timer of map.values()) {
        clearTimeout(timer);
      }
      map.clear();
    };
  }, []);

  // ── 이벤트 핸들러 ────────────────────────────────────────

  const handleEvent = useCallback(
    (type: string, data: unknown) => {
      if (!enabled) return;
      if (type !== "pipeline_end") return;
      if (!isPipelineEndEvent(data)) return;

      const { status, pipeline_slug } = data;

      // paused는 알림 발송하지 않음
      if (!isNotifiableStatus(status)) return;

      const slug = pipeline_slug ?? "";

      // 10초 debounce — 같은 slug 중복 방지
      if (debounceMapRef.current.has(slug)) return;

      const { title } = NOTIFICATION_MAP[status];
      const body = slug;

      sendNotification({ title, body });

      // 향후 notification action listener 연동 시 onNotificationClick 호출 지점
      // 현재는 Tauri v2 API 안정화 대기 중
      // onClickRef.current?.(slug);

      const timer = setTimeout(() => {
        debounceMapRef.current.delete(slug);
      }, DEBOUNCE_MS);

      debounceMapRef.current.set(slug, timer);
    },
    [enabled]
  );

  return { permissionGranted, handleEvent };
}
