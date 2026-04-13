import { expect, mock, test } from "bun:test";
import { createSlackWebClient } from "../src/slack/client";

test("createSlackWebClient implements Slack external upload flow", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({ url, init });

    if (url === "https://slack.com/api/files.getUploadURLExternal") {
      return new Response(
        JSON.stringify({
          ok: true,
          upload_url: "https://uploads.slack.test/file",
          file_id: "F123",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === "https://uploads.slack.test/file") {
      return new Response("ok", { status: 200 });
    }

    if (url === "https://slack.com/api/files.completeUploadExternal") {
      return new Response(
        JSON.stringify({
          ok: true,
          files: [
            {
              id: "F123",
              title: "qa-report.md",
              permalink: "https://slack.test/files/F123",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const client = createSlackWebClient("xoxb-test");
    const ticket = await client.getUploadURLExternal({
      filename: "qa-report.md",
      length: 12,
    });
    await client.uploadBinary({
      url: ticket.upload_url,
      content: new TextEncoder().encode("# QA Report\n"),
    });
    const completed = await client.completeUploadExternal({
      files: [{ id: ticket.file_id, title: "qa-report.md" }],
      channel_id: "C_PROJECT",
      thread_ts: "1710000000.000100",
    });

    expect(ticket.file_id).toBe("F123");
    expect(completed.ok).toBe(true);
    expect(completed.files?.[0]?.permalink).toBe("https://slack.test/files/F123");
    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://uploads.slack.test/file",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
