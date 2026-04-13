import { expect, test } from "bun:test";
import {
  buildApprovalText,
  buildCaptainProgressText,
  buildCaptainStartText,
  buildImpactNarration,
  buildRoutingText,
  sanitizeIncomingSlackText,
} from "../src/slack/message-style";

test("sanitizeIncomingSlackText strips ChatGPT send footers from Slack text", () => {
  expect(
    sanitizeIncomingSlackText("온보딩 개선\n*다음을 사용하여 보냄* ChatGPT"),
  ).toBe("온보딩 개선");
  expect(
    sanitizeIncomingSlackText("온보딩 개선\n*Sent using* ChatGPT"),
  ).toBe("온보딩 개선");
});

test("message style helpers produce human-sounding Slack copy without bracket prefixes", () => {
  expect(buildRoutingText("mypetroutine")).toBe("총괄: 이 건은 #mypetroutine 채널에서 이어갈게요.");
  expect(buildCaptainStartText("온보딩 개선", ["planner", "customer-voice"], {
    selectedRoles: ["planner", "customer-voice"],
    nextAction: "목표 문장과 완료 기준을 먼저 고정한다.",
    blockedReason: null,
    status: "active",
    taskGraph: [
      {
        id: "task-1",
        role: "planner",
        title: "목표 문장과 완료 기준 정리",
        dependsOn: [],
      },
      {
        id: "task-2",
        role: "customer-voice",
        title: "사용자 가치와 기대 결과 점검",
        dependsOn: ["task-1"],
      },
    ],
  })).toBe(
    "캡틴: 이번 라운드에서는 기획에게 목표 문장과 완료 기준 정리를, 고객 관점에게 사용자 가치와 기대 결과 점검을 맡길게요. 먼저 목표 문장과 완료 기준을 먼저 고정한다.",
  );
  expect(buildCaptainProgressText("온보딩 개선")).toBe(
    "캡틴: 지금은 검토 결과를 한 줄 계획으로 묶고 있어요. 바로 다음 액션이 보이게 정리해서 넘길게요.",
  );
  expect(
    buildCaptainProgressText("온보딩 개선", [
      { role: "qa", level: "blocking", message: "온보딩 흐름에서 회귀가 보여요. 배포 전에 막아야 해요." },
      { role: "planner", level: "info", message: "범위를 한 번 더 줄이면 돼요." },
    ]),
  ).toBe(
    "캡틴: 지금은 QA에서 막히는 조건이 보여서 그 이슈부터 정리하고 있어요. 기획 의견까지 묶어서. 온보딩 흐름에서 회귀가 보여요.",
  );
  expect(buildApprovalText("deploy", "배포 전 최종 확인이 필요합니다.")).toContain("총괄:");
  expect(buildImpactNarration("qa", "온보딩 흐름에 회귀가 보여요.")).toBe("QA: 온보딩 흐름에 회귀가 보여요.");
  expect(
    buildImpactNarration("backend", "회원가입 API 응답을 정리했어요.", ["src/api/signup.ts", "src/routes/signup.ts"]),
  ).toBe("백엔드: 회원가입 API 응답을 정리했어요. 수정 파일: src/api/signup.ts, src/routes/signup.ts");
  expect(buildImpactNarration("customer-voice", "지금 왜 중요한지 조금 더 분명해야 해요.")).toBe(
    "고객 관점: 지금 왜 중요한지 조금 더 분명해야 해요.",
  );
  expect(buildImpactNarration("planner", "범위를 먼저 고정할게요.")).toBe("기획: 범위를 먼저 고정할게요.");
  expect(buildImpactNarration("designer", "사용 흐름을 먼저 다듬을게요.")).toBe("디자인: 사용 흐름을 먼저 다듬을게요.");
  expect(buildImpactNarration("frontend", "화면 기준을 먼저 맞출게요.")).toBe("프론트엔드: 화면 기준을 먼저 맞출게요.");
  expect(buildImpactNarration("backend", "데이터 경계를 먼저 정리할게요.")).toBe("백엔드: 데이터 경계를 먼저 정리할게요.");
});
