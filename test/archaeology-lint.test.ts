/**
 * Archaeology lint: model-read skill text carries rules, not history.
 *
 * Issue and PR numbers ("(#2477)", "See #1327", "PR #605") and incident
 * stories tell the model where a rule came from, which it cannot use, and cost
 * tokens in every session. The lint renders every host into a temp dir (the
 * text models actually read), scans each generated SKILL.md and section, maps
 * every hit back to the template or resolver that emitted it, and fails with
 * that source. Legitimate references (upstream bug IDs, usage examples,
 * sample output) are allowlisted by skill plus a nearby anchor string, each
 * with a reason; an entry that no longer matches anything fails too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/** `source` narrows an entry to hits emitted by one template or resolver. */
interface AllowEntry { skills: string[]; anchor: string; reason: string; source?: string }

/** Pending entries name an edit another workstream owns; delete them when it lands. */
const ALLOWLIST: AllowEntry[] = [
  { skills: ['land-and-deploy'], anchor: 'cli/cli#', reason: 'upstream GitHub CLI bug IDs behind the merge-queue retry guidance' },
  { skills: ['land-and-deploy'], anchor: '/land-and-deploy #123', reason: 'usage example of the PR-number argument' },
  { skills: ['landing-report'], anchor: 'alpha-branch', reason: 'sample landing-report output (PR numbers in the queue table)' },
  { skills: ['landing-report'], anchor: 'feat/payments', reason: 'sample landing-report output (PR number of a sibling workspace)' },
  { skills: ['retro'], anchor: 'Biggest ship: PR #605', reason: 'sample retro output' },
  { skills: ['codex'], anchor: 'OpenAI issues #8545', reason: 'upstream OpenAI Codex issue IDs behind the reasoning-effort default' },
  { skills: ['captain'], anchor: 'captain/templates/postmortem.md', reason: 'names the postmortem template the controller fills after a revert, a procedure rather than an incident story' },
];

/** `#` + 3 or more digits (bare or parenthesized), `PR #N`, `issue #N`, incident stories. */
const PATTERNS: RegExp[] = [
  /(?<!&)#\d{3,}\b/g,
  /\bPR #\d+\b/g,
  /\bissues? #\d+\b/gi,
  /\b(?:a|an|one|the) (?:real|actual|past|previous|production) incident\b/gi,
  /\bincident (?:occurred|happened)\b/gi,
  /\bpost-?mortem\b/gi,
];

const ANCHOR_WINDOW = 3;

interface Hit { file: string; skill: string; line: number; text: string; match: string; context: string; near: string; sources?: string[] }

let outDir = '';
let hits: Hit[] = [];
let sources: { file: string; text: string }[] = [];

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') walk(p, keep, out);
    } else if (keep(p)) {
      out.push(p);
    }
  }
  return out;
}

function skillOf(rel: string): string {
  const parts = rel.split(sep);
  const name = parts[0].startsWith('.') ? parts[parts.indexOf('skills') + 1] ?? parts[0] : parts.length === 1 ? 'gstack' : parts[0];
  const bare = name.replace(/^gstack-/, '');
  return name !== bare && existsSync(join(outDir, bare)) ? bare : name;
}

