/**
 * Site visit persistence.
 *
 * Same pattern as the rest of the user-owned stores: RLS is the authorization
 * boundary, with an in-memory stand-in when Supabase is not configured. The
 * dev store checks ownership too, so a bug cannot pass silently in fixture
 * mode and then fail in production.
 */

import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import type { SiteVisit, VisitObservation, VisitStatus } from '@/domain/visits/types';
import { VISIT_STATUSES } from '@/domain/visits/types';
import { getServerEnv } from '@/lib/env';
import { createServerClient } from '@/server/supabase';

export interface SiteVisitRepository {
  list(userId: UserId): Promise<readonly SiteVisit[]>;
  listForProperty(userId: UserId, propertyId: PropertyId): Promise<readonly SiteVisit[]>;
  get(userId: UserId, visitId: string): Promise<SiteVisit | undefined>;
  schedule(userId: UserId, propertyId: PropertyId, scheduledFor: string): Promise<SiteVisit>;
  complete(
    userId: UserId,
    visitId: string,
    observations: readonly VisitObservation[],
    overallNote?: string,
  ): Promise<SiteVisit | undefined>;
  cancel(userId: UserId, visitId: string): Promise<void>;
}

const toDomain = (row: Record<string, unknown>): SiteVisit => ({
  id: String(row.id),
  userId: asId<UserId>(String(row.user_id)),
  propertyId: asId<PropertyId>(String(row.property_id)),
  scheduledFor: String(row.scheduled_for).slice(0, 10),
  status: VISIT_STATUSES.includes(row.status as VisitStatus)
    ? (row.status as VisitStatus)
    : 'scheduled',
  completedAt: row.completed_at ? String(row.completed_at) : undefined,
  observations: Array.isArray(row.observations) ? (row.observations as VisitObservation[]) : [],
  overallNote: row.overall_note ? String(row.overall_note) : undefined,
  createdAt: String(row.created_at),
});

class SupabaseVisits implements SiteVisitRepository {
  async list(userId: UserId) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('site_visits')
      .select('*')
      .eq('user_id', userId)
      .order('scheduled_for', { ascending: false });
    if (error) throw new Error(`Visit read failed: ${error.message}`);
    return (data ?? []).map(toDomain);
  }

  async listForProperty(userId: UserId, propertyId: PropertyId) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('site_visits')
      .select('*')
      .eq('user_id', userId)
      .eq('property_id', propertyId)
      .order('scheduled_for', { ascending: false });
    if (error) throw new Error(`Visit read failed: ${error.message}`);
    return (data ?? []).map(toDomain);
  }

  async get(userId: UserId, visitId: string) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('site_visits')
      .select('*')
      .eq('user_id', userId)
      .eq('id', visitId)
      .maybeSingle();
    if (error) throw new Error(`Visit read failed: ${error.message}`);
    return data ? toDomain(data) : undefined;
  }

  async schedule(userId: UserId, propertyId: PropertyId, scheduledFor: string) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('site_visits')
      .insert({
        user_id: userId,
        property_id: propertyId,
        scheduled_for: scheduledFor,
        status: 'scheduled',
        observations: [],
      })
      .select()
      .single();
    if (error) throw new Error(`Visit write failed: ${error.message}`);
    return toDomain(data);
  }

  async complete(
    userId: UserId,
    visitId: string,
    observations: readonly VisitObservation[],
    overallNote?: string,
  ) {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('site_visits')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        observations,
        overall_note: overallNote ?? null,
      })
      .eq('user_id', userId)
      .eq('id', visitId)
      .select()
      .maybeSingle();
    if (error) throw new Error(`Visit update failed: ${error.message}`);
    return data ? toDomain(data) : undefined;
  }

  async cancel(userId: UserId, visitId: string) {
    const supabase = await createServerClient();
    const { error } = await supabase
      .from('site_visits')
      .update({ status: 'cancelled' })
      .eq('user_id', userId)
      .eq('id', visitId);
    if (error) throw new Error(`Visit cancel failed: ${error.message}`);
  }
}

class MemoryVisits implements SiteVisitRepository {
  private readonly rows = new Map<string, SiteVisit>();

  private owned(userId: UserId, visitId: string): SiteVisit | undefined {
    const row = this.rows.get(visitId);
    return row?.userId === userId ? row : undefined;
  }

  async list(userId: UserId) {
    return [...this.rows.values()]
      .filter((v) => v.userId === userId)
      .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
  }

  async listForProperty(userId: UserId, propertyId: PropertyId) {
    return (await this.list(userId)).filter((v) => v.propertyId === propertyId);
  }

  async get(userId: UserId, visitId: string) {
    return this.owned(userId, visitId);
  }

  async schedule(userId: UserId, propertyId: PropertyId, scheduledFor: string) {
    const visit: SiteVisit = {
      id: randomUUID(),
      userId,
      propertyId,
      scheduledFor,
      status: 'scheduled',
      observations: [],
      createdAt: new Date().toISOString(),
    };
    this.rows.set(visit.id, visit);
    return visit;
  }

  async complete(
    userId: UserId,
    visitId: string,
    observations: readonly VisitObservation[],
    overallNote?: string,
  ) {
    const existing = this.owned(userId, visitId);
    if (!existing) return undefined;
    const updated: SiteVisit = {
      ...existing,
      status: 'completed',
      completedAt: new Date().toISOString(),
      observations,
      overallNote,
    };
    this.rows.set(visitId, updated);
    return updated;
  }

  async cancel(userId: UserId, visitId: string) {
    const existing = this.owned(userId, visitId);
    if (existing) this.rows.set(visitId, { ...existing, status: 'cancelled' });
  }
}

const memoryStore = new MemoryVisits();

export const getVisitRepository = (): SiteVisitRepository =>
  getServerEnv().PROPIQ_DATA_ADAPTER === 'supabase' ? new SupabaseVisits() : memoryStore;
