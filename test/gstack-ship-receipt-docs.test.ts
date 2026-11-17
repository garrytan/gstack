/**
 * PR 2 of the /ship + /review convergence lane: a repository with no version
 * source or CHANGELOG ships with `version: "none"` (E18); the documentation
 * audit's owner-accept path and the policy's doc caps (E11); the carry's git
 * floor, named patch-id refusal and branch-touched walk; the digit-bounded
 * stamp replacement.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { CARRY_NAMED_PATHS, extractReceipt, planCarry, stampOnlyText } from '../lib/ship-receipt';
import { checkDocsCaps, docsCapLine, docsExceptionLine, parseReceiptDocs } from '../lib/ship-receipt-docs';
import { DOCS_CAPS_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { gitArgvIn } from './helpers/scratch-repo';

const repos: FixtureRepo[] = [];
const fixture = (opts: Parameters<typeof makeFixtureRepo>[0] = {}) => { const r = makeFixtureRepo({ prefix: 'ship-receipt-2-', ...opts }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

/** A repository with no VERSION, no package.json, no CHANGELOG and no policy: the shape E18 names. */
function bareRepo(): FixtureRepo {
  const repo = fixture();
  for (const f of ['VERSION', 'package.json', 'package-lock.json', 'CHANGELOG.md', 'gen.js', 'generated', 'docs', '.gstack']) fs.rmSync(path.join(repo.work, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(repo.work, 'README.md'), '# fixture\n');
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'no version source');
  repo.git('push', '-q', '-f', 'origin', 'main');
  return repo;
}

describe('E18: a repository without a version source or CHANGELOG', () => {
  test('write records version "none"; read --body and result --body accept it', () => {
    const repo = bareRepo();
    const head = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '5', '--base', 'main', '--session-kind', 'unattended', '--body', body]);
    expect(w.status).toBe(EXIT.ok);
    expect(w.err.trim()).toContain(`head=${head.slice(0, 12)} version=none base=main`);
    const parsed = extractReceipt(w.out);
    expect(parsed.errors).toEqual([]);
    expect(parsed.receipt).toMatchObject({ pr: 5, head, version: 'none' });
    const read = runBin(repo, 'gstack-ship-receipt', ['read', '--body', body, '--json']);
    expect(read.status).toBe(EXIT.ok);
    expect(JSON.parse(read.out).version).toBe('none');
    const out = path.join(repo.root, 'run');
    const result = runBin(repo, 'gstack-ship-receipt', ['result', '--body', body, '--out', out]);
    expect(result.status).toBe(EXIT.ok);
    expect(result.out.trim()).toBe(`GSTACK_RESULT: skill=ship status=complete head=${head} run=${out}`);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'ship-run.json'), 'utf8')).version).toBe('none');
  });

  // Value: protects=a receipt write --version named in a repository with no version source keeps that version through a
  //   carry (GST-1030 review); fails_when=the carry refuses because HEAD has no readable version, or drops the version;
  //   seam=bin/gstack-ship-receipt cmdCarry
  test('a carry keeps the version write --version named when HEAD has no version source (GST-1030)', () => {
    const repo = fixture();
    for (const f of ['VERSION', 'package.json', 'package-lock.json']) fs.rmSync(path.join(repo.work, f));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'changelog only'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-unversioned');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '3', '--base', 'main', '--session-kind', 'x', '--version', '2.0.0', '--body', body]).status).toBe(EXIT.ok);
    fs.mkdirSync(path.join(repo.work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'test', 'a.test.ts'), 'test a\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'a test-only change');
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(carried.out, carried.err).toContain('CARRY: carried');
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt?.version).toBe('2.0.0');
  });

  test('a repository with a version source keeps its version, and one with only a CHANGELOG records no version rather than "none"', () => {
    const repo = fixture();
    const w = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'x', '--json']);
    expect(JSON.parse(w.out).version).toBe('1.2.3.0');
    for (const f of ['VERSION', 'package.json', 'package-lock.json']) fs.rmSync(path.join(repo.work, f));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'drop the version files, keep the changelog');
    const only = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'x', '--json']);
    expect(only.status).toBe(EXIT.ok);
    expect('version' in JSON.parse(only.out)).toBe(false);
  });

  test('"none" means absent: a package.json version is used, and a malformed VERSION, a policy stamp file or an unreadable base keep the no-version path', () => {
    const version = (repo: FixtureRepo, args: string[] = []) => JSON.parse(runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'x', '--json', ...args]).out).version;
    const manifest = bareRepo();
    fs.writeFileSync(path.join(manifest.work, 'package.json'), JSON.stringify({ name: 'x', version: '4.5.6' }) + '\n');
    manifest.git('add', '-A');
    manifest.git('commit', '-qm', 'manifest only');
    expect(version(manifest)).toBe('4.5.6');
    const malformed = bareRepo();
    fs.writeFileSync(path.join(malformed.work, 'VERSION'), 'not-a-version\n');
    malformed.git('add', '-A');
    malformed.git('commit', '-qm', 'malformed VERSION');
    expect(version(malformed)).toBeUndefined();
    const stamped = fixture({ policy: { ...BASE_POLICY, stamp_files: ['RELEASE'] } });
    fs.writeFileSync(path.join(stamped.work, 'RELEASE'), 'build 7\n');
    for (const f of ['VERSION', 'package.json', 'package-lock.json', 'CHANGELOG.md']) fs.rmSync(path.join(stamped.work, f));
    stamped.git('add', '-A');
    stamped.git('commit', '-qm', 'only a policy stamp file');
    expect(version(stamped)).toBeUndefined();
    const unreachable = bareRepo();
    unreachable.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(version(unreachable)).toBeUndefined();
  });
});

