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
  expect(buildCaptainStartText("온보딩 개선", ["planner", "customer-voice"])).toBe(
    "캡틴: 이번 목표는 \"온보딩 개선\" 기준으로 바로 진행해볼게요. 이번 라운드에서는 기획과 고객 관점으로 먼저 볼게요.",
  );
  expect(buildCaptainProgressText("온보딩 개선")).toBe("캡틴: 지금은 \"온보딩 개선\" 기준으로 정리하면서 진행 중이에요.");
  expect(buildApprovalText("deploy", "배포 전 최종 확인이 필요합니다.")).toContain("사람 확인이 필요해요");
  expect(buildImpactNarration("qa", "온보딩 흐름에 회귀가 보여요.")).toBe("QA: 온보딩 흐름에 회귀가 보여요.");
  expect(buildImpactNarration("customer-voice", "지금 왜 중요한지 조금 더 분명해야 해요.")).toBe(
    "고객 관점: 지금 왜 중요한지 조금 더 분명해야 해요.",
  );
  expect(buildImpactNarration("planner", "범위를 먼저 고정할게요.")).toBe("기획: 범위를 먼저 고정할게요.");
  expect(buildImpactNarration("designer", "사용 흐름을 먼저 다듬을게요.")).toBe("디자인: 사용 흐름을 먼저 다듬을게요.");
  expect(buildImpactNarration("frontend", "화면 기준을 먼저 맞출게요.")).toBe("프론트엔드: 화면 기준을 먼저 맞출게요.");
  expect(buildImpactNarration("backend", "데이터 경계를 먼저 정리할게요.")).toBe("백엔드: 데이터 경계를 먼저 정리할게요.");
});
