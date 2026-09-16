/**
 * Production property repository (Supabase).
 *
 * This is the contract any real data source must satisfy. It reads the
 * canonical schema in `supabase/migrations` and maps rows onto domain types.
 *
 * Two rules it enforces at the boundary:
 *  1. It never emits `dataStatus: 'demo'`. A row that somehow carries that
 *     status is dropped rather than served, because demo data escaping into a
 *     production response is the single failure mode this whole layer exists
 *     to prevent.
 *  2. It never substitutes a default for a missing fact. Absent columns map to
 *     `undefined` and the scoring layer treats them as unknown.
 */

import 'server-only';
import type { CityId, DeveloperId, LocalityId, ProjectId, PropertyId } from '@/domain/shared/types';
import { asId } from '@/domain/shared/types';
import type { Developer, Project, Property } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';
import type { Comparable } from '@/domain/valuation/types';
import { createServerClient } from '@/server/supabase';
import type { Page, PropertyRepository, PropertySearchQuery } from '../ports';
import {
  mapComparableRow,
  mapDeveloperRow,
  mapLocalityRow,
  mapProjectRow,
  mapPropertyRow,
} from './mappers';

const DEFAULT_PAGE_SIZE = 12;

export class SupabasePropertyRepository implements PropertyRepository {
  readonly adapterName = 'supabase';
  readonly servesDemoData = false;
  readonly servesNoData = false;

  private async client() {
    return createServerClient();
  }

  async search(query: PropertySearchQuery): Promise<Page<Property>> {
    const supabase = await this.client();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(48, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
    const from = (page - 1) * pageSize;

    let q = supabase
      .from('properties')
      .select('*, evidence:evidence(*)', { count: 'exact' })
      // Demo rows are excluded at the query level, not filtered afterwards.
      .neq('data_status', 'demo');

    if (query.cityId) q = q.eq('city_id', query.cityId);
    if (query.localityIds?.length) q = q.in('locality_id', [...query.localityIds] as string[]);
    if (query.priceMin !== undefined) q = q.gte('asking_price', query.priceMin);
    if (query.priceMax !== undefined) q = q.lte('asking_price', query.priceMax);
    if (query.bedroomsMin !== undefined) q = q.gte('bedrooms', query.bedroomsMin);
    if (query.bedroomsMax !== undefined) q = q.lte('bedrooms', query.bedroomsMax);
    if (query.kinds?.length) q = q.in('kind', [...query.kinds] as string[]);
    if (query.constructionStatus?.length) {
      q = q.in('construction_status', [...query.constructionStatus] as string[]);
    }
    if (query.text) q = q.textSearch('search_vector', query.text, { type: 'websearch' });

    switch (query.sort) {
      case 'priceAsc':
        q = q.order('asking_price', { ascending: true });
        break;
      case 'priceDesc':
        q = q.order('asking_price', { ascending: false });
        break;
      case 'newest':
        q = q.order('listed_at', { ascending: false, nullsFirst: false });
        break;
      default:
        q = q.order('listed_at', { ascending: false, nullsFirst: false });
        break;
    }

    const { data, error, count } = await q.range(from, from + pageSize - 1);
    if (error) throw new Error(`Property search failed: ${error.message}`);

    const items = (data ?? []).map(mapPropertyRow).filter((p) => p.dataStatus !== 'demo');
    const total = count ?? items.length;
    return { items, total, page, pageSize, hasMore: from + pageSize < total };
  }

  async getById(id: PropertyId): Promise<Property | undefined> {
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('properties')
      .select('*, evidence:evidence(*)')
      .eq('id', id)
      .neq('data_status', 'demo')
      .maybeSingle();
    if (error) throw new Error(`Property lookup failed: ${error.message}`);
    return data ? mapPropertyRow(data) : undefined;
  }

  async getManyByIds(ids: readonly PropertyId[]): Promise<readonly Property[]> {
    if (ids.length === 0) return [];
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('properties')
      .select('*, evidence:evidence(*)')
      .in('id', [...ids] as string[])
      .neq('data_status', 'demo');
    if (error) throw new Error(`Property batch lookup failed: ${error.message}`);
    const byId = new Map((data ?? []).map((row) => [row.id as string, mapPropertyRow(row)]));
    // Caller ordering is load-bearing for comparison columns.
    return ids.map((id) => byId.get(id)).filter((p): p is Property => p !== undefined);
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('projects')
      .select('*, phases:project_phases(*), towers:project_towers(*)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Project lookup failed: ${error.message}`);
    return data ? mapProjectRow(data) : undefined;
  }

  async getDeveloper(id: DeveloperId): Promise<Developer | undefined> {
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('developers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Developer lookup failed: ${error.message}`);
    return data ? mapDeveloperRow(data) : undefined;
  }

  async getLocality(id: LocalityId): Promise<Locality | undefined> {
    return this.fetchLocality('id', id);
  }

  async getLocalityBySlug(slug: string): Promise<Locality | undefined> {
    return this.fetchLocality('slug', slug);
  }

  private async fetchLocality(column: 'id' | 'slug', value: string): Promise<Locality | undefined> {
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('localities')
      .select('*, price_history:locality_price_points(*), pipeline:locality_pipeline(*)')
      .eq(column, value)
      .maybeSingle();
    if (error) throw new Error(`Locality lookup failed: ${error.message}`);
    return data ? mapLocalityRow(data) : undefined;
  }

  async listLocalities(cityId?: CityId): Promise<readonly Locality[]> {
    const supabase = await this.client();
    let q = supabase
      .from('localities')
      .select('*, price_history:locality_price_points(*), pipeline:locality_pipeline(*)');
    if (cityId) q = q.eq('city_id', cityId);
    const { data, error } = await q.order('name');
    if (error) throw new Error(`Locality listing failed: ${error.message}`);
    return (data ?? []).map(mapLocalityRow);
  }

  async getComparables(id: PropertyId): Promise<readonly Comparable[]> {
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('comparables')
      .select('*')
      .eq('subject_property_id', id)
      .neq('data_status', 'demo')
      .order('observed_at', { ascending: false })
      .limit(25);
    if (error) throw new Error(`Comparable lookup failed: ${error.message}`);
    return (data ?? []).map(mapComparableRow);
  }

  async getAlternatives(id: PropertyId, limit = 3): Promise<readonly Property[]> {
    const subject = await this.getById(id);
    if (!subject) return [];
    const supabase = await this.client();
    const { data, error } = await supabase
      .from('properties')
      .select('*, evidence:evidence(*)')
      .eq('bedrooms', subject.bedrooms)
      .eq('city_id', subject.cityId)
      .neq('id', subject.id)
      .neq('data_status', 'demo')
      .gte('asking_price', Math.round(subject.askingPrice * 0.7))
      .lte('asking_price', Math.round(subject.askingPrice * 1.3))
      .limit(limit * 3);
    if (error) throw new Error(`Alternatives lookup failed: ${error.message}`);
    return (data ?? [])
      .map(mapPropertyRow)
      .sort(
        (a, b) =>
          Math.abs(a.askingPrice - subject.askingPrice) -
          Math.abs(b.askingPrice - subject.askingPrice),
      )
      .slice(0, limit);
  }
}

/** Re-exported so callers can construct branded IDs from route params. */
export const toPropertyId = (raw: string): PropertyId => asId<PropertyId>(raw);
