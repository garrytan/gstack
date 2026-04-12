import type { ImpactLevel } from "../roles/contracts";
import type { CaptainPlan } from "../orchestrator/captain-plan";
import type { RoleName } from "../roles";

const CHATGPT_FOOTER_PATTERN =
  /\*?(?:다음을\s+사용하여\s+보냄|Sent using)\*?\s*ChatGPT/gi;
const GREETING_PATTERN = /^(안녕+|안녕하세요|ㅎㅇ|hello|hi|hey|반가워)([!.?\s~]*)$/i;
const STATUS_PATTERN = /^(상태|status|지금 상태|뭐하고 있어|무슨 일 하고 있어|도움말|help)([!.?\s~]*)$/i;

function cleanWhitespace(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function sanitizeIncomingSlackText(text: string) {
  return cleanWhitespace(text.replace(CHATGPT_FOOTER_PATTERN, ""));
}

export type ConversationalIntent = "greeting" | "status" | null;

export function detectConversationalIntent(text: string): ConversationalIntent {
  const normalized = sanitizeIncomingSlackText(text);
  if (GREETING_PATTERN.test(normalized)) return "greeting";
  if (STATUS_PATTERN.test(normalized)) return "status";
  return null;
}

export function buildAiOpsGreetingText(projectIds: string[]) {
  const knownProjects = projectIds.length > 0 ? projectIds.join(", ") : "등록된 프로젝트";
  return `총괄: 여기서는 \`프로젝트명: 목표\` 형식으로 말해주시면 바로 넘길게요. 지금 연결된 프로젝트는 ${knownProjects}예요.`;
}

export function buildAiOpsStatusText(projectIds: string[]) {
  const knownProjects = projectIds.length > 0 ? projectIds.join(", ") : "아직 등록된 프로젝트가 없어요";
  return `총괄: 지금 연결된 프로젝트는 ${knownProjects}예요. 여기서는 \`프로젝트명: 목표\` 형식으로 요청해주시면 바로 진행할게요.`;
}

export function buildProjectGreetingText(projectId: string) {
  return `안녕하세요. 이 채널은 ${projectId} 프로젝트 전용이에요. 목표를 한 문장으로 남겨주시면 바로 이어서 볼게요.`;
}

export function buildProjectStatusText(projectId: string) {
  return `여기는 ${projectId} 프로젝트 채널이에요. 작업 요청을 남겨주시면 바로 이어서 진행할게요.`;
}

function roleLabel(role: RoleName | string) {
  if (role === "planner") return "기획";
  if (role === "designer") return "디자인";
  if (role === "frontend") return "프론트엔드";
  if (role === "backend") return "백엔드";
  if (role === "qa") return "QA";
  if (role === "customer-voice") return "고객 관점";
  return role;
}

function joinRoleLabels(roles: Array<RoleName | string>) {
  const labels = roles.map(roleLabel);
  if (labels.length === 0) return "캡틴";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]}과 ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, ${labels.at(-1)}`;
}

function hasFinalConsonant(text: string) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const code = text.charCodeAt(index);
    if (code < 0xac00 || code > 0xd7a3) continue;
    return (code - 0xac00) % 28 !== 0;
  }
  return false;
}

function objectParticle(text: string) {
  return hasFinalConsonant(text) ? "을" : "를";
}

function buildAssignmentText(plan?: CaptainPlan, roles: Array<RoleName | string> = []) {
  const assignments = plan?.taskGraph?.length
    ? plan.taskGraph.map((task) => `${roleLabel(task.role)}에게 ${task.title}${objectParticle(task.title)}`)
    : roles.map((role) => {
        const label = roleLabel(role);
        const taskTitle = `${label} 1차 검토`;
        return `${label}에게 ${taskTitle}${objectParticle(taskTitle)}`;
      });
  if (assignments.length === 0) return null;
  return assignments.join(", ");
}

export function buildRoutingText(projectId: string, plan?: CaptainPlan) {
  const base = `총괄: 이 건은 #${projectId} 채널에서 이어갈게요.`;
  const assignmentText = buildAssignmentText(plan, plan?.selectedRoles ?? []);
  if (!assignmentText) return base;
  return `${base} 캡틴에게는 ${assignmentText} 먼저 보게 하라고 전달했어요.`;
}

function firstSentence(text: string, fallback: string) {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  const match = trimmed.match(/^(.+?[.!?]|.+?$)/);
  return match?.[1]?.trim() ?? fallback;
}

