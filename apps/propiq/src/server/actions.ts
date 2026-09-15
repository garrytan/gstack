/**
 * Server actions.
 *
 * Every action validates its input with Zod before touching a repository, and
 * every user-scoped action resolves the caller's identity server-side. A
 * client-supplied user id is never trusted.
 */

'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import { getCurrentUser } from '@/server/supabase';
import { getWatchlistRepository } from '@/server/watchlist';
import { getServerEnv } from '@/lib/env';

export interface ActionResult {
  readonly ok: boolean;
  readonly message?: string;
}

const propertyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid property id');

/**
 * Resolve the acting user.
 *
 * In fixture mode there is no auth provider, so a fixed local identity keeps
 * the save flow demonstrable. That identity only ever reaches the in-memory
 * store, which `getWatchlistRepository` refuses to hand out in supabase mode.
 */
const resolveUserId = async (): Promise<UserId | undefined> => {
  const user = await getCurrentUser();
  if (user) return asId<UserId>(user.id);
  if (getServerEnv().PROPIQ_DATA_ADAPTER === 'fixture') {
    return asId<UserId>('local-dev-user');
  }
  return undefined;
};

export const saveToWatchlist = async (
  rawPropertyId: string,
  note?: string,
): Promise<ActionResult> => {
  const parsed = propertyIdSchema.safeParse(rawPropertyId);
  if (!parsed.success) return { ok: false, message: 'That property reference is not valid.' };

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to save properties to your watchlist.' };

  await getWatchlistRepository().add(userId, asId<PropertyId>(parsed.data), note?.slice(0, 500));
  revalidatePath('/dashboard/watchlist');
  revalidatePath(`/property/${parsed.data}`);
  return { ok: true, message: 'Saved to your watchlist.' };
};

export const removeFromWatchlist = async (rawPropertyId: string): Promise<ActionResult> => {
  const parsed = propertyIdSchema.safeParse(rawPropertyId);
  if (!parsed.success) return { ok: false, message: 'That property reference is not valid.' };

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to manage your watchlist.' };

  await getWatchlistRepository().remove(userId, asId<PropertyId>(parsed.data));
  revalidatePath('/dashboard/watchlist');
  revalidatePath(`/property/${parsed.data}`);
  return { ok: true, message: 'Removed from your watchlist.' };
};

export const isWatched = async (rawPropertyId: string): Promise<boolean> => {
  const parsed = propertyIdSchema.safeParse(rawPropertyId);
  if (!parsed.success) return false;
  const userId = await resolveUserId();
  if (!userId) return false;
  return getWatchlistRepository().has(userId, asId<PropertyId>(parsed.data));
};

export const currentUserId = async (): Promise<UserId | undefined> => resolveUserId();
