import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { processSlackPayload } from "../src/slack/ingress";
import { MemoryStore } from "../src/memory/store";
import { readProjectCustomerVoiceProfile } from "../src/orchestrator/customer-voice-director";
import { openStore } from "../src/state/store";

test("processSlackPayload ignores unsupported Slack event callbacks without queueing a run", async () => {
  const store = openStore(":memory:");

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "user_typing",
        channel: "C_TOTAL",
        user: "U_TONY",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: false });
  expect(store.db.query("select count(*) as count from runs").get()).toEqual({ count: 0 });
});

test("processSlackPayload replies to greeting in ai-ops channel without creating work", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "안녕",
        ts: "1712900000.000100",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.channel).toBe("C_TOTAL");
  expect(posted[0]?.thread_ts).toBe("1712900000.000100");
  expect(posted[0]?.text).toContain("총괄");
  expect(posted[0]?.text).toContain("프로젝트명: 목표");
  expect(store.db.query("select count(*) as count from runs").get()).toEqual({ count: 0 });
});

test("processSlackPayload replies to greeting in project channel without creating a goal", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "안녕",
        ts: "1712900000.000200",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.channel).toBe("C_MYPETROUTINE");
  expect(posted[0]?.thread_ts).toBe("1712900000.000200");
  expect(posted[0]?.text).toContain("이 채널은 mypetroutine 프로젝트");
  expect(store.repositories.goals.listByProject("mypetroutine")).toHaveLength(0);
});

test("processSlackPayload routes explicit project prefixes in a project channel to the requested project", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });
  store.repositories.projects.create({
    id: "pet-memorial",
    slackChannelId: "C_PET_MEMORIAL",
  });

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "pet-memorial: 지금 원격 깃이 연결되어있나?",
        ts: "1712900000.000300",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.goals.listByProject("mypetroutine")).toHaveLength(0);
  expect(store.repositories.goals.listByProject("pet-memorial")).toHaveLength(1);
  expect(store.repositories.goals.listByProject("pet-memorial")[0]?.title).toBe(
    "지금 원격 깃이 연결되어있나?",
  );
});

test("processSlackPayload does not truncate a project-channel goal just because the text contains ':'", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "test",
    slackChannelId: "C_TEST",
  });

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage() {
          return { ok: true, ts: "1710000000.000100" };
        },
        async getConversationInfo() {
          return {
            ok: true,
            channel: {
              id: "C_TEST",
              name: "test",
              is_channel: true,
              is_archived: false,
            },
          };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TEST",
        user: "U_TONY",
        text: "이 채널 목표 제안해봐 live 검증 2026-04-12 21:28",
        ts: "1712900000.000350",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.goals.listByProject("test")).toHaveLength(1);
  expect(store.repositories.goals.listByProject("test")[0]?.title).toBe(
    "이 채널 목표 제안해봐 live 검증 2026-04-12 21:28",
  );
});

test("processSlackPayload auto-registers an eligible project channel on first task message", async () => {
  const store = openStore(":memory:");

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage() {
          return { ok: true, ts: "1710000000.000100" };
        },
        async getConversationInfo(channelId) {
          expect(channelId).toBe("C_NEW_PROJECT");
          return {
            ok: true,
            channel: {
              id: "C_NEW_PROJECT",
              name: "new-project",
              is_channel: true,
              is_archived: false,
            },
          };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_NEW_PROJECT",
        user: "U_TONY",
        text: "로그인 개선안을 정리해줘",
        ts: "1712900000.000400",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.projects.get("new-project")).toMatchObject({
    id: "new-project",
    slackChannelId: "C_NEW_PROJECT",
  });
  expect(store.repositories.goals.listByProject("new-project")).toHaveLength(1);
});

