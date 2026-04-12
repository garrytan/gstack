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
