/**
 * Academic API clients: Semantic Scholar, PubMed, arXiv, OpenAlex.
 * All normalize responses to PaperRecord format.
 * Exponential backoff with 3 retries, 30s timeout per request.
 */

import type { ApiSource, Author, PaperRecord, SearchCriteria, SourceRecord } from './types';

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return response;
      if (response.status === 429) {
        // Rate limited -- back off and retry
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error('fetch failed');
}

// ─── Semantic Scholar ─────────────────────────────────────────

interface S2Paper {
  paperId: string;
  title: string;
  authors?: Array<{ name: string; affiliations?: string[] }>;
  abstract?: string;
  year?: number;
  externalIds?: Record<string, string>;
  url?: string;
  citationCount?: number;
  venue?: string;
  publicationDate?: string;
}

export async function searchSemanticScholar(criteria: SearchCriteria): Promise<{ papers: PaperRecord[]; source: SourceRecord }> {
  const start = Date.now();
  const papers: PaperRecord[] = [];
  try {
    const params = new URLSearchParams({
      query: criteria.query,
      limit: String(Math.min(criteria.maxPerSource, 100)),
      fields: 'paperId,title,authors,abstract,year,externalIds,url,citationCount,venue,publicationDate',
    });
    if (criteria.yearFrom) params.set('year', `${criteria.yearFrom}-${criteria.yearTo ?? ''}`);

    const resp = await fetchWithRetry(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`);
    const data = await resp.json() as { data?: S2Paper[] };
    for (const p of data.data ?? []) {
      papers.push(normalizeS2(p));
    }
    return {
      papers,
      source: { source: 'semantic_scholar', status: 'success', resultsFound: papers.length, durationMs: Date.now() - start },
    };
  } catch (err) {
    return {
      papers,
      source: { source: 'semantic_scholar', status: papers.length > 0 ? 'partial' : 'error', resultsFound: papers.length, error: (err as Error).message, durationMs: Date.now() - start },
    };
  }
}

function normalizeS2(p: S2Paper): PaperRecord {
  return {
    id: `semantic_scholar:${p.paperId}`,
    title: p.title ?? '',
    authors: (p.authors ?? []).map(a => ({ name: a.name, affiliations: a.affiliations })),
    abstract: p.abstract ?? '',
    year: p.year ?? null,
    doi: p.externalIds?.DOI ?? null,
    url: p.url ?? null,
    source: 'semantic_scholar',
    externalId: p.paperId,
    crossrefIds: p.externalIds ?? {},
    citations: p.citationCount ?? null,
    venue: p.venue ?? null,
    publicationDate: p.publicationDate ?? null,
  };
}

// ─── PubMed ───────────────────────────────────────────────────

export async function searchPubMed(criteria: SearchCriteria): Promise<{ papers: PaperRecord[]; source: SourceRecord }> {
  const start = Date.now();
  const papers: PaperRecord[] = [];
  try {
    let query = criteria.query;
    if (criteria.yearFrom) {
      query += ` AND ${criteria.yearFrom}:${criteria.yearTo ?? '3000'}[pdat]`;
    }
    const searchParams = new URLSearchParams({
      db: 'pubmed',
      term: query,
      retmax: String(Math.min(criteria.maxPerSource, 200)),
      retmode: 'json',
      sort: 'relevance',
    });
    const searchResp = await fetchWithRetry(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams}`);
    const searchData = await searchResp.json() as { esearchresult?: { idlist?: string[] } };
    const ids = searchData.esearchresult?.idlist ?? [];
    if (ids.length === 0) {
      return {
        papers: [],
        source: { source: 'pubmed', status: 'success', resultsFound: 0, durationMs: Date.now() - start },
      };
    }

    // Fetch summaries in batch
    const fetchParams = new URLSearchParams({
      db: 'pubmed',
      id: ids.join(','),
      retmode: 'json',
    });
    const fetchResp = await fetchWithRetry(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${fetchParams}`);
    const fetchData = await fetchResp.json() as { result?: Record<string, PubMedSummary> };
    const results = fetchData.result ?? {};

    for (const pmid of ids) {
      const doc = results[pmid];
      if (!doc || !doc.title) continue;
      papers.push(normalizePubMed(pmid, doc));
    }
    return {
      papers,
      source: { source: 'pubmed', status: 'success', resultsFound: papers.length, durationMs: Date.now() - start },
    };
  } catch (err) {
    return {
      papers,
      source: { source: 'pubmed', status: papers.length > 0 ? 'partial' : 'error', resultsFound: papers.length, error: (err as Error).message, durationMs: Date.now() - start },
    };
  }
}

interface PubMedSummary {
  title?: string;
  authors?: Array<{ name: string }>;
  pubdate?: string;
  source?: string;
  elocationid?: string;
  articleids?: Array<{ idtype: string; value: string }>;
}

function normalizePubMed(pmid: string, doc: PubMedSummary): PaperRecord {
  const doi = doc.articleids?.find(a => a.idtype === 'doi')?.value ?? null;
  const yearMatch = doc.pubdate?.match(/\d{4}/);
  return {
    id: `pubmed:${pmid}`,
    title: (doc.title ?? '').replace(/<\/?[^>]+>/g, ''),
    authors: (doc.authors ?? []).map(a => ({ name: a.name })),
    abstract: '', // PubMed summary endpoint doesn't include abstracts
    year: yearMatch ? parseInt(yearMatch[0], 10) : null,
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    source: 'pubmed',
    externalId: pmid,
    crossrefIds: doi ? { DOI: doi, PMID: pmid } : { PMID: pmid },
    citations: null,
    venue: doc.source ?? null,
    publicationDate: doc.pubdate ?? null,
  };
}

// ─── arXiv ────────────────────────────────────────────────────

export async function searchArxiv(criteria: SearchCriteria): Promise<{ papers: PaperRecord[]; source: SourceRecord }> {
  const start = Date.now();
  const papers: PaperRecord[] = [];
  try {
    const params = new URLSearchParams({
      search_query: `all:${criteria.query}`,
      start: '0',
      max_results: String(Math.min(criteria.maxPerSource, 100)),
      sortBy: 'relevance',
    });

    const resp = await fetchWithRetry(`http://export.arxiv.org/api/query?${params}`);
    const xml = await resp.text();

    // Parse Atom XML entries
    const entries = xml.split('<entry>').slice(1);
    for (const entry of entries) {
      const paper = parseArxivEntry(entry);
      if (paper && matchesYearFilter(paper.year, criteria)) {
        papers.push(paper);
      }
    }
    return {
      papers,
      source: { source: 'arxiv', status: 'success', resultsFound: papers.length, durationMs: Date.now() - start },
    };
  } catch (err) {
    return {
      papers,
      source: { source: 'arxiv', status: papers.length > 0 ? 'partial' : 'error', resultsFound: papers.length, error: (err as Error).message, durationMs: Date.now() - start },
    };
  }
}

function parseArxivEntry(entry: string): PaperRecord | null {
  const tag = (name: string) => {
    const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m?.[1]?.trim() ?? '';
  };

  const id = tag('id');
  const arxivId = id.replace('http://arxiv.org/abs/', '').replace(/v\d+$/, '');
  const title = tag('title').replace(/\s+/g, ' ');
  if (!title) return null;

  const authorMatches = entry.match(/<author>\s*<name>([^<]+)<\/name>/g) ?? [];
  const authors: Author[] = authorMatches.map(m => {
    const name = m.match(/<name>([^<]+)<\/name>/)?.[1] ?? '';
    return { name };
  });

  const published = tag('published');
  const yearMatch = published.match(/(\d{4})/);
  const doiLink = entry.match(/href="https?:\/\/dx\.doi\.org\/([^"]+)"/)?.[1] ?? null;

  return {
    id: `arxiv:${arxivId}`,
    title,
    authors,
    abstract: tag('summary').replace(/\s+/g, ' '),
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    doi: doiLink,
    url: id,
    source: 'arxiv',
    externalId: arxivId,
    crossrefIds: doiLink ? { DOI: doiLink, ArXiv: arxivId } : { ArXiv: arxivId },
    citations: null,
    venue: 'arXiv',
    publicationDate: published.slice(0, 10),
  };
}

