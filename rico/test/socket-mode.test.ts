import { test, expect } from "bun:test";
import { routeSocketEnvelope } from "../src/slack/socket-mode";

test("routeSocketEnvelope maps events_api envelopes to event payload handling", async () => {
  const received: Array<{ kind: string; payload: unknown }> = [];

  const handled = await routeSocketEnvelope(
    {
      envelope_id: "envelope-1",
      type: "events_api",
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C_TOTAL",
          user: "U_TONY",
          text: "mypetroutine: 온보딩 개선",
          ts: "1712900000.000100",
        },
      },
    },
    async (kind, payload) => {
      received.push({ kind, payload });
    },
  );

  expect(handled).toBe(true);
  expect(received).toEqual([
    {
      kind: "event",
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C_TOTAL",
          user: "U_TONY",
          text: "mypetroutine: 온보딩 개선",
          ts: "1712900000.000100",
        },
      },
    },
  ]);
});

test("routeSocketEnvelope maps interactive envelopes to interaction payload handling", async () => {
  const received: Array<{ kind: string; payload: unknown }> = [];

  const handled = await routeSocketEnvelope(
    {
      envelope_id: "envelope-2",
      type: "interactive",
      payload: {
        type: "block_actions",
        user: { id: "U_TONY" },
        actions: [{ action_id: "approval:approve", value: "approval-1" }],
      },
    },
    async (kind, payload) => {
      received.push({ kind, payload });
    },
  );

  expect(handled).toBe(true);
  expect(received).toEqual([
    {
      kind: "interaction",
      payload: {
        type: "block_actions",
        user: { id: "U_TONY" },
        actions: [{ action_id: "approval:approve", value: "approval-1" }],
      },
    },
  ]);
});

test("routeSocketEnvelope ignores unsupported envelope types", async () => {
  const received: Array<{ kind: string; payload: unknown }> = [];

  const handled = await routeSocketEnvelope(
    {
      envelope_id: "envelope-3",
      type: "hello",
    },
    async (kind, payload) => {
      received.push({ kind, payload });
    },
  );

  expect(handled).toBe(false);
  expect(received).toEqual([]);
});
