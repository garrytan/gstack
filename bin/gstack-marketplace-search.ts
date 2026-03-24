#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

interface RawSkill {
  name?: string;
  description?: string;
  author?: string;
  stars?: number;
  forks?: number;
  githubUrl?: string;
  scopedName?: string;
}

interface SearchQuery {
  text: string;
  source: 'full' | 'keyword';
}

interface RankedSkill {
  name: string;
  description: string;
  author: string;
  scopedName: string;
  githubUrl: string;
  stars: number;
  forks: number;
  installCommand: string;
  matchedKeywords: string[];
  sourceQueries: string[];
  score: number;
}

interface SearchResponse {
  status: 'ok' | 'unavailable';
  query: string;
  keywords: string[];
  queries: string[];
  results: RankedSkill[];
  reason?: string;
}

const KNOWN_KEYWORDS: Array<{ canonical: string; patterns: RegExp[] }> = [
  { canonical: 'supabase', patterns: [/\bsupabase\b/i] },
  { canonical: 'vercel', patterns: [/\bvercel\b/i] },
  { canonical: 'azure cli', patterns: [/\bazure cli\b/i, /\baz\s+cli\b/i, /\baz\b/i] },
  { canonical: 'github cli', patterns: [/\bgithub cli\b/i, /\bgh cli\b/i, /\bgh\b/i] },
  { canonical: 'nextjs', patterns: [/\bnext\.?js\b/i, /\bnextjs\b/i] },
  { canonical: 'postgres', patterns: [/\bpostgres(?:ql)?\b/i] },
  { canonical: 'prisma', patterns: [/\bprisma\b/i] },
  { canonical: 'drizzle', patterns: [/\bdrizzle\b/i] },
  { canonical: 'tailwind', patterns: [/\btailwind\b/i] },
  { canonical: 'docker', patterns: [/\bdocker\b/i] },
  { canonical: 'kubernetes', patterns: [/\bkubernetes\b/i, /\bk8s\b/i] },
  { canonical: 'terraform', patterns: [/\bterraform\b/i] },
  { canonical: 'openai', patterns: [/\bopenai\b/i] },
  { canonical: 'anthropic', patterns: [/\banthropic\b/i, /\bclaude\b/i] },
  { canonical: 'stripe', patterns: [/\bstripe\b/i] },
  { canonical: 'react', patterns: [/\breact\b/i] },
  { canonical: 'vue', patterns: [/\bvue\b/i] },
  { canonical: 'svelte', patterns: [/\bsvelte\b/i] },
];

const STOPWORDS = new Set([
  'build', 'using', 'with', 'need', 'help', 'make', 'this', 'that', 'from',
  'into', 'have', 'about', 'should', 'would', 'there', 'their', 'when', 'what',
  'where', 'which', 'while', 'before', 'after', 'without', 'through', 'query',
  'skill', 'skills', 'mode', 'plan', 'design', 'review', 'flow',
]);

function parseArgs(argv: string[]) {
  let query = '';
  let queryFile = '';
  let limit = 3;
  let outputJson = false;
  const explicitKeywords: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--query') query = argv[++i] ?? '';
    else if (arg === '--query-file') queryFile = argv[++i] ?? '';
    else if (arg === '--keyword') explicitKeywords.push((argv[++i] ?? '').trim());
    else if (arg === '--limit') limit = Math.max(1, Number(argv[++i] ?? 3) || 3);
    else if (arg === '--json') outputJson = true;
  }

  if (!query && queryFile) query = fs.readFileSync(queryFile, 'utf-8');

  if (!query.trim()) {
    throw new Error('Usage: gstack-marketplace-search --query <text> [--keyword <term>] [--limit <n>] [--json]');
  }

  return { query: query.trim(), explicitKeywords, limit, outputJson };
}