describe('E11: the documentation audit record and the doc caps', () => {
  test('parseReceiptDocs: blocked without an exception is DOCS_AUDIT_BLOCKED; malformed input is RECEIPT_INVALID; a full record parses', () => {
    expect(parseReceiptDocs({ status: 'blocked', scope: 'docs/' })).toMatchObject({ ok: false, code: 'DOCS_AUDIT_BLOCKED' });
    expect(parseReceiptDocs({ status: 'current', scope: 'docs/' })).toEqual({ ok: true, docs: { status: 'current', scope: 'docs/' } });
    for (const bad of [null, [], 'current', { status: 'done', scope: 'x' }, { status: 'current' }, { status: 'current', scope: '' }, { status: 'current', scope: 'x', extra: 1 },
      { status: 'blocked', scope: 'x', exception: { accepted_by: 'o', date: '2026-10-26', via: 'r' } }, { status: 'blocked', scope: 'x', exception: { accepted_by: 'o', date: 'yesterday', via: 'r', reason: 'w' } },
      { status: 'blocked', scope: 'x', exception: { accepted_by: 'o', date: '2026-10-26', via: 'r', reason: 'w', more: 1 } }]) {
      expect(parseReceiptDocs(bad)).toMatchObject({ ok: false, code: 'RECEIPT_INVALID' });
    }
    const full = parseReceiptDocs({ status: 'blocked', scope: 'docs/, README.md', exception: { accepted_by: ' owner ', date: '2026-10-26', via: 'PR #12 comment', reason: 'the removed page is republished next release' } });
    expect(full).toEqual({ ok: true, docs: { status: 'blocked', scope: 'docs/, README.md', exception: { accepted_by: 'owner', date: '2026-10-26', via: 'PR #12 comment', reason: 'the removed page is republished next release' } } });
    expect(docsExceptionLine((full as any).docs)).toBe('Documentation exception: accepted by owner 2026-10-26 via PR #12 comment: the removed page is republished next release');
    expect(docsExceptionLine({ status: 'current', scope: 'x' })).toBeNull();
  });

  test('write --docs refuses a blocked audit with no exception and a body without the exception line, and records the exception otherwise', () => {
    const repo = fixture();
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Documentation\n\nAudit blocked on docs/removed.md.\n');
    const common = ['write', '--pr', '9', '--base', 'main', '--session-kind', 'unattended', '--body', body];
    const blocked = runBin(repo, 'gstack-ship-receipt', [...common, '--docs', '{"status":"blocked","scope":"docs/"}']);
    expect(blocked.status).toBe(EXIT.refused);
    expect(blocked.err).toContain('DOCS_AUDIT_BLOCKED');
    expect(blocked.err).toContain('troubleshooting.md#docs-audit-blocked');
    expect(fs.readFileSync(body, 'utf8')).not.toContain('gstack-ship-receipt');
    const docsFile = path.join(repo.root, 'docs.json');
    fs.writeFileSync(docsFile, JSON.stringify({ status: 'blocked', scope: 'docs/', exception: { accepted_by: 'owner', date: '2026-10-26', via: 'PR #9 review', reason: 'removed page republished in the next release' } }));
    const noLine = runBin(repo, 'gstack-ship-receipt', [...common, '--docs', '@' + docsFile]);
    expect(noLine.status).toBe(EXIT.refused);
    expect(noLine.err).toContain('does not carry the exception line verbatim');
    expect(noLine.err).toContain('"Documentation exception: accepted by owner 2026-10-26 via PR #9 review: removed page republished in the next release"');
    fs.appendFileSync(body, 'Documentation exception: accepted by owner 2026-10-26 via PR #9 review: removed page republished in the next release\n');
    const ok = runBin(repo, 'gstack-ship-receipt', [...common, '--docs', '@' + docsFile, '--review-loop', '{"passes":1,"blocking_found":0,"deferred":0}']);
    expect(ok.status).toBe(EXIT.ok);
    const receipt = extractReceipt(fs.readFileSync(body, 'utf8'));
    expect(receipt.errors).toEqual([]);
    expect((receipt.receipt as any).docs).toEqual({ status: 'blocked', scope: 'docs/', exception: { accepted_by: 'owner', date: '2026-10-26', via: 'PR #9 review', reason: 'removed page republished in the next release' } });
    expect(Object.keys(receipt.receipt!).slice(-3)).toEqual(['docs', 'review_loop', 'gate_dispositions']);
    expect(runBin(repo, 'gstack-ship-receipt', ['read', '--body', body]).status).toBe(EXIT.ok);
    const malformed = runBin(repo, 'gstack-ship-receipt', [...common, '--docs', '{"status":"done","scope":"docs/"}']);
    expect(malformed.status).toBe(EXIT.fail);
    expect(malformed.err).toContain('RECEIPT_INVALID');
  });

  test('checkDocsCaps and docs-caps: one line per cap, over or absent exits 1 with DOCS_AUDIT_BLOCKED, no caps prints none declared', () => {
    expect(checkDocsCaps([{ path: 'a.md', max_bytes: 10 }, { path: 'b.md', max_bytes: 10 }, { path: 'c.md', max_bytes: 10 }], p => ({ 'a.md': 10, 'b.md': 11 } as Record<string, number>)[p] ?? null).map(docsCapLine))
      .toEqual(['DOCS_CAP: a.md 10/10 ok', 'DOCS_CAP: b.md 11/10 over', 'DOCS_CAP: c.md absent/10 over']);
    const repo = fixture();
    const none = runBin(repo, 'gstack-ship-receipt', ['docs-caps']);
    expect(none.status).toBe(EXIT.ok);
    expect(none.out.trim()).toBe('DOCS_CAP: none declared');
    const policy = path.join(repo.root, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({ docs: { caps: [{ path: 'docs/notes.md', max_bytes: 4096 }, { path: 'CHANGELOG.md', max_bytes: 16 }, { path: 'docs/missing.md', max_bytes: 10 }] }, min_gstack_version: DOCS_CAPS_KEY_VERSION }));
    const r = runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--policy', policy]);
    expect(r.status).toBe(EXIT.fail);
    const changelogBytes = fs.statSync(path.join(repo.work, 'CHANGELOG.md')).size;
    expect(r.out.trim().split('\n')).toEqual([
      `DOCS_CAP: docs/notes.md ${fs.statSync(path.join(repo.work, 'docs/notes.md')).size}/4096 ok`,
      `DOCS_CAP: CHANGELOG.md ${changelogBytes}/16 over`,
      'DOCS_CAP: docs/missing.md absent/10 over',
    ]);
    expect(r.err).toContain('DOCS_AUDIT_BLOCKED');
    expect(r.err).toContain('2 of 3 documentation caps over: CHANGELOG.md, docs/missing.md');
    fs.writeFileSync(policy, JSON.stringify({ docs: { caps: [{ path: 'docs/notes.md', max_bytes: 4096 }] }, min_gstack_version: DOCS_CAPS_KEY_VERSION }));
    const ok = runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--policy', policy, '--json']);
    expect(ok.status).toBe(EXIT.ok);
    expect(JSON.parse(ok.out)).toMatchObject({ over: 0, caps: [{ path: 'docs/notes.md', verdict: 'ok' }] });
    fs.writeFileSync(policy, JSON.stringify({ docs: { caps: [{ path: '../escape.md', max_bytes: 0 }] } }));
    const bad = runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--policy', policy]);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('POLICY_CONTAINMENT');
    expect(bad.err).toContain('docs.caps[0].max_bytes');
    expect(runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--policy', path.join(repo.root, 'nope.json')]).status).toBe(EXIT.usage);
  });

  test('docs-caps reads the caps from the base policy, so a branch that raises its own cap in the working tree still reports over', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, docs: { caps: [{ path: 'CHANGELOG.md', max_bytes: 16 }] }, min_gstack_version: DOCS_CAPS_KEY_VERSION } });
    const raised = JSON.stringify({ ...BASE_POLICY, docs: { caps: [{ path: 'CHANGELOG.md', max_bytes: 1_000_000 }] }, min_gstack_version: DOCS_CAPS_KEY_VERSION }, null, 2) + '\n';
    fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), raised);
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'raise my own cap');
    const r = runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--base', 'main']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out.trim()).toBe(`DOCS_CAP: CHANGELOG.md ${fs.statSync(path.join(repo.work, 'CHANGELOG.md')).size}/16 over`);
    expect(r.err).toContain('DOCS_AUDIT_BLOCKED');
    const explicit = runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--policy', path.join(repo.work, '.gstack', 'ship-policy.json')]);
    expect(explicit.status).toBe(EXIT.ok);
    repo.git('update-ref', '-d', 'refs/remotes/origin/main');
    const gone = runBin(repo, 'gstack-ship-receipt', ['docs-caps', '--base', 'main']);
    expect(gone.status).toBe(EXIT.refused);
    expect(gone.err).toContain('POLICY_SOURCE_UNAVAILABLE');
  });

  test('the policy docs key validates its shape and needs min_gstack_version', () => {
    const codes = (raw: Record<string, unknown>) => validatePolicy(raw, { gstackVersion: '9.9.9.9' }).map(e => `${e.code}:${e.path}`);
    expect(codes({ docs: null })).toEqual([]);
    expect(codes({ docs: { caps: [] } })).toEqual(['POLICY_INVALID:docs']);
    expect(codes({ docs: { caps: [{ path: 'README.md', max_bytes: 100 }] }, min_gstack_version: DOCS_CAPS_KEY_VERSION })).toEqual([]);
    expect(codes({ docs: { caps: 'README.md' }, min_gstack_version: DOCS_CAPS_KEY_VERSION })).toEqual(['POLICY_INVALID:docs.caps']);
    expect(codes({ docs: { caps: [{ path: '/etc/x', max_bytes: 1.5, other: 1 }], limit: 1 }, min_gstack_version: DOCS_CAPS_KEY_VERSION }))
      .toEqual(['POLICY_INVALID:docs.limit', 'POLICY_INVALID:docs.caps[0].other', 'POLICY_CONTAINMENT:docs.caps[0].path', 'POLICY_INVALID:docs.caps[0].max_bytes']);
  });
});

