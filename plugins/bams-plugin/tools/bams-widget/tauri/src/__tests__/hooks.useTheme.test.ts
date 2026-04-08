/**
 * src/__tests__/hooks.useTheme.test.ts
 * hooks/useTheme.ts — 테마 전환 로직 테스트
 *
 * 우선순위 3
 *   - 초기 상태: localStorage 없음 → system 모드
 *   - localStorage에 저장된 값 복원
 *   - setMode() 호출 시 localStorage 저장 + resolvedTheme 갱신
 *   - toggleTheme(): dark ↔ light 전환
 *   - system 모드: prefers-color-scheme 변경 반응
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";

// ─────────────────────────────────────────────────────────────
// matchMedia 모킹 헬퍼
// ─────────────────────────────────────────────────────────────

function setupMatchMedia(prefersDark: boolean) {
  const listeners: Array<() => void> = [];

  const mq = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      const idx = listeners.indexOf(listener);
      if (idx > -1) listeners.splice(idx, 1);
    }),
    dispatchEvent: vi.fn(),
  };

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue(mq),
  });

  return { mq, triggerChange: () => listeners.forEach((l) => l()) };
}

// ─────────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────────

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("초기 상태", () => {
    it("localStorage 없을 때 → mode: system", () => {
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());
      expect(result.current.mode).toBe("system");
    });

    it("시스템이 라이트일 때 → resolvedTheme: light", () => {
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());
      expect(result.current.resolvedTheme).toBe("light");
    });

    it("시스템이 다크일 때 → resolvedTheme: dark", () => {
      setupMatchMedia(true);
      const { result } = renderHook(() => useTheme());
      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("localStorage에 'dark' 저장 시 → mode: dark, resolvedTheme: dark", () => {
      localStorage.setItem("bams-widget-theme", "dark");
      setupMatchMedia(false); // 시스템은 라이트이지만 저장값이 우선
      const { result } = renderHook(() => useTheme());
      expect(result.current.mode).toBe("dark");
      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("localStorage에 'light' 저장 시 → mode: light, resolvedTheme: light", () => {
      localStorage.setItem("bams-widget-theme", "light");
      setupMatchMedia(true); // 시스템은 다크이지만 저장값이 우선
      const { result } = renderHook(() => useTheme());
      expect(result.current.mode).toBe("light");
      expect(result.current.resolvedTheme).toBe("light");
    });

    it("localStorage에 잘못된 값 → system으로 폴백", () => {
      localStorage.setItem("bams-widget-theme", "invalid_value");
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());
      expect(result.current.mode).toBe("system");
    });
  });

  describe("setMode()", () => {
    it("setMode('dark') → mode와 resolvedTheme 모두 dark로 변경", () => {
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setMode("dark");
      });

      expect(result.current.mode).toBe("dark");
      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("setMode('light') → localStorage에 'light' 저장", () => {
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setMode("light");
      });

      expect(localStorage.getItem("bams-widget-theme")).toBe("light");
    });

    it("setMode('system') → 시스템 테마로 복귀", () => {
      localStorage.setItem("bams-widget-theme", "dark");
      setupMatchMedia(false); // 시스템 라이트
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setMode("system");
      });

      expect(result.current.mode).toBe("system");
      expect(result.current.resolvedTheme).toBe("light");
    });

    it("setMode() 호출 시 document.documentElement.data-theme 갱신", () => {
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setMode("dark");
      });

      expect(
        document.documentElement.getAttribute("data-theme")
      ).toBe("dark");
    });
  });

  describe("toggleTheme()", () => {
    it("resolvedTheme이 dark일 때 → light로 전환", () => {
      localStorage.setItem("bams-widget-theme", "dark");
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.resolvedTheme).toBe("light");
    });

    it("resolvedTheme이 light일 때 → dark로 전환", () => {
      localStorage.setItem("bams-widget-theme", "light");
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("토글 후 mode는 dark 또는 light (system 해제됨)", () => {
      setupMatchMedia(false);
      const { result } = renderHook(() => useTheme());
      expect(result.current.mode).toBe("system");

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.mode).not.toBe("system");
    });
  });

  describe("system 모드 — OS 변경 반응", () => {
    it("system 모드에서 OS 다크 전환 시 resolvedTheme → dark", () => {
      const { triggerChange } = setupMatchMedia(false); // 초기: 라이트
      const { result } = renderHook(() => useTheme());
      expect(result.current.resolvedTheme).toBe("light");

      // OS가 다크로 바뀜 — matchMedia.matches 변경 후 change 이벤트 발생
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockReturnValue({
          matches: true,
          media: "(prefers-color-scheme: dark)",
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }),
      });

      act(() => {
        triggerChange();
      });

      expect(result.current.resolvedTheme).toBe("dark");
    });
  });
});
