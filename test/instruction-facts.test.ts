/**
 * Instruction facts pinned to their sources (free, static).
 *
 * CLAUDE.md and skill templates state facts that code owns: which free test
 * files run serially, the catalog token ceiling, where the detach timeouts
 * live, which /ship step another skill points at, and where gstack state is
 * read and written. Each check below fails with both values, the file:line,
 * and the fix, so drift is repaired at the source instead of rediscovered by
 * an agent following stale prose.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TREE_MUTATING } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const claudeMd = read('CLAUDE.md');

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'test', 'dist', '.context'].includes(entry.name) || entry.name.startsWith('.')) continue;
      out.push(...walk(rel, keep));
    } else if (keep(rel)) out.push(rel);
  }
  return out.sort();
}

const templates = walk('.', rel => rel.endsWith('.tmpl'));
const resolvers = walk('scripts/resolvers', rel => rel.endsWith('.ts'));

describe('CLAUDE.md facts match the code that owns them', () => {
  test('CLAUDE.md names every TREE_MUTATING file and does not call the set empty', () => {
    const at = claudeMd.indexOf('`TREE_MUTATING`');
    expect(at, 'CLAUDE.md:? no longer mentions `TREE_MUTATING`; fix: describe scripts/test-free-shards.ts TREE_MUTATING in the Testing section').toBeGreaterThanOrEqual(0);
    const paragraph = claudeMd.slice(at, claudeMd.indexOf('\n\n', at));
    const keys = Object.keys(TREE_MUTATING);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(paragraph.includes(key),
        `CLAUDE.md:${lineOf(claudeMd, at)} TREE_MUTATING text omits ${key}; code (scripts/test-free-shards.ts) lists ${JSON.stringify(keys)}; fix: name every key in that paragraph`).toBe(true);
    }
    expect(paragraph, `CLAUDE.md:${lineOf(claudeMd, at)} calls TREE_MUTATING empty while code lists ${JSON.stringify(keys)}; fix: name the files`)
      .not.toMatch(/TREE_MUTATING`[^.]*\b(?:is|now) empty\b|no files? (?:still )?run/i);
  });

  test('CLAUDE.md states the current catalog ceiling from test/catalog-budget.test.ts', () => {
    const source = read('test/catalog-budget.test.ts');
    const constant = /const CATALOG_BUDGET_TOKEN_EQUIVALENTS = ([\d_]+);/.exec(source);
    expect(constant, 'test/catalog-budget.test.ts no longer declares CATALOG_BUDGET_TOKEN_EQUIVALENTS as a literal; fix: update this parser').not.toBeNull();
    const value = Number(constant![1]!.replace(/_/g, ''));
    const at = claudeMd.indexOf('`CATALOG_BUDGET_TOKEN_EQUIVALENTS`');
    expect(at, 'CLAUDE.md no longer names `CATALOG_BUDGET_TOKEN_EQUIVALENTS`; fix: name the constant next to its value').toBeGreaterThanOrEqual(0);
    const stated = /^`CATALOG_BUDGET_TOKEN_EQUIVALENTS` \(([\d,]+) today/.exec(claudeMd.slice(at));
    expect(stated, `CLAUDE.md:${lineOf(claudeMd, at)} names the constant without "(<value> today"; fix: state ${value.toLocaleString('en-US')}`).not.toBeNull();
    const claimed = Number(stated![1]!.replace(/,/g, ''));
    expect(claimed, `CLAUDE.md:${lineOf(claudeMd, at)} says ${claimed}, test/catalog-budget.test.ts says ${value}; fix: update CLAUDE.md to ${value.toLocaleString('en-US')}`).toBe(value);
  });

  test('CLAUDE.md points at package.json for detach timeouts instead of stating numbers', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    const timeouts = Object.entries(scripts)
      .filter(([name, command]) => name.startsWith('eval:bg') && /--timeout \d+/.test(command))
      .map(([name, command]) => ({ name, seconds: /--timeout (\d+)/.exec(command)![1]! }));
    for (const { name, seconds } of timeouts) {
      for (const spelled of [seconds, Number(seconds).toLocaleString('en-US')]) {
        const at = claudeMd.indexOf(spelled);
        expect(at, `CLAUDE.md:${lineOf(claudeMd, at)} states ${spelled}, the ${name} --timeout in package.json; fix: point at package.json's \`${name}\` instead of copying the number`).toBe(-1);
      }
    }
    const start = claudeMd.indexOf('## Running evals as an agent');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = claudeMd.slice(start, claudeMd.indexOf('\n## ', start + 1));
    expect(section).toContain("package.json's `eval:bg:gate` / `eval:bg:periodic`");
    const stale = /--timeout \d+|\b\d[\d,]{3,}\s*(?:s|sec|seconds)\b/.exec(section);
    expect(stale?.[0] ?? null,
      `CLAUDE.md:${stale ? lineOf(claudeMd, start + stale.index) : '?'} states a timeout number in the detach section; package.json owns it; fix: remove the number`).toBeNull();
  });
});

// Explicit cross-skill references to a /ship step. Each row names the step's
// title subject; the reference's own line or enclosing heading must mention it,
// so pointing at a different existing step fails as well as a missing one.
// A historical row records an incident-history comment, not an instruction;
// it is exempt from title checks but must still match its reference.
const SHIP_STEP_REFERENCES: Array<{ file: string; step: string; title?: string; historical?: string }> = [
  { file: 'document-release/sections/release-body.md.tmpl', step: '14', title: 'TODOS.md' },
];
const SHIP_REFERENCE = /\/ship`?(?:'s)? Step (\d+(?:\.\d+)?)\b/g;

function shipSteps(): Map<string, string> {
  const steps = new Map<string, string>();
  for (const rel of ['ship/SKILL.md.tmpl', ...walk('ship/sections', file => file.endsWith('.md.tmpl'))]) {
    for (const match of read(rel).matchAll(/^#{2,4} Step (\d+(?:\.\d+)?): (.+)$/gm)) steps.set(match[1]!, match[2]!.trim());
  }
  return steps;
}

function shipReferenceProblems(sources: Record<string, string>): string[] {
  const steps = shipSteps();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [file, text] of Object.entries(sources)) {
    for (const match of text.matchAll(SHIP_REFERENCE)) {
      const step = match[1]!;
      const line = lineOf(text, match.index!);
      const row = SHIP_STEP_REFERENCES.find(r => r.file === file && r.step === step);
      if (!row) {
        const near = SHIP_STEP_REFERENCES.filter(r => r.file === file).map(r => `Step ${r.step} (${r.title ?? 'historical'})`);
        problems.push(`${file}:${line} references /ship Step ${step} ("${steps.get(step) ?? 'undefined'}"), but the table expects ${near.length ? near.join(', ') : 'no /ship reference here'}; fix: correct the step number, or add a row naming the step's title subject`);
        continue;
      }
      seen.add(`${file}#${step}`);
      if (row.historical) continue;
      const title = steps.get(step);
      if (!title) {
        problems.push(`${file}:${line} references /ship Step ${step}, which ship/SKILL.md.tmpl and ship/sections/*.md.tmpl do not define; fix: point at the step that now owns "${row.title}"`);
        continue;
      }
      if (!title.includes(row.title!)) {
        problems.push(`${file}:${line} references /ship Step ${step} expecting "${row.title}", but that step is now "${title}"; fix: point at the step titled "${row.title}" or update the row`);
        continue;
      }
      const heading = text.slice(0, match.index!).match(/^#{1,4} .+$/gm)?.at(-1) ?? '';
      const context = `${heading}\n${text.split('\n')[line - 1]}`;
      if (!context.includes(row.title!)) {
        problems.push(`${file}:${line} references /ship Step ${step} ("${title}") but neither the line nor its heading "${heading}" mentions "${row.title}"; fix: reference the /ship step that matches this section's subject`);
      }
    }
  }
  for (const row of SHIP_STEP_REFERENCES) {
    if (row.file in sources && !seen.has(`${row.file}#${row.step}`)) {
      problems.push(`${row.file}: table row for /ship Step ${row.step} (${row.title ?? 'historical'}) matches no reference; fix: delete the stale row`);
    }
  }
  return problems;
}

describe('/ship step references resolve to the step they mean', () => {
  const sources = Object.fromEntries([...templates, ...resolvers].map(rel => [rel, read(rel)]));

  test('every explicit /ship Step reference names a defined /ship step with the expected title', () => {
    expect(shipReferenceProblems(sources)).toEqual([]);
  });

  test('negative control: moving a reference to another existing /ship step fails', () => {
    const file = 'document-release/sections/release-body.md.tmpl';
    const moved = sources[file]!.replace("`/ship`'s Step 14.", "`/ship`'s Step 12.");
    expect(moved).not.toBe(sources[file]);
    expect(shipSteps().has('12')).toBe(true);
    const problems = shipReferenceProblems({ ...sources, [file]: moved });
    expect(problems.some(problem => problem.startsWith(`${file}:`) && problem.includes('Step 12'))).toBe(true);
  });
});

// Every literal default-root state path in templates and resolvers. Writers
// resolve $GSTACK_STATE_ROOT (docs/state-root.md); a literal ~/.gstack path
// only matches them when the state root is the default. Rows are user-facing
// descriptions, source comments, or readers that must match a writer outside
// the state root. Manifest globs use the `{gstack_state_root}/` prefix. New
// hits fail.
const STATE_ROOT_LITERAL = /~\/\.gstack\/(?:projects|analytics)\//g;
const RATCHET_ALLOWLIST = JSON.parse(read('test/state-root-ratchet.allowlist.json')) as Array<{ path: string; match: string; reason: string }>;
const readinessEvalReason = RATCHET_ALLOWLIST.find(entry => entry.path === 'land-and-deploy/sections/readiness-gate.md.tmpl')!.reason;
const DESCRIPTION = 'user-facing description of where the data lives; no command reads or writes this literal';
const SOURCE_COMMENT = 'source comment, not rendered into any skill';

const STATE_ROOT_ALLOWLIST: Array<{ file: string; match: string; reason: string }> = [
  { file: 'autoplan/SKILL.md.tmpl', match: 'test plan on disk at ~/.gstack/projects/$SLUG/', reason: DESCRIPTION },
  { file: 'careful/SKILL.md.tmpl', match: '`~/.gstack/projects/<slug>/careful-patterns.txt` (per-project)', reason: DESCRIPTION },
  { file: 'design-shotgun/SKILL.md.tmpl', match: 'v1 schema at `~/.gstack/projects/$SLUG/taste-profile.json`', reason: DESCRIPTION },
  { file: 'land-and-deploy/sections/readiness-gate.md.tmpl', match: 'eval store (`~/.gstack/projects/<slug>/evals/`', reason: readinessEvalReason },
  { file: 'land-and-deploy/sections/readiness-gate.md.tmpl', match: 'EVAL_DIR=~/.gstack/projects/$SLUG/evals', reason: readinessEvalReason },
  { file: 'office-hours/SKILL.md.tmpl', match: "see each other's design docs in `~/.gstack/projects/`", reason: DESCRIPTION },
  { file: 'office-hours/sections/design-and-handoff.md.tmpl', match: 'The design doc at `~/.gstack/projects/` is automatically discoverable', reason: DESCRIPTION },
  { file: 'plan-ceo-review/sections/review-sections.md.tmpl', match: 'Keep in `~/.gstack/projects/` only (local, personal reference)', reason: DESCRIPTION },
  { file: 'plan-tune/SKILL.md.tmpl', match: 'Logs stay local (`~/.gstack/projects/<slug>/question-log.jsonl`)', reason: DESCRIPTION },
  { file: 'plan-tune/SKILL.md.tmpl', match: '`~/.gstack/projects/<slug>/question-log.jsonl` — nothing leaves your', reason: DESCRIPTION },
  { file: 'scripts/resolvers/learnings.ts', match: '* Learnings are stored per-project at ~/.gstack/projects/{slug}/learnings.jsonl', reason: SOURCE_COMMENT },
  { file: 'scripts/resolvers/preamble.ts', match: 'local JSONL append to ~/.gstack/analytics/ (inline, inspectable)', reason: SOURCE_COMMENT },
];

describe('templates and resolvers name gstack state only through allowlisted literals', () => {
  const hits = [...templates, ...resolvers].flatMap(file => {
    const text = read(file);
    return [...text.matchAll(STATE_ROOT_LITERAL)].map(match => {
      const line = lineOf(text, match.index!);
      return { file, line, text: text.split('\n')[line - 1]! };
    });
  });

  test('every ~/.gstack/projects/ and ~/.gstack/analytics/ hit is allowlisted with a reason', () => {
    expect(hits.length).toBeGreaterThan(0);
    const unlisted = hits
      .filter(hit => !STATE_ROOT_ALLOWLIST.some(row => row.file === hit.file && row.reason && hit.text.includes(row.match)))
      .map(hit => `${hit.file}:${hit.line} names ${hit.text.match(STATE_ROOT_LITERAL)![0]} ("${hit.text.trim().slice(0, 100)}"); fix: use $GSTACK_STATE_ROOT (docs/state-root.md) or add a STATE_ROOT_ALLOWLIST row with a reason`);
    expect(unlisted).toEqual([]);
  });

  test('every state-root allowlist row still matches a hit', () => {
    const stale = STATE_ROOT_ALLOWLIST
      .filter(row => !hits.some(hit => hit.file === row.file && hit.text.includes(row.match)))
      .map(row => `${row.file}: allowlist row "${row.match}" matches no ~/.gstack/projects|analytics line; fix: delete the row (the literal was converted or moved)`);
    expect(stale).toEqual([]);
  });
});
