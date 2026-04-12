interface SocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export async function routeSocketEnvelope(
  envelope: SocketEnvelope,
  processPayload: (kind: "event" | "interaction", payload: Record<string, unknown>) => Promise<void>,
) {
  if (envelope.type === "events_api" && envelope.payload && typeof envelope.payload === "object") {
    await processPayload("event", envelope.payload);
    return true;
  }
  if (envelope.type === "interactive" && envelope.payload && typeof envelope.payload === "object") {
    await processPayload("interaction", envelope.payload);
    return true;
  }
  return false;
}

export async function startSlackSocketMode(input: {
  appToken: string;
  processPayload: (kind: "event" | "interaction", payload: Record<string, unknown>) => Promise<void>;
  logger?: Pick<Console, "info" | "error" | "warn">;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  reconnectDelayMs?: number;
}) {
  if (!input.appToken) {
    throw new Error("SLACK_APP_TOKEN is required for socket mode");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const webSocketFactory = input.webSocketFactory ?? ((url) => new WebSocket(url));
  const logger = input.logger ?? console;
  const reconnectDelayMs = input.reconnectDelayMs ?? 1000;
  let stopped = false;
  let currentSocket: WebSocket | null = null;

  async function openConnection() {
    const response = await fetchImpl("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.appToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    const body = await response.json() as { ok?: boolean; url?: string; error?: string };
    if (!response.ok || body.ok !== true || typeof body.url !== "string") {
      throw new Error(`Slack apps.connections.open failed: ${body.error ?? response.status}`);
    }
    return body.url;
  }

  async function connect() {
    const url = await openConnection();
    const socket = webSocketFactory(url);
    currentSocket = socket;

    socket.onopen = () => {
      logger.info(JSON.stringify({ service: "rico", slackMode: "socket", state: "connected" }));
    };
    socket.onmessage = (event) => {
      void (async () => {
        try {
          const envelope = JSON.parse(String(event.data)) as SocketEnvelope;
          if (envelope.envelope_id) {
            socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          }
          await routeSocketEnvelope(envelope, input.processPayload);
        } catch (error) {
          logger.error(error);
        }
      })();
    };
    socket.onerror = (event) => {
      logger.warn(JSON.stringify({ service: "rico", slackMode: "socket", state: "error", event: String(event) }));
    };
    socket.onclose = () => {
      currentSocket = null;
      if (stopped) return;
      logger.warn(JSON.stringify({ service: "rico", slackMode: "socket", state: "closed", reconnectDelayMs }));
      setTimeout(() => {
        if (!stopped) {
          void connect();
        }
      }, reconnectDelayMs);
    };
  }

  await connect();

  return {
    stop() {
      stopped = true;
      currentSocket?.close();
    },
  };
}
