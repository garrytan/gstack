export interface RicoConfig {
  stateDir: string;
  dbPath: string;
  artifactDir: string;
  maxActiveProjects: number;
  aiOpsChannelId: string;
  slackSigningSecret: string;
  slackBotToken: string;
  slackAppToken: string;
}

export interface ResolveConfigInput {
  cwd?: string;
  env?: Record<string, string | undefined>;
  openclawConfig?: Record<string, unknown>;
}
