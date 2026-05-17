export interface PiSkillAliasSpec {
  readonly command: string;
  readonly skillName: string;
  readonly description: string;
}

export const PI_GSTACK_SKILL_ALIASES: readonly PiSkillAliasSpec[] = [
  {
    command: 'office-hours',
    skillName: 'gstack-office-hours',
    description: 'Start the gstack Office Hours product-intake workflow.',
  },
  {
    command: 'autoplan',
    skillName: 'gstack-autoplan',
    description: 'Run the gstack autoplan review pipeline.',
  },
  {
    command: 'review',
    skillName: 'gstack-review',
    description: 'Run the gstack code review workflow.',
  },
  {
    command: 'qa',
    skillName: 'gstack-qa',
    description: 'Run the gstack QA workflow.',
  },
  {
    command: 'ship',
    skillName: 'gstack-ship',
    description: 'Run the gstack ship workflow.',
  },
] as const;

export interface PiBrowserCommandRequest {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
}

export interface NormalizedPiBrowserCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export type PiBrowserCommandNormalization =
  | { readonly ok: true; readonly value: NormalizedPiBrowserCommandRequest }
  | { readonly ok: false; readonly error: string };

export interface PiBrowserRuntimePaths {
  readonly repoRoot: string;
  readonly home: string;
  readonly env?: Record<string, string | undefined>;
}

export interface AskUserQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskUserQuestionRequest {
  readonly question?: unknown;
  readonly options?: unknown;
  readonly allowCustom?: unknown;
  readonly placeholder?: unknown;
}

export interface NormalizedAskUserQuestionRequest {
  readonly question: string;
  readonly options: readonly AskUserQuestionOption[];
  readonly allowCustom: boolean;
  readonly placeholder?: string;
}

export type AskUserQuestionNormalization =
  | { readonly ok: true; readonly value: NormalizedAskUserQuestionRequest }
  | { readonly ok: false; readonly error: string };

export interface AskUserQuestionResult {
  readonly question: string;
  readonly answer: string | null;
  readonly cancelled: boolean;
  readonly wasCustom: boolean;
}

export type FactoryReviewGoalNormalization =
  | { readonly ok: true; readonly goal: string }
  | { readonly ok: false; readonly error: string };

export function toPiSkillCommand(skillName: string, args = ''): string {
  const trimmedSkillName = skillName.trim();
  if (!trimmedSkillName) {
    throw new Error('skillName is required');
  }

  const trimmedArgs = args.trim();
  return trimmedArgs ? `/skill:${trimmedSkillName} ${trimmedArgs}` : `/skill:${trimmedSkillName}`;
}

export function aliasToPiSkillCommand(spec: PiSkillAliasSpec, args = ''): string {
  return toPiSkillCommand(spec.skillName, args);
}

export function normalizeFactoryReviewGoal(args: string): FactoryReviewGoalNormalization {
  const goal = args.trim();
  if (!goal) {
    return { ok: false, error: 'factory-review requires a review goal or scope' };
  }
  return { ok: true, goal };
}

export function factoryRunsRoot(projectRoot: string): string {
  return joinPath(projectRoot, '.gstack', 'factory', 'runs');
}

export function normalizePiBrowserCommandRequest(input: PiBrowserCommandRequest): PiBrowserCommandNormalization {
  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    return { ok: false, error: 'command must be a non-empty string' };
  }

  const command = input.command.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(command)) {
    return { ok: false, error: 'command must be a browse command name such as goto, snapshot, screenshot, or console' };
  }

  if (input.args !== undefined && !Array.isArray(input.args)) {
    return { ok: false, error: 'args must be an array of strings' };
  }

  const args = (input.args ?? []).map((arg) => typeof arg === 'string' ? arg : null);
  if (args.some(arg => arg === null)) {
    return { ok: false, error: 'args must be an array of strings' };
  }

  if (input.cwd !== undefined) {
    return { ok: false, error: 'cwd is not supported; gstack_browser runs in the current Pi project' };
  }

  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
    ? Math.trunc(input.timeoutMs)
    : 30_000;

  if (timeoutMs < 1_000 || timeoutMs > 120_000) {
    return { ok: false, error: 'timeoutMs must be between 1000 and 120000' };
  }

  return {
    ok: true,
    value: {
      command,
      args: args as string[],
      timeoutMs,
    },
  };
}

export function piBrowserExecutableCandidates(paths: PiBrowserRuntimePaths): readonly string[] {
  const envBrowse = paths.env?.GSTACK_BROWSE;
  return uniqueStrings([
    envBrowse ? joinPath(envBrowse, 'browse') : '',
    joinPath(paths.home, '.pi', 'agent', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    joinPath(paths.repoRoot, '.pi', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    joinPath(paths.repoRoot, 'browse', 'dist', 'browse'),
  ]);
}

export function normalizeAskUserQuestionRequest(input: AskUserQuestionRequest): AskUserQuestionNormalization {
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    return { ok: false, error: 'question must be a non-empty string' };
  }

  const options = normalizeQuestionOptions(input.options);
  const placeholder = typeof input.placeholder === 'string' && input.placeholder.trim().length > 0
    ? input.placeholder.trim()
    : undefined;

  return {
    ok: true,
    value: {
      question: input.question.trim(),
      options,
      allowCustom: typeof input.allowCustom === 'boolean' ? input.allowCustom : options.length === 0,
      placeholder,
    },
  };
}

export function formatAskUserQuestionResult(result: AskUserQuestionResult): string {
  if (result.cancelled || result.answer === null) {
    return 'User cancelled the question. Do not assume an answer; ask again or stop at the gate.';
  }

  return result.wasCustom ? `User wrote: ${result.answer}` : `User selected: ${result.answer}`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function joinPath(...parts: readonly string[]): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return '';
  return filtered.join('/').replace(/\/+/g, '/');
}

function normalizeQuestionOptions(input: unknown): readonly AskUserQuestionOption[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const options: AskUserQuestionOption[] = [];

  for (const raw of input) {
    const option = normalizeQuestionOption(raw);
    if (!option) continue;

    const key = option.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }

  return options;
}

function normalizeQuestionOption(input: unknown): AskUserQuestionOption | null {
  if (typeof input === 'string') {
    const label = input.trim();
    return label ? { label } : null;
  }

  if (!input || typeof input !== 'object') return null;

  const record = input as { label?: unknown; description?: unknown };
  if (typeof record.label !== 'string' || record.label.trim().length === 0) return null;

  const description = typeof record.description === 'string' && record.description.trim().length > 0
    ? record.description.trim()
    : undefined;

  return description ? { label: record.label.trim(), description } : { label: record.label.trim() };
}