describe('carry follow-ups: git floor, named refusal, branch-touched walk, digit-bounded stamps', () => {
  test('stampOnlyText replaces the version only at digit boundaries', () => {
    const change = (before: string, after: string) => stampOnlyText({ before, after, oldVersion: '1.2.3', newVersion: '1.2.4' });
    expect(change('v1.2.3 and 11.2.3 and 1.2.34\n', 'v1.2.4 and 11.2.3 and 1.2.34\n')).toBe(true);
    expect(change('v1.2.3 and 11.2.3\n', 'v1.2.4 and 11.2.4\n')).toBe(false);
    expect(change('1.2.34\n', '1.2.44\n')).toBe(false);
  });

  // #3512: the carry classifies a stamp path as metadata only while its change is a stamp; a tentative key version the slot
  // stamp moved (next minor -> released) was product, so `carry` refused RECEIPT_CARRY_PRODUCT_CHANGED on a stamp commit.
  test('stampOnlyText accepts a tentative key version moved to the new version, and refuses a released one moved by hand or any other edit', () => {
    const templates = ["_KEY_VERSION = '{version}'"];
    const change = (before: string, after: string) => stampOnlyText({ before, after, oldVersion: '1.2.3.0', newVersion: '1.2.4.0', templates });
    const keys = (docs: string, old: string, extra = '') => `export const DOCS_KEY_VERSION = '${docs}';\nexport const OLD_KEY_VERSION = '${old}';\n${extra}`;
    expect(change(keys('1.3.0.0', '1.2.2.0'), keys('1.2.4.0', '1.2.2.0'))).toBe(true);
    expect(change(keys('1.2.3.0', '1.2.2.0'), keys('1.2.4.0', '1.2.2.0'))).toBe(true);
    expect(change(keys('1.3.0.0', '1.2.2.0'), keys('1.2.4.0', '1.2.4.0'))).toBe(false);
    expect(change(keys('1.3.0.0', '1.2.2.0'), keys('1.2.4.0', '1.2.2.0', 'export const EXTRA = 1;\n'))).toBe(false);
    // Without the template the constant is not a stamp form, so the move is a product change.
    expect(stampOnlyText({ before: keys('1.3.0.0', '1.2.2.0'), after: keys('1.2.4.0', '1.2.2.0'), oldVersion: '1.2.3.0', newVersion: '1.2.4.0' })).toBe(false);
    // A mention of another width is never a stamp candidate (tentativeMentions), so moving it by hand is a product change.
    expect(change(keys('1.3.0', '1.2.2.0'), keys('1.2.4.0', '1.2.2.0'))).toBe(false);
    expect(stampOnlyText({ before: 'left-pad since: 1.2.3\n', after: 'left-pad since: 1.2.4.0\n', oldVersion: '1.2.3.0', newVersion: '1.2.4.0' })).toBe(false);
  });

  // GST-963: the carry shares the stage's bound, so a key version the branch added at its fork version (older than the
  // pin's VERSION after a base merge) is a stamp on the branch's own line and a hand edit on any other.
  test('stampOnlyText takes the fork-version bound only on a line the branch added', () => {
    const templates = ["_KEY_VERSION = '{version}'"];
    const mine = "export const MINE_KEY_VERSION = '1.2.3.0';";
    const before = `${mine}\nexport const BASE_KEY_VERSION = '1.2.3.0';\n`;
    const moved = (text: string) => ({ before, after: text, oldVersion: '1.2.4.0', newVersion: '1.2.5.0', templates });
    const side = { fork: '1.2.3.0', added: new Set([mine]), at: new Set([1]) };
    expect(stampOnlyText({ ...moved(before.replace(mine, mine.replace('1.2.3.0', '1.2.5.0'))), side })).toBe(true);
    expect(stampOnlyText(moved(before.replace(mine, mine.replace('1.2.3.0', '1.2.5.0'))))).toBe(false);
    expect(stampOnlyText({ ...moved(before.replace("BASE_KEY_VERSION = '1.2.3.0'", "BASE_KEY_VERSION = '1.2.5.0'")), side })).toBe(false);
  });

  // Value: protects=the carry reads the branch's own line by position and, with a kept VERSION claim, accepts only the
  //   branch's own row moved from the fork version (GST-979, GST-980); fails_when=stampOnlyText refuses every change at
  //   equal versions or takes a duplicated base line as the branch's; seam=lib/ship-receipt.ts stampOnlyText
  test('stampOnlyText reads the branch line by position, and with a kept VERSION moves only the branch\'s own row (GST-979, GST-980)', () => {
    const templates = ["_KEY_VERSION = '{version}'"];
    const key = (v: string) => `export const MINE_KEY_VERSION = '${v}';`;
    const before = `${key('1.2.3.0')}\nexport const BASE_KEY_VERSION = '1.2.3.0';\n${key('1.2.3.0')}\n`;
    const side = { fork: '1.2.3.0', added: new Set([key('1.2.3.0')]), at: new Set([3]) };
    const lines = (a: string, c: string) => `${a}\nexport const BASE_KEY_VERSION = '1.2.3.0';\n${c}\n`;
    const change = (after: string, oldVersion: string, newVersion: string) => stampOnlyText({ before, after, oldVersion, newVersion, templates, side });
    expect(change(lines(key('1.2.3.0'), key('1.2.5.0')), '1.2.4.0', '1.2.5.0')).toBe(true);
    expect(change(lines(key('1.2.5.0'), key('1.2.3.0')), '1.2.4.0', '1.2.5.0')).toBe(false);
    expect(change(lines(key('1.2.3.0'), key('1.2.4.0')), '1.2.4.0', '1.2.4.0')).toBe(true);
    expect(change(lines(key('1.2.4.0'), key('1.2.3.0')), '1.2.4.0', '1.2.4.0')).toBe(false);
    expect(stampOnlyText({ before, after: lines(key('1.2.3.0'), key('1.2.4.0')), oldVersion: '1.2.4.0', newVersion: '1.2.4.0', templates })).toBe(false);
  });

  // Value: protects=the carry classifier reads a declared placeholder moved to the new version on the branch's own row
  //   as a stamp, through the same predicate as finish and the tree receipt (GST-1026); fails_when=stampOnlyText ignores
  //   the policy's placeholders, or accepts an undeclared one or a base row; seam=lib/ship-receipt.ts stampOnlyText
  test('stampOnlyText reads a declared placeholder moved on the branch\'s own row as a stamp, and nothing else (GST-1026)', () => {
    const templates = ["since: '{version}'"];
    const row = (v: string, id: string) => `  { since: '${v}', id: '${id}' },`;
    const text = (...rows: string[]) => ['export const ROWS = [', ...rows, '];', ''].join('\n');
    const before = text(row('TBD', 'base'), row('TBD', 'mine'));
    const side = { fork: '0.60.552.0', added: new Set([row('TBD', 'mine')]), at: new Set([3]) };
    const change = (after: string, extra: Record<string, unknown> = {}) => stampOnlyText({ before, after, oldVersion: '0.60.552.0', newVersion: '0.60.553.0', templates, side, placeholders: ['TBD'], ...extra });
    expect(change(text(row('TBD', 'base'), row('0.60.553.0', 'mine')))).toBe(true);
    expect(change(text(row('TBD', 'base'), row('0.60.553.0', 'mine')), { oldVersion: '0.60.553.0' })).toBe(true);
    expect(change(text(row('TBD', 'base'), row('0.60.553.0', 'mine')), { placeholders: [] })).toBe(false);
    expect(change(text(row('TBD', 'base'), row('0.60.553.0', 'mine')), { placeholders: ['WIP'] })).toBe(false);
    expect(change(text(row('TBD', 'base'), row('0.60.553.0', 'mine')), { templates: [] })).toBe(false);
    expect(change(text(row('TBD', 'base'), row('0.60.553.0', 'mine')), { side: undefined })).toBe(false);
    expect(change(text(row('0.60.553.0', 'base'), row('TBD', 'mine')))).toBe(false);
  });

  test('planCarry names at most CARRY_NAMED_PATHS paths', () => {
    const many = Array.from({ length: CARRY_NAMED_PATHS + 3 }, (_, i) => `src/f${i}.ts`);
    const plan = planCarry({ from: 'a'.repeat(40), head: 'b'.repeat(40), changed: many.map(p => ({ path: p, class: 'product' as const })), productPatchId: { from: 'x', head: 'y' }, testPatchId: { from: '', head: '' }, changedProduct: many, mergeCommits: 0, rangeDiff: '' });
    expect(plan.ok).toBe(false);
    expect((plan as any).message).toContain(`(+3 more)`);
    expect((plan as any).message.split(', ').length).toBe(CARRY_NAMED_PATHS);
  });

  // The old-git stand-in is a sh script on a colon-joined PATH, which CreateProcess cannot run on Windows.
  test.skipIf(process.platform === 'win32')('carry refuses git below 2.39 by name (RECEIPT_GIT_TOO_OLD) and names a product path the branch touched', () => {
    const repo = fixture();
    makePr(repo, 'pr-carry', { expects: '1.2.4.0' });
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '3', '--base', 'main', '--session-kind', 'x', '--body', body]).status).toBe(EXIT.ok);
    fs.writeFileSync(path.join(repo.work, 'src.ts'), 'export const x = 1;\n');
    repo.git('add', 'src.ts');
    repo.git('commit', '-qm', 'product change');
    const shim = path.join(repo.root, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'git'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.38.5"; exit 0; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const realGit = gitArgvIn(repo.work, ['--version']).stdout.toString();
    expect(realGit).toMatch(/git version/);
    const old = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main'], { PATH: `${shim}:${process.env.PATH}` });
    expect(old.status).toBe(EXIT.refused);
    expect(old.err).toContain('RECEIPT_GIT_TOO_OLD');
    expect(old.err).toContain('git 2.38.5 cannot run patch-id --verbatim; the carry needs git 2.39 or later');
    expect(fs.readFileSync(body, 'utf8')).toContain('"pr": 3');
    const changed = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(changed.status).toBe(EXIT.refused);
    expect(changed.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(changed.err).toContain('src.ts');
  });

  test.skipIf(process.platform === 'win32')('a failing patch-id is a RECEIPT_CARRY_REFUSED naming git\'s error, never a carry', () => {
    const repo = fixture();
    makePr(repo, 'pr-patchid', { expects: '1.2.4.0' });
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '5', '--base', 'main', '--session-kind', 'x', '--body', body]).status).toBe(EXIT.ok);
    fs.writeFileSync(path.join(repo.work, 'src.test.ts'), 'export const t = 1;\n');
    repo.git('add', 'src.test.ts');
    repo.git('commit', '-qm', 'test-only change');
    const shim = path.join(repo.root, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'git'), '#!/bin/sh\nif [ "$1" = "patch-id" ]; then echo "fatal: patch-id exploded" >&2; exit 128; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const before = fs.readFileSync(body, 'utf8');
    const broken = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main'], { PATH: `${shim}:${process.env.PATH}` });
    expect(broken.status).toBe(EXIT.refused);
    expect(broken.err).toContain('RECEIPT_CARRY_REFUSED');
    expect(broken.err).toContain('git patch-id --verbatim: fatal: patch-id exploded');
    expect(fs.readFileSync(body, 'utf8')).toBe(before);
    expect(runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']).out).toContain('CARRY: carried');
  });

  test('the carry walk names the branch product path and not a product path a base merge brought in', () => {
    const repo = fixture();
    makePr(repo, 'pr-walk', { expects: '1.2.4.0' });
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '4', '--base', 'main', '--session-kind', 'x', '--body', body]).status).toBe(EXIT.ok);
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'lib-base-only.ts'), 'export const base = 1;\n');
    repo.git('add', 'lib-base-only.ts');
    repo.git('commit', '-qm', 'base change');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'pr-walk');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    const merged = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(merged.status).toBe(EXIT.ok);
    expect(merged.out).toContain('CARRY: carried');
    fs.writeFileSync(path.join(repo.work, 'src.ts'), 'export const x = 2;\n');
    repo.git('add', 'src.ts');
    repo.git('commit', '-qm', 'product change after the merge');
    const changed = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(changed.status).toBe(EXIT.refused);
    expect(changed.err).toMatch(/product diff changed between [0-9a-f]{12} and [0-9a-f]{12}: src\.ts/);
    expect(changed.err).not.toContain('lib-base-only.ts');
  });
});
