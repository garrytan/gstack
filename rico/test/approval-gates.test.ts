import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAction, recordRiskAccepted } from "../src/orchestrator/approvals";
import { buildApprovalRequest } from "../src/slack/publish";
import { handleApprovalInteraction } from "../src/slack/interactions";
import { openStore } from "../src/state/store";

async function withStore<T>(
  fn: (store: ReturnType<typeof openStore>) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rico-approval-"));
  const dbPath = join(dir, "rico.sqlite");
  const store = openStore(dbPath);

  try {
    return await fn(store);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedApprovalFixture(store: ReturnType<typeof openStore>, approvalId = "approval-1") {
  store.repositories.projects.create({
    id: "project-1",
    slackChannelId: "C_PROJECT",
  });
  store.repositories.goals.create({
    id: "goal-1",
    initiativeId: null,
    projectId: "project-1",
    title: "Deploy the onboarding refresh",
    state: "awaiting_human_approval",
  });
  store.repositories.approvals.create({
    id: approvalId,
    goalId: "goal-1",
    type: "deploy",
    status: "pending",
    rationale: "deployment is a protected action",
  });
}

test("deployment requires human approval", () => {
  const result = evaluateAction({ type: "deploy" });

  expect(result.state).toBe("awaiting_human_approval");
  expect(result.allowed).toBe(false);
});

test("risk accepted records rationale and actor", () => {
  const event = recordRiskAccepted({
    actor: "petnow",
    action: "deploy",
    rationale: "ship hotfix now",
    now: () => "2026-04-12T13:00:00.000Z",
  });

  expect(event.type).toBe("risk_accepted");
  expect(event.rationale).toBe("ship hotfix now");
  expect(event.actor).toBe("petnow");
  expect(event.createdAt).toBe("2026-04-12T13:00:00.000Z");
});

test("buildApprovalRequest includes action type, blocking reason, buttons, and thread metadata", () => {
  const request = buildApprovalRequest({
    approvalId: "approval-1",
    goalId: "goal-1",
    actionType: "deploy",
    blockingReason: "deployment requires human approval",
    channelId: "C_PROJECT",
    threadTs: "1710000000.000400",
  });

  expect(request.text).toContain("deploy");
  expect(request.text).toContain("deployment requires human approval");
  expect(JSON.stringify(request.blocks)).toContain("Approve");
  expect(JSON.stringify(request.blocks)).toContain("Reject");
  expect(request.metadata).toEqual({
    approvalId: "approval-1",
    goalId: "goal-1",
    channelId: "C_PROJECT",
    threadTs: "1710000000.000400",
  });
});

test("approve callback transitions pending approval to approved", async () => {
  await withStore(async (store) => {
    seedApprovalFixture(store);

    const result = await handleApprovalInteraction({
      db: store.db,
      action: "approve",
      approvalId: "approval-1",
      actor: "petnow",
      now: () => "2026-04-12T13:05:00.000Z",
    });

    expect(result.nextState).toBe("approved");
    expect(result.threadMessage).toContain("승인됐어요");
    expect(store.repositories.approvals.listByGoal("goal-1")[0]?.status).toBe("approved");
    expect(store.repositories.goals.get("goal-1")?.state).toBe("approved");
  });
});

test("reject callback updates approval row and returns a rejection thread summary", async () => {
  await withStore(async (store) => {
    seedApprovalFixture(store, "approval-2");

    const result = await handleApprovalInteraction({
      db: store.db,
      action: "reject",
      approvalId: "approval-2",
      actor: "petnow",
      now: () => "2026-04-12T13:06:00.000Z",
    });

    expect(result.nextState).toBe("rejected");
    expect(result.threadMessage).toContain("반려됐어요");
    expect(store.repositories.approvals.listByGoal("goal-1")[0]?.status).toBe("rejected");
    expect(store.repositories.goals.get("goal-1")?.state).toBe("rejected");
  });
});

test("stale callbacks cannot overturn a recorded approval decision", async () => {
  await withStore(async (store) => {
    seedApprovalFixture(store, "approval-3");

    await handleApprovalInteraction({
      db: store.db,
      action: "reject",
      approvalId: "approval-3",
      actor: "petnow",
      now: () => "2026-04-12T13:07:00.000Z",
    });

    await expect(
      handleApprovalInteraction({
        db: store.db,
        action: "approve",
        approvalId: "approval-3",
        actor: "petnow",
        now: () => "2026-04-12T13:08:00.000Z",
      }),
    ).rejects.toThrow("approval is already resolved");

    expect(store.repositories.approvals.listByGoal("goal-1")[0]?.status).toBe("rejected");
    expect(store.repositories.goals.get("goal-1")?.state).toBe("rejected");
  });
});

test("approval state and goal transition stay in sync when transition append fails", async () => {
  await withStore(async (store) => {
    seedApprovalFixture(store, "approval-4");
    store.repositories.stateTransitions.append({
      id: "approval-4:approve:2026-04-12T13:09:00.000Z",
      goalId: "goal-1",
      fromState: "awaiting_human_approval",
      toState: "noop",
      createdAt: "2026-04-12T13:00:00.000Z",
      actor: "seed",
    });

    await expect(
      handleApprovalInteraction({
        db: store.db,
        action: "approve",
        approvalId: "approval-4",
        actor: "petnow",
        now: () => "2026-04-12T13:09:00.000Z",
      }),
    ).rejects.toThrow();

    expect(store.repositories.approvals.listByGoal("goal-1")[0]?.status).toBe("pending");
    expect(store.repositories.goals.get("goal-1")?.state).toBe("noop");
  });
});
