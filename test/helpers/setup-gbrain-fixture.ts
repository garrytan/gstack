/**
 * setup-gbrain E2E fixture builder — carve-aware (token-reduction Phase 4).
 *
 * setup-gbrain is carved: the generated SKILL.md is a decision-tree skeleton
 * whose STOP-Read pointers reference install paths
 * (`~/.claude/skills/gstack/setup-gbrain/sections/*.md`) that do not exist in
 * a hermetic E2E sandbox. Pointing an agent at the raw skeleton would burn
 * turns on failed Reads and never reach the per-path init procedures under
 * test. This builder reconstructs a runnable single-file fixture, wave-1
 * style (see the codex fixture in test/skill-e2e-workflow.test.ts):
 *
 *   1. slice the skeleton from the skill title (dropping the shared preamble —
 *      CLAUDE.md rule: "E2E test fixtures: extract, don't copy"),
 *   2. cut the Section index table (its sections/ paths don't resolve here),
 *   3. replace each STOP pointer with the section body the test needs, or an
 *      explicit "not needed" stub for the rest, and
 *   4. run a non-empty guard: every needed section's distinctive anchor must
 *      be present in the result, so a renamed/emptied section fails loudly
 *      instead of shipping a silently hollow fixture.
 *
 * Monolith-tolerant: if the generated SKILL.md has no STOP pointers (pre-carve
 * checkout, or a regen that un-carves), the bodies are still inline and the
 * anchor guard passes — the builder works on both shapes.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const SKILL_MD = path.join(ROOT, 'setup-gbrain', 'SKILL.md');
const SECTIONS_DIR = path.join(ROOT, 'setup-gbrain', 'sections');

const TITLE = '# /setup-gbrain — Coding-Agent Onboarding for gbrain';

/** Matches one generated STOP-Read pointer (two lines) and captures the section file name. */
const STOP_POINTER =
  /^> \*\*STOP\.\*\* Before [^\n]*sections\/([a-z0-9-]+\.md)[^\n]*\n> in full\.[^\n]*/gm;

/** Distinctive per-section anchors — the non-empty guard for inlined content. */
export const SECTION_ANCHORS: Record<string, string> = {
  'brain-init.md': '### Path 4 (Remote gbrain MCP',
  'claude-md-persist.md': 'Mode: remote-http',
  'engine-remediation.md': "Your local gbrain engine isn't responding",
  'transcript-gate.md': 'gstack-memory-ingest.ts --probe',
};

/**
 * Build the fixture text: skeleton (preamble dropped, Section index cut) with
 * `neededSections` inlined at their STOP pointers and every other pointer
 * replaced by an explicit not-needed stub. Throws on any missing anchor.
 */
export function buildSetupGbrainFixture(
  neededSections: string[],
  options: { helperBinDir?: string } = {},
): string {
  for (const file of neededSections) {
    if (!(file in SECTION_ANCHORS)) {
      throw new Error(
        `setup-gbrain fixture: unknown section "${file}" — known: ${Object.keys(SECTION_ANCHORS).join(', ')}`,
      );
    }
  }

  let full = fs.readFileSync(SKILL_MD, 'utf-8');

  const titleIdx = full.indexOf(TITLE);
  if (titleIdx < 0) throw new Error(`setup-gbrain fixture: title heading not found: "${TITLE}"`);
  full = full.slice(titleIdx);

  // Cut the Section index table (heading through its closing --- separator).
  const idxStart = full.indexOf('## Section index');
  if (idxStart >= 0) {
    const idxEnd = full.indexOf('\n---\n', idxStart);
    if (idxEnd < 0) throw new Error('setup-gbrain fixture: Section index has no closing ---');
    full = full.slice(0, idxStart) + full.slice(idxEnd + '\n---\n'.length);
  }

  full = full.replace(STOP_POINTER, (_m, file: string) => {
    if (!neededSections.includes(file)) {
      return '_(Section not included in this fixture — not needed for this run. Continue with the next step.)_';
    }
    const secPath = path.join(SECTIONS_DIR, file);
    if (!fs.existsSync(secPath)) {
      throw new Error(
        `setup-gbrain fixture: sections/${file} not generated — run bun run gen:skill-docs`,
      );
    }
    const body = fs
      .readFileSync(secPath, 'utf-8')
      .replace(/^<!--[^\n]*-->\n/gm, '') // strip AUTO-GENERATED header comments
      .trim();
    if (body.length < 500) {
      throw new Error(`setup-gbrain fixture: sections/${file} is unexpectedly small/empty`);
    }
    return body;
  });

  // Non-empty guard on the RESULT — holds for both the carved shape (section
  // inlined above) and the monolith shape (body was never carved out).
  for (const file of neededSections) {
    if (!full.includes(SECTION_ANCHORS[file])) {
      throw new Error(
        `setup-gbrain fixture: needed section "${file}" content missing from fixture ` +
          `(anchor not found: "${SECTION_ANCHORS[file]}")`,
      );
    }
  }

  // Preserve the extracted instructions; only rebind their install location.
  // PATH alone cannot redirect the literal ~/.../bin commands in the skill.
  if (options.helperBinDir) {
    const quotedBin = `'${options.helperBinDir.replaceAll("'", "'\\''")}'`;
    full = full.replaceAll('~/.claude/skills/gstack/bin', quotedBin);
  }
  return full;
}

