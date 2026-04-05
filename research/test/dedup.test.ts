import { describe, expect, test } from 'bun:test';
import {
  normalizeTitle,
  bigrams,
  bigramSimilarity,
  normalizeAuthorName,
  authorsOverlap,
  isDuplicate,
  dedup,
} from '../src/dedup';
import type { PaperRecord } from '../src/types';

function makePaper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    id: `test:${Math.random().toString(36).slice(2)}`,
    title: 'A Test Paper',
    authors: [{ name: 'John Smith' }],
    abstract: 'Some abstract.',
    year: 2024,
    doi: null,
    url: null,
    source: 'semantic_scholar',
    externalId: '123',
    crossrefIds: {},
    citations: null,
    venue: null,
    publicationDate: null,
    ...overrides,
  };
}

describe('normalizeTitle', () => {
  test('lowercases and strips punctuation', () => {
    expect(normalizeTitle('Hello, World!')).toBe('hello world');
  });

  test('handles diacritics', () => {
    expect(normalizeTitle('Über die Wärme')).toBe('uber die warme');
  });

  test('collapses whitespace', () => {
    expect(normalizeTitle('  lots   of   spaces  ')).toBe('lots of spaces');
  });

  test('empty string', () => {
    expect(normalizeTitle('')).toBe('');
  });
});

describe('bigrams', () => {
  test('generates character bigrams', () => {
    expect(bigrams('abc')).toEqual(new Set(['ab', 'bc']));
  });

  test('single character returns empty set', () => {
    expect(bigrams('a')).toEqual(new Set());
  });

  test('empty string returns empty set', () => {
    expect(bigrams('')).toEqual(new Set());
  });
});

describe('bigramSimilarity', () => {
  test('identical strings have similarity 1.0', () => {
    expect(bigramSimilarity('hello world', 'hello world')).toBe(1);
  });

  test('completely different strings have low similarity', () => {
    expect(bigramSimilarity('abcdef', 'xyz123')).toBeLessThan(0.2);
  });

  test('similar strings have high similarity', () => {
    const sim = bigramSimilarity('machine learning', 'machine learnin');
    expect(sim).toBeGreaterThan(0.8);
  });

  test('both empty returns 1.0', () => {
    expect(bigramSimilarity('', '')).toBe(1);
  });

  test('one empty returns 0.0', () => {
    expect(bigramSimilarity('hello', '')).toBe(0);
  });
});

describe('normalizeAuthorName', () => {
  test('lowercases and strips diacritics', () => {
    expect(normalizeAuthorName('José García')).toBe('jose garcia');
  });

  test('strips punctuation', () => {
    expect(normalizeAuthorName('O\'Brien, Jr.')).toBe('obrien jr');
  });
});

describe('authorsOverlap', () => {
  test('exact name match', () => {
    const a = makePaper({ authors: [{ name: 'John Smith' }] });
    const b = makePaper({ authors: [{ name: 'John Smith' }] });
    expect(authorsOverlap(a, b)).toBe(true);
  });

  test('last name match handles initials', () => {
    const a = makePaper({ authors: [{ name: 'J. Smith' }] });
    const b = makePaper({ authors: [{ name: 'John Smith' }] });
    expect(authorsOverlap(a, b)).toBe(true);
  });

  test('no overlap returns false', () => {
    const a = makePaper({ authors: [{ name: 'Alice Johnson' }] });
    const b = makePaper({ authors: [{ name: 'Bob Williams' }] });
    expect(authorsOverlap(a, b)).toBe(false);
  });

  test('empty authors returns true (no info to exclude)', () => {
    const a = makePaper({ authors: [] });
    const b = makePaper({ authors: [{ name: 'Anyone' }] });
    expect(authorsOverlap(a, b)).toBe(true);
  });
});

