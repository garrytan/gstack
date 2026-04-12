import { expect, test } from "bun:test";
import { parseCodexSpecialistResponse } from "../src/codex/executor";

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

test("parseCodexSpecialistResponse rejects non-json output", () => {
  expect(() => parseCodexSpecialistResponse("not-json")).toThrow(
    "Codex specialist response was not valid JSON",
  );
});
