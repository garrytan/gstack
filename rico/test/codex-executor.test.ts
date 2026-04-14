import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  buildSpecialistPromptForTest,
  canWriteWithoutWorkspace,
  determineSpecialistExecutionMode,
  finalizeSpecialistResultForRuntime,
  normalizeSpecialistResult,
  parseCodexSpecialistResponse,
  parseOrRepairCodexSpecialistResponse,
  sanitizeCodexSpecialistResponse,
} from "../src/codex/executor";
import { MemoryStore } from "../src/memory/store";
import { openStore } from "../src/state/store";
import {
  decideCustomerVoiceDelegation,
  ensureProjectCustomerVoiceProfile,
} from "../src/orchestrator/customer-voice-director";
import { ensureDefaultRolePlaybooks } from "../src/roles/playbooks";

test("parseCodexSpecialistResponse accepts raw JSON", () => {
  const parsed = parseCodexSpecialistResponse(
    '{"summary":"구체적으로 진행해볼게요.","impact":"info","artifacts":[{"kind":"report","title":"planner-report.md"}],"rawFindings":["docs/README.md 확인"]}',
  );

  expect(parsed).toMatchObject({
    summary: "구체적으로 진행해볼게요.",
    impact: "info",
    artifacts: [{ kind: "report", title: "planner-report.md" }],
  });
});

test("parseCodexSpecialistResponse extracts fenced JSON", () => {
  const parsed = parseCodexSpecialistResponse(
    '```json\n{"summary":"검증이 더 필요해요.","impact":"blocking","artifacts":[],"rawFindings":["테스트 기준 누락"]}\n```',
  );

  expect(parsed).toMatchObject({
    summary: "검증이 더 필요해요.",
    impact: "blocking",
    artifacts: [],
  });
});

test("parseCodexSpecialistResponse keeps write-mode metadata when provided", () => {
  const parsed = parseCodexSpecialistResponse(
    '{"summary":"회원가입 API 응답 스키마를 정리했어요.","impact":"info","artifacts":[{"kind":"report","title":"backend-report.md"}],"rawFindings":["src/api/signup.ts를 수정했다."],"executionMode":"write","changedFiles":["src/api/signup.ts","src/routes/signup.ts"],"verificationNotes":["bun test test/signup.test.ts"]}',
  );

  expect(parsed).toMatchObject({
    summary: "회원가입 API 응답 스키마를 정리했어요.",
    impact: "info",
    executionMode: "write",
    changedFiles: ["src/api/signup.ts", "src/routes/signup.ts"],
    verificationNotes: ["bun test test/signup.test.ts"],
  });
});



test("parseCodexSpecialistResponse extracts JSON after progress prose", () => {
  const parsed = parseCodexSpecialistResponse(
    [
      "요청 범위를 먼저 좁히겠습니다.",
      "기존 워크트리 상태를 확인했습니다.",
      '{"summary":"백엔드 입력 검증을 보완했어요.","impact":"info","artifacts":[{"kind":"report","title":"backend-report.md"}],"rawFindings":["PATCH /projects/:id 입력 파싱 실패를 400으로 처리"],"executionMode":"write","changedFiles":["supabase/functions/make-server-bea7392e/index.ts"],"verificationNotes":["git diff -- supabase/functions/make-server-bea7392e/index.ts"]}',
    ].join("\n"),
  );

  expect(parsed).toMatchObject({
    summary: "백엔드 입력 검증을 보완했어요.",
    impact: "info",
    executionMode: "write",
    changedFiles: ["supabase/functions/make-server-bea7392e/index.ts"],
  });
});



test("parseOrRepairCodexSpecialistResponse repairs prose-only specialist output", async () => {
  const repaired = await parseOrRepairCodexSpecialistResponse({
    text: "백엔드에서 PATCH /projects/:id 입력 검증을 400으로 보강했고 변경 파일은 make-server 함수예요.",
    repair: async () => '{"summary":"PATCH /projects/:id 입력 검증을 400으로 보강했어요.","impact":"info","artifacts":[{"kind":"report","title":"backend-report.md"}],"rawFindings":["잘못된 JSON 본문을 400으로 처리"],"executionMode":"write","changedFiles":["supabase/functions/make-server-bea7392e/index.ts"],"verificationNotes":["git diff -- supabase/functions/make-server-bea7392e/index.ts"]}',
  });

  expect(repaired).toMatchObject({
    summary: "PATCH /projects/:id 입력 검증을 400으로 보강했어요.",
    impact: "info",
    executionMode: "write",
  });
});

