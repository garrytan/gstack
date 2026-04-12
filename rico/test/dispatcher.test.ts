import { expect, test } from "bun:test";
import { createRuntimeDispatcher } from "../src/runtime/dispatcher";
import { openStore } from "../src/state/store";
import type { LoadedRunContext } from "../src/runtime/job-runner";

function seedContext(input: {
  store: ReturnType<typeof openStore>;
  projectId: string;
  projectChannelId: string;
  goalId: string;
  goalTitle: string;
  runId: string;
  payload?: Record<string, unknown>;
}): LoadedRunContext {
  input.store.repositories.projects.create({
    id: input.projectId,
    slackChannelId: input.projectChannelId,
  });
  input.store.repositories.goals.create({
    id: input.goalId,
    projectId: input.projectId,
    initiativeId: null,
    title: input.goalTitle,
    state: "planned",
  });
  input.store.repositories.runs.create({
    id: input.runId,
    goalId: input.goalId,
    status: "running",
    queuedAt: "2026-04-12T15:00:00.000Z",
    startedAt: "2026-04-12T15:00:05.000Z",
    finishedAt: null,
  });

  const goal = input.store.repositories.goals.get(input.goalId);
  const project = input.store.repositories.projects.get(input.projectId);
  const run = input.store.repositories.runs.get(input.runId);
  if (!goal || !project || !run) {
    throw new Error("Failed to seed dispatch context");
  }

  return {
    job: {
      id: input.runId,
      goalId: input.goalId,
      kind: "event",
      payload: {
        goalId: input.goalId,
        projectId: input.projectId,
        text: input.goalTitle,
        aiOpsChannelId: "C_AI_OPS",
        intakeThreadTs: "1710000000.000200",
        projectChannelId: input.projectChannelId,
        sourceChannelId: "C_AI_OPS",
        isFinalGoal: false,
        requiresDeployApproval: false,
        ...input.payload,
      },
    },
    goal,
    project,
    run,
    target: "governor",
  };
}

test("dispatcher releases the governor slot after a Slack failure", async () => {
  const store = openStore(":memory:");
  let postCount = 0;
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    slackClient: {
      async postMessage() {
        postCount += 1;
        if (postCount === 1) {
          return { ok: false };
        }
        return { ok: true, ts: `171000000${postCount}.000100` };
      },
    },
  });

  const firstContext = seedContext({
    store,
    projectId: "mypetroutine",
    projectChannelId: "C_MYPETROUTINE",
    goalId: "goal-1",
    goalTitle: "온보딩 개선",
    runId: "run-1",
  });
  const secondContext = seedContext({
    store,
    projectId: "sherpalabs",
    projectChannelId: "C_SHERPALABS",
    goalId: "goal-2",
    goalTitle: "보고서 자동화",
    runId: "run-2",
  });

  await expect(dispatcher(firstContext)).rejects.toThrow("Slack rejected project thread root");
  await expect(dispatcher(secondContext)).resolves.toBeUndefined();

  store.db.close();
});