export function extractKeywords(text: string): string[] {
  const matches = new Set<string>();

  for (const entry of KNOWN_KEYWORDS) {
    if (entry.patterns.some(pattern => pattern.test(text))) {
      matches.add(entry.canonical);
    }
  }

  if (matches.size === 0) {
    const generic = text
      .toLowerCase()
      .split(/[^a-z0-9.+#-]+/)
      .filter(token => token.length >= 4 && !STOPWORDS.has(token))
      .slice(0, 4);
    for (const token of generic) matches.add(token);
  }

  return Array.from(matches).slice(0, 6);
}

export function parseMarketplaceOutput(raw: string): RawSkill[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return [];
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return Array.isArray(parsed.skills) ? parsed.skills : [];
}

function buildQueries(query: string, explicitKeywords: string[]): SearchQuery[] {
  const keywords = Array.from(new Set([
    ...explicitKeywords.map(k => k.trim().toLowerCase()).filter(Boolean),
    ...extractKeywords(query),
  ])).slice(0, 6);

  const trimmedQuery = query.split(/\s+/).slice(0, 12).join(' ').trim();
  const queries: SearchQuery[] = [];
  if (trimmedQuery) queries.push({ text: trimmedQuery, source: 'full' });
  for (const keyword of keywords.slice(0, 3)) queries.push({ text: keyword, source: 'keyword' });
  return queries;
}

function commandExists(bin: string): boolean {
  const result = spawnSync('which', [bin], { encoding: 'utf-8' });
  return result.status === 0;
}

function getStateDir(): string {
  return process.env.GSTACK_STATE_DIR || path.join(process.env.HOME || '', '.gstack');
}

function readCache(key: string): SearchResponse | null {
  const cacheFile = path.join(getStateDir(), 'cache', 'marketplace-search', `${key}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  const stat = fs.statSync(cacheFile);
  if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) return null;
  return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as SearchResponse;
}

function writeCache(key: string, data: SearchResponse) {
  const cacheDir = path.join(getStateDir(), 'cache', 'marketplace-search');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(data, null, 2));
}

function runSearchQuery(query: SearchQuery, limit: number): RawSkill[] | null {
  if (process.env.GSTACK_MARKETPLACE_FIXTURE) {
    const raw = fs.readFileSync(process.env.GSTACK_MARKETPLACE_FIXTURE, 'utf-8');
    return parseMarketplaceOutput(raw);
  }

  const queryArgs = query.text.split(/\s+/).filter(Boolean).slice(0, 12);
  const commonArgs = ['search', ...queryArgs, '--json', '--limit', String(limit), '--sort', 'stars'];

  if (commandExists('skills')) {
    const result = spawnSync('skills', commonArgs, { encoding: 'utf-8', timeout: 30000 });
    if (result.status === 0) return parseMarketplaceOutput(result.stdout || result.stderr || '');
  }

  if (commandExists('npx')) {
    const result = spawnSync('npx', ['-y', 'agent-skills-cli', ...commonArgs], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    if (result.status === 0) return parseMarketplaceOutput((result.stdout || '') + (result.stderr || ''));
  }

  return null;
}

export function rankSkills(rawSkills: Array<RawSkill & { query: SearchQuery }>, keywords: string[], limit: number): RankedSkill[] {
  const ranked = new Map<string, RankedSkill>();

  for (let index = 0; index < rawSkills.length; index++) {
    const raw = rawSkills[index];
    const key = raw.scopedName || raw.githubUrl || `${raw.author}:${raw.name}`;
    if (!key) continue;

    const name = raw.name || 'unknown';
    const description = raw.description || '';
    const author = raw.author || 'unknown';
    const scopedName = raw.scopedName || `@${author}/${name}`;
    const githubUrl = raw.githubUrl || '';
    const stars = raw.stars || 0;
    const forks = raw.forks || 0;
    const haystack = `${name} ${scopedName} ${description}`.toLowerCase();
    const matchedKeywords = keywords.filter(keyword => haystack.includes(keyword.toLowerCase()));
    const exactNameMatch = matchedKeywords.some(keyword =>
      name.toLowerCase().includes(keyword) || scopedName.toLowerCase().includes(keyword)
    );

    const score =
      Math.max(0, 100 - index * 3) +
      matchedKeywords.length * 18 +
      (exactNameMatch ? 20 : 0) +
      (raw.query.source === 'keyword' ? 8 : 4) +
      Math.min(18, Math.floor(Math.log10(stars + 1) * 6));

    const next: RankedSkill = {
      name,
      description,
      author,
      scopedName,
      githubUrl,
      stars,
      forks,
      installCommand: `npx skills add ${scopedName}`,
      matchedKeywords,
      sourceQueries: [raw.query.text],
      score,
    };

    const existing = ranked.get(key);
    if (!existing || next.score > existing.score) {
      ranked.set(key, existing
        ? {
            ...next,
            sourceQueries: Array.from(new Set([...existing.sourceQueries, ...next.sourceQueries])),
            matchedKeywords: Array.from(new Set([...existing.matchedKeywords, ...next.matchedKeywords])),
          }
        : next);
    } else {
      existing.sourceQueries = Array.from(new Set([...existing.sourceQueries, raw.query.text]));
      existing.matchedKeywords = Array.from(new Set([...existing.matchedKeywords, ...next.matchedKeywords]));
    }
  }

  return Array.from(ranked.values())
    .sort((a, b) => b.score - a.score || b.stars - a.stars)
    .slice(0, limit);
}

function formatText(response: SearchResponse): string {
  if (response.status !== 'ok') {
    return `Marketplace unavailable: ${response.reason ?? 'unknown reason'}`;
  }
  if (response.results.length === 0) {
    return `No marketplace matches found for: ${response.query}`;
  }
  const lines = [`Marketplace matches for: ${response.query}`, ''];
  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.scopedName} — ${result.description}`);
    lines.push(`   Why: matched ${result.matchedKeywords.join(', ') || 'query context'}`);
    lines.push(`   Install: ${result.installCommand}`);
    if (result.githubUrl) lines.push(`   Source: ${result.githubUrl}`);
  });
  return lines.join('\n');
}

