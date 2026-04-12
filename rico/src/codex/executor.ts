import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoleContext } from "../memory/context-loader";
import { loadOpenClawContextArtifacts } from "../memory/openclaw-context";
import { MemoryStore } from "../memory/store";
import { resolveProjectWorkspace } from "../orchestrator/project-workspace";
import type { SpecialistResult } from "../roles/contracts";
import { ROLE_REGISTRY, type RoleName } from "../roles";

export interface CodexSpecialistMeta {
  workspacePath: string | null;
  tokensUsed: number;
  inspectedWorkspace: boolean;
}

export interface CodexSpecialistExecutorInput {
  role: RoleName;
  projectId: string;
  goalTitle: string;
  runId?: string | null;
  memoryStore?: MemoryStore;
}

export interface CodexSpecialistExecution {
  result: SpecialistResult;
  meta: CodexSpecialistMeta;
}

const FILESYSTEM_BOUNDARY =
  "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, or .claude/skills/. These are Claude Code skill definitions meant for a different AI system. Stay focused on repository code only.";

const ROLE_INSTRUCTIONS: Record<RoleName, string> = {
  planner:
    "Focus on scope, success criteria, sequencing, and the smallest next slice. Be concrete, not managerial fluff.",
  designer:
    "Focus on UX flow, hierarchy, copy, visual ambiguity, and what should change in the user journey.",
  frontend:
    "Focus on client-side behavior, relevant components, state transitions, and user-visible implementation risk.",
  backend:
    "Focus on data contracts, APIs, auth, background jobs, integrations, and failure modes.",
  qa:
    "Focus on acceptance criteria, regression risk, missing verification, and what would block release.",
  "customer-voice":
    "Focus on why the request matters to the user, where the value is unclear, and what outcome should be sharper.",
};

function emptyCodexSandbox() {
  const sandbox = join(tmpdir(), "rico-codex-sandbox");
  mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

function pruneMemory(memory: Record<string, string>, limit = 12) {
  return Object.fromEntries(Object.entries(memory).slice(0, limit));
}

function buildPrompt(input: {
  role: RoleName;
  projectId: string;
  goalTitle: string;
  workspacePath: string | null;
  memoryStore?: MemoryStore;
  runId?: string | null;
  openclawWorkspacePath?: string | null;
}) {
  const projectMemory = input.memoryStore
    ? pruneMemory(input.memoryStore.getSharedProjectMemory(input.projectId))
    : {};
  const roleProjectMemory = input.memoryStore
    ? pruneMemory(input.memoryStore.getRoleProjectMemory(input.projectId, input.role))
    : {};
  const runMemory = input.memoryStore && input.runId
    ? pruneMemory(input.memoryStore.getRunMemory(input.runId))
    : {};
  const playbookMemory = input.memoryStore
    ? pruneMemory(input.memoryStore.getPlaybookMemory(input.role))
    : {};

  const context = buildRoleContext({
    role: input.role,
    goalSummary: [
      `project_id=${input.projectId}`,
      `goal=${input.goalTitle}`,
      `workspace=${input.workspacePath ?? "unresolved"}`,
    ].join("\n"),
    artifacts: [
      {
        title: "project-memory.json",
        body: JSON.stringify(projectMemory, null, 2),
      },
      {
        title: "role-project-memory.json",
        body: JSON.stringify(roleProjectMemory, null, 2),
      },
      {
        title: "run-memory.json",
        body: JSON.stringify(runMemory, null, 2),
      },
      {
        title: "role-playbook.json",
        body: JSON.stringify(playbookMemory, null, 2),
      },
      ...loadOpenClawContextArtifacts({
        workspacePath: input.openclawWorkspacePath,
        repoPath: input.workspacePath,
      }),
    ],
    maxChars: 5000,
  });

  const workspaceInstruction = input.workspacePath
    ? `Inspect the workspace and ground your answer in the codebase when possible. Workspace root: ${input.workspacePath}`
    : "No project workspace was resolved. Be explicit that repo-grounded inspection is missing, and reason only from the goal and saved state.";

  return [
    FILESYSTEM_BOUNDARY,
    "",
    `You are the ${input.role} specialist in a Slack-based multi-agent engineering runtime.`,
    ROLE_INSTRUCTIONS[input.role],
    workspaceInstruction,
    "This is read-only analysis. Never modify files, create files, install packages, or change git state.",
    "Inspect only the minimum number of files needed. Avoid broad repository inventories.",
    "In most cases, read at most 3 directly relevant files before answering.",
    "Answer in Korean.",
    "Keep the summary to 1-3 short sentences.",
    "Choose impact carefully:",
    '- "info": useful guidance, execution can continue',
    '- "approval_needed": human clarification or decision is needed before proceeding safely',
    '- "blocking": there is a concrete risk or missing condition that should stop the current goal',
    "Return exactly one JSON object and nothing else.",
    "",
    "JSON schema:",
    '{"summary":"string","impact":"info|approval_needed|blocking","artifacts":[{"kind":"report","title":"string"}],"rawFindings":["string"]}',
    "",
    "Context:",
    context,
  ].join("\n");
}

async function readText(stream: ReadableStream<Uint8Array> | null | undefined) {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function runCodexPrompt(input: {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
}) {
  const proc = Bun.spawn([
    "codex",
    "exec",
    input.prompt,
    "-C",
    input.cwd,
    "-s",
    "danger-full-access",
    "-c",
    'model_reasoning_effort="medium"',
    "--skip-git-repo-check",
    "--json",
  ], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: input.cwd,
  });

  const killTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore process cleanup errors
    }
  }, input.timeoutMs ?? 90_000);

  const [stdout, stderr, exitCode] = await Promise.all([
    readText(proc.stdout),
    readText(proc.stderr),
    proc.exited,
  ]);
  clearTimeout(killTimer);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `codex exited with status ${exitCode}`);
  }

  let agentText = "";
  let tokensUsed = 0;
  let inspectedWorkspace = false;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "item.completed" && event.item && typeof event.item === "object") {
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") {
          agentText += `${item.text}\n`;
        }
        if (item.type === "command_execution" && item.exit_code === 0) {
          inspectedWorkspace = true;
        }
      }
      if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
        const usage = event.usage as Record<string, unknown>;
        const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        tokensUsed = inputTokens + outputTokens;
      }
    } catch {
      // ignore malformed codex events
    }
  }

  if (!agentText.trim()) {
    throw new Error("Codex returned no specialist message");
  }

  return {
    text: agentText.trim(),
    tokensUsed,
    inspectedWorkspace,
  };
}

