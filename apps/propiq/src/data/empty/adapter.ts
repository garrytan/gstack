/**
 * The no-source property repository.
 *
 * A production deployment with no property database connected has nothing to
 * say about Indian property, and this is what saying nothing looks like: every
 * query returns empty, every lookup returns `undefined`. It never falls back to
 * fixtures, which is the whole point — the alternative to real data is silence,
 * not invented data wearing a badge.
 *
 * `servesNoData` lets a surface tell the difference between "your filters
 * matched nothing" and "this deployment has no property source", which are very
 * different sentences to show a buyer.
 */

import type { CityId, DeveloperId, LocalityId, ProjectId, PropertyId } from '@/domain/shared/types';
import type { Developer, Project, Property } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';
import type { Comparable } from '@/domain/valuation/types';
import type { Page, PropertyRepository, PropertySearchQuery } from '../ports';

const EMPTY_PAGE: Page<Property> = { items: [], total: 0, page: 1, pageSize: 0, hasMore: false };

export class EmptyPropertyRepository implements PropertyRepository {
  readonly adapterName = 'none';
  readonly servesDemoData = false;
  readonly servesNoData = true;

  async search(_query: PropertySearchQuery): Promise<Page<Property>> {
    return EMPTY_PAGE;
  }
  async getById(_id: PropertyId): Promise<Property | undefined> {
    return undefined;
  }
  async getManyByIds(_ids: readonly PropertyId[]): Promise<readonly Property[]> {
    return [];
  }
  async getProject(_id: ProjectId): Promise<Project | undefined> {
    return undefined;
  }
  async getDeveloper(_id: DeveloperId): Promise<Developer | undefined> {
    return undefined;
  }
  async getLocality(_id: LocalityId): Promise<Locality | undefined> {
    return undefined;
  }
  async getLocalityBySlug(_slug: string): Promise<Locality | undefined> {
    return undefined;
  }
  async listLocalities(_cityId?: CityId): Promise<readonly Locality[]> {
    return [];
  }
  async getComparables(_id: PropertyId): Promise<readonly Comparable[]> {
    return [];
  }
  async getAlternatives(_id: PropertyId, _limit?: number): Promise<readonly Property[]> {
    return [];
  }
}
