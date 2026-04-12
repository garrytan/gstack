import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ResolveOpenClawWorkspaceRootInput {
  env?: Record<string, string | undefined>;
  home?: string;
  openclawConfig?: Record<string, unknown> | null;
}

interface LoadOpenClawContextArtifactsInput {
  workspacePath?: string | null;
  repoPath?: string | null;
  maxCharsPerFile?: number;
}

interface ContextArtifact {
  title: string;
  body: string;
}

function trimBody(body: string, maxCharsPerFile: number) {
  const normalized = body.trim();
  if (normalized.length <= maxCharsPerFile) return normalized;
  return `${normalized.slice(0, maxCharsPerFile).trimEnd()}\n...[truncated]`;
}

function readArtifact(path: string, title: string, maxCharsPerFile: number) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return null;
  return {
    title,
    body: trimBody(raw, maxCharsPerFile),
  } satisfies ContextArtifact;
}

export function resolveOpenClawWorkspaceRoot(
  input: ResolveOpenClawWorkspaceRootInput = {},
) {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? process.env.HOME ?? "";
  const configuredWorkspace =
    input.openclawConfig
    && typeof input.openclawConfig.agents === "object"
    && input.openclawConfig.agents
    && typeof (input.openclawConfig.agents as Record<string, unknown>).defaults === "object"
    && (input.openclawConfig.agents as Record<string, unknown>).defaults
    && typeof ((input.openclawConfig.agents as Record<string, unknown>).defaults as Record<string, unknown>).workspace === "string"
      ? (((input.openclawConfig.agents as Record<string, unknown>).defaults as Record<string, unknown>).workspace as string)
      : null;

  return env.RICO_OPENCLAW_WORKSPACE
    ?? env.OPENCLAW_WORKSPACE
    ?? configuredWorkspace
    ?? (home ? join(home, ".openclaw", "workspace") : null);
}

export function loadOpenClawContextArtifacts(
  input: LoadOpenClawContextArtifactsInput,
) {
  const maxCharsPerFile = input.maxCharsPerFile ?? 1800;
  const artifacts: ContextArtifact[] = [];

  if (input.workspacePath) {
    const workspaceArtifacts: Array<[string, string]> = [
      [join(input.workspacePath, "SOUL.md"), "openclaw-soul.md"],
      [join(input.workspacePath, "AGENTS.md"), "openclaw-agents.md"],
      [join(input.workspacePath, "USER.md"), "openclaw-user.md"],
    ];
    for (const [path, title] of workspaceArtifacts) {
      const artifact = readArtifact(path, title, maxCharsPerFile);
      if (artifact) artifacts.push(artifact);
    }
  }

  if (input.repoPath) {
    const repoAgents = readArtifact(
      join(input.repoPath, "AGENTS.md"),
      "repo-agents.md",
      maxCharsPerFile,
    );
    if (repoAgents) artifacts.push(repoAgents);
  }

  return artifacts;
}