test("processSlackPayload auto-registers an ai-ops project when a matching Slack channel exists", async () => {
  const store = openStore(":memory:");

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage() {
          return { ok: true, ts: "1710000000.000100" };
        },
        async findConversationByName(name) {
          expect(name).toBe("pet-sandbox");
          return {
            ok: true,
            channel: {
              id: "C_PET_SANDBOX",
              name: "pet-sandbox",
              is_channel: true,
              is_archived: false,
            },
          };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "pet-sandbox: 첫 목표를 잡아줘",
        ts: "1712900000.000500",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.projects.get("pet-sandbox")).toMatchObject({
    id: "pet-sandbox",
    slackChannelId: "C_PET_SANDBOX",
  });
  expect(store.repositories.goals.listByProject("pet-sandbox")).toHaveLength(1);
});

test("processSlackPayload updates customer voice settings in a project channel without queueing work", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "test",
    slackChannelId: "C_TEST",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TEST",
        user: "U_TONY",
        text: "고객관점 base-url: http://127.0.0.1:5173",
        ts: "1712900000.000600",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.text).toContain("고객관점 설정");
  expect(
    readProjectCustomerVoiceProfile({
      memoryStore: new MemoryStore(store.db),
      projectId: "test",
    }).simulation.baseUrl,
  ).toBe("http://127.0.0.1:5173");
  expect(store.repositories.goals.listByProject("test")).toHaveLength(0);
});

test("processSlackPayload updates customer voice settings from ai-ops with explicit project prefix", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "sherpalabs: 고객관점 상태",
        ts: "1712900000.000700",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.channel).toBe("C_TOTAL");
  expect(posted[0]?.text).toContain("#sherpalabs");
  expect(posted[0]?.text).toContain("persona-driven");
});

test("processSlackPayload treats project-thread feedback as a follow-up run for the existing goal", async () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });
  store.repositories.goals.create({
    id: "goal-existing",
    projectId: "mypetroutine",
    initiativeId: null,
    title: "온보딩 개선",
    state: "approved",
  });
  memoryStore.putProjectFact(
    "mypetroutine",
    "captain.thread.1712900000.000710.goal_id",
    "goal-existing",
  );

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "이 피드백 반영해서 다시 봐줘",
        ts: "1712900000.000720",
        thread_ts: "1712900000.000710",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.goals.listByProject("mypetroutine")).toHaveLength(1);
  expect(store.repositories.runs.listByGoal("goal-existing")).toHaveLength(1);
  expect(store.repositories.runs.listByGoal("goal-existing")[0]?.status).toBe("queued");
  expect(memoryStore.getRunMemory(store.repositories.runs.listByGoal("goal-existing")[0]!.id)).toMatchObject({
    "queue.kind": "event",
  });
  expect(
    JSON.parse(
      memoryStore.getRunMemory(store.repositories.runs.listByGoal("goal-existing")[0]!.id)["queue.payload_json"]!,
    ),
  ).toMatchObject({
    goalId: "goal-existing",
    projectId: "mypetroutine",
    followUpText: "이 피드백 반영해서 다시 봐줘",
    projectThreadTs: "1712900000.000710",
  });
});

test("processSlackPayload updates project repo root in a project channel without queueing work", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "crypto",
    slackChannelId: "C_CRYPTO",
  });

  const repoRoot = mkdtempSync(join(tmpdir(), "rico-crypto-repo-"));
  mkdirSync(join(repoRoot, ".git"));
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "package.json"), "{}");

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_CRYPTO",
        user: "U_TONY",
        text: `저장소: ${repoRoot}`,
        ts: "1712900000.000730",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.text).toContain("#crypto");
  expect(posted[0]?.text).toContain(repoRoot);
  expect(new MemoryStore(store.db).getProjectMemory("crypto")).toMatchObject({
    "project.repo_root": repoRoot,
    "project.repo_root_source": "manual",
  });
  expect(store.repositories.goals.listByProject("crypto")).toHaveLength(0);

  rmSync(repoRoot, { recursive: true, force: true });
});

