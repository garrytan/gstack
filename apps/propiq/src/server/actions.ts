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
import type { LocalityId, PropertyId, UserId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import { getCurrentUser } from '@/server/supabase';
import { getWatchlistRepository } from '@/server/watchlist';
import { getBuyerProfileRepository } from '@/server/profile';
import { getPortfolioRepository } from '@/server/portfolio';
import { BUYER_PERSONAS } from '@/domain/buyer/types';
import type { BuyerProfile } from '@/domain/buyer/types';
import { VALUATION_SOURCES } from '@/domain/portfolio/types';
import type { PortfolioAsset } from '@/domain/portfolio/types';
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

// ---------------------------------------------------------------------------
// Buyer profile
// ---------------------------------------------------------------------------

/**
 * Profile input.
 *
 * Coerced from form strings, then bounded. The ceilings are not arbitrary:
 * a budget above ₹100 crore or a commute tolerance over four hours is a typo
 * or an abuse attempt, and either way should not reach the scoring engine.
 */
const profileSchema = z
  .object({
    persona: z.enum(BUYER_PERSONAS),
    budgetMin: z.coerce.number().min(0).max(1_000_00_00_000),
    budgetMax: z.coerce.number().min(0).max(1_000_00_00_000),
    bedroomsMin: z.coerce.number().int().min(0).max(10).optional(),
    bedroomsMax: z.coerce.number().int().min(0).max(10).optional(),
    workplaceLabel: z.string().max(120).optional(),
    maxPeakCommuteMinutes: z.coerce.number().int().min(5).max(240).optional(),
    needsReadyToMove: z.coerce.boolean().optional(),
    minCarpetEfficiency: z.coerce.number().min(0).max(1).optional(),
    targetGrossYieldPercent: z.coerce.number().min(0).max(30).optional(),
    preferredLocalities: z.array(z.string().max(64)).max(25).optional(),
  })
  .refine((v) => v.budgetMax >= v.budgetMin, {
    message: 'Maximum budget must be at least the minimum.',
    path: ['budgetMax'],
  })
  .refine((v) => (v.bedroomsMax ?? 99) >= (v.bedroomsMin ?? 0), {
    message: 'Maximum bedrooms must be at least the minimum.',
    path: ['bedroomsMax'],
  });

export const saveBuyerProfile = async (raw: unknown): Promise<ActionResult> => {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the values you entered.',
    };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to save your preferences.' };

  const v = parsed.data;
  const profile: BuyerProfile = {
    userId,
    persona: v.persona,
    budgetMin: Math.round(v.budgetMin),
    budgetMax: Math.round(v.budgetMax),
    preferredLocalities: (v.preferredLocalities ?? []).map((l) => asId<LocalityId>(l)),
    bedroomsMin: v.bedroomsMin,
    bedroomsMax: v.bedroomsMax,
    workplace:
      v.workplaceLabel && v.maxPeakCommuteMinutes !== undefined
        ? { label: v.workplaceLabel, maxPeakCommuteMinutes: v.maxPeakCommuteMinutes }
        : undefined,
    needsReadyToMove: v.needsReadyToMove,
    minCarpetEfficiency: v.minCarpetEfficiency,
    targetGrossYieldPercent: v.targetGrossYieldPercent,
  };

  await getBuyerProfileRepository().save(profile);
  // Every scored surface reads the profile, so all of them are now stale.
  revalidatePath('/preferences');
  revalidatePath('/search');
  revalidatePath('/dashboard');
  return { ok: true, message: 'Preferences saved. Scores are now weighted for how you buy.' };
};

export const loadBuyerProfile = async (): Promise<BuyerProfile | undefined> => {
  const userId = await resolveUserId();
  if (!userId) return undefined;
  return getBuyerProfileRepository().get(userId);
};

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

const assetSchema = z.object({
  label: z.string().min(1).max(120),
  propertyId: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9_-]*$/)
    .optional(),
  purchasePrice: z.coerce.number().min(0).max(1_000_00_00_000),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.'),
  costBasis: z.coerce.number().min(0).max(1_000_00_00_000),
  outstandingLoan: z.coerce.number().min(0).max(1_000_00_00_000),
  monthlyRent: z.coerce.number().min(0).max(1_00_00_000),
  monthlyExpenses: z.coerce.number().min(0).max(1_00_00_000),
  currentEstimate: z.coerce.number().min(0).max(1_000_00_00_000).optional(),
  valuationSource: z.enum(VALUATION_SOURCES),
});

export const addPortfolioAsset = async (raw: unknown): Promise<ActionResult> => {
  const parsed = assetSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the values you entered.',
    };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to track a portfolio.' };

  const v = parsed.data;
  // A user-supplied current value is self-reported, whatever the form said.
  // The label on the number has to match where it actually came from.
  const valuationSource =
    v.currentEstimate !== undefined && v.valuationSource === 'verified'
      ? 'userProvided'
      : v.valuationSource;

  await getPortfolioRepository().add(userId, {
    label: v.label,
    propertyId: v.propertyId ? asId<PropertyId>(v.propertyId) : undefined,
    purchasePrice: Math.round(v.purchasePrice),
    purchaseDate: v.purchaseDate,
    costBasis: Math.round(v.costBasis),
    outstandingLoan: Math.round(v.outstandingLoan),
    monthlyRent: Math.round(v.monthlyRent),
    monthlyExpenses: Math.round(v.monthlyExpenses),
    currentEstimate: v.currentEstimate === undefined ? undefined : Math.round(v.currentEstimate),
    valuationSource,
  });

  revalidatePath('/dashboard/portfolio');
  return { ok: true, message: 'Asset added to your portfolio.' };
};

export const removePortfolioAsset = async (assetId: string): Promise<ActionResult> => {
  const parsed = z.string().min(1).max(64).safeParse(assetId);
  if (!parsed.success) return { ok: false, message: 'That asset reference is not valid.' };

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to manage your portfolio.' };

  await getPortfolioRepository().remove(userId, parsed.data);
  revalidatePath('/dashboard/portfolio');
  return { ok: true, message: 'Asset removed.' };
};

export const loadPortfolio = async (): Promise<readonly PortfolioAsset[]> => {
  const userId = await resolveUserId();
  if (!userId) return [];
  return getPortfolioRepository().list(userId);
};
