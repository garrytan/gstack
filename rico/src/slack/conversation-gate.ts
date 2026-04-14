import type { MemoryStore } from "../memory/store";

export interface ConversationTurn {
  speaker: "user" | "assistant";
  text: string;
}

export interface GovernorConversationInput {
  text: string;
  knownProjects: string[];
  threadHistory?: ConversationTurn[];
}

export interface GovernorConversationReply {
  reply: string;
}

export interface CaptainConversationInput {
  projectId: string;
  text: string;
  threadGoalTitle?: string | null;
  memoryStore?: MemoryStore;
  threadHistory?: ConversationTurn[];
}

export interface CaptainConversationDecision {
  mode: "reply" | "delegate";
  reply: string;
  delegateReason?: string | null;
}

const ACTION_REQUEST_PATTERN =
  /(해줘|해주세요|해 볼|진행해|진행하자|수정해|고쳐|고치|손봐|다듬어|추가해|추가하자|만들어|작성해|반영해|붙여|이어줘|연결해|점검해|검증해|테스트해|태워|실행해|배포해|정리해|보완해|리포트|분석해)/i;
const DISCUSSION_PATTERN =
  /(\?$|왜|뭐가|어떻게|어떤|생각해|의견|맞아|괜찮아|설명해|알려줘|지금|근데|그러면|그럼|혹시|이유)/i;
const BULLET_PATTERN = /(^|\n)\s*[-*•]\s+/;
const DELIVERABLE_PATTERN =
  /(문서|초안|카피|문구|랜딩|cta|정리|수정|연결|링크|보고|결과|리포트|검증|점검|구현|적어줘|써줘|남겨줘)/i;

export function looksLikeExecutionRequest(text: string) {
  const normalized = text.trim();
  if (!normalized) return false;
  if (BULLET_PATTERN.test(normalized)) return true;
  if (ACTION_REQUEST_PATTERN.test(normalized) && DELIVERABLE_PATTERN.test(normalized)) {
    return true;
  }
  if (ACTION_REQUEST_PATTERN.test(normalized) && !DISCUSSION_PATTERN.test(normalized)) {
    return true;
  }
  if (normalized.length > 80 && ACTION_REQUEST_PATTERN.test(normalized)) {
    return true;
  }
  return false;
}

export function shouldUseGovernorConversation(text: string) {
  return text.trim().length > 0;
}

export function shouldUseCaptainConversation(input: {
  text: string;
  hasThreadGoal: boolean;
  hasExplicitProjectOverride: boolean;
}) {
  if (input.hasExplicitProjectOverride) return false;
  if (!input.text.trim()) return false;
  if (input.hasThreadGoal && !looksLikeExecutionRequest(input.text)) {
    return true;
  }
  if (DISCUSSION_PATTERN.test(input.text) && !looksLikeExecutionRequest(input.text)) {
    return true;
  }
  return false;
}
