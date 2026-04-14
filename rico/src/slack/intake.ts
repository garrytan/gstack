import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MemoryStore } from "../memory/store";
import { splitOversizedGoal } from "../orchestrator/initiative";
import { readProjectCustomerVoiceProfile } from "../orchestrator/customer-voice-director";
import { enqueueQueuedRun, type QueueJob } from "../runtime/queue";
import { createRepositories } from "../state/repositories";
import type { SlackMessageClient } from "./publish";
import {
  applyCustomerVoiceCommand,
  buildCustomerVoiceStatusText,
  parseCustomerVoiceCommand,
} from "./customer-voice-commands";
import {
  archiveProjectGoal,
  buildGovernorApprovalBacklogText,
  buildGovernorArchiveText,
  buildGovernorPolicyChangeText,
  buildGovernorQueueText,
  buildGovernorReleaseText,
  buildGovernorRepairText,
  buildGovernorSnapshot,
  buildGovernorStatusSnapshotText,
  markProjectGoalReleased,
  parseGovernorCommand,
  recordGovernorPolicyChange,
  repairProjectGoals,
} from "./governor-commands";
import {
  applyProjectWorkspaceCommand,
  parseProjectWorkspaceCommand,
} from "./project-workspace-commands";
import type {
  CaptainConversationDecision,
  CaptainConversationInput,
  ConversationTurn,
  GovernorConversationInput,
  GovernorConversationReply,
} from "./conversation-gate";
import {
  looksLikeExecutionRequest,
  shouldUseCaptainConversation,
  shouldUseGovernorConversation,
} from "./conversation-gate";
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
  governorConversationExecutor?: (
    input: GovernorConversationInput,
  ) => Promise<GovernorConversationReply>;
  captainConversationExecutor?: (
    input: CaptainConversationInput,
  ) => Promise<CaptainConversationDecision>;
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
  followUpText?: string;
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
    .map((segment) => segment.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);

  if (segments.length === 0) {
    const normalized = sanitizeIncomingSlackText(stripLeadingMention(text));
    return normalized ? [normalized] : [];
  }

  return [...new Set(segments)];
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectImplicitProjectExecutionIntent(input: {
  repositories: ReturnType<typeof createRepositories>;
  text: string;
}) {
  const normalized = sanitizeIncomingSlackText(stripLeadingMention(input.text));
  if (!normalized) return null;

  const projects = input.repositories.projects.list()
    .map((project) => project.id)
    .sort((left, right) => right.length - left.length);

  for (const projectId of projects) {
    const projectPattern = normalizeProjectKey(projectId);
    if (!projectPattern) continue;
    const pattern = new RegExp(
      `^(?:#)?${escapeRegExp(projectPattern)}(?:\\s*(?:쪽|관련|프로젝트))?[\\s,:-]+(.+)$`,
      "i",
    );
    const match = normalized.match(pattern);
    if (!match) continue;
    const goalText = match[1]?.trim();
    if (!goalText) continue;
    return {
      projectId: projectPattern,
      goalText,
    };
  }

  return null;
}

function resolveAiOpsExecutionIntent(input: {
  repositories: ReturnType<typeof createRepositories>;
  text: string;
}) {
  const explicit = normalizeEventText(input.text);
  if (explicit) return explicit;
  const implicit = detectImplicitProjectExecutionIntent(input);
  if (!implicit) return null;
  if (!looksLikeExecutionRequest(implicit.goalText)) return null;
  if (detectConversationalIntent(input.text)) return null;
  return implicit;
}

function readThreadGoal(input: {
  repositories: ReturnType<typeof createRepositories>;
  memoryStore: MemoryStore;
  projectId: string;
  threadTs?: string;
}) {
  if (!input.threadTs) return null;
  const goalId =
    input.memoryStore.getProjectMemory(input.projectId)[`captain.thread.${input.threadTs}.goal_id`];
  if (!goalId) return null;
  return input.repositories.goals.get(goalId);
}

const GOVERNOR_CONVERSATION_SCOPE = "__governor__";

