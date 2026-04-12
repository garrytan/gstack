import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RicoConfig, ResolveConfigInput } from "./types";

function parseMaxActiveProjects(value: string | undefined): number {
  if (value === undefined) return 2;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid RICO_MAX_ACTIVE_PROJECTS: ${JSON.stringify(value)}. Expected a positive finite integer.`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid RICO_MAX_ACTIVE_PROJECTS: ${JSON.stringify(value)}. Expected a positive finite integer.`,
    );
  }

  return parsed;
}

export function resolveConfig(input: ResolveConfigInput = {}): RicoConfig {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const stateDir = join(cwd, ".gstack", "rico");
  const openclawConfig =
    input.openclawConfig ?? readOpenClawConfig(env.OPENCLAW_CONFIG_PATH, env.HOME);
  const openclawSlack =
    openclawConfig &&
    typeof openclawConfig === "object" &&
    "channels" in openclawConfig &&
    openclawConfig.channels &&
    typeof openclawConfig.channels === "object" &&
    "slack" in openclawConfig.channels &&
    openclawConfig.channels.slack &&
    typeof openclawConfig.channels.slack === "object"
      ? openclawConfig.channels.slack as Record<string, unknown>
      : null;

  return {
    stateDir,
    dbPath: join(stateDir, "rico.sqlite"),
    artifactDir: join(stateDir, "artifacts"),
    maxActiveProjects: parseMaxActiveProjects(env.RICO_MAX_ACTIVE_PROJECTS),
    aiOpsChannelId: env.RICO_AI_OPS_CHANNEL_ID ?? "",
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? "",
    slackBotToken:
      env.SLACK_BOT_TOKEN ??
      (typeof openclawSlack?.botToken === "string" ? openclawSlack.botToken : ""),
    slackAppToken:
      env.SLACK_APP_TOKEN ??
      (typeof openclawSlack?.appToken === "string" ? openclawSlack.appToken : ""),
  };
}

function readOpenClawConfig(explicitPath: string | undefined, home: string | undefined) {
  const candidates = [
    explicitPath,
    home ? join(home, ".openclaw", "openclaw.json") : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
  }

  return null;
}
