import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { splitOversizedGoal } from "../orchestrator/initiative";
import { enqueueQueuedRun, type QueueJob } from "../runtime/queue";
import { createRepositories } from "../state/repositories";
import type { SlackMessageClient } from "./publish";
import {
  buildAiOpsGreetingText,
  buildAiOpsStatusText,
  buildProjectGreetingText,
  buildProjectStatusText,
  detectConversationalIntent,
  sanitizeIncomingSlackText,
} from "./message-style";

interface SlackIntakeOptions {
  aiOpsChannelId: string;
  runIdFactory: () => string;
  slackClient?: SlackMessageClient;
}

export interface SlackConversationReply {
  channelId: string;
  threadTs: string;
  text: string;
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

function normalizeProjectKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function canAutoRegisterProjectChannel(projectId: string) {
  if (!projectId) return false;
  if (["total", "general", "random"].includes(projectId)) return false;
  if (/(?:^|-)sentry$/.test(projectId)) return false;
  if (/(?:^|-)(?:noti|notification|notifications|alert|alerts|log|logs|ops)$/.test(projectId)) {
    return false;
  }
  return true;
}

function findProjectByIdentifier(
  repositories: ReturnType<typeof createRepositories>,
  projectId: string,
) {
  const normalized = normalizeProjectKey(projectId);
  if (!normalized) return null;

  const direct = repositories.projects.get(normalized);
  if (direct) return direct;

  return repositories.projects.list().find(
    (project) => normalizeProjectKey(project.id) === normalized,
  ) ?? null;
}

async function resolveProjectByIdentifier(input: {
  repositories: ReturnType<typeof createRepositories>;
  projectId: string;
  slackClient?: SlackMessageClient;
}) {
  const normalized = normalizeProjectKey(input.projectId);
  if (!normalized) return null;

  const existing = findProjectByIdentifier(input.repositories, normalized);
  if (existing) return existing;

  if (!input.slackClient?.findConversationByName) return null;

  const found = await input.slackClient.findConversationByName(normalized);
  const channelName = found.channel?.name ? normalizeProjectKey(found.channel.name) : normalized;
  if (!found.ok || !found.channel?.id || !canAutoRegisterProjectChannel(channelName)) {
    return null;
  }

  input.repositories.projects.create({
    id: channelName,
    slackChannelId: found.channel.id,
  });
  return input.repositories.projects.get(channelName);
}

async function resolveProjectForIncomingChannel(input: {
  repositories: ReturnType<typeof createRepositories>;
  channelId: string;
  slackClient?: SlackMessageClient;
}) {
  const existing = input.repositories.projects.getBySlackChannelId(input.channelId);
  if (existing) return existing;

  if (!input.slackClient?.getConversationInfo) return null;

  const info = await input.slackClient.getConversationInfo(input.channelId);
  if (!info.ok || !info.channel?.name || !info.channel.id || info.channel.is_archived) {
    return null;
  }

  const projectId = normalizeProjectKey(info.channel.name);
  if (!canAutoRegisterProjectChannel(projectId)) {
    return null;
  }

  const byId = findProjectByIdentifier(input.repositories, projectId);
  if (byId) {
    return byId;
  }

  input.repositories.projects.create({
    id: projectId,
    slackChannelId: info.channel.id,
  });
  return input.repositories.projects.get(projectId);
}

function deriveTaskList(text: string) {
  const segments = sanitizeIncomingSlackText(stripLeadingMention(text))
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
  const normalized = sanitizeIncomingSlackText(stripLeadingMention(text));
  const projectSeparator = normalized.indexOf(":");
  if (projectSeparator === -1) return null;

  const projectId = normalizeProjectKey(normalized.slice(0, projectSeparator));
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

async function bootstrapAiOpsIntake(
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
  const text = sanitizeIncomingSlackText(event.text as string);
  const messageTs =
    typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : `slack-${Date.now()}`;

  if (options.aiOpsChannelId && channelId === options.aiOpsChannelId) {
    const normalized = normalizeEventText(text);
    if (!normalized) return "ignored";

    const project = await resolveProjectByIdentifier({
      repositories,
      projectId: normalized.projectId,
      slackClient: options.slackClient,
    });
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

  const sourceProject = await resolveProjectForIncomingChannel({
    repositories,
    channelId,
    slackClient: options.slackClient,
  });
  const explicitProject = normalizeEventText(text);
  const project = explicitProject
    ? await resolveProjectByIdentifier({
        repositories,
        projectId: explicitProject.projectId,
        slackClient: options.slackClient,
      }) ?? sourceProject
    : sourceProject;
  if (!project) {
    return null;
  }
  const goalText = explicitProject && project
    ? explicitProject.goalText
    : text;
  if (!goalText.trim()) {
    return "ignored";
  }
  const taskList = deriveTaskList(goalText);
  const split = splitOversizedGoal({
    projectId: project.id,
    title: goalText,
    tasks: taskList,
  });
  enqueueGoals({
    db,
    repositories,
    split,
    initiativeTitle: goalText,
    projectId: project.id,
    aiOpsChannelId: options.aiOpsChannelId,
    intakeThreadTs: messageTs,
    projectChannelId: project.slackChannelId,
    projectThreadTs: channelId === project.slackChannelId ? messageTs : undefined,
    sourceChannelId: channelId,
    runIdFactory: options.runIdFactory,
    requiresDeployApproval: /배포|deploy/i.test(goalText),
  });
  return "handled";
}

export async function bootstrapSlackIntake(
  db: Database,
  payload: Record<string, unknown>,
  options: SlackIntakeOptions,
) {
  return await bootstrapAiOpsIntake(db, payload, options);
}

export async function maybeBuildConversationReply(
  db: Database,
  payload: Record<string, unknown>,
  options: { aiOpsChannelId: string; slackClient?: SlackMessageClient },
) {
  const event = resolveEvent(payload);
  const channelId = resolveChannelId(payload, event);
  if (!isUserMessageEvent(payload, event)) {
    return null;
  }

  const repositories = createRepositories(db);
  const text = sanitizeIncomingSlackText(event.text as string);
  const intent = detectConversationalIntent(text);
  if (!intent) return null;

  const threadTs =
    typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : `slack-${Date.now()}`;

  if (options.aiOpsChannelId && channelId === options.aiOpsChannelId) {
    if (normalizeEventText(text)) return null;
    const projectIds = repositories.projects.list().map((project) => project.id);
    return {
      channelId,
      threadTs,
      text:
        intent === "status"
          ? buildAiOpsStatusText(projectIds)
          : buildAiOpsGreetingText(projectIds),
    } satisfies SlackConversationReply;
  }

  const project = await resolveProjectForIncomingChannel({
    repositories,
    channelId,
    slackClient: options.slackClient,
  });
  if (!project) return null;

  return {
    channelId,
    threadTs,
    text:
      intent === "status"
        ? buildProjectStatusText(project.id)
        : buildProjectGreetingText(project.id),
  } satisfies SlackConversationReply;
}
