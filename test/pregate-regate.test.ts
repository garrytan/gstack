/**
 * Field wave CD3: `gstack-pregate regate --against <gated-head>` decides
 * whether a gated head's evidence still covers HEAD. Reuse comes only from a
 * tree receipt evaluated now with a bundle produced on the gated tree; each
 * lane gets a verdict; a migration number the branch adds is checked against
 * the base branch and every other open PR, and a lookup that cannot finish is
 * `unknown`, which withholds `REGATE: not-needed`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_POLICY, cleanup, copyFixtureRepo, makeFixtureRepo, makePr, recordAndBundle, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const POLICY = { ...BASE_POLICY, stamp_sensitive_gates: ['digest'], migrations: { dir: 'migrations', id: '^v(\\d+)-' } };

interface GhData { list?: unknown; listFail?: boolean; api?: Record<string, string[] | null> }
/** A gh stand-in: `pr list` answers from data (or fails), `api .../pulls/<n>/files` prints one filename per line (or fails). */
function ghShim(repo: FixtureRepo, data: GhData): Record<string, string> {
  const dir = path.join(repo.root, 'gh-regate');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify(data));
  fs.writeFileSync(path.join(dir, 'calls.log'), '');
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/sh',
    `echo "$*" >> "${path.join(dir, 'calls.log')}"`,
    `exec node -e '
const d=require(process.argv[1]); const a=process.argv.slice(2);
if(a[0]==="pr"&&a[1]==="list"){ if(d.listFail){console.error("gh: HTTP 502");process.exit(1)} console.log(JSON.stringify(d.list??[])); process.exit(0) }
if(a[0]==="api"){ const n=/pulls\\/(\\d+)\\/files/.exec(a.join(" "))?.[1]; const f=d.api?.[n]; if(!f){console.error("gh: HTTP 403");process.exit(1)} console.log(f.join("\\n")); process.exit(0) }
console.error("gh shim: unsupported "+a.join(" ")); process.exit(1)' "${file}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}
const ghCalls = (repo: FixtureRepo) => fs.readFileSync(path.join(repo.root, 'gh-regate', 'calls.log'), 'utf8');

type Lanes = Array<{ label: string; command: string }>;
const TESTS_LANE: Lanes = [{ label: 'tests', command: 'true' }];
const DIGEST_LANES: Lanes = [...TESTS_LANE, { label: 'digest', command: 'cat generated/digest.md' }];

/** pr-a adds migration v240, is stamped 1.2.4.0 and gated (lanes recorded and bundled); then restamped to 1.2.5.0. */
function buildGated(lanes: Lanes) {
  const repo = makeFixtureRepo({ prefix: 'pregate-regate-', policy: POLICY });
  makePr(repo, 'pr-a', { expects: '1.2.4.0' });
  fs.mkdirSync(path.join(repo.work, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, 'migrations', 'v240-add-index.sql'), 'create index a;\n');
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'migration v240');
  expect(restamp(repo, ['--version', '1.2.4.0']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp 1.2.4.0');
  const bundle = path.join(repo.root, 'bundle.json');
  recordAndBundle(repo, repo.work, lanes, bundle);
  const head = repo.git('rev-parse', 'HEAD');
  expect(restamp(repo, ['--version', '1.2.5.0']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp 1.2.5.0');
  return { repo, head, current: repo.git('rev-parse', 'HEAD') };
}

// Each fixture costs four gstack bin runs (two restamps, an evidence run and a bundle); build each lane set once
// and give every test its own copy instead of rebuilding it per test.
const templates = new Map<Lanes, ReturnType<typeof buildGated>>();
beforeAll(() => { for (const lanes of [TESTS_LANE, DIGEST_LANES]) templates.set(lanes, buildGated(lanes)); }, 60_000);
afterAll(() => { for (const t of templates.values()) cleanup(t.repo); });

function gatedThenRestamped(lanes: Lanes = TESTS_LANE) {
  const { repo: template, head, current } = templates.get(lanes)!;
  const repo = copyFixtureRepo(template, 'pregate-regate-');
  repos.push(repo);
  return { repo, head, bundle: path.join(repo.root, 'bundle.json'), current };
}
const regate = (repo: FixtureRepo, args: string[], env: Record<string, string>) => runBin(repo, 'gstack-pregate', ['regate', '--base', 'main', ...args], env);

describe('gstack-pregate regate: evidence, stamps and lane verdicts', () => {
  test('a pure restamp with a bundle from the gated tree and no other migration is not-needed; the --against alias is the same verb', () => {
    const { repo, head, bundle, current } = gatedThenRestamped();
    const env = ghShim(repo, { list: [{ number: 7, headRefOid: current, files: [{ path: 'migrations/v240-add-index.sql' }] }, { number: 8, headRefOid: 'f'.repeat(40), files: [{ path: 'migrations/v241-other.sql' }] }] });
    const r = regate(repo, ['--against', head, '--bundle', bundle], env);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^  stamp   docs\/pr-a\.md \(stamp_paths\)$/m);
    expect(r.out).toMatch(/^STAMP_ONLY: yes files=\d+$/m);
    expect(r.out).toMatch(/^LANE: tests reusable \(identity matches; tree same modulo stamps\)$/m);
    expect(r.out).toMatch(/^MIGRATION_COLLISION: none \(240 checked against origin\/main and 1 open PR\(s\)\)$/m);
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('REGATE: not-needed');
    expect(ghCalls(repo)).toContain('pr list --state open --limit 1000 --json number,headRefOid,files');
    const alias = runBin(repo, 'gstack-pregate', ['--against', head, '--bundle', bundle, '--base', 'main'], env);
    expect(alias.status).toBe(EXIT.ok);
    expect(alias.out).toBe(r.out);
  });

  test('without gate evidence, or with a bundle from another tree, the verdict is needed even when the tree is stamp-only', () => {
    const { repo, head, bundle } = gatedThenRestamped();
    const env = ghShim(repo, { list: [] });
    const none = regate(repo, ['--against', head], env);
    expect(none.status).toBe(EXIT.fail);
    expect(none.out).toMatch(/^STAMP_ONLY: yes /m);
    expect(none.out).toMatch(new RegExp(`^REGATE: needed \\(no gate evidence for ${head.slice(0, 12)} \\(none \\(no evidence bundle; execution identity unknown\\)\\)\\)$`, 'm'));
    const other = path.join(repo.root, 'other.json');
    recordAndBundle(repo, repo.work, [{ label: 'tests', command: 'true' }], other);
    const wrong = regate(repo, ['--against', head, '--bundle', other], env);
    expect(wrong.status).toBe(EXIT.fail);
    expect(wrong.out).toMatch(/^REGATE: needed \(no gate evidence for [0-9a-f]{12} \(bundle .*other\.json was produced on tree [0-9a-f]{12}, not the gated tree [0-9a-f]{12}\)\)$/m);
    expect(wrong.out).not.toContain('LANE: tests reusable');
    const required = regate(repo, ['--against', head, '--bundle', bundle, '--require', 'tests,e2e'], env);
    expect(required.status).toBe(EXIT.fail);
    expect(required.out).toMatch(/^LANE: tests reusable /m);
    expect(required.out).toMatch(/^LANE: e2e not-reusable \(required lane has no record in the bundle\)$/m);
    expect(required.out).toMatch(/^REGATE: needed \(e2e not reusable \(required lane has no record in the bundle\)\)$/m);
  });

  test('a stamp-sensitive lane reruns, so a regate is needed; a code edit is not stamp-only and names the file and line', () => {
    const { repo, head, bundle } = gatedThenRestamped(DIGEST_LANES);
    const env = ghShim(repo, { list: [] });
    const r = regate(repo, ['--against', head, '--bundle', bundle], env);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^LANE: tests reusable /m);
    expect(r.out).toMatch(/^LANE: digest rerun \(stamp-sensitive/m);
    expect(r.out).toMatch(/^REGATE: needed \(digest reruns \(stamp-sensitive/m);
    fs.writeFileSync(path.join(repo.work, 'pr-a.txt'), 'pr-a\nmore code\n');
    repo.git('commit', '-qam', 'code edit');
    const edited = regate(repo, ['--against', head, '--bundle', bundle], env);
    expect(edited.status).toBe(EXIT.fail);
    expect(edited.out).toMatch(/^  changed pr-a\.txt:2 \(other: 1 hunk\(s\) outside every stamp rule\)$/m);
    expect(edited.out).toMatch(/^STAMP_ONLY: no files=\d+ changed=1$/m);
    expect(edited.out).toMatch(/^LANE: tests not-reusable \(not stamp-only: pr-a\.txt\)$/m);
    expect(edited.out).toMatch(/^REGATE: needed \(not stamp-only: pr-a\.txt; digest reruns \(stamp-sensitive/m);
  });

  test('a moved or unknown predecessor head withholds not-needed', () => {
    const { repo, head, bundle, current } = gatedThenRestamped();
    const env = ghShim(repo, { list: [] });
    repo.git('branch', 'pred', current);
    const moved = regate(repo, ['--against', head, '--bundle', bundle, '--predecessor', head, '--predecessor-ref', 'pred'], env);
    expect(moved.status).toBe(EXIT.fail);
    expect(moved.out).toMatch(new RegExp(`^REGATE: needed \\(PREDECESSOR MOVED ${head.slice(0, 12)} -> ${current.slice(0, 12)}\\)$`, 'm'));
    const unknown = regate(repo, ['--against', head, '--bundle', bundle, '--predecessor', head, '--predecessor-pr', '41'], env);
    expect(unknown.status).toBe(EXIT.fail);
    expect(unknown.out).toMatch(/^REGATE: needed \(predecessor #41 current head unknown\)$/m);
  });
});

describe('gstack-pregate regate: migration collisions', () => {
  test('two open PRs adding the same migration number collide; the PR itself is excluded', () => {
    const { repo, head, bundle, current } = gatedThenRestamped();
    const env = ghShim(repo, { list: [
      { number: 7, headRefOid: current, files: [{ path: 'migrations/v240-add-index.sql' }] },
      { number: 9, headRefOid: 'a'.repeat(40), files: [{ path: 'src/x.ts' }, { path: 'migrations/v240-add-column.sql' }] },
    ] });
    const r = regate(repo, ['--against', head, '--bundle', bundle], env);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^MIGRATION_COLLISION: 240 migrations\/v240-add-index\.sql vs PR #9 migrations\/v240-add-column\.sql$/m);
    expect(r.out).toMatch(/^REGATE: needed \(migration collision: 240\)$/m);
    expect(r.err).toContain('(MIGRATION_COLLISION)');
  });

  test('a number the base branch took meanwhile collides', () => {
    const { repo, head, bundle } = gatedThenRestamped();
    const env = ghShim(repo, { list: [] });
    repo.git('checkout', '-q', 'origin/main', '-b', 'other');
    fs.mkdirSync(path.join(repo.work, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'migrations', 'v240-landed.sql'), 'alter table b;\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'landed v240');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('checkout', '-q', 'pr-a');
    repo.git('fetch', '-q', 'origin');
    const r = regate(repo, ['--against', head, '--bundle', bundle], env);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^MIGRATION_COLLISION: 240 migrations\/v240-add-index\.sql vs origin\/main migrations\/v240-landed\.sql$/m);
  });

  test('a lookup that cannot finish is unknown and blocks not-needed: gh failing, a truncated PR list, a 100-file PR whose files cannot be fetched', () => {
    const { repo, head, bundle } = gatedThenRestamped();
    const failing = regate(repo, ['--against', head, '--bundle', bundle], ghShim(repo, { listFail: true }));
    expect(failing.status).toBe(EXIT.fail);
    expect(failing.out).toMatch(/^MIGRATION_COLLISION: unknown \(gh pr list failed: gh: HTTP 502\)$/m);
    expect(failing.out).toMatch(/^REGATE: needed \(migration lookup unknown \(gh pr list failed: gh: HTTP 502\)\)$/m);

    const many = Array.from({ length: 1000 }, (_, i) => ({ number: 1000 + i, headRefOid: 'b'.repeat(40), files: [] }));
    const truncated = regate(repo, ['--against', head, '--bundle', bundle], ghShim(repo, { list: many }));
    expect(truncated.status).toBe(EXIT.fail);
    expect(truncated.out).toMatch(/^MIGRATION_COLLISION: unknown \(1000 open PRs listed, the list may be truncated at 1000\)$/m);

    const hundred = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const big = [{ number: 12, headRefOid: 'c'.repeat(40), files: hundred }];
    const unfetched = regate(repo, ['--against', head, '--bundle', bundle], ghShim(repo, { list: big }));
    expect(unfetched.status).toBe(EXIT.fail);
    expect(unfetched.out).toMatch(/^MIGRATION_COLLISION: unknown \(PR #12 lists 100 files \(truncated\) and its full file list could not be fetched\)$/m);

    const env = ghShim(repo, { list: big, api: { '12': [...hundred.map(f => f.path), 'migrations/v240-late.sql'] } });
    const fetched = regate(repo, ['--against', head, '--bundle', bundle], env);
    expect(ghCalls(repo)).toContain('api --paginate repos/{owner}/{repo}/pulls/12/files?per_page=100 --jq .[].filename');
    expect(fetched.out).toMatch(/^MIGRATION_COLLISION: 240 migrations\/v240-add-index\.sql vs PR #12 migrations\/v240-late\.sql$/m);
  });

  test('regate takes only its own flags (exit 2) and needs --against', () => {
    const { repo, head } = gatedThenRestamped();
    const env = ghShim(repo, { list: [] });
    expect(regate(repo, ['--against', head, '--bogus'], env).status).toBe(EXIT.usage);
    const missing = regate(repo, [], env);
    expect(missing.status).toBe(EXIT.usage);
    expect(missing.err).toContain('--against <gated-head> is required');
  });
});
