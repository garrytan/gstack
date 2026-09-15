/**
 * Portfolio persistence.
 *
 * Same pattern as the watchlist: RLS is the authorization boundary, and an
 * in-memory store keeps the flow demonstrable when Supabase is not configured.
 */

import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import type {
  PortfolioAsset,
  PortfolioAssetInput,
  ValuationSource,
} from '@/domain/portfolio/types';
import { VALUATION_SOURCES } from '@/domain/portfolio/types';
import { getServerEnv } from '@/lib/env';
import { createServerClient } from '@/server/supabase';

export interface PortfolioAssetRepository {
  list(userId: UserId): Promise<readonly PortfolioAsset[]>;
  add(userId: UserId, input: PortfolioAssetInput): Promise<PortfolioAsset>;
  remove(userId: UserId, assetId: string): Promise<void>;
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0;

const optionalNum = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : num(v);

const toDomain = (row: Record<string, unknown>): PortfolioAsset => ({
  id: String(row.id),
  userId: asId<UserId>(String(row.user_id)),
  label: String(row.label ?? 'Asset'),
  propertyId: row.property_id ? asId<PropertyId>(String(row.property_id)) : undefined,
  purchasePrice: num(row.purchase_price),
  purchaseDate: String(row.purchase_date).slice(0, 10),
  costBasis: num(row.cost_basis),
  outstandingLoan: num(row.outstanding_loan),
  monthlyRent: num(row.monthly_rent),
  monthlyExpenses: num(row.monthly_expenses),
  currentEstimate: optionalNum(row.current_estimate),
  valuationSource: VALUATION_SOURCES.includes(row.valuation_source as ValuationSource)
    ? (row.valuation_source as ValuationSource)
    : 'userProvided',
  createdAt: String(row.created_at),
});

class SupabasePortfolio implements PortfolioAssetRepository {
  async list(userId: UserId): Promise<readonly PortfolioAsset[]> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('portfolio_assets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Portfolio read failed: ${error.message}`);
    return (data ?? []).map(toDomain);
  }

  async add(userId: UserId, input: PortfolioAssetInput): Promise<PortfolioAsset> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('portfolio_assets')
      .insert({
        user_id: userId,
        label: input.label,
        property_id: input.propertyId ?? null,
        purchase_price: input.purchasePrice,
        purchase_date: input.purchaseDate,
        cost_basis: input.costBasis,
        outstanding_loan: input.outstandingLoan,
        monthly_rent: input.monthlyRent,
        monthly_expenses: input.monthlyExpenses,
        current_estimate: input.currentEstimate ?? null,
        valuation_source: input.valuationSource,
      })
      .select()
      .single();
    if (error) throw new Error(`Portfolio write failed: ${error.message}`);
    return toDomain(data);
  }

  async remove(userId: UserId, assetId: string): Promise<void> {
    const supabase = await createServerClient();
    const { error } = await supabase
      .from('portfolio_assets')
      .delete()
      .eq('user_id', userId)
      .eq('id', assetId);
    if (error) throw new Error(`Portfolio delete failed: ${error.message}`);
  }
}

class MemoryPortfolio implements PortfolioAssetRepository {
  private readonly rows = new Map<string, PortfolioAsset>();

  async list(userId: UserId): Promise<readonly PortfolioAsset[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async add(userId: UserId, input: PortfolioAssetInput): Promise<PortfolioAsset> {
    const entry: PortfolioAsset = {
      ...input,
      id: randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
    };
    this.rows.set(entry.id, entry);
    return entry;
  }

  async remove(userId: UserId, assetId: string): Promise<void> {
    const existing = this.rows.get(assetId);
    // Ownership is checked even in the dev store, so the action behaves the
    // same way in both modes and a bug here cannot pass silently in fixture mode.
    if (existing?.userId === userId) this.rows.delete(assetId);
  }
}

const memoryStore = new MemoryPortfolio();

export const getPortfolioRepository = (): PortfolioAssetRepository =>
  getServerEnv().PROPIQ_DATA_ADAPTER === 'supabase' ? new SupabasePortfolio() : memoryStore;
