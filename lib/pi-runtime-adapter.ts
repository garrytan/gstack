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
