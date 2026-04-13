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
    captainExecutor: async () => ({
      selectedRoles: ["backend"],
      nextAction: "배포 전 백엔드 변경만 먼저 확정한다.",
      blockedReason: null,
      status: "active",
      taskGraph: [
        {
          id: "task-1",
          role: "backend",
          title: "배포 전 백엔드 변경 확정",
          dependsOn: [],
        },
      ],
    }),
    specialistExecutor: async ({ role }) => ({
      result: {
        role,
        summary: "배포 가능한 변경만 남겼어요.",
        impact: "info",
        artifacts: [{ kind: "report", title: `${role}.md` }],
        rawFindings: [],
        executionMode: "write",
        changedFiles: ["src/api/projects.ts"],
        verificationNotes: ["npm test -- --run src/api/projects.test.ts"],
      },
      meta: {
        workspacePath: "/tmp/workspace",
        tokensUsed: 1,
        inspectedWorkspace: true,
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

  await waitFor(() => postedMessages.length >= 4);

  expect(runtime.store.repositories.initiatives.listByProject("mypetroutine")).toHaveLength(0);
  expect(runtime.store.repositories.goals.listByProject("mypetroutine")).toHaveLength(1);
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
        /^(🧠 기획|🎨 디자인|🖥️ 프론트엔드|🧱 백엔드|🧪 QA|🗣️ 고객 관점)/.test(message.text),
    ),
  ).toBe(true);
  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_AI_OPS" &&
        message.text.includes("사람 확인 필요") &&
        JSON.stringify(message.blocks ?? []).includes("approval:approve") &&
        message.metadata?.approvalId === latestApproval?.id,
    ),
  ).toBe(true);

  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_AI_OPS" &&
        message.text.includes("총괄") &&
        message.text.includes("#mypetroutine"),
    ),
  ).toBe(true);

  expect(
    postedMessages.some(
      (message) =>
        message.channel === "C_MYPETROUTINE" &&
        message.text.includes("캡틴 계획") &&
        !message.text.includes("다음을 사용하여 보냄") &&
        !message.text.includes("ChatGPT"),
    ),
  ).toBe(true);

  runtime.runner.stop();
  runtime.store.db.close();
  rmSync(cwd, { recursive: true, force: true });
});

test("runtime intake persists and uploads specialist evidence artifacts when Slack upload support is available", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rico-runtime-artifacts-"));
  const postedMessages: Array<{
    channel: string;
    thread_ts?: string;
    text: string;
  }> = [];
  const uploads: {
    ticket?: { filename: string; length: number };
    binary?: string;
    completed?: {
      files: Array<{ id: string; title: string }>;
      channel_id?: string;
      thread_ts?: string;
    };
  } = {};

  const runtime = createRicoRuntime({
    config: resolveConfig({
      cwd,
      env: {
        SLACK_SIGNING_SECRET: "secret",
        SLACK_BOT_TOKEN: "xoxb-test",
        RICO_AI_OPS_CHANNEL_ID: "C_AI_OPS",
      },
    }),
    captainExecutor: async () => ({
      selectedRoles: ["qa"],
      nextAction: "QA 증적을 남기고 종료한다.",
      blockedReason: null,
      status: "active",
      taskGraph: [
        {
          id: "task-1",
          role: "qa",
          title: "QA 증적 업로드",
          dependsOn: [],
        },
      ],
    }),
    specialistExecutor: async ({ role }) => ({
      result: {
        role,
        summary: "변경 파일 기준 검증을 마쳤고 증적을 남겼어요.",
        impact: "info",
        artifacts: [{ kind: "report", title: "qa-report.md" }],
        rawFindings: ["route smoke passed", "api smoke passed"],
        executionMode: "write",
        changedFiles: ["qa/verification.md"],
        verificationNotes: ["npm test -- --run src/app/App.aiEmployeeRoute.test.tsx"],
      },
      meta: {
        workspacePath: "/tmp/workspace",
        tokensUsed: 1,
        inspectedWorkspace: true,
      },
    }),
    slackClient: {
      async postMessage(input) {
        postedMessages.push(input);
        return {
          ok: true,
          ts: `${1710001000 + postedMessages.length}.000100`,
        };
      },
      async getUploadURLExternal(input) {
        uploads.ticket = input;
        return {
          upload_url: "https://uploads.slack.test/file",
          file_id: "F_QA_1",
        };
      },
      async uploadBinary(input) {
        uploads.binary = Buffer.from(input.content).toString("utf8");
        return { ok: true };
      },
      async completeUploadExternal(input) {
        uploads.completed = input;
        return {
          ok: true,
          files: [
            {
              id: "F_QA_1",
              title: "qa-report.md",
              permalink: "https://slack.test/files/F_QA_1",
            },
          ],
        };
      },
    },
  });

  runtime.store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
  });

  const rawBody = JSON.stringify({
    type: "event_callback",
    event: {
      type: "message",
      text: "sherpalabs: QA 증적을 남기고 종료해",
      channel: "C_AI_OPS",
      ts: "1710001000.000200",
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

  await waitFor(() =>
    runtime.store.repositories.goals.listByProject("sherpalabs").some((goal) => goal.state === "approved")
  );

  const latestGoal = runtime.store.repositories.goals.listByProject("sherpalabs").at(-1);
  expect(latestGoal).toBeTruthy();
  expect(uploads.ticket?.filename).toBe("qa-report.md");
  expect(uploads.binary).toContain("요약");
  expect(uploads.completed?.channel_id).toBe("C_SHERPALABS");
  expect(
    runtime.store.repositories.artifacts.listByGoal(latestGoal!.id).some((artifact) =>
      artifact.goalId === latestGoal?.id
      && artifact.slackFileId === "F_QA_1"
      && artifact.localPath.includes("/artifacts/sherpalabs/"),
    ),
  ).toBe(true);
  expect(
    postedMessages.some((message) => message.text.includes("https://slack.test/files/F_QA_1")),
  ).toBe(true);

  runtime.runner.stop();
  runtime.store.db.close();
  rmSync(cwd, { recursive: true, force: true });
});
