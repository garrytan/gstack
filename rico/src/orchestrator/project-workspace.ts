import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../memory/store";

function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function tokenize(value: string) {
  return normalizeSlug(value)
    .split("-")
    .filter(Boolean)
    .filter((token) => !["mirror", "workspace", "worktree", "project", "projects"].includes(token));
}

function scoreCandidate(projectId: string, candidateName: string) {
  const normalizedProject = normalizeSlug(projectId);
  const normalizedCandidate = normalizeSlug(candidateName);

  if (!normalizedProject || !normalizedCandidate) return -1;
  if (normalizedProject === normalizedCandidate) return 100;
  if (normalizedCandidate.includes(normalizedProject)) return 90;
  if (normalizedProject.includes(normalizedCandidate)) return 85;

  const projectTokens = tokenize(projectId);
  const candidateTokens = tokenize(candidateName);
  const overlap = projectTokens.filter((token) => candidateTokens.includes(token));
  if (overlap.length === 0) return -1;

  return overlap.length * 20;
}

function scoreWorkspaceContents(
  candidatePath: string,
  pathExists: (path: string) => boolean,
) {
  let score = 0;
  if (pathExists(join(candidatePath, "package.json"))) score += 40;
  if (pathExists(join(candidatePath, "src"))) score += 25;
  if (pathExists(join(candidatePath, "AGENTS.md"))) score += 20;
  if (pathExists(join(candidatePath, ".git"))) score += 15;
  if (pathExists(join(candidatePath, "docs"))) score += 10;
  return score;
}

export function looksLikeProjectWorkspace(
  candidatePath: string,
  pathExists: (path: string) => boolean = existsSync,
) {
  return pathExists(candidatePath) && scoreWorkspaceContents(candidatePath, pathExists) >= 40;
}

function defaultCandidateRoots() {
  const home = process.env.HOME ?? "";
  const envRoots = (process.env.RICO_PROJECT_ROOTS ?? "")
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean);

  return [
    ...envRoots,
    home ? join(home, ".openclaw", "worktrees") : "",
    home ? join(home, ".openclaw", "workspace", "projects") : "",
    home ? join(home, "ai-server", "projects") : "",
    home ? join(home, "repos-watch") : "",
    home ? join(home, "Documents") : "",
  ].filter(Boolean);
}

function defaultListDirectories(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

export function resolveProjectWorkspace(input: {
  projectId: string;
  memoryStore?: MemoryStore;
  candidateRoots?: string[];
  pathExists?: (path: string) => boolean;
  listDirectories?: (root: string) => string[];
}) {
  const pathExists = input.pathExists ?? existsSync;
  const listDirectories = input.listDirectories ?? defaultListDirectories;

  const projectMemory = input.memoryStore?.getProjectMemory(input.projectId) ?? {};
  const override = projectMemory["project.repo_root"];
  const overrideSource = projectMemory["project.repo_root_source"];
  const overrideLooksLikeRepo = override && looksLikeProjectWorkspace(override, pathExists);
  if (overrideLooksLikeRepo && overrideSource === "manual") {
    return override;
  }

  const candidates = (input.candidateRoots ?? defaultCandidateRoots())
    .filter((root) => pathExists(root))
    .flatMap((root) => listDirectories(root));

  let bestPath: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const name = candidate.split("/").at(-1) ?? candidate;
    const nameScore = scoreCandidate(input.projectId, name);
    if (nameScore < 0) continue;
    const score = nameScore + scoreWorkspaceContents(candidate, pathExists);
    if (score > bestScore) {
      bestScore = score;
      bestPath = candidate;
    }
  }

  if (bestPath && bestScore >= 20) {
    input.memoryStore?.putProjectFact(input.projectId, "project.repo_root", bestPath);
    input.memoryStore?.putProjectFact(input.projectId, "project.repo_root_source", "auto");
    return bestPath;
  }

  if (
    override
    && overrideLooksLikeRepo
    && scoreCandidate(input.projectId, override.split("/").at(-1) ?? override) >= 0
  ) {
    return override;
  }

  return null;
}
