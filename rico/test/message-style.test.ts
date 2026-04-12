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
  expect(buildRoutingText("mypetroutine")).toBe("이 건은 #mypetroutine 채널에서 이어갈게요.");
  expect(buildCaptainStartText("온보딩 개선")).toBe("이번 목표는 \"온보딩 개선\" 기준으로 바로 진행해볼게요.");
  expect(buildCaptainProgressText("온보딩 개선")).toBe("지금은 \"온보딩 개선\" 기준으로 정리하면서 진행 중이에요.");
  expect(buildApprovalText("deploy", "배포 전 최종 확인이 필요합니다.")).toContain("사람 확인이 필요해요");
  expect(buildImpactNarration("qa", "온보딩 흐름에 회귀가 보여요.")).toBe("QA에서 확인해보니 온보딩 흐름에 회귀가 보여요.");
  expect(buildImpactNarration("customer-voice", "지금 왜 중요한지 조금 더 분명해야 해요.")).toBe(
    "고객 관점에서는 지금 왜 중요한지 조금 더 분명해야 해요.",
  );
});
