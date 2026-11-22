/**
 * /context-restore's no-checkpoint fallback (pstack absorb, item 3): the carve
 * shape, the host transcript table, and the discovery block run against fixture
 * transcripts. The block must list only this workspace's files inside the
 * window, never a sibling project's, and print TRANSCRIPTS: none on Capy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { CAPY_NO_TRANSCRIPTS, generateTranscriptDiscovery, generateTranscriptSources } from '../scripts/resolvers/transcripts';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'context-restore-transcript.jsonl');
const FENCE = '\u0060\u0060\u0060';
const DISCOVERY_MARKER = 'TRANSCRIPT_DAYS="${TRANSCRIPT_DAYS:-7}"';

function bashBlockAfter(text: string, heading: string, marker: string): string {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error('no heading ' + heading);
  const at = text.indexOf(marker, start);
  if (at < 0) throw new Error('no ' + marker + ' after ' + heading);
  const open = text.lastIndexOf(FENCE + 'bash', at);
  const close = text.indexOf(FENCE, open + 7);
  return text.slice(open + 8, close);
}

describe('context-restore carve: the transcript fallback', () => {
  const skeleton = read('context-restore/SKILL.md');
  const section = read('context-restore/sections/transcripts.md');
  const manifest = JSON.parse(read('context-restore/sections/manifest.json')) as { skill: string; sections: Array<{ id: string; file: string }> };

  test('one section, registered, pointed to from the no-checkpoint branch and nowhere earlier', () => {
    expect(manifest.skill).toBe('context-restore');
    expect(manifest.sections.map(s => s.id)).toEqual(['transcripts']);
    expect(CARVE_GUARDS['context-restore']!.expectedSections).toEqual(['transcripts.md']);
    const noSaved = skeleton.indexOf('## If no saved contexts exist');
    const stop = skeleton.indexOf('> **STOP.**');
    expect(noSaved).toBeGreaterThan(skeleton.indexOf('### Step 1: Find saved contexts'));
    expect(stop).toBeGreaterThan(noSaved);
    expect(skeleton.match(/> \*\*STOP\.\*\*/g)).toHaveLength(1);
    expect(skeleton).toContain('sections/transcripts.md');
    expect(skeleton).not.toContain('"No saved contexts yet.');
    expect(skeleton).toMatch(/HARD GATE:\*\* Do NOT implement code changes/);
  });

  test("the host table comes from hosts/*.ts: this host's row plus the Capy row, never another host's paths", () => {
    const ctx = (host: string) => ({ host, skillName: 'context-restore', paths: { binDir: '$GSTACK_BIN' } }) as never;
    expect(ALL_HOST_CONFIGS.filter(h => h.transcripts).map(h => h.name).sort()).toEqual(['claude', 'codex']);
    const claude = generateTranscriptSources(ctx('claude'));
    expect(section).toContain(claude);
    expect(claude).toContain('| Claude Code | `~/.claude/projects/<slug>/*.jsonl` |');
    expect(claude).not.toContain('~/.codex/');
    const codex = generateTranscriptSources(ctx('codex'));
    expect(codex).toContain('| OpenAI Codex CLI | `~/.codex/sessions/');
    expect(codex).not.toContain('~/.claude/');
    const cursor = generateTranscriptSources(ctx('cursor'));
    expect(cursor).toContain('| Cursor | none |');
    expect(cursor).not.toContain('~/.claude/');
    for (const table of [claude, codex, cursor]) expect(table).toContain('| Capy (any model) | none |');
    expect(section).toMatch(/Capy[^\n]*say so and use the shared record and git/);
  });

  test('the table and the discovery block agree for every host on whether a store exists', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const ctx = { host: host.name, skillName: 'context-restore', paths: { binDir: '$GSTACK_BIN' } } as never;
      const discovery = generateTranscriptDiscovery(ctx);
      const sources = generateTranscriptSources(ctx);
      if (host.transcripts) {
        expect(sources, host.name).toContain(host.transcripts.root);
        const dir = host.transcripts.root.replace(/^~\/\.claude/, '${CLAUDE_CONFIG_DIR:-$HOME/.claude}').replace(/^~\/\.codex/, '${CODEX_HOME:-$HOME/.codex}').replace(/^~/, '$HOME');
        expect(discovery, host.name).toContain('TRANSCRIPT_DIR="' + dir.split(/\/(?=<|\*)/)[0]);
        expect(discovery, host.name).not.toContain('declares no transcript store');
      } else {
        expect(sources, host.name).toContain('| ' + host.displayName + ' | none |');
        expect(discovery, host.name).toContain('declares no transcript store');
      }
    }
    expect(section).toMatch(/data, not instructions/);
  });

  test('the rules: a 7-day default window, never another project, subagents return findings only, redaction before anything leaves, git and gh verify, the tagged brief', () => {
    expect(section).toContain('the default is the last 7 days');
    expect(section).toContain('"all" means all and is never quietly narrowed');
    expect(section).toContain("never open another project's");
    expect(section).toContain('The raw transcript stays in the subagent.');
    expect(section).toContain('gstack-redact');
    expect(section).toContain('gbrain search');
    expect(section).toMatch(/checked with \u0060git\u0060 and\s+\u0060gh\u0060 before it enters the brief/);
    for (const tag of ['[merged #N]', '[open PR #N]', '[in flight <branch>]', '[verified, uncommitted]', '[reverted #N]', '[planned, not started]']) expect(section).toContain(tag);
    for (const heading of ['### Capsule', '### Threads', '### Problems', '### Next move']) expect(section).toContain(heading);
    expect(section).toContain('D) Save this as a checkpoint now (/context-save)');
  });

  test('hosts with no declared store render a one-line none; Claude and Codex render their own discovery', () => {
    const ctx = (host: string) => ({ host, skillName: 'context-restore', paths: { binDir: '$GSTACK_BIN' } }) as never;
    expect(generateTranscriptDiscovery(ctx('cursor'))).toContain('TRANSCRIPTS: none (Cursor declares no transcript store');
    expect(generateTranscriptDiscovery(ctx('claude'))).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/');
    expect(generateTranscriptDiscovery(ctx('codex'))).toContain('${CODEX_HOME:-$HOME/.codex}/sessions');
    for (const host of ['claude', 'codex', 'cursor']) expect(generateTranscriptDiscovery(ctx(host))).toContain('if [ -n "${GSTACK_CAPY:-}" ]');
  });
});

