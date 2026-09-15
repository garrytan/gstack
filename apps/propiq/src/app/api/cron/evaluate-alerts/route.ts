/**
 * Scheduled alert evaluation.
 *
 * The rules and the snapshot diff already exist and are pure; what was missing
 * was something a scheduler can call. This is that: point any cron at it
 * (Vercel Cron, GitHub Actions, a systemd timer) and alert delivery stops
 * being a code problem and becomes a configuration one.
 *
 * Auth is a shared secret compared in constant time, not a session: a
 * scheduler has no user. Without `CRON_SECRET` set the endpoint refuses
 * every request rather than defaulting open.
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { evaluateAlerts } from '@/domain/alerts/engine';
import type { Alert } from '@/domain/alerts/types';
import { buildPropertyIntelligence } from '@/server/intelligence';
import { getSnapshotStore, toSnapshot } from '@/server/snapshots';
import { getWatchlistRepository } from '@/server/watchlist';
import { getServerEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Constant-time compare so a wrong secret cannot be found by timing the response. */
const secretMatches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const POST = async (request: Request): Promise<NextResponse> => {
  const env = getServerEnv();

  if (!env.CRON_SECRET) {
    return NextResponse.json(
      { error: 'Scheduled evaluation is not configured. Set CRON_SECRET to enable it.' },
      { status: 503 },
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !secretMatches(provided, env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
  const userId = typeof body.userId === 'string' ? body.userId : undefined;
  if (!userId) {
    // One user per call, so a failure is isolated and the scheduler controls
    // its own fan-out and pacing rather than this endpoint guessing at both.
    return NextResponse.json(
      { error: 'Send a userId. Evaluate one user per call so the scheduler controls fan-out.' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const store = getSnapshotStore();
  const entries = await getWatchlistRepository().list(asId(userId));

  const alerts: Alert[] = [];
  let baselined = 0;
  let skipped = 0;

  for (const entry of entries) {
    const intel = await buildPropertyIntelligence(asId<PropertyId>(entry.propertyId), {
      now,
      includeAlternatives: false,
    });
    if (!intel) {
      skipped += 1;
      continue;
    }

    const current = toSnapshot(intel);
    const previous = await store.latest(userId, entry.propertyId);
    if (previous) alerts.push(...evaluateAlerts(previous, current, now));
    else baselined += 1;
    await store.put(userId, current);
  }

  return NextResponse.json({
    evaluatedAt: now,
    watched: entries.length,
    baselined,
    skipped,
    alerts,
    // Delivery is deliberately not this endpoint's job. It returns the alerts
    // so a scheduler, a webhook or an email worker can decide what to do with
    // them, which keeps the evaluation testable in isolation.
    delivered: false,
  });
};
