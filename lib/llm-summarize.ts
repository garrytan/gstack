/**
 * LLM session summarization via raw fetch() to Anthropic Messages API.
 *
 * No SDK dependency — matches the Supabase raw-fetch pattern.
 * Uses eval-cache for SHA-based caching (reruns are instant).
 *
 * Retry strategy (per Anthropic docs):
 *   429: read retry-after header, wait that duration, max 2 retries
 *   5xx: exponential backoff (1s, 2s), max 2 retries
 *   All other errors: return null immediately
 */

import { computeCacheKey, cacheRead, cacheWrite } from './eval-cache';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 10_000;

/**
 * Generate a 1-sentence summary of a Claude Code session.
 * Returns null if: no API key, API error, or malformed response.
 */
export async function summarizeSession(
  messages: Array<{ display: string; timestamp: number }>,
  toolsUsed: string[] | null,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (messages.length === 0) return null;

  // Build cache key from session content
  const contentForHash = messages.map(m => m.display).join('\n').slice(0, 10_000);
  const toolsStr = toolsUsed ? toolsUsed.join(',') : '';
  const cacheKey = computeCacheKey([], `summary:${MODEL}:${contentForHash}:${toolsStr}`);

  const cached = cacheRead('transcript-summaries', cacheKey);
  if (cached !== null && typeof cached === 'string') return cached;

  const promptLines = messages.slice(0, 50).map(m =>
    m.display.length > 200 ? m.display.slice(0, 200) + '...' : m.display,
  );
  const toolInfo = toolsUsed && toolsUsed.length > 0
    ? `\nTools used: ${toolsUsed.join(', ')}`
    : '';

  const userPrompt = `Summarize this Claude Code session in exactly one sentence. Focus on what the user accomplished, not the process. Be specific and concise.

User prompts (${messages.length} turns):
${promptLines.join('\n')}
${toolInfo}

Respond with ONLY the summary sentence, nothing else.`;

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 150,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const summary = await fetchWithRetry(apiKey, body);
  if (summary) {
    cacheWrite('transcript-summaries', cacheKey, summary, { model: MODEL });
  }
  return summary;
}

async function fetchWithRetry(apiKey: string, body: string): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        const content = (data.content as any[])?.[0];
        if (content?.type === 'text' && typeof content.text === 'string') {
          return content.text.trim().slice(0, 500);
        }
        return null;
      }

      // 429: use retry-after header
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 5xx: exponential backoff
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      // 4xx (not 429): don't retry
      return null;
    } catch {
      // Network error, timeout, abort — retry with backoff
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
