import { MemoryStore } from "../memory/store";
import { determineSpecialistExecutionMode } from "../codex/executor";
import { ROLE_REGISTRY, type RoleName } from "../roles";
import {
  type ImpactLevel,
  type SpecialistResult,
  validateSpecialistResult,
} from "../roles/contracts";
import type { CodexSpecialistExecution } from "../codex/executor";
import type {
  CustomerVoiceDelegationDecision,
  CustomerVoicePersona,
} from "./customer-voice-director";

export interface SpecialistImpact {
  role: string;
  level: ImpactLevel;
  message: string;
}

function enforceResultContracts(result: SpecialistResult) {
  if (
    result.role === "qa"
    && result.impact === "blocking"
    && (!result.verificationNotes || result.verificationNotes.length === 0)
  ) {
    return {
      ...result,
      impact: "approval_needed" as const,
      summary: `${result.summary} 검증 근거가 더 필요해요.`,
    };
  }

  return result;
}

function executorFailureSummary(role: RoleName, executionMode: "analyze" | "write") {
  if (executionMode === "write") {
    return `${ROLE_REGISTRY[role].role} 실행기에서 오류가 나서 실제 수정 또는 검증을 끝내지 못했어요.`;
  }
  return `${ROLE_REGISTRY[role].role} 분석 실행기에서 오류가 나서 이번 라운드 근거 수집이 중단됐어요.`;
}

export type SpecialistExecutor = (input: {
  role: RoleName;
  projectId: string;
  goalTitle: string;
  runId?: string | null;
  memoryStore?: MemoryStore;
  personaLabel?: string;
  customerVoiceDecision?: CustomerVoiceDelegationDecision;
  customerVoicePersona?: CustomerVoicePersona;
}) => Promise<CodexSpecialistExecution | SpecialistResult>;