test("parseCodexSpecialistResponse rejects non-json output", () => {
  expect(() => parseCodexSpecialistResponse("not-json")).toThrow(
    "Codex specialist response was not valid JSON",
  );
});

test("sanitizeCodexSpecialistResponse drops fake sandbox-limit findings after successful inspection", () => {
  const sanitized = sanitizeCodexSpecialistResponse({
    inspectedWorkspace: true,
    parsed: {
      summary: "실제 코드 기준으로 우선순위를 정리했어요.",
      impact: "info",
      artifacts: [],
      rawFindings: [
        "src/app/routes.ts를 확인했다.",
        "현재 런타임에서는 저장소 실제 파일 탐색이 제한되어 추가 근거 수집이 막혀 있다.",
      ],
    },
  });

  expect(sanitized.rawFindings).toEqual(["src/app/routes.ts를 확인했다."]);
});

test("determineSpecialistExecutionMode keeps repo-check questions in analyze mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "backend",
      goalTitle: "지금 원격 깃이 연결되어있나?",
    }),
  ).toBe("analyze");
});

test("determineSpecialistExecutionMode promotes concrete backend implementation work to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "backend",
      goalTitle: "회원가입 API 에러 응답 스키마를 수정해줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode keeps backend mixed inspect-and-fix goals in write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "backend",
      goalTitle: "백엔드 엔드포인트 점검해서 보완할 부분이 있으면 직접 수정해줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode keeps frontend UX analysis in analyze mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "frontend",
      goalTitle: "온보딩 화면 흐름 문제를 분석해줘",
    }),
  ).toBe("analyze");
});

test("determineSpecialistExecutionMode promotes concrete frontend UI changes to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "frontend",
      goalTitle: "로그인 버튼 카피를 시작하기로 바꿔줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode keeps frontend navigation connection goals in write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "frontend",
      goalTitle: "메인 랜딩페이지와 ai-employee 서브 페이지 네비게이션을 이어줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode promotes frontend copy-touch goals to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "frontend",
      goalTitle: "랜딩 문구만 실제로 손봐줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode promotes QA verification-and-report goals to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "qa",
      goalTitle: "변경 파일과 검증 결과를 스레드에 남겨줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode promotes planner doc-writing goals to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "planner",
      goalTitle: "기획 초안을 문서로 정리해줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode promotes designer doc-writing goals to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "designer",
      goalTitle: "UX writing 가이드를 문서로 작성해줘",
    }),
  ).toBe("write");
});

test("determineSpecialistExecutionMode promotes customer voice simulation goals to write mode", () => {
  expect(
    determineSpecialistExecutionMode({
      role: "customer-voice",
      goalTitle: "고객 관점 페르소나 시뮬레이션 증적을 문서로 정리해줘",
    }),
  ).toBe("write");
});

test("canWriteWithoutWorkspace allows artifact-only specialists to run in write mode", () => {
  expect(canWriteWithoutWorkspace("planner", "write")).toBe(true);
  expect(canWriteWithoutWorkspace("designer", "write")).toBe(true);
  expect(canWriteWithoutWorkspace("customer-voice", "write")).toBe(true);
  expect(canWriteWithoutWorkspace("backend", "write")).toBe(false);
  expect(canWriteWithoutWorkspace("frontend", "write")).toBe(false);
});