describe('isDuplicate', () => {
  test('same ID', () => {
    const a = makePaper({ id: 'test:same' });
    const b = makePaper({ id: 'test:same' });
    expect(isDuplicate(a, b)).toBe(true);
  });

  test('DOI match', () => {
    const a = makePaper({ id: 'a', doi: '10.1234/test' });
    const b = makePaper({ id: 'b', doi: '10.1234/test' });
    expect(isDuplicate(a, b)).toBe(true);
  });

  test('DOI match is case-insensitive', () => {
    const a = makePaper({ id: 'a', doi: '10.1234/TEST' });
    const b = makePaper({ id: 'b', doi: '10.1234/test' });
    expect(isDuplicate(a, b)).toBe(true);
  });

  test('cross-reference ID match', () => {
    const a = makePaper({ id: 'a', crossrefIds: { PMID: '12345' } });
    const b = makePaper({ id: 'b', crossrefIds: { PMID: '12345' } });
    expect(isDuplicate(a, b)).toBe(true);
  });

  test('fuzzy title + author match', () => {
    const a = makePaper({
      id: 'a',
      title: 'Deep Learning for Natural Language Processing',
      authors: [{ name: 'John Smith' }],
    });
    const b = makePaper({
      id: 'b',
      title: 'Deep Learning for Natural Language Processing.',
      authors: [{ name: 'J. Smith' }],
    });
    expect(isDuplicate(a, b)).toBe(true);
  });

  test('different papers are not duplicates', () => {
    const a = makePaper({
      id: 'a',
      title: 'Deep Learning for Vision',
      authors: [{ name: 'Alice' }],
    });
    const b = makePaper({
      id: 'b',
      title: 'Quantum Computing Overview',
      authors: [{ name: 'Bob' }],
    });
    expect(isDuplicate(a, b)).toBe(false);
  });

  test('similar titles but different authors', () => {
    const a = makePaper({
      id: 'a',
      title: 'Machine Learning Review',
      authors: [{ name: 'Alice Johnson' }],
    });
    const b = makePaper({
      id: 'b',
      title: 'Machine Learning Review',
      authors: [{ name: 'Bob Williams' }],
    });
    // Same title, different authors. Fuzzy match requires author overlap.
    expect(isDuplicate(a, b)).toBe(false);
  });
});

describe('dedup', () => {
  test('removes DOI duplicates, keeps first occurrence', () => {
    const a = makePaper({ id: 's2:1', doi: '10.1234/x', source: 'semantic_scholar', abstract: 'Abstract A' });
    const b = makePaper({ id: 'pm:1', doi: '10.1234/x', source: 'pubmed', abstract: '' });
    const result = dedup([a, b]);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].id).toBe('s2:1');
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.mergeMap.get('pm:1')).toBe('s2:1');
  });

  test('merges cross-reference IDs from duplicates', () => {
    const a = makePaper({ id: 'a', doi: '10.1/x', crossrefIds: { DOI: '10.1/x' } });
    const b = makePaper({ id: 'b', doi: '10.1/x', crossrefIds: { DOI: '10.1/x', PMID: '999' } });
    const result = dedup([a, b]);
    expect(result.unique[0].crossrefIds?.PMID).toBe('999');
  });

  test('prefers non-empty abstract from duplicate', () => {
    const a = makePaper({ id: 'a', doi: '10.1/x', abstract: '' });
    const b = makePaper({ id: 'b', doi: '10.1/x', abstract: 'Real abstract here' });
    const result = dedup([a, b]);
    expect(result.unique[0].abstract).toBe('Real abstract here');
  });

  test('no duplicates returns all papers', () => {
    const papers = [
      makePaper({ id: 'a', title: 'Paper A', doi: '10.1/a' }),
      makePaper({ id: 'b', title: 'Paper B', doi: '10.1/b' }),
      makePaper({ id: 'c', title: 'Paper C', doi: '10.1/c' }),
    ];
    const result = dedup(papers);
    expect(result.unique).toHaveLength(3);
    expect(result.duplicatesRemoved).toBe(0);
  });

  test('empty input returns empty', () => {
    const result = dedup([]);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicatesRemoved).toBe(0);
  });
});
