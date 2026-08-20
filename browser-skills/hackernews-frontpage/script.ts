/**
 * hackernews-frontpage — scrape the HN front page and emit JSON.
 *
 * Output protocol:
 *   stdout = a single JSON document on success: { stories: Story[], count }
 *   stderr = anything we want logged (currently nothing)
 *   exit 0 on success, nonzero on parse / network failure.
 *
 * The parser logic (`parseStoriesFromHtml`) is exported so script.test.ts can
 * exercise it against bundled HTML fixtures without spinning up the daemon.
 */

import { browse } from './_lib/browse-client';

export interface Story {
  /** 1-based rank as displayed on HN. */
  rank: number;
  /** HN item id (the integer in `tr.athing[id]`). */
  id: string;
  title: string;
  /** Outbound URL the title links to. */
  url: string;
  /** null when the row has no score (job postings). */
  points: number | null;
  /** null when the row has no comments link (job postings). */
  comments: number | null;
}

export interface Output {
  stories: Story[];
  count: number;
}

const FRONT_PAGE_URL = 'https://news.ycombinator.com/';

/**
 * Parse HN front-page HTML into Story[].
 *
 * HN's structure is stable: each story is a pair of rows.
 *   <tr class="athing submission" id="<itemid>">
 *     <td class="rank">N.</td>
 *     <td class="title">...</td>
 *     <td class="title"><span class="titleline"><a href="<url>">title</a> ...</span></td>
 *   </tr>
 *   <tr><td colspan="2"></td><td class="subtext"><span class="subline">
 *     <span class="score" id="score_<itemid>">N points</span>
 *     ... <a href="item?id=<itemid>">N comments</a>
 *   </span></td></tr>
 *
 * Job postings ("Foo (YC X25) is hiring...") omit the score and comments —
 * those fields come back as null.
 */
export function parseStoriesFromHtml(html: string): Story[] {
  const stories: Story[] = [];

  // Match each `tr.athing` row, capturing the id attribute and the row body.
  const rowRegex = /<tr\s+[^>]*\bclass="athing[^"]*"[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;

  let match: RegExpExecArray | null;
  let rank = 0;
  while ((match = rowRegex.exec(html)) !== null) {
    rank++;
    const id = match[1];
    const rowBody = match[2];

    // Title link: <span class="titleline"><a href="..." ...>title</a>
    const titleMatch = rowBody.match(/<span\s+class="titleline"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const url = decodeHtmlEntities(titleMatch[1]);
    const title = stripTags(decodeHtmlEntities(titleMatch[2])).trim();

    // The next sibling tr should hold the subtext row. Bound the lookahead
    // to before the next story (tr.spacer marks the gap, then tr.athing).
    // Bug if we don't bound: the score from story N+1 leaks into story N
    // when story N is a job posting (no score of its own).
    const subtextStart = match.index + match[0].length;
    const tail = html.slice(subtextStart);
    const spacerIdx = tail.search(/<tr\b[^>]*\bclass="spacer\b/);
    const nextAthingIdx = tail.search(/<tr\b[^>]*\bclass="athing\b/);
    const candidates = [spacerIdx, nextAthingIdx].filter(i => i >= 0);
    const boundary = candidates.length > 0 ? Math.min(...candidates) : tail.length;
    const subtextSlice = tail.slice(0, boundary);

    let points: number | null = null;
    let comments: number | null = null;

    const scoreMatch = subtextSlice.match(/<span\s+class="score"[^>]*>(\d+)\s*points?<\/span>/);
    if (scoreMatch) points = parseInt(scoreMatch[1], 10);

    // Comment count: an anchor like `<a href="item?id=...">N comments</a>`,
    // or `discuss` (treated as 0). Skip "hide" / "context" / "from" links.
    const commentsMatch = subtextSlice.match(/<a\s+href="item\?id=\d+"[^>]*>(\d+)\s*(?:&nbsp;)?\s*comments?<\/a>/);
    if (commentsMatch) {
      comments = parseInt(commentsMatch[1], 10);
    } else if (/discuss<\/a>/.test(subtextSlice)) {
      comments = 0;
    }

    stories.push({ rank, id, title, url, points, comments });
  }

  return stories;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// ─── Main entry (only when run as a script, not when imported by tests) ─

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  await browse.goto(FRONT_PAGE_URL);
  const html = await browse.html();
  const stories = parseStoriesFromHtml(html);
  const output: Output = { stories, count: stories.length };
  process.stdout.write(JSON.stringify(output) + '\n');
}
