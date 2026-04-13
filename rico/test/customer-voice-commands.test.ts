import { expect, test } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import {
  applyCustomerVoiceCommand,
  buildCustomerVoiceStatusText,
  parseCustomerVoiceCommand,
} from "../src/slack/customer-voice-commands";
import { openStore } from "../src/state/store";
import { ensureProjectCustomerVoiceProfile, readProjectCustomerVoiceProfile } from "../src/orchestrator/customer-voice-director";

test("parseCustomerVoiceCommand detects status requests", () => {
  expect(parseCustomerVoiceCommand("고객관점 상태")).toEqual({ type: "status" });
});

test("parseCustomerVoiceCommand parses mode updates", () => {
  expect(parseCustomerVoiceCommand("고객관점 모드: persona-driven")).toEqual({
    type: "set-mode",
    mode: "persona-driven",
  });
});

test("parseCustomerVoiceCommand strips Slack auto-link wrapping from base urls", () => {
  expect(parseCustomerVoiceCommand("고객관점 base-url: <https://example.com>")).toEqual({
    type: "set-base-url",
    baseUrl: "https://example.com",
  });
});

test("parseCustomerVoiceCommand parses persona additions", () => {
  expect(
    parseCustomerVoiceCommand(
      "고객관점 페르소나 추가: 운영 리더 | AI employee 도입 가치를 빨리 판단한다 | 효과가 추상적이면 도입을 미룬다, 내부 용어가 많으면 신뢰가 떨어진다 | 랜딩,메시지,도입 | 도입 이유와 다음 행동이 명확하다",
    ),
  ).toEqual({
    type: "add-persona",
    persona: {
      label: "운영 리더",
      jobToBeDone: "AI employee 도입 가치를 빨리 판단한다",
      pains: ["효과가 추상적이면 도입을 미룬다", "내부 용어가 많으면 신뢰가 떨어진다"],
      triggers: ["랜딩", "메시지", "도입"],
      desiredOutcome: "도입 이유와 다음 행동이 명확하다",
    },
  });
});

test("applyCustomerVoiceCommand updates simulation settings and persona memory", () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  ensureProjectCustomerVoiceProfile({
    memoryStore,
    projectId: "test",
  });

  applyCustomerVoiceCommand({
    memoryStore,
    projectId: "test",
    command: {
      type: "set-base-url",
      baseUrl: "http://127.0.0.1:5173",
    },
  });
  applyCustomerVoiceCommand({
    memoryStore,
    projectId: "test",
    command: {
      type: "set-journeys",
      journeys: ["/", "/ai-employee"],
    },
  });
  applyCustomerVoiceCommand({
    memoryStore,
    projectId: "test",
    command: {
      type: "set-credentials",
      credentialRefs: ["TEST_EMAIL", "TEST_PASSWORD"],
    },
  });
  applyCustomerVoiceCommand({
    memoryStore,
    projectId: "test",
    command: {
      type: "add-persona",
      persona: {
        label: "베타 사용자",
        jobToBeDone: "채널 목적을 빠르게 파악한다.",
        pains: ["가치가 불명확하면 바로 이탈한다."],
        triggers: ["랜딩"],
        desiredOutcome: "한 줄 약속과 CTA가 명확하다.",
      },
    },
  });

  const profile = readProjectCustomerVoiceProfile({
    memoryStore,
    projectId: "test",
  });

  expect(profile.simulation.baseUrl).toBe("http://127.0.0.1:5173");
  expect(profile.simulation.allowedJourneys).toEqual(["/", "/ai-employee"]);
  expect(profile.simulation.credentialRefs).toEqual(["TEST_EMAIL", "TEST_PASSWORD"]);
  expect(profile.personas.some((persona) => persona.label === "베타 사용자")).toBe(true);

  store.db.close();
});

test("buildCustomerVoiceStatusText summarizes mode, setup, personas, and simulation", () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  ensureProjectCustomerVoiceProfile({
    memoryStore,
    projectId: "sherpalabs",
  });

  const text = buildCustomerVoiceStatusText({
    projectId: "sherpalabs",
    profile: readProjectCustomerVoiceProfile({
      memoryStore,
      projectId: "sherpalabs",
    }),
  });

  expect(text.includes("고객관점 설정")).toBe(true);
  expect(text.includes("persona-driven")).toBe(true);
  expect(text.includes("운영 리더")).toBe(true);
  expect(text.includes("시뮬레이션")).toBe(true);

  store.db.close();
});
