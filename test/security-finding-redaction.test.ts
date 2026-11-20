/**
 * Security findings stay out of public text (GST-3076): a PR body, its receipt block and every line gstack prints for one
 * carry no finding location (`path:line`) and no reason when the finding is security class (category security, auth,
 * secret or red-team). The public form is an opaque id and "security finding, details recorded privately"; the fingerprint
 * and reason stay in the private approval record or the local review files. Every other finding prints as before.
 * Synthetic fixtures only.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderRecord, type ApprovalRow, type ReadResult, type StoreLocation } from '../lib/approval-record';
import { EXIT } from '../lib/headless-artifacts';
import { gateDispositionText, type GateDisposition } from '../lib/gate-dispositions';
import { EXIT as POST_EXIT, runPost, type PostEnv } from '../lib/gstack-post';
import { deferredRecord, renderDeferredSection } from '../lib/review-scope';
import { ruledNoteRow, ruledNoteText, type RuledNote } from '../lib/ruled-notes';
import { securityFingerprints } from '../lib/security-findings';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const HEAD = 'c0ffee0000000000000000000000000000000001';
const SECRET_REASON = 'session token logged by the retry handler';
const SEC = 'src/net/retry.ts:42:security';
const note = (finding: string, reason: string): RuledNote => ({ finding, head: HEAD, by: 'Fixture Owner', reason, at: '2026-11-18T00:00:00Z', approval: 'a-0123456789ab' });
const leaks = (text: string, where: string, reason: string) => [text.includes(where), text.includes(reason)];

// Value: protects=a ruled security finding's location and reason never reach a public line (GST-3076, a public repo's PR body
//   showed file:line:security and why it was left); fails_when=ruledNoteText prints the fingerprint or reason of a security,
//   auth, secret or red-team finding, or changes a non-security line; seam=the one renderer every Ruled note line goes through
describe('ruled notes', () => {
  test('a security-class ruling prints an opaque id and the private-record phrase; other rulings print as before', () => {
    for (const cat of ['security', 'auth', 'secret', 'red-team']) {
      const line = ruledNoteText(note(`src/net/retry.ts:42:${cat}`, SECRET_REASON));
      expect(leaks(line, 'src/net/retry.ts', SECRET_REASON)).toEqual([false, false]);
      expect(line).toBe('redacted at c0ffee000000 ruled by Fixture Owner at 2026-11-18T00:00:00Z: security finding, details recorded privately (approval a-0123456789ab)');
    }
    expect(ruledNoteText(note('src/x.ts:1:naming', 'naming ships as a note'))).toBe('src/x.ts:1:naming at c0ffee000000 ruled by Fixture Owner at 2026-11-18T00:00:00Z: naming ships as a note (approval a-0123456789ab)');
  });
});

// Value: protects=a gate disposition on a security finding shows no location, reason or owner words, and the lander's
//   receipt-vs-store comparison still matches; fails_when=the line carries them, or a non-security line changes;
//   seam=gateDispositionText
describe('gate dispositions', () => {
  test('a security-class disposition is redacted; another prints as before', () => {
    const d = (finding: string): GateDisposition => ({ finding, gate_id: '69c7c3432501', head: HEAD, by: 'Fixture Owner', reason: SECRET_REASON, words: 'ship it, the token path is next', at: '2026-11-18T00:00:00Z', approval: 'a-0123456789ab' });
    const sec = gateDispositionText(d(SEC));
    expect([...leaks(sec, 'src/net/retry.ts', SECRET_REASON), sec.includes('token path')]).toEqual([false, false, false]);
    expect(sec).toContain('security finding, details recorded privately');
    expect(gateDispositionText(d('tests/b.test.ts:3:gate-integrity'))).toBe('tests/b.test.ts:3:gate-integrity [gate 69c7c3432501] at c0ffee000000 by Fixture Owner at 2026-11-18T00:00:00Z: session token logged by the retry handler — "ship it, the token path is next" (approval a-0123456789ab)');
  });
});

// Value: protects=a deferred or noted security finding in code the PR did not change (a live exposure out of scope) is listed
//   without its path or summary; fails_when=the PR-body section names either, or a non-security line changes; seam=renderDeferredSection
describe('deferred findings and review notes', () => {
  test('security-class entries are redacted to an opaque id; others print as before', () => {
    const out = renderDeferredSection(
      [{ fingerprint: SEC, path: 'src/net/retry.ts:42', severity: 'CRITICAL', summary: SECRET_REASON }, { fingerprint: 'src/a.ts:3:correctness', path: 'src/a.ts:3', severity: 'CRITICAL', summary: 'off by one' }],
      [{ fingerprint: 'src/auth/login.ts:9:auth', path: 'src/auth/login.ts', line: 9, severity: 'INFORMATIONAL', category: 'auth', summary: 'cookie lacks SameSite' }, { path: 'src/b.ts', line: 2, severity: 'INFORMATIONAL', category: 'security', summary: 'unescaped echo' }, { path: 'src/c.ts', line: 4, severity: 'INFORMATIONAL', category: 'naming', summary: 'rename x' }],
    );
    for (const s of ['src/net/retry.ts', SECRET_REASON, 'src/auth/login.ts', 'SameSite', 'src/b.ts', 'unescaped echo']) expect([s, out.includes(s)]).toEqual([s, false]);
    expect(out.match(/`sf-[0-9a-f]{12}` security finding, details recorded privately/g)?.length).toBe(3);
    expect(out).toContain('- Deferred: CRITICAL `src/a.ts:3` off by one');
    expect(out).toContain('- INFORMATIONAL `src/c.ts:4` rename x');
  });

  test('a lineless security fingerprint and a security reviewer\'s other category are redacted when deferred', () => {
    const f = { severity: 'CRITICAL', path: 'src/a.ts', line: 7, category: 'injection', specialist: 'security', summary: SECRET_REASON, scope: 'defer' as const, locus: 'outside' as const, kind: 'defect' as const, blocking: true };
    const out = renderDeferredSection([JSON.parse(JSON.stringify(deferredRecord(f))), { fingerprint: 'src/x.ts::auth', path: 'src/x.ts', severity: 'CRITICAL', summary: 'cookie lacks SameSite' }]);
    for (const s of ['src/a.ts', 'src/x.ts', SECRET_REASON, 'SameSite']) expect([s, out.includes(s)]).toEqual([s, false]);
    expect(ruledNoteText(note('src/x.ts::security', SECRET_REASON))).not.toContain('src/x.ts');
  });
});

// Value: protects=the whole path on a synthetic public repository: gstack-approvals rule, rulings, receipt write and the receipt
//   block keep a security ruling's fingerprint and reason out, the private record keeps them, and write refuses a body that
//   pastes a raw security fingerprint; fails_when=any public output carries them or the record loses them;
//   seam=gstack-approvals rule|rulings|list and gstack-ship-receipt write
describe('a security ruling on a public repository', () => {
  test.skipIf(process.platform === 'win32')('nothing public names the finding; the private record still does', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    ships.push(f);
    const gh = path.join(f.root, 'stub', 'gh');
    fs.writeFileSync(gh, '#!/bin/sh\ncase "$*" in *visibility*) echo PUBLIC ;; *) exit 1 ;; esac\n', { mode: 0o755 });
    const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const ruled = run('gstack-approvals', ['rule', '--finding', 'src/x.ts:1:security', '--head', head, '--reason', SECRET_REASON, '--words', 'note it', '--by', 'Fixture Owner']);
    expect(ruled.status, ruled.stderr).toBe(0);
    expect(leaks(ruled.stdout + ruled.stderr, 'src/x.ts:1', SECRET_REASON)).toEqual([false, false]);
    const rulings = run('gstack-approvals', ['rulings']);
    const line = rulings.stdout.trim();
    expect([line.startsWith('Ruled note: redacted at '), ...leaks(line, 'src/x.ts:1', SECRET_REASON)]).toEqual([true, false, false]);
    const rendered = run('gstack-approvals', ['render']).stdout;
    expect(leaks(rendered, 'src/x.ts:1', SECRET_REASON)).toEqual([false, false]);
    expect(leaks(run('gstack-approvals', ['list']).stdout, 'src/x.ts:1:security', SECRET_REASON)).toEqual([true, true]);
    const body = path.join(f.root, 'body.md');
    const write = () => f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], { GSTACK_APPROVALS_MIRROR: '0' });
    fs.writeFileSync(body, `## Pre-Landing Review\n\n${line}\nLeft open: src/x.ts:1:security\n`);
    const pasted = write();
    expect([pasted.status, pasted.stderr]).toEqual([EXIT.fail, expect.stringContaining('src/x.ts:1:security')]);
    fs.writeFileSync(body, `## Pre-Landing Review\n\n${line}\n`);
    const ok = write();
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    expect(leaks(ok.stdout, 'src/x.ts:1', SECRET_REASON)).toEqual([false, false]);
  });
});

// Value: protects=gstack-post never sends a body that carries a raw security fingerprint to GitHub; fails_when=it posts one,
//   or refuses a body with a non-security fingerprint; seam=runPost before any gh call
describe('gstack-post', () => {
  const post = (body: string) => {
    const calls: string[][] = [], err: string[] = [];
    const env: PostEnv = {
      run(cmd, args) {
        calls.push([cmd, ...args]);
        if (cmd === 'git' && args[0] === 'remote') return { status: 0, stdout: 'git@github.com:acme/widget.git\n', stderr: '' };
        if (cmd === 'cfg') return { status: 0, stdout: 'public\n', stderr: '' };
        return { status: cmd === 'git' ? 1 : 0, stdout: '', stderr: '' };
      },
      readFile: () => body, out: () => {}, err: t => { err.push(t); },
    };
    return { code: runPost(['pr-comment', '7', '--body-file', 'b.md'], env, 'cfg'), posted: calls.some(c => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'comment'), err: err.join('') };
  };
  test('a raw security fingerprint is refused; another fingerprint posts', () => {
    const sec = post('Left open: `src/net/retry.ts:42:security`.\n');
    expect([sec.code, sec.posted, sec.err]).toEqual([POST_EXIT.refused, false, expect.stringContaining('security finding')]);
    const other = post('Left open: `src/a.ts:3:naming`.\n');
    expect([other.code, other.posted]).toEqual([POST_EXIT.posted, true]);
    expect(post('Left open: `src/x.ts:4:Auth`.\n').posted).toBe(false);
    expect(post('Moves the check into `crate::auth`.\n').posted).toBe(true);
  });
});

// Value: protects=a private repository's full Approvals table (the one /ship puts in the PR body) shows a security ruling
//   without its fingerprint or reason, so receipt write's guard does not refuse that standard body; fails_when=the full table
//   prints the raw ask or scope of a security ruled_note row, or changes another row; seam=renderRecord full mode
describe('the full approvals table', () => {
  test('a security ruling row is redacted in full mode; another row prints as before', () => {
    const row = (finding: string, reason: string): ApprovalRow => ({ schema_version: 1, id: 'a-0123456789ab', date: '2026-11-18', ...ruledNoteRow(finding, HEAD, reason), words: 'note it', by: 'Fixture Owner', outcome: 'approved', pending: '', source: '', branch: 'feat', recorded_at: '2026-11-18T00:00:00Z' } as ApprovalRow);
    const read = { rows: [row(SEC, SECRET_REASON), row('src/x.ts:1:naming', 'naming ships as a note')], state: 'ok' } as unknown as ReadResult;
    const out = renderRecord(read, { branch: 'feat', file: 'f' } as StoreLocation, { mode: 'full' });
    expect([...leaks(out, 'src/net/retry.ts', SECRET_REASON), securityFingerprints(out)]).toEqual([false, false, []]);
    expect(out).toContain(`ruled_note redacted at ${HEAD}: security finding, details recorded privately`);
    expect(out).toContain(`ruled_note src/x.ts:1:naming at ${HEAD}: naming ships as a note`);
  });
});

// Value: protects=a red-team finding the owner ruled not security class (gstack-evals #380: a statistics fix) shows its location
//   and reason in public text, the receipt validates and the public-text guards pass it, while security, auth and secret
//   findings cannot take the exemption; fails_when=every red-team ruling prints "security finding, details recorded privately",
//   or the exemption reaches a security-category finding; seam=gstack-approvals rule|rulings and gstack-ship-receipt write
describe('a red-team finding the owner ruled not security class (gstack-evals #380)', () => {
  test.skipIf(process.platform === 'win32')('rule --not-security prints the finding; a security category refuses the flag', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    ships.push(f);
    fs.writeFileSync(path.join(f.root, 'stub', 'gh'), '#!/bin/sh\ncase "$*" in *visibility*) echo PUBLIC ;; *) exit 1 ;; esac\n', { mode: 0o755 });
    const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const reason = 'the routing pilot picks its four extra tasks before the seed is fixed';
    const rule = (finding: string, extra: string[]) => run('gstack-approvals', ['rule', '--finding', finding, '--head', head, '--reason', reason, '--words', 'a note, fix it by a dated change', '--by', 'Fixture Owner', ...extra]);
    expect(rule('src/x.ts:1:security', ['--not-security']).status).toBe(EXIT.usage);
    const marker = path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    fs.writeFileSync(marker, 'ship-run-1\n');
    const inRun = rule('src/x.ts:2:red-team', ['--not-security', '--owner-ref', 'GSTA-36:2026-11-19T12:29:59Z']);
    expect(inRun.status).toBe(EXIT.usage);
    expect(inRun.stderr).toContain('--not-security');
    fs.rmSync(marker);
    expect(run('gstack-approvals', ['rulings']).stdout).not.toContain('src/x.ts:2');
    const ruled = rule('src/x.ts:1:red-team', ['--not-security']);
    expect(ruled.status, ruled.stderr).toBe(0);
    const line = run('gstack-approvals', ['rulings']).stdout.trim();
    expect(line).toStartWith(`Ruled note: src/x.ts:1 (red-team, ruled not security class) at ${head.slice(0, 12)} ruled by Fixture Owner at `);
    expect(line).toContain(reason);
    expect(securityFingerprints(line)).toEqual([]);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, `## Pre-Landing Review\n\n${line}\n`);
    const write = f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], { GSTACK_APPROVALS_MIRROR: '0' });
    expect(write.status, write.stderr).toBe(EXIT.ok);
    expect(fs.readFileSync(body, 'utf8')).toContain('"not_security": true');
  });
});