/** This opt-in fixture answers recognized decisions from their offered choices.
 * Explanatory text can mention artifacts inside the local-code offer. Reject
 * unknown or mixed actions instead of silently consenting to another action.
 */
export function chooseLocalPgliteFixtureAnswer(question: {
  question: string;
  options: Array<{ label: string }>;
}): string {
  let options = question.options.map(option => ({
    option, label: option.label.replace(/\s*\(recommended\)\s*$/i, '').trim().replace(/\s+/g, ' '),
  }));
  // Strip only a complete, consistently numbered choice inventory. Backend
  // names such as "3 — PGLite local" are semantic labels, not selectors.
  const prefixes = options.map(o => /^([A-D1-4])([).])\s+(.+)$/.exec(o.label));
  if (prefixes.some(Boolean)) {
    const first = prefixes.find(Boolean)!;
    const expected = (/^[A-D]$/.test(first[1]) ? 'ABCD' : '1234').slice(0, options.length);
    if (options.length < 2 || options.length > 4 || prefixes.some(p => !p || p[2] !== first[2])
      || prefixes.map(p => p?.[1]).sort().join('') !== expected) {
      throw new Error(`Unrecognized or ambiguous local-PGLite fixture question: ${question.question.split('\n')[0]}`);
    }
    options = options.map((o, index) => ({ ...o, label: prefixes[index]![3] }));
  }
  // An em dash after the initial Yes/No is the observed comma separator.
  // Keep all action text and trailing qualifiers for the anchored classifiers.
  options = options.map(o => ({ ...o, label: o.label.replace(/^(yes|no) — /i, '$1, ') }));
  // The optional transport name does not change the remote-only decline.
  const remoteOnlyDecline = /^no,? remote(?: mcp)? only$/i;
  const declines = options.filter(o => /^(?:no(?:,? thanks)?|skip(?: artifacts sync)?|decline(?: artifacts sync)?)$/i.test(o.label)
    || remoteOnlyDecline.test(o.label));
  const local = options.filter(o => /^yes,? (?:(?:set up|install|enable|use) )?local pglite(?: for (?:code|code search))?$/i.test(o.label));
  const sync = options.filter(o => /^(?:yes,? )?(?:full sync(?: \(everything allowlisted\))?|artifacts[- ]only(?: sync)?|sync (?:all|artifacts)(?: only)?)$/i.test(o.label));
  const remote = options.filter(o => /^(?:(?:use|connect to|select) )?remote (?:gbrain )?mcp(?: \(path ?4\))?$/i.test(o.label)
    || /^path ?4(?:\s*[-—–:]\s*remote (?:gbrain )?mcp)?$/i.test(o.label)
    || /^4 — remote gbrain mcp\.?$/i.test(o.label));
  // Step 2's existing backend alternatives are not affirmative setup actions.
  const backendLabels = new Set([
    'local pglite', '1 — supabase, i already have a connection string',
    '2a — supabase, auto-provision a new project', '2b — supabase, create manually',
    '3 — pglite local',
  ]);
  const otherBackends = options.filter(o => backendLabels.has(o.label.replace(/\.$/, '').toLowerCase()));
  const known = new Set([...declines, ...local, ...sync, ...remote, ...otherBackends]);
  const families = [local.length, sync.length, remote.length + otherBackends.length].filter(Boolean);
  if (known.size !== options.length || families.length !== 1) {
    throw new Error(`Unrecognized or ambiguous local-PGLite fixture question: ${question.question.split('\n')[0]}`);
  }
  if (local.length === 1 && declines.length === 1 && remoteOnlyDecline.test(declines[0]!.label)) return local[0]!.option.label;
  if (sync.length > 0 && declines.length === 1) return declines[0]!.option.label;
  if (remote.length === 1) return remote[0]!.option.label;
  throw new Error(`Unrecognized or ambiguous local-PGLite fixture question: ${question.question.split('\n')[0]}`);
}
