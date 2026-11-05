/**
 * Review-bot history facts, checked without a model (GST-1403). /review and /ship
 * hand history writes to review/greptile-triage.md, gstack-review-bots writes and
 * reads the rows, and /retro reads the global file through gstack-retro-metrics.
 * Each fact is compared against lib/review-bots.ts's constants and row parser, so
 * a skill that drifts from the others or from the code fails here.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CATEGORIES, HISTORY_FILE, HISTORY_TYPES, LEGACY_HISTORY_FILE, parseHistory } from '../lib/review-bots';

const ROOT = path.resolve(import.meta.dir, '..');
const FILES = {
  triage: 'review/greptile-triage.md',
  review: 'review/SKILL.md',
  ship: 'ship/SKILL.md',
  shipBots: 'ship/sections/greptile.md',
  retro: 'retro/SKILL.md',
  retroMetrics: 'bin/gstack-retro-metrics',
  writer: 'lib/review-bots.ts',
} as const;
type Sources = Record<keyof typeof FILES, string>;

const read = (): Sources => Object.fromEntries(
  Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(path.join(ROOT, file), 'utf8')])) as Sources;
const ticks = (values: readonly string[]) => values.map(value => `\`${value}\``).join(', ');

function disagreements(s: Sources): string[] {
  const issues: string[] = [];
  const need = (key: keyof Sources, text: string, why: string) => {
    if (!s[key].includes(text)) issues.push(`${FILES[key]} lacks "${text}" (${why})`);
  };

  need('triage', '## History File Writes', 'the section /review and /ship delegate to');
  need('review', "greptile-triage.md's Output Format summary in your header and its History File Writes", '/review delegates history writes');
  need('shipBots', 'from greptile-triage.md (inline diff + explanation) and record it (History File Writes', '/ship delegates history writes');
  for (const key of ['review', 'ship', 'shipBots'] as const) {
    for (const name of [HISTORY_FILE, LEGACY_HISTORY_FILE]) {
      if (s[key].includes(name)) issues.push(`${FILES[key]} names ${name}; only greptile-triage.md states history paths`);
    }
  }

  need('triage', `It appends one row to the project's \`${HISTORY_FILE}\` (suppressions) and the global one (retro):`, 'writes go to both files');
  need('writer', 'path.join(root, "projects", id, name)', 'the per-project history file');
  need('writer', 'path.join(root, name)]', 'the global history file');
  need('triage', `rows in the old \`${LEGACY_HISTORY_FILE}\` count as Greptile's`, 'legacy rows');
  need('retro', "(column 6: bot; old rows Greptile's)", 'retro reads the bot column and legacy rows');
  need('retroMetrics', '_GH="$_gstack_sr_root"', 'retro reads the global state root');
  for (const name of [HISTORY_FILE, LEGACY_HISTORY_FILE]) need('retroMetrics', `[ -f "$_GH/${name}" ]`, 'retro reads the global file only');
  if (/projects\/[^\n]*history\.md/.test(s.retroMetrics)) issues.push(`${FILES.retroMetrics} reads a per-project history file; /retro aggregates the global one`);

  const row = s.triage.match(/`(<YYYY-MM-DD> \| [^`\n]+)`/)?.[1];
  if (!row) issues.push(`${FILES.triage} lacks the history row format`);
  else {
    const cells = row.split(' | ');
    const [parsed] = parseHistory(row);
    const expected = { repo: '<owner/repo>', type: '<type>', pattern: '<file-pattern>', category: '<category>', bot: '<bot>' };
    if (cells.length !== 6 || JSON.stringify(parsed) !== JSON.stringify(expected)) {
      issues.push(`${FILES.triage} row "${row}" does not parse as parseHistory's columns ${JSON.stringify(expected)}`);
    }
    const botColumn = cells.indexOf('<bot>') + 1;
    if (!s.retro.includes(`column ${botColumn}: bot`)) issues.push(`${FILES.retro} does not read the bot from column ${botColumn}`);
    const written = s.writer.match(/const row = `\$\{[^`]*?\} \| ([^`]+?)\\n`/)?.[1]?.split(' | ').map(cell => cell.match(/^\$\{(\w+)/)?.[1]);
    if (JSON.stringify(written) !== JSON.stringify(['repo', 'type', 'file', 'category', 'bot'])) {
      issues.push(`${FILES.writer} writes columns ${JSON.stringify(written)}, not the row ${FILES.triage} documents`);
    }
  }

  need('triage', `--type <${HISTORY_TYPES.join('|')}>`, 'record types');
  need('retro', `count ${ticks(HISTORY_TYPES)};`, 'retro counts every record type');
  need('triage', `**Categories** (fixed set): ${ticks(CATEGORIES)}\n`, 'categories the helper accepts');
  return issues;
}

describe('review-bot history facts agree across /review, /ship, /retro and gstack-review-bots', () => {
  test('the checked-in skills and helpers agree', () => {
    expect(disagreements(read())).toEqual([]);
  });

  const mutations: Array<[string, keyof Sources, string, string, RegExp]> = [
    ['retro reads the wrong column', 'retro', 'column 6: bot', 'column 5: bot', /does not read the bot from column 6/],
    ['triage drops a category', 'triage', ', `other`', '', /Categories/],
    ['triage reorders the row', 'triage', '<type> | <file-pattern>', '<file-pattern> | <type>', /does not parse as parseHistory's columns/],
    ['triage says retro reads the project file', 'triage', 'and the global one (retro)', 'only (retro)', /writes go to both files/],
    ['retro-metrics reads a project file', 'retroMetrics', '"$_GH/review-bot-history.md"', '"$_GH/projects/$_SLUG/review-bot-history.md"', /global file only|per-project history file/],
    ['/review restates a history path', 'review', 'its History File Writes for each record.', 'its History File Writes for each record in ~/.gstack/greptile-history.md.', /review\/SKILL\.md names greptile-history\.md/],
    ['/ship stops delegating', 'shipBots', 'record it (History File Writes', 'record it', /\/ship delegates history writes/],
    ['retro skips a record type', 'retro', 'count `fix`, `fp`, `already-fixed`;', 'count `fix`, `fp`;', /retro counts every record type/],
    ['the writer swaps two columns', 'writer', '| ${type} | ${file} |', '| ${file} | ${type} |', /writes columns/],
    ['legacy rows lose their owner', 'triage', "count as Greptile's", 'are ignored', /legacy rows/],
  ];

  test.each(mutations)('fails when %s', (_label, key, from, to, issue) => {
    const sources = read();
    expect(sources[key]).toContain(from);
    const issues = disagreements({ ...sources, [key]: sources[key].replace(from, to) });
    expect(issues.some(line => issue.test(line)), issues.join('\n')).toBe(true);
  });
});
