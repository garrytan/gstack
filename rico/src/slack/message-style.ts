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

export function buildRoutingText(projectId: string) {
  return `총괄: 이 건은 #${projectId} 채널에서 이어갈게요.`;
}

export function buildAiOpsGreetingText(projectIds: string[]) {
  const knownProjects = projectIds.length > 0 ? projectIds.join(", ") : "등록된 프로젝트";
  return `안녕하세요. 여기서는 \`프로젝트명: 목표\` 형식으로 말해주시면 바로 넘길게요. 지금 연결된 프로젝트는 ${knownProjects}예요.`;
}

export function buildAiOpsStatusText(projectIds: string[]) {
  const knownProjects = projectIds.length > 0 ? projectIds.join(", ") : "아직 등록된 프로젝트가 없어요";
  return `지금 연결된 프로젝트는 ${knownProjects}예요. 여기서는 \`프로젝트명: 목표\` 형식으로 요청해주시면 바로 진행할게요.`;
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

export function buildCaptainStartText(title: string, roles: RoleName[] = []) {
  return `캡틴: 이번 목표는 "${title}" 기준으로 바로 진행해볼게요. 이번 라운드에서는 ${joinRoleLabels(roles)}으로 먼저 볼게요.`;
}

export function buildCaptainProgressText(title: string) {
  return `캡틴: 지금은 "${title}" 기준으로 정리하면서 진행 중이에요.`;
}

export function buildApprovalText(actionType: string, blockingReason: string) {
  return `이 단계는 ${actionType} 전에 사람 확인이 필요해요. ${blockingReason}`;
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