// ─── OpenAlex ─────────────────────────────────────────────────

export async function searchOpenAlex(criteria: SearchCriteria): Promise<{ papers: PaperRecord[]; source: SourceRecord }> {
  const start = Date.now();
  const papers: PaperRecord[] = [];
  try {
    const params = new URLSearchParams({
      search: criteria.query,
      per_page: String(Math.min(criteria.maxPerSource, 200)),
    });
    if (criteria.yearFrom) {
      const to = criteria.yearTo ?? new Date().getFullYear();
      params.set('filter', `publication_year:${criteria.yearFrom}-${to}`);
    }
    if (criteria.email) params.set('mailto', criteria.email);

    const resp = await fetchWithRetry(`https://api.openalex.org/works?${params}`);
    const data = await resp.json() as { results?: OpenAlexWork[] };
    for (const work of data.results ?? []) {
      papers.push(normalizeOpenAlex(work));
    }
    return {
      papers,
      source: { source: 'openalex', status: 'success', resultsFound: papers.length, durationMs: Date.now() - start },
    };
  } catch (err) {
    return {
      papers,
      source: { source: 'openalex', status: papers.length > 0 ? 'partial' : 'error', resultsFound: papers.length, error: (err as Error).message, durationMs: Date.now() - start },
    };
  }
}

