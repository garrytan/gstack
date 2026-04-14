import { existsSync } from "node:fs";
import { MemoryStore } from "../memory/store";
import { looksLikeProjectWorkspace, resolveProjectWorkspace } from "../orchestrator/project-workspace";

export type ProjectWorkspaceCommand =
  | { type: "status" }
  | { type: "set-root"; root: string }
  | { type: "auto" };

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

export function parseProjectWorkspaceCommand(text: string): ProjectWorkspaceCommand | null {
  const normalized = normalizeText(text);

  if (/^(?:저장소|repo)\s+상태$/i.test(normalized)) {
    return { type: "status" };
  }

  const setMatch = normalized.match(/^(?:저장소|repo)\s*:\s*(.+)$/i);
  if (setMatch?.[1]) {
    return {
      type: "set-root",
      root: setMatch[1].trim(),
    };
  }

  if (/^(?:저장소|repo)\s+자동$/i.test(normalized)) {
    return { type: "auto" };
  }

  return null;
}

function buildWorkspaceStatusText(input: {
  projectId: string;
  root: string | null;
  source: string | null;
  valid: boolean;
  note?: string;
}) {
  const lines = [
    "🗂️ 저장소 설정",
    `- 프로젝트: #${input.projectId}`,
    `- 저장소: ${input.root ?? "미설정"}`,
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
      source: resolvedMemory["project.repo_root_source"] ?? null,
      valid: resolved ? looksLikeProjectWorkspace(resolved, pathExists) : false,
      note: resolved ? "자동 탐색 기준으로 다시 맞췄어요." : "자동 탐색으로는 아직 맞는 저장소를 찾지 못했어요.",
    });
  }

  const root = input.command.root;
  if (!pathExists(root)) {
    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root,
      source: "manual",
      valid: false,
      note: "경로가 존재하지 않아요.",
    });
  }
  if (!looksLikeProjectWorkspace(root, pathExists)) {
    return buildWorkspaceStatusText({
      projectId: input.projectId,
      root,
      source: "manual",
      valid: false,
      note: "git 저장소나 앱 루트처럼 보이지 않아요.",
    });
  }

  input.memoryStore.putProjectFact(input.projectId, "project.repo_root", root);
  input.memoryStore.putProjectFact(input.projectId, "project.repo_root_source", "manual");

  return buildWorkspaceStatusText({
    projectId: input.projectId,
    root,
    source: "manual",
    valid: true,
    note: "이 프로젝트의 기본 저장소로 고정했어요.",
  });
}
