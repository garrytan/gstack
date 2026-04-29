/**
 * hackernews-frontpage script tests — exercise parseStoriesFromHtml against
 * the bundled HN fixture. No daemon, no network: the parser is a pure function
 * over HTML, so we test it directly.
 */

import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parseStoriesFromHtml } from './script';

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'hn-2026-04-26.html'),
  'utf-8',
);

describe('parseStoriesFromHtml against bundled HN fixture', () => {
  it('returns 5 stories (matching the fixture)', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories).toHaveLength(5);
  });

  it('assigns 1-based ranks in document order', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories.map(s => s.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('extracts ids matching the tr.athing[id] attribute', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories.map(s => s.id)).toEqual([
      '40000001', '40000002', '40000003', '40000004', '40000005',
    ]);
  });

  it('extracts titles and decodes HTML entities', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories[0].title).toBe('Show HN: A toy compiler in 200 lines');
    expect(stories[1].title).toBe('Database internals: writing an LSM tree');
    expect(stories[3].title).toBe("Ask HN: What's your most underrated tool?");
    expect(stories[4].title).toBe('Why quantum & chess engines disagree');
  });

  it('extracts URLs and decodes ampersands', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories[0].url).toBe('https://example.com/blog-post-1');
    expect(stories[1].url).toBe('https://example.org/database-internals');
    expect(stories[4].url).toBe('https://example.io/quantum&chess');
  });

  it('parses point counts as numbers', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories[0].points).toBe(412);
    expect(stories[1].points).toBe(298);
    expect(stories[3].points).toBe(156);
    expect(stories[4].points).toBe(73);
  });

  it('parses comment counts as numbers', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories[0].comments).toBe(87);
    expect(stories[1].comments).toBe(152);
    expect(stories[4].comments).toBe(12);
  });

  it('treats "discuss" links as 0 comments', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    expect(stories[3].comments).toBe(0);
  });

  it('returns null points + null comments for job postings', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    // Story #3 is the YC-hiring row in the fixture.
    expect(stories[2].title).toContain('YC W26');
    expect(stories[2].points).toBeNull();
    expect(stories[2].comments).toBeNull();
  });

  it('returns [] for empty HTML', () => {
    expect(parseStoriesFromHtml('')).toEqual([]);
  });

  it('returns [] for HTML with no story rows', () => {
    expect(parseStoriesFromHtml('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });

  it('does not fabricate stories from arbitrary tr.athing rows missing titleline', () => {
    const html = '<tr class="athing" id="999"><td>nothing</td></tr>';
    expect(parseStoriesFromHtml(html)).toEqual([]);
  });
});

describe('output shape', () => {
  it('every story has all required keys', () => {
    const stories = parseStoriesFromHtml(FIXTURE);
    for (const s of stories) {
      expect(typeof s.rank).toBe('number');
      expect(typeof s.id).toBe('string');
      expect(typeof s.title).toBe('string');
      expect(typeof s.url).toBe('string');
      // points/comments may be null for job rows
      expect(s.points === null || typeof s.points === 'number').toBe(true);
      expect(s.comments === null || typeof s.comments === 'number').toBe(true);
    }
  });
});