test("processSlackPayload answers lightweight ai-ops discussion through governor without queueing work", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      governorConversationExecutor: async () => ({
        reply: "총괄: 지금은 mypetroutine이 가장 먼저 볼 건이고, 이 질문은 바로 답할 수 있어요.",
      }),
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "mypetroutine 쪽 지금 어떤 흐름으로 보면 돼?",
        ts: "1712900000.000740",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.channel).toBe("C_TOTAL");
  expect(posted[0]?.text).toContain("총괄");
  expect(store.repositories.goals.listByProject("mypetroutine")).toHaveLength(0);
});

test("processSlackPayload delegates implicit ai-ops execution requests for known projects without requiring a prefix", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
  });

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      governorConversationExecutor: async () => ({
        reply: "총괄: 이건 실행보다 대화예요.",
      }),
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "sherpalabs 쪽 랜딩 문구만 실제로 손봐줘",
        ts: "1712900000.000741",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.goals.listByProject("sherpalabs")).toHaveLength(1);
  expect(store.repositories.goals.listByProject("sherpalabs")[0]?.title).toBe(
    "랜딩 문구만 실제로 손봐줘",
  );
});

test("processSlackPayload passes prior governor thread history into follow-up conversation turns", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const seenHistory: string[] = [];
  const slackClient = {
    async postMessage() {
      return { ok: true, ts: "1710000000.000100" };
    },
  };

  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      governorConversationExecutor: async () => ({
        reply: "총괄: 가볍게 질문해도 괜찮아요.",
      }),
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "지금 가볍게 질문해도 돼?",
        ts: "1712900000.000900",
      },
    },
  );

  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      governorConversationExecutor: async (input) => {
        seenHistory.push(...(input.threadHistory ?? []).map((turn) => `${turn.speaker}:${turn.text}`));
        return {
          reply: "총괄: 그럼 지금 가장 먼저 볼 만한 건 mypetroutine 쪽 우선순위예요.",
        };
      },
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "그래 그럼 아무거나 얘기해봐",
        ts: "1712900000.000901",
        thread_ts: "1712900000.000900",
      },
    },
  );

  expect(seenHistory).toContain("user:지금 가볍게 질문해도 돼?");
  expect(seenHistory).toContain("assistant:총괄: 가볍게 질문해도 괜찮아요.");
});

test("processSlackPayload answers lightweight project-thread discussion through captain without queueing follow-up work", async () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });
  store.repositories.goals.create({
    id: "goal-existing",
    projectId: "mypetroutine",
    initiativeId: null,
    title: "온보딩 개선",
    state: "in_progress",
  });
  memoryStore.putProjectFact(
    "mypetroutine",
    "captain.thread.1712900000.000800.goal_id",
    "goal-existing",
  );

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      captainConversationExecutor: async () => ({
        mode: "reply",
        reply: "캡틴: 이건 새 라운드로 태울 필요 없이, QA를 붙인 이유만 바로 설명할 수 있어요.",
      }),
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000100" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "왜 QA를 붙였어?",
        ts: "1712900000.000810",
        thread_ts: "1712900000.000800",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.channel).toBe("C_MYPETROUTINE");
  expect(posted[0]?.thread_ts).toBe("1712900000.000800");
  expect(posted[0]?.text).toContain("캡틴");
  expect(store.repositories.runs.listByGoal("goal-existing")).toHaveLength(0);
});

test("processSlackPayload passes prior captain thread history into project follow-up discussion", async () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });
  store.repositories.goals.create({
    id: "goal-existing",
    projectId: "mypetroutine",
    initiativeId: null,
    title: "온보딩 개선",
    state: "in_progress",
  });
  memoryStore.putProjectFact(
    "mypetroutine",
    "captain.thread.1712900000.000950.goal_id",
    "goal-existing",
  );

  const seenHistory: string[] = [];
  const slackClient = {
    async postMessage() {
      return { ok: true, ts: "1710000000.000100" };
    },
  };

  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      captainConversationExecutor: async () => ({
        mode: "reply",
        reply: "캡틴: 이건 이번 스레드에서 바로 설명할 수 있어요.",
      }),
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "왜 이 방향으로 보고 있어?",
        ts: "1712900000.000951",
        thread_ts: "1712900000.000950",
      },
    },
  );

  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      captainConversationExecutor: async (input) => {
        seenHistory.push(...(input.threadHistory ?? []).map((turn) => `${turn.speaker}:${turn.text}`));
        return {
          mode: "reply",
          reply: "캡틴: 방금 설명했던 흐름을 이어서 정리해볼게요.",
        };
      },
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "좋아, 그럼 이어서 말해봐",
        ts: "1712900000.000952",
        thread_ts: "1712900000.000950",
      },
    },
  );

  expect(seenHistory).toContain("user:왜 이 방향으로 보고 있어?");
  expect(seenHistory).toContain("assistant:캡틴: 이건 이번 스레드에서 바로 설명할 수 있어요.");
});

