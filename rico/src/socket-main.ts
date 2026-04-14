import { createRicoRuntime } from "./main";
import { processSlackPayload } from "./slack/ingress";
import { startSlackSocketMode } from "./slack/socket-mode";

if (import.meta.main) {
  const runtime = createRicoRuntime();
  runtime.runner.start();

  await startSlackSocketMode({
    appToken: runtime.config.slackAppToken,
    processPayload: async (kind, payload) => {
      await processSlackPayload(
        {
          db: runtime.store.db,
          aiOpsChannelId: runtime.config.aiOpsChannelId,
          maxActiveProjects: runtime.config.maxActiveProjects,
          governorConversationExecutor: runtime.governorConversationExecutor,
          captainConversationExecutor: runtime.captainConversationExecutor,
          slackClient: runtime.slackClient,
          triggerDrain: () => runtime.runner.kick(),
        },
        kind,
        payload,
      );
    },
  });

  console.log(
    JSON.stringify({
      service: "rico",
      stateDir: runtime.config.stateDir,
      maxActiveProjects: runtime.config.maxActiveProjects,
      slackMode: "socket",
      aiOpsChannelId: runtime.config.aiOpsChannelId,
    }),
  );
}