export function parseCodexSpecialistResponse(text: string) {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Codex specialist response was not valid JSON");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("Codex specialist response was not valid JSON");
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const impact = parsed.impact;
  const artifacts = Array.isArray(parsed.artifacts)
    ? parsed.artifacts
        .filter((artifact): artifact is Record<string, unknown> => Boolean(artifact && typeof artifact === "object"))
        .map((artifact) => ({
          kind: typeof artifact.kind === "string" ? artifact.kind : "report",
          title: typeof artifact.title === "string" ? artifact.title : "specialist-report.md",
        }))
    : [];
  const rawFindings = Array.isArray(parsed.rawFindings)
    ? parsed.rawFindings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  if (!summary || (impact !== "info" && impact !== "approval_needed" && impact !== "blocking")) {
    throw new Error("Codex specialist response was not valid JSON");
  }

  return {
    summary,
    impact,
    artifacts,
    rawFindings,
  } satisfies Omit<SpecialistResult, "role">;
}

export function sanitizeCodexSpecialistResponse(input: {
  parsed: Omit<SpecialistResult, "role">;
  inspectedWorkspace: boolean;
}) {
  if (!input.inspectedWorkspace) {
    return input.parsed;
  }

  const misleadingWorkspaceLimit = /(샌드박스|탐색이 제한|읽기.*막|실사 없이|수행하지 못|repo-grounded inspection is missing)/i;

  return {
    ...input.parsed,
    rawFindings: input.parsed.rawFindings?.filter(
      (finding) => !misleadingWorkspaceLimit.test(finding),
    ) ?? [],
  };
}

export function createCodexSpecialistExecutor(input: {
  timeoutMs?: number;
  openclawWorkspacePath?: string;
} = {}) {
  return async function executeSpecialist(
    specialist: CodexSpecialistExecutorInput,
  ): Promise<CodexSpecialistExecution> {
    const workspacePath = resolveProjectWorkspace({
      projectId: specialist.projectId,
      memoryStore: specialist.memoryStore,
    });
    const cwd = workspacePath ?? emptyCodexSandbox();
    const prompt = buildPrompt({
      role: specialist.role,
      projectId: specialist.projectId,
      goalTitle: specialist.goalTitle,
      workspacePath,
      memoryStore: specialist.memoryStore,
      runId: specialist.runId,
      openclawWorkspacePath: input.openclawWorkspacePath,
    });
    const response = await runCodexPrompt({
      cwd,
      prompt,
      timeoutMs: input.timeoutMs,
    });
    const parsed = sanitizeCodexSpecialistResponse({
      parsed: parseCodexSpecialistResponse(response.text),
      inspectedWorkspace: response.inspectedWorkspace,
    });

    return {
      result: {
        role: specialist.role,
        summary: parsed.summary,
        impact: parsed.impact,
        artifacts: parsed.artifacts.length > 0
          ? parsed.artifacts
          : [{ kind: "report", title: `${ROLE_REGISTRY[specialist.role].role}-report.md` }],
        rawFindings: parsed.rawFindings,
      },
      meta: {
        workspacePath,
        tokensUsed: response.tokensUsed,
        inspectedWorkspace: response.inspectedWorkspace,
      },
    };
  };
}