async function main() {
  try {
    const { query, explicitKeywords, limit, outputJson } = parseArgs(process.argv.slice(2));
    const keywords = Array.from(new Set([
      ...explicitKeywords.map(k => k.trim().toLowerCase()).filter(Boolean),
      ...extractKeywords(query),
    ])).slice(0, 6);
    const queries = buildQueries(query, explicitKeywords);
    const cacheKey = createHash('sha1')
      .update(JSON.stringify({ query, keywords, limit }))
      .digest('hex');

    if (!process.env.GSTACK_MARKETPLACE_FIXTURE) {
      const cached = readCache(cacheKey);
      if (cached) {
        console.log(outputJson ? JSON.stringify(cached, null, 2) : formatText(cached));
        return;
      }
    }

    const rawHits: Array<RawSkill & { query: SearchQuery }> = [];
    for (const searchQuery of queries) {
      const hits = runSearchQuery(searchQuery, Math.max(limit, 5));
      if (!hits) continue;
      for (const hit of hits) rawHits.push({ ...hit, query: searchQuery });
    }

    const response: SearchResponse = rawHits.length > 0
      ? {
          status: 'ok',
          query,
          keywords,
          queries: queries.map(item => item.text),
          results: rankSkills(rawHits, keywords, limit),
        }
      : {
          status: 'unavailable',
          query,
          keywords,
          queries: queries.map(item => item.text),
          results: [],
          reason: 'skills CLI unavailable or search failed',
        };

    if (!process.env.GSTACK_MARKETPLACE_FIXTURE) writeCache(cacheKey, response);
    console.log(outputJson ? JSON.stringify(response, null, 2) : formatText(response));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
