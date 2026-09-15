/**
 * Watchlist persistence.
 *
 * Supabase-backed with RLS doing the authorization: every query is scoped to
 * `auth.uid()` in the policy, so a user cannot read or write another user's
 * rows even if this code passed the wrong id. The check here is defence in
 * depth, not the security boundary.
 *
 * When Supabase is not configured (fixture mode), an in-memory store keeps the
 * flow demonstrable in development. It is explicitly per-process and is never
 * used when `PROPIQ_DATA_ADAPTER=supabase`.
 */

import 'server-only';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { getServerEnv } from '@/lib/env';
import { createServerClient } from '@/server/supabase';
import type { WatchlistEntry, WatchlistRepository } from '@/data/ports';

class SupabaseWatchlist implements WatchlistRepository {
  async list(userId: UserId): Promise<readonly WatchlistEntry[]> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Watchlist read failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id) as UserId,
      propertyId: String(row.property_id) as PropertyId,
      note: row.note ? String(row.note) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  async add(userId: UserId, propertyId: PropertyId, note?: string): Promise<WatchlistEntry> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('watchlist')
      .upsert(
        { user_id: userId, property_id: propertyId, note: note ?? null },
        { onConflict: 'user_id,property_id' },
      )
      .select()
      .single();
    if (error) throw new Error(`Watchlist write failed: ${error.message}`);
    return {
      id: String(data.id),
      userId,
      propertyId,
      note: data.note ? String(data.note) : undefined,
      createdAt: String(data.created_at),
    };
  }

  async remove(userId: UserId, propertyId: PropertyId): Promise<void> {
    const supabase = await createServerClient();
    const { error } = await supabase
      .from('watchlist')
      .delete()
      .eq('user_id', userId)
      .eq('property_id', propertyId);
    if (error) throw new Error(`Watchlist delete failed: ${error.message}`);
  }

  async has(userId: UserId, propertyId: PropertyId): Promise<boolean> {
    const supabase = await createServerClient();
    const { count, error } = await supabase
      .from('watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('property_id', propertyId);
    if (error) return false;
    return (count ?? 0) > 0;
  }
}

/** Development-only store. Resets on every server restart, by design. */
class MemoryWatchlist implements WatchlistRepository {
  private readonly rows = new Map<string, WatchlistEntry>();
  private key(userId: string, propertyId: string) {
    return `${userId}::${propertyId}`;
  }

  async list(userId: UserId): Promise<readonly WatchlistEntry[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async add(userId: UserId, propertyId: PropertyId, note?: string): Promise<WatchlistEntry> {
    const entry: WatchlistEntry = {
      id: this.key(userId, propertyId),
      userId,
      propertyId,
      note,
      createdAt: new Date().toISOString(),
    };
    this.rows.set(entry.id, entry);
    return entry;
  }

  async remove(userId: UserId, propertyId: PropertyId): Promise<void> {
    this.rows.delete(this.key(userId, propertyId));
  }

  async has(userId: UserId, propertyId: PropertyId): Promise<boolean> {
    return this.rows.has(this.key(userId, propertyId));
  }
}

const memoryStore = new MemoryWatchlist();

export const getWatchlistRepository = (): WatchlistRepository =>
  getServerEnv().PROPIQ_DATA_ADAPTER === 'supabase' ? new SupabaseWatchlist() : memoryStore;
