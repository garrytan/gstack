import type { Database } from "bun:sqlite";
import { renderTextArtifact } from "../artifacts/render";
import { writeArtifact } from "../artifacts/store";
import { MemoryStore } from "../memory/store";
import { evaluateAction } from "../orchestrator/approvals";
import { Captain } from "../orchestrator/captain";
import {
  buildFallbackCaptainPlan,
  normalizeCaptainPlanForGoal,
  type CaptainPlan,
} from "../orchestrator/captain-plan";
import {
  applyCustomerVoiceDecisionToPlan,
  decideCustomerVoiceDelegation,
  ensureProjectCustomerVoiceProfile,
} from "../orchestrator/customer-voice-director";
import { Governor } from "../orchestrator/governor";
import { runSpecialist, type SpecialistExecutor } from "../orchestrator/specialists";
import { ensureDefaultRolePlaybooks } from "../roles/playbooks";
import type { SpecialistResult } from "../roles/contracts";
import { buildApprovalRequest, publishImpactUpdate, type SlackMessageClient } from "../slack/publish";
import {
  buildCaptainFinalText,
  buildCaptainStartText,
  buildGovernorFinalText,
  buildImpactNarration,
  buildRoutingText,
} from "../slack/message-style";
import type { LoadedRunContext } from "./job-runner";
import { createRepositories } from "../state/repositories";
import type { SlackExternalUploadClient } from "../slack/files";

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
    followUpText: typeof candidate.followUpText === "string" ? candidate.followUpText : undefined,
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

function buildEffectiveGoalTitle(baseTitle: string, followUpText?: string) {
  const normalizedFollowUp = followUpText?.trim();
  if (!normalizedFollowUp) return baseTitle;
  return `${baseTitle}\n\n후속 피드백:\n${normalizedFollowUp}`;
}