test("normalizeSpecialistResult downgrades false QA blockers when the route is declared", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rico-qa-route-"));
  mkdirSync(join(workspace, "src", "app"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "app", "App.tsx"),
    [
      "export function App() {",
      "  return null;",
      "}",
      'const routes = <Route path="/projects" />;',
    ].join("\n"),
  );

  try {
    const normalized = await normalizeSpecialistResult({
      role: "qa",
      executionMode: "write",
      originalText: '{"summary":"`/projects` 링크를 차단 이슈로 분류했습니다.","impact":"blocking","artifacts":[],"rawFindings":["`/projects` is not a registered route."],"executionMode":"write","changedFiles":[],"verificationNotes":[]}',
      workspacePath: workspace,
      parsed: {
        summary: "`/projects` 링크를 차단 이슈로 분류했습니다.",
        impact: "blocking",
        artifacts: [],
        rawFindings: ["`/projects` is not a registered route."],
        executionMode: "write",
        changedFiles: [],
        verificationNotes: [],
      },
    });

    expect(normalized.impact).toBe("info");
    expect(normalized.summary.includes("`/projects`")).toBe(true);
    expect(normalized.summary.includes("등록")).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("normalizeSpecialistResult softens customer-voice approval gating when the feedback is advisory", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "customer-voice",
    executionMode: "analyze",
    originalText: '{"summary":"메시지 선명도가 아직 조금 약해서 사용자가 바로 이해하기 어렵습니다.","impact":"approval_needed","artifacts":[],"rawFindings":["도입 효과가 첫 화면에서 바로 읽히지 않습니다."],"executionMode":"analyze"}',
    workspacePath: null,
    parsed: {
      summary: "메시지 선명도가 아직 조금 약해서 사용자가 바로 이해하기 어렵습니다.",
      impact: "approval_needed",
      artifacts: [],
      rawFindings: ["도입 효과가 첫 화면에서 바로 읽히지 않습니다."],
      executionMode: "analyze",
    },
  });

  expect(normalized.impact).toBe("info");
  expect(normalized.summary).toContain("메시지");
});

test("normalizeSpecialistResult keeps customer-voice blocking when simulation or access fails", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "customer-voice",
    executionMode: "write",
    originalText: '{"summary":"실제 고객 흐름을 재현하지 못해서 이번 판단은 멈춰야 합니다.","impact":"blocking","artifacts":[],"rawFindings":["browser simulation failed: base-url responded 404"],"executionMode":"write","changedFiles":[],"verificationNotes":["browser simulation failed: GET / => 404"]}',
    workspacePath: null,
    parsed: {
      summary: "실제 고객 흐름을 재현하지 못해서 이번 판단은 멈춰야 합니다.",
      impact: "blocking",
      artifacts: [],
      rawFindings: ["browser simulation failed: base-url responded 404"],
      executionMode: "write",
      changedFiles: [],
      verificationNotes: ["browser simulation failed: GET / => 404"],
    },
  });

  expect(normalized.impact).toBe("blocking");
});

test("normalizeSpecialistResult replaces changed files with observed git delta when available", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "qa",
    executionMode: "write",
    originalText: '{"summary":"검증 파일을 만들었다고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["qa/fake.md"],"verificationNotes":["bun test test/foo.test.ts"]}',
    workspacePath: null,
    observedChangedFiles: ["src/api/client.ts"],
    parsed: {
      summary: "검증 파일을 만들었다고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["qa/fake.md"],
      verificationNotes: ["bun test test/foo.test.ts"],
    },
  });

  expect(normalized.changedFiles).toEqual(["src/api/client.ts"]);
});

test("normalizeSpecialistResult downgrades QA blockers without verification trail", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "qa",
    executionMode: "write",
    originalText: '{"summary":"차단해야 합니다.","impact":"blocking","artifacts":[],"rawFindings":["회귀 가능성"],"executionMode":"write","changedFiles":[],"verificationNotes":[]}',
    workspacePath: null,
    observedChangedFiles: [],
    parsed: {
      summary: "차단해야 합니다.",
      impact: "blocking",
      artifacts: [],
      rawFindings: ["회귀 가능성"],
      executionMode: "write",
      changedFiles: [],
      verificationNotes: [],
    },
  });

  expect(normalized.impact).toBe("approval_needed");
  expect(normalized.rawFindings.at(-1)).toContain("실행된 검증 명령");
});

