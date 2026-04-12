import { expect, test } from "bun:test";
import { Captain } from "../src/orchestrator/captain";
import { runSpecialist } from "../src/orchestrator/specialists";
import { MemoryStore } from "../src/memory/store";
import { QA_ROLE_PROFILE } from "../src/roles/qa";
import { validateSpecialistResult } from "../src/roles/contracts";
import { openStore } from "../src/state/store";

test("validateSpecialistResult requires role, summary, impact, and artifacts", () => {
  const result = validateSpecialistResult({
    role: "qa",
    summary: "Regression found",
    impact: "blocking",
    artifacts: [{ kind: "report", title: "qa-report.md" }],
  });

  expect(result.ok).toBe(true);
});

test("runSpecialist validates, persists, and returns qa impact", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);

  const result = await runSpecialist({
    role: "qa",
    input: {
      goalId: "goal-1",
      projectId: "mypetroutine",
      runId: "run-1",
      summary: "verify onboarding",
    },
    memoryStore,
  });

  expect(result.role).toBe("qa");
  expect(result.summary).toBe("verify onboarding");
  expect(result.impact).toBe("blocking");
  expect(memoryStore.getRunMemory("run-1")["specialist.qa.impact"]).toBe(
    "blocking",
  );
  expect(
    memoryStore.getRunMemory("run-1")["specialist.qa.result_json"],
  ).toContain('"artifacts"');
  expect(
    memoryStore.getProjectMemory("mypetroutine")[
      "specialist.qa.last_result_json"
    ],
  ).toContain('"rawFindings"');

  db.db.close();
});

test("QA role profile stops on regression and keeps protected actions behind human sign-off", () => {
  expect(QA_ROLE_PROFILE.guardrails).toContain("stop_on_regression");
  expect(QA_ROLE_PROFILE.guardrails).toContain(
    "do_not_approve_release_when_human_signoff_required",
  );
});

test("Captain stores validated specialist results without rewriting impact", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  const captain = new Captain(memoryStore);

  captain.handleAiOpsIntake({
    projectId: "mypetroutine",
    aiOpsChannelId: "C_AI_OPS",
    projectChannelId: "C_PROJECT",
    intakeThreadTs: "1710000000.000100",
    title: "improve onboarding conversion",
  });

  const results = [
    await runSpecialist({
      role: "qa",
      input: {
        goalId: "goal-1",
        projectId: "mypetroutine",
        runId: "run-qa",
        summary: "verify onboarding",
      },
      memoryStore: new MemoryStore(db.db),
    }),
  ];

  captain.captureSpecialistResults("mypetroutine", results);

  expect(captain.getStoredSpecialistResults("mypetroutine")).toEqual(results);
  expect(captain.getStoredSpecialistResults("mypetroutine")[0]?.impact).toBe(
    "blocking",
  );
  expect(
    memoryStore.getProjectMemory("mypetroutine")[
      "captain.specialist.qa.result_json"
    ],
  ).toContain('"impact":"blocking"');

  db.db.close();
});

test("Captain rehydrates intake and specialist results from durable project memory after restart", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  const firstCaptain = new Captain(memoryStore);

  firstCaptain.handleAiOpsIntake({
    projectId: "mypetroutine",
    aiOpsChannelId: "C_AI_OPS",
    projectChannelId: "C_PROJECT",
    intakeThreadTs: "1710000000.000100",
    title: "improve onboarding conversion",
  });

  const results = [
    await runSpecialist({
      role: "qa",
      input: {
        goalId: "goal-1",
        projectId: "mypetroutine",
        runId: "run-qa",
        summary: "verify onboarding",
      },
      memoryStore,
    }),
  ];
  firstCaptain.captureSpecialistResults("mypetroutine", results);

  const restartedCaptain = new Captain(memoryStore);
  expect(restartedCaptain.getPortfolioRecord("mypetroutine")).toMatchObject({
    projectId: "mypetroutine",
    aiOpsChannelId: "C_AI_OPS",
    projectChannelId: "C_PROJECT",
  });
  expect(restartedCaptain.getStoredSpecialistResults("mypetroutine")).toEqual(
    results,
  );

  const narration = restartedCaptain.composeProjectSummary({
    projectId: "mypetroutine",
    projectThreadTs: "1710000000.000300",
    summary: "Recovered after restart",
    impacts: [{ role: "qa", level: "blocking", message: "Regression found" }],
  });
  expect(narration.channelId).toBe("C_PROJECT");

  db.db.close();
});

