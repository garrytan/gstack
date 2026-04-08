/**
 * src/__tests__/lib.utils.test.ts
 * lib/utils.ts — formatDuration, formatRelativeTime, sanitizeId 순수 함수 테스트
 *
 * 우선순위 1: 순수 함수이므로 mock 불필요, 가장 빠른 검증
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatDuration,
  formatRelativeTime,
  sanitizeId,
} from "@/lib/utils";

// ─────────────────────────────────────────────────────────────
// formatDuration
// ─────────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("ms 미만 — N ms 표시", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("1초 이상 60초 미만 — Ns 표시", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(1500)).toBe("2s"); // Math.round(1.5) = 2
    expect(formatDuration(30000)).toBe("30s");
    expect(formatDuration(59999)).toBe("60s"); // round → 60s 경계
  });

  it("60초 — 1m 표시 (나머지 0)", () => {
    expect(formatDuration(60000)).toBe("1m");
  });

  it("1분 이상 — Nm Ns 표시 (나머지 있을 때)", () => {
    // 90초 = 1분 30초
    expect(formatDuration(90000)).toBe("1m 30s");
    // 125초 = 2분 5초
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("정확히 N분 — Nm 표시 (나머지 0)", () => {
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(300000)).toBe("5m");
  });

  it("큰 값 — 올바른 분/초 계산", () => {
    // 3661초 = 61분 1초
    expect(formatDuration(3661000)).toBe("61m 1s");
  });
});

// ─────────────────────────────────────────────────────────────
// formatRelativeTime
// ─────────────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("500ms 전 — just now", () => {
    const ts = new Date(now - 500).toISOString();
    expect(formatRelativeTime(ts)).toBe("just now");
  });

  it("정확히 1000ms 전 — 1s ago", () => {
    const ts = new Date(now - 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe("1s ago");
  });

  it("30초 전 — 30s ago", () => {
    const ts = new Date(now - 30_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("30s ago");
  });

  it("59초 전 — 59s ago (분 경계 직전)", () => {
    const ts = new Date(now - 59_999).toISOString();
    expect(formatRelativeTime(ts)).toBe("59s ago");
  });

  it("1분 전 — 1m ago", () => {
    const ts = new Date(now - 60_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("1m ago");
  });

  it("30분 전 — 30m ago", () => {
    const ts = new Date(now - 30 * 60_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("30m ago");
  });

  it("59분 전 — 59m ago (시 경계 직전)", () => {
    const ts = new Date(now - 59 * 60_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("59m ago");
  });

  it("1시간 전 — 1h ago", () => {
    const ts = new Date(now - 3_600_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("1h ago");
  });

  it("24시간 전 — 24h ago", () => {
    const ts = new Date(now - 24 * 3_600_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("24h ago");
  });

  it("유효하지 않은 타임스탬프 — NaN 처리 (방어)", () => {
    // 미래 ts → diff < 0 → just now 처리 또는 NaN
    const futureTs = new Date(now + 5000).toISOString();
    const result = formatRelativeTime(futureTs);
    // diff < 0 이면 if (diff < 1000) → "just now"
    expect(result).toBe("just now");
  });
});

// ─────────────────────────────────────────────────────────────
// sanitizeId
// ─────────────────────────────────────────────────────────────

describe("sanitizeId", () => {
  it("영문자는 그대로 유지", () => {
    expect(sanitizeId("hello")).toBe("hello");
    expect(sanitizeId("ABC")).toBe("ABC");
  });

  it("숫자는 그대로 유지", () => {
    expect(sanitizeId("123")).toBe("123");
    expect(sanitizeId("abc123")).toBe("abc123");
  });

  it("특수문자는 언더스코어로 치환", () => {
    expect(sanitizeId("hello-world")).toBe("hello_world");
    expect(sanitizeId("feature/foo.bar")).toBe("feature_foo_bar");
    expect(sanitizeId("my pipeline 2025")).toBe("my_pipeline_2025");
  });

  it("한글 포함 — 모두 언더스코어로 치환", () => {
    expect(sanitizeId("dev_맥북위젯")).toBe("dev_______");
  });

  it("빈 문자열 — 빈 문자열 반환", () => {
    expect(sanitizeId("")).toBe("");
  });

  it("slug 형태 처리 — 언더스코어 유지, 하이픈 치환", () => {
    expect(sanitizeId("dev_PhaseB-test")).toBe("dev_PhaseB_test");
  });
});