test("normalizeSpecialistResult blocks planner writes outside artifact scope", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "planner",
    executionMode: "write",
    originalText: '{"summary":"기획 문서를 정리했다고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["src/app/App.tsx"],"verificationNotes":[]}',
    workspacePath: null,
    observedChangedFiles: ["src/app/App.tsx"],
    parsed: {
      summary: "기획 문서를 정리했다고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["src/app/App.tsx"],
      verificationNotes: [],
    },
  });

  expect(normalized.impact).toBe("blocking");
  expect(normalized.summary).toContain("기획 역할");
  expect(normalized.rawFindings.at(-1)).toContain("write scope violation");
});

test("normalizeSpecialistResult blocks customer voice product code writes", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "customer-voice",
    executionMode: "write",
    originalText: '{"summary":"고객 관점 문서를 정리했다고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["src/app/App.tsx"],"verificationNotes":[]}',
    workspacePath: null,
    observedChangedFiles: ["src/app/App.tsx"],
    parsed: {
      summary: "고객 관점 문서를 정리했다고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["src/app/App.tsx"],
      verificationNotes: [],
    },
  });

  expect(normalized.impact).toBe("blocking");
  expect(normalized.summary).toContain("고객 관점 역할");
});

test("normalizeSpecialistResult blocks frontend writes outside frontend scope", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "frontend",
    executionMode: "write",
    originalText: '{"summary":"프론트 수정이라고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["supabase/functions/make-server/index.ts"],"verificationNotes":[]}',
    workspacePath: null,
    observedChangedFiles: ["supabase/functions/make-server/index.ts"],
    parsed: {
      summary: "프론트 수정이라고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["supabase/functions/make-server/index.ts"],
      verificationNotes: [],
    },
  });

  expect(normalized.impact).toBe("blocking");
  expect(normalized.summary).toContain("프론트엔드 역할");
});

test("normalizeSpecialistResult blocks QA product code writes outside evidence scope", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "qa",
    executionMode: "write",
    originalText: '{"summary":"QA 검증이라고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["src/api/client.ts"],"verificationNotes":["bun test"]}',
    workspacePath: null,
    observedChangedFiles: ["src/api/client.ts"],
    parsed: {
      summary: "QA 검증이라고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["src/api/client.ts"],
      verificationNotes: ["bun test"],
    },
  });

  expect(normalized.impact).toBe("blocking");
  expect(normalized.summary).toContain("QA 역할");
});

test("normalizeSpecialistResult blocks disallowed deploy capabilities from executed commands", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "backend",
    executionMode: "write",
    originalText: '{"summary":"API 보강을 마쳤다고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["src/api/projects.ts"],"verificationNotes":["bun test src/api/projects.test.ts"]}',
    workspacePath: null,
    observedChangedFiles: ["src/api/projects.ts"],
    executedCommands: ["vercel deploy --prod"],
    playbookMemory: {
      allowed_tools_json: JSON.stringify(["repo-read", "project-memory", "run-memory", "verification-log"]),
      disallowed_tools_json: JSON.stringify(["external-message", "data-delete", "deploy", "destructive-write"]),
    },
    parsed: {
      summary: "API 보강을 마쳤다고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["src/api/projects.ts"],
      verificationNotes: ["bun test src/api/projects.test.ts"],
    },
  });

  expect(normalized.impact).toBe("blocking");
  expect(normalized.summary).toContain("playbook이 금지한 실행");
  expect(normalized.rawFindings.at(-1)).toContain("deploy");
});

test("normalizeSpecialistResult keeps allowed verification commands for backend specialists", async () => {
  const normalized = await normalizeSpecialistResult({
    role: "backend",
    executionMode: "write",
    originalText: '{"summary":"API 보강을 마쳤다고 보고했습니다.","impact":"info","artifacts":[],"rawFindings":[],"executionMode":"write","changedFiles":["src/api/projects.ts"],"verificationNotes":["bun test src/api/projects.test.ts"]}',
    workspacePath: null,
    observedChangedFiles: ["src/api/projects.ts"],
    executedCommands: ["bun test src/api/projects.test.ts"],
    playbookMemory: {
      allowed_tools_json: JSON.stringify(["repo-read", "project-memory", "run-memory", "verification-log"]),
      disallowed_tools_json: JSON.stringify(["external-message", "data-delete", "deploy", "destructive-write"]),
    },
    parsed: {
      summary: "API 보강을 마쳤다고 보고했습니다.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["src/api/projects.ts"],
      verificationNotes: ["bun test src/api/projects.test.ts"],
    },
  });

  expect(normalized.impact).toBe("info");
  expect(normalized.rawFindings.join("\n")).not.toContain("capability violation");
});

