import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { splitOversizedGoal } from "../orchestrator/initiative";
import { enqueueQueuedRun, type QueueJob } from "../runtime/queue";
import { createRepositories } from "../state/repositories";

interface SlackIntakeOptions {
  aiOpsChannelId: string;
  runIdFactory: () => string;
}

export type SlackIntakeResult = "handled" | "ignored" | null;

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

function stripLeadingMention(text: string) {
  return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}

function deriveTaskList(text: string) {
  const segments = stripLeadingMention(text)
    .split(/[,\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return [
      `plan:${text}`,
      `implement:${text}`,
      `review:${text}`,
    ];
  }

  return segments.flatMap((segment) => [
    `plan:${segment}`,
    `implement:${segment}`,
    `review:${segment}`,
  ]);
}

function normalizeEventText(text: string) {
  const normalized = stripLeadingMention(text);
  const projectSeparator = normalized.indexOf(":");
  if (projectSeparator === -1) return null;

  const projectId = normalized.slice(0, projectSeparator).trim();
  const goalText = normalized.slice(projectSeparator + 1).trim();
  if (!projectId || !goalText) return null;

  return {
    projectId,
    goalText,
  };
}

function resolveEvent(payload: Record<string, unknown>) {
  return payload.event && typeof payload.event === "object"
    ? payload.event as Record<string, unknown>
    : payload;
}

function resolveChannelId(payload: Record<string, unknown>, event: Record<string, unknown>) {
  return typeof event.channel === "string"
    ? event.channel
    : typeof payload.channel_id === "string"
      ? payload.channel_id
      : "";
}

function isUserMessageEvent(
  payload: Record<string, unknown>,
  event: Record<string, unknown>,
) {
  if (payload.type !== "event_callback") return false;
  if (event.type !== "message" && event.type !== "app_mention") return false;
  if (typeof event.subtype === "string" && event.subtype.length > 0) return false;
  if (typeof event.bot_id === "string" && event.bot_id.length > 0) return false;
  return typeof event.text === "string" && typeof event.channel === "string";
}

function createGoalIntakePayload(input: {
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
}) {
  return {
    goalId: input.goalId,
    projectId: input.projectId,
    text: input.text,
    aiOpsChannelId: input.aiOpsChannelId,
    intakeThreadTs: input.intakeThreadTs,
    projectChannelId: input.projectChannelId,
    projectThreadTs: input.projectThreadTs,
    sourceChannelId: input.sourceChannelId,
    isFinalGoal: input.isFinalGoal,
    requiresDeployApproval: input.requiresDeployApproval,
  } satisfies GoalIntakePayload;
}

function enqueueGoals(input: {
  db: Database;
  repositories: ReturnType<typeof createRepositories>;
  split: ReturnType<typeof splitOversizedGoal>;
  initiativeTitle: string;
  projectId: string;
  aiOpsChannelId: string;
  intakeThreadTs: string;
  projectChannelId: string;
  projectThreadTs?: string;
  sourceChannelId: string;
  runIdFactory: () => string;
  requiresDeployApproval: boolean;
}) {
  const initiativeId =
    input.split.kind === "initiative"
      ? `initiative-${input.projectId}-${randomUUID()}`
      : null;
  if (initiativeId) {
    input.repositories.initiatives.create({
      id: initiativeId,
      projectId: input.projectId,
      title: input.initiativeTitle,
      status: "in_progress",
    });
  }

  const goals =
    input.split.kind === "initiative"
      ? input.split.goals
      : [{ title: input.initiativeTitle, tasks: input.split.tasks }];

  goals.forEach((goal, index) => {
    const goalId = `goal-${input.projectId}-${index + 1}-${randomUUID()}`;
    input.repositories.goals.create({
      id: goalId,
      initiativeId,
      projectId: input.projectId,
      title: goal.title,
      state: "planned",
    });
    const queueJob: QueueJob = {
      kind: "event",
      runId: input.runIdFactory(),
      payload: createGoalIntakePayload({
        goalId,
        projectId: input.projectId,
        text: input.initiativeTitle,
        aiOpsChannelId: input.aiOpsChannelId,
        intakeThreadTs: input.intakeThreadTs,
        projectChannelId: input.projectChannelId,
        projectThreadTs: input.projectThreadTs,
        sourceChannelId: input.sourceChannelId,
        isFinalGoal: index === goals.length - 1,
        requiresDeployApproval: input.requiresDeployApproval,
      }),
    };
    enqueueQueuedRun(input.db, queueJob);
  });
}

function bootstrapAiOpsIntake(
  db: Database,
  payload: Record<string, unknown>,
  options: SlackIntakeOptions,
) {
  const event = resolveEvent(payload);
  const channelId = resolveChannelId(payload, event);
  if (!isUserMessageEvent(payload, event)) {
    return null;
  }

  const repositories = createRepositories(db);
  const text = event.text as string;
  const messageTs =
    typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : `slack-${Date.now()}`;

  if (options.aiOpsChannelId && channelId === options.aiOpsChannelId) {
    const normalized = normalizeEventText(text);
    if (!normalized) return "ignored";

    const project = repositories.projects.get(normalized.projectId);
    if (!project) {
      return "ignored";
    }

    const taskList = deriveTaskList(normalized.goalText);
    const split = splitOversizedGoal({
      projectId: normalized.projectId,
      title: normalized.goalText,
      tasks: taskList,
    });
    enqueueGoals({
      db,
      repositories,
      split,
      initiativeTitle: normalized.goalText,
      projectId: normalized.projectId,
      aiOpsChannelId: options.aiOpsChannelId,
      intakeThreadTs: messageTs,
      projectChannelId: project.slackChannelId,
      sourceChannelId: channelId,
      runIdFactory: options.runIdFactory,
      requiresDeployApproval: /배포|deploy/i.test(normalized.goalText),
    });
    return "handled";
  }

  const project = repositories.projects.getBySlackChannelId(channelId);
  if (!project) {
    return null;
  }
  if (!text.trim()) {
    return "ignored";
  }
  const taskList = deriveTaskList(text);
  const split = splitOversizedGoal({
    projectId: project.id,
    title: text,
    tasks: taskList,
  });
  enqueueGoals({
    db,
    repositories,
    split,
    initiativeTitle: text,
    projectId: project.id,
    aiOpsChannelId: options.aiOpsChannelId,
    intakeThreadTs: messageTs,
    projectChannelId: project.slackChannelId,
    projectThreadTs: messageTs,
    sourceChannelId: channelId,
    runIdFactory: options.runIdFactory,
    requiresDeployApproval: /배포|deploy/i.test(text),
  });
  return "handled";
}

export function bootstrapSlackIntake(
  db: Database,
  payload: Record<string, unknown>,
  options: SlackIntakeOptions,
) {
  return bootstrapAiOpsIntake(db, payload, options);
}