test("processSlackPayload delegates project discussion into a new run when captain gate says execution is needed", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      captainConversationExecutor: async () => ({
        mode: "delegate",
        reply: "캡틴: 이건 바로 답하는 것보다 실제 라운드로 태우는 게 맞아요.",
      }),
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_MYPETROUTINE",
        user: "U_TONY",
        text: "이건 논의보다 실제 작업 라운드로 이어가는 게 낫지 않을까?",
        ts: "1712900000.000820",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.goals.listByProject("mypetroutine")).toHaveLength(1);
  expect(store.repositories.goals.listByProject("mypetroutine")[0]?.title).toBe(
    "이건 논의보다 실제 작업 라운드로 이어가는 게 낫지 않을까?",
  );
});

test("processSlackPayload delegates project deliverable requests even when discourse markers are present", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "test",
    slackChannelId: "C_TEST",
  });

  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      captainConversationExecutor: async () => ({
        mode: "reply",
        reply: "캡틴: 이건 대화예요.",
      }),
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TEST",
        user: "U_TONY",
        text: "그럼 이 채널 목표를 한 줄 문서로 정리해줘",
        ts: "1712900000.000821",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(store.repositories.goals.listByProject("test")).toHaveLength(1);
  expect(store.repositories.goals.listByProject("test")[0]?.title).toBe(
    "그럼 이 채널 목표를 한 줄 문서로 정리해줘",
  );
});

test("processSlackPayload does not let captain conversation replies hijack project deliverable requests in live mode", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "test",
    slackChannelId: "C_TEST",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000822" };
        },
      },
      captainConversationExecutor: async () => ({
        mode: "reply",
        reply: "캡틴: 이건 대화예요.",
      }),
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TEST",
        user: "U_TONY",
        text: "그럼 이 채널 목표를 한 줄 문서로 정리해줘",
        ts: "1712900000.000822",
      },
    },
  );

  expect(result).toEqual({ queued: true, handled: true });
  expect(posted).toHaveLength(0);
  expect(store.repositories.goals.listByProject("test")).toHaveLength(1);
});

test("processSlackPayload shows a structured governor status snapshot in ai-ops", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
    priority: 8,
  });
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
    priority: 3,
    paused: true,
  });
  store.repositories.goals.create({
    id: "goal-active",
    projectId: "mypetroutine",
    initiativeId: null,
    title: "온보딩 개선",
    state: "in_progress",
  });
  store.repositories.runs.create({
    id: "run-active",
    goalId: "goal-active",
    status: "running",
    queuedAt: "2026-04-14T01:00:00.000Z",
    startedAt: "2026-04-14T01:05:00.000Z",
    finishedAt: null,
  });
  store.repositories.goals.create({
    id: "goal-approval",
    projectId: "sherpalabs",
    initiativeId: null,
    title: "배포 준비",
    state: "awaiting_human_approval",
  });
  store.repositories.approvals.create({
    id: "approval-1",
    goalId: "goal-approval",
    type: "deploy",
    status: "pending",
    rationale: "배포 전 확인 필요",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000500" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "상태",
        ts: "1712900000.000900",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.text).toContain("총괄 상태");
  expect(posted[0]?.text).toContain("활성 프로젝트");
  expect(posted[0]?.text).toContain("#mypetroutine");
  expect(posted[0]?.text).toContain("승인 대기");
  expect(posted[0]?.text).toContain("#sherpalabs");
  expect(posted[0]?.text).toContain("일시정지");
});

