/**
 * pregate/init-draft — `gstack-pregate init` writes a policy drafted from the
 * repo (#3268) instead of a fixed example: the languages it holds, what the
 * lanes check would run, and a `dependencies` entry for each file the import
 * graph maps to no test.
 *
 * A drafted entry only ever adds tests: it maps an unmapped file to the tests
 * of the nearest directory above it that has any. An empty list (`[]`) would
 * clear the file without a test, so the draft never writes one; a file with no
 * nearby test, or past the schema's entry limit, is printed as a TODO for the
 * owner to decide. Documentation,
 * assets and tool config already clear without a policy (docs-lane.ts), and
 * Dart packages run per package root, so `runner` stays null unless no
 * runner can be detected.
 */
import * as path from 'node:path';
import { detectRunner } from './checks/lanes';
import { DEFAULT_CONFIG, MAX_LIST, PREGATE_CONFIG_PATH, PREGATE_CONFIG_SCHEMA } from './config';
import { isDocsEmptyLane, isInertNoTests } from './docs-lane';
import { buildGraph, listRepoFiles, testsFor } from './import-graph';
import { GENERATED_PATH, isRegistryUnavailable, loadRegistryFromHead } from '../regen';
import { matchesAny } from '../ship-policy';
import { discoverLanes } from './workflows';

const LANGUAGES: Array<[string, RegExp]> = [
  ['typescript', /\.[cm]?tsx?$/], ['javascript', /\.[cm]?jsx?$/], ['python', /\.py$/], ['dart', /\.dart$/],
  ['go', /\.go$/], ['ruby', /\.rb$/], ['rust', /\.rs$/], ['shell', /\.(?:sh|bash|bats)$/],
];
/** Above this many tests a directory's tests are no longer a useful suggestion. */
const MAX_SUGGESTED = 25;
const MAX_TODO_LINES = 50;

export interface InitDraft {
  json: string;
  languages: Array<{ language: string; files: number }>;
  runnerNote: string;
  drafted: number;
  todo: string[];
  selectionTodo: string[];
}

/** The tests under the nearest ancestor directory of `file` (not the repo root) that has 1..MAX_SUGGESTED tests. */
function nearestTests(tests: readonly string[], file: string): string[] {
  for (let dir = path.posix.dirname(file); dir !== '.' && dir !== ''; dir = path.posix.dirname(dir)) {
    const under = tests.filter(t => t.startsWith(`${dir}/`));
    if (under.length > MAX_SUGGESTED) return [];
    if (under.length) return under;
  }
  return [];
}

export function draftConfig(repoRoot: string): InitDraft {
  const files = listRepoFiles(repoRoot);
  const graph = buildGraph(repoRoot);
  const tests = [...graph.tests].sort();
  const languages = LANGUAGES.map(([language, re]) => ({ language, files: files.filter(f => re.test(f)).length })).filter(l => l.files > 0).sort((a, b) => b.files - a.files);

  const dependencies: Record<string, string[]> = {};
  const todo: string[] = [];
  let drafted = 0;
  const registry = loadRegistryFromHead(repoRoot);
  const generated = isRegistryUnavailable(registry) ? [] : registry.registry.entries.flatMap(e => [...e.inputs, ...e.outputs]);
  for (const file of files) {
    if (matchesAny(generated, file)) continue;
    if (graph.tests.has(file) || file === PREGATE_CONFIG_PATH || file === GENERATED_PATH) continue;
    if (isDocsEmptyLane(file) || isInertNoTests(file)) continue;
    if (testsFor(graph, file).tests.length) continue;
    const suggested = nearestTests(tests, file);
    if (!suggested.length || drafted >= MAX_LIST) { todo.push(file); continue; }
    dependencies[file] = suggested;
    drafted++;
  }

  const groups = new Map<string, string[]>();
  for (const t of tests) { const lang = t.endsWith('.dart') ? 'dart' : t.endsWith('.rs') ? 'rust' : t.endsWith('.py') ? 'python' : /\.[cm]?[jt]sx?$/.test(t) ? 'javascript' : 'other'; groups.set(lang, [...(groups.get(lang) ?? []), t]); }
  const notes = [...groups].map(([lang, list]) => {
    if (lang === 'dart') return `${list.length} Dart test file(s) run per package with flutter test or dart test`;
    if (lang === 'rust') return `${list.length} Rust test file(s) run per crate with cargo test -p`;
    const runner = detectRunner({ repoRoot, config: DEFAULT_CONFIG }, list);
    return runner ? `${lang} tests detected at run time: ${runner}` : `no runner detected for ${list.length} ${lang} test file(s); set runner (with {files})`;
  });
  const mixed = [...groups.keys()].filter(l => l !== 'dart' && l !== 'rust').length > 1 ? '; a selection mixing these languages needs runner set' : '';
  const runnerNote = notes.length ? notes.join('; ') + mixed : 'no test files found';

  const selectionTodo = discoverLanes(repoRoot).filter(l => l.runsTests && l.matrixExpression && l.testFiles.length === 0).map(l => l.id);
  const config = { $schema: PREGATE_CONFIG_SCHEMA, runner: null, dependencies, empty_lanes: [], selection: {}, warn: [], strays: { allow: [] } };
  return { json: JSON.stringify(config, null, 2) + '\n', languages, runnerNote, drafted, todo, selectionTodo };
}

/** The lines `init` prints after writing the draft. */
export function describeDraft(d: InitDraft): string[] {
  const lines = [
    `PREGATE_INIT: languages ${d.languages.map(l => `${l.language} ${l.files}`).join(', ') || '(none recognised)'}`,
    `PREGATE_INIT: runner null (${d.runnerNote})`,
    `PREGATE_INIT: ${d.drafted} file(s) with no test lane mapped to the tests nearest them under dependencies; review each entry`,
  ];
  for (const id of d.selectionTodo) lines.push(`TODO selection: ${id} computes its matrix; declare the command that lists its test files under selection`);
  for (const f of d.todo.slice(0, MAX_TODO_LINES)) lines.push(`TODO ${f}: no test lane and no nearby test; add a test, map it under dependencies, or declare [] if no test can cover it`);
  if (d.todo.length > MAX_TODO_LINES) lines.push(`TODO: +${d.todo.length - MAX_TODO_LINES} more file(s) with no test lane`);
  return lines;
}
