/**
 * src/__tests__/setup.ts
 * Vitest 글로벌 셋업 — jest-dom matcher, window 모킹
 */

import "@testing-library/jest-dom";

// ─────────────────────────────────────────────────────────────
// window.matchMedia mock (useTheme 테스트용)
// ─────────────────────────────────────────────────────────────

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: query.includes("dark") ? false : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// ─────────────────────────────────────────────────────────────
// localStorage mock (jsdom 기본 제공 — 명시적 초기화)
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

// ─────────────────────────────────────────────────────────────
// EventSource mock (SseClient 테스트용)
// ─────────────────────────────────────────────────────────────

export class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = MockEventSource.CONNECTING;
  private listeners: Map<string, Set<EventListener>> = new Map();
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  // 테스트에서 이벤트를 직접 발생시키기 위한 헬퍼
  dispatchMockEvent(type: string, data: unknown) {
    const event = new MessageEvent(type, {
      data: JSON.stringify(data),
    });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  // 에러 이벤트 발생
  dispatchError() {
    const event = new Event("error");
    this.listeners.get("error")?.forEach((listener) => listener(event));
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

// 전역 EventSource를 MockEventSource로 교체
global.EventSource = MockEventSource as unknown as typeof EventSource;
