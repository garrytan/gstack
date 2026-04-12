import { resolveConfig } from "./config";
import { createRuntimeDispatcher } from "./runtime/dispatcher";
import { startJobRunner } from "./runtime/job-runner";
import { createSlackWebClient } from "./slack/client";
import { createSlackRouter } from "./slack/router";
import type { SlackMessageClient } from "./slack/publish";
import { openStore } from "./state/store";

export function createRicoRuntime(input: {
  config?: ReturnType<typeof resolveConfig>;
  port?: number;
  slackClient?: SlackMessageClient;
} = {}) {
  const config = input.config ?? resolveConfig();
  const store = openStore(config.dbPath);
  const slackClient = input.slackClient ?? createSlackWebClient(config.slackBotToken);
  const dispatch = createRuntimeDispatcher({
    db: store.db,
    slackClient,
    maxActiveProjects: config.maxActiveProjects,
  });
  const runner = startJobRunner({
    db: store.db,
    dispatch,
  });
  const fetch = createSlackRouter({
    db: store.db,
    aiOpsChannelId: config.aiOpsChannelId,
    signingSecret: config.slackSigningSecret,
    slackClient,
    triggerDrain: () => runner.kick(),
  });

  return {
    config,
    fetch,
    port: input.port ?? Number(process.env.PORT ?? "3000"),
    runner,
    slackClient,
    store,
  };
}

if (import.meta.main) {
  const runtime = createRicoRuntime();
  runtime.runner.start();
  const server = Bun.serve({
    port: runtime.port,
    fetch: runtime.fetch,
  });

  console.log(
    JSON.stringify({
      service: "rico",
      stateDir: runtime.config.stateDir,
      maxActiveProjects: runtime.config.maxActiveProjects,
      port: server.port,
    }),
  );
}
