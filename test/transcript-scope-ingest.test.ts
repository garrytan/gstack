/**
 * Scoped transcript consent in the memory ingest and the sync orchestrator:
 * the new@ cutoff on each session's first record (both parsers), the
 * transcript_repos allowlist after the attribution gate, exclusion counts by
 * reason, explicit overrides that never widen a scoped consent, the consent
 * record that restages on a scope change, and the regression contract that
 * `recent` selects exactly the sessions it did before (file mtime, 90 days).
 * Runs the real ingest and orchestrator against a stub gbrain.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { transcriptConsentRecord, transcriptConsentSummary } from '../bin/gstack-gbrain-sync';
import { reposHash } from '../lib/transcript-consent';

const ROOT = join(import.meta.dir, '..');
const INGEST = join(ROOT, 'bin', 'gstack-memory-ingest.ts');
const SYNC = join(ROOT, 'bin', 'gstack-gbrain-sync.ts');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Box {
  home: string;
  gstackHome: string;
  env: Record<string, string>;
  repo: (slug: string) => string;
  claude: (id: string, opts: { cwd: string; start?: string; mtimeMs?: number; appendNow?: boolean }) => string;
  codex: (id: string, opts: { cwd: string; start: string }) => string;
  staged: () => string[];
  cleanup: () => void;
}

function box(config: string): Box {
  const home = mkdtempSync(join(tmpdir(), 'gstack-tscope-'));
  const gstackHome = join(home, '.gstack');
  const bindir = join(home, 'bin');
  const stagedList = join(home, 'staged.list');
  for (const d of [gstackHome, bindir, join(home, '.gbrain'), join(home, '.claude', 'projects', 'p')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(gstackHome, 'config.yaml'), config);
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_url: 'pglite:///test' }));
  writeFileSync(join(bindir, 'gbrain'), `#!/bin/sh
case "$1" in
  --version) echo "gbrain 0.60.28.0" ;;
  --help) printf 'Commands:\\n  import <dir>   Import markdown directory\\n' ;;
  sources) echo '{"sources":[]}' ;;
  import)
    ( cd "$2" && find . -name '*.md' -type f | sort ) > "${stagedList}"
    n=$(wc -l < "${stagedList}" | tr -d ' ')
    echo "{\\"status\\":\\"success\\",\\"imported\\":$n,\\"skipped\\":0,\\"errors\\":0,\\"total_files\\":$n}" ;;
  *) echo "unexpected gbrain $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bindir, 'gbrain'), 0o755);
  const env = {
    HOME: home,
    GSTACK_HOME: gstackHome,
    GBRAIN_HOME: '',
    GSTACK_MEMORY_INGEST_SOURCES: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    PATH: `${bindir}:${process.env.PATH || ''}`,
  };
  const line = (rec: Record<string, unknown>) => JSON.stringify(rec) + '\n';
  return {
    home,
    gstackHome,
    env,
    repo: (slug) => {
      const dir = join(home, 'work', slug.replace('/', '-'));
      mkdirSync(dir, { recursive: true });
      spawnSync('git', ['-C', dir, 'init', '-q'], { timeout: 30_000 });
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`], { timeout: 30_000 });
      return dir;
    },
    claude: (id, { cwd, start, mtimeMs, appendNow }) => {
      const path = join(home, '.claude', 'projects', 'p', `${id}.jsonl`);
      const ts = start ? { timestamp: start } : {};
      writeFileSync(path, line({ type: 'user', message: { role: 'user', content: `hello ${id}` }, cwd, ...ts }) + line({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, ...ts }));
      if (appendNow) writeFileSync(path, readFileSync(path, 'utf-8') + line({ type: 'user', message: { role: 'user', content: 'later' }, timestamp: iso(Date.now()) }));
      if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
      return path;
    },
    codex: (id, { cwd, start }) => {
      const dir = join(home, '.codex', 'sessions', '2026', '10', '01');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-${id}.jsonl`);
      writeFileSync(path, line({ type: 'session_meta', timestamp: start, payload: { id, cwd } }) + line({ type: 'response_item', timestamp: start, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `hi ${id}` }] } }));
      return path;
    },
    staged: () => (existsSync(stagedList) ? readFileSync(stagedList, 'utf-8').split('\n').filter((l) => l.includes('transcripts/')) : []),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const ingest = (b: Box, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bun', [INGEST, ...args], { encoding: 'utf-8', timeout: 60_000, cwd: b.home, env: { ...process.env, ...b.env, ...env } });
const sync = (b: Box, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bun', [SYNC, '--no-code', '--no-brain-sync', ...args], { encoding: 'utf-8', timeout: 60_000, cwd: b.home, env: { ...process.env, ...b.env, ...env } });

describe.skipIf(process.platform === 'win32')('new@ cutoff', () => {
  test('both parsers filter on the first record timestamp; appended pre-cutoff and start-less sessions stay out', () => {
    const now = Date.now();
    const b = box(`transcript_ingest_mode: new@${iso(now - DAY)}\n`);
    try {
      const app = b.repo('acme/app');
      b.claude('preappend0001', { cwd: app, start: iso(now - 2 * DAY), appendNow: true });
      b.claude('postcutoff001', { cwd: app, start: iso(now - 60_000) });
      b.claude('nostart000001', { cwd: app });
      b.codex('codexold00001', { cwd: app, start: iso(now - 3 * DAY) });
      b.codex('codexnew00001', { cwd: app, start: iso(now - 60_000) });

      const probe = ingest(b, ['--probe']);
      expect(probe.status).toBe(0);
      expect(probe.stdout).toContain('Total files in window: 2');
      expect(probe.stdout).toMatch(/Excluded \(pre-cutoff\):\s+2/);
      expect(probe.stdout).toMatch(/Excluded \(missing start\):\s+1/);

      const bulk = ingest(b, ['--bulk', '--quiet']);
      expect(bulk.status).toBe(0);
      const staged = b.staged().join('\n');
      expect(staged).toMatch(/postcutoff00/);
      expect(staged).toMatch(/codexnew0000/);
      expect(staged).not.toMatch(/preappend000|nostart00000|codexold0000/);
      const page = readFileSync(join(b.gstackHome, '.transcript-ingest-state.json'), 'utf-8');
      expect(page).not.toContain('preappend0001');
    } finally {
      b.cleanup();
    }
  });

  test('a run that ingests no session says so, with the pre-cutoff count', () => {
    const now = Date.now();
    const b = box(`transcript_ingest_mode: new@${iso(now - DAY)}\n`);
    try {
      b.claude('preappend0001', { cwd: b.repo('acme/app'), start: iso(now - 2 * DAY), appendNow: true });
      const r = ingest(b, ['--bulk', '--quiet']);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`[memory-ingest] 0 transcript sessions ingested under new@${iso(now - DAY)}: 1 started before the cutoff; new sessions will appear on the next sync`);
    } finally {
      b.cleanup();
    }
  });
});

describe.skipIf(process.platform === 'win32')('transcript_repos allowlist', () => {
  test('only allowlisted repos ingest, after the attribution gate, with the exclusion counted', () => {
    const b = box('transcript_ingest_mode: all+repos\ntranscript_repos: github.com/acme/app\n');
    try {
      b.claude('appsession001', { cwd: b.repo('acme/app'), start: iso(Date.now()) });
      b.claude('websession001', { cwd: b.repo('acme/web'), start: iso(Date.now()) });
      b.codex('codexweb00001', { cwd: join(b.home, 'work', 'acme-web'), start: iso(Date.now()) });
      const probe = ingest(b, ['--probe']);
      expect(probe.stdout).toContain('Total files in window: 1');
      expect(probe.stdout).toMatch(/Excluded \(not allowlisted\):\s+2/);
      ingest(b, ['--bulk', '--quiet']);
      expect(b.staged().join('\n')).toMatch(/appsession00/);
      expect(b.staged().join('\n')).not.toMatch(/websession00|codexweb0000/);
    } finally {
      b.cleanup();
    }
  });
});

describe.skipIf(process.platform === 'win32')('explicit overrides never widen a scoped consent', () => {
  for (const [args, env, why] of [
    [['--sources', 'transcript,learning'], {}, '--sources'],
    [[], { GSTACK_MEMORY_INGEST_SOURCES: 'transcript' }, 'GSTACK_MEMORY_INGEST_SOURCES'],
  ] as const) {
    test(`${why}: the cutoff still applies under consent, and a broken allowlist still denies`, () => {
      const now = Date.now();
      const b = box(`transcript_ingest_mode: new@${iso(now - DAY)}\n`);
      try {
        const app = b.repo('acme/app');
        b.claude('preappend0001', { cwd: app, start: iso(now - 2 * DAY), appendNow: true });
        b.claude('postcutoff001', { cwd: app, start: iso(now - 60_000) });
        const scoped = sync(b, ['--incremental', '--quiet', ...args], { ...env });
        expect(scoped.status).toBe(0);
        expect(b.staged().join('\n')).toMatch(/postcutoff00/);
        expect(b.staged().join('\n')).not.toMatch(/preappend000/);

        writeFileSync(join(b.gstackHome, 'config.yaml'), 'transcript_ingest_mode: recent+repos\n');
        rmSync(join(b.gstackHome, '.transcript-ingest-state.json'), { force: true });
        rmSync(join(b.home, 'staged.list'), { force: true });
        const denied = sync(b, ['--incremental', '--quiet', ...args], { ...env });
        expect(denied.status).toBe(0);
        expect(b.staged()).toEqual([]);
        expect(denied.stderr).toContain(`gbrain-sync: transcripts ingested because ${why} names transcript (transcript_ingest_mode=recent+repos). The new@ cutoff and transcript_repos allowlist still apply.`);
      } finally {
        b.cleanup();
      }
    });
  }
});

describe.skipIf(process.platform === 'win32')('consent record and notice', () => {
  test('the stage record carries the cutoff and allowlist hash; unscoped records are unchanged', () => {
    const cutoff = '2026-10-03T17:00:00Z';
    expect(transcriptConsentRecord({ affirmative: true, window: 'recent', reason: 'recent', value: 'recent' }, false)).toEqual({ mode: 'recent', window: 'recent' });
    expect(transcriptConsentRecord({ affirmative: true, window: 'new', reason: 'new', value: `new@${cutoff}+repos`, cutoff, repos: ['github.com/a/b'] }, false))
      .toEqual({ mode: 'new', window: 'new', cutoff, repos_hash: reposHash(['github.com/a/b']) });
  });

  test('the consent notice prints the effective consent in words, unless --quiet', () => {
    const p = { affirmative: true, window: 'recent' as const, reason: 'recent' as const, value: 'recent+repos', repos: ['github.com/a/b'], roots: ['/s'] };
    expect(transcriptConsentSummary(p, false)).toBe('gbrain-sync: transcripts: sessions from the last 90 days; repo github.com/a/b; config: /s');
    expect(transcriptConsentSummary(p, true)).toBeNull();
    expect(transcriptConsentSummary({ ...p, affirmative: false, reason: 'off' }, false)).toBeNull();
  });

  test('a changed cutoff restages an interrupted import', () => {
    const now = Date.now();
    const b = box(`transcript_ingest_mode: new@${iso(now - DAY)}\n`);
    try {
      const stagingDir = join(b.gstackHome, '.staging-ingest-1-1');
      mkdirSync(join(stagingDir, 'projects'), { recursive: true });
      writeFileSync(join(stagingDir, '.gstack-staging'), '');
      writeFileSync(join(stagingDir, 'projects', 'stale-page.md'), '# stale\n');
      writeFileSync(join(b.home, '.gbrain', 'import-checkpoint.json'), JSON.stringify({ dir: stagingDir, processedIndex: 0, totalFiles: 1 }));
      const { MEMORY_INGEST_TYPES } = require('../bin/gstack-gbrain-sync');
      writeFileSync(join(b.gstackHome, '.gbrain-sync-state.json'), JSON.stringify({
        schema_version: 1,
        last_writer: 'gstack-gbrain-sync',
        last_stages: [{ name: 'memory', ran: true, ok: false, duration_ms: 1, summary: 'timeout', memory_sources: [...MEMORY_INGEST_TYPES], transcript_consent: { mode: 'new', window: 'new', cutoff: iso(now - 2 * DAY) } }],
      }));
      const r = sync(b, ['--incremental', '--quiet']);
      expect(r.stderr).toContain('gbrain-sync: transcript consent changed since the interrupted import');
      expect(r.stderr).not.toContain('resuming from gbrain checkpoint');
    } finally {
      b.cleanup();
    }
  });
});

describe.skipIf(process.platform === 'win32')('regression contract: recent selects the same sessions as before', () => {
  test('recent keeps the 90-day file-mtime window, whatever the session start', () => {
    const now = Date.now();
    const b = box('transcript_ingest_mode: recent\n');
    try {
      const app = b.repo('acme/app');
      b.claude('mtimenowold1', { cwd: app, start: iso(now - 200 * DAY) });
      b.claude('mtimeoldnew1', { cwd: app, start: iso(now), mtimeMs: now - 200 * DAY });
      b.claude('bothrecent01', { cwd: app, start: iso(now - DAY) });
      b.claude('botholdxxxx1', { cwd: app, start: iso(now - 200 * DAY), mtimeMs: now - 200 * DAY });
      b.claude('nostampsxxx1', { cwd: app });
      const r = ingest(b, ['--bulk', '--quiet']);
      expect(r.status).toBe(0);
      const ids = b.staged().map((l) => l.replace(/^.*-([a-z0-9]{12})\.md$/, '$1')).sort();
      expect(ids).toEqual(['bothrecent01', 'mtimenowold1', 'nostampsxxx1']);
      const probe = ingest(b, ['--probe']);
      expect(probe.stdout).not.toContain('Excluded');
    } finally {
      b.cleanup();
    }
  });
});

describe.skipIf(process.platform === 'win32')('CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
  // A dev profile (CLAUDE_CONFIG_DIR=~/.claude-dev/.claude, CODEX_HOME=~/.claude-dev/.codex) keeps its
  // sessions under those dirs. The walk used to read ~/.claude/projects and ~/.codex/sessions only, so
  // those sessions never reached the brain. Fails when a custom home is skipped or the default home is
  // counted twice when the env names it.
  test('sessions under a custom Claude Code config dir and Codex home are walked beside the default homes', () => {
    const now = Date.now();
    const b = box('transcript_ingest_mode: recent\n');
    try {
      const app = b.repo('acme/app');
      const line = (rec: Record<string, unknown>) => JSON.stringify(rec) + '\n';
      const start = iso(now - 60_000);
      b.claude('defaulthome01', { cwd: app, start });
      const devClaude = join(b.home, '.claude-dev', '.claude');
      mkdirSync(join(devClaude, 'projects', 'p'), { recursive: true });
      writeFileSync(
        join(devClaude, 'projects', 'p', 'devclaude0001.jsonl'),
        line({ type: 'user', message: { role: 'user', content: 'hello dev' }, cwd: app, timestamp: start }) +
          line({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: start }),
      );
      const devCodex = join(b.home, '.claude-dev', '.codex');
      mkdirSync(join(devCodex, 'sessions', '2026', '10', '01'), { recursive: true });
      writeFileSync(
        join(devCodex, 'sessions', '2026', '10', '01', 'rollout-devcodex0001.jsonl'),
        line({ type: 'session_meta', timestamp: start, payload: { id: 'devcodex0001', cwd: app } }) +
          line({ type: 'response_item', timestamp: start, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi dev' }] } }),
      );
      const plain = ingest(b, ['--probe'], { CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' });
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('Total files in window: 1');
      const dev = ingest(b, ['--probe'], { CLAUDE_CONFIG_DIR: devClaude, CODEX_HOME: devCodex });
      expect(dev.status).toBe(0);
      expect(dev.stdout).toContain('Total files in window: 3');
      const same = ingest(b, ['--probe'], { CLAUDE_CONFIG_DIR: join(b.home, '.claude'), CODEX_HOME: join(b.home, '.codex') });
      expect(same.stdout).toContain('Total files in window: 1');
    } finally {
      b.cleanup();
    }
  });
});
