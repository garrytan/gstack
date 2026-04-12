import type { RoleName } from "../roles";

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

export function selectSpecialistRoles(goalTitle: string): RoleName[] {
  const normalized = goalTitle.toLowerCase();

  if (includesAny(normalized, ["제안", "아이디어", "브레인스토밍", "기획안", "목표"])) {
    const roles: RoleName[] = ["planner", "customer-voice"];
    if (includesAny(normalized, ["ui", "ux", "디자인", "화면"])) {
      roles.splice(1, 0, "designer");
    }
    return roles;
  }

  if (includesAny(normalized, ["원격", "git", "repo", "repository", "저장소", "브랜치"])) {
    return ["backend"];
  }

  const roles = new Set<RoleName>();

  if (includesAny(normalized, ["온보딩", "signup", "가입", "회원가입", "화면", "ui", "ux", "디자인"])) {
    roles.add("planner");
    roles.add("designer");
    roles.add("frontend");
  }

  if (includesAny(normalized, ["api", "db", "database", "schema", "webhook", "auth", "백엔드", "서버", "배포", "deploy", "release", "릴리즈"])) {
    roles.add("backend");
  }

  if (includesAny(normalized, ["qa", "테스트", "검증", "회귀", "버그", "배포", "deploy", "release", "릴리즈"])) {
    roles.add("qa");
  }

  if (includesAny(normalized, ["고객", "가치", "카피", "메시지", "설명", "리텐션", "전환", "온보딩", "제안"])) {
    roles.add("customer-voice");
  }

  if (roles.size === 0) {
    roles.add("planner");
    roles.add("customer-voice");
  }

  return [...roles];
}