function isWrappedExecution(
  value: CodexSpecialistExecution | SpecialistResult,
): value is CodexSpecialistExecution {
  return "result" in value && "meta" in value;
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function buildQaSummary(goalTitle: string) {
  const normalized = goalTitle.toLowerCase();

  if (includesAny(normalized, ["git", "repo", "repository", "remote", "원격", "저장소", "레포"])) {
    return "어느 저장소와 어느 원격을 기준으로 볼지 먼저 고정해야 확인이 정확해져요.";
  }
  if (includesAny(normalized, ["deploy", "배포", "release", "릴리즈"])) {
    return "배포 전에 확인할 체크리스트와 롤백 기준을 먼저 분리해두는 게 좋아요.";
  }
  if (includesAny(normalized, ["report", "리포트", "summary", "요약", "대시보드"])) {
    return "비교 기준과 확인할 수치를 먼저 정해두면 검증이 훨씬 쉬워져요.";
  }
  if (includesAny(normalized, ["onboarding", "온보딩", "signup", "가입", "회원가입"])) {
    return "온보딩 흐름에서 깨질 수 있는 단계와 확인 포인트를 먼저 잡아둘게요.";
  }
  return `"${goalTitle}" 작업은 완료 기준과 실패 조건을 먼저 정해두면 검증이 쉬워져요.`;
}

function buildPlannerSummary(goalTitle: string) {
  const normalized = goalTitle.toLowerCase();

  if (includesAny(normalized, ["제안", "아이디어", "브레인스토밍", "기획안", "목표"])) {
    return "첫 목표 후보를 세 개 정도로 줄인 뒤, 가장 빨리 끝낼 수 있는 것 하나를 먼저 고르는 게 좋아요.";
  }
  if (includesAny(normalized, ["온보딩", "signup", "가입", "회원가입"])) {
    return "온보딩은 어디서 이탈하는지와 무엇을 바꾸려는지부터 좁혀두면 실행이 빨라져요.";
  }
  if (includesAny(normalized, ["리포트", "report", "대시보드", "요약"])) {
    return "리포트는 누가 보고 어떤 결정을 내릴지부터 정하면 범위를 줄이기 쉬워요.";
  }
  return `"${goalTitle}" 작업은 범위와 완료 조건을 먼저 고정해두면 흐름이 매끄러워져요.`;
}

function buildCustomerVoiceSummary(goalTitle: string) {
  const normalized = goalTitle.toLowerCase();

  if (includesAny(normalized, ["제안", "아이디어", "브레인스토밍", "기획안", "목표"])) {
    return "이 채널을 보는 사람이 무엇을 바로 해야 하는지까지 드러나야 목표가 살아나요.";
  }
  if (includesAny(normalized, ["git", "repo", "repository", "remote", "원격", "저장소", "레포"])) {
    return "어떤 저장소를 왜 확인하려는지와 기대하는 답을 한 줄 더 분명히 적어두면 덜 헷갈려요.";
  }
  if (includesAny(normalized, ["deploy", "배포", "release", "릴리즈"])) {
    return "사용자가 체감할 변화와 리스크를 같이 보여줘야 승인 판단이 빨라져요.";
  }
  if (includesAny(normalized, ["report", "리포트", "summary", "요약", "대시보드"])) {
    return "누가 이 결과를 보고 어떤 결정을 내리는지까지 드러나면 가치가 더 선명해져요.";
  }
  if (includesAny(normalized, ["onboarding", "온보딩", "signup", "가입", "회원가입"])) {
    return "사용자가 어디에서 망설이는지까지 보여줘야 개선 이유가 더 또렷해져요.";
  }
  return `지금 요청에서 왜 이게 중요한지와 기대 결과를 한 줄 더 적어두면 판단이 빨라져요.`;
}

function buildDefaultSummary(role: RoleName, goalTitle: string) {
  if (role === "qa") return buildQaSummary(goalTitle);
  if (role === "customer-voice") return buildCustomerVoiceSummary(goalTitle);
  if (role === "planner") {
    return buildPlannerSummary(goalTitle);
  }
  if (role === "designer") {
    return `"${goalTitle}" 작업은 사용자가 한 번에 이해할 수 있는 흐름으로 정리하는 게 좋아요.`;
  }
  if (role === "frontend") {
    return `"${goalTitle}" 작업은 화면에서 바로 확인할 기준을 먼저 맞춰두는 게 좋아요.`;
  }
  if (role === "backend") {
    return `"${goalTitle}" 작업은 데이터 경계와 실패 케이스를 먼저 정리해두는 게 좋아요.`;
  }
  return goalTitle.length > 0 ? `"${goalTitle}" 기준으로 정리해볼게요.` : `${role} completed`;
}

export function preserveSpecialistImpacts(
  impacts: SpecialistImpact[],
): SpecialistImpact[] {
  return impacts.map((impact) => ({ ...impact }));
}

export async function runSpecialist(input: {
  role: RoleName;
  input: Record<string, unknown> & {
    personaLabel?: string;
    customerVoiceDecision?: CustomerVoiceDelegationDecision;
    customerVoicePersona?: CustomerVoicePersona;
  };
  memoryStore?: MemoryStore;
  executor?: SpecialistExecutor;
}) {
  const profile = ROLE_REGISTRY[input.role];
  if (!profile) {
    throw new Error(`unknown role: ${input.role}`);
  }

  const goalTitle =
    typeof input.input.goalTitle === "string" && input.input.goalTitle.length > 0
      ? input.input.goalTitle.trim()
      : "";
  const requestedSummary =
    typeof input.input.summary === "string" && input.input.summary.length > 0
      ? input.input.summary
      : buildDefaultSummary(input.role, goalTitle);
  const projectId =
    typeof input.input.projectId === "string" ? input.input.projectId : null;
  const runId = typeof input.input.runId === "string" ? input.input.runId : null;

  let result: SpecialistResult | null = null;
  if (input.executor && projectId) {
    try {
      const executed = await input.executor({
        role: input.role,
        projectId,
        goalTitle,
        runId,
        memoryStore: input.memoryStore,
        personaLabel: input.input.personaLabel,
        customerVoiceDecision: input.input.customerVoiceDecision,
        customerVoicePersona: input.input.customerVoicePersona,
      });
      result = isWrappedExecution(executed) ? executed.result : executed;
      if (input.memoryStore && isWrappedExecution(executed)) {
        input.memoryStore.putRunFact(
          runId ?? `run-${input.role}`,
          `specialist.${input.role}.codex_tokens`,
          String(executed.meta.tokensUsed),
        );
        if (executed.meta.workspacePath) {
          input.memoryStore.putProjectFact(
            projectId,
            "project.repo_root",
            executed.meta.workspacePath,
          );
          input.memoryStore.putProjectFact(
            projectId,
            "project.repo_root_source",
            "auto",
          );
        }
      }
    } catch (error) {
      const executionMode = determineSpecialistExecutionMode({
        role: input.role,
        goalTitle,
      });
      const message = error instanceof Error ? error.message : String(error);
      if (input.memoryStore && runId) {
        input.memoryStore.putRunFact(
          runId,
          `specialist.${input.role}.executor_error`,
          message,
        );
      }
      if (executionMode === "write") {
        result = {
          role: input.role,
          summary: executorFailureSummary(input.role, executionMode),
          impact: "blocking",
          artifacts: [{ kind: "report", title: `${input.role}-report.md` }],
          rawFindings: [message],
          executionMode,
          changedFiles: [],
          verificationNotes: [],
          personaLabel: input.input.personaLabel,
        };
      } else {
        result = null;
      }
    }
  }

  if (!result) {
    result = {
      role: input.role,
      summary: requestedSummary,
      impact: profile.defaultImpact,
      artifacts: [{ kind: "report", title: `${input.role}-report.md` }],
      rawFindings: [profile.invoke],
      personaLabel: input.input.personaLabel,
    };
  }

  result = enforceResultContracts(result);
  const validated = validateSpecialistResult(result);
  if (!validated.ok) {
    throw new Error("invalid specialist output");
  }

  if (input.memoryStore && projectId) {
    input.memoryStore.putProjectFact(
      projectId,
      `specialist.${input.role}.last_summary`,
      result.summary,
    );
    input.memoryStore.putProjectFact(
      projectId,
      `specialist.${input.role}.last_result_json`,
      JSON.stringify(result),
    );
    input.memoryStore.putRoleProjectFact(
      projectId,
      input.role,
      "last_summary",
      result.summary,
    );
    input.memoryStore.putRoleProjectFact(
      projectId,
      input.role,
      "last_result_json",
      JSON.stringify(result),
    );
  }
  if (input.memoryStore && runId) {
    input.memoryStore.putRunFact(
      runId,
      `specialist.${input.role}.impact`,
      result.impact,
    );
    input.memoryStore.putRunFact(
      runId,
      `specialist.${input.role}.summary`,
      result.summary,
    );
    input.memoryStore.putRunFact(
      runId,
      `specialist.${input.role}.result_json`,
      JSON.stringify(result),
    );
  }

  return result;
}
