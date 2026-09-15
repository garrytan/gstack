/**
 * Buyer profile persistence.
 *
 * The profile is what turns a generic score into a personal one: it feeds
 * persona weighting and every buyer-fit signal. Supabase-backed with RLS doing
 * the authorization; an in-memory store keeps the flow usable in fixture mode.
 */

import 'server-only';
import type { LocalityId, UserId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import type { BuyerProfile, BuyerPersona } from '@/domain/buyer/types';
import { getServerEnv } from '@/lib/env';
import { createServerClient } from '@/server/supabase';

export interface BuyerProfileRepository {
  get(userId: UserId): Promise<BuyerProfile | undefined>;
  save(profile: BuyerProfile): Promise<BuyerProfile>;
  clear(userId: UserId): Promise<void>;
}

/** DB row → domain. A missing column is `undefined`, never a default. */
const toDomain = (row: Record<string, unknown>, userId: UserId): BuyerProfile => {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v)
      ? v
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
        ? Number(v)
        : undefined;

  const workplaceLabel = typeof row.workplace_label === 'string' ? row.workplace_label : undefined;
  const maxCommute = num(row.max_peak_commute_minutes);

  return {
    userId,
    persona: (['homebuyer', 'investor', 'nri'] as const).includes(row.persona as BuyerPersona)
      ? (row.persona as BuyerPersona)
      : 'homebuyer',
    budgetMin: num(row.budget_min) ?? 0,
    budgetMax: num(row.budget_max) ?? 0,
    preferredLocalities: Array.isArray(row.preferred_localities)
      ? (row.preferred_localities as string[]).map((s) => asId<LocalityId>(s))
      : [],
    bedroomsMin: num(row.bedrooms_min),
    bedroomsMax: num(row.bedrooms_max),
    workplace:
      workplaceLabel && maxCommute !== undefined
        ? { label: workplaceLabel, maxPeakCommuteMinutes: maxCommute }
        : undefined,
    needsReadyToMove:
      typeof row.needs_ready_to_move === 'boolean' ? row.needs_ready_to_move : undefined,
    minCarpetEfficiency: num(row.min_carpet_efficiency),
    targetGrossYieldPercent: num(row.target_gross_yield_percent),
    priorities:
      row.priorities && typeof row.priorities === 'object'
        ? (row.priorities as BuyerProfile['priorities'])
        : undefined,
  };
};

const toRow = (p: BuyerProfile) => ({
  user_id: p.userId,
  persona: p.persona,
  budget_min: p.budgetMin,
  budget_max: p.budgetMax,
  preferred_localities: [...p.preferredLocalities],
  bedrooms_min: p.bedroomsMin ?? null,
  bedrooms_max: p.bedroomsMax ?? null,
  workplace_label: p.workplace?.label ?? null,
  max_peak_commute_minutes: p.workplace?.maxPeakCommuteMinutes ?? null,
  needs_ready_to_move: p.needsReadyToMove ?? null,
  min_carpet_efficiency: p.minCarpetEfficiency ?? null,
  target_gross_yield_percent: p.targetGrossYieldPercent ?? null,
  priorities: p.priorities ?? null,
  updated_at: new Date().toISOString(),
});

class SupabaseBuyerProfiles implements BuyerProfileRepository {
  async get(userId: UserId): Promise<BuyerProfile | undefined> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('buyer_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Buyer profile read failed: ${error.message}`);
    return data ? toDomain(data, userId) : undefined;
  }

  async save(profile: BuyerProfile): Promise<BuyerProfile> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('buyer_profiles')
      .upsert(toRow(profile), { onConflict: 'user_id' })
      .select()
      .single();
    if (error) throw new Error(`Buyer profile write failed: ${error.message}`);
    return toDomain(data, profile.userId);
  }

  async clear(userId: UserId): Promise<void> {
    const supabase = await createServerClient();
    const { error } = await supabase.from('buyer_profiles').delete().eq('user_id', userId);
    if (error) throw new Error(`Buyer profile delete failed: ${error.message}`);
  }
}

/** Development-only store. Resets on server restart, by design. */
class MemoryBuyerProfiles implements BuyerProfileRepository {
  private readonly rows = new Map<string, BuyerProfile>();
  async get(userId: UserId) {
    return this.rows.get(userId);
  }
  async save(profile: BuyerProfile) {
    this.rows.set(profile.userId, profile);
    return profile;
  }
  async clear(userId: UserId) {
    this.rows.delete(userId);
  }
}

const memoryStore = new MemoryBuyerProfiles();

export const getBuyerProfileRepository = (): BuyerProfileRepository =>
  getServerEnv().PROPIQ_DATA_ADAPTER === 'supabase' ? new SupabaseBuyerProfiles() : memoryStore;
