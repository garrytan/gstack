/** Core types for the research pipeline. De facto schema for all artifacts. */

export type ApiSource = 'semantic_scholar' | 'pubmed' | 'arxiv' | 'openalex';

export interface Author {
  name: string;
  affiliations?: string[];
}

export interface PaperRecord {
  id: string;               // Internal unique ID (source:externalId)
  title: string;
  authors: Author[];
  abstract: string;
  year: number | null;
  doi: string | null;
  url: string | null;
  source: ApiSource;
  externalId: string;       // Source-specific ID (e.g., PubMed ID, arXiv ID)
  crossrefIds?: Record<string, string>;  // Other known IDs for dedup
  citations: number | null;
  venue: string | null;
  publicationDate: string | null;  // ISO date string
}

export interface SearchMeta {
  query: string;
  sources: SourceRecord[];
  totalResults: number;
  totalAfterDedup: number;
  searchedAt: string;       // ISO timestamp
  parameters: SearchCriteria;
}

export interface SourceRecord {
  source: ApiSource;
  status: SourceStatus;
  resultsFound: number;
  error?: string;
  durationMs: number;
}

export type SourceStatus = 'success' | 'partial' | 'error' | 'skipped';

export interface SearchCriteria {
  query: string;
  maxPerSource: number;
  yearFrom?: number;
  yearTo?: number;
  sources?: ApiSource[];     // Subset of APIs to query (default: all)
  email?: string;            // Polite pool email for OpenAlex
}

export interface ScreeningDecision {
  id: string;
  decision: 'include' | 'exclude' | 'uncertain';
  reasoning: string;
  confidence: number;        // 0.0 - 1.0
  criteriaMatched: string[];
}

export interface EvidenceClaim {
  text: string;
  supporting: string[];      // Paper IDs
  contradicting: string[];   // Paper IDs
  confidence: number;
  sourceQuote: string;       // Direct quote from paper (anti-hallucination)
  paperId: string;           // Primary source paper
}

export interface EvidenceGraph {
  claims: EvidenceClaim[];
  themes: string[];
  methodology: {
    studyDesigns: Record<string, number>;
    qualityDistribution: { high: number; medium: number; low: number };
  };
  generatedAt: string;
}

export interface ReviewDimension {
  dimension: string;
  score: 'strong' | 'adequate' | 'weak' | 'not_assessed';
  findings: string[];
  summary: string;
}

export interface ReviewReport {
  overallAssessment: {
    decision: 'accept' | 'minor_revision' | 'major_revision' | 'reject';
    summary: string;
    confidence: number;
    strengths: string[];
    weaknesses: string[];
  };
  dimensions: ReviewDimension[];
  claimAssessments: Array<{
    claimText: string;
    quoteVerified: boolean;
    reviewerConfidence: number;
    issues: string[];
  }>;
  recommendations: Array<{
    priority: 'critical' | 'major' | 'minor' | 'suggestion';
    action: string;
    rationale: string;
    dimension: string;
  }>;
  tier: 'search_only' | 'search_screen' | 'full_pipeline';
  reviewedAt: string;
}
