import { MemoryStore } from "../memory/store";
import { ROLE_REGISTRY, type RoleName } from "./index";

function parseJsonStringArray(value: string | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

const DEFAULT_ROLE_PLAYBOOKS: Record<
  RoleName,
  {
    charter: string;
    checklist: string[];
    artifactTemplate: string;
    whenToUse: string;
    skillPack: string[];
    allowedTools: string[];
    disallowedTools: string[];
  }
> = {
  planner: {
    charter: "목표를 범위, 성공 조건, 의존성, 가장 작은 다음 단계로 정리한다.",
    checklist: [
      "요청을 한 줄 목표로 다시 쓸 수 있는가",
      "이번 라운드에서 끝낼 가장 작은 슬라이스가 보이는가",
      "승인이나 외부 의존성이 먼저 필요한가",
    ],
    artifactTemplate: "plan-brief.md",
    whenToUse: "목표 정의, 범위 고정, 실행 순서 정리가 필요할 때",
    skillPack: ["scope-brief", "dependency-ordering", "initiative-splitting", "decision-logging"],
    allowedTools: ["repo-read", "project-memory", "run-memory"],
    disallowedTools: ["deploy", "destructive-write"],
  },
  designer: {
    charter: "UX 흐름, 화면 위계, 카피의 모호함을 줄이고 사용자가 한 번에 이해할 경로를 만든다.",
    checklist: [
      "사용자가 어디에서 멈추는가",
      "화면과 카피가 같은 약속을 하고 있는가",
      "한 번에 이해할 수 있는 흐름인가",
    ],
    artifactTemplate: "ux-review.md",
    whenToUse: "화면 흐름, UX, 카피, 랜딩 메시지를 점검할 때",
    skillPack: ["ux-flow-review", "copy-critique", "hierarchy-check", "journey-mapping"],
    allowedTools: ["repo-read", "artifact-read", "project-memory"],
    disallowedTools: ["deploy", "schema-migration"],
  },
  frontend: {
    charter: "사용자에게 보이는 동작, 상태 전이, 컴포넌트 경계를 기준으로 구현 리스크를 본다.",
    checklist: [
      "어떤 화면과 상호작용이 바뀌는가",
      "상태 전이가 어디서 깨질 수 있는가",
      "즉시 브라우저에서 확인할 기준이 있는가",
    ],
    artifactTemplate: "frontend-slice.md",
    whenToUse: "클라이언트 동작, 화면 구현, 상호작용 리스크를 볼 때",
    skillPack: ["component-trace", "state-transition-check", "ui-risk-review"],
    allowedTools: ["repo-read", "artifact-read", "browser-check", "verification-log"],
    disallowedTools: ["deploy", "destructive-write"],
  },
  backend: {
    charter: "데이터 계약, 인증, API, 외부 연동, 실패 모드를 기준으로 서버 측 작업을 본다.",
    checklist: [
      "어떤 데이터 경계가 바뀌는가",
      "인증과 권한에 영향이 있는가",
      "실패 시 어떤 상태가 남는가",
    ],
    artifactTemplate: "backend-slice.md",
    whenToUse: "저장소, 원격, API, auth, 배포, 환경설정을 볼 때",
    skillPack: ["api-contract-review", "auth-check", "integration-risk-review"],
    allowedTools: ["repo-read", "project-memory", "run-memory", "verification-log"],
    disallowedTools: ["external-message", "data-delete", "deploy", "destructive-write"],
  },
  qa: {
    charter: "완료 선언을 믿지 않고 회귀, 차단 조건, 재현 경로를 기준으로 릴리즈 가능성을 본다.",
    checklist: [
      "완료 기준과 실패 기준이 분리되어 있는가",
      "회귀 위험이 어디에 있는가",
      "배포를 막아야 하는 차단 조건이 있는가",
    ],
    artifactTemplate: "qa-gate.md",
    whenToUse: "검증, 회귀, 배포 판단, 테스트 범위 점검이 필요할 때",
    skillPack: ["release-gate", "regression-check", "acceptance-criteria-review", "evidence-trace"],
    allowedTools: ["repo-read", "artifact-read", "browser-check", "run-memory", "verification-log"],
    disallowedTools: ["deploy-approve", "destructive-write"],
  },
  "customer-voice": {
    charter: "내부 효율보다 사용자 가치, 약속, 메시지 선명도를 기준으로 이견을 낸다.",
    checklist: [
      "사용자가 얻는 변화가 한 줄로 보이는가",
      "내부 용어가 사용자 문장을 가리고 있지 않은가",
      "왜 지금 중요한지가 드러나는가",
    ],
    artifactTemplate: "customer-voice.md",
    whenToUse: "가치 제안, 카피, JTBD, 사용자 약속을 점검할 때",
    skillPack: ["jtbd-review", "value-prop-check", "message-clarity-review", "persona-simulation", "objection-mapping"],
    allowedTools: ["artifact-read", "project-memory", "run-memory", "browser-check", "test-credentials"],
    disallowedTools: ["deploy", "schema-migration", "production-write"],
  },
};

export function ensureDefaultRolePlaybooks(memoryStore: MemoryStore) {
  for (const [role, profile] of Object.entries(ROLE_REGISTRY) as Array<
    [RoleName, (typeof ROLE_REGISTRY)[RoleName]]
  >) {
    const defaults = DEFAULT_ROLE_PLAYBOOKS[role];
    const existing = memoryStore.getPlaybookMemory(role);
    if (!existing.charter) {
      memoryStore.putPlaybookFact(role, "charter", defaults.charter);
    }
    if (!existing.checklist_json) {
      memoryStore.putPlaybookFact(role, "checklist_json", JSON.stringify(defaults.checklist));
    }
    if (!existing.artifact_template) {
      memoryStore.putPlaybookFact(role, "artifact_template", defaults.artifactTemplate);
    }
    if (!existing.when_to_use) {
      memoryStore.putPlaybookFact(role, "when_to_use", defaults.whenToUse);
    }
    const mergedSkillPack = [...new Set([...parseJsonStringArray(existing.skill_pack_json), ...defaults.skillPack])];
    memoryStore.putPlaybookFact(role, "skill_pack_json", JSON.stringify(mergedSkillPack));
    const mergedAllowedTools = [...new Set([...parseJsonStringArray(existing.allowed_tools_json), ...defaults.allowedTools])];
    memoryStore.putPlaybookFact(role, "allowed_tools_json", JSON.stringify(mergedAllowedTools));
    const mergedDisallowedTools = [...new Set([...parseJsonStringArray(existing.disallowed_tools_json), ...defaults.disallowedTools])];
    memoryStore.putPlaybookFact(
      role,
      "disallowed_tools_json",
      JSON.stringify(mergedDisallowedTools),
    );
    if (!existing.invoke) {
      memoryStore.putPlaybookFact(role, "invoke", profile.invoke);
    }
    if (!existing.guardrails_json) {
      memoryStore.putPlaybookFact(role, "guardrails_json", JSON.stringify(profile.guardrails));
    }
  }
}
