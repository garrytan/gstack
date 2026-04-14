import { existsSync } from "node:fs";
import { MemoryStore } from "../memory/store";
import {
  looksLikeProjectWorkspace,
  readOriginRemoteUrl,
  resolveProjectWorkspace,
} from "../orchestrator/project-workspace";

export type ProjectWorkspaceCommand =
  | { type: "status" }
  | { type: "set-root"; root: string }
  | { type: "set-repo-url"; repoUrl: string }
  | { type: "auto" };

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function looksLikeGitRemoteUrl(value: string) {
  return /^(?:git@|ssh:\/\/git@|https?:\/\/).+\.git$/i.test(value.trim());
}

export function parseProjectWorkspaceCommand(text: string): ProjectWorkspaceCommand | null {
  const normalized = normalizeText(text);

  if (/^(?:저장소|repo)\s+상태$/i.test(normalized)) {
    return { type: "status" };
  }

  const setMatch = normalized.match(/^(?:저장소|repo)\s*:\s*(.+)$/i);
  if (setMatch?.[1]) {
    const value = setMatch[1].trim();
    if (looksLikeGitRemoteUrl(value)) {
      return {
        type: "set-repo-url",
        repoUrl: value,
      };
    }
    return {
      type: "set-root",
      root: value,
    };
  }

  if (/^(?:저장소|repo)\s+자동$/i.test(normalized)) {
    return { type: "auto" };
  }

  if (
    /^(?:저장소|repo)\s+탐색(?:해서)?(?:\s+찾아봐)?$/i.test(normalized)
    || /^로컬\s+경로\s+탐색(?:을)?(?:\s+해서)?\s+찾아봐$/i.test(normalized)
  ) {
    return { type: "auto" };
  }

  return null;
}

function buildWorkspaceStatusText(input: {
  projectId: string;
  root: string | null;
  source: string | null;
  valid: boolean;
  repoUrl?: string | null;
  note?: string;
}) {
  const lines = [
    "🗂️ 저장소 설정",
    `- 프로젝트: #${input.projectId}`,
    `- 저장소: ${input.root ?? "미설정"}`,
    `- 원격: ${input.repoUrl ?? "미설정"}`,
    `- 소스: ${input.source ?? "없음"}`,
    `- 상태: ${input.valid ? "사용 가능" : "확인 필요"}`,
  ];
  if (input.note) {
    lines.push(`- 메모: ${input.note}`);
  }
  return lines.join("\n");
}

export function applyProjectWorkspaceCommand(input: {
  memoryStore: MemoryStore;
  projectId: string;
  command: ProjectWorkspaceCommand;
  pathExists?: (path: string) => boolean;
}) {
  const pathExists = input.pathExists ?? existsSync;
  const projectMemory = input.memoryStore.getProjectMemory(input.projectId);

  if (input.command.type === "status") {
    const root = projectMemory["project.repo_root"] ?? null;
    const repoUrl = projectMemory["project.repo_url"] ?? null;
    const source = projectMemory["project.repo_root_source"] ?? null;
    const resolved =
      root && source === "manual"
        ? root
        : resolveProjectWorkspace({
            projectId: input.projectId,
            memoryStore: input.memoryStore,
            pathExists,
          });
    const resolvedMemory = input.memoryStore.getProjectMemory(input.projectId);
    const effectiveSource = resolvedMemory["project.repo_root_source"] ?? source;
    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root: resolved ?? null,
      repoUrl,
      source: effectiveSource ?? null,
      valid: resolved ? looksLikeProjectWorkspace(resolved, pathExists) : false,
      note: resolved ? undefined : "직접 지정하거나 자동 탐색이 가능한 저장소를 먼저 연결해 주세요.",
    });
  }

  if (input.command.type === "auto") {
    input.memoryStore.deleteProjectFact(input.projectId, "project.repo_root");
    input.memoryStore.deleteProjectFact(input.projectId, "project.repo_root_source");
    const resolved = resolveProjectWorkspace({
      projectId: input.projectId,
      memoryStore: input.memoryStore,
      pathExists,
    });
    const resolvedMemory = input.memoryStore.getProjectMemory(input.projectId);
    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root: resolved ?? null,
      repoUrl: resolvedMemory["project.repo_url"] ?? null,
      source: resolvedMemory["project.repo_root_source"] ?? null,
      valid: resolved ? looksLikeProjectWorkspace(resolved, pathExists) : false,
      note: resolved ? "자동 탐색 기준으로 다시 맞췄어요." : "자동 탐색으로는 아직 맞는 저장소를 찾지 못했어요.",
    });
  }

  if (input.command.type === "set-repo-url") {
    input.memoryStore.putProjectFact(input.projectId, "project.repo_url", input.command.repoUrl);
    input.memoryStore.putProjectFact(input.projectId, "project.repo_url_source", "manual");
    input.memoryStore.deleteProjectFact(input.projectId, "project.repo_root");
    input.memoryStore.deleteProjectFact(input.projectId, "project.repo_root_source");

    const resolved = resolveProjectWorkspace({
      projectId: input.projectId,
      memoryStore: input.memoryStore,
      pathExists,
    });
    const resolvedMemory = input.memoryStore.getProjectMemory(input.projectId);

    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root: resolved ?? null,
      repoUrl: input.command.repoUrl,
      source: resolvedMemory["project.repo_root_source"] ?? "manual",
      valid: resolved ? looksLikeProjectWorkspace(resolved, pathExists) : false,
      note: resolved
        ? "원격 저장소 기준으로 로컬 작업 경로까지 연결했어요."
        : "원격 저장소는 기억했지만, 아직 일치하는 로컬 작업 경로는 찾지 못했어요.",
    });
  }

  const root = input.command.root;
  if (!pathExists(root)) {
    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root,
      repoUrl: projectMemory["project.repo_url"] ?? null,
      source: "manual",
      valid: false,
      note: "경로가 존재하지 않아요.",
    });
  }
  if (!looksLikeProjectWorkspace(root, pathExists)) {
    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root,
      repoUrl: projectMemory["project.repo_url"] ?? null,
      source: "manual",
      valid: false,
      note: "git 저장소나 앱 루트처럼 보이지 않아요.",
    });
  }

  input.memoryStore.putProjectFact(input.projectId, "project.repo_root", root);
  input.memoryStore.putProjectFact(input.projectId, "project.repo_root_source", "manual");
  const inferredRepoUrl = readOriginRemoteUrl(root, pathExists);
  if (inferredRepoUrl) {
    input.memoryStore.putProjectFact(input.projectId, "project.repo_url", inferredRepoUrl);
    input.memoryStore.putProjectFact(input.projectId, "project.repo_url_source", "inferred");
  }

  return buildWorkspaceStatusText({
    projectId: input.projectId,
    root,
    repoUrl: inferredRepoUrl ?? projectMemory["project.repo_url"] ?? null,
    source: "manual",
    valid: true,
    note: "이 프로젝트의 기본 저장소로 고정했어요.",
  });
}
