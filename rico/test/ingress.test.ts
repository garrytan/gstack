import { test, expect } from "bun:test";
import { processSlackPayload } from "../src/slack/ingress";
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
