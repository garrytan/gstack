import { test, expect } from "bun:test";
import { resolveConfig } from "../src/config";

test("resolveConfig defaults state paths under .gstack/rico", () => {
  const cfg = resolveConfig({ cwd: "/tmp/demo-repo", env: {} });
  expect(cfg.stateDir).toBe("/tmp/demo-repo/.gstack/rico");
  expect(cfg.dbPath).toBe("/tmp/demo-repo/.gstack/rico/rico.sqlite");
  expect(cfg.artifactDir).toBe("/tmp/demo-repo/.gstack/rico/artifacts");
  expect(cfg.maxActiveProjects).toBe(2);
  expect(cfg.slackSigningSecret).toBe("");
  expect(cfg.slackBotToken).toBe("");
});

test("resolveConfig reads slack env fields when present", () => {
  const cfg = resolveConfig({
    cwd: "/tmp/demo-repo",
    env: {
      SLACK_SIGNING_SECRET: "signing-secret",
      SLACK_BOT_TOKEN: "bot-token",
    },
  });

  expect(cfg.slackSigningSecret).toBe("signing-secret");
  expect(cfg.slackBotToken).toBe("bot-token");
});
