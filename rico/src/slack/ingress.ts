import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { enqueueQueuedRun, type QueueJob } from "../runtime/queue";
import { handleApprovalInteraction } from "./interactions";
import { bootstrapSlackIntake, maybeBuildConversationReply } from "./intake";
import type { SlackMessageClient } from "./publish";

export interface SlackIngressOptions {
  db: Database;
  aiOpsChannelId: string;
  slackClient?: SlackMessageClient;
  runIdFactory?: () => string;
  triggerDrain?: () => void | Promise<void>;
}

export async function processSlackPayload(
  options: SlackIngressOptions,
  kind: QueueJob["kind"],
  payload: Record<string, unknown>,
) {
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());

  if (kind === "interaction") {
    const handledInteraction = await tryHandleApprovalInteraction(
      options.db,
      payload,
      options.slackClient,
    );
    if (handledInteraction) {
      return { queued: false, handled: true } as const;
    }
  }

  const conversationReply = await maybeBuildConversationReply(options.db, payload, {
    aiOpsChannelId: options.aiOpsChannelId,
    slackClient: options.slackClient,
  });
  if (conversationReply && options.slackClient) {
    await options.slackClient.postMessage({
      channel: conversationReply.channelId,
      thread_ts: conversationReply.threadTs,
      text: conversationReply.text,
    });
    return { queued: false, handled: true } as const;
  }

  const intakeResult = await bootstrapSlackIntake(
    options.db,
    payload,
    {
      aiOpsChannelId: options.aiOpsChannelId,
      runIdFactory,
      slackClient: options.slackClient,
    },
  );

  let queued = false;
  if (intakeResult === null) {
    if (!hasGoalId(payload)) {
      return { queued: false, handled: false } as const;
    }
    const job: QueueJob = {
      kind,
      payload,
      runId: runIdFactory(),
    };
    enqueueQueuedRun(options.db, job);
    queued = true;
  } else if (intakeResult === "handled") {
    queued = true;
  }

  if (queued && options.triggerDrain) {
    void options.triggerDrain();
  }

  return { queued, handled: intakeResult !== "ignored" } as const;
}

function hasGoalId(payload: Record<string, unknown>) {
  return (
    (typeof payload.goalId === "string" && payload.goalId.length > 0)
    || (typeof payload.goal_id === "string" && payload.goal_id.length > 0)
  );
}

async function tryHandleApprovalInteraction(
  db: Database,
  payload: Record<string, unknown>,
  slackClient?: SlackMessageClient,
) {
  if (payload.type !== "block_actions") return false;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const firstAction = actions[0];
  if (!firstAction || typeof firstAction !== "object") return false;
  const actionId = typeof firstAction.action_id === "string" ? firstAction.action_id : "";
  if (actionId !== "approval:approve" && actionId !== "approval:reject") return false;
  const approvalId = typeof firstAction.value === "string" ? firstAction.value : "";
  const actor =
    payload.user && typeof payload.user === "object" && typeof payload.user.id === "string"
      ? payload.user.id
      : "unknown";
  if (!approvalId) return false;

  const result = await handleApprovalInteraction({
    db,
    action: actionId === "approval:approve" ? "approve" : "reject",
    approvalId,
    actor,
  });
  const channelId =
    payload.channel && typeof payload.channel === "object" && typeof payload.channel.id === "string"
      ? payload.channel.id
      : "";
  const threadTs =
    payload.message && typeof payload.message === "object"
      ? (
          typeof payload.message.thread_ts === "string"
            ? payload.message.thread_ts
            : typeof payload.message.ts === "string"
              ? payload.message.ts
              : undefined
        )
      : undefined;

  if (slackClient && channelId) {
    await slackClient.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: result.threadMessage,
    });
  }
  return true;
}
