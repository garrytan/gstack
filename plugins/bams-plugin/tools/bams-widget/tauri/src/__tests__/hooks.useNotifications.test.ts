/**
 * src/__tests__/hooks.useNotifications.test.ts
 * hooks/useNotifications.ts — 알림 발송 조건 + debounce 테스트
 *
 * 우선순위 4
 *   - 권한 초기화: isPermissionGranted → requestPermission
 *   - pipeline_end 이벤트 수신 시 알림 발송
 *   - paused 상태는 알림 발송 안 함
 *   - 10초 debounce: 같은 slug 중복 방지
 *   - enabled=false 시 알림 미발송
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNotifications } from "@/hooks/useNotifications";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// ─────────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────────

describe("useNotifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // mock 함수 초기화
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    vi.mocked(requestPermission).mockResolvedValue("granted");
    vi.mocked(sendNotification).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── 권한 초기화 ────────────────────────────────────────────

  describe("권한 초기화", () => {
    it("이미 권한 있을 때 → permissionGranted: true", async () => {
      vi.mocked(isPermissionGranted).mockResolvedValue(true);
      const { result } = renderHook(() => useNotifications());

      await waitFor(() => {
        expect(result.current.permissionGranted).toBe(true);
      });
    });

    it("권한 없을 때 → requestPermission 호출 후 granted이면 true", async () => {
      vi.mocked(isPermissionGranted).mockResolvedValue(false);
      vi.mocked(requestPermission).mockResolvedValue("granted");

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => {
        expect(result.current.permissionGranted).toBe(true);
      });
      expect(requestPermission).toHaveBeenCalled();
    });

    it("권한 거부 시 → permissionGranted: false", async () => {
      vi.mocked(isPermissionGranted).mockResolvedValue(false);
      vi.mocked(requestPermission).mockResolvedValue("denied");

      const { result } = renderHook(() => useNotifications());
      await waitFor(() => {
        expect(result.current.permissionGranted).toBe(false);
      });
    });

    it("enabled=false 이면 권한 요청 안 함", async () => {
      renderHook(() => useNotifications({ enabled: false }));
      await vi.runAllTimersAsync();
      expect(isPermissionGranted).not.toHaveBeenCalled();
    });
  });

  // ── handleEvent — pipeline_end 알림 발송 ──────────────────

  describe("handleEvent — 알림 발송 조건", () => {
    it("pipeline_end(completed) → sendNotification 호출", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "completed",
          pipeline_slug: "test-pipeline",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).toHaveBeenCalledWith({
        title: "✅ Pipeline Completed",
        body: "test-pipeline",
      });
    });

    it("pipeline_end(failed) → sendNotification 호출 (❌ 타이틀)", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "failed",
          pipeline_slug: "fail-pipeline",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).toHaveBeenCalledWith({
        title: "❌ Pipeline Failed",
        body: "fail-pipeline",
      });
    });

    it("pipeline_end(rolled_back) → sendNotification 호출 (⚠️ 타이틀)", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "rolled_back",
          pipeline_slug: "rb-pipeline",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).toHaveBeenCalledWith({
        title: "⚠️ Pipeline Rolled Back",
        body: "rb-pipeline",
      });
    });

    it("pipeline_end(paused) → sendNotification 호출 안 함", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "paused",
          pipeline_slug: "paused-pipeline",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("pipeline_end가 아닌 이벤트 → 무시", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        result.current.handleEvent("agent_start", { call_id: "test", type: "agent_start", ts: "2026-04-08T00:00:00Z" });
        result.current.handleEvent("heartbeat", {});
      });

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("enabled=false 이면 알림 미발송", async () => {
      const { result } = renderHook(() => useNotifications({ enabled: false }));
      await vi.runAllTimersAsync();

      act(() => {
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "completed",
          pipeline_slug: "test-pipeline",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("type이 맞지 않는 data — isPipelineEndEvent false → 무시", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        // type 필드가 pipeline_end가 아님
        result.current.handleEvent("pipeline_end", {
          type: "agent_start",
          status: "completed",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).not.toHaveBeenCalled();
    });
  });

  // ── 10초 debounce — 중복 알림 방지 ───────────────────────

  describe("10초 debounce — 중복 방지", () => {
    it("같은 slug로 10초 내 두 번 이벤트 → 첫 번째만 알림", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      const event = {
        type: "pipeline_end",
        status: "completed",
        pipeline_slug: "dup-pipeline",
        ts: "2026-04-08T00:00:00Z",
      };

      act(() => {
        result.current.handleEvent("pipeline_end", event);
      });

      act(() => {
        result.current.handleEvent("pipeline_end", event); // 중복
      });

      // sendNotification은 1번만 호출
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it("10초 후 동일 slug → 다시 알림 발송", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      const event = {
        type: "pipeline_end",
        status: "completed",
        pipeline_slug: "dup-pipeline",
        ts: "2026-04-08T00:00:00Z",
      };

      act(() => {
        result.current.handleEvent("pipeline_end", event);
      });

      // 10초 경과
      act(() => {
        vi.advanceTimersByTime(10_001);
      });

      act(() => {
        result.current.handleEvent("pipeline_end", event);
      });

      expect(sendNotification).toHaveBeenCalledTimes(2);
    });

    it("다른 slug는 각각 독립적으로 알림", async () => {
      const { result } = renderHook(() => useNotifications());
      await waitFor(() => expect(result.current.permissionGranted).toBe(true));

      act(() => {
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "completed",
          pipeline_slug: "pipeline-a",
          ts: "2026-04-08T00:00:00Z",
        });
        result.current.handleEvent("pipeline_end", {
          type: "pipeline_end",
          status: "failed",
          pipeline_slug: "pipeline-b",
          ts: "2026-04-08T00:00:00Z",
        });
      });

      expect(sendNotification).toHaveBeenCalledTimes(2);
    });
  });
});