function conversationHistoryKey(threadTs: string) {
  return `conversation.thread.${threadTs}.history_json`;
}

function readConversationHistory(input: {
  memoryStore: MemoryStore;
  scopeId: string;
  threadTs?: string;
}) {
  if (!input.threadTs) return [] as ConversationTurn[];
  const raw = input.memoryStore.getProjectMemory(input.scopeId)[conversationHistoryKey(input.threadTs)];
  if (!raw) return [] as ConversationTurn[];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ConversationTurn =>
        Boolean(item)
        && typeof item === "object"
        && (item as { speaker?: unknown }).speaker !== undefined
        && ((item as { speaker?: unknown }).speaker === "user"
          || (item as { speaker?: unknown }).speaker === "assistant")
        && typeof (item as { text?: unknown }).text === "string")
      : [];
  } catch {
    return [] as ConversationTurn[];
  }
}

function appendConversationHistory(input: {
  memoryStore: MemoryStore;
  scopeId: string;
  threadTs: string;
  userText: string;
  assistantText: string;
}) {
  const history = readConversationHistory({
    memoryStore: input.memoryStore,
    scopeId: input.scopeId,
    threadTs: input.threadTs,
  });
  history.push(
    { speaker: "user", text: input.userText.trim() },
    { speaker: "assistant", text: input.assistantText.trim() },
  );
  input.memoryStore.putProjectFact(
    input.scopeId,
    conversationHistoryKey(input.threadTs),
    JSON.stringify(history.slice(-8)),
  );
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
  followUpText?: string;
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
    followUpText: input.followUpText,
    aiOpsChannelId: input.aiOpsChannelId,
    intakeThreadTs: input.intakeThreadTs,
    projectChannelId: input.projectChannelId,
    projectThreadTs: input.projectThreadTs,
    sourceChannelId: input.sourceChannelId,
    isFinalGoal: input.isFinalGoal,
    requiresDeployApproval: input.requiresDeployApproval,
  } satisfies GoalIntakePayload;
}

