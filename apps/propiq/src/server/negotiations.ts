/**
 * Negotiation persistence.
 *
 * Status changes go through `canTransition` on the way in, so a stored
 * negotiation can never claim a sequence that did not happen.
 */

import 'server-only';
import { randomUUID } from 'node:crypto';
import type { INR, PropertyId, UserId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import type { Negotiation, NegotiationStatus, Offer } from '@/domain/negotiation/types';
import { NEGOTIATION_STATUSES } from '@/domain/negotiation/types';
import { canTransition } from '@/domain/negotiation/engine';
import { getServerEnv } from '@/lib/env';
import { createServerClient } from '@/server/supabase';

export interface NegotiationInput {
  readonly propertyId: PropertyId;
  readonly askingPrice: INR;
  readonly fairValueMid?: INR;
  readonly targetPrice: INR;
  readonly walkAwayPrice: INR;
}

export interface NegotiationRepository {
  list(userId: UserId): Promise<readonly Negotiation[]>;
  getForProperty(userId: UserId, propertyId: PropertyId): Promise<Negotiation | undefined>;
  start(userId: UserId, input: NegotiationInput): Promise<Negotiation>;
  addOffer(userId: UserId, id: string, offer: Omit<Offer, 'id'>): Promise<Negotiation | undefined>;
  setStatus(
    userId: UserId,
    id: string,
    status: NegotiationStatus,
    outcomePrice?: INR,
  ): Promise<{ negotiation?: Negotiation; refused?: string }>;
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0;

const toDomain = (row: Record<string, unknown>): Negotiation => ({
  id: String(row.id),
  userId: asId<UserId>(String(row.user_id)),
  propertyId: asId<PropertyId>(String(row.property_id)),
  askingPrice: num(row.asking_price),
  fairValueMid:
    row.fair_value_mid === null || row.fair_value_mid === undefined
      ? undefined
      : num(row.fair_value_mid),
  targetPrice: num(row.target_price),
  walkAwayPrice: num(row.walk_away_price),
  status: NEGOTIATION_STATUSES.includes(row.status as NegotiationStatus)
    ? (row.status as NegotiationStatus)
    : 'preparing',
  offers: Array.isArray(row.offers) ? (row.offers as Offer[]) : [],
  outcomePrice:
    row.outcome_price === null || row.outcome_price === undefined
      ? undefined
      : num(row.outcome_price),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

/** Shared transition guard so both adapters enforce the same rule. */
const applyTransition = (
  current: Negotiation,
  status: NegotiationStatus,
  outcomePrice?: INR,
): { negotiation?: Negotiation; refused?: string } => {
  if (current.status === status) return { negotiation: current };
  if (!canTransition(current.status, status)) {
    return {
      refused: `A negotiation that is "${current.status}" cannot move to "${status}".`,
    };
  }
  return {
    negotiation: {
      ...current,
      status,
      outcomePrice: outcomePrice ?? current.outcomePrice,
      updatedAt: new Date().toISOString(),
    },
  };
};

class SupabaseNegotiations implements NegotiationRepository {
  async list(userId: UserId) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('negotiations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw new Error(`Negotiation read failed: ${error.message}`);
    return (data ?? []).map(toDomain);
  }

  async getForProperty(userId: UserId, propertyId: PropertyId) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('negotiations')
      .select('*')
      .eq('user_id', userId)
      .eq('property_id', propertyId)
      .maybeSingle();
    if (error) throw new Error(`Negotiation read failed: ${error.message}`);
    return data ? toDomain(data) : undefined;
  }

  async start(userId: UserId, input: NegotiationInput) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('negotiations')
      .upsert(
        {
          user_id: userId,
          property_id: input.propertyId,
          asking_price: input.askingPrice,
          fair_value_mid: input.fairValueMid ?? null,
          target_price: input.targetPrice,
          walk_away_price: input.walkAwayPrice,
          status: 'preparing',
          offers: [],
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,property_id' },
      )
      .select()
      .single();
    if (error) throw new Error(`Negotiation write failed: ${error.message}`);
    return toDomain(data);
  }

  private async persist(userId: UserId, negotiation: Negotiation) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('negotiations')
      .update({
        status: negotiation.status,
        offers: negotiation.offers,
        outcome_price: negotiation.outcomePrice ?? null,
        updated_at: negotiation.updatedAt,
      })
      .eq('user_id', userId)
      .eq('id', negotiation.id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`Negotiation update failed: ${error.message}`);
    return data ? toDomain(data) : undefined;
  }

  private async byId(userId: UserId, id: string): Promise<Negotiation | undefined> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('negotiations')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Negotiation read failed: ${error.message}`);
    return data ? toDomain(data) : undefined;
  }

  async addOffer(userId: UserId, id: string, offer: Omit<Offer, 'id'>) {
    const current = await this.byId(userId, id);
    if (!current) return undefined;
    // An offer implies the status: a buyer offer opens, a seller reply counters.
    const nextStatus: NegotiationStatus = offer.party === 'buyer' ? 'offerMade' : 'countered';
    const transitioned = canTransition(current.status, nextStatus) ? nextStatus : current.status;
    return this.persist(userId, {
      ...current,
      offers: [...current.offers, { ...offer, id: randomUUID() }],
      status: transitioned,
      updatedAt: new Date().toISOString(),
    });
  }

  async setStatus(userId: UserId, id: string, status: NegotiationStatus, outcomePrice?: INR) {
    const current = await this.byId(userId, id);
    if (!current) return {};
    const result = applyTransition(current, status, outcomePrice);
    if (!result.negotiation) return result;
    return { negotiation: await this.persist(userId, result.negotiation) };
  }
}

class MemoryNegotiations implements NegotiationRepository {
  private readonly rows = new Map<string, Negotiation>();

  private owned(userId: UserId, id: string) {
    const row = this.rows.get(id);
    return row?.userId === userId ? row : undefined;
  }

  async list(userId: UserId) {
    return [...this.rows.values()]
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getForProperty(userId: UserId, propertyId: PropertyId) {
    return (await this.list(userId)).find((n) => n.propertyId === propertyId);
  }

  async start(userId: UserId, input: NegotiationInput) {
    const existing = await this.getForProperty(userId, input.propertyId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const negotiation: Negotiation = {
      id: randomUUID(),
      userId,
      status: 'preparing',
      offers: [],
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.rows.set(negotiation.id, negotiation);
    return negotiation;
  }

  async addOffer(userId: UserId, id: string, offer: Omit<Offer, 'id'>) {
    const current = this.owned(userId, id);
    if (!current) return undefined;
    const nextStatus: NegotiationStatus = offer.party === 'buyer' ? 'offerMade' : 'countered';
    const updated: Negotiation = {
      ...current,
      offers: [...current.offers, { ...offer, id: randomUUID() }],
      status: canTransition(current.status, nextStatus) ? nextStatus : current.status,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async setStatus(userId: UserId, id: string, status: NegotiationStatus, outcomePrice?: INR) {
    const current = this.owned(userId, id);
    if (!current) return {};
    const result = applyTransition(current, status, outcomePrice);
    if (result.negotiation) this.rows.set(id, result.negotiation);
    return result;
  }
}

const memoryStore = new MemoryNegotiations();

export const getNegotiationRepository = (): NegotiationRepository =>
  getServerEnv().PROPIQ_DATA_ADAPTER === 'supabase' ? new SupabaseNegotiations() : memoryStore;
