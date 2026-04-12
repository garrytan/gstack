import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoleContext } from "../memory/context-loader";
import { loadOpenClawContextArtifacts } from "../memory/openclaw-context";
import { MemoryStore } from "../memory/store";
import { resolveProjectWorkspace } from "../orchestrator/project-workspace";
import {
  buildFallbackCaptainPlan,
  normalizeCaptainPlanForGoal,
  type CaptainPlan,
  type CaptainPlanStatus,
} from "../orchestrator/captain-plan";
import { ROLE_REGISTRY, type RoleName } from "../roles";

interface CaptainExecutorInput {
  projectId: string;
  goalTitle: string;
  runId?: string | null;
  memoryStore?: MemoryStore;
}

const FILESYSTEM_BOUNDARY =
  "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, or .claude/skills/. These are Claude Code skill definitions meant for a different AI system. Stay focused on repository code only.";

function emptyCodexSandbox() {
  const sandbox = join(tmpdir(), "rico-captain-sandbox");
  mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

function pruneMemory(memory: Record<string, string>, limit = 12) {
  return Object.fromEntries(Object.entries(memory).slice(0, limit));
}

function buildCaptainPrompt(input: {
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
  const runMemory = input.memoryStore && input.runId
    ? pruneMemory(input.memoryStore.getRunMemory(input.runId))
    : {};
  const rolePlaybooks = Object.fromEntries(
    (Object.keys(ROLE_REGISTRY) as RoleName[]).map((role) => [
      role,
      input.memoryStore ? pruneMemory(input.memoryStore.getPlaybookMemory(role), 8) : {},
    ]),
  );

  const context = buildRoleContext({
    role: "captain",
    goalSummary: [
      `project_id=${input.projectId}`,
      `goal=${input.goalTitle}`,
      `workspace=${input.workspacePath ?? "unresolved"}`,
    ].join("\n"),
    artifacts: [
      { title: "project-memory.json", body: JSON.stringify(projectMemory, null, 2) },
      { title: "run-memory.json", body: JSON.stringify(runMemory, null, 2) },
      { title: "role-playbooks.json", body: JSON.stringify(rolePlaybooks, null, 2) },
      ...loadOpenClawContextArtifacts({
        workspacePath: input.openclawWorkspacePath,
        repoPath: input.workspacePath,
      }),
    ],
    maxChars: 6000,
  });

  const workspaceInstruction = input.workspacePath
    ? `Inspect the workspace and choose only the roles that are actually useful. Workspace root: ${input.workspacePath}`
    : "No workspace was resolved. Be conservative, and only choose roles you can justify from the goal itself.";

  return [
    FILESYSTEM_BOUNDARY,
    "",
    "You are the Project Captain in a Slack-based multi-agent engineering runtime.",
    "Your job is to decide which specialists should speak in this round, what the next action is, and whether the goal is blocked or needs a human decision.",
    workspaceInstruction,
    "This is read-only analysis. Never modify files, create files, install packages, or change git state.",
    "Inspect only the minimum number of files needed. In most cases, read at most 3 directly relevant files before answering.",
    "Do not select every role by default. Select the smallest useful set.",
    "Return exactly one JSON object and nothing else.",
    "Answer in Korean.",
    "",
    "Allowed role names: planner, designer, frontend, backend, qa, customer-voice",
    "status must be one of: active, needs_decision, blocked",
    "taskGraph should contain 1-4 items max. Each item must include id, role, title, dependsOn.",
    "",
    "JSON schema:",
    '{"selectedRoles":["planner"],"nextAction":"string","blockedReason":null,"status":"active|needs_decision|blocked","taskGraph":[{"id":"task-1","role":"planner","title":"string","dependsOn":[]}]}',
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
      // ignore cleanup errors
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
      }
    } catch {
      // ignore malformed codex events
    }
  }

  if (!agentText.trim()) {
    throw new Error("Codex returned no captain message");
  }

  return agentText.trim();
}

function normalizeCaptainStatus(value: unknown): CaptainPlanStatus {
  if (value === "active" || value === "needs_decision" || value === "blocked") {
    return value;
  }
  throw new Error("Codex captain response was not valid JSON");
}

function isRoleName(value: unknown): value is RoleName {
  return typeof value === "string" && value in ROLE_REGISTRY;
}

export function parseCodexCaptainPlanResponse(text: string): CaptainPlan {
  const trimmed = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Codex captain response was not valid JSON");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("Codex captain response was not valid JSON");
  }

  const selectedRoles = Array.isArray(parsed.selectedRoles)
    ? parsed.selectedRoles.filter(isRoleName)
    : [];
  if (
    !Array.isArray(parsed.selectedRoles)
    || selectedRoles.length !== parsed.selectedRoles.length
    || typeof parsed.nextAction !== "string"
    || parsed.nextAction.trim().length === 0
  ) {
    throw new Error("Codex captain response was not valid JSON");
  }

  const taskGraph = Array.isArray(parsed.taskGraph)
    ? parsed.taskGraph.map((task) => {
        if (!task || typeof task !== "object") {
          throw new Error("Codex captain response was not valid JSON");
        }
        const record = task as Record<string, unknown>;
        if (
          typeof record.id !== "string"
          || !isRoleName(record.role)
          || typeof record.title !== "string"
          || !Array.isArray(record.dependsOn)
          || record.dependsOn.some((dependency) => typeof dependency !== "string")
        ) {
          throw new Error("Codex captain response was not valid JSON");
        }
        return {
          id: record.id,
          role: record.role,
          title: record.title,
          dependsOn: record.dependsOn as string[],
        };
      })
    : [];

  return {
    selectedRoles,
    nextAction: parsed.nextAction.trim(),
    blockedReason:
      parsed.blockedReason == null
        ? null
        : typeof parsed.blockedReason === "string"
          ? parsed.blockedReason
          : (() => {
              throw new Error("Codex captain response was not valid JSON");
            })(),
    status: normalizeCaptainStatus(parsed.status),
    taskGraph,
  };
}

export function createCodexCaptainExecutor(input: {
  timeoutMs?: number;
  openclawWorkspacePath?: string;
} = {}) {
  return async function executeCaptainPlan(
    captainInput: CaptainExecutorInput,
  ): Promise<CaptainPlan> {
    const workspacePath = resolveProjectWorkspace({
      projectId: captainInput.projectId,
      memoryStore: captainInput.memoryStore,
    });
    const cwd = workspacePath ?? emptyCodexSandbox();
    const prompt = buildCaptainPrompt({
      projectId: captainInput.projectId,
      goalTitle: captainInput.goalTitle,
      workspacePath,
      memoryStore: captainInput.memoryStore,
      runId: captainInput.runId,
      openclawWorkspacePath: input.openclawWorkspacePath,
    });
    try {
      const text = await runCodexPrompt({
        cwd,
        prompt,
        timeoutMs: input.timeoutMs,
      });
      const parsed = parseCodexCaptainPlanResponse(text);
      if (parsed.selectedRoles.length === 0) {
        return normalizeCaptainPlanForGoal(
          captainInput.goalTitle,
          buildFallbackCaptainPlan(captainInput.goalTitle),
        );
      }
      return normalizeCaptainPlanForGoal(captainInput.goalTitle, parsed);
    } catch {
      return normalizeCaptainPlanForGoal(
        captainInput.goalTitle,
        buildFallbackCaptainPlan(captainInput.goalTitle),
      );
    }
  };
}