test("buildSpecialistPromptForTest injects customer voice persona and simulation context", () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  ensureDefaultRolePlaybooks(memoryStore);
  ensureProjectCustomerVoiceProfile({
    memoryStore,
    projectId: "sherpalabs",
  });
  const decision = decideCustomerVoiceDelegation({
    memoryStore,
    projectId: "sherpalabs",
    goalTitle: "여러 페르소나의 고객 관점으로 메인 랜딩과 ai-employee 동선, UX writing을 같이 점검해줘",
    selectedRoles: ["designer", "frontend"],
  });
  const persona = decision.selectedPersonas[0]!;

  const prompt = buildSpecialistPromptForTest({
    role: "customer-voice",
    projectId: "sherpalabs",
    goalTitle: "여러 페르소나의 고객 관점으로 메인 랜딩과 ai-employee 동선, UX writing을 같이 점검해줘",
    workspacePath: "/tmp/sherpalabs",
    executionMode: "analyze",
    memoryStore,
    runId: "run-1",
    personaLabel: persona.label,
    customerVoiceDecision: decision,
    customerVoicePersona: persona,
  });

  expect(prompt.includes("customer-voice-directive.json")).toBe(true);
  expect(prompt.includes(persona.label)).toBe(true);
  expect(prompt.includes("Allowed capabilities")).toBe(true);
  expect(prompt.includes("persona-simulation")).toBe(true);

  store.db.close();
});

test("buildSpecialistPromptForTest exposes playbook guardrails for backend specialists", () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  ensureDefaultRolePlaybooks(memoryStore);

  const prompt = buildSpecialistPromptForTest({
    role: "backend",
    projectId: "mypetroutine",
    goalTitle: "회원가입 API 에러 응답 스키마를 수정해줘",
    workspacePath: "/tmp/mypetroutine",
    executionMode: "write",
    memoryStore,
    runId: "run-2",
  });

  expect(prompt.includes("Charter:")).toBe(true);
  expect(prompt.includes("Allowed capabilities")).toBe(true);
  expect(prompt.includes("Disallowed actions")).toBe(true);
  expect(prompt.includes("api-contract-review")).toBe(true);

  store.db.close();
});

test("finalizeSpecialistResultForRuntime applies playbook artifact templates", () => {
  const finalized = finalizeSpecialistResultForRuntime({
    role: "backend",
    playbookMemory: {
      artifact_template: "backend-slice.md",
    },
    parsed: {
      summary: "백엔드 변경을 정리했어요.",
      impact: "info",
      artifacts: [{ kind: "report", title: "backend-report.md" }],
      rawFindings: [],
      executionMode: "write",
      changedFiles: ["src/api/projects.ts"],
      verificationNotes: ["bun test test/projects.test.ts"],
    },
  });

  expect(finalized.artifacts).toEqual([{ kind: "report", title: "backend-slice.md" }]);
});

test("finalizeSpecialistResultForRuntime marks artifact-only writes explicitly", () => {
  const finalized = finalizeSpecialistResultForRuntime({
    role: "customer-voice",
    playbookMemory: {
      artifact_template: "customer-voice.md",
    },
    parsed: {
      summary: "고객 관점 증적을 정리했어요.",
      impact: "info",
      artifacts: [],
      rawFindings: [],
      executionMode: "write",
      changedFiles: [],
      verificationNotes: ["browser simulation summary"],
    },
  });

  expect(finalized.artifacts).toEqual([{ kind: "report", title: "customer-voice.md" }]);
  expect(finalized.rawFindings.at(-1)).toContain("artifact-only write");
});