function trimMessage(text: string, limit = 90) {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function impactPriority(impact: ImpactLevel) {
  if (impact === "blocking") return 0;
  if (impact === "approval_needed") return 1;
  return 2;
}

export function buildCaptainStartText(
  _title: string,
  roles: RoleName[] = [],
  plan?: CaptainPlan,
) {
  const firstPass = joinRoleLabels(roles);
  const nextAction = plan?.nextAction ? ` 먼저 ${plan.nextAction}` : "";
  if (plan?.status === "blocked" && plan.blockedReason) {
    return `캡틴: 먼저 막힌 조건부터 푸는 게 맞아요. ${plan.blockedReason}${nextAction}`;
  }
  if (plan?.status === "needs_decision" && plan.blockedReason) {
    return `캡틴: 먼저 결정이 필요한 쟁점을 좁히고 갈게요. ${plan.blockedReason}${nextAction}`;
  }
  if (roles.length === 0) {
    return `캡틴: 요청 확인했어요. 먼저 범위와 리스크를 빠르게 정리하고, 바로 다음 액션을 제안할게요.${nextAction}`;
  }
  const assignmentText = buildAssignmentText(plan, roles);
  if (assignmentText) {
    return `캡틴: 이번 라운드에서는 ${assignmentText} 맡길게요.${nextAction}`;
  }
  return `캡틴: 요청 확인했어요. 먼저 ${firstPass}에서 봐야 할 핵심 전제와 리스크를 빠르게 확인한 뒤, 실행 순서를 제안할게요.${nextAction}`;
}

export function buildCaptainProgressText(
  _title: string,
  impacts: Array<{ role: string; level: ImpactLevel; message: string }> = [],
  plan?: CaptainPlan,
) {
  if (impacts.length === 0) {
    return plan?.nextAction
      ? `캡틴: 지금은 계획을 실행 가능한 순서로 다듬고 있어요. 다음 액션은 ${plan.nextAction}`
      : "캡틴: 지금은 검토 결과를 한 줄 계획으로 묶고 있어요. 바로 다음 액션이 보이게 정리해서 넘길게요.";
  }

  const sorted = [...impacts].sort(
    (left, right) => impactPriority(left.level) - impactPriority(right.level),
  );
  const lead = sorted[0]!;
  const supportingRoles = sorted.slice(1, 3).map((impact) => roleLabel(impact.role));
  const supportingText =
    supportingRoles.length > 0 ? ` ${supportingRoles.join(", ")} 의견까지 묶어서.` : "";
  const leadSummary = trimMessage(
    firstSentence(lead.message, "핵심 쟁점을 먼저 정리하고 있어요."),
  );

  if (lead.level === "blocking") {
    const nextAction = plan?.nextAction ? ` 다음 액션은 ${plan.nextAction}` : "";
    return `캡틴: 지금은 ${roleLabel(lead.role)}에서 막히는 조건이 보여서 그 이슈부터 정리하고 있어요.${supportingText} ${leadSummary}${nextAction}`;
  }

  if (lead.level === "approval_needed") {
    const nextAction = plan?.nextAction ? ` 다음 액션은 ${plan.nextAction}` : "";
    return `캡틴: 지금은 ${roleLabel(lead.role)} 기준으로 먼저 결정이 필요한 지점을 모으고 있어요.${supportingText} ${leadSummary}${nextAction}`;
  }

  const nextAction = plan?.nextAction
    ? ` 다음 액션은 ${plan.nextAction}`
    : " 다음 단계는 여기서 바로 이어갈게요.";
  return `캡틴: 지금까지는 ${roleLabel(lead.role)} 중심으로 실행 순서를 좁혔어요.${supportingText}${nextAction} ${leadSummary}`;
}

export function buildApprovalText(actionType: string, blockingReason: string) {
  return `총괄: 이 단계는 ${actionType} 전에 사람 확인이 필요해요. ${blockingReason}`;
}

export function buildApprovalResolutionText(input: {
  approvalId: string;
  nextState: "approved" | "rejected";
  actionType: string;
  actor: string;
}) {
  const action = input.nextState === "approved" ? "승인됐어요" : "반려됐어요";
  return `${input.actionType} 요청(${input.approvalId})은 ${action}. 처리한 사람은 ${input.actor}예요.`;
}

export function buildImpactNarration(role: string, summary: string) {
  return `${roleLabel(role)}: ${summary}`;
}
