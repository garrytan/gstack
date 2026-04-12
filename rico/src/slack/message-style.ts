const CHATGPT_FOOTER_PATTERN =
  /\*?(?:다음을\s+사용하여\s+보냄|Sent using)\*?\s*ChatGPT/gi;

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

export function buildRoutingText(projectId: string) {
  return `이 건은 #${projectId} 채널에서 이어갈게요.`;
}

export function buildCaptainStartText(title: string) {
  return `이번 목표는 "${title}" 기준으로 바로 진행해볼게요.`;
}

export function buildCaptainProgressText(title: string) {
  return `지금은 "${title}" 기준으로 정리하면서 진행 중이에요.`;
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
  if (role === "qa") {
    return `QA에서 확인해보니 ${summary}`;
  }
  if (role === "customer-voice") {
    return `고객 관점에서는 ${summary}`;
  }
  if (role === "planner") {
    return `기획 쪽에서는 ${summary}`;
  }
  if (role === "designer") {
    return `디자인 관점에서는 ${summary}`;
  }
  if (role === "frontend") {
    return `프론트엔드 쪽에서는 ${summary}`;
  }
  if (role === "backend") {
    return `백엔드 쪽에서는 ${summary}`;
  }
  return summary;
}