function buildDisplayGoalTitle(baseTitle: string, followUpText?: string) {
  const normalizedFollowUp = followUpText?.trim();
  if (!normalizedFollowUp) return baseTitle;
  return `${baseTitle} — 후속 피드백 반영`;
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

function buildRoleExecutionOrder(plan: CaptainPlan, selectedRoles: string[]) {
  const ordered: string[] = [];

  for (const task of plan.taskGraph ?? []) {
    if (!selectedRoles.includes(task.role)) continue;
    if (!ordered.includes(task.role)) {
      ordered.push(task.role);
    }
  }

  for (const role of selectedRoles) {
    if (!ordered.includes(role)) {
      ordered.push(role);
    }
  }

  return ordered;
}

function determineFinalGoalState(
  impacts: Array<{ level: "info" | "blocking" | "approval_needed"; role: string }>,
) {
  if (impacts.some((impact) => impact.level === "blocking")) {
    return impacts.some((impact) => impact.role === "qa") ? "qa_failed" : "blocked";
  }
  if (impacts.some((impact) => impact.level === "approval_needed")) {
    return "awaiting_human_approval";
  }
  return "approved";
}

function shouldPostSpecialistMessage(result: SpecialistResult) {
  if (result.impact === "blocking" || result.impact === "approval_needed") return true;
  if (result.executionMode === "write") return true;
  if ((result.changedFiles?.length ?? 0) > 0) return true;
  if ((result.verificationNotes?.length ?? 0) > 0) return true;
  if (result.personaLabel) return true;
  return false;
}

function shouldPublishArtifact(result: SpecialistResult) {
  if (result.role === "qa") return true;
  if (result.role === "customer-voice" && ((result.verificationNotes?.length ?? 0) > 0 || result.personaLabel)) {
    return true;
  }
  if (result.executionMode === "write") return true;
  return false;
}

function supportsArtifactUpload(
  client: SlackMessageClient,
): client is SlackMessageClient & SlackExternalUploadClient {
  return (
    typeof (client as Partial<SlackExternalUploadClient>).getUploadURLExternal === "function"
    && typeof (client as Partial<SlackExternalUploadClient>).uploadBinary === "function"
    && typeof (client as Partial<SlackExternalUploadClient>).completeUploadExternal === "function"
  );
}

function buildSpecialistArtifactBody(result: SpecialistResult) {
  const lines = [
    `역할: ${result.role}`,
    `영향: ${result.impact}`,
    `실행 모드: ${result.executionMode ?? "analyze"}`,
  ];

  if (result.personaLabel) {
    lines.push(`페르소나: ${result.personaLabel}`);
  }

  lines.push("");
  lines.push("요약");
  lines.push(result.summary);

  if ((result.changedFiles?.length ?? 0) > 0) {
    lines.push("");
    lines.push("변경 파일");
    for (const file of result.changedFiles ?? []) {
      lines.push(`- ${file}`);
    }
  }

  if ((result.verificationNotes?.length ?? 0) > 0) {
    lines.push("");
    lines.push("검증");
    for (const note of result.verificationNotes ?? []) {
      lines.push(`- ${note}`);
    }
  }

  if ((result.rawFindings?.length ?? 0) > 0) {
    lines.push("");
    lines.push("근거");
    for (const finding of result.rawFindings ?? []) {
      lines.push(`- ${finding}`);
    }
  }

  return lines.join("\n");
}

function shouldExposeCustomerVoicePersona(input: {
  decision?: ReturnType<typeof decideCustomerVoiceDelegation>;
  personaCount: number;
}) {
  if (!input.decision) return false;
  if (input.personaCount > 1) return true;
  return input.decision.mode === "persona-driven" && !input.decision.needsSetup;
}

async function executeRole(input: {
  role: string;
  payload: GoalIntakePayload;
  context: LoadedRunContext;
  memoryStore: MemoryStore;
  specialistExecutor?: SpecialistExecutor;
  customerVoiceDecision?: ReturnType<typeof decideCustomerVoiceDelegation>;
}) {
  const effectiveGoalTitle = buildEffectiveGoalTitle(
    input.context.goal.title,
    input.payload.followUpText,
  );
  if (input.role !== "customer-voice" || !input.customerVoiceDecision?.enabled) {
    const result = await runSpecialist({
      role: input.role as Parameters<typeof runSpecialist>[0]["role"],
      input: {
        projectId: input.payload.projectId,
        runId: input.context.run.id,
        goalTitle: effectiveGoalTitle,
      },
      memoryStore: input.memoryStore,
      executor: input.specialistExecutor,
    });
    return [result];
  }

  const personas = input.customerVoiceDecision.selectedPersonas.length > 0
    ? input.customerVoiceDecision.selectedPersonas
    : [];

  if (personas.length === 0) {
    const result = await runSpecialist({
      role: "customer-voice",
      input: {
        projectId: input.payload.projectId,
        runId: input.context.run.id,
        goalTitle: effectiveGoalTitle,
        customerVoiceDecision: input.customerVoiceDecision,
      },
      memoryStore: input.memoryStore,
      executor: input.specialistExecutor,
    });
    return [result];
  }

  const results: SpecialistResult[] = [];
  const exposePersonaLabel = shouldExposeCustomerVoicePersona({
    decision: input.customerVoiceDecision,
    personaCount: personas.length,
  });
  for (const persona of personas) {
    const result = await runSpecialist({
      role: "customer-voice",
      input: {
        projectId: input.payload.projectId,
        runId: input.context.run.id,
        goalTitle: effectiveGoalTitle,
        personaLabel: persona.label,
        customerVoiceDecision: input.customerVoiceDecision,
        customerVoicePersona: persona,
      },
      memoryStore: input.memoryStore,
      executor: input.specialistExecutor,
    });
    results.push({
      ...result,
      personaLabel: exposePersonaLabel ? (result.personaLabel ?? persona.label) : undefined,
    });
  }
  return results;
}

export function createRuntimeDispatcher(input: {
  db: Database;
  slackClient: SlackMessageClient;
  maxActiveProjects: number;
  artifactRoot?: string;
  specialistExecutor?: SpecialistExecutor;
  captainExecutor?: (input: {
    projectId: string;
    goalTitle: string;
    runId?: string | null;
    memoryStore?: MemoryStore;
  }) => Promise<CaptainPlan>;
}) {
  const memoryStore = new MemoryStore(input.db);
  const repositories = createRepositories(input.db);
  ensureDefaultRolePlaybooks(memoryStore);
  for (const project of repositories.projects.list()) {
    ensureProjectCustomerVoiceProfile({
      memoryStore,
      projectId: project.id,
    });
  }
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
      const effectiveGoalTitle = buildEffectiveGoalTitle(context.goal.title, payload.followUpText);
      const displayGoalTitle = buildDisplayGoalTitle(context.goal.title, payload.followUpText);

      const currentGoalState = repositories.goals.get(payload.goalId)?.state ?? context.goal.state;
      if (currentGoalState !== "in_progress") {
        repositories.stateTransitions.append({
          id: `transition-${context.run.id}-start`,
          goalId: payload.goalId,
          fromState: currentGoalState,
          toState: "in_progress",
          createdAt: new Date().toISOString(),
          actor: "captain",
        });
      }
      ensureProjectCustomerVoiceProfile({
        memoryStore,
        projectId: payload.projectId,
      });

      let projectThreadTs = payload.projectThreadTs;
      const rawCaptainPlan = normalizeCaptainPlanForGoal(
        effectiveGoalTitle,
        input.captainExecutor
        ? await input.captainExecutor({
            projectId: payload.projectId,
            goalTitle: effectiveGoalTitle,
            runId: context.run.id,
            memoryStore,
          })
        : buildFallbackCaptainPlan(effectiveGoalTitle),
      );
      const customerVoiceDecision = decideCustomerVoiceDelegation({
        memoryStore,
        projectId: payload.projectId,
        goalTitle: effectiveGoalTitle,
        selectedRoles: rawCaptainPlan.selectedRoles,
      });
      const captainPlan = applyCustomerVoiceDecisionToPlan({
        plan: rawCaptainPlan,
        decision: customerVoiceDecision,
        goalTitle: effectiveGoalTitle,
      });
      if (context.run.id) {
        memoryStore.putRunFact(
          context.run.id,
          "customer_voice.decision_json",
          JSON.stringify(customerVoiceDecision),
        );
      }
      const specialistRoles = captainPlan.selectedRoles.length > 0
        ? captainPlan.selectedRoles
        : buildFallbackCaptainPlan(effectiveGoalTitle).selectedRoles;
      captain.capturePlan(payload.projectId, context.run.id, captainPlan);
      for (const task of captainPlan.taskGraph) {
        input.db.query(
          `insert into tasks (id, goal_id, run_id, role, state, payload_json, attempt_count, started_at, finished_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             goal_id = excluded.goal_id,
             run_id = excluded.run_id,
             role = excluded.role,
             state = excluded.state,
             payload_json = excluded.payload_json,
             attempt_count = excluded.attempt_count,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at`,
        ).run(
          `${context.run.id}:${task.id}`,
          payload.goalId,
          context.run.id,
          task.role,
          task.dependsOn.length === 0 ? "ready" : "planned",
          JSON.stringify(task),
          0,
          null,
          null,
        );
      }
      if (
        payload.sourceChannelId
        && payload.sourceChannelId !== payload.projectChannelId
      ) {
        const governorUpdate = await input.slackClient.postMessage({
          channel: payload.sourceChannelId,
          thread_ts: payload.intakeThreadTs,
          text: buildRoutingText(payload.projectId, captainPlan),
        });
        if (!governorUpdate.ok) {
          throw new Error("Slack rejected governor routing update");
        }
      }

      if (!projectThreadTs) {
        const root = await input.slackClient.postMessage({
          channel: portfolio.projectChannelId,
          text: buildCaptainStartText(displayGoalTitle, specialistRoles, captainPlan),
        });
        if (!root.ok || !root.ts) {
          throw new Error("Slack rejected project thread root");
        }
        projectThreadTs = root.ts;
      } else {
        const ack = await input.slackClient.postMessage({
          channel: portfolio.projectChannelId,
          thread_ts: projectThreadTs,
          text: buildCaptainStartText(displayGoalTitle, specialistRoles, captainPlan),
        });
        if (!ack.ok) {
          throw new Error("Slack rejected project thread acknowledgement");
        }
      }
      memoryStore.putProjectFact(payload.projectId, `captain.thread.${projectThreadTs}.goal_id`, payload.goalId);
      memoryStore.putProjectFact(payload.projectId, `captain.goal.${payload.goalId}.thread_ts`, projectThreadTs);

      const specialistResults = [];
      for (const role of buildRoleExecutionOrder(captainPlan, specialistRoles)) {
        const roleTasks = captainPlan.taskGraph.filter((task) => task.role === role);
        const now = new Date().toISOString();
        for (const task of roleTasks) {
          const taskId = `${context.run.id}:${task.id}`;
          const currentTask = repositories.tasks.get(taskId);
          repositories.tasks.updateState({
            id: taskId,
            state: "running",
            attemptCount: (currentTask?.attemptCount ?? 0) + 1,
            startedAt: now,
            finishedAt: null,
          });
        }
        const results = await executeRole({
          role,
          payload,
          context,
          memoryStore,
          specialistExecutor: input.specialistExecutor,
          customerVoiceDecision,
        });
        for (const result of results) {
          specialistResults.push(result);
          if (shouldPostSpecialistMessage(result)) {
            if (
              input.artifactRoot
              && shouldPublishArtifact(result)
              && supportsArtifactUpload(input.slackClient)
            ) {
              const artifactTitle = result.artifacts[0]?.title ?? `${result.role}-report.md`;
              const rendered = renderTextArtifact({
                fileName: artifactTitle,
                title: artifactTitle,
                body: buildSpecialistArtifactBody(result),
                format: artifactTitle.endsWith(".json") ? "json" : "md",
              });
              const stored = writeArtifact({
                root: input.artifactRoot,
                projectId: payload.projectId,
                goalId: payload.goalId,
                fileName: rendered.fileName,
                content: rendered.content,
              });
              const published = await publishImpactUpdate({
                client: input.slackClient,
                channelId: portfolio.projectChannelId,
                threadTs: projectThreadTs,
                role: result.role,
                summary: result.summary,
                impact: result.impact,
                artifact: {
                  fileName: rendered.fileName,
                  content: rendered.content,
                  title: artifactTitle,
                },
              });
              repositories.artifacts.create({
                id: `artifact-${context.run.id}-${result.role}-${Date.now()}`,
                goalId: payload.goalId,
                kind: result.role,
                localPath: stored.path,
                slackFileId: published.uploaded.fileId ?? null,
              });
            } else {
              const message = await input.slackClient.postMessage({
                channel: portfolio.projectChannelId,
                thread_ts: projectThreadTs,
                text: buildImpactNarration({
                  role: result.role,
                  summary: result.summary,
                  level: result.impact,
                  changedFiles: result.changedFiles,
                  verificationNotes: result.verificationNotes,
                  executionMode: result.executionMode,
                  personaLabel: result.personaLabel,
                }),
              });
              if (!message.ok) {
                throw new Error(`Slack rejected ${result.role} impact message`);
              }
            }
          }
        }
        const roleImpact = results.some((result) => result.impact === "blocking")
          ? "blocked"
          : "succeeded";
        const finishedAt = new Date().toISOString();
        for (const task of roleTasks) {
          repositories.tasks.updateState({
            id: `${context.run.id}:${task.id}`,
            state: roleImpact,
            finishedAt,
          });
        }
        const succeededTaskIds = new Set(
          repositories.tasks
            .listByRun(context.run.id)
            .filter((task) => task.state === "succeeded")
            .map((task) => task.id.replace(`${context.run.id}:`, "")),
        );
        for (const task of captainPlan.taskGraph) {
          const taskId = `${context.run.id}:${task.id}`;
          const currentTask = repositories.tasks.get(taskId);
          if (!currentTask || currentTask.state !== "planned") continue;
          if (task.dependsOn.every((dependency) => succeededTaskIds.has(dependency))) {
            repositories.tasks.updateState({
              id: taskId,
              state: "ready",
            });
          }
        }
      }
      captain.captureSpecialistResults(payload.projectId, specialistResults);

      const goalStateBeforeQa = repositories.goals.get(payload.goalId)?.state ?? context.goal.state;
      if (goalStateBeforeQa !== "awaiting_qa") {
        repositories.stateTransitions.append({
          id: `transition-${context.run.id}-awaiting-qa`,
          goalId: payload.goalId,
          fromState: goalStateBeforeQa,
          toState: "awaiting_qa",
          createdAt: new Date().toISOString(),
          actor: "captain",
        });
      }

      const baseFinalGoalState = determineFinalGoalState(
        specialistResults.map((result) => ({
          role: result.role,
          level: result.impact,
        })),
      );
      const deployDecision =
        baseFinalGoalState === "approved" && payload.isFinalGoal && payload.requiresDeployApproval
          ? evaluateAction({ type: "deploy" })
          : null;
      const finalGoalState =
        deployDecision && !deployDecision.allowed
          ? deployDecision.state
          : baseFinalGoalState;

      const summary = captain.composeProjectSummary({
        projectId: payload.projectId,
        projectThreadTs: projectThreadTs,
        summary: buildCaptainFinalText({
          finalState: finalGoalState,
          impacts: specialistResults.map((result) => ({
            role: result.role,
            level: result.impact,
            message: result.summary,
            changedFiles: result.changedFiles,
            verificationNotes: result.verificationNotes,
          })),
          nextAction: captainPlan.nextAction,
        }),
        impacts: specialistResults.map((result) => ({
          role: result.role,
          level: result.impact,
          message: result.summary,
        })),
      });
      const summaryResponse = await input.slackClient.postMessage({
        channel: summary.channelId,
        thread_ts: summary.threadTs,
        text: summary.summary,
      });
      if (!summaryResponse.ok) {
        throw new Error("Slack rejected project summary");
      }

      if (
        payload.sourceChannelId
        && payload.sourceChannelId !== payload.projectChannelId
      ) {
        const leadImpact = [...specialistResults].sort((left, right) => {
          const rank = { blocking: 0, approval_needed: 1, info: 2 } as const;
          return rank[left.impact] - rank[right.impact];
        })[0] ?? null;
        const governorFinal = await input.slackClient.postMessage({
          channel: payload.sourceChannelId,
          thread_ts: payload.intakeThreadTs,
          text: buildGovernorFinalText({
            projectId: payload.projectId,
            finalState: finalGoalState,
            leadSummary: leadImpact?.summary ?? null,
            changedFiles: specialistResults.flatMap((result) => result.changedFiles ?? []),
            nextAction: captainPlan.nextAction,
          }),
        });
        if (!governorFinal.ok) {
          throw new Error("Slack rejected governor completion update");
        }
      }

      if (deployDecision && !deployDecision.allowed) {
          const approvalId = `approval-${context.run.id}`;
          requestApproval({
            db: input.db,
            approvalId,
            goalId: payload.goalId,
            actionType: "deploy",
            rationale: deployDecision.blockingReason ?? null,
            fromState: "approved",
            toState: deployDecision.state,
            actor: "governor",
          });

          const approvalRequest = buildApprovalRequest({
            approvalId,
            goalId: payload.goalId,
            actionType: "deploy",
            blockingReason: deployDecision.blockingReason ?? "deployment requires human approval",
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
      } else {
        const currentGoalState = repositories.goals.get(payload.goalId)?.state ?? context.goal.state;
        if (currentGoalState !== finalGoalState) {
          repositories.stateTransitions.append({
            id: `transition-${context.run.id}-final`,
            goalId: payload.goalId,
            fromState: currentGoalState,
            toState: finalGoalState,
            createdAt: new Date().toISOString(),
            actor: "captain",
          });
        }
      }
    } finally {
      governor.finishProject(context.project.id);
    }
  };
}
