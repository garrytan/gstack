import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store";
import { evaluateAction } from "../../src/orchestrator/approvals";
import { Captain } from "../../src/orchestrator/captain";
import { Governor } from "../../src/orchestrator/governor";
import { splitOversizedGoal } from "../../src/orchestrator/initiative";
import { runSpecialist } from "../../src/orchestrator/specialists";
import { buildApprovalRequest } from "../../src/slack/publish";
import { openStore } from "../../src/state/store";

type MessageKind = "intake" | "approval" | "root" | "impact" | "summary";

interface HarnessMessage {
  channelId: string;
  threadTs: string;
  text: string;
  kind: MessageKind;
  blocks?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  ts?: string;
}

function projectChannelId(projectId: string) {
  return `C_${projectId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

function roleLabel(role: string) {
  return role.replace(/-/g, " ").toUpperCase();
}

export async function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "rico-harness-"));
  const artifactDir = join(dir, ".gstack", "rico", "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const store = openStore(join(dir, "rico.sqlite"));
  const memoryStore = new MemoryStore(store.db);
  const governor = new Governor({ maxActiveProjects: 2 });
  const captain = new Captain(memoryStore);
  const messages: HarnessMessage[] = [];
  let activeProjectId: string | null = null;
  let messageCounter = 0;

  let initiativeCounter = 0;
  let goalCounter = 0;
  let runCounter = 0;
  let approvalCounter = 0;

  function nextId(prefix: string, counter: number) {
    return `${prefix}-${counter}`;
  }

  const slackClient = {
    async postMessage(input: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: Array<Record<string, unknown>>;
      metadata?: Record<string, unknown>;
    }) {
      messageCounter += 1;
      const ts = `1710000000.${String(messageCounter).padStart(6, "0")}`;
      messages.push({
        channelId: input.channel,
        threadTs: input.thread_ts ?? ts,
        text: input.text,
        kind: "summary",
        blocks: input.blocks,
        metadata: input.metadata,
        ts,
      });
      return { ok: true, ts };
    },
  };

  async function recordMessage(input: {
    channelId: string;
    threadTs: string;
    text: string;
    kind: MessageKind;
    blocks?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }) {
    const response = await slackClient.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: input.text,
      blocks: input.blocks,
      metadata: input.metadata,
    });
    const lastMessage = messages[messages.length - 1];
    messages[messages.length - 1] = {
      ...lastMessage,
      kind: input.kind,
      threadTs: input.threadTs,
      ts: response.ts,
    };
  }

  async function receiveAiOpsGoal(input: {
    channelId: string;
    projectId: string;
    text: string;
    specialistTasks: number;
  }) {
    const aiOpsThreadTs = `aiops-thread-${input.projectId}-1`;
    const mappedProjectChannelId = projectChannelId(input.projectId);
    activeProjectId = input.projectId;

    store.repositories.projects.create({
      id: input.projectId,
      slackChannelId: mappedProjectChannelId,
    });
    governor.registerProject({
      id: input.projectId,
      channelId: mappedProjectChannelId,
    });
    governor.markQueued(input.projectId, "2026-04-12T14:00:00.000Z");
    governor.startProject(input.projectId);

    captain.handleAiOpsIntake({
      projectId: input.projectId,
      aiOpsChannelId: input.channelId,
      projectChannelId: mappedProjectChannelId,
      intakeThreadTs: aiOpsThreadTs,
      title: input.text,
    });
    await recordMessage({
      channelId: input.channelId,
      threadTs: aiOpsThreadTs,
      text: input.text,
      kind: "intake",
    });

    const specialistTasks = Array.from(
      { length: input.specialistTasks },
      (_, index) => `task-${index + 1}`,
    );
    const split = splitOversizedGoal({
      projectId: input.projectId,
      title: input.text,
      tasks: specialistTasks,
    });

    const goals =
      split.kind === "initiative"
        ? split.goals
        : [{ title: input.text, tasks: specialistTasks }];

    let initiativeId: string | null = null;
    if (split.kind === "initiative") {
      initiativeCounter += 1;
      initiativeId = nextId("initiative", initiativeCounter);
      store.repositories.initiatives.create({
        id: initiativeId,
        projectId: input.projectId,
        title: input.text,
        status: "in_progress",
      });
    }

    for (const [index, goalPlan] of goals.entries()) {
      goalCounter += 1;
      const goalId = nextId("goal", goalCounter);
      const threadTs = `project-thread-${goalId}`;
      store.repositories.goals.create({
        id: goalId,
        initiativeId,
        projectId: input.projectId,
        title: goalPlan.title,
        state: "planned",
      });
      await recordMessage({
        channelId: mappedProjectChannelId,
        threadTs,
        text: goalPlan.title,
        kind: "root",
      });

      runCounter += 1;
      const runId = nextId("run", runCounter);
      store.repositories.runs.create({
        id: runId,
        goalId,
        status: "in_progress",
        queuedAt: "2026-04-12T14:00:00.000Z",
        startedAt: "2026-04-12T14:00:05.000Z",
        finishedAt: null,
      });

      const qaResult = await runSpecialist({
        role: "qa",
        input: {
          projectId: input.projectId,
          runId,
          summary: "Regression found in onboarding",
        },
        memoryStore,
      });
      const customerVoiceResult = await runSpecialist({
        role: "customer-voice",
        input: {
          projectId: input.projectId,
          runId,
          summary: "Customer value is not obvious enough yet",
        },
        memoryStore,
      });

      for (const result of [qaResult, customerVoiceResult]) {
        await recordMessage({
          channelId: mappedProjectChannelId,
          threadTs,
          text: `[${roleLabel(result.role)} Impact] ${result.summary}`,
          kind: "impact",
        });
      }

      captain.captureSpecialistResults(input.projectId, [qaResult, customerVoiceResult]);
      const summary = captain.composeProjectSummary({
        projectId: input.projectId,
        projectThreadTs: threadTs,
        summary: `${goalPlan.title} in progress`,
        impacts: [
          {
            role: qaResult.role,
            level: qaResult.impact,
            message: qaResult.summary,
          },
          {
            role: customerVoiceResult.role,
            level: customerVoiceResult.impact,
            message: customerVoiceResult.summary,
          },
        ],
      });
      await recordMessage({
        channelId: summary.channelId,
        threadTs: summary.threadTs,
        text: summary.summary,
        kind: "summary",
      });

      const shouldRequestDeployApproval =
        index === goals.length - 1 && /배포|deploy/i.test(input.text);
      if (shouldRequestDeployApproval) {
        const decision = evaluateAction({ type: "deploy" });
        if (!decision.allowed) {
          approvalCounter += 1;
          const approvalId = nextId("approval", approvalCounter);
          store.repositories.approvals.create({
            id: approvalId,
            goalId,
            type: "deploy",
            status: "pending",
            rationale: decision.blockingReason ?? null,
          });
          store.repositories.stateTransitions.append({
            id: `transition-${approvalId}`,
            goalId,
            fromState: "planned",
            toState: decision.state,
            createdAt: "2026-04-12T14:01:00.000Z",
            actor: "governor",
          });
          const approvalRequest = buildApprovalRequest({
            approvalId,
            goalId,
            actionType: "deploy",
            blockingReason: decision.blockingReason ?? "deployment requires human approval",
            channelId: input.channelId,
            threadTs: aiOpsThreadTs,
          });
          await recordMessage({
            channelId: input.channelId,
            threadTs: aiOpsThreadTs,
            text: approvalRequest.text,
            kind: "approval",
            blocks: approvalRequest.blocks,
            metadata: approvalRequest.metadata,
          });
        }
      }
    }

    governor.finishProject(input.projectId);
  }

  return {
    messages,
    artifactDir,
    store: {
      listInitiatives(projectId = activeProjectId) {
        if (!projectId) return [];
        return store.repositories.initiatives.listByProject(projectId);
      },
      listGoals(projectId = activeProjectId) {
        if (!projectId) return [];
        return store.repositories.goals.listByProject(projectId);
      },
      latestApproval(projectId = activeProjectId) {
        if (!projectId) return null;
        const approvals = store.repositories.goals
          .listByProject(projectId)
          .flatMap((goal) => store.repositories.approvals.listByGoal(goal.id));
        return approvals[approvals.length - 1] ?? null;
      },
      latestGoalState(projectId = activeProjectId) {
        if (!projectId) return null;
        const goals = store.repositories.goals.listByProject(projectId);
        return goals[goals.length - 1]?.state ?? null;
      },
    },
    async receiveAiOpsGoal(input: {
      channelId: string;
      projectId: string;
      text: string;
      specialistTasks: number;
    }) {
      await receiveAiOpsGoal(input);
    },
    async close() {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
