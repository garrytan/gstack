#!/usr/bin/env bun
/**
 * research-tools CLI — search academic APIs and deduplicate results.
 *
 * Commands:
 *   search --query "..." [--max N] [--year-from YYYY] [--year-to YYYY] [--sources s1,s2] [--email x] [--output path]
 *   validate --file path.jsonl
 */

import { searchAll } from './apis';
import { dedup } from './dedup';
import type { ApiSource, PaperRecord, SearchCriteria, SearchMeta } from './types';
import { writeFileSync, readFileSync, existsSync } from 'fs';

function usage(): never {
  console.error(`research-tools — academic literature search + dedup

Commands:
  search   Search academic APIs and write deduplicated results.
  validate Check that a JSONL file contains valid JSON records.

search options:
  --query, -q     Research question (required)
  --max, -m       Max results per source (default: 50)
  --year-from     Filter: earliest publication year
  --year-to       Filter: latest publication year
  --sources, -s   Comma-separated API list (default: all)
                  Options: semantic_scholar, pubmed, arxiv, openalex
  --email, -e     Email for OpenAlex polite pool
  --output, -o    Output directory (default: ./artifacts)
  --resume        Resume: skip sources that already have results

validate options:
  --file, -f      Path to JSONL file to validate (required)`);
  process.exit(1);
}

function parseArgs(args: string[]): { command: string; flags: Record<string, string> } {
  const command = args[0];
  if (!command) usage();
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      flags[key] = args[++i] ?? '';
    } else if (arg.startsWith('-') && arg.length === 2) {
      const shortMap: Record<string, string> = { q: 'query', m: 'max', s: 'sources', e: 'email', o: 'output', f: 'file' };
      const key = shortMap[arg[1]] ?? arg[1];
      flags[key] = args[++i] ?? '';
    }
  }
  return { command, flags };
}

async function runSearch(flags: Record<string, string>) {
  const query = flags.query;
  if (!query) {
    console.error('Error: --query is required');
    process.exit(1);
  }

  const outputDir = flags.output ?? './artifacts';
  const resultsFile = `${outputDir}/search_results.jsonl`;
  const metaFile = `${outputDir}/search_meta.json`;
  const resume = 'resume' in flags;

  // Ensure output directory exists
  const { mkdirSync } = await import('fs');
  mkdirSync(outputDir, { recursive: true });

  // Check for resume: load existing results and determine which sources to skip
  let existingPapers: PaperRecord[] = [];
  const completedSources = new Set<ApiSource>();
  if (resume && existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8')) as SearchMeta;
      for (const src of meta.sources) {
        if (src.status === 'success') completedSources.add(src.source);
      }
      console.error(`Resuming: skipping ${completedSources.size} completed sources`);
    } catch { /* ignore corrupt meta */ }
  }
  if (resume && existsSync(resultsFile)) {
    const lines = readFileSync(resultsFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { existingPapers.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }
  }

  const requestedSources: ApiSource[] | undefined = flags.sources
    ? (flags.sources.split(',').map(s => s.trim()) as ApiSource[])
    : undefined;

  const sources = (requestedSources ?? ['semantic_scholar', 'pubmed', 'arxiv', 'openalex'] as ApiSource[])
    .filter(s => !completedSources.has(s));

  if (sources.length === 0) {
    console.error('All sources already completed. Use without --resume to re-search.');
    process.exit(0);
  }

  const criteria: SearchCriteria = {
    query,
    maxPerSource: parseInt(flags.max ?? '50', 10),
    yearFrom: flags['year-from'] ? parseInt(flags['year-from'], 10) : undefined,
    yearTo: flags['year-to'] ? parseInt(flags['year-to'], 10) : undefined,
    sources,
    email: flags.email,
  };

  console.error(`Searching ${sources.join(', ')} for: "${query}"`);

  const result = await searchAll(criteria, (source, count) => {
    console.error(`  ${source}: ${count} results`);
  });

  // Combine with existing papers if resuming
  const allPapers = [...existingPapers, ...result.papers];

  // Deduplicate
  const dedupResult = dedup(allPapers);
  console.error(`\nDedup: ${allPapers.length} total → ${dedupResult.unique.length} unique (${dedupResult.duplicatesRemoved} duplicates removed)`);

  // Write JSONL results
  const jsonl = dedupResult.unique.map(p => JSON.stringify(p)).join('\n') + '\n';
  writeFileSync(resultsFile, jsonl);
  console.error(`Results written to ${resultsFile}`);

  // Write search meta
  const meta: SearchMeta = {
    query,
    sources: result.sources,
    totalResults: allPapers.length,
    totalAfterDedup: dedupResult.unique.length,
    searchedAt: new Date().toISOString(),
    parameters: criteria,
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  console.error(`Meta written to ${metaFile}`);

  // Print summary to stdout (machine-readable)
  console.log(JSON.stringify({
    total: allPapers.length,
    unique: dedupResult.unique.length,
    duplicatesRemoved: dedupResult.duplicatesRemoved,
    sources: result.sources.map(s => ({ source: s.source, status: s.status, count: s.resultsFound })),
  }));
}

function runValidate(flags: Record<string, string>) {
  const file = flags.file;
  if (!file) {
    console.error('Error: --file is required');
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }

  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  let valid = 0;
  let invalid = 0;
  const errors: Array<{ line: number; error: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
      valid++;
    } catch (err) {
      invalid++;
      errors.push({ line: i + 1, error: (err as Error).message });
    }
  }

  console.log(JSON.stringify({ file, totalLines: lines.length, valid, invalid, errors: errors.slice(0, 10) }));
  process.exit(invalid > 0 ? 1 : 0);
}

// ─── Main ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) usage();

const { command, flags } = parseArgs(args);

switch (command) {
  case 'search':
    await runSearch(flags);
    break;
  case 'validate':
    runValidate(flags);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
}