test("processSlackPayload applies governor pause, resume, and reprioritize commands in ai-ops", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const slackClient = {
    async postMessage(input: { channel: string; thread_ts?: string; text: string }) {
      posted.push(input);
      return { ok: true, ts: "1710000000.000600" };
    },
  };

  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "우선순위 mypetroutine 9",
        ts: "1712900000.001000",
      },
    },
  );
  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "일시정지 mypetroutine",
        ts: "1712900000.001100",
      },
    },
  );
  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "재개 mypetroutine",
        ts: "1712900000.001200",
      },
    },
  );

  expect(store.repositories.projects.get("mypetroutine")).toMatchObject({
    priority: 9,
    paused: false,
  });
  expect(
    store.repositories.governorEvents.listByProject("mypetroutine").map((event) => event.eventType),
  ).toEqual(["project_reprioritized", "project_paused", "project_resumed"]);
  expect(posted).toHaveLength(3);
  expect(posted[0]?.text).toContain("총괄 정책 변경");
  expect(posted[0]?.text).toContain("우선순위: 9");
  expect(posted[1]?.text).toContain("일시정지");
  expect(posted[2]?.text).toContain("재개");
});

test("processSlackPayload summarizes queued and pending approval projects in ai-ops", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "mypetroutine",
    slackChannelId: "C_MYPETROUTINE",
    priority: 4,
  });
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
    priority: 7,
  });
  store.repositories.goals.create({
    id: "goal-queued",
    projectId: "mypetroutine",
    initiativeId: null,
    title: "QA 재검증",
    state: "planned",
  });
  store.repositories.runs.create({
    id: "run-queued",
    goalId: "goal-queued",
    status: "queued",
    queuedAt: "2026-04-14T02:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  });
  store.repositories.goals.create({
    id: "goal-approval",
    projectId: "sherpalabs",
    initiativeId: null,
    title: "배포 승인",
    state: "awaiting_human_approval",
  });
  store.repositories.approvals.create({
    id: "approval-queued",
    goalId: "goal-approval",
    type: "deploy",
    status: "pending",
    rationale: "릴리즈 전 확인",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const slackClient = {
    async postMessage(input: { channel: string; thread_ts?: string; text: string }) {
      posted.push(input);
      return { ok: true, ts: "1710000000.000700" };
    },
  };

  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "대기열",
        ts: "1712900000.001300",
      },
    },
  );
  await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient,
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "승인 대기",
        ts: "1712900000.001400",
      },
    },
  );

  expect(posted).toHaveLength(2);
  expect(posted[0]?.text).toContain("총괄 대기열");
  expect(posted[0]?.text).toContain("#mypetroutine");
  expect(posted[1]?.text).toContain("총괄 승인 대기");
  expect(posted[1]?.text).toContain("#sherpalabs");
  expect(posted[1]?.text).toContain("deploy");
});

test("processSlackPayload marks the latest approved deployment goal as released from ai-ops", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
  });
  store.repositories.goals.create({
    id: "goal-release",
    projectId: "sherpalabs",
    initiativeId: null,
    title: "메인 랜딩 배포",
    state: "approved",
  });
  store.repositories.stateTransitions.append({
    id: "transition-goal-release-approved",
    goalId: "goal-release",
    fromState: "awaiting_human_approval",
    toState: "approved",
    createdAt: "2026-04-14T03:00:00.000Z",
    actor: "captain",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000800" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "배포 완료 sherpalabs",
        ts: "1712900000.001500",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(store.repositories.goals.get("goal-release")?.state).toBe("released");
  expect(
    store.repositories.governorEvents.listByProject("sherpalabs").map((event) => event.eventType),
  ).toContain("goal_released");
  expect(
    store.repositories.stateTransitions.listByGoal("goal-release").some((transition) =>
      transition.fromState === "approved"
      && transition.toState === "released"
      && transition.actor === "governor"
    ),
  ).toBe(true);
  expect(posted[0]?.text).toContain("총괄 릴리즈");
  expect(posted[0]?.text).toContain("#sherpalabs");
});

