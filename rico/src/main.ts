import { createCodexCaptainExecutor } from "./codex/captain";
import {
  createCodexCaptainConversationExecutor,
  createCodexGovernorConversationExecutor,
} from "./codex/conversation";
import { resolveConfig } from "./config";
import { createCodexSpecialistExecutor } from "./codex/executor";
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
    captainExecutor?: Parameters<typeof createRuntimeDispatcher>[0]["captainExecutor"];
    specialistExecutor?: Parameters<typeof createRuntimeDispatcher>[0]["specialistExecutor"];
    governorConversationExecutor?: Parameters<typeof createSlackRouter>[0]["governorConversationExecutor"];
    captainConversationExecutor?: Parameters<typeof createSlackRouter>[0]["captainConversationExecutor"];
} = {}) {
  const config = input.config ?? resolveConfig();
  const store = openStore(config.dbPath);
  const slackClient = input.slackClient ?? createSlackWebClient(config.slackBotToken);
  const captainExecutor =
    input.captainExecutor
    ?? (input.slackClient
      ? undefined
      : createCodexCaptainExecutor({
          openclawWorkspacePath: config.openclawWorkspacePath,
        }));
  const specialistExecutor =
    input.specialistExecutor
    ?? (input.slackClient
      ? undefined
      : createCodexSpecialistExecutor({
          openclawWorkspacePath: config.openclawWorkspacePath,
        }));
  const governorConversationExecutor =
    input.governorConversationExecutor
    ?? (input.slackClient ? undefined : createCodexGovernorConversationExecutor());
  const captainConversationExecutor =
    input.captainConversationExecutor
    ?? (input.slackClient
      ? undefined
      : createCodexCaptainConversationExecutor({
          openclawWorkspacePath: config.openclawWorkspacePath,
        }));
  const dispatch = createRuntimeDispatcher({
    db: store.db,
    slackClient,
    maxActiveProjects: config.maxActiveProjects,
    artifactRoot: config.artifactDir,
    captainExecutor,
    specialistExecutor,
  });
  const runner = startJobRunner({
    db: store.db,
    dispatch,
  });
  const fetch = createSlackRouter({
    db: store.db,
    aiOpsChannelId: config.aiOpsChannelId,
    maxActiveProjects: config.maxActiveProjects,
    signingSecret: config.slackSigningSecret,
    slackClient,
    governorConversationExecutor,
    captainConversationExecutor,
    triggerDrain: () => runner.kick(),
  });

  return {
    captainConversationExecutor,
    captainExecutor,
    config,
    fetch,
    governorConversationExecutor,
    port: input.port ?? Number(process.env.PORT ?? "3000"),
    runner,
    slackClient,
    specialistExecutor,
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
