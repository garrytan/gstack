/**
 * Fixture property repository.
 *
 * Serves the labelled demo dataset. `servesDemoData` is true so every surface
 * that renders its output can show the DEMO DATA badge without having to
 * inspect individual records.
 */

import type { CityId, DeveloperId, LocalityId, ProjectId, PropertyId } from '@/domain/shared/types';
import type { Developer, Project, Property } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';
import type { Comparable } from '@/domain/valuation/types';
import type { Page, PropertyRepository, PropertySearchQuery } from '../ports';
import { DEMO_LOCALITIES } from './localities';
import { DEMO_DEVELOPERS, DEMO_PROJECTS, DEMO_PROPERTIES, demoComparables } from './properties';

const DEFAULT_PAGE_SIZE = 12;

const matchesText = (property: Property, project: Project | undefined, text: string): boolean => {
  const haystack = [property.title, project?.name ?? '', property.localityId, property.kind]
    .join(' ')
    .toLowerCase();
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
};

export class FixturePropertyRepository implements PropertyRepository {
  readonly adapterName = 'fixture';
  readonly servesDemoData = true;

  async search(query: PropertySearchQuery): Promise<Page<Property>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(48, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    let items = DEMO_PROPERTIES.filter((p) => {
      if (query.cityId && p.cityId !== query.cityId) return false;
      if (query.localityIds?.length && !query.localityIds.includes(p.localityId)) return false;
      if (query.priceMin !== undefined && p.askingPrice < query.priceMin) return false;
      if (query.priceMax !== undefined && p.askingPrice > query.priceMax) return false;
      if (query.bedroomsMin !== undefined && p.bedrooms < query.bedroomsMin) return false;
      if (query.bedroomsMax !== undefined && p.bedrooms > query.bedroomsMax) return false;
      if (query.kinds?.length && !query.kinds.includes(p.kind)) return false;
      if (
        query.constructionStatus?.length &&
        !query.constructionStatus.includes(p.constructionStatus)
      ) {
        return false;
      }
      if (query.text) {
        const project = DEMO_PROJECTS.find((pr) => pr.id === p.projectId);
        if (!matchesText(p, project, query.text)) return false;
      }
      return true;
    });

    switch (query.sort) {
      case 'priceAsc':
        items = [...items].sort((a, b) => a.askingPrice - b.askingPrice);
        break;
      case 'priceDesc':
        items = [...items].sort((a, b) => b.askingPrice - a.askingPrice);
        break;
      case 'newest':
        items = [...items].sort((a, b) => (b.listedAt ?? '').localeCompare(a.listedAt ?? ''));
        break;
      default:
        // Relevance and score ordering are applied by the caller, which has the
        // scored records. The repository stays a pure data port.
        break;
    }

    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      hasMore: start + pageSize < total,
    };
  }

  async getById(id: PropertyId): Promise<Property | undefined> {
    return DEMO_PROPERTIES.find((p) => p.id === id);
  }

  async getManyByIds(ids: readonly PropertyId[]): Promise<readonly Property[]> {
    const set = new Set<string>(ids);
    // Preserve the caller's ordering — comparison columns depend on it.
    return ids
      .map((id) => DEMO_PROPERTIES.find((p) => p.id === id))
      .filter((p): p is Property => p !== undefined && set.has(p.id));
  }

  async getProject(id: ProjectId): Promise<Project | undefined> {
    return DEMO_PROJECTS.find((p) => p.id === id);
  }

  async getDeveloper(id: DeveloperId): Promise<Developer | undefined> {
    return DEMO_DEVELOPERS.find((d) => d.id === id);
  }

  async getLocality(id: LocalityId): Promise<Locality | undefined> {
    return DEMO_LOCALITIES.find((l) => l.id === id);
  }

  async getLocalityBySlug(slug: string): Promise<Locality | undefined> {
    return DEMO_LOCALITIES.find((l) => l.slug === slug);
  }

  async listLocalities(cityId?: CityId): Promise<readonly Locality[]> {
    return cityId ? DEMO_LOCALITIES.filter((l) => l.cityId === cityId) : DEMO_LOCALITIES;
  }

  async getComparables(id: PropertyId): Promise<readonly Comparable[]> {
    const property = await this.getById(id);
    if (!property) return [];
    const locality = await this.getLocality(property.localityId);
    const median = locality?.currentMedianPricePerSqFt;
    if (!median) return [];
    const carpet = property.carpetAreaSqFt ?? property.areaSqFt * 0.71;
    return demoComparables(property.id, median, carpet);
  }

  async getAlternatives(id: PropertyId, limit = 3): Promise<readonly Property[]> {
    const subject = await this.getById(id);
    if (!subject) return [];
    // Alternatives are same-bedroom units within ±30% of the asking price,
    // ordered by how close they sit to the subject on price.
    return DEMO_PROPERTIES.filter(
      (p) =>
        p.id !== subject.id &&
        p.bedrooms === subject.bedrooms &&
        Math.abs(p.askingPrice - subject.askingPrice) / subject.askingPrice <= 0.3,
    )
      .sort(
        (a, b) =>
          Math.abs(a.askingPrice - subject.askingPrice) -
          Math.abs(b.askingPrice - subject.askingPrice),
      )
      .slice(0, limit);
  }
}
