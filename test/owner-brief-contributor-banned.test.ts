/**
 * PR E3: the one-page owner brief and the draft-direction close
 * (`gstack-owner-brief`), contributor-PR mode detection
 * (`gstack-contributor-mode`, decision D10), banned terms
 * (`gstack-banned-terms`), and the `test_backend` config key behind the
 * doctor's `cores` row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addedLines, exampleBannedTermsJson, normalizeRules, renderBannedTerms, scanBannedTerms, validateBannedTerms } from '../lib/banned-terms';
import { CONTRIBUTOR_INSTRUCTIONS, detectContributorMode, renderDetection } from '../lib/contributor-mode';
import type { GateList } from '../lib/gate-list';
import { EXIT } from '../lib/headless-artifacts';
import { BRIEF_FILE, DRAFT_DIRECTION_PHRASE, closeDraftDirections, loadBriefInputs, renderBrief } from '../lib/owner-brief';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function bin(name: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('bun', [path.join(ROOT, 'bin', name), ...args], { cwd: opts.cwd ?? ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...opts.env } });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ── owner brief ─────────────────────────────────────────────────────────────

function gateRun(dir: string, o: { items?: number; decided?: Record<string, string>; urgent?: boolean } = {}): GateList {
  const n = o.items ?? 9;
  const items = Array.from({ length: n }, (_, i) => ({
    id: i === 0 ? 'p1' : `d${i}`, title: i === 0 ? 'Approve the plan' : `Taste decision ${i}`, kind: (i === 0 ? 'approval' : i % 3 === 0 ? 'approval' : 'auto') as 'auto' | 'approval',
    recommended: 'a', options: [{ key: 'a', text: `option a for ${i}` }, { key: 'b', text: `option b for ${i}` }],
  }));
  const gate: GateList = { schema_version: 1, run: 'run-1', gate_rev: 2, items };
  fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify(gate));
  const decisions = items.map(it => {
    const chosen = o.decided?.[it.id];
    return { schema_version: 1, run: 'run-1', id: `run-1-${it.id}`, label: it.id.toUpperCase(), title: it.title, options: ['a', 'b'], recommended: 'a', kind: it.kind, status: chosen ? 'answered' : 'pending', gate_rev: 2, chosen: chosen ?? null, answered_at: chosen ? '2026-10-10T12:00:00Z' : undefined };
  });
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), decisions.map(d => JSON.stringify(d)).join('\n') + '\n');
  const findings = [{ id: 'F1', severity: 'High', title: 'a finding', resolution: 'accepted' }, ...(o.urgent ? [{ id: 'F2', severity: 'Critical', title: 'token leak outside this plan', urgent: true, suggested_owner: 'platform' }] : [])];
  fs.writeFileSync(path.join(dir, 'findings.jsonl'), findings.map(f => JSON.stringify(f)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ required_phases: ['ceo', 'eng'], phases: { ceo: { closed_at: 'x' }, eng: { closed_at: 'y' } } }));
  return gate;
}

describe('owner brief', () => {
  test('one page: URGENT block first, plain summary, seven numbered decisions with defaults or pending, and the review-record pointer', () => {
    const dir = tmp('gstack-brief-');
    gateRun(dir, { urgent: true, decided: { d1: 'b' } });
    fs.writeFileSync(path.join(dir, 'review-record.md'), '## Review record\nlong\n');
    const loaded = loadBriefInputs(dir);
    if ('error' in loaded) throw new Error(loaded.error.message);
    const brief = renderBrief(loaded.inputs, { outDir: dir });
    const lines = brief.split('\n');
    expect(lines[0]).toBe('# /autoplan owner brief — run run-1 (gate_rev 2, page 1/2)');
    expect(brief.indexOf('## URGENT, outside this plan')).toBeLessThan(brief.indexOf('### Summary'));
    expect(brief).toContain('token leak outside this plan');
    expect(brief).toContain('2 review phases closed (ceo, eng); 2 findings (1 accepted into the plan).');
    expect(brief).toContain('9 decisions below: 6 take their default if you do not answer; 3 need your answer (3 still pending).');
    const numbered = lines.filter(l => /^\d+\. \[/.test(l));
    expect(numbered).toHaveLength(7);
    expect(numbered[0]).toContain('[p1]');
    expect(numbered[0]).toContain('→ pending until you answer');
    expect(numbered[1]).toContain('→ decided d1b on 2026-10-10');
    expect(numbered[2]).toContain('→ default d2a taken if unanswered');
    expect(brief).toContain('Full review: ' + path.join(dir, 'review-record.md'));
    expect(brief).toContain('--gate-rev 2');
    expect(renderBrief(loaded.inputs, { page: 2 }).split('\n').filter(l => /^\d+\. \[/.test(l))).toHaveLength(2);
    expect(renderBrief(loaded.inputs, { summary: 'Owner-written summary.' })).toContain('Owner-written summary.');
  });

  test('the bin renders, defaults to <dir>/summary.md, writes brief.md with --write, and refuses when an input is missing', () => {
    const dir = tmp('gstack-brief-bin-');
    gateRun(dir);
    fs.writeFileSync(path.join(dir, 'summary.md'), 'Three sentences the run wrote.\n');
    const r = bin('gstack-owner-brief', ['render', '--out', dir, '--write']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('Three sentences the run wrote.');
    expect(fs.readFileSync(path.join(dir, BRIEF_FILE), 'utf8')).toBe(r.out);
    const json = bin('gstack-owner-brief', ['render', '--out', dir, '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ run: 'run-1', gate_rev: 2, items: 9 });
    fs.rmSync(path.join(dir, 'decisions.jsonl'));
    const missing = bin('gstack-owner-brief', ['render', '--out', dir]);
    expect(missing.status).toBe(EXIT.refused);
    expect(missing.err).toContain('BRIEF_INPUT_MISSING');
  });

  test('close rewrites decided draft-direction lines to the option and date, leaves pending ones and reports them', () => {
    const dir = tmp('gstack-brief-close-');
    gateRun(dir, { decided: { d1: 'b', p1: 'a' } });
    const loaded = loadBriefInputs(dir);
    if ('error' in loaded) throw new Error(loaded.error.message);
    const plan = [
      '# Plan',
      `- d1: cache layer — ${DRAFT_DIRECTION_PHRASE}.`,
      `- d2: naming — ${DRAFT_DIRECTION_PHRASE}.`,
      `- overall ${DRAFT_DIRECTION_PHRASE} (no id here, falls to the plan approval).`,
      '- unrelated line',
    ].join('\n');
    const r = closeDraftDirections(plan, loaded.inputs, '2026-10-10');
    expect(r.rewrites.map(x => [x.line, x.id, x.status])).toEqual([[2, 'd1', 'rewritten'], [3, 'd2', 'pending'], [4, 'p1', 'rewritten']]);
    expect(r.text.split('\n')[1]).toBe('- d1: cache layer — decided d1b (2026-10-10): option b for 1.');
    expect(r.text.split('\n')[2]).toBe(`- d2: naming — ${DRAFT_DIRECTION_PHRASE}.`);
    expect(r.text.split('\n')[3]).toContain('decided p1a (2026-10-10): option a for 0');
    expect(r.unresolved.map(x => x.id)).toEqual(['d2']);
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, plan);
    const closed = bin('gstack-owner-brief', ['close', '--out', dir, '--plan', file, '--date', '2026-10-10']);
    expect(closed.status).toBe(EXIT.fail);
    expect(closed.out).toContain('DRAFT_DIRECTIONS: rewritten=2 unresolved=1');
    expect(closed.err).toContain('DRAFT_DIRECTION_UNRESOLVED');
    expect(fs.readFileSync(file, 'utf8')).toContain('decided d1b (2026-10-10)');
  });
});

// ── contributor mode ────────────────────────────────────────────────────────

describe('contributor mode', () => {
  test('an explicit maintainers list decides without the network; an empty list falls to push permission; nothing available is off with the source recorded', () => {
    const cwd = ROOT;
    const policy = detectContributorMode({ cwd, author: 'outsider', maintainers: ['garrytan'], policySource: '.gstack/ship-policy.json@origin/main', resolvePermission: () => { throw new Error('must not be called'); } });
    expect(policy).toMatchObject({ mode: 'on', source: 'policy', author: 'outsider' });
    expect(detectContributorMode({ cwd, author: 'GarryTan', maintainers: ['garrytan'], policySource: 'x', resolvePermission: () => { throw new Error('no'); } }).mode).toBe('off');
    const collaborators = detectContributorMode({ cwd, author: 'someone', maintainers: [], policySource: 'x', resolvePermission: () => ({ permission: 'read' }) });
    expect(collaborators).toMatchObject({ mode: 'on', source: 'collaborators', permission: 'read' });
    expect(detectContributorMode({ cwd, author: 'someone', maintainers: [], policySource: 'x', resolvePermission: () => ({ permission: 'write' }) }).mode).toBe('off');
    const unavailable = detectContributorMode({ cwd, author: 'someone', maintainers: [], policySource: 'x', resolvePermission: () => ({ error: 'gh offline' }) });
    expect(unavailable).toMatchObject({ mode: 'off', source: 'off', error: { code: 'CONTRIBUTOR_SOURCE_UNAVAILABLE' } });
    const noAuthor = detectContributorMode({ cwd, maintainers: [], policySource: 'x', resolveAuthor: () => ({ error: 'no PR' }) });
    expect(noAuthor.mode).toBe('off');
    expect(noAuthor.error?.code).toBe('CONTRIBUTOR_SOURCE_UNAVAILABLE');
    const forced = detectContributorMode({ cwd, maintainers: [], policySource: 'x', force: true, resolveAuthor: () => ({ error: 'no PR' }) });
    expect(forced).toMatchObject({ mode: 'on', source: 'flag' });
    expect(renderDetection(collaborators)).toMatch(/^CONTRIBUTOR_MODE: on author=someone source=collaborators permission=read — /);
  });

  test('the instructions are evidence-first: the table, the three decisions, and credit lines only when evidence carried over; CODEOWNERS is never consulted', () => {
    for (const term of ['| Change | Evidence value | Risk surfaces | Decision |', 'accept', 'supersede', 'decline', 'Contributed by @<handle>', 'Co-Authored-By:', 'Supersedes #<n>', 'plain-language approval']) expect(CONTRIBUTOR_INSTRUCTIONS).toContain(term);
    expect(CONTRIBUTOR_INSTRUCTIONS).toContain('never a higher one');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'contributor-mode.ts'), 'utf8') + fs.readFileSync(path.join(ROOT, 'bin', 'gstack-contributor-mode'), 'utf8');
    expect(src).not.toMatch(/CODEOWNERS['"`)]/);
    expect(src).toContain('writeReceipt(');
    const r = bin('gstack-contributor-mode', ['instructions']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out.trim()).toBe(CONTRIBUTOR_INSTRUCTIONS);
    const forced = bin('gstack-contributor-mode', ['detect', '--contributor', '--author', 'x']);
    expect(forced.out.split('\n')[0]).toMatch(/^CONTRIBUTOR_MODE: on author=x source=flag/);
    expect(forced.out).toContain('CONTRIBUTOR-PR MODE');
  });
});

// ── banned terms ────────────────────────────────────────────────────────────

describe('banned terms', () => {
  test('the example validates; unknown keys, empty terms and escaping globs are BANNED_TERMS_INVALID', () => {
    expect(validateBannedTerms(JSON.parse(exampleBannedTermsJson()))).toEqual([]);
    expect(validateBannedTerms({ terms: ['x'], bogus: 1 }).map(e => e.path)).toEqual(['bogus']);
    expect(validateBannedTerms({ terms: [] }).length).toBeGreaterThan(0);
    expect(validateBannedTerms({ terms: ['x'], allowed_paths: ['../outside/**'] }).map(e => e.code)).toEqual(['BANNED_TERMS_INVALID']);
    expect(validateBannedTerms({ terms: [{ term: 'legacy', allowed_paths: ['/abs/path'] }] }).map(e => e.code)).toEqual(['BANNED_TERMS_INVALID']);
    expect(validateBannedTerms('nope')[0]!.message).toContain('JSON object');
  });

  test('added lines are scanned per term outside its allowed locations; findings name the term, file:line and the allowed paths', () => {
    const config = { terms: ['blazing fast', { term: 'OldName', allowed_paths: ['CHANGELOG.md', 'docs/migration/**'], reason: 'renamed' }], allowed_paths: ['docs/glossary.md'] };
    expect(normalizeRules(config).map(r => r.allowed_paths)).toEqual([['docs/glossary.md'], ['docs/glossary.md', 'CHANGELOG.md', 'docs/migration/**']]);
    const diff = [
      'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1,2 +1,4 @@', ' intro', '+It is blazing fast.', '+OldName lives on here.', '-gone', ' tail',
      'diff --git a/docs/migration/v2.md b/docs/migration/v2.md', '--- /dev/null', '+++ b/docs/migration/v2.md', '@@ -0,0 +1 @@', '+OldName became NewName.',
      'diff --git a/docs/glossary.md b/docs/glossary.md', '--- a/docs/glossary.md', '+++ b/docs/glossary.md', '@@ -1 +1 @@', '+blazing fast: a banned phrase',
      'diff --git a/.gstack/banned-terms.json b/.gstack/banned-terms.json', '--- a/.gstack/banned-terms.json', '+++ b/.gstack/banned-terms.json', '@@ -1 +1 @@', '+"blazing fast"',
    ].join('\n');
    const added = addedLines(diff);
    expect([...added.keys()]).toEqual(['README.md', 'docs/migration/v2.md', 'docs/glossary.md', '.gstack/banned-terms.json']);
    expect(added.get('README.md')!.map(l => l.line)).toEqual([2, 3]);
    const r = scanBannedTerms(config, 'test', added);
    expect(r.findings.map(f => [f.term, `${f.file}:${f.line}`])).toEqual([['blazing fast', 'README.md:2'], ['OldName', 'README.md:3']]);
    expect(r.skipped).toEqual(['.gstack/banned-terms.json']);
    const text = renderBannedTerms(r);
    expect(text).toContain('BANNED_TERM: "OldName" README.md:3 allowed: docs/glossary.md, CHANGELOG.md, docs/migration/** (renamed)');
    expect(text.trim().split('\n').pop()).toBe('BANNED_TERMS: found=2 terms=2 files=4 source=test');
    expect(scanBannedTerms({ terms: ['Blazing'], allowed_paths: [] }, 'x', added).findings.map(f => f.file)).toEqual(['README.md', 'docs/glossary.md']);
  });

  test('the bin: `none` without a list (exit 0), findings on --files (exit 1), init and validate', () => {
    const repo = tmp('gstack-banned-repo-');
    const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    fs.writeFileSync(path.join(repo, '.gitconfig'), '[user]\n\tname = t\n\temail = t@test\n[init]\n\tdefaultBranch = main\n');
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    const none = bin('gstack-banned-terms', ['check', '--files', 'README.md'], { cwd: repo });
    expect(none.status).toBe(EXIT.ok);
    expect(none.out).toContain('BANNED_TERMS: none');
    const init = bin('gstack-banned-terms', ['init'], { cwd: repo });
    expect(init.status).toBe(EXIT.ok);
    expect(bin('gstack-banned-terms', ['validate'], { cwd: repo }).status).toBe(EXIT.ok);
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\nblazing fast\n');
    const found = bin('gstack-banned-terms', ['check', '--files', 'README.md', '--policy-from', 'head'], { cwd: repo });
    expect(found.status).toBe(EXIT.fail);
    expect(found.out).toContain('BANNED_TERM: "blazing fast" README.md:2');
    fs.writeFileSync(path.join(repo, '.gstack', 'banned-terms.json'), '{"terms": ["x"], "nope": true}\n');
    const invalid = bin('gstack-banned-terms', ['validate'], { cwd: repo });
    expect(invalid.status).toBe(EXIT.refused);
    expect(invalid.err).toContain('BANNED_TERMS_INVALID');
  });
});

// ── test_backend ────────────────────────────────────────────────────────────

describe('test_backend config', () => {
  test('defaults to local, accepts only local|ubicloud, and the doctor cores row names the remote gate under 8 cores', () => {
    const state = tmp('gstack-test-backend-');
    const cfg = (...args: string[]) => { const r = spawnSync(path.join(ROOT, 'bin', 'gstack-config'), args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_HOME: state } }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' }; };
    expect(cfg('get', 'test_backend')).toMatchObject({ code: 0, out: 'local' });
    expect(cfg('set', 'test_backend', 'ubicloud').code).toBe(0);
    expect(cfg('get', 'test_backend').out).toBe('ubicloud');
    expect(cfg('set', 'test_backend', 'mars').code).not.toBe(0);
    expect(cfg('get', 'test_backend').out).toBe('ubicloud');
    expect(cfg('defaults').out).toContain('test_backend');
    const doctor = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-doctor-check.sh'), 'utf8');
    expect(doctor).toContain('gstack-config" get test_backend');
    expect(doctor).toContain('set gstack-config set test_backend ubicloud, scripts/ubicloud/ubi-runner.sh');
  });
});
