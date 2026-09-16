/**
 * Notification inbox.
 *
 * The in-app channel is the one delivery path that needs no third-party
 * account, which makes it the floor: however the deployment is configured,
 * a user who watches a property and sees it move will find that move recorded
 * somewhere they can read it.
 *
 * Authorization is RLS, scoped to `auth.uid()`. The `user_id` filters here are
 * defence in depth, not the boundary.
 */

import 'server-only';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { getServerEnv } from '@/lib/env';
import { createServerClient } from '@/server/supabase';
import type { NewNotification, NotificationRecord, NotificationRepository } from '@/data/ports';

const DEFAULT_LIMIT = 100;

/** The day a notification belongs to, used as the idempotency bucket. */
const dayOf = (iso: string): string => iso.slice(0, 10);

const dedupeKey = (userId: string, n: NewNotification, day: string): string =>
  [userId, n.propertyId ?? '-', n.kind, n.rule, day].join('::');

type Row = Record<string, unknown>;

const toRecord = (row: Row): NotificationRecord => ({
  id: String(row.id),
  userId: String(row.user_id) as UserId,
  propertyId: row.property_id ? (String(row.property_id) as PropertyId) : undefined,
  kind: String(row.kind),
  severity: String(row.severity) as NotificationRecord['severity'],
  headline: String(row.headline),
  detail: String(row.detail),
  rule: String(row.rule),
  createdAt: String(row.created_at),
  readAt: row.read_at ? String(row.read_at) : undefined,
});

class SupabaseNotifications implements NotificationRepository {
  async list(userId: UserId, limit = DEFAULT_LIMIT): Promise<readonly NotificationRecord[]> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Notification read failed: ${error.message}`);
    return (data ?? []).map(toRecord);
  }

  async add(
    userId: UserId,
    records: readonly NewNotification[],
  ): Promise<readonly NotificationRecord[]> {
    if (records.length === 0) return [];
    const supabase = await createServerClient();
    const rows = records.map((n) => ({
      user_id: userId,
      property_id: n.propertyId ?? null,
      kind: n.kind,
      severity: n.severity,
      headline: n.headline,
      detail: n.detail,
      rule: n.rule,
      // Written explicitly rather than defaulted: it is half of the uniqueness
      // key that makes a double-fired scheduler harmless.
      dedupe_day: dayOf(new Date().toISOString()),
    }));
    const { data, error } = await supabase
      .from('notifications')
      .upsert(rows, {
        onConflict: 'user_id,property_id,kind,rule,dedupe_day',
        ignoreDuplicates: true,
      })
      .select();
    if (error) throw new Error(`Notification write failed: ${error.message}`);
    return (data ?? []).map(toRecord);
  }

  async markAllRead(userId: UserId, now: string): Promise<number> {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('notifications')
      .update({ read_at: now })
      .eq('user_id', userId)
      .is('read_at', null)
      .select('id');
    if (error) throw new Error(`Notification update failed: ${error.message}`);
    return (data ?? []).length;
  }

  async unreadCount(userId: UserId): Promise<number> {
    const supabase = await createServerClient();
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null);
    if (error) return 0;
    return count ?? 0;
  }
}

/** Development-only store. Resets on every server restart, by design. */
class MemoryNotifications implements NotificationRepository {
  private readonly rows = new Map<string, NotificationRecord>();
  private seq = 0;

  async list(userId: UserId, limit = DEFAULT_LIMIT): Promise<readonly NotificationRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async add(
    userId: UserId,
    records: readonly NewNotification[],
  ): Promise<readonly NotificationRecord[]> {
    const now = new Date().toISOString();
    const day = dayOf(now);
    const written: NotificationRecord[] = [];
    for (const n of records) {
      const key = dedupeKey(userId, n, day);
      if (this.rows.has(key)) continue;
      this.seq += 1;
      const record: NotificationRecord = {
        ...n,
        id: `mem-${this.seq}`,
        userId,
        // Ordering within one batch must be stable and distinct, or the list
        // view shuffles rows that all landed in the same millisecond.
        createdAt: new Date(Date.parse(now) + this.seq).toISOString(),
        readAt: undefined,
      };
      this.rows.set(key, record);
      written.push(record);
    }
    return written;
  }

  async markAllRead(userId: UserId, now: string): Promise<number> {
    let changed = 0;
    for (const [key, row] of this.rows) {
      if (row.userId !== userId || row.readAt) continue;
      this.rows.set(key, { ...row, readAt: now });
      changed += 1;
    }
    return changed;
  }

  async unreadCount(userId: UserId): Promise<number> {
    return [...this.rows.values()].filter((r) => r.userId === userId && !r.readAt).length;
  }
}

const memoryStore = new MemoryNotifications();

export const getNotificationRepository = (): NotificationRepository =>
  getServerEnv().PROPIQ_DATA_ADAPTER === 'supabase' ? new SupabaseNotifications() : memoryStore;