test("Captain can promote run-scoped specialist results after a restart before project capture ran", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  const firstCaptain = new Captain(memoryStore);

  firstCaptain.handleAiOpsIntake({
    projectId: "mypetroutine",
    aiOpsChannelId: "C_AI_OPS",
    projectChannelId: "C_PROJECT",
    intakeThreadTs: "1710000000.000100",
    title: "improve onboarding conversion",
  });

  const result = await runSpecialist({
    role: "qa",
    input: {
      goalId: "goal-1",
      projectId: "mypetroutine",
      runId: "run-recovery",
      summary: "verify onboarding",
    },
    memoryStore,
  });

  const restartedCaptain = new Captain(memoryStore);
  expect(
    restartedCaptain.promoteRunResultsToProject(
      "mypetroutine",
      "run-recovery",
    ),
  ).toEqual([result]);
  expect(restartedCaptain.getStoredSpecialistResults("mypetroutine")).toEqual([
    result,
  ]);

  db.db.close();
});

test("planner, designer, customer voice, frontend, backend, and qa all flow through the same specialist path", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  const roles = [
    "planner",
    "designer",
    "customer-voice",
    "frontend",
    "backend",
    "qa",
  ] as const;

  const results = await Promise.all(
    roles.map((role) =>
      runSpecialist({
        role,
        input: {
          goalId: `goal-${role}`,
          projectId: "mypetroutine",
          runId: `run-${role}`,
          summary: `execute ${role}`,
        },
        memoryStore,
      }),
    ),
  );

  expect(results.map((result) => result.role)).toEqual(roles);
  for (const role of roles) {
    expect(memoryStore.getRunMemory(`run-${role}`)[`specialist.${role}.impact`]).toBeDefined();
  }

  db.db.close();
});

test("runSpecialist derives role-specific summaries from the current goal when no canned summary is given", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);

  const qaResult = await runSpecialist({
    role: "qa",
    input: {
      goalId: "goal-git",
      projectId: "pet-memorial",
      runId: "run-git",
      goalTitle: "지금 원격 깃이 연결되어있나?",
    },
    memoryStore,
  });
  const customerVoiceResult = await runSpecialist({
    role: "customer-voice",
    input: {
      goalId: "goal-git",
      projectId: "pet-memorial",
      runId: "run-git",
      goalTitle: "지금 원격 깃이 연결되어있나?",
    },
    memoryStore,
  });

  expect(qaResult.summary).not.toBe("verifyGoal completed");
  expect(customerVoiceResult.summary).not.toBe("reviewCustomerValue completed");
  expect(qaResult.summary.includes("원격") || qaResult.summary.includes("저장소") || qaResult.summary.includes("깃")).toBe(true);
  expect(customerVoiceResult.summary.includes("원격") || customerVoiceResult.summary.includes("저장소") || customerVoiceResult.summary.includes("깃")).toBe(true);

  db.db.close();
});

test("runSpecialist gives a more concrete planning summary for ideation prompts", async () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);

  const plannerResult = await runSpecialist({
    role: "planner",
    input: {
      goalId: "goal-idea",
      projectId: "test",
      runId: "run-idea",
      goalTitle: "이 채널 목표 제안해봐",
    },
    memoryStore,
  });
  const customerVoiceResult = await runSpecialist({
    role: "customer-voice",
    input: {
      goalId: "goal-idea",
      projectId: "test",
      runId: "run-idea",
      goalTitle: "이 채널 목표 제안해봐",
    },
    memoryStore,
  });

  expect(plannerResult.summary.includes("후보") || plannerResult.summary.includes("첫 목표")).toBe(true);
  expect(customerVoiceResult.summary.includes("무엇을") || customerVoiceResult.summary.includes("바로 해야")).toBe(true);

  db.db.close();
});