function enqueueFollowUpRun(input: {
  db: Database;
  goalId: string;
  projectId: string;
  goalTitle: string;
  followUpText: string;
  aiOpsChannelId: string;
  intakeThreadTs: string;
  projectChannelId: string;
  projectThreadTs: string;
  sourceChannelId: string;
  runIdFactory: () => string;
}) {
  enqueueQueuedRun(input.db, {
    kind: "event",
    runId: input.runIdFactory(),
    payload: createGoalIntakePayload({
      goalId: input.goalId,
      projectId: input.projectId,
      text: input.goalTitle,
      followUpText: input.followUpText,
      aiOpsChannelId: input.aiOpsChannelId,
      intakeThreadTs: input.intakeThreadTs,
      projectChannelId: input.projectChannelId,
      projectThreadTs: input.projectThreadTs,
      sourceChannelId: input.sourceChannelId,
      isFinalGoal: true,
      requiresDeployApproval: /배포|deploy/i.test(`${input.goalTitle}\n${input.followUpText}`),
    }),
  });
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
  const memoryStore = new MemoryStore(db);
  const text = sanitizeIncomingSlackText(event.text as string);
  const incomingThreadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  const messageTs =
    incomingThreadTs
      ? incomingThreadTs
      : typeof event.ts === "string"
        ? event.ts
        : `slack-${Date.now()}`;

  if (options.aiOpsChannelId && channelId === options.aiOpsChannelId) {
    const normalized = resolveAiOpsExecutionIntent({
      repositories,
      text,
    });
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
  const explicitProjectMatch = explicitProject
    ? await resolveProjectByIdentifier({
        repositories,
        projectId: explicitProject.projectId,
        slackClient: options.slackClient,
      })
    : null;
  const project = explicitProjectMatch ?? sourceProject;
  if (!project) {
    return null;
  }
  const goalText = explicitProject && explicitProjectMatch
    ? explicitProject.goalText
    : text;
  if (!goalText.trim()) {
    return "ignored";
  }
  if (
    sourceProject
    && !explicitProjectMatch
    && incomingThreadTs
    && channelId === sourceProject.slackChannelId
  ) {
    const threadGoalId =
      memoryStore.getProjectMemory(sourceProject.id)[`captain.thread.${incomingThreadTs}.goal_id`];
    const goal = threadGoalId ? repositories.goals.get(threadGoalId) : null;
    if (goal && goal.projectId === sourceProject.id) {
      enqueueFollowUpRun({
        db,
        goalId: goal.id,
        projectId: sourceProject.id,
        goalTitle: goal.title,
        followUpText: goalText,
        aiOpsChannelId: options.aiOpsChannelId,
        intakeThreadTs: incomingThreadTs,
        projectChannelId: sourceProject.slackChannelId,
        projectThreadTs: incomingThreadTs,
        sourceChannelId: channelId,
        runIdFactory: options.runIdFactory,
      });
      return "handled";
    }
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
  options: {
    aiOpsChannelId: string;
    maxActiveProjects?: number;
    slackClient?: SlackMessageClient;
    governorConversationExecutor?: (
      input: GovernorConversationInput,
    ) => Promise<GovernorConversationReply>;
    captainConversationExecutor?: (
      input: CaptainConversationInput,
    ) => Promise<CaptainConversationDecision>;
  },
) {
  const event = resolveEvent(payload);
  const channelId = resolveChannelId(payload, event);
  if (!isUserMessageEvent(payload, event)) {
    return null;
  }

  const repositories = createRepositories(db);
  const memoryStore = new MemoryStore(db);
  const text = sanitizeIncomingSlackText(event.text as string);
  const threadTs =
    typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : `slack-${Date.now()}`;

  if (options.aiOpsChannelId && channelId === options.aiOpsChannelId) {
    const aiOpsExecutionIntent = resolveAiOpsExecutionIntent({
      repositories,
      text,
    });
    const governorThreadHistory = readConversationHistory({
      memoryStore,
      scopeId: GOVERNOR_CONVERSATION_SCOPE,
      threadTs,
    });
    const normalized = normalizeEventText(text);
    if (normalized) {
      const workspaceCommand = parseProjectWorkspaceCommand(normalized.goalText);
      if (workspaceCommand) {
        const project = await resolveProjectByIdentifier({
          repositories,
          projectId: normalized.projectId,
          slackClient: options.slackClient,
        });
        if (!project) return null;
        return {
          channelId,
          threadTs,
          text: applyProjectWorkspaceCommand({
            memoryStore,
            projectId: project.id,
            command: workspaceCommand,
          }),
        } satisfies SlackConversationReply;
      }
      const command = parseCustomerVoiceCommand(normalized.goalText);
      if (command) {
        const project = await resolveProjectByIdentifier({
          repositories,
          projectId: normalized.projectId,
          slackClient: options.slackClient,
        });
        if (!project) return null;
        if (command.type !== "status") {
          applyCustomerVoiceCommand({
            memoryStore,
            projectId: project.id,
            command,
          });
        }
        return {
          channelId,
          threadTs,
          text: buildCustomerVoiceStatusText({
            projectId: project.id,
            profile: readProjectCustomerVoiceProfile({
              memoryStore,
              projectId: project.id,
            }),
          }),
        } satisfies SlackConversationReply;
      }
      return null;
    }
    if (aiOpsExecutionIntent) {
      return null;
    }

    const governorCommand = parseGovernorCommand(text);
    if (governorCommand) {
      if (governorCommand.type === "status") {
        return {
          channelId,
          threadTs,
          text: buildGovernorStatusSnapshotText(
            buildGovernorSnapshot(repositories, options.maxActiveProjects ?? 2),
          ),
        } satisfies SlackConversationReply;
      }
      if (governorCommand.type === "queue") {
        return {
          channelId,
          threadTs,
          text: buildGovernorQueueText(
            buildGovernorSnapshot(repositories, options.maxActiveProjects ?? 2),
          ),
        } satisfies SlackConversationReply;
      }
      if (governorCommand.type === "approval_backlog") {
        return {
          channelId,
          threadTs,
          text: buildGovernorApprovalBacklogText(
            buildGovernorSnapshot(repositories, options.maxActiveProjects ?? 2),
          ),
        } satisfies SlackConversationReply;
      }

      const project = await resolveProjectByIdentifier({
        repositories,
        projectId: governorCommand.projectId,
        slackClient: options.slackClient,
      });
      if (!project) {
        return {
          channelId,
          threadTs,
          text: `총괄: #${governorCommand.projectId} 프로젝트를 찾지 못했어요.`,
        } satisfies SlackConversationReply;
      }

      if (governorCommand.type === "mark_released") {
        const released = markProjectGoalReleased({
          repositories,
          projectId: project.id,
        });
        return {
          channelId,
          threadTs,
          text: buildGovernorReleaseText({
            projectId: project.id,
            changed: released?.changed === true,
            goalTitle: "goalTitle" in (released ?? {}) ? released?.goalTitle : undefined,
          }),
        } satisfies SlackConversationReply;
      }

      if (governorCommand.type === "archive") {
        const archived = archiveProjectGoal({
          repositories,
          projectId: project.id,
        });
        return {
          channelId,
          threadTs,
          text: buildGovernorArchiveText({
            projectId: project.id,
            changed: archived?.changed === true,
            goalTitle: "goalTitle" in (archived ?? {}) ? archived?.goalTitle : undefined,
          }),
        } satisfies SlackConversationReply;
      }

      if (governorCommand.type === "repair") {
        const repaired = repairProjectGoals({
          repositories,
          projectId: project.id,
        });
        return {
          channelId,
          threadTs,
          text: buildGovernorRepairText({
            projectId: project.id,
            repaired: repaired.repaired,
          }),
        } satisfies SlackConversationReply;
      }

      if (governorCommand.type === "pause") {
        repositories.projects.update({
          id: project.id,
          paused: true,
        });
      } else if (governorCommand.type === "resume") {
        repositories.projects.update({
          id: project.id,
          paused: false,
        });
      } else {
        repositories.projects.update({
          id: project.id,
          priority: governorCommand.priority,
        });
      }
      recordGovernorPolicyChange({
        repositories,
        projectId: project.id,
        action: governorCommand.type,
        priority: governorCommand.type === "reprioritize"
          ? governorCommand.priority
          : undefined,
      });

      return {
        channelId,
        threadTs,
        text: buildGovernorPolicyChangeText({
          projectId: project.id,
          action: governorCommand.type,
          priority: governorCommand.type === "reprioritize"
            ? governorCommand.priority
            : undefined,
        }),
      } satisfies SlackConversationReply;
    }

    const intent = detectConversationalIntent(text);
    const projectIds = repositories.projects.list().map((project) => project.id);
    if (intent) {
      return {
        channelId,
        threadTs,
        text:
          intent === "status"
            ? buildAiOpsStatusText(projectIds)
            : buildAiOpsGreetingText(projectIds),
      } satisfies SlackConversationReply;
    }
    if (!shouldUseGovernorConversation(text)) return null;
    if (options.governorConversationExecutor) {
      const reply = await options.governorConversationExecutor({
        text,
        knownProjects: projectIds,
        threadHistory: governorThreadHistory,
      });
      appendConversationHistory({
        memoryStore,
        scopeId: GOVERNOR_CONVERSATION_SCOPE,
        threadTs,
        userText: text,
        assistantText: reply.reply,
      });
      return {
        channelId,
        threadTs,
        text: reply.reply,
      } satisfies SlackConversationReply;
    }
    const fallbackReply =
      `총괄: 이건 여기서 바로 얘기해도 돼요. 실행이 필요해지면 \`프로젝트명: 목표\` 형식으로 넘기거나 해당 프로젝트 채널에서 이어가 주세요.`;
    appendConversationHistory({
      memoryStore,
      scopeId: GOVERNOR_CONVERSATION_SCOPE,
      threadTs,
      userText: text,
      assistantText: fallbackReply,
    });
    return {
      channelId,
      threadTs,
      text: fallbackReply,
    } satisfies SlackConversationReply;
  }

  const project = await resolveProjectForIncomingChannel({
    repositories,
    channelId,
    slackClient: options.slackClient,
  });
  if (!project) return null;
  const explicitProject = normalizeEventText(text);
  const explicitProjectMatch = explicitProject
    ? await resolveProjectByIdentifier({
        repositories,
        projectId: explicitProject.projectId,
        slackClient: options.slackClient,
      })
    : null;
  const threadGoal = readThreadGoal({
    repositories,
    memoryStore,
    projectId: project.id,
    threadTs: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
  });

  const workspaceCommand = parseProjectWorkspaceCommand(text);
  if (workspaceCommand) {
    return {
      channelId,
      threadTs,
      text: applyProjectWorkspaceCommand({
        memoryStore,
        projectId: project.id,
        command: workspaceCommand,
      }),
    } satisfies SlackConversationReply;
  }

  const command = parseCustomerVoiceCommand(text);
  if (command) {
    if (command.type !== "status") {
      applyCustomerVoiceCommand({
        memoryStore,
        projectId: project.id,
        command,
      });
    }
    return {
      channelId,
      threadTs,
      text: buildCustomerVoiceStatusText({
        projectId: project.id,
        profile: readProjectCustomerVoiceProfile({
          memoryStore,
          projectId: project.id,
        }),
      }),
    } satisfies SlackConversationReply;
  }

  const intent = detectConversationalIntent(text);
  if (intent) {
    return {
      channelId,
      threadTs,
      text:
        intent === "status"
          ? buildProjectStatusText(project.id)
          : buildProjectGreetingText(project.id),
    } satisfies SlackConversationReply;
  }
  if (
    explicitProjectMatch
    && explicitProjectMatch.id !== project.id
  ) {
    return null;
  }
  const captainThreadHistory = readConversationHistory({
    memoryStore,
    scopeId: project.id,
    threadTs,
  });
  const shouldConsultCaptainConversation =
    !explicitProjectMatch
      ? (
          options.captainConversationExecutor
            ? Boolean(threadGoal) || shouldUseCaptainConversation({
                text,
                hasThreadGoal: Boolean(threadGoal),
                hasConversationHistory: captainThreadHistory.length > 0,
                hasExplicitProjectOverride: false,
              })
            : shouldUseCaptainConversation({
                text,
                hasThreadGoal: Boolean(threadGoal),
                hasConversationHistory: captainThreadHistory.length > 0,
                hasExplicitProjectOverride: false,
              })
        )
      : false;
  if (shouldConsultCaptainConversation) {
    if (options.captainConversationExecutor) {
      const decision = await options.captainConversationExecutor({
        projectId: project.id,
        text,
        threadGoalTitle: threadGoal?.title ?? null,
        memoryStore,
        threadHistory: captainThreadHistory,
      });
      if (decision.mode === "reply") {
        appendConversationHistory({
          memoryStore,
          scopeId: project.id,
          threadTs,
          userText: text,
          assistantText: decision.reply,
        });
        return {
          channelId,
          threadTs,
          text: decision.reply,
        } satisfies SlackConversationReply;
      }
      return null;
    }
    const fallbackReply =
      threadGoal
        ? `캡틴: 이건 새 라운드로 태우기보다 지금 스레드 맥락에서 바로 얘기할 수 있어요. 실제 수정이나 검증이 필요해지면 한 줄로 요청해 주세요.`
        : `캡틴: 이건 바로 대화로 정리할 수 있어요. 실제 작업으로 돌릴 필요가 생기면 한 문장으로 요청해 주세요.`;
    appendConversationHistory({
      memoryStore,
      scopeId: project.id,
      threadTs,
      userText: text,
      assistantText: fallbackReply,
    });
    return {
      channelId,
      threadTs,
      text: fallbackReply,
    } satisfies SlackConversationReply;
  }
  return null;
}
