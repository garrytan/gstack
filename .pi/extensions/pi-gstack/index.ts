import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PI_GSTACK_SKILL_ALIASES,
  aliasToPiSkillCommand,
  formatAskUserQuestionResult,
  normalizeAskUserQuestionRequest,
  type AskUserQuestionResult,
} from '../../../lib/pi-runtime-adapter';

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(EXTENSION_DIR, '..', '..', '..');
const GENERATED_PI_SKILLS_DIR = join(REPO_ROOT, '.pi', 'skills');
const CUSTOM_ANSWER_LABEL = 'Type a custom answer.';

const ASK_USER_QUESTION_PARAMETERS = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question to ask the user before proceeding.',
    },
    options: {
      type: 'array',
      description: 'Optional answer choices. Each item may be a string or { label, description }.',
      items: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        ],
      },
    },
    allowCustom: {
      type: 'boolean',
      description: 'Whether the user may type a custom answer when options are present. Defaults to false with options and true without options.',
    },
    placeholder: {
      type: 'string',
      description: 'Optional placeholder text for freeform answers.',
    },
  },
  required: ['question'],
  additionalProperties: false,
} as const;

export default function piGstack(pi: any) {
  pi.on('resources_discover', async () => {
    if (!existsSync(GENERATED_PI_SKILLS_DIR)) return undefined;
    return { skillPaths: [GENERATED_PI_SKILLS_DIR] };
  });

  for (const alias of PI_GSTACK_SKILL_ALIASES) {
    pi.registerCommand(alias.command, {
      description: alias.description,
      handler: async (args: string, ctx: any) => {
        const message = aliasToPiSkillCommand(alias, args);
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
          return;
        }

        pi.sendUserMessage(message, { deliverAs: 'followUp' });
        ctx.ui.notify(`Queued ${message}`, 'info');
      },
    });
  }

  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask User Question',
    description: 'Ask the user a structured question through the Pi UI. Use when gstack needs an explicit user decision or missing project-specific detail before proceeding.',
    promptSnippet: 'Ask the user a structured question through the Pi UI.',
    promptGuidelines: [
      'Use ask_user_question when a gstack workflow requires an explicit user decision or missing project-specific detail; do not invent answers.',
    ],
    parameters: ASK_USER_QUESTION_PARAMETERS,

    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const normalized = normalizeAskUserQuestionRequest(params as Record<string, unknown>);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }

      if (!ctx.hasUI) {
        throw new Error('ask_user_question requires interactive Pi UI. Ask the user directly instead of auto-deciding.');
      }

      const request = normalized.value;
      const answer = request.options.length > 0
        ? await askWithOptions(ctx, request.question, request.options, request.allowCustom, request.placeholder)
        : await askFreeform(ctx, request.question, request.placeholder);

      const result: AskUserQuestionResult = {
        question: request.question,
        answer: answer?.answer ?? null,
        cancelled: !answer,
        wasCustom: answer?.wasCustom ?? false,
      };

      return {
        content: [{ type: 'text', text: formatAskUserQuestionResult(result) }],
        details: result,
      };
    },
  });
}

async function askWithOptions(
  ctx: any,
  question: string,
  options: readonly { label: string; description?: string }[],
  allowCustom: boolean,
  placeholder: string | undefined,
): Promise<{ answer: string; wasCustom: boolean } | null> {
  const prompt = formatQuestionPrompt(question, options);
  const choices = allowCustom ? [...options.map(option => option.label), CUSTOM_ANSWER_LABEL] : options.map(option => option.label);
  const choice = await ctx.ui.select(prompt, choices);

  if (!choice) return null;
  if (choice !== CUSTOM_ANSWER_LABEL) return { answer: choice, wasCustom: false };

  return askFreeform(ctx, question, placeholder);
}

async function askFreeform(
  ctx: any,
  question: string,
  placeholder: string | undefined,
): Promise<{ answer: string; wasCustom: boolean } | null> {
  const answer = await ctx.ui.input(question, placeholder ?? 'Type your answer');
  if (typeof answer !== 'string' || answer.trim().length === 0) return null;
  return { answer: answer.trim(), wasCustom: true };
}

function formatQuestionPrompt(question: string, options: readonly { label: string; description?: string }[]): string {
  const described = options.filter(option => option.description);
  if (described.length === 0) return question;

  const details = described.map(option => `- ${option.label}: ${option.description}`).join('\n');
  return `${question}\n\n${details}`;
}