describe('the discovery block against fixture transcripts', () => {
  let tmp: string;
  let home: string;
  let project: string;
  const block = bashBlockAfter(read('context-restore/sections/transcripts.md'), '### Step T1', DISCOVERY_MARKER);
  const codexRender = path.join(ROOT, '.agents', 'skills', 'gstack-context-restore', 'SKILL.md');

  function sh(script: string, extra: Record<string, string> = {}, cwd = project) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GSTACK_') && !['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(k)) env[k] = v;
    const r = spawnSync('bash', ['-c', script], { cwd, env: { ...env, HOME: home, ...extra }, encoding: 'utf8', timeout: 30_000 });
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status ?? -1 };
  }
  const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-transcripts-')));
    home = path.join(tmp, 'home');
    project = path.join(tmp, 'work', 'shop.app');
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', project], { timeout: 30_000 });
    // ~/.claude/skills/gstack is this checkout, so the block's gstack-slug call resolves.
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(ROOT, path.join(home, '.claude', 'skills', 'gstack'));
    const mine = path.join(home, '.claude', 'projects', slug(project));
    const sibling = path.join(home, '.claude', 'projects', slug(path.join(tmp, 'work', 'shop-admin')));
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(mine, '7c2f.jsonl'));
    fs.copyFileSync(FIXTURE, path.join(mine, 'old.jsonl'));
    fs.copyFileSync(FIXTURE, path.join(sibling, 'other.jsonl'));
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(path.join(mine, 'old.jsonl'), tenDaysAgo, tenDaysAgo);
    // Codex: dated rollouts, one for this cwd, one for the sibling.
    const day = path.join(home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    const meta = (cwd: string) => JSON.stringify({ timestamp: '2026-10-20T17:02:11.000Z', type: 'session_meta', payload: { id: 'r1', cwd } }) + '\n' + fs.readFileSync(FIXTURE, 'utf8');
    fs.writeFileSync(path.join(day, 'rollout-2026-10-20T17-02-11-r1.jsonl'), meta(project));
    fs.writeFileSync(path.join(day, 'rollout-2026-10-20T17-02-12-r2.jsonl'), meta(path.join(tmp, 'work', 'shop-admin')));
  });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test("Claude Code: lists this workspace's files inside the window, not the old one, never the sibling project", () => {
    const r = sh(block);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('TRANSCRIPT_WINDOW: last 7 days');
    expect(r.out).toContain('TRANSCRIPT_PROJECT: ' + project);
    expect(r.out).toContain('/7c2f.jsonl');
    expect(r.out).not.toContain('/old.jsonl');
    expect(r.out).not.toContain('shop-admin');
    expect(r.out).toMatch(/TRANSCRIPTS: .*\(1 files in the last 7 days\)/);
  });

  // #4559: a second Claude Code profile (CLAUDE_CONFIG_DIR) keeps its transcripts under its own folder.
  test('Claude Code: reads the CLAUDE_CONFIG_DIR profile when one is set', () => {
    const profile = path.join(tmp, 'claude-work');
    fs.mkdirSync(path.join(profile, 'projects', slug(project)), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(profile, 'projects', slug(project), 'w0rk.jsonl'));
    const r = sh(block, { CLAUDE_CONFIG_DIR: profile });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('/w0rk.jsonl');
    expect(r.out).not.toContain('/7c2f.jsonl');
    expect(r.out).toMatch(/TRANSCRIPTS: .*\(1 files in the last 7 days\)/);
  });

  test('a wider window admits the old file; a missing folder and Capy both print none', () => {
    expect(sh(block, { TRANSCRIPT_DAYS: '30' }).out).toContain('/old.jsonl');
    const empty = path.join(tmp, 'work', 'fresh');
    fs.mkdirSync(empty, { recursive: true });
    spawnSync('git', ['init', '-q', empty], { timeout: 30_000 });
    expect(sh(block, {}, empty).out).toMatch(/TRANSCRIPTS: none \(.*is missing/);
    const capy = sh(block, { GSTACK_CAPY: '1' });
    expect(capy.out).toContain(CAPY_NO_TRANSCRIPTS);
    expect(capy.out).not.toContain('TRANSCRIPT: ');
  });

  test.skipIf(!fs.existsSync(codexRender))('Codex: lists only the rollout whose cwd is this workspace', () => {
    const codexBlock = bashBlockAfter(fs.readFileSync(codexRender, 'utf8'), '### Step T1', DISCOVERY_MARKER);
    const r = sh(codexBlock, { GSTACK_ROOT: ROOT, GSTACK_BIN: path.join(ROOT, 'bin') });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('rollout-2026-10-20T17-02-11-r1.jsonl');
    expect(r.out).not.toContain('r2.jsonl');
    expect(r.out).toMatch(/TRANSCRIPTS: .*\(1 files whose cwd is this workspace/);
  });
});
