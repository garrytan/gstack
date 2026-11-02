/**
 * W2 (field list 2): approval classes. `gstack-approval-classes check` reads
 * the classes only from the committed origin/<base> copy and the migration
 * rule from the base's ship policy; `gstack-ship-receipt write` refuses
 * APPROVAL_CITATION_MISSING unless every declared class with hits has a
 * citation that resolves (an APPROVED autoplan plan, a ship-policy
 * maintainer's comment) and binds to the class's current effects, or an
 * explicit `for <class>@<digest>` attestation recorded as unverified.
 * Real fixture repositories, real autoplan runs and a `gh` shim on PATH.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { evaluateApprovals, parseCitations } from '../lib/approval-citations';
import { scopeOf, type ApprovalHit } from '../lib/approval-classes';
import { autoplan, recCarrying, runPhase } from './helpers/autoplan-run-fixture';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const CLASSES = [
  { name: 'data-repair', description: 'rewrites user data', paths: ['src/commands/repair/**'] },
  { name: 'default-change', patterns: ['DEFAULT_TOKENMAX'], allowed_paths: ['test/**'] },
];
const POLICY = { ...BASE_POLICY, maintainers: ['garrytan'], migrations: { dir: 'db/migrate', id: '^(\\d+)_' } };

function classRepo(classes: unknown[] | null = CLASSES, policy: Record<string, unknown> = POLICY): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'approval-classes-', policy });
  repos.push(repo);
  if (classes) {
    fs.writeFileSync(path.join(repo.work, '.gstack', 'approval-classes.json'), JSON.stringify({ classes }, null, 2) + '\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'approval classes');
    repo.git('push', '-q', 'origin', 'main');
  }
  repo.git('checkout', '-q', '-b', 'feature');
  return repo;
}

function commit(repo: FixtureRepo, files: Record<string, string>, message = 'change'): string {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.work, rel), body);
  }
  repo.git('add', '-A');
  repo.git('commit', '-qm', message);
  return repo.git('rev-parse', 'HEAD');
}

const check = (repo: FixtureRepo, args: string[] = []) => runBin(repo, 'gstack-approval-classes', ['check', '--base', 'main', ...args]);
const scopeToken = (out: string, cls: string) => new RegExp(`^APPROVAL_SCOPE: (${cls}@[0-9a-f]{12}) `, 'm').exec(out)?.[1];

/** A `gh api <path>` shim answering from a map of API path → JSON body; anything else fails like an unreachable gh. */
function ghApi(repo: FixtureRepo, responses: Record<string, unknown>): { PATH: string } {
  const dir = path.join(repo.root, 'gh-api-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/sh',
    `[ "$1" = "api" ] || { echo "gh shim: unsupported $*" >&2; exit 1; }`,
    `node -e "const d=require(process.argv[1]);const r=d[process.argv[2]];if(!r){console.error('HTTP 404: Not Found');process.exit(1)}console.log(JSON.stringify(r))" "${path.join(dir, 'responses.json')}" "$2"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

function write(repo: FixtureRepo, body: string, args: string[] = [], env: Record<string, string> = {}) {
  const bodyFile = path.join(repo.root, 'body.md');
  fs.writeFileSync(bodyFile, body);
  const r = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'interactive', '--body', bodyFile, '--json', ...args], env);
  return { ...r, body: fs.readFileSync(bodyFile, 'utf8') };
}

const REPAIR = { 'src/commands/repair/accepted-takes.ts': 'export function repairAcceptedTakes(preview = true) { return preview; }\n' };
const COMMENT = 'https://github.com/acme/brain/pull/7#issuecomment-101';
const COMMENT_API = 'repos/acme/brain/issues/comments/101';

describe('gstack-approval-classes check', () => {
  test('no committed classes: none, exit 0', () => {
    const repo = classRepo(null);
    commit(repo, REPAIR);
    const r = check(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^APPROVAL_CLASSES: none \(no \.gstack\/approval-classes\.json on the base\) classes=0 report_only=0 source=origin\/main@[0-9a-f]{12}:\.gstack\/approval-classes\.json$/m);
  }, 30_000);

  test('hits by path and literal pattern print class and file:line, one scope token per class, found=<n>; allowed paths are exempt; exit 1', () => {
    const repo = classRepo();
    commit(repo, { ...REPAIR, 'src/config.ts': 'export const A = 1;\nexport const DEFAULT_TOKENMAX = false;\n', 'test/config.test.ts': 'DEFAULT_TOKENMAX\n' });
    const r = check(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('APPROVAL_CLASS: data-repair src/commands/repair/accepted-takes.ts:1 (path) — added\n');
    expect(r.out).toContain('APPROVAL_CLASS: default-change src/config.ts:2 (pattern) — export const DEFAULT_TOKENMAX = false;\n');
    expect(r.out).not.toContain('test/config.test.ts');
    expect(scopeToken(r.out, 'data-repair')).toBeDefined();
    expect(r.out).toMatch(/^APPROVAL_SCOPE: default-change@[0-9a-f]{12} effects=1 files=src\/config\.ts; cite: Approved by <owner> <YYYY-MM-DD> via <plan sha\|comment or review URL\|ref> for default-change@[0-9a-f]{12}$/m);
    expect(r.out).toMatch(/^APPROVAL_CLASSES: found=2 classes=2 report_only=0 source=origin\/main@/m);
    expect(r.err).toMatch(/\(APPROVAL_CLASS_FOUND\)$/m);
  }, 30_000);

  test('classes come only from the base: a branch that deletes its class file is still checked against origin/main', () => {
    const repo = classRepo();
    fs.rmSync(path.join(repo.work, '.gstack', 'approval-classes.json'));
    commit(repo, REPAIR, 'drop classes and add a repair');
    const r = check(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('APPROVAL_CLASS: data-repair src/commands/repair/accepted-takes.ts:1');
  }, 30_000);

  test('the scope token changes when an effect is added or edited, and is stable otherwise', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const first = scopeToken(check(repo).out, 'data-repair');
    expect(scopeToken(check(repo).out, 'data-repair')).toBe(first);
    commit(repo, { 'src/commands/repair/accepted-takes.ts': 'export function repairAcceptedTakes(preview = false) { return preview; }\n' }, 'edit');
    const edited = scopeToken(check(repo).out, 'data-repair');
    expect(edited).not.toBe(first);
    commit(repo, { 'src/commands/repair/orphans.ts': 'export const x = 1;\n' }, 'add');
    expect(scopeToken(check(repo).out, 'data-repair')).not.toBe(edited);
  }, 30_000);

  test('migrations from the ship policy: report-only when no class claims them, declared with migrations: true', () => {
    const plain = classRepo();
    commit(plain, { 'db/migrate/0249_add_beliefs.sql': 'CREATE TABLE beliefs (id int);\n', 'db/migrate/README.md': 'notes\n' });
    const r = check(plain);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('APPROVAL_CLASS: migrations db/migrate/0249_add_beliefs.sql:1 (built-in, report-only) — added\n');
    expect(r.out).not.toContain('README');
    expect(r.out).toMatch(/^APPROVAL_CLASSES: ok classes=2 report_only=1 /m);
    const declared = classRepo([...CLASSES, { name: 'upgrade-data-rewrite', migrations: true }]);
    commit(declared, { 'db/migrate/0249_add_beliefs.sql': 'UPDATE takes SET x = 1;\n' });
    const d = check(declared);
    expect(d.status).toBe(EXIT.fail);
    expect(d.out).toContain('APPROVAL_CLASS: upgrade-data-rewrite db/migrate/0249_add_beliefs.sql:1 (migration) — added\n');
    expect(d.out).toMatch(/report_only=0 /);
  }, 30_000);

  test('init writes an example that validates; an invalid working-tree or base file refuses with APPROVAL_CLASSES_INVALID; no origin refuses with APPROVAL_SOURCE_UNAVAILABLE', () => {
    const repo = classRepo(null);
    const init = runBin(repo, 'gstack-approval-classes', ['init']);
    expect(init.status).toBe(EXIT.ok);
    expect(runBin(repo, 'gstack-approval-classes', ['init']).status).toBe(EXIT.refused);
    const valid = runBin(repo, 'gstack-approval-classes', ['validate']);
    expect(valid.status, valid.err).toBe(EXIT.ok);
    expect(valid.out).toBe('APPROVAL_CLASSES_VALID: .gstack/approval-classes.json classes=4\n');
    fs.writeFileSync(path.join(repo.work, '.gstack', 'approval-classes.json'), JSON.stringify({ classes: [{ name: 'Bad Name', paths: ['../x'] }, { name: 'empty' }], extra: 1 }));
    const bad = runBin(repo, 'gstack-approval-classes', ['validate']);
    expect(bad.status).toBe(EXIT.refused);
    for (const at of ['extra', 'classes[0].name', 'classes[0].paths[0]', 'classes[1]']) expect(bad.err).toMatch(new RegExp(` at ${at.replace(/[[\]]/g, '\\$&')} ?.*\\(APPROVAL_CLASSES_INVALID\\)$`, 'm'));
    const broken = classRepo([{ name: 'x' }]);
    const b = check(broken);
    expect(b.status).toBe(EXIT.refused);
    expect(b.err).toMatch(/matches nothing.*\(origin\/main@[0-9a-f]{12}:\.gstack\/approval-classes\.json\).*\(APPROVAL_CLASSES_INVALID\)$/m);
    broken.git('remote', 'remove', 'origin');
    const gone = check(broken);
    expect(gone.status).toBe(EXIT.refused);
    expect(gone.err).toMatch(/origin\/main is not a resolvable commit.*\(APPROVAL_SOURCE_UNAVAILABLE\)$/m);
  }, 30_000);
});

describe('citation grammar', () => {
  test('owner, date, ref and an optional for-list; a bad calendar date is not a citation; trailing punctuation leaves the ref', () => {
    const [a, b] = parseCitations('Approved by @garrytan 2026-10-16 via https://github.com/a/b/pull/1#issuecomment-2.\nApproved by Garry 2026-10-16 via GBRA-60 for data-repair@0123456789ab,default-change\nApproved by x 2026-02-30 via y');
    expect(a).toMatchObject({ owner: 'garrytan', date: '2026-10-16', ref: 'https://github.com/a/b/pull/1#issuecomment-2', for: [] });
    expect(b).toMatchObject({ owner: 'Garry', ref: 'GBRA-60', for: [{ class: 'data-repair', digest: '0123456789ab' }, { class: 'default-change' }] });
    expect(parseCitations('Approved by x 2026-02-30 via y')).toEqual([]);
  }, 30_000);
});

describe('gstack-ship-receipt write enforces declared classes (APPROVAL_CITATION_MISSING)', () => {
  test('no citation: refused, nothing written, the body untouched', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const w = write(repo, '## Summary\n');
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toMatch(/data-repair \(data-repair@[0-9a-f]{12}; effects in src\/commands\/repair\/accepted-takes\.ts\): no "Approved by" line.*\(APPROVAL_CITATION_MISSING\)$/m);
    expect(w.out).toBe('');
    expect(w.body).toBe('## Summary\n');
  }, 30_000);

  test('a maintainer comment naming the scope token verifies; an authentic but unrelated approval, a non-maintainer, an owner mismatch and a changes-requested review do not', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const token = scopeToken(check(repo).out, 'data-repair')!;
    const unrelated = write(repo, `Approved by garrytan 2026-10-16 via ${COMMENT}\n`, [], ghApi(repo, { [COMMENT_API]: { user: { login: 'garrytan' }, body: 'LGTM on the docs change' } }));
    expect(unrelated.status).toBe(EXIT.fail);
    expect(unrelated.err).toMatch(/comment by garrytan names neither data-repair@[0-9a-f]{12} nor data-repair with every effect path.*\(APPROVAL_CITATION_MISSING\)$/m);
    const stranger = write(repo, `Approved by mallory 2026-10-16 via ${COMMENT}\n`, [], ghApi(repo, { [COMMENT_API]: { user: { login: 'mallory' }, body: `approved ${token}` } }));
    expect(stranger.err).toMatch(/is by mallory, not a ship-policy maintainer.*\(APPROVAL_CITATION_MISSING\)$/m);
    const mismatch = write(repo, `Approved by alice 2026-10-16 via ${COMMENT}\n`, [], ghApi(repo, { [COMMENT_API]: { user: { login: 'garrytan' }, body: `approved ${token}` } }));
    expect(mismatch.err).toMatch(/the citation names alice but .* is by garrytan/);
    const review = 'https://github.com/acme/brain/pull/7#pullrequestreview-55';
    const changes = write(repo, `Approved by garrytan 2026-10-16 via ${review}\n`, [], ghApi(repo, { 'repos/acme/brain/pulls/7/reviews/55': { user: { login: 'garrytan' }, state: 'CHANGES_REQUESTED', body: token } }));
    expect(changes.err).toMatch(/requests changes; it is not an approval/);
    const ok = write(repo, `## Summary\n\nApproved by garrytan 2026-10-16 via ${COMMENT}\n`, [], ghApi(repo, { [COMMENT_API]: { user: { login: 'garrytan' }, body: `Approved: ${token}. Preview first, never at upgrade.` } }));
    expect(ok.status, ok.err).toBe(EXIT.ok);
    expect(ok.err).toMatch(/^SHIP_RECEIPT: .* approval=verified$/m);
    const receipt = JSON.parse(ok.out);
    expect(receipt.approval).toMatchObject({ status: 'checked', source: expect.stringMatching(/^origin\/main@[0-9a-f]{12}:\.gstack\/approval-classes\.json$/) });
    expect(receipt.approval.classes).toEqual([{ class: 'data-repair', scope: token, effects: ['src/commands/repair/accepted-takes.ts:1'], citation: 'verified', approved_by: 'garrytan', date: '2026-10-16', via: COMMENT, binding: 'token', evidence: 'comment by garrytan' }]);
    expect(extractReceipt(ok.body).receipt!.approval).toEqual(receipt.approval);
  }, 30_000);

  test('an effect added after the approval invalidates it: the old token no longer binds', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const token = scopeToken(check(repo).out, 'data-repair')!;
    const gh = ghApi(repo, { [COMMENT_API]: { user: { login: 'garrytan' }, body: `approved ${token} (src/commands/repair/accepted-takes.ts)` } });
    expect(write(repo, `Approved by garrytan 2026-10-16 via ${COMMENT}\n`, [], gh).status).toBe(EXIT.ok);
    commit(repo, { 'src/commands/repair/clear-never-installed.ts': 'export const wipe = true;\n' }, 'post-approval addition');
    const after = write(repo, `Approved by garrytan 2026-10-16 via ${COMMENT}\n`, [], gh);
    expect(after.status).toBe(EXIT.fail);
    expect(after.err).toMatch(/effects in src\/commands\/repair\/accepted-takes\.ts, src\/commands\/repair\/clear-never-installed\.ts\).*names data-repair@[0-9a-f]{12}, not the current data-repair@[0-9a-f]{12}; a token is authoritative.*\(APPROVAL_CITATION_MISSING\)$/m);
  }, 30_000);

  test('a plan sha resolves through an APPROVED autoplan run whose plan names the class and every effect path; a pending gate, an unrelated plan and a later file do not', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const run = (name: string, text: string, approve: boolean) => {
      const dir = path.join(repo.root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plan.md'), `# ${name}\n\n## Implementation plan\n\n${text}\n\n## Review record\n`);
      const out = path.join(dir, 'run');
      expect(autoplan(['next', '--out', out, '--plan', path.join(dir, 'plan.md'), '--no-ui']).status).toBe(0);
      runPhase(out, 'ceo');
      runPhase(out, 'eng');
      if (approve) expect(autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', recCarrying(out)]).stdout).toMatch(/^APPROVED: gate_rev=1/m);
      const sha = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).artifacts['plan.md'].sha256 as string;
      return { out, sha: sha.slice(0, 8) };
    };
    const good = run('repair-plan', 'Add a data-repair command in src/commands/repair/accepted-takes.ts: explicit, preview-first, never at upgrade. Tests cover preview and apply.', true);
    const pending = run('pending-plan', 'Add a data-repair command in src/commands/repair/accepted-takes.ts: explicit and preview-first. Tests cover it.', false);
    const other = run('docs-plan', 'Rewrite the quickstart in docs/quickstart.md with a shorter first step. Tests cover the links.', true);
    const ok = write(repo, `Approved by Garry 2026-10-16 via ${good.sha}\n`, ['--approval-run', other.out, '--approval-run', good.out]);
    expect(ok.status, ok.err).toBe(EXIT.ok);
    expect(JSON.parse(ok.out).approval.classes[0]).toMatchObject({ class: 'data-repair', citation: 'verified', binding: 'paths', via: good.sha, evidence: expect.stringMatching(/^plan run-\d+ gate_rev=1 p1=b answered_by=human$/) });
    const notApproved = write(repo, `Approved by Garry 2026-10-16 via ${pending.sha}\n`, ['--approval-run', pending.out]);
    expect(notApproved.err).toMatch(/holds this plan but its gate is not APPROVED \(status gate_pending, p1 unanswered\).*\(APPROVAL_CITATION_MISSING\)$/m);
    const unrelated = write(repo, `Approved by Garry 2026-10-16 via ${other.sha}\n`, ['--approval-run', other.out]);
    expect(unrelated.err).toMatch(/plan run-\d+ gate_rev=1 p1=b answered_by=human names neither/);
    const noRun = write(repo, `Approved by Garry 2026-10-16 via ${good.sha}\n`);
    expect(noRun.err).toMatch(/plan sha [0-9a-f]{8}: pass the autoplan run with --approval-run <dir>.*must attest "for data-repair@[0-9a-f]{12}"/);
    fs.appendFileSync(path.join(good.out, 'plan.md'), '\nsrc/commands/repair/later.ts\n');
    expect(write(repo, `Approved by Garry 2026-10-16 via ${good.sha}\n`, ['--approval-run', good.out]).err).toMatch(/plan\.md does not match its manifest hash/);
  }, 120_000);

  test('a plan gate an agent answered in its own words is not the owner\'s approval: a plan-sha citation of it is rejected', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const dir = path.join(repo.root, 'self-approved');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.md'), '# self-approved\n\n## Implementation plan\n\nAdd a data-repair command in src/commands/repair/accepted-takes.ts: explicit, preview-first, never at upgrade. Tests cover preview and apply.\n\n## Review record\n');
    const out = path.join(dir, 'run');
    expect(autoplan(['next', '--out', out, '--plan', path.join(dir, 'plan.md'), '--no-ui']).status).toBe(0);
    runPhase(out, 'ceo');
    runPhase(out, 'eng');
    const reply = recCarrying(out);
    expect(autoplan(['answer', '--by', 'agent:test', '--words-by', 'agent:test', '--owner-reply', reply, '--out', out, '--gate-rev', '1', '--reply', reply]).stdout).toMatch(/^APPROVED: gate_rev=1/m);
    const sha = (JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).artifacts['plan.md'].sha256 as string).slice(0, 8);
    const cited = write(repo, `Approved by Garry 2026-10-16 via ${sha}\n`, ['--approval-run', out]);
    expect(cited.status).toBe(EXIT.fail);
    expect(cited.err).toMatch(/gate was answered in agent:test's own words, not the owner's.*\(APPROVAL_CITATION_MISSING\)$/m);
  }, 120_000);

  test('an unresolvable reference counts only as an explicit for <class>@<digest> attestation, recorded unverified, and goes stale when the effects change', () => {
    const repo = classRepo();
    commit(repo, REPAIR);
    const token = scopeToken(check(repo).out, 'data-repair')!;
    const bare = write(repo, 'Approved by Garry 2026-10-16 via GBRA-60\n');
    expect(bare.err).toMatch(/GBRA-60: unresolved \(GBRA-60 is neither a plan sha nor a GitHub comment or review URL\); an unverified citation must attest "for data-repair@[0-9a-f]{12}".*\(APPROVAL_CITATION_MISSING\)$/m);
    const attested = write(repo, '', ['--approval', `Approved by Garry 2026-10-16 via GBRA-60 for ${token}`]);
    expect(attested.status, attested.err).toBe(EXIT.ok);
    expect(attested.err).toMatch(/^SHIP_RECEIPT: .* approval=unverified:data-repair$/m);
    expect(JSON.parse(attested.out).approval.classes[0]).toMatchObject({ citation: 'unverified', binding: 'attested', via: 'GBRA-60', evidence: expect.stringMatching(/^unresolved: /) });
    commit(repo, { 'src/commands/repair/orphans.ts': 'export const y = 2;\n' }, 'more repair');
    const stale = write(repo, '', ['--approval', `Approved by Garry 2026-10-16 via GBRA-60 for ${token}`]);
    expect(stale.status).toBe(EXIT.fail);
    expect(stale.err).toMatch(/attested for data-repair@[0-9a-f]{12} but the effects are now data-repair@[0-9a-f]{12} \(changed since the attestation\)/);
  }, 30_000);

  test('every class needs its own citation: an approval for one class does not cover another', () => {
    const repo = classRepo();
    commit(repo, { ...REPAIR, 'src/config.ts': 'export const DEFAULT_TOKENMAX = false;\n' });
    const repair = scopeToken(check(repo).out, 'data-repair')!;
    const w = write(repo, '', ['--approval', `Approved by Garry 2026-10-16 via GBRA-60 for ${repair}`]);
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toMatch(/default-change \(default-change@[0-9a-f]{12}; effects in src\/config\.ts\).*\(APPROVAL_CITATION_MISSING\)$/m);
    expect(w.err).not.toMatch(/data-repair \(data-repair@/);
  }, 30_000);

  test('no origin: the receipt records approval status unavailable and the summary says approval=unchecked; report-only migrations are recorded without a citation', () => {
    const repo = classRepo(null);
    commit(repo, { 'db/migrate/0250_x.sql': 'CREATE TABLE y (id int);\n' });
    const w = write(repo, '');
    expect(w.status, w.err).toBe(EXIT.ok);
    expect(JSON.parse(w.out).approval).toEqual({ source: expect.stringMatching(/^origin\/main@[0-9a-f]{12}:/), status: 'checked', classes: [], report_only: ['migrations db/migrate/0250_x.sql:1 (added)'] });
    expect(w.err).toMatch(/approval=none$/m);
    repo.git('remote', 'remove', 'origin');
    const gone = write(repo, '');
    expect(gone.status, gone.err).toBe(EXIT.ok);
    expect(gone.err).toMatch(/^APPROVAL_CLASSES: unavailable \(origin\/main is not a resolvable commit\); approval classes were not checked$/m);
    expect(gone.err).toMatch(/approval=unchecked$/m);
    expect(JSON.parse(gone.out).approval).toMatchObject({ status: 'unavailable', classes: [] });
  }, 30_000);
});

