import { expect, test } from "bun:test";
import {
  determineSpecialistExecutionMode,
  parseCodexSpecialistResponse,
  sanitizeCodexSpecialistResponse,
} from "../src/codex/executor";

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
