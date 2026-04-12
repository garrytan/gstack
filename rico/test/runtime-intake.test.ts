import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import { createRicoRuntime } from "../src/main";

function signSlackPayload(secret: string, timestamp: string, rawBody: string) {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for runtime side effects");
    }
    await Bun.sleep(25);
  }
}

test("ai-ops message bootstraps work and drives the captain/governor Slack flow", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rico-runtime-"));
  const postedMessages: Array<{
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }> = [];

  const runtime = createRicoRuntime({
    config: resolveConfig({
      cwd,
      env: {
        SLACK_SIGNING_SECRET: "secret",
        SLACK_BOT_TOKEN: "xoxb-test",
        RICO_AI_OPS_CHANNEL_ID: "C_AI_OPS",
      },
    }),
    slackClient: {
      async postMessage(input) {
        postedMessages.push(input);
        return {
          ok: true,
          ts: `${1710000000 + postedMessages.length}.000100`,
        };
      },
    },
  });

  runtime.store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const rawBody = JSON.stringify({
    type: "event_callback",
    event: {
      type: "message",
      text: "mypetroutine: 온보딩 개선, 리텐션 리포트, 배포까지 준비해\n*다음을 사용하여 보냄* ChatGPT",
      channel: "C_AI_OPS",
      ts: "1710000000.000200",
      user: "U_TONY",
    },
  });
  const timestamp = `${Math.floor(Date.now() / 1000)}`;

  const response = await runtime.fetch(
    new Request("http://localhost/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlackPayload("secret", timestamp, rawBody),
      },
      body: rawBody,
    }),
  );

  expect(response.status).toBe(200);

  await waitFor(() => postedMessages.length >= 5);

  expect(runtime.store.repositories.initiatives.listByProject("mypetroutine")).toHaveLength(1);
  expect(runtime.store.repositories.goals.listByProject("mypetroutine").length).toBeGreaterThan(1);
  expect(
    runtime.store.repositories.goals
      .listByProject("mypetroutine")
      .some((goal) => goal.state === "awaiting_human_approval"),
  ).toBe(true);

  const latestGoal = runtime.store.repositories.goals.listByProject("mypetroutine").at(-1);
  const latestApproval = latestGoal
    ? runtime.store.repositories.approvals.listByGoal(latestGoal.id).at(-1)
    : null;

  expect(latestApproval?.type).toBe("deploy");
  expect(latestApproval?.status).toBe("pending");
  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_MYPETROUTINE" &&
        message.text.includes("QA에서 확인해보니"),
    ),
  ).toBe(true);
  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_MYPETROUTINE" &&
        message.text.includes("고객 관점에서는"),
    ),
  ).toBe(true);
  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_AI_OPS" &&
        message.text.includes("사람 확인이 필요해요") &&
        JSON.stringify(message.blocks ?? []).includes("approval:approve") &&
        message.metadata?.approvalId === latestApproval?.id,
    ),
  ).toBe(true);

  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_AI_OPS" &&
        message.text.includes("#mypetroutine 채널에서 이어갈게요"),
    ),
  ).toBe(true);

  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_MYPETROUTINE" &&
        message.text.includes("이번 목표는") &&
        !message.text.includes("다음을 사용하여 보냄") &&
        !message.text.includes("ChatGPT"),
    ),
  ).toBe(true);

  runtime.runner.stop();
  runtime.store.db.close();
  rmSync(cwd, { recursive: true, force: true });
});
