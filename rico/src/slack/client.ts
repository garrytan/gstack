import type { SlackExternalUploadClient } from "./files";
import type { SlackMessageClient } from "./publish";

export function createSlackWebClient(token: string): SlackMessageClient & SlackExternalUploadClient {
  async function slackApiJson<T>(
    method: string,
    params: Record<string, string>,
  ) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  return {
    async postMessage(input) {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(input),
      });
      const body = await response.json() as {
        ok: boolean;
        ts?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(`Slack chat.postMessage failed with HTTP ${response.status}`);
      }

      return {
        ok: body.ok,
        ts: body.ts,
      };
    },
    async getConversationInfo(channelId) {
      const body = await slackApiJson<{
        ok: boolean;
        channel?: {
          id: string;
          name?: string;
          is_channel?: boolean;
          is_archived?: boolean;
        };
      }>("conversations.info", { channel: channelId });

      return {
        ok: body.ok,
        channel: body.channel,
      };
    },
    async findConversationByName(name) {
      let cursor = "";

      while (true) {
        const body = await slackApiJson<{
          ok: boolean;
          channels?: Array<{
            id: string;
            name?: string;
            is_channel?: boolean;
            is_archived?: boolean;
          }>;
          response_metadata?: {
            next_cursor?: string;
          };
        }>("conversations.list", {
          exclude_archived: "true",
          limit: "1000",
          types: "public_channel,private_channel",
          ...(cursor ? { cursor } : {}),
        });

        const channel = body.channels?.find(
          (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
        );
        if (channel) {
          return {
            ok: true,
            channel,
          };
        }

        cursor = body.response_metadata?.next_cursor?.trim() ?? "";
        if (!body.ok || !cursor) {
          return {
            ok: false,
          };
        }
      }
    },
    async getUploadURLExternal(input) {
      const body = await slackApiJson<{
        ok: boolean;
        upload_url?: string;
        file_id?: string;
        error?: string;
      }>("files.getUploadURLExternal", {
        filename: input.filename,
        length: String(input.length),
      });
      if (!body.ok || !body.upload_url || !body.file_id) {
        throw new Error(`Slack files.getUploadURLExternal failed: ${body.error ?? "unknown_error"}`);
      }
      return {
        upload_url: body.upload_url,
        file_id: body.file_id,
      };
    },
    async uploadBinary(input) {
      const response = await fetch(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
        },
        body: input.content,
      });
      if (!response.ok) {
        throw new Error(`Slack upload URL rejected binary with HTTP ${response.status}`);
      }
      return await response.text();
    },
    async completeUploadExternal(input) {
      return await slackApiJson<{
        ok: boolean;
        files?: Array<{ id: string; title?: string; permalink?: string }>;
      }>("files.completeUploadExternal", {
        files: JSON.stringify(input.files),
        ...(input.channel_id ? { channel_id: input.channel_id } : {}),
        ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      });
    },
  };
}