test("dispatcher keeps approval state changes atomic when approval transition insert fails", async () => {
  const store = openStore(":memory:");
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    slackClient: {
      async postMessage() {
        return { ok: true, ts: "1710000001.000100" };
      },
    },
  });

  const context = seedContext({
    store,
    projectId: "mypetroutine",
    projectChannelId: "C_MYPETROUTINE",
    goalId: "goal-1",
    goalTitle: "배포 준비",
    runId: "run-approval",
    payload: {
      isFinalGoal: true,
      requiresDeployApproval: true,
    },
  });

  store.db.query(
    `insert into state_transitions (id, goal_id, from_state, to_state, created_at, actor)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    "transition-approval-run-approval",
    "goal-1",
    null,
    "planned",
    "2026-04-12T15:10:00.000Z",
    "seed",
  );

  await expect(dispatcher(context)).rejects.toThrow();

  expect(store.repositories.approvals.listByGoal("goal-1")).toHaveLength(0);
  expect(store.repositories.goals.get("goal-1")?.state).toBe("in_progress");

  store.db.close();
});

test("dispatcher posts a routing note back to the source thread when a project override changes channels", async () => {
  const store = openStore(":memory:");
  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    slackClient: {
      async postMessage(input) {
        posted.push(input);
        return { ok: true, ts: `171000000${posted.length}.000100` };
      },
    },
  });

  const context = seedContext({
    store,
    projectId: "pet-memorial",
    projectChannelId: "C_PET_MEMORIAL",
    goalId: "goal-cross-project",
    goalTitle: "지금 원격 깃이 연결되어있나?",
    runId: "run-cross-project",
    payload: {
      sourceChannelId: "C_MYPETROUTINE",
      intakeThreadTs: "1710000999.000100",
    },
  });

  await expect(dispatcher(context)).resolves.toBeUndefined();

  expect(
    posted.some(
      (message) =>
        message.channel === "C_MYPETROUTINE"
        && message.thread_ts === "1710000999.000100"
        && message.text.includes("#pet-memorial"),
    ),
  ).toBe(true);

  store.db.close();
});

test("dispatcher uses goal-sensitive specialist narration instead of a fixed onboarding summary", async () => {
  const store = openStore(":memory:");
  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    slackClient: {
      async postMessage(input) {
        posted.push(input);
        return { ok: true, ts: `171000001${posted.length}.000100` };
      },
    },
  });

  const context = seedContext({
    store,
    projectId: "pet-memorial",
    projectChannelId: "C_PET_MEMORIAL",
    goalId: "goal-git-status",
    goalTitle: "지금 원격 깃이 연결되어있나?",
    runId: "run-git-status",
    payload: {
      sourceChannelId: "C_PET_MEMORIAL",
      intakeThreadTs: "1710001999.000100",
    },
  });

  await expect(dispatcher(context)).resolves.toBeUndefined();

  const joined = posted.map((message) => message.text).join("\n");
  expect(joined.includes("온보딩 흐름")).toBe(false);
  expect(joined.includes("원격") || joined.includes("저장소") || joined.includes("깃")).toBe(true);
  expect(joined.includes("백엔드:")).toBe(true);
  expect(joined.includes("기획:")).toBe(false);
  expect(joined.includes("디자인:")).toBe(false);
  expect(joined.includes("프론트엔드:")).toBe(false);
  expect(joined.includes("QA:")).toBe(false);
  expect(joined.includes("고객 관점:")).toBe(false);

  store.db.close();
});

test("dispatcher keeps ideation prompts focused on planner and customer voice", async () => {
  const store = openStore(":memory:");
  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    slackClient: {
      async postMessage(input) {
        posted.push(input);
        return { ok: true, ts: `171000002${posted.length}.000100` };
      },
    },
  });

  const context = seedContext({
    store,
    projectId: "test",
    projectChannelId: "C_TEST",
    goalId: "goal-ideation",
    goalTitle: "이 채널 목표 제안해봐",
    runId: "run-ideation",
    payload: {
      sourceChannelId: "C_TEST",
      intakeThreadTs: "1710002999.000100",
    },
  });

  await expect(dispatcher(context)).resolves.toBeUndefined();

  const joined = posted.map((message) => message.text).join("\n");
  expect(joined.includes("기획:")).toBe(true);
  expect(joined.includes("고객 관점:")).toBe(true);
  expect(joined.includes("QA:")).toBe(false);
  expect(joined.includes("백엔드:")).toBe(false);
  expect(joined.includes("프론트엔드:")).toBe(false);

  store.db.close();
});

test("dispatcher follows captain-selected roles instead of keyword fallback when a captain planner is provided", async () => {
  const store = openStore(":memory:");
  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    captainExecutor: async () => ({
      selectedRoles: ["planner", "customer-voice"],
      nextAction: "먼저 사용자 약속 문장부터 고정한다.",
      blockedReason: null,
      status: "active",
      taskGraph: [
        {
          id: "task-1",
          role: "planner",
          title: "목표 문장 정리",
          dependsOn: [],
        },
        {
          id: "task-2",
          role: "customer-voice",
          title: "사용자 약속과 기대 결과 점검",
          dependsOn: ["task-1"],
        },
      ],
    }),
    slackClient: {
      async postMessage(input) {
        posted.push(input);
        return { ok: true, ts: `171000003${posted.length}.000100` };
      },
    },
  });

  const context = seedContext({
    store,
    projectId: "pet-memorial",
    projectChannelId: "C_PET_MEMORIAL",
    goalId: "goal-captain-selection",
    goalTitle: "배포 전에 사용자 약속 문구를 먼저 정리할까?",
    runId: "run-captain-selection",
    payload: {
      sourceChannelId: "C_PET_MEMORIAL",
      intakeThreadTs: "1710003999.000100",
    },
  });

  await expect(dispatcher(context)).resolves.toBeUndefined();

  const joined = posted.map((message) => message.text).join("\n");
  expect(joined.includes("기획:")).toBe(true);
  expect(joined.includes("고객 관점:")).toBe(true);
  expect(joined.includes("백엔드:")).toBe(false);
  expect(joined.includes("먼저 사용자 약속 문장부터 고정한다.")).toBe(true);
  expect(joined.includes("기획에게 목표 문장 정리")).toBe(true);
  expect(joined.includes("고객 관점에게 사용자 약속과 기대 결과 점검")).toBe(true);

  store.db.close();
});

test("dispatcher keeps ai-ops voice on the governor and includes captain delegation in the routing note", async () => {
  const store = openStore(":memory:");
  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const dispatcher = createRuntimeDispatcher({
    db: store.db,
    maxActiveProjects: 1,
    captainExecutor: async () => ({
      selectedRoles: ["backend"],
      nextAction: "백엔드에게 원격 저장소와 브랜치 상태를 먼저 확인하게 한다.",
      blockedReason: null,
      status: "active",
      taskGraph: [
        {
          id: "task-1",
          role: "backend",
          title: "원격 저장소와 브랜치 상태 확인",
          dependsOn: [],
        },
      ],
    }),
    slackClient: {
      async postMessage(input) {
        posted.push(input);
        return { ok: true, ts: `171000004${posted.length}.000100` };
      },
    },
  });

  const context = seedContext({
    store,
    projectId: "mypetroutine",
    projectChannelId: "C_MYPETROUTINE",
    goalId: "goal-governor-voice",
    goalTitle: "원격 깃 연결 상태만 확인해줘",
    runId: "run-governor-voice",
    payload: {
      sourceChannelId: "C_AI_OPS",
      intakeThreadTs: "1710004999.000100",
    },
  });

  await expect(dispatcher(context)).resolves.toBeUndefined();

  const aiOpsMessages = posted.filter((message) => message.channel === "C_AI_OPS");
  expect(aiOpsMessages.some((message) => message.text.startsWith("총괄:"))).toBe(true);
  expect(
    aiOpsMessages.some(
      (message) =>
        message.text.includes("캡틴에게")
        && message.text.includes("백엔드")
        && message.text.includes("원격 저장소와 브랜치 상태 확인"),
    ),
  ).toBe(true);
  expect(aiOpsMessages.every((message) => !message.text.startsWith("캡틴:"))).toBe(true);

  store.db.close();
});
