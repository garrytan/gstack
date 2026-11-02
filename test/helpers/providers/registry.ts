import type { ProviderAdapter } from './types';
import { ClaudeAdapter } from './claude';
import { GptAdapter } from './gpt';
import { GeminiAdapter } from './gemini';
import { GatewayAdapter } from './gateway';

/** The one provider registry the benchmark CLI, its dry run and the runner share. */
export const PROVIDERS = {
  claude: () => new ClaudeAdapter(),
  gpt: () => new GptAdapter(),
  gemini: () => new GeminiAdapter(),
  particle: () => new GatewayAdapter('particle'),
  deepseek: () => new GatewayAdapter('deepseek'),
} satisfies Record<string, () => ProviderAdapter>;

export type ProviderName = keyof typeof PROVIDERS;
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

export function isProviderName(name: string): name is ProviderName {
  return Object.hasOwn(PROVIDERS, name);
}