interface OpenAlexWork {
  id: string;
  title?: string;
  authorships?: Array<{ author: { display_name: string }; institutions?: Array<{ display_name: string }> }>;
  abstract_inverted_index?: Record<string, number[]>;
  publication_year?: number;
  doi?: string;
  primary_location?: { landing_page_url?: string; source?: { display_name?: string } };
  cited_by_count?: number;
  publication_date?: string;
  ids?: Record<string, string>;
}

function normalizeOpenAlex(w: OpenAlexWork): PaperRecord {
  const oaId = w.id.replace('https://openalex.org/', '');
  const doi = w.doi?.replace('https://doi.org/', '') ?? null;
  const crossrefIds: Record<string, string> = {};
  if (doi) crossrefIds.DOI = doi;
  if (w.ids) {
    for (const [k, v] of Object.entries(w.ids)) {
      if (k !== 'openalex') crossrefIds[k] = typeof v === 'string' ? v : String(v);
    }
  }

  return {
    id: `openalex:${oaId}`,
    title: w.title ?? '',
    authors: (w.authorships ?? []).map(a => ({
      name: a.author.display_name,
      affiliations: a.institutions?.map(i => i.display_name),
    })),
    abstract: invertedIndexToAbstract(w.abstract_inverted_index),
    year: w.publication_year ?? null,
    doi,
    url: w.primary_location?.landing_page_url ?? null,
    source: 'openalex',
    externalId: oaId,
    crossrefIds,
    citations: w.cited_by_count ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    publicationDate: w.publication_date ?? null,
  };
}

function invertedIndexToAbstract(index?: Record<string, number[]>): string {
  if (!index) return '';
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(w => w[1]).join(' ');
}

// ─── Orchestrator ─────────────────────────────────────────────

function matchesYearFilter(year: number | null, criteria: SearchCriteria): boolean {
  if (!year) return true;
  if (criteria.yearFrom && year < criteria.yearFrom) return false;
  if (criteria.yearTo && year > criteria.yearTo) return false;
  return true;
}

const SOURCE_SEARCHERS: Record<ApiSource, (c: SearchCriteria) => Promise<{ papers: PaperRecord[]; source: SourceRecord }>> = {
  semantic_scholar: searchSemanticScholar,
  pubmed: searchPubMed,
  arxiv: searchArxiv,
  openalex: searchOpenAlex,
};

const DEFAULT_SOURCES: ApiSource[] = ['semantic_scholar', 'pubmed', 'arxiv', 'openalex'];

export async function searchAll(
  criteria: SearchCriteria,
  onProgress?: (source: ApiSource, count: number) => void,
): Promise<{ papers: PaperRecord[]; sources: SourceRecord[] }> {
  const sources = criteria.sources ?? DEFAULT_SOURCES;
  const allPapers: PaperRecord[] = [];
  const allSources: SourceRecord[] = [];

  // Search sequentially to respect rate limits
  for (const src of sources) {
    const searcher = SOURCE_SEARCHERS[src];
    if (!searcher) continue;
    const result = await searcher(criteria);
    allPapers.push(...result.papers);
    allSources.push(result.source);
    onProgress?.(src, result.papers.length);
  }

  return { papers: allPapers, sources: allSources };
}