describe('review #3235 regressions: what counts as approval, stale tokens, and native diffs', () => {
  const hit = (blob: string): ApprovalHit => ({ class: 'data-repair', file: 'src/repair.ts', line: 1, via: 'path', text: 'modified', declared: true, effect: `path\0src/repair.ts\0${blob}` });
  const before = scopeOf('data-repair', [hit('preview-true')]);
  const after = scopeOf('data-repair', [hit('preview-false-wipe-all')]);
  const judge = (scope: typeof before, ref: string, response: Record<string, unknown>) => evaluateApprovals([scope], parseCitations(`Approved by garrytan 2026-10-16 via ${ref}`), { runDirs: [], maintainers: ['garrytan'], gh: () => ({ ok: true, out: JSON.stringify({ user: { login: 'garrytan' }, ...response }), err: '' }) });
  const REVIEW = 'https://github.com/acme/brain/pull/7#pullrequestreview-55';

  test('P1-2: a maintainer comment naming the token without an approval line approves nothing; an approval line does', () => {
    const rejection = judge(after, COMMENT, { body: `Do NOT approve ${after.token}. This deletes customer data.` });
    expect(rejection.records).toEqual([]);
    expect(rejection.missing[0]!.reasons[0]).toMatch(/names neither data-repair@[0-9a-f]{12} nor data-repair with every effect path \(src\/repair\.ts\) on its first non-blank line, which must start at column 0 with "Approved" or "Approve"/);
    expect(judge(after, COMMENT, { body: `Looks fine.\nNot approving ${after.token} yet.` }).records).toEqual([]);
    expect(judge(after, COMMENT, { body: `\n**Approved** ${after.token}: preview-first.` }).records.map(r => `${r.citation}/${r.binding}`)).toEqual(['verified/token']);
    expect(judge(after, COMMENT, { body: `approve ${after.token}` }).records.map(r => r.citation)).toEqual(['verified']);
  });

  test('P1-2: only the first non-blank line counts: quoted, fenced, nested, listed, indented, commented and later-line approvals approve nothing', () => {
    const FENCE = '```';
    const none = (body: string) => expect(judge(after, COMMENT, { body }).records, body).toEqual([]);
    none(`> Approved ${after.token}`);
    none(`> Approved ${after.token}\n\nI do not approve this change. That quoted approval is only the text you asked me to post.`);
    none(`Do not approve this change. This is only an example of the requested syntax:\n\n${FENCE}text\nApproved ${after.token}\n${FENCE}`);
    none(`~~~~\nApproved ${after.token}\n~~~\nstill inside the fence\n~~~~`);
    none(`Example:\n\n    Approved ${after.token}`);
    none(`<!-- Approved ${after.token} -->\nNot yet.`);
    none(`<!--\nApproved ${after.token}\n-->`);
    none(`- > Approved ${after.token}`);
    none(`Do not approve this change. This list contains an example only:\n\n- ${FENCE}text\n  Approved ${after.token}\n  ${FENCE}`);
    none(`> Example syntax, not approval:\nApproved ${after.token}\n\nI do not approve this change.`);
    none(`${FENCE}text\nexample\n${FENCE}\n\nApproved ${after.token}: preview-first.`);
    none(`Context first.\n**Approved** ${after.token}: preview-first.`);
    none(`Looks right to me.\n\nApproved ${after.token}`);
    none(`- approve ${after.token}`);
    none(`1. Approved ${after.token}`);
    none(` Approved ${after.token}`);
    const ok = (body: string) => expect(judge(after, COMMENT, { body }).records.map(r => `${r.citation}/${r.binding}`), body).toEqual(['verified/token']);
    ok(`Approved ${after.token}`);
    ok(`**Approved** ${after.token}`);
    ok(`\n\nApproved ${after.token}: preview-first.`);
  });

  test('P1-2: only an APPROVED review counts, and it still needs an approval line naming the scope', () => {
    for (const state of ['COMMENTED', 'DISMISSED', 'PENDING']) {
      const r = judge(after, REVIEW, { state, body: `Approved ${after.token}` });
      expect(r.records).toEqual([]);
      expect(r.missing[0]!.reasons[0]).toContain(`is a ${state.toLowerCase()} review; only an APPROVED review counts`);
    }
    expect(judge(after, REVIEW, { state: 'APPROVED', body: `Approved ${after.token}` }).records.map(r => `${r.citation}/${r.binding}/${r.evidence}`)).toEqual(['verified/token/review by garrytan']);
    expect(judge(after, REVIEW, { state: 'APPROVED', body: `LGTM ${after.token}` }).records).toEqual([]);
  });

  test('P1-3: a stale explicit token is not approval and never falls back to the class and paths; untokened class and paths still bind', () => {
    const approval = `Approved ${before.token} (src/repair.ts).`;
    expect(judge(before, COMMENT, { body: approval }).records.map(r => r.binding)).toEqual(['token']);
    const stale = judge(after, COMMENT, { body: approval });
    expect(stale.records).toEqual([]);
    expect(stale.missing[0]!.reasons[0]).toContain(`names ${before.token}, not the current ${after.token}; a token is authoritative`);
    expect(judge(after, COMMENT, { body: `Approved data-repair@${before.digest} and ${after.token}` }).records.map(r => r.binding)).toEqual(['token']);
    expect(judge(after, COMMENT, { body: 'Approved data-repair for src/repair.ts: preview-first.' }).records.map(r => r.binding)).toEqual(['paths']);
  });

  function defaultRepo(): FixtureRepo {
    const repo = classRepo();
    commit(repo, { 'src/config.ts': 'export const DEFAULT_TOKENMAX = true;\n' });
    return repo;
  }
  const refusedWithoutCitation = (repo: FixtureRepo, env: Record<string, string> = {}) => {
    const c = runBin(repo, 'gstack-approval-classes', ['check', '--base', 'main'], env);
    expect(c.status, c.err).toBe(EXIT.fail);
    expect(c.out).toMatch(/^APPROVAL_CLASS: default-change src\/config\.ts:1 \(pattern\)/m);
    const w = write(repo, '', [], env);
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toMatch(/default-change \(default-change@[0-9a-f]{12}; effects in src\/config\.ts\).*\(APPROVAL_CITATION_MISSING\)$/m);
  };

  test('P1-4: diff.external and a textconv driver cannot hide a declared pattern from check or the receipt', () => {
    const repo = defaultRepo();
    repo.git('config', 'diff.external', '/bin/true');
    refusedWithoutCitation(repo);
    repo.git('config', '--unset', 'diff.external');
    fs.writeFileSync(path.join(repo.work, '.git', 'info', 'attributes'), '*.ts diff=blank\n');
    repo.git('config', 'diff.blank.textconv', 'true');
    refusedWithoutCitation(repo);
  }, 30_000);

  test('P1-4: a content diff that is missing or disagrees with git\'s count fails closed with APPROVAL_SOURCE_UNAVAILABLE', () => {
    const repo = defaultRepo();
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const dir = path.join(repo.root, 'git-shim');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" --unified=0 "*) exit 0 ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${dir}:${process.env.PATH ?? ''}` };
    const c = runBin(repo, 'gstack-approval-classes', ['check', '--base', 'main'], env);
    expect(c.status).toBe(EXIT.refused);
    expect(c.err).toMatch(/the content diff for src\/config\.ts shows 0 added line\(s\) but git counts 1; the content diff could not be read, so nothing was checked.*\(APPROVAL_SOURCE_UNAVAILABLE\)$/m);
    const w = write(repo, '', [], env);
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toMatch(/\(APPROVAL_SOURCE_UNAVAILABLE\)$/m);
    expect(w.out).toBe('');
  }, 30_000);
});

