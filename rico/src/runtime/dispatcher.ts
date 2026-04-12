import type { Database } from "bun:sqlite";
import { MemoryStore } from "../memory/store";
import { evaluateAction } from "../orchestrator/approvals";
import { Captain } from "../orchestrator/captain";
import { Governor } from "../orchestrator/governor";
import { runSpecialist } from "../orchestrator/specialists";
import { buildApprovalRequest, type SlackMessageClient } from "../slack/publish";
import type { LoadedRunContext } from "./job-runner";

interface GoalIntakePayload {
  goalId: string;
  projectId: string;
  text: string;
  aiOpsChannelId: string;
  intakeThreadTs: string;
  projectChannelId: string;
  projectThreadTs?: string;
  sourceChannelId: string;
  isFinalGoal: boolean;
  requiresDeployApproval: boolean;
}

function asGoalIntakePayload(payload: unknown): GoalIntakePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.goalId !== "string" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.intakeThreadTs !== "string" ||
    typeof candidate.projectChannelId !== "string" ||
    typeof candidate.sourceChannelId !== "string"
  ) {
    return null;
  }

  return {
    goalId: candidate.goalId,
    projectId: candidate.projectId,
    text: candidate.text,
    aiOpsChannelId: typeof candidate.aiOpsChannelId === "string" ? candidate.aiOpsChannelId : "",
    intakeThreadTs: candidate.intakeThreadTs,
    projectChannelId: candidate.projectChannelId,
    projectThreadTs:
      typeof candidate.projectThreadTs === "string" ? candidate.projectThreadTs : undefined,
    sourceChannelId: candidate.sourceChannelId,
    isFinalGoal: candidate.isFinalGoal === true,
    requiresDeployApproval: candidate.requiresDeployApproval === true,
  };
}

