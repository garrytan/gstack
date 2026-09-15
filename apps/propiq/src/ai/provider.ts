/**
 * AI provider abstraction.
 *
 * Two rules this layer exists to enforce:
 *  1. No model ID ever appears in domain logic. Providers and models are
 *     resolved from environment configuration at the edge.
 *  2. The LLM is an explanation layer. It receives retrieved evidence and
 *     deterministic calculator output as context and is instructed to answer
 *     only from them. It is never the source of a property fact.
 */

import 'server-only';
import { getServerEnv } from '@/lib/env';

export interface CompletionMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly CompletionMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      'No AI provider is configured. Set AI_PROVIDER and AI_API_KEY. PropIQ will not ' +
        'fabricate an answer in their absence.',
    );
    this.name = 'AiNotConfiguredError';
  }
}

/**
 * Null provider.
 *
 * Deliberately throws rather than returning a plausible-sounding placeholder.
 * A stubbed AI answer is indistinguishable from a real one to a user, which
 * makes it exactly the kind of fabrication this product forbids.
 */
class NullProvider implements AiProvider {
  readonly name = 'none';
  readonly model = 'none';
  async complete(): Promise<CompletionResult> {
    throw new AiNotConfiguredError();
  }
}

class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = request.messages.filter((m) => m.role !== 'system');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      throw new Error(`AI provider returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    return {
      text,
      model: this.model,
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
    };
  }
}

class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      throw new Error(`AI provider returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model: this.model,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    };
  }
}

let cached: AiProvider | undefined;

export const getAiProvider = (): AiProvider => {
  if (cached) return cached;
  const env = getServerEnv();

  let provider: AiProvider;
  if (env.AI_PROVIDER === 'anthropic' && env.AI_API_KEY && env.AI_MODEL) {
    provider = new AnthropicProvider(env.AI_MODEL, env.AI_API_KEY);
  } else if (env.AI_PROVIDER === 'openai' && env.AI_API_KEY && env.AI_MODEL) {
    provider = new OpenAiProvider(env.AI_MODEL, env.AI_API_KEY);
  } else {
    provider = new NullProvider();
  }

  cached = provider;
  return provider;
};

export const isAiConfigured = (): boolean => getAiProvider().name !== 'none';

/** Test-only: clears the memoised provider. */
export const __resetAiProvider = (): void => {
  cached = undefined;
};
