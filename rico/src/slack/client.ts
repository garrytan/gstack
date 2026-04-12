import type { SlackMessageClient } from "./publish";

export function createSlackWebClient(token: string): SlackMessageClient {
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
  };
}