/** The templates or resolvers that emitted a hit: the most specific snippet any source contains. */
function sourcesFor(hit: Hit): string[] {
  if (hit.sources) return hit.sources;
  const at = hit.text.indexOf(hit.match);
  const snippets = [hit.near, hit.text.trim(), ...[60, 30, 12, 0].map(width =>
    hit.text.slice(Math.max(0, at - width), at + hit.match.length + width).trim())];
  for (const snippet of snippets) {
    const found = sources.filter(s => s.text.includes(snippet)).map(s => s.file);
    if (found.length > 0) return (hit.sources = found);
  }
  return (hit.sources = []);
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'gstack-archaeology-'));
  const gen = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', outDir], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000,
  });
  if (gen.status !== 0) throw new Error(`gen-skill-docs --host all failed:\n${gen.stderr}`);

  const generated = walk(outDir, p => /(^|[\\/])SKILL\.md$/.test(p) || /[\\/]sections[\\/][^\\/]+\.md$/.test(p));
  for (const file of generated) {
    const rel = relative(outDir, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const pattern of PATTERNS) {
        for (const m of text.matchAll(pattern)) {
          hits.push({
            file: rel, skill: skillOf(rel), line: i + 1, text, match: m[0],
            context: lines.slice(Math.max(0, i - ANCHOR_WINDOW), i + ANCHOR_WINDOW + 1).join('\n'),
            near: lines.slice(Math.max(0, i - 1), i + 2).join('\n').trim(),
          });
        }
      }
    });
  }

  const sourceFiles = [
    ...walk(ROOT, p => p.endsWith('.tmpl') && !relative(ROOT, p).startsWith('.')),
    ...walk(join(ROOT, 'scripts', 'resolvers'), p => p.endsWith('.ts')),
    ...walk(join(ROOT, 'model-overlays'), p => p.endsWith('.md')),
  ];
  sources = sourceFiles.map(file => ({
    file: relative(ROOT, file),
    text: readFileSync(file, 'utf8').replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\'),
  }));
}, 240_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const covers = (e: AllowEntry, hit: Hit) =>
  e.skills.includes(hit.skill) && hit.context.includes(e.anchor) && (!e.source || sourcesFor(hit).includes(e.source));
const allowedBy = (hit: Hit) => ALLOWLIST.find(e => covers(e, hit));

describe('archaeology lint (generated skill text, every host)', () => {
  test('the scan sees every host and real hits', () => {
    const hosts = new Set(hits.map(h => h.file.split(sep)[0].startsWith('.') ? h.file.split(sep)[0] : 'claude'));
    expect(hosts.size).toBeGreaterThan(5);
    expect(hits.some(h => h.match === '#123')).toBe(true);
  });

  test('no issue/PR numbers or incident stories in model-read skill text', () => {
    const report = new Map<string, { sources: string[]; match: string; skill: string; text: string; renders: number }>();
    for (const hit of hits) {
      if (allowedBy(hit)) continue;
      const found = sourcesFor(hit);
      const key = `${found.join(',') || hit.file}\0${hit.match}`;
      const seen = report.get(key);
      if (seen) seen.renders++;
      else report.set(key, { sources: found, match: hit.match, skill: hit.skill, text: hit.text.trim(), renders: 1 });
    }
    const messages = [...report.values()].map(r => [
      `  source: ${r.sources.length ? r.sources.join(', ') : '(not found in templates or scripts/resolvers; search the generated text below)'}`,
      `  matched: ${r.match}   (${r.renders} generated render${r.renders === 1 ? '' : 's'})`,
      `  line: ${r.text.slice(0, 160)}`,
      `  fix: remove the reference from the source and keep the rule. For a legitimate reference (upstream bug ID, usage example, sample output), add to ALLOWLIST in test/archaeology-lint.test.ts:`,
      `    { skills: ['${r.skill}'], anchor: '<text on or near the matched line>', reason: '<why the model needs this reference>' },`,
    ].join('\n'));
    expect(messages, `Archaeology in model-read skill text:\n${messages.join('\n\n')}`).toEqual([]);
  });

  test('every allowlist entry carries a reason and still matches a hit', () => {
    const stale = ALLOWLIST.filter(e => !e.reason.trim() || !hits.some(h => covers(e, h)));
    expect(stale.map(e => `${e.skills.join(',')}: '${e.anchor}' — matches nothing (or has no reason); delete the entry`)).toEqual([]);
  });

  test('self-test: the patterns catch archaeology and leave colors, placeholders and entities alone', () => {
    const scan = (line: string) => PATTERNS.flatMap(p => [...line.matchAll(p)].map(m => m[0]));
    expect(scan('cached 1h (#2477)')).toEqual(['#2477']);
    expect(scan('See #1327.')).toEqual(['#1327']);
    expect(scan('Biggest ship: PR #605 — x')).toEqual(['#605', 'PR #605']);
    expect(scan('OpenAI issues #8545, #8402')).toEqual(['#8545', '#8402', 'issues #8545']);
    expect(scan('A real incident occurred in production')).toEqual(['A real incident', 'incident occurred']);
    expect(scan('color: #6366f1; PR #NNN; &#8212; #12; resolved incidents')).toEqual([]);
  });
});
