/**
 * Paper deduplication: DOI match, cross-reference ID match, fuzzy title+author bigram similarity.
 * Three-strategy approach. Pure logic, no network calls.
 */

import type { PaperRecord } from './types';

const FUZZY_THRESHOLD = 0.9;

/** Normalize title for comparison: lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // Strip diacritics
    .replace(/[^\w\s]/g, ' ')          // Punctuation to spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract character bigrams from a string. */
export function bigrams(text: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) {
    s.add(text.slice(i, i + 2));
  }
  return s;
}

/** Jaccard similarity between two bigram sets. */
export function bigramSimilarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  for (const g of ba) {
    if (bb.has(g)) intersection++;
  }
  return intersection / (ba.size + bb.size - intersection);
}

/** Normalize author name for comparison. */
export function normalizeAuthorName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, '')
    .trim();
}

/** Check if two papers share at least one author (fuzzy name match). */
export function authorsOverlap(a: PaperRecord, b: PaperRecord): boolean {
  if (a.authors.length === 0 || b.authors.length === 0) return true; // No info = don't exclude
  const namesA = a.authors.map(au => normalizeAuthorName(au.name));
  const namesB = b.authors.map(au => normalizeAuthorName(au.name));
  for (const na of namesA) {
    for (const nb of namesB) {
      if (na === nb) return true;
      // Check last name match (handles "J. Smith" vs "John Smith")
      const lastA = na.split(/\s+/).pop() ?? '';
      const lastB = nb.split(/\s+/).pop() ?? '';
      if (lastA.length > 2 && lastA === lastB) return true;
    }
  }
  return false;
}

/** Strategy 1: DOI match. */
function matchByDoi(a: PaperRecord, b: PaperRecord): boolean {
  if (!a.doi || !b.doi) return false;
  return a.doi.toLowerCase() === b.doi.toLowerCase();
}

/** Strategy 2: Cross-reference ID match (e.g., same PubMed ID across sources). */
function matchByCrossRef(a: PaperRecord, b: PaperRecord): boolean {
  if (!a.crossrefIds || !b.crossrefIds) return false;
  for (const [key, valA] of Object.entries(a.crossrefIds)) {
    const valB = b.crossrefIds[key];
    if (valB && valA.toLowerCase() === valB.toLowerCase()) return true;
  }
  return false;
}

/** Strategy 3: Fuzzy title + author similarity. */
function matchByFuzzy(a: PaperRecord, b: PaperRecord): boolean {
  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  const sim = bigramSimilarity(titleA, titleB);
  if (sim < FUZZY_THRESHOLD) return false;
  return authorsOverlap(a, b);
}

/** Check if two papers are duplicates using all 3 strategies. */
export function isDuplicate(a: PaperRecord, b: PaperRecord): boolean {
  if (a.id === b.id) return true;
  if (matchByDoi(a, b)) return true;
  if (matchByCrossRef(a, b)) return true;
  if (matchByFuzzy(a, b)) return true;
  return false;
}

export interface DedupResult {
  unique: PaperRecord[];
  duplicatesRemoved: number;
  /** Map from removed paper ID to the kept paper ID it duplicated. */
  mergeMap: Map<string, string>;
}

/**
 * Deduplicate a list of papers. Earlier papers in the list are preferred
 * (first occurrence is kept). Merges cross-reference IDs from duplicates.
 */
export function dedup(papers: PaperRecord[]): DedupResult {
  const unique: PaperRecord[] = [];
  const mergeMap = new Map<string, string>();

  for (const paper of papers) {
    let found = false;
    for (const kept of unique) {
      if (isDuplicate(paper, kept)) {
        // Merge cross-reference IDs into the kept paper
        if (paper.crossrefIds) {
          kept.crossrefIds = { ...kept.crossrefIds, ...paper.crossrefIds };
        }
        // Prefer non-empty abstract
        if (!kept.abstract && paper.abstract) {
          kept.abstract = paper.abstract;
        }
        // Prefer non-null citations
        if (kept.citations === null && paper.citations !== null) {
          kept.citations = paper.citations;
        }
        mergeMap.set(paper.id, kept.id);
        found = true;
        break;
      }
    }
    if (!found) {
      unique.push(paper);
    }
  }

  return {
    unique,
    duplicatesRemoved: papers.length - unique.length,
    mergeMap,
  };
}
