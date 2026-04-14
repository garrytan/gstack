import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoleContext } from "../memory/context-loader";
import { loadOpenClawContextArtifacts } from "../memory/openclaw-context";
import { MemoryStore } from "../memory/store";
import type {
  CustomerVoiceDelegationDecision,
  CustomerVoicePersona,
} from "../orchestrator/customer-voice-director";
import { readProjectCustomerVoiceProfile } from "../orchestrator/customer-voice-director";
import { resolveProjectWorkspace } from "../orchestrator/project-workspace";
import type { SpecialistExecutionMode, SpecialistResult } from "../roles/contracts";
import { ROLE_REGISTRY, type RoleName } from "../roles";
import {
  runBrowserSimulation,
  summarizeBrowserSimulation,
} from "../simulation/browser";

export interface CodexSpecialistMeta {
  workspacePath: string | null;
  tokensUsed: number;
  inspectedWorkspace: boolean;
  executedCommands: string[];
}

export interface CodexSpecialistExecutorInput {
  role: RoleName;
  projectId: string;
  goalTitle: string;
  runId?: string | null;
  memoryStore?: MemoryStore;
  personaLabel?: string;
  customerVoiceDecision?: CustomerVoiceDelegationDecision;
  customerVoicePersona?: CustomerVoicePersona;
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

const BACKEND_ANALYZE_KEYWORDS = [
  "원격",
  "git",
  "repo",
  "repository",
  "저장소",
  "레포",
  "브랜치",
  "branch",
  "상태",
  "확인",
  "점검",
  "분석",
  "로그",
  "log",
];

const BACKEND_WRITE_KEYWORDS = [
  "구현",
  "수정",
  "고쳐",
  "고치",
  "추가",
  "만들",
  "작성",
  "반영",
  "연결해줘",
  "이어줘",
  "붙여",
  "보완",
  "엔드포인트",
  "endpoint",
  "계약",
  "리팩토링",
  "패치",
  "fix",
  "patch",
  "refactor",
  "rename",
  "schema",
  "migration",
];

const FRONTEND_ANALYZE_KEYWORDS = [
  "분석",
  "점검",
  "검토",
  "문제",
  "흐름",
  "구조",
  "왜",
  "원인",
  "상태",
  "리뷰",
];

const FRONTEND_WRITE_KEYWORDS = [
  "구현",
  "수정",
  "고쳐",
  "고치",
  "손봐",
  "다듬",
  "바꿔",
  "변경",
  "추가",
  "만들",
  "작성",
  "반영",
  "붙여",
  "이어줘",
  "연결해줘",
  "연결",
  "네비게이션",
  "navigation",
  "링크",
  "link",
  "라우트",
  "route",
  "cta",
  "카피",
  "문구",
  "헤드라인",
  "랜딩",
  "버튼",
  "컴포넌트",
  "ui",
  "ux",
  "스타일",
  "레이아웃",
];

const QA_WRITE_KEYWORDS = [
  "qa",
  "검증",
  "테스트",
  "회귀",
  "리그레션",
  "증거",
  "결과",
  "로그",
  "변경 파일",
  "남겨줘",
  "정리해줘",
  "검수",
];

const PLANNER_WRITE_KEYWORDS = [
  "기획",
  "계획",
  "플랜",
  "초안",
  "정리",
  "문서",
  "브리프",
  "로드맵",
  "spec",
  "prd",
];

const DESIGNER_WRITE_KEYWORDS = [
  "디자인",
  "ux writing",
  "ux-writing",
  "카피",
  "문구",
  "메시지",
  "와이어",
  "wire",
  "흐름도",
  "문서",
];

const CUSTOMER_VOICE_WRITE_KEYWORDS = [
  "고객 관점",
  "customer voice",
  "customer-voice",
  "페르소나",
  "persona",
  "jtbd",
  "objection",
  "가치 제안",
  "value proposition",
  "메시지 맵",
  "시뮬레이션",
  "simulation",
  "체험",
  "dogfood",
  "evidence",
  "증적",
  "증거",
  "정리해줘",
  "문서",
];

const HANGUL_PATTERN = /[가-힣]/;
const QA_ROUTE_BLOCK_PATTERN =
  /(not a registered route|broken link|등록된\s*라우트가\s*아니|라우트가\s*없|깨진\s*링크)/i;

function emptyCodexSandbox() {
  const sandbox = join(tmpdir(), "rico-codex-sandbox");
  mkdirSync(sandbox, { recursive: true });
  return sandbox;
}

function pruneMemory(memory: Record<string, string>, limit = 12) {
  return Object.fromEntries(Object.entries(memory).slice(0, limit));
}

function parseJsonStringArray(value: string | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

const GATED_CAPABILITIES = new Set([
  "browser-check",
  "verification-log",
  "schema-migration",
  "deploy",
  "external-message",
  "data-delete",
  "production-write",
  "destructive-write",
]);

function includesAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function containsHangul(text: string) {
  return HANGUL_PATTERN.test(text);
}

export function determineSpecialistExecutionMode(input: {
  role: RoleName;
  goalTitle: string;
}): SpecialistExecutionMode {
  const normalized = input.goalTitle.trim().toLowerCase();
  if (!normalized) return "analyze";
  if (input.role === "planner") {
    if (includesAny(normalized, PLANNER_WRITE_KEYWORDS)) return "write";
    return "analyze";
  }
  if (input.role === "designer") {
    if (includesAny(normalized, DESIGNER_WRITE_KEYWORDS)) return "write";
    return "analyze";
  }
  if (input.role === "backend") {
    if (includesAny(normalized, BACKEND_WRITE_KEYWORDS)) return "write";
    if (includesAny(normalized, BACKEND_ANALYZE_KEYWORDS)) return "analyze";
    return "analyze";
  }
  if (input.role === "frontend") {
    if (includesAny(normalized, FRONTEND_WRITE_KEYWORDS)) return "write";
    if (includesAny(normalized, FRONTEND_ANALYZE_KEYWORDS)) return "analyze";
    return "analyze";
  }
  if (input.role === "qa") {
    if (includesAny(normalized, QA_WRITE_KEYWORDS)) return "write";
    return "analyze";
  }
  if (input.role === "customer-voice") {
    if (includesAny(normalized, CUSTOMER_VOICE_WRITE_KEYWORDS)) return "write";
    return "analyze";
  }
  return "analyze";
}

function buildJsonSchema(executionMode: SpecialistExecutionMode) {
  if (executionMode === "write") {
    return '{"summary":"string","impact":"info|approval_needed|blocking","artifacts":[{"kind":"report","title":"string"}],"rawFindings":["string"],"executionMode":"write","changedFiles":["path/from/repo/root"],"verificationNotes":["string"],"personaLabel":"string(optional)"}';
  }
  return '{"summary":"string","impact":"info|approval_needed|blocking","artifacts":[{"kind":"report","title":"string"}],"rawFindings":["string"],"executionMode":"analyze","personaLabel":"string(optional)"}';
}

function buildExecutionInstruction(input: {
  role: RoleName;
  executionMode: SpecialistExecutionMode;
}) {
  if (input.executionMode !== "write") {
    return "This is read-only analysis. Never modify files, create files, install packages, or change git state.";
  }

  if (input.role === "frontend") {
    return [
      "This is write-mode execution for the frontend specialist.",
      "Make the smallest UI-facing code change that satisfies the goal.",
      "You may edit files inside the resolved workspace root, run focused verification, and inspect git status.",
      "Prefer component, route, style, or copy changes over backend or schema changes.",
      "Do not modify server-side data contracts, do not deploy, do not send external messages, do not delete data, and do not rewrite unrelated code.",
      "If the goal is ambiguous or unsafe to execute, do not write code; return approval_needed or blocking with a concrete reason.",
    ].join(" ");
  }

  if (input.role === "planner") {
    return [
      "This is write-mode execution for the planner specialist.",
      "Produce or update a narrowly scoped planning artifact inside the workspace, preferably under docs/, planning/, or a small repo-local notes path that already fits the codebase.",
      "Write only the minimum markdown or text document needed to unblock implementation.",
      "Do not rewrite product code, do not deploy, do not send external messages, and do not create broad project documentation unrelated to the goal.",
    ].join(" ");
  }

  if (input.role === "designer") {
    return [
      "This is write-mode execution for the designer specialist.",
      "Produce or update a narrowly scoped UX or copy artifact inside the workspace when the goal explicitly calls for design or writing documentation.",
      "Prefer markdown notes, copy proposals, IA notes, or content diffs over product code changes.",
      "Do not deploy, do not send external messages, and do not rewrite unrelated code or broad documentation.",
    ].join(" ");
  }

  if (input.role === "qa") {
    return [
      "This is write-mode execution for the QA specialist.",
      "Run focused verification, inspect changed files, and leave a concrete verification trail.",
      "You may create or update narrowly scoped test or QA evidence files inside the workspace when helpful.",
      "Prefer verification commands, regression tests, or QA notes over product code changes.",
      "Do not call a navigation target broken until you verify the route declaration actually exists or does not exist in the router code.",
      "If a route exists, treat mismatched labeling or destination choice as a follow-up issue, not an automatic release blocker.",
      "Do not deploy, do not send external messages, do not delete data, and do not rewrite unrelated code.",
      "If verification cannot be completed, return blocking with the missing condition and the exact failed command or gap.",
    ].join(" ");
  }

  if (input.role === "customer-voice") {
    return [
      "This is write-mode execution for the customer-voice specialist.",
      "You may create or update narrowly scoped persona, JTBD, objection, or simulation-evidence artifacts inside the workspace.",
      "Prefer markdown, json, txt, or QA evidence artifacts over product code changes.",
      "Do not modify application code, backend contracts, schema, or deploy state.",
      "If the goal needs product changes, raise the recommendation through summary and artifacts instead of editing code directly.",
    ].join(" ");
  }

  return [
    "This is write-mode execution for the backend specialist.",
    "Make the smallest backend-only code change that satisfies the goal.",
    "You may edit files inside the resolved workspace root, run focused verification, and inspect git status.",
    "Do not modify files outside the workspace root, do not deploy, do not send external messages, do not delete data, and do not rewrite unrelated code.",
    "If the goal is ambiguous or unsafe to execute, do not write code; return approval_needed or blocking with a concrete reason.",
  ].join(" ");
}

function buildRoleOutputContract(role: RoleName) {
  if (role === "planner") {
    return "Output contract: include the narrowed goal, success criteria, and the smallest next slice that should actually be executed.";
  }
  if (role === "designer") {
    return "Output contract: include UX judgment, what copy or journey should change, and what user confusion it resolves.";
  }
  if (role === "frontend") {
    return "Output contract: include the concrete UI change, affected files or surfaces, and how it was verified.";
  }
  if (role === "backend") {
    return "Output contract: include the concrete contract or endpoint change, affected files, and the verification trail.";
  }
  if (role === "qa") {
    return "Output contract: include release judgment, exact verification evidence, and the concrete reason if it blocks or needs approval.";
  }
  return "Output contract: include the user-facing value signal, what is unclear, and what would make the request or experience more convincing.";
}

function buildPlaybookInstructions(role: RoleName, playbookMemory: Record<string, string>) {
  const checklist = parseJsonStringArray(playbookMemory.checklist_json);
  const skillPack = parseJsonStringArray(playbookMemory.skill_pack_json);
  const allowedTools = parseJsonStringArray(playbookMemory.allowed_tools_json);
  const disallowedTools = parseJsonStringArray(playbookMemory.disallowed_tools_json);
  const lines = [buildRoleOutputContract(role)];

  if (playbookMemory.charter) {
    lines.push(`Charter: ${playbookMemory.charter}`);
  }
  if (checklist.length > 0) {
    lines.push(`Checklist: ${checklist.join(" / ")}`);
  }
  if (skillPack.length > 0) {
    lines.push(`Preferred skills: ${skillPack.join(", ")}`);
  }
  if (allowedTools.length > 0) {
    lines.push(`Allowed capabilities: ${allowedTools.join(", ")}`);
  }
  if (disallowedTools.length > 0) {
    lines.push(`Disallowed actions: ${disallowedTools.join(", ")}`);
  }

  return lines.join("\n");
}

function defaultArtifactTitle(role: RoleName, playbookMemory: Record<string, string>) {
  const template = playbookMemory.artifact_template?.trim();
  if (template) return template;
  return `${ROLE_REGISTRY[role].role}-report.md`;
}

function ensureArtifactTemplate(input: {
  role: RoleName;
  playbookMemory: Record<string, string>;
  artifacts: Array<{ kind: string; title: string }>;
}) {
  const artifactTitle = defaultArtifactTitle(input.role, input.playbookMemory);
  if (input.artifacts.length === 0) {
    return [{ kind: "report", title: artifactTitle }];
  }

  const next = input.artifacts.map((artifact) => ({ ...artifact }));
  if (next.some((artifact) => artifact.title === artifactTitle)) {
    return next;
  }

  const genericReportIndex = next.findIndex(
    (artifact) => artifact.kind === "report" && /-report\.md$/i.test(artifact.title),
  );
  if (genericReportIndex >= 0) {
    next[genericReportIndex] = {
      ...next[genericReportIndex]!,
      title: artifactTitle,
    };
    return next;
  }

  return [{ kind: "report", title: artifactTitle }, ...next];
}

export function finalizeSpecialistResultForRuntime(input: {
  role: RoleName;
  playbookMemory: Record<string, string>;
  parsed: Omit<SpecialistResult, "role">;
}) {
  const artifacts = ensureArtifactTemplate({
    role: input.role,
    playbookMemory: input.playbookMemory,
    artifacts: input.parsed.artifacts,
  });
  const changedFiles = input.parsed.changedFiles ?? [];
  const rawFindings = [...(input.parsed.rawFindings ?? [])];

  if (
    input.parsed.executionMode === "write"
    && changedFiles.length === 0
    && !rawFindings.some((finding) => /artifact-only write/i.test(finding))
  ) {
    rawFindings.push("artifact-only write: no repo files were changed");
  }

  return {
    ...input.parsed,
    artifacts,
    rawFindings,
  };
}

function buildCustomerVoiceDirective(input: {
  decision?: CustomerVoiceDelegationDecision;
  persona?: CustomerVoicePersona;
}) {
  if (!input.decision) return null;

  return {
    mode: input.decision.mode,
    needsSetup: input.decision.needsSetup,
    reason: input.decision.reason,
    selectedPersonas: input.decision.selectedPersonas,
    activePersona: input.persona ?? null,
    simulation: input.decision.simulation,
  };
}

async function collectDynamicArtifacts(input: {
  role: RoleName;
  projectId: string;
  memoryStore?: MemoryStore;
  customerVoiceDecision?: CustomerVoiceDelegationDecision;
}) {
  if (!input.memoryStore) return [];
  if (input.role !== "qa" && input.role !== "customer-voice") return [];

  const profile = readProjectCustomerVoiceProfile({
    memoryStore: input.memoryStore,
    projectId: input.projectId,
  });
  const simulation = input.customerVoiceDecision?.simulation ?? profile.simulation;
  const evidence = await runBrowserSimulation({
    projectId: input.projectId,
    enabled: simulation.enabled,
    baseUrl: simulation.baseUrl,
    allowedJourneys: simulation.allowedJourneys,
    requiresCredentials: simulation.requiresCredentials,
    credentialRefs: simulation.credentialRefs,
  });

  input.memoryStore.putRoleProjectFact(
    input.projectId,
    input.role,
    "last_browser_simulation_json",
    JSON.stringify(evidence),
  );

  return [
    {
      title: "browser-simulation.json",
      body: JSON.stringify(evidence, null, 2),
    },
    {
      title: "browser-simulation-summary.txt",
      body: summarizeBrowserSimulation(evidence).join("\n"),
    },
  ];
}

function buildPrompt(input: {
  role: RoleName;
  projectId: string;
  goalTitle: string;
  workspacePath: string | null;
  executionMode: SpecialistExecutionMode;
  memoryStore?: MemoryStore;
  runId?: string | null;
  openclawWorkspacePath?: string | null;
  personaLabel?: string;
  customerVoiceDecision?: CustomerVoiceDelegationDecision;
  customerVoicePersona?: CustomerVoicePersona;
  extraArtifacts?: Array<{ title: string; body: string }>;
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
  const customerVoiceDirective = buildCustomerVoiceDirective({
    decision: input.customerVoiceDecision,
    persona: input.customerVoicePersona,
  });

  const context = buildRoleContext({
    role: input.role,
    goalSummary: [
      `project_id=${input.projectId}`,
      `goal=${input.goalTitle}`,
      `workspace=${input.workspacePath ?? "unresolved"}`,
      input.personaLabel ? `persona=${input.personaLabel}` : "",
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
      ...(customerVoiceDirective
        ? [{
            title: "customer-voice-directive.json",
            body: JSON.stringify(customerVoiceDirective, null, 2),
          }]
        : []),
      ...(input.extraArtifacts ?? []),
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
  const executionInstruction = buildExecutionInstruction({
    role: input.role,
    executionMode: input.executionMode,
  });
  const playbookInstructions = buildPlaybookInstructions(input.role, playbookMemory);

  return [
    FILESYSTEM_BOUNDARY,
    "",
    `You are the ${input.role} specialist in a Slack-based multi-agent engineering runtime.`,
    ROLE_INSTRUCTIONS[input.role],
    workspaceInstruction,
    executionInstruction,
    playbookInstructions,
    input.personaLabel ? `Active persona label: ${input.personaLabel}` : "",
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
    buildJsonSchema(input.executionMode),
    "",
    "Context:",
    context,
  ].join("\n");
}

export function buildSpecialistPromptForTest(input: Parameters<typeof buildPrompt>[0]) {
  return buildPrompt(input);
}

function parseGitStatusPath(line: string) {
  const candidate = line.slice(3).trim();
  if (!candidate) return null;
  if (candidate.includes(" -> ")) {
    return candidate.split(" -> ").at(-1)?.trim() ?? null;
  }
  return candidate;
}

async function listGitChangedFiles(cwd: string) {
  const proc = Bun.spawn(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    readText(proc.stdout),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return null;
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseGitStatusPath)
    .filter((path): path is string => Boolean(path));
}

function mergeChangedFiles(...groups: Array<string[] | undefined>) {
  return [...new Set(groups.flatMap((group) => group ?? []).filter(Boolean))];
}

function normalizePathForScopeChecks(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function isArtifactScopedPath(path: string) {
  const normalized = normalizePathForScopeChecks(path).toLowerCase();
  return (
    /\.(md|txt|json)$/i.test(normalized)
    || /(^|\/)(docs|planning|plans|specs|qa|artifacts|reviews|notes|evidence)(\/|$)/.test(normalized)
    || /(^|\/)(__snapshots__|test-results|playwright-report)(\/|$)/.test(normalized)
  );
}

function isFrontendScopedPath(path: string) {
  const normalized = normalizePathForScopeChecks(path).toLowerCase();
  return (
    isArtifactScopedPath(normalized)
    || /(^|\/)(src\/app|src\/components|src\/pages|src\/routes|src\/features|app\/|components\/|pages\/|routes\/)/.test(normalized)
    || /\.(tsx|jsx|css|scss|sass|less)$/.test(normalized)
  );
}

function isBackendScopedPath(path: string) {
  const normalized = normalizePathForScopeChecks(path).toLowerCase();
  return (
    isArtifactScopedPath(normalized)
    || /(^|\/)(src\/api|src\/server|src\/services|src\/repositories|src\/lib\/server|supabase\/functions|api\/|server\/|backend\/|db\/|migrations\/)/.test(normalized)
    || /\.(sql|prisma)$/.test(normalized)
  );
}

function isQaScopedPath(path: string) {
  const normalized = normalizePathForScopeChecks(path).toLowerCase();
  return (
    isArtifactScopedPath(normalized)
    || /(^|\/)(test|tests|__tests__|e2e|playwright|cypress|qa)(\/|$)/.test(normalized)
  );
}

function writeScopeViolationSummary(role: RoleName) {
  if (role === "planner") {
    return "기획 역할에서 문서 범위를 벗어난 코드 수정이 감지돼 이번 라운드는 brief/spec artifact 범위로 다시 제한해야 해요.";
  }
  if (role === "designer") {
    return "디자인 역할에서 UX/copy 범위를 벗어난 서버 측 수정이 감지돼 이번 라운드는 UX artifact 또는 프론트 카피 범위로 다시 제한해야 해요.";
  }
  if (role === "frontend") {
    return "프론트엔드 역할에서 서버 측 파일 변경이 감지돼 이번 라운드는 UI/route/component 범위로 다시 제한해야 해요.";
  }
  if (role === "backend") {
    return "백엔드 역할에서 화면 중심 파일 변경이 감지돼 이번 라운드는 API/contract/server 범위로 다시 제한해야 해요.";
  }
  if (role === "qa") {
    return "QA 역할에서 검증 범위를 벗어난 제품 코드 수정이 감지돼 이번 라운드는 evidence/test 범위로 다시 제한해야 해요.";
  }
  return "고객 관점 역할에서 artifact 범위를 벗어난 제품 코드 수정이 감지돼 이번 라운드는 persona/simulation evidence 범위로 다시 제한해야 해요.";
}

function findWriteScopeViolations(role: RoleName, changedFiles: string[]) {
  const unique = [...new Set(changedFiles.map((path) => normalizePathForScopeChecks(path)).filter(Boolean))];
  if (unique.length === 0) return [];

  if (role === "planner" || role === "customer-voice") {
    return unique.filter((path) => !isArtifactScopedPath(path));
  }
  if (role === "designer") {
    return unique.filter((path) => !isFrontendScopedPath(path));
  }
  if (role === "frontend") {
    return unique.filter((path) => !isFrontendScopedPath(path));
  }
  if (role === "backend") {
    return unique.filter((path) => !isBackendScopedPath(path));
  }
  if (role === "qa") {
    return unique.filter((path) => !isQaScopedPath(path));
  }
  return [];
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
  const executedCommands: string[] = [];

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
        if (item.type === "command_execution") {
          const command = extractCommandText(item);
          if (command) {
            executedCommands.push(command);
          }
          if (item.exit_code === 0) {
            inspectedWorkspace = true;
          }
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
    executedCommands,
  };
}

function extractCommandText(item: Record<string, unknown>) {
  const directCandidates = [
    item.command,
    item.command_line,
    item.cmd,
    item.commandLine,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const objectCandidates = [item.command, item.command_input, item.payload];
  for (const candidate of objectCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const nestedStrings = [
      record.command,
      record.command_line,
      record.cmd,
      record.raw,
    ];
    for (const nested of nestedStrings) {
      if (typeof nested === "string" && nested.trim().length > 0) {
        return nested.trim();
      }
    }
    if (Array.isArray(record.argv)) {
      const argv = record.argv.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (argv.length > 0) {
        return argv.join(" ");
      }
    }
  }

  if (Array.isArray(item.argv)) {
    const argv = item.argv.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (argv.length > 0) {
      return argv.join(" ");
    }
  }

  return null;
}

function classifyCommandCapabilities(command: string) {
  const normalized = command.trim().toLowerCase();
  const capabilities = new Set<string>();

  if (/(^|\s)(git\s+(status|diff|show|log)|rg\b|grep\b|sed\s+-n|cat\b|ls\b|find\b)/.test(normalized)) {
    capabilities.add("repo-read");
  }
  if (/(playwright|chromium|browser)/.test(normalized)) {
    capabilities.add("browser-check");
  }
  if (/(^|\s)((bun|npm|pnpm|yarn)\s+(test|run test)|vitest\b|jest\b|pytest\b|playwright\s+test|cypress\b)/.test(normalized)) {
    capabilities.add("verification-log");
  }
  if (/(vercel\s+deploy|flyctl\s+deploy|kubectl\s+(apply|rollout|set image)|netlify\s+deploy|render\s+deploy|railway\s+up|serverless\s+deploy)/.test(normalized)) {
    capabilities.add("deploy");
  }
  if (/(--prod\b|\bproduction\b|\bprod\b)/.test(normalized) && /(vercel|flyctl|kubectl|netlify|render|railway|serverless)/.test(normalized)) {
    capabilities.add("production-write");
  }
  if (/(rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|drop\s+table|truncate\s+table|delete\s+from|supabase\s+db\s+reset)/.test(normalized)) {
    capabilities.add("destructive-write");
  }
  if (/(drop\s+table|truncate\s+table|delete\s+from|supabase\s+db\s+reset)/.test(normalized)) {
    capabilities.add("data-delete");
  }
  if (/(prisma\s+migrate|drizzle-kit|alembic|knex\s+migrate|supabase\s+(migration|db\s+push)|db\s+push)/.test(normalized)) {
    capabilities.add("schema-migration");
  }
  if (/(hooks\.slack\.com|sendgrid|resend|mailgun|twilio)/.test(normalized)) {
    capabilities.add("external-message");
  }

  return [...capabilities];
}

function capabilityViolationSummary(role: RoleName) {
  if (role === "planner") {
    return "기획 역할에서 playbook이 금지한 실행이 감지돼 이번 라운드는 문서/범위 정리로만 제한해야 해요.";
  }
  if (role === "designer") {
    return "디자인 역할에서 playbook 범위를 벗어난 실행이 감지돼 이번 라운드는 UX/copy 검토와 artifact 작성으로만 제한해야 해요.";
  }
  if (role === "frontend") {
    return "프론트엔드 역할에서 playbook이 금지한 실행이 감지돼 이번 라운드는 UI 구현과 허용된 검증 범위로만 제한해야 해요.";
  }
  if (role === "backend") {
    return "백엔드 역할에서 playbook이 금지한 실행이 감지돼 이번 라운드는 서버 코드 수정과 허용된 검증 범위로만 제한해야 해요.";
  }
  if (role === "qa") {
    return "QA 역할에서 playbook이 금지한 실행이 감지돼 이번 라운드는 검증과 evidence 수집 범위로만 제한해야 해요.";
  }
  return "고객 관점 역할에서 playbook이 금지한 실행이 감지돼 이번 라운드는 persona/simulation evidence 범위로만 제한해야 해요.";
}

function findCapabilityViolations(input: {
  playbookMemory: Record<string, string>;
  executedCommands: string[];
}) {
  const allowed = new Set(parseJsonStringArray(input.playbookMemory.allowed_tools_json));
  const disallowed = new Set(parseJsonStringArray(input.playbookMemory.disallowed_tools_json));
  const capabilityToCommands = new Map<string, string[]>();

  for (const command of input.executedCommands) {
    for (const capability of classifyCommandCapabilities(command)) {
      capabilityToCommands.set(capability, [...(capabilityToCommands.get(capability) ?? []), command]);
    }
  }

  const capabilityViolations = [...capabilityToCommands.keys()].filter((capability) =>
    disallowed.has(capability)
    || (GATED_CAPABILITIES.has(capability) && !allowed.has(capability))
  );

  return capabilityViolations.map((capability) => ({
    capability,
    commands: capabilityToCommands.get(capability) ?? [],
  }));
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
  const executionMode = parsed.executionMode === "write" ? "write" : "analyze";
  const changedFiles = Array.isArray(parsed.changedFiles)
    ? parsed.changedFiles.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const verificationNotes = Array.isArray(parsed.verificationNotes)
    ? parsed.verificationNotes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const personaLabel = typeof parsed.personaLabel === "string" && parsed.personaLabel.trim().length > 0
    ? parsed.personaLabel.trim()
    : undefined;

  if (!summary || (impact !== "info" && impact !== "approval_needed" && impact !== "blocking")) {
    throw new Error("Codex specialist response was not valid JSON");
  }

  return {
    summary,
    impact,
    artifacts,
    rawFindings,
    executionMode,
    changedFiles,
    verificationNotes,
    personaLabel,
  } satisfies Omit<SpecialistResult, "role">;
}

export async function parseOrRepairCodexSpecialistResponse(input: {
  text: string;
  repair?: (text: string) => Promise<string>;
}) {
  try {
    return parseCodexSpecialistResponse(input.text);
  } catch (error) {
    if (!input.repair) {
      throw error;
    }
    const repaired = await input.repair(input.text);
    return parseCodexSpecialistResponse(repaired);
  }
}

function buildRepairPrompt(input: {
  role: RoleName;
  executionMode: SpecialistExecutionMode;
  text: string;
}) {
  return [
    "You convert a specialist response into strict JSON.",
    `Role: ${input.role}`,
    "Return exactly one JSON object and nothing else.",
    "Do not add markdown fences.",
    "Preserve only facts that are already present in the source response.",
    "If changed files or verification notes are missing, use empty arrays.",
    "Keep summary concise and grounded in the source response.",
    "",
    "JSON schema:",
    buildJsonSchema(input.executionMode),
    "",
    "Source response:",
    input.text,
  ].join("\n");
}

async function repairCodexSpecialistResponse(input: {
  role: RoleName;
  executionMode: SpecialistExecutionMode;
  text: string;
  timeoutMs?: number;
}) {
  const repaired = await runCodexPrompt({
    cwd: emptyCodexSandbox(),
    prompt: buildRepairPrompt(input),
    timeoutMs: Math.min(input.timeoutMs ?? 90_000, 30_000),
  });
  return repaired.text;
}

function listSourceFiles(root: string) {
  const files: string[] = [];
  const queue = [join(root, "src")];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      files.push(nextPath);
    }
  }
  return files;
}

function extractRouteMentions(text: string) {
  return [...text.matchAll(/[`'"]?(\/[A-Za-z0-9/_:-]*)[`'"]?/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function workspaceHasDeclaredRoute(workspacePath: string, route: string) {
  const routeMatchers = [
    `path="${route}"`,
    `path='${route}'`,
    `path: "${route}"`,
    `path: '${route}'`,
  ];
  for (const filePath of listSourceFiles(workspacePath)) {
    let text = "";
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (routeMatchers.some((candidate) => text.includes(candidate))) {
      return true;
    }
  }
  return false;
}

export async function normalizeSpecialistResult(input: {
  role: RoleName;
  executionMode: SpecialistExecutionMode;
  parsed: Omit<SpecialistResult, "role">;
  originalText: string;
  workspacePath: string | null;
  observedChangedFiles?: string[] | null;
  executedCommands?: string[];
  playbookMemory?: Record<string, string>;
  timeoutMs?: number;
}) {
  let parsed = input.parsed;

  if (input.executionMode === "write" && Array.isArray(input.observedChangedFiles)) {
    parsed = {
      ...parsed,
      changedFiles: [...input.observedChangedFiles],
    };
  }

  if (!containsHangul(parsed.summary)) {
    const repaired = await repairCodexSpecialistResponse({
      role: input.role,
      executionMode: input.executionMode,
      text: input.originalText,
      timeoutMs: input.timeoutMs,
    });
    parsed = parseCodexSpecialistResponse(repaired);
  }

  if (
    input.role === "qa"
    && input.workspacePath
    && parsed.impact === "blocking"
  ) {
    const joined = [parsed.summary, ...parsed.rawFindings].join("\n");
    const routes = extractRouteMentions(joined);
    if (
      QA_ROUTE_BLOCK_PATTERN.test(joined)
      && routes.length > 0
      && routes.every((route) => workspaceHasDeclaredRoute(input.workspacePath!, route))
    ) {
      parsed = {
        ...parsed,
        impact: "info",
        summary: `라우트 선언을 다시 확인해보니 ${routes.map((route) => `\`${route}\``).join(", ")} 경로는 이미 등록돼 있어요. 이번 변경은 차단 이슈가 아니라 목적에 맞는 연결과 카피 정합성을 다시 확인하면 되는 수준이에요.`,
        rawFindings: [
          ...parsed.rawFindings.filter((finding) => !QA_ROUTE_BLOCK_PATTERN.test(finding)),
          `라우트 선언 확인: ${routes.join(", ")} 경로가 앱 라우터에 이미 등록돼 있습니다.`,
        ],
        verificationNotes: [
          ...parsed.verificationNotes,
          `라우트 선언 확인: ${routes.join(", ")} path가 src/app/App.tsx 계열 라우터에 존재합니다.`,
        ],
      };
    }
  }

  if (
    input.role === "qa"
    && input.executionMode === "write"
    && parsed.impact === "blocking"
    && parsed.verificationNotes.length === 0
  ) {
    parsed = {
      ...parsed,
      impact: "approval_needed",
      rawFindings: [
        ...parsed.rawFindings,
        "차단 판단을 뒷받침하는 실행된 검증 명령이나 실패 로그가 결과에 포함되지 않았습니다.",
      ],
    };
  }

  if (input.executionMode === "write") {
    const violations = findWriteScopeViolations(input.role, parsed.changedFiles);
    if (violations.length > 0) {
      parsed = {
        ...parsed,
        impact: "blocking",
        summary: writeScopeViolationSummary(input.role),
        rawFindings: [
          ...parsed.rawFindings,
          `write scope violation: ${violations.join(", ")}`,
        ],
        verificationNotes: [
          ...parsed.verificationNotes,
          `runtime contract blocked out-of-scope writes: ${violations.join(", ")}`,
        ],
      };
    }
  }

  if (input.executionMode === "write" && input.playbookMemory && (input.executedCommands?.length ?? 0) > 0) {
    const capabilityViolations = findCapabilityViolations({
      playbookMemory: input.playbookMemory,
      executedCommands: input.executedCommands ?? [],
    });
    if (capabilityViolations.length > 0) {
      parsed = {
        ...parsed,
        impact: "blocking",
        summary: capabilityViolationSummary(input.role),
        rawFindings: [
          ...parsed.rawFindings,
          ...capabilityViolations.map((violation) =>
            `capability violation: ${violation.capability} via ${violation.commands.join(" | ")}`
          ),
        ],
        verificationNotes: [
          ...parsed.verificationNotes,
          `runtime contract blocked disallowed capabilities: ${capabilityViolations.map((violation) => violation.capability).join(", ")}`,
        ],
      };
    }
  }

  return parsed;
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
    const executionMode = determineSpecialistExecutionMode({
      role: specialist.role,
      goalTitle: specialist.goalTitle,
    });
    const workspacePath = resolveProjectWorkspace({
      projectId: specialist.projectId,
      memoryStore: specialist.memoryStore,
    });
    if (executionMode === "write" && !workspacePath) {
      return {
        result: {
          role: specialist.role,
          summary: "작업 저장소를 찾지 못해서 실제 수정을 시작하지 않았어요. 먼저 프로젝트 작업 경로를 연결해야 해요.",
          impact: "blocking",
          artifacts: [{ kind: "report", title: `${ROLE_REGISTRY[specialist.role].role}-report.md` }],
          rawFindings: ["project workspace unresolved for backend write mode"],
          executionMode,
          changedFiles: [],
          verificationNotes: [],
        },
        meta: {
          workspacePath,
          tokensUsed: 0,
          inspectedWorkspace: false,
          executedCommands: [],
        },
      };
    }
    const cwd = workspacePath ?? emptyCodexSandbox();
    const beforeChangedFiles = executionMode === "write"
      ? await listGitChangedFiles(cwd)
      : null;
    const extraArtifacts = await collectDynamicArtifacts({
      role: specialist.role,
      projectId: specialist.projectId,
      memoryStore: specialist.memoryStore,
      customerVoiceDecision: specialist.customerVoiceDecision,
    });
    const prompt = buildPrompt({
      role: specialist.role,
      projectId: specialist.projectId,
      goalTitle: specialist.goalTitle,
      workspacePath,
      executionMode,
      memoryStore: specialist.memoryStore,
      runId: specialist.runId,
      openclawWorkspacePath: input.openclawWorkspacePath,
      personaLabel: specialist.personaLabel,
      customerVoiceDecision: specialist.customerVoiceDecision,
      customerVoicePersona: specialist.customerVoicePersona,
      extraArtifacts,
    });
    const response = await runCodexPrompt({
      cwd,
      prompt,
      timeoutMs: input.timeoutMs,
    });
    const afterChangedFiles = executionMode === "write"
      ? await listGitChangedFiles(cwd)
      : null;
    const observedChangedFiles = executionMode === "write"
      ? (
        Array.isArray(beforeChangedFiles) && Array.isArray(afterChangedFiles)
          ? afterChangedFiles.filter((path) => !beforeChangedFiles.includes(path))
          : null
      )
      : null;
    const playbookMemory = specialist.memoryStore
      ? pruneMemory(specialist.memoryStore.getPlaybookMemory(specialist.role))
      : {};
    const parsed = sanitizeCodexSpecialistResponse({
      parsed: await normalizeSpecialistResult({
        role: specialist.role,
        executionMode,
        originalText: response.text,
        workspacePath,
        observedChangedFiles,
        executedCommands: response.executedCommands,
        playbookMemory,
        timeoutMs: input.timeoutMs,
        parsed: await parseOrRepairCodexSpecialistResponse({
          text: response.text,
          repair: async (text) =>
            await repairCodexSpecialistResponse({
              role: specialist.role,
              executionMode,
              text,
              timeoutMs: input.timeoutMs,
            }),
        }),
      }),
      inspectedWorkspace: response.inspectedWorkspace,
    });
    const mergedChangedFiles = executionMode === "write"
      ? (
        Array.isArray(observedChangedFiles)
          ? observedChangedFiles
          : mergeChangedFiles(parsed.changedFiles)
      )
      : [];

    const finalized = finalizeSpecialistResultForRuntime({
      role: specialist.role,
      playbookMemory,
      parsed: {
        ...parsed,
        executionMode,
        changedFiles: mergedChangedFiles,
      },
    });

    return {
      result: {
        role: specialist.role,
        summary: finalized.summary,
        impact: finalized.impact,
        artifacts: finalized.artifacts,
        rawFindings: finalized.rawFindings,
        executionMode,
        changedFiles: finalized.changedFiles,
        verificationNotes: finalized.verificationNotes,
        personaLabel: finalized.personaLabel ?? specialist.personaLabel,
      },
      meta: {
        workspacePath,
        tokensUsed: response.tokensUsed,
        inspectedWorkspace: response.inspectedWorkspace,
        executedCommands: response.executedCommands,
      },
    };
  };
}
