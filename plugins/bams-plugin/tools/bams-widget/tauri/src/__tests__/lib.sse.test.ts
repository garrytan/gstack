/**
 * src/__tests__/lib.sse.test.ts
 * lib/sse.ts — SseClient 클래스 테스트
 *
 * 우선순위 2: 핵심 SSE 로직
 *   - 연결 성공 및 상태 전이
 *   - exponential backoff 재연결 (3s → 6s → 12s → 24s → 48s)
 *   - 5회 실패 시 폴링 모드 전환
 *   - 이벤트 버퍼 최대 100개 제한
 *   - close() 후 상태 전이
 *   - 타입 가드 함수
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import {
  SseClient,
  isAgentStartEvent,
  isAgentEndEvent,
  isPipelineEndEvent,
} from "@/lib/sse";
import { MockEventSource } from "./setup";

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

function createClient(overrides?: Partial<ConstructorParameters<typeof SseClient>[0]>) {
  const onEvent = vi.fn();
  const onStateChange = vi.fn();
  const onError = vi.fn();

  const client = new SseClient({
    pipeline: "global",
    onEvent,
    onStateChange,
    onError,
    ...overrides,
  });

  return { client, onEvent, onStateChange, onError };
}

// ─────────────────────────────────────────────────────────────
// SseClient — 연결 & 기본 상태 전이
// ─────────────────────────────────────────────────────────────

describe("SseClient — 연결 및 기본 동작", () => {
  let mockEs: MockEventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    // EventSource 생성 시 MockEventSource 인스턴스를 캡처
    vi.spyOn(global, "EventSource" as keyof typeof global).mockImplementation(
      (url: string) => {
        mockEs = new MockEventSource(url);
        return mockEs as unknown as EventSource;
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connect() 호출 시 초기 상태는 connecting", () => {
    const { client, onStateChange } = createClient();
    client.connect();
    expect(onStateChange).toHaveBeenCalledWith("connecting");
  });

  it("connected 이벤트 수신 시 상태 → connected, retryCount 리셋", () => {
    const { client, onStateChange } = createClient();
    client.connect();

    mockEs.dispatchMockEvent("connected", { type: "connected" });

    expect(onStateChange).toHaveBeenCalledWith("connected");
  });

  it("이벤트 수신 시 onEvent 콜백 호출 + 버퍼에 저장", () => {
    const { client, onEvent } = createClient();
    client.connect();

    const payload = { type: "agent_start", call_id: "test-1" };
    mockEs.dispatchMockEvent("agent_start", payload);

    expect(onEvent).toHaveBeenCalledWith("agent_start", payload);
    expect(client.getBuffer()).toHaveLength(1);
    expect(client.getBuffer()[0].type).toBe("agent_start");
  });

  it("close() 호출 시 상태 → closed", () => {
    const { client, onStateChange } = createClient();
    client.connect();
    client.close();

    expect(onStateChange).toHaveBeenCalledWith("closed");
    expect(client.getState()).toBe("closed");
  });

  it("closed 상태에서 connect() 재호출 시 무시", () => {
    const EventSourceSpy = vi.spyOn(global, "EventSource" as keyof typeof global);
    const { client } = createClient();
    client.connect();
    client.close();

    const callsBefore = EventSourceSpy.mock.calls.length;
    client.connect(); // closed이므로 무시되어야 함
    expect(EventSourceSpy.mock.calls.length).toBe(callsBefore);
  });

  it("getBuffer()는 스냅샷을 반환 (참조 불변)", () => {
    const { client } = createClient();
    client.connect();
    mockEs.dispatchMockEvent("heartbeat", { type: "heartbeat" });

    const buf1 = client.getBuffer();
    const buf2 = client.getBuffer();
    expect(buf1).not.toBe(buf2); // 다른 배열 참조
    expect(buf1).toEqual(buf2); // 같은 내용
  });

  it("clearBuffer() 호출 후 버퍼 비워짐", () => {
    const { client } = createClient();
    client.connect();
    mockEs.dispatchMockEvent("heartbeat", { type: "heartbeat" });
    expect(client.getBuffer()).toHaveLength(1);

    client.clearBuffer();
    expect(client.getBuffer()).toHaveLength(0);
  });

  it("buildUrl — pipeline 파라미터 포함", () => {
    createClient({ pipeline: "dev_맥북위젯구현" });
    // EventSource 생성 URL 확인
    const EventSourceSpy = vi.spyOn(
      global,
      "EventSource" as keyof typeof global
    );
    const { client } = createClient({ pipeline: "my-pipeline" });
    client.connect();
    const url = (EventSourceSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(url).toContain("pipeline=my-pipeline");
  });
});

// ─────────────────────────────────────────────────────────────
// SseClient — 이벤트 버퍼 100개 제한
// ─────────────────────────────────────────────────────────────

describe("SseClient — 이벤트 버퍼 제한 (max 100)", () => {
  let mockEs: MockEventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(global, "EventSource" as keyof typeof global).mockImplementation(
      (url: string) => {
        mockEs = new MockEventSource(url);
        return mockEs as unknown as EventSource;
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("101번째 이벤트 수신 시 가장 오래된 이벤트 제거 (FIFO)", () => {
    const { client } = createClient();
    client.connect();

    // 100개 채움
    for (let i = 0; i < 100; i++) {
      mockEs.dispatchMockEvent("heartbeat", { seq: i });
    }
    expect(client.getBuffer()).toHaveLength(100);
    expect((client.getBuffer()[0].data as { seq: number }).seq).toBe(0);

    // 101번째 → 첫 번째 제거
    mockEs.dispatchMockEvent("heartbeat", { seq: 100 });
    expect(client.getBuffer()).toHaveLength(100);
    expect((client.getBuffer()[0].data as { seq: number }).seq).toBe(1); // 0번 제거됨
    expect(
      (client.getBuffer()[99].data as { seq: number }).seq
    ).toBe(100); // 마지막은 100번
  });
});

// ─────────────────────────────────────────────────────────────
// SseClient — 재연결 (exponential backoff)
// ─────────────────────────────────────────────────────────────

describe("SseClient — 재연결 (exponential backoff)", () => {
  let mockEs: MockEventSource;
  let EventSourceSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    EventSourceSpy = vi.spyOn(
      global,
      "EventSource" as keyof typeof global
    ).mockImplementation((url: string) => {
      mockEs = new MockEventSource(url);
      return mockEs as unknown as EventSource;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("에러 발생 시 상태 → reconnecting", () => {
    const { client, onStateChange } = createClient();
    client.connect();
    mockEs.dispatchError();
    expect(onStateChange).toHaveBeenCalledWith("reconnecting");
  });

  it("1회 에러 후 3초 backoff 후 재연결 시도", () => {
    const { client } = createClient();
    client.connect();
    const initialCallCount = EventSourceSpy.mock.calls.length;

    mockEs.dispatchError();
    expect(EventSourceSpy.mock.calls.length).toBe(initialCallCount); // 아직 재연결 안 함

    vi.advanceTimersByTime(3000);
    expect(EventSourceSpy.mock.calls.length).toBe(initialCallCount + 1); // 3초 후 재연결
  });

  it("2회 에러 후 6초 backoff (3s * 2^1)", () => {
    const { client } = createClient();
    client.connect();
    const initialCallCount = EventSourceSpy.mock.calls.length;

    // 1회 에러 → 3초 후 재연결
    mockEs.dispatchError();
    vi.advanceTimersByTime(3000); // 재연결됨
    const afterFirst = EventSourceSpy.mock.calls.length;

    // 2회 에러 → 6초 후 재연결
    mockEs.dispatchError();
    vi.advanceTimersByTime(5999); // 6초 미만 — 아직 안 됨
    expect(EventSourceSpy.mock.calls.length).toBe(afterFirst);
    vi.advanceTimersByTime(1); // 6초 도달
    expect(EventSourceSpy.mock.calls.length).toBe(afterFirst + 1);
  });

  it("close() 후 에러 발생 시 재연결 시도 안 함", () => {
    const { client } = createClient();
    client.connect();
    client.close();
    const callsBefore = EventSourceSpy.mock.calls.length;

    // closed 상태에서 에러 — 무시
    mockEs.dispatchError();
    vi.advanceTimersByTime(10000);
    expect(EventSourceSpy.mock.calls.length).toBe(callsBefore);
  });
});

// ─────────────────────────────────────────────────────────────
// SseClient — 5회 실패 후 폴링 모드 전환
// ─────────────────────────────────────────────────────────────

describe("SseClient — 5회 실패 후 폴링 모드 전환", () => {
  let mockEs: MockEventSource;
  let fetchSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(global, "EventSource" as keyof typeof global).mockImplementation(
      (url: string) => {
        mockEs = new MockEventSource(url);
        return mockEs as unknown as EventSource;
      }
    );

    // fetch mock
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ workunit: null }), { status: 200 })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function exhaustRetries(client: SseClient) {
    // 5회 에러 + 각 backoff 대기
    const delays = [3000, 6000, 12000, 24000, 48000];
    for (let i = 0; i < 5; i++) {
      mockEs.dispatchError();
      await vi.runAllTimersAsync();
      if (i < 4) {
        vi.advanceTimersByTime(delays[i]!);
      }
    }
    // 마지막(5번째) 에러로 폴링 전환 트리거
    mockEs.dispatchError();
    await vi.runAllTimersAsync();
  }

  it("5회 에러 후 상태 → polling", async () => {
    const { client, onStateChange } = createClient();
    client.connect();
    await exhaustRetries(client);
    expect(onStateChange).toHaveBeenCalledWith("polling");
  });

  it("polling 모드 전환 시 즉시 fetch 1회 호출", async () => {
    const { client } = createClient();
    client.connect();
    await exhaustRetries(client);
    expect(fetchSpy).toHaveBeenCalled();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/workunits/active");
  });

  it("polling 모드에서 30초마다 반복 fetch", async () => {
    const { client } = createClient();
    client.connect();
    await exhaustRetries(client);

    const callsAfterSwitch = fetchSpy.mock.calls.length;
    vi.advanceTimersByTime(30000);
    await vi.runAllTimersAsync();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterSwitch);
  });

  it("polling 중 onEvent('poll_active') 호출", async () => {
    const { client, onEvent } = createClient();
    client.connect();
    await exhaustRetries(client);
    expect(onEvent).toHaveBeenCalledWith("poll_active", expect.anything());
  });

  it("close() 후 폴링 중단", async () => {
    const { client } = createClient();
    client.connect();
    await exhaustRetries(client);

    const callsBefore = fetchSpy.mock.calls.length;
    client.close();
    vi.advanceTimersByTime(60000); // 2주기 후
    await vi.runAllTimersAsync();
    // close 후 fetch 추가 호출 없음
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });
});

// ─────────────────────────────────────────────────────────────
// 타입 가드 함수
// ─────────────────────────────────────────────────────────────

describe("타입 가드 함수", () => {
  describe("isAgentStartEvent", () => {
    it("type === agent_start 이면 true", () => {
      expect(isAgentStartEvent({ type: "agent_start", ts: "2026-04-08T00:00:00Z" })).toBe(true);
    });
    it("다른 type이면 false", () => {
      expect(isAgentStartEvent({ type: "agent_end", ts: "2026-04-08T00:00:00Z" })).toBe(false);
    });
    it("null이면 false", () => {
      expect(isAgentStartEvent(null)).toBe(false);
    });
    it("원시값이면 false", () => {
      expect(isAgentStartEvent("string")).toBe(false);
    });
  });

  describe("isAgentEndEvent", () => {
    it("type === agent_end 이면 true", () => {
      expect(isAgentEndEvent({ type: "agent_end", ts: "2026-04-08T00:00:00Z" })).toBe(true);
    });
    it("다른 type이면 false", () => {
      expect(isAgentEndEvent({ type: "agent_start", ts: "2026-04-08T00:00:00Z" })).toBe(false);
    });
  });

  describe("isPipelineEndEvent", () => {
    it("type === pipeline_end 이면 true", () => {
      expect(isPipelineEndEvent({ type: "pipeline_end", ts: "2026-04-08T00:00:00Z" })).toBe(true);
    });
    it("다른 type이면 false", () => {
      expect(isPipelineEndEvent({ type: "pipeline_start", ts: "2026-04-08T00:00:00Z" })).toBe(false);
    });
    it("undefined이면 false", () => {
      expect(isPipelineEndEvent(undefined)).toBe(false);
    });
  });
});
