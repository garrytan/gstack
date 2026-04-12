export interface RicoConfig {
  stateDir: string;
  dbPath: string;
  artifactDir: string;
  maxActiveProjects: number;
  slackSigningSecret: string;
  slackBotToken: string;
}

export interface ResolveConfigInput {
  cwd?: string;
  env?: Record<string, string | undefined>;
}
