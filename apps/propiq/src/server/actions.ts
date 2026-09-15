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
import { getVisitRepository } from '@/server/visits';
import { getNegotiationRepository } from '@/server/negotiations';
import type { SiteVisit } from '@/domain/visits/types';
import { summariseVisit, visitChangesDecision } from '@/domain/visits/engine';
import type { Negotiation } from '@/domain/negotiation/types';
import { NEGOTIATION_STATUSES } from '@/domain/negotiation/types';
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

// ---------------------------------------------------------------------------
// Site visits
// ---------------------------------------------------------------------------

const answerSchema = z.enum(['good', 'acceptable', 'concern', 'unknown']);

const observationsSchema = z
  .array(
    z.object({
      itemId: z.string().min(1).max(64),
      answer: answerSchema,
      note: z.string().max(500).optional(),
    }),
  )
  .max(100);

export const scheduleVisit = async (
  rawPropertyId: string,
  scheduledFor: string,
): Promise<ActionResult> => {
  const parsed = z
    .object({
      propertyId: propertyIdSchema,
      scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.'),
    })
    .safeParse({ propertyId: rawPropertyId, scheduledFor });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the date.' };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to plan a site visit.' };

  await getVisitRepository().schedule(
    userId,
    asId<PropertyId>(parsed.data.propertyId),
    parsed.data.scheduledFor,
  );
  revalidatePath(`/property/${parsed.data.propertyId}/visit`);
  return { ok: true, message: 'Visit planned. The checklist is ready when you are.' };
};

export const completeVisit = async (
  visitId: string,
  rawObservations: unknown,
  overallNote?: string,
): Promise<ActionResult> => {
  const parsed = z
    .object({
      visitId: z.string().min(1).max(64),
      observations: observationsSchema,
      overallNote: z.string().max(2000).optional(),
    })
    .safeParse({ visitId, observations: rawObservations, overallNote });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check what you entered.' };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to record a visit.' };

  const visit = await getVisitRepository().complete(
    userId,
    parsed.data.visitId,
    parsed.data.observations,
    parsed.data.overallNote,
  );
  if (!visit) return { ok: false, message: 'We could not find that visit.' };

  const summary = summariseVisit(visit);
  revalidatePath(`/property/${visit.propertyId}`);
  revalidatePath(`/property/${visit.propertyId}/visit`);

  // A material concern means what we hold on this property is now out of date.
  return {
    ok: true,
    message: visitChangesDecision(summary)
      ? `Recorded. You flagged ${summary.materialConcerns.length} thing(s) serious enough to change the verdict — the property page now reads them as first-party evidence.`
      : 'Recorded. What you saw is now evidence on this property.',
  };
};

export const loadVisits = async (rawPropertyId?: string): Promise<readonly SiteVisit[]> => {
  const userId = await resolveUserId();
  if (!userId) return [];
  const repo = getVisitRepository();
  if (!rawPropertyId) return repo.list(userId);
  const parsed = propertyIdSchema.safeParse(rawPropertyId);
  if (!parsed.success) return [];
  return repo.listForProperty(userId, asId<PropertyId>(parsed.data));
};

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

const startNegotiationSchema = z.object({
  propertyId: propertyIdSchema,
  askingPrice: z.coerce.number().min(0).max(1_000_00_00_000),
  fairValueMid: z.coerce.number().min(0).max(1_000_00_00_000).optional(),
  targetPrice: z.coerce.number().min(0).max(1_000_00_00_000),
  walkAwayPrice: z.coerce.number().min(0).max(1_000_00_00_000),
});

export const startNegotiation = async (raw: unknown): Promise<ActionResult> => {
  const parsed = startNegotiationSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the numbers.' };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to track a negotiation.' };

  const v = parsed.data;
  if (v.walkAwayPrice < v.targetPrice) {
    return {
      ok: false,
      message:
        'Your walk-away price should be at or above your target. Otherwise the target is the walk-away.',
    };
  }

  await getNegotiationRepository().start(userId, {
    propertyId: asId<PropertyId>(v.propertyId),
    askingPrice: Math.round(v.askingPrice),
    fairValueMid: v.fairValueMid === undefined ? undefined : Math.round(v.fairValueMid),
    targetPrice: Math.round(v.targetPrice),
    walkAwayPrice: Math.round(v.walkAwayPrice),
  });
  revalidatePath(`/property/${v.propertyId}/negotiate`);
  return { ok: true, message: 'Both numbers recorded before the first offer. That was the point.' };
};

const offerSchema = z.object({
  negotiationId: z.string().min(1).max(64),
  party: z.enum(['buyer', 'seller']),
  amount: z.coerce.number().min(0).max(1_000_00_00_000),
  concessions: z.array(z.string().max(160)).max(12).optional(),
  note: z.string().max(500).optional(),
});

export const recordOffer = async (raw: unknown): Promise<ActionResult> => {
  const parsed = offerSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the offer details.' };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to record an offer.' };

  const v = parsed.data;
  const updated = await getNegotiationRepository().addOffer(userId, v.negotiationId, {
    party: v.party,
    amount: Math.round(v.amount),
    at: new Date().toISOString(),
    concessions: v.concessions?.filter((c) => c.trim().length > 0),
    note: v.note,
  });
  if (!updated) return { ok: false, message: 'We could not find that negotiation.' };

  revalidatePath(`/property/${updated.propertyId}/negotiate`);
  return { ok: true, message: 'Offer recorded.' };
};

export const setNegotiationStatus = async (
  negotiationId: string,
  status: string,
  outcomePrice?: number,
): Promise<ActionResult> => {
  const parsed = z
    .object({
      negotiationId: z.string().min(1).max(64),
      status: z.enum(NEGOTIATION_STATUSES),
      outcomePrice: z.coerce.number().min(0).max(1_000_00_00_000).optional(),
    })
    .safeParse({ negotiationId, status, outcomePrice });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'That status is not valid.' };
  }

  const userId = await resolveUserId();
  if (!userId) return { ok: false, message: 'Sign in to update a negotiation.' };

  const result = await getNegotiationRepository().setStatus(
    userId,
    parsed.data.negotiationId,
    parsed.data.status,
    parsed.data.outcomePrice === undefined ? undefined : Math.round(parsed.data.outcomePrice),
  );
  if (result.refused) return { ok: false, message: result.refused };
  if (!result.negotiation) return { ok: false, message: 'We could not find that negotiation.' };

  revalidatePath(`/property/${result.negotiation.propertyId}/negotiate`);
  return { ok: true, message: 'Updated.' };
};

export const loadNegotiation = async (rawPropertyId: string): Promise<Negotiation | undefined> => {
  const parsed = propertyIdSchema.safeParse(rawPropertyId);
  if (!parsed.success) return undefined;
  const userId = await resolveUserId();
  if (!userId) return undefined;
  return getNegotiationRepository().getForProperty(userId, asId<PropertyId>(parsed.data));
};

export const loadNegotiations = async (): Promise<readonly Negotiation[]> => {
  const userId = await resolveUserId();
  if (!userId) return [];
  return getNegotiationRepository().list(userId);
};
