/**
 * Shared Interfaze client via Vercel AI SDK OpenAI-compatible provider.
 * Captures Interfaze `precontext` (OCR bounds, search hits, scrape elements) in providerMetadata.
 */

import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { SharedV3ProviderMetadata } from '@ai-sdk/provider';
import { resolveInterfazeKey } from './interfaze-auth';

const precontextExtractor: MetadataExtractor = {
  async extractMetadata({ parsedBody }) {
    const body = parsedBody as Record<string, unknown> | null;
    if (!body || !('precontext' in body) || body.precontext == null) {
      return undefined;
    }
    return {
      interfaze: { precontext: body.precontext },
    } as SharedV3ProviderMetadata;
  },
  createStreamExtractor: () => {
    let precontext: unknown;
    return {
      processChunk(parsedChunk: unknown) {
        const chunk = parsedChunk as Record<string, unknown> | null;
        if (chunk && 'precontext' in chunk && chunk.precontext != null) {
          precontext = chunk.precontext;
        }
      },
      buildMetadata(): SharedV3ProviderMetadata | undefined {
        if (precontext == null) return undefined;
        return { interfaze: { precontext } } as SharedV3ProviderMetadata;
      },
    };
  },
};

export const INTERFAZE_MODEL = 'interfaze-beta';

export type InterfazeProvider = ReturnType<typeof createInterfazeCompatible>;

function createInterfazeCompatible() {
  const apiKey = resolveInterfazeKey();
  if (!apiKey) return null;
  return createOpenAICompatible({
    name: 'interfaze',
    apiKey,
    baseURL: 'https://api.interfaze.ai/v1',
    supportsStructuredOutputs: true,
    metadataExtractor: precontextExtractor,
  });
}

/** Returns null if no API key configured. */
export function createInterfazeProvider(): InterfazeProvider | null {
  return createInterfazeCompatible();
}

export function getInterfazePrecontext(
  providerMetadata: Record<string, unknown> | undefined,
): unknown {
  if (!providerMetadata) return undefined;
  const interfaze = providerMetadata.interfaze as { precontext?: unknown } | undefined;
  return interfaze?.precontext;
}
