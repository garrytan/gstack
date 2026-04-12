import type { RoleName } from "../roles";
import { selectSpecialistRoles } from "./role-selection";

export type CaptainPlanStatus = "active" | "needs_decision" | "blocked";

export interface CaptainTaskNode {
  id: string;
  role: RoleName;
  title: string;
  dependsOn: string[];
}

export interface CaptainPlan {
  selectedRoles: RoleName[];
  nextAction: string;
  blockedReason: string | null;
  status: CaptainPlanStatus;
  taskGraph: CaptainTaskNode[];
}

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function buildTaskTitle(goalTitle: string, role: RoleName) {
  const normalized = goalTitle.toLowerCase();

  if (role === "backend" && includesAny(normalized, ["원격", "git", "repo", "repository", "저장소", "브랜치"])) {
    return "원격 저장소와 브랜치 상태 확인";
  }

  if (role === "planner" && includesAny(normalized, ["제안", "아이디어", "브레인스토밍", "기획안", "목표"])) {
    return "목표 후보와 완료 기준 정리";
  }

  if (role === "customer-voice" && includesAny(normalized, ["제안", "아이디어", "브레인스토밍", "기획안", "목표"])) {
    return "사용자 가치와 기대 결과 점검";
  }

  if (role === "planner") return "목표와 완료 기준 정리";
  if (role === "designer") return "사용 흐름과 카피 구조 점검";
  if (role === "frontend") return "화면 흐름과 상태 전이 점검";
  if (role === "backend") return "데이터/API/실패 모드 점검";
  if (role === "qa") return "완료 기준과 회귀 위험 확인";
  return "사용자 가치와 메시지 선명도 점검";
}

function buildDefaultTaskGraph(goalTitle: string, roles: RoleName[]) {
  return roles.map((role, index) => ({
    id: `task-${index + 1}`,
    role,
    title: buildTaskTitle(goalTitle, role),
    dependsOn: index === 0 ? [] : [`task-${index}`],
  }));
}

function needsTaskRewrite(task: CaptainTaskNode) {
  return /1차 검토/i.test(task.title) || task.title.trim().length === 0;
}

export function buildFallbackCaptainPlan(goalTitle: string): CaptainPlan {
  const selectedRoles = selectSpecialistRoles(goalTitle);
  return {
    selectedRoles,
    nextAction:
      selectedRoles.length > 0
        ? `${selectedRoles[0]} 관점에서 핵심 전제와 다음 단계를 먼저 정리한다.`
        : "범위와 리스크를 먼저 정리한다.",
    blockedReason: null,
    status: "active",
    taskGraph: buildDefaultTaskGraph(goalTitle, selectedRoles),
  };
}

export function normalizeCaptainPlanForGoal(goalTitle: string, plan: CaptainPlan): CaptainPlan {
  const normalizedGoal = goalTitle.toLowerCase();
  const normalizedPlan: CaptainPlan = {
    ...plan,
    selectedRoles: [...plan.selectedRoles],
    taskGraph: plan.taskGraph.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
    })),
  };

  if (includesAny(normalizedGoal, ["원격", "git", "repo", "repository", "저장소", "브랜치"])) {
    normalizedPlan.selectedRoles = ["backend"];
    normalizedPlan.taskGraph = buildDefaultTaskGraph(goalTitle, ["backend"]);
    normalizedPlan.nextAction = "원격 저장소, 현재 브랜치, upstream 연결 상태를 먼저 확인한다.";
    return normalizedPlan;
  }

  if (normalizedPlan.taskGraph.length === 0) {
    normalizedPlan.taskGraph = buildDefaultTaskGraph(goalTitle, normalizedPlan.selectedRoles);
    return normalizedPlan;
  }

  normalizedPlan.taskGraph = normalizedPlan.taskGraph.map((task) => ({
    ...task,
    title: needsTaskRewrite(task) ? buildTaskTitle(goalTitle, task.role) : task.title,
  }));

  return normalizedPlan;
}