test("processSlackPayload archives the latest released goal from ai-ops", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
  });
  store.repositories.goals.create({
    id: "goal-archive",
    projectId: "sherpalabs",
    initiativeId: null,
    title: "배포 후 정리",
    state: "released",
  });
  store.repositories.stateTransitions.append({
    id: "transition-goal-archive-released",
    goalId: "goal-archive",
    fromState: "approved",
    toState: "released",
    createdAt: "2026-04-14T03:10:00.000Z",
    actor: "governor",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000810" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "보관 sherpalabs",
        ts: "1712900000.001600",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(store.repositories.goals.get("goal-archive")?.state).toBe("archived");
  expect(
    store.repositories.governorEvents.listByProject("sherpalabs").map((event) => event.eventType),
  ).toContain("goal_archived");
  expect(
    store.repositories.stateTransitions.listByGoal("goal-archive").some((transition) =>
      transition.fromState === "released"
      && transition.toState === "archived"
      && transition.actor === "governor"
    ),
  ).toBe(true);
  expect(posted[0]?.text).toContain("총괄 보관");
  expect(posted[0]?.text).toContain("#sherpalabs");
});

test("processSlackPayload repairs stale in-progress goals from ai-ops", async () => {
  const store = openStore(":memory:");
  store.repositories.projects.create({
    id: "sherpalabs",
    slackChannelId: "C_SHERPALABS",
  });
  store.repositories.goals.create({
    id: "goal-stale",
    projectId: "sherpalabs",
    initiativeId: null,
    title: "스테일 상태 복구",
    state: "in_progress",
  });
  store.repositories.runs.create({
    id: "run-stale",
    goalId: "goal-stale",
    status: "succeeded",
    queuedAt: "2026-04-14T03:20:00.000Z",
    startedAt: "2026-04-14T03:21:00.000Z",
    finishedAt: "2026-04-14T03:25:00.000Z",
  });
  store.repositories.tasks.create({
    id: "run-stale:task-1",
    goalId: "goal-stale",
    runId: "run-stale",
    role: "backend",
    state: "succeeded",
    payloadJson: "{\"title\":\"backend\"}",
    attemptCount: 1,
    startedAt: "2026-04-14T03:21:00.000Z",
    finishedAt: "2026-04-14T03:22:00.000Z",
  });
  store.repositories.tasks.create({
    id: "run-stale:task-2",
    goalId: "goal-stale",
    runId: "run-stale",
    role: "qa",
    state: "succeeded",
    payloadJson: "{\"title\":\"qa\"}",
    attemptCount: 1,
    startedAt: "2026-04-14T03:23:00.000Z",
    finishedAt: "2026-04-14T03:25:00.000Z",
  });

  const posted: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const result = await processSlackPayload(
    {
      db: store.db,
      aiOpsChannelId: "C_TOTAL",
      slackClient: {
        async postMessage(input) {
          posted.push(input);
          return { ok: true, ts: "1710000000.000820" };
        },
      },
    },
    "event",
    {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C_TOTAL",
        user: "U_TONY",
        text: "복구 sherpalabs",
        ts: "1712900000.001700",
      },
    },
  );

  expect(result).toEqual({ queued: false, handled: true });
  expect(
    store.repositories.governorEvents.listByProject("sherpalabs").map((event) => event.eventType),
  ).toEqual(["stale_state_repaired"]);
  expect(store.repositories.goals.get("goal-stale")?.state).toBe("approved");
  expect(store.repositories.stateTransitions.listByGoal("goal-stale").at(-1)).toMatchObject({
    fromState: "in_progress",
    toState: "approved",
    actor: "repair-script",
  });
  expect(posted[0]?.text).toContain("총괄 복구");
  expect(posted[0]?.text).toContain("#sherpalabs");
  expect(posted[0]?.text).toContain("1건");
});
