import {
  uploadTextArtifact,
  type SlackArtifactReference,
  type SlackExternalUploadClient,
} from "./files";
import { buildApprovalText, buildImpactNarration } from "./message-style";

export interface ImpactMessageInput {
  role: string;
  summary: string;
  impact: string;
  artifactLabel: string;
}

export interface SlackMessageClient {
  postMessage(input: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }): Promise<{ ok: boolean; ts?: string }>;
}

export interface PublishImpactUpdateInput {
  client: SlackExternalUploadClient & SlackMessageClient;
  channelId: string;
  threadTs?: string;
  role: string;
  summary: string;
  impact: string;
  artifact: {
    fileName: string;
    content: string;
    title?: string;
  };
}

export interface BuildApprovalRequestInput {
  approvalId: string;
  goalId: string;
  actionType: string;
  blockingReason: string;
  channelId: string;
  threadTs: string;
}

export interface ApprovalRequestMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
  metadata: {
    approvalId: string;
    goalId: string;
    channelId: string;
    threadTs: string;
  };
}

function artifactLinkText(artifact: SlackArtifactReference) {
  return artifact.permalink ?? artifact.fileId ?? artifact.title ?? "artifact";
}

export function buildImpactMessage(input: ImpactMessageInput) {
  return `${buildImpactNarration(input.role, input.summary)} 자세한 내용은 ${input.artifactLabel}에 정리해뒀어요.`;
}

export function buildApprovalRequest(input: BuildApprovalRequestInput): ApprovalRequestMessage {
  return {
    text: buildApprovalText(input.actionType, input.blockingReason),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*사람 확인이 필요해요:* \`${input.actionType}\`\n${input.blockingReason}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Approve",
            },
            style: "primary",
            action_id: "approval:approve",
            value: input.approvalId,
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Reject",
            },
            style: "danger",
            action_id: "approval:reject",
            value: input.approvalId,
          },
        ],
      },
    ],
    metadata: {
      approvalId: input.approvalId,
      goalId: input.goalId,
      channelId: input.channelId,
      threadTs: input.threadTs,
    },
  };
}

export async function publishImpactUpdate(input: PublishImpactUpdateInput) {
  const uploaded = await uploadTextArtifact({
    client: input.client,
    channelId: input.channelId,
    threadTs: input.threadTs,
    artifact: input.artifact,
  });

  const text = `${buildImpactMessage({
    role: input.role,
    summary: input.summary,
    impact: input.impact,
    artifactLabel: input.artifact.title ?? input.artifact.fileName,
  })}\n${artifactLinkText(uploaded)}`;

  const message = await input.client.postMessage({
    channel: input.channelId,
    thread_ts: input.threadTs,
    text,
  });
  if (!message.ok) {
    throw new Error("Slack rejected impact message");
  }

  return {
    uploaded,
    messageTs: message.ts,
    text,
  };
}