function roleLabel(role: string) {
  if (role === "qa") return "QA";
  if (role === "customer-voice") return "Customer Voice";
  return role
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function requestApproval(input: {
  db: Database;
  approvalId: string;
  goalId: string;
  fromState: string;
  toState: string;
  actor: string;
  actionType: string;
  rationale: string | null;
  createdAt?: string;
}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  input.db.transaction(() => {
    input.db.query(
      `insert into approvals (id, goal_id, type, status, rationale)
       values (?, ?, ?, ?, ?)`,
    ).run(
      input.approvalId,
      input.goalId,
      input.actionType,
      "pending",
      input.rationale,
    );
    input.db.query(
      `insert into state_transitions (id, goal_id, from_state, to_state, created_at, actor)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(
      `transition-${input.approvalId}`,
      input.goalId,
      input.fromState,
      input.toState,
      createdAt,
      input.actor,
    );
    const updateResult = input.db
      .query("update goals set state = ? where id = ?")
      .run(input.toState, input.goalId) as { changes?: number } | undefined;
    if (!updateResult || updateResult.changes !== 1) {
      throw new Error(`Goal not found for approval: ${input.goalId}`);
    }
  })();
}

export function createRuntimeDispatcher(input: {
  db: Database;
  slackClient: SlackMessageClient;
  maxActiveProjects: number;
}) {
  const memoryStore = new MemoryStore(input.db);
  const captain = new Captain(memoryStore);
  const governor = new Governor({ maxActiveProjects: input.maxActiveProjects });

  return async function dispatch(context: LoadedRunContext) {
    const payload = asGoalIntakePayload(context.job.payload);
    if (!payload) {
      return;
    }

    governor.registerProject({
      id: context.project.id,
      channelId: context.project.slackChannelId,
    });
    const started = governor.startProject(context.project.id);
    if (!started.ok) {
      throw new Error(`Project cannot start: ${started.reason}`);
    }

    try {
      const portfolio = captain.getPortfolioRecord(payload.projectId)
        ?? captain.handleAiOpsIntake({
          projectId: payload.projectId,
          aiOpsChannelId: payload.aiOpsChannelId,
          projectChannelId: payload.projectChannelId,
          intakeThreadTs: payload.intakeThreadTs,
          title: payload.text,
        }).portfolioRecord;

      input.db.query(
        "update goals set state = 'in_progress' where id = ?",
      ).run(payload.goalId);

      let projectThreadTs = payload.projectThreadTs;
      if (!projectThreadTs) {
        const root = await input.slackClient.postMessage({
          channel: portfolio.projectChannelId,
          text: `[Captain:${payload.projectId}] ${context.goal.title}`,
        });
        if (!root.ok || !root.ts) {
          throw new Error("Slack rejected project thread root");
        }
        projectThreadTs = root.ts;
      } else {
        const ack = await input.slackClient.postMessage({
          channel: portfolio.projectChannelId,
          thread_ts: projectThreadTs,
          text: `[Captain:${payload.projectId}] ${context.goal.title}`,
        });
        if (!ack.ok) {
          throw new Error("Slack rejected project thread acknowledgement");
        }
      }

      const qaResult = await runSpecialist({
        role: "qa",
        input: {
          projectId: payload.projectId,
          runId: context.run.id,
          summary: "Regression found in onboarding",
        },
        memoryStore,
      });
      const customerVoiceResult = await runSpecialist({
        role: "customer-voice",
        input: {
          projectId: payload.projectId,
          runId: context.run.id,
          summary: "Customer value is not obvious enough yet",
        },
        memoryStore,
      });
      captain.captureSpecialistResults(payload.projectId, [qaResult, customerVoiceResult]);

      for (const result of [qaResult, customerVoiceResult]) {
        const message = await input.slackClient.postMessage({
          channel: portfolio.projectChannelId,
          thread_ts: projectThreadTs,
          text: `[${roleLabel(result.role)} Impact] ${result.summary}`,
        });
        if (!message.ok) {
          throw new Error(`Slack rejected ${result.role} impact message`);
        }
      }

      const summary = captain.composeProjectSummary({
        projectId: payload.projectId,
        projectThreadTs: projectThreadTs,
        summary: `[Captain:${payload.projectId}] ${context.goal.title} in progress`,
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
      const summaryResponse = await input.slackClient.postMessage({
        channel: summary.channelId,
        thread_ts: summary.threadTs,
        text: summary.summary,
      });
      if (!summaryResponse.ok) {
        throw new Error("Slack rejected project summary");
      }

      if (payload.isFinalGoal && payload.requiresDeployApproval) {
        const decision = evaluateAction({ type: "deploy" });
        if (!decision.allowed) {
          const approvalId = `approval-${context.run.id}`;
          requestApproval({
            db: input.db,
            approvalId,
            goalId: payload.goalId,
            actionType: "deploy",
            rationale: decision.blockingReason ?? null,
            fromState: "in_progress",
            toState: decision.state,
            actor: "governor",
          });

          const approvalRequest = buildApprovalRequest({
            approvalId,
            goalId: payload.goalId,
            actionType: "deploy",
            blockingReason: decision.blockingReason ?? "deployment requires human approval",
            channelId: payload.aiOpsChannelId,
            threadTs: payload.intakeThreadTs,
          });
          const approvalMessage = await input.slackClient.postMessage({
            channel: payload.aiOpsChannelId,
            thread_ts: payload.intakeThreadTs,
            text: approvalRequest.text,
            blocks: approvalRequest.blocks,
            metadata: approvalRequest.metadata,
          });
          if (!approvalMessage.ok) {
            throw new Error("Slack rejected approval request");
          }
        }
      }

      if (payload.sourceChannelId === payload.aiOpsChannelId) {
        const governorUpdate = await input.slackClient.postMessage({
          channel: payload.aiOpsChannelId,
          thread_ts: payload.intakeThreadTs,
          text: `[Governor] Routed to #${payload.projectId} (${portfolio.projectChannelId})`,
        });
        if (!governorUpdate.ok) {
          throw new Error("Slack rejected governor routing update");
        }
      }
    } finally {
      governor.finishProject(context.project.id);
    }
  };
}
