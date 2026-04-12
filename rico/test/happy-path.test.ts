import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createHarness } from "./helpers/harness";

test("goal intake creates goal threads, splits oversized work, and requests deployment approval", async () => {
  const harness = await createHarness();

  await harness.receiveAiOpsGoal({
    channelId: "C_AI_OPS",
    projectId: "mypetroutine",
    text: "온보딩 개선, 리텐션 리포트, 배포까지 준비해",
    specialistTasks: 10,
  });

  expect(harness.store.listInitiatives().length).toBe(1);
  expect(harness.store.listGoals().length).toBeGreaterThan(1);
  expect(existsSync(harness.artifactDir)).toBe(true);

  const projectRootThreads = 
    harness.messages
      .filter((message) => message.channelId === "C_MYPETROUTINE" && message.kind === "root")
      .map((message) => message.threadTs);
  expect(new Set(projectRootThreads).size).toBe(harness.store.listGoals().length);
  for (const threadTs of projectRootThreads) {
    expect(
      harness.messages.some(
        (message) =>
          message.channelId === "C_MYPETROUTINE" &&
          message.kind === "impact" &&
          message.threadTs === threadTs &&
          message.text.includes("QA에서 확인해보니"),
      ),
    ).toBe(true);
    expect(
      harness.messages.some(
        (message) =>
          message.channelId === "C_MYPETROUTINE" &&
          message.kind === "impact" &&
          message.threadTs === threadTs &&
          message.text.includes("고객 관점에서는"),
      ),
    ).toBe(true);
    expect(
      harness.messages.some(
        (message) =>
          message.channelId === "C_MYPETROUTINE" &&
          message.kind === "summary" &&
          message.threadTs === threadTs,
      ),
    ).toBe(true);
  }

  expect(harness.store.latestApproval()?.type).toBe("deploy");
  expect(harness.store.latestApproval()?.status).toBe("pending");
  expect(harness.store.latestGoalState()).toBe("awaiting_human_approval");
  const latestApproval = harness.store.latestApproval();
  const latestGoal = harness.store.listGoals().at(-1);

  const approvalMessage = harness.messages.find(
    (message) => message.channelId === "C_AI_OPS" && message.kind === "approval",
  );
  expect(approvalMessage?.metadata).toMatchObject({
    approvalId: latestApproval?.id,
    goalId: latestGoal?.id,
    channelId: "C_AI_OPS",
    threadTs: "aiops-thread-mypetroutine-1",
  });
  expect(JSON.stringify(approvalMessage?.blocks ?? [])).toContain("approval:approve");
  expect(JSON.stringify(approvalMessage?.blocks ?? [])).toContain("approval:reject");
  expect(JSON.stringify(approvalMessage?.blocks ?? [])).toContain(latestApproval?.id ?? "");

  expect(
    harness.messages
      .filter((message) => message.channelId === "C_AI_OPS")
      .every((message) => message.kind === "intake" || message.kind === "approval"),
  ).toBe(true);
  expect(
    harness.messages.some(
      (message) =>
        message.channelId === "C_MYPETROUTINE" && message.kind === "summary",
    ),
  ).toBe(true);

  await harness.close();
});
