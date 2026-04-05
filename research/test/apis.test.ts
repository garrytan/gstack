import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import {
  searchSemanticScholar,
  searchPubMed,
  searchArxiv,
  searchOpenAlex,
  searchAll,
} from '../src/apis';
import type { SearchCriteria } from '../src/types';

const baseCriteria: SearchCriteria = {
  query: 'machine learning',
  maxPerSource: 10,
};

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('searchSemanticScholar', () => {
  test('parses valid response', async () => {
    mockFetch(() => new Response(JSON.stringify({
      data: [{
        paperId: 'abc123',
        title: 'Test Paper',
        authors: [{ name: 'J. Doe' }],
        abstract: 'An abstract.',
        year: 2023,
        externalIds: { DOI: '10.1234/test' },
        url: 'https://example.com',
        citationCount: 42,
        venue: 'NeurIPS',
        publicationDate: '2023-06-15',
      }],
    })));

    const result = await searchSemanticScholar(baseCriteria);
    expect(result.source.status).toBe('success');
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].id).toBe('semantic_scholar:abc123');
    expect(result.papers[0].doi).toBe('10.1234/test');
    expect(result.papers[0].citations).toBe(42);
  });

  test('handles empty response', async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [] })));
    const result = await searchSemanticScholar(baseCriteria);
    expect(result.source.status).toBe('success');
    expect(result.papers).toHaveLength(0);
  });

  test('handles network error', async () => {
    mockFetch(() => { throw new Error('network failure'); });
    const result = await searchSemanticScholar(baseCriteria);
    expect(result.source.status).toBe('error');
    expect(result.source.error).toContain('network failure');
  });
});

describe('searchPubMed', () => {
  test('parses search + summary response', async () => {
    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      if (url.includes('esearch')) {
        return new Response(JSON.stringify({
          esearchresult: { idlist: ['12345'] },
        }));
      }
      return new Response(JSON.stringify({
        result: {
          '12345': {
            title: 'PubMed Paper',
            authors: [{ name: 'Smith A' }],
            pubdate: '2023 Mar',
            source: 'Nature',
            articleids: [{ idtype: 'doi', value: '10.1038/test' }],
          },
        },
      }));
    });

    const result = await searchPubMed(baseCriteria);
    expect(result.source.status).toBe('success');
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].id).toBe('pubmed:12345');
    expect(result.papers[0].doi).toBe('10.1038/test');
  });
});

describe('searchArxiv', () => {
  test('parses Atom XML response', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/abs/2301.00001v1</id>
  <title>ArXiv Test Paper</title>
  <summary>An arxiv abstract.</summary>
  <author><name>Alice Bob</name></author>
  <published>2023-01-15T00:00:00Z</published>
</entry>
</feed>`;
    mockFetch(() => new Response(xml));

    const result = await searchArxiv(baseCriteria);
    expect(result.source.status).toBe('success');
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].id).toBe('arxiv:2301.00001');
    expect(result.papers[0].title).toBe('ArXiv Test Paper');
  });
});

describe('searchOpenAlex', () => {
  test('parses response with inverted abstract index', async () => {
    mockFetch(() => new Response(JSON.stringify({
      results: [{
        id: 'https://openalex.org/W123',
        title: 'OpenAlex Paper',
        authorships: [{
          author: { display_name: 'Test Author' },
          institutions: [{ display_name: 'MIT' }],
        }],
        abstract_inverted_index: { 'hello': [0], 'world': [1] },
        publication_year: 2023,
        doi: 'https://doi.org/10.5555/test',
        cited_by_count: 10,
        primary_location: {
          landing_page_url: 'https://example.com/paper',
          source: { display_name: 'Science' },
        },
        publication_date: '2023-03-01',
      }],
    })));

    const result = await searchOpenAlex(baseCriteria);
    expect(result.source.status).toBe('success');
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].id).toBe('openalex:W123');
    expect(result.papers[0].abstract).toBe('hello world');
    expect(result.papers[0].doi).toBe('10.5555/test');
    expect(result.papers[0].authors[0].affiliations).toEqual(['MIT']);
  });
});

describe('searchAll', () => {
  test('searches multiple sources and aggregates results', async () => {
    mockFetch((url) => {
      if (url.includes('semanticscholar')) {
        return new Response(JSON.stringify({ data: [{ paperId: 's1', title: 'S2 Paper', year: 2023 }] }));
      }
      if (url.includes('eutils') && url.includes('esearch')) {
        return new Response(JSON.stringify({ esearchresult: { idlist: [] } }));
      }
      if (url.includes('arxiv')) {
        return new Response('<feed></feed>');
      }
      if (url.includes('openalex')) {
        return new Response(JSON.stringify({ results: [] }));
      }
      return new Response('', { status: 404 });
    });

    const result = await searchAll({
      ...baseCriteria,
      sources: ['semantic_scholar', 'pubmed', 'arxiv', 'openalex'],
    });
    expect(result.sources).toHaveLength(4);
    expect(result.papers.length).toBeGreaterThanOrEqual(1);
  });
});
