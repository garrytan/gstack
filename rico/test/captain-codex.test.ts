import { expect, test } from "bun:test";
import { parseCodexCaptainPlanResponse } from "../src/codex/captain";
import { normalizeCaptainPlanForGoal } from "../src/orchestrator/captain-plan";

test("parseCodexCaptainPlanResponse accepts structured captain planning json", () => {
  const plan = parseCodexCaptainPlanResponse(`
    {
      "selectedRoles": ["planner", "customer-voice"],
      "nextAction": "핵심 목표 문장을 먼저 고정한다.",
      "blockedReason": null,
      "status": "active",
      "taskGraph": [
        {
          "id": "task-1",
          "role": "planner",
          "title": "목표 문장 정리",
          "dependsOn": []
        }
      ]
    }
  `);

  expect(plan).toEqual({
    selectedRoles: ["planner", "customer-voice"],
    nextAction: "핵심 목표 문장을 먼저 고정한다.",
    blockedReason: null,
    status: "active",
    taskGraph: [
      {
        id: "task-1",
        role: "planner",
        title: "목표 문장 정리",
        dependsOn: [],
      },
    ],
  });
});

test("parseCodexCaptainPlanResponse rejects invalid role names", () => {
  expect(() =>
    parseCodexCaptainPlanResponse(`
      {
        "selectedRoles": ["wizard"],
        "nextAction": "정리한다.",
        "blockedReason": null,
        "status": "active",
        "taskGraph": []
      }
    `)
  ).toThrow("Codex captain response was not valid JSON");
});

test("normalizeCaptainPlanForGoal corrects obvious repo questions toward backend", () => {
  const normalized = normalizeCaptainPlanForGoal(
    "지금 원격 깃 연결 상태만 확인해줘",
    {
      selectedRoles: ["planner"],
      nextAction: "planner가 저장소가 Git 작업 트리인지 확인한다.",
      blockedReason: null,
      status: "active",
      taskGraph: [
        {
          id: "task-1",
          role: "planner",
          title: "저장소 확인",
          dependsOn: [],
        },
      ],
    },
  );

  expect(normalized.selectedRoles).toEqual(["backend"]);
  expect(normalized.taskGraph[0]?.role).toBe("backend");
  expect(normalized.nextAction).toContain("원격 저장소");
  expect(normalized.taskGraph[0]?.title).toContain("원격 저장소");
});

test("normalizeCaptainPlanForGoal expands empty task graphs into goal-sensitive delegation titles", () => {
  const normalized = normalizeCaptainPlanForGoal(
    "이 채널 목표를 한 줄로 제안해줘",
    {
      selectedRoles: ["planner", "customer-voice"],
      nextAction: "planner 관점에서 핵심 전제와 다음 단계를 먼저 정리한다.",
      blockedReason: null,
      status: "active",
      taskGraph: [],
    },
  );

  expect(normalized.taskGraph).toHaveLength(2);
  expect(normalized.taskGraph[0]?.title).not.toContain("1차 검토");
  expect(normalized.taskGraph[0]?.title).toContain("목표");
  expect(normalized.taskGraph[1]?.title).toContain("사용자");
});
