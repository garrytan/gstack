/**
 * Copilot endpoint.
 *
 * Order is deliberate: validate, authorize, rate limit, then do work. The
 * expensive step (building the intelligence payload, then a model call) only
 * happens for a request that has cleared every cheaper gate.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { buildPropertyIntelligence } from '@/server/intelligence';
import { currentUserId } from '@/server/actions';
import { checkAiRateLimit, rateLimitHeaders } from '@/server/rate-limit';
import { askCopilot, MAX_QUESTION_LENGTH } from '@/ai/copilot';
import { AiNotConfiguredError } from '@/ai/provider';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  propertyId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  question: z.string().min(3).max(MAX_QUESTION_LENGTH),
});

/** First hop in `x-forwarded-for` is the client; the rest are proxies. */
const clientIp = (request: Request): string | undefined =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
  request.headers.get('x-real-ip') ??
  undefined;

export const POST = async (request: Request): Promise<NextResponse> => {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: 'Send a propertyId and a question between 3 and 800 characters.' },
      { status: 400 },
    );
  }

  const userId = await currentUserId();
  const limit = await checkAiRateLimit({ userId, ip: clientIp(request) });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many questions. Try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: rateLimitHeaders(limit) },
    );
  }

  const intel = await buildPropertyIntelligence(asId<PropertyId>(parsed.propertyId), {
    includeAlternatives: false,
  });
  if (!intel) {
    return NextResponse.json({ error: 'We do not have that property.' }, { status: 404 });
  }

  try {
    const answer = await askCopilot({ question: parsed.question, intelligence: intel });
    return NextResponse.json(
      {
        text: answer.text,
        grounded: answer.grounded,
        unsupportedClaims: answer.unsupportedClaims,
        intent: answer.intent,
        usesDemoData: answer.usesDemoData,
        model: answer.model,
      },
      { headers: rateLimitHeaders(limit) },
    );
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      // 503, not 500: the service is correctly configured to refuse rather
      // than to invent, and the caller should be told which it is.
      return NextResponse.json(
        {
          error:
            'PropIQ Copilot has no AI provider configured in this environment. Rather than ' +
            'generate an answer that looks real, it declines. Everything the Copilot would cite ' +
            'is already on the property page.',
          code: 'AI_NOT_CONFIGURED',
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: 'The Copilot could not answer that. Nothing was guessed in its place.' },
      { status: 502 },
    );
  }
};
