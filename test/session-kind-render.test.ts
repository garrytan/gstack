/**
 * Unattended render (GST-825): `--session-kind unattended` drops interactive
 * ceremony from every always-loaded SKILL.md while interactive renders keep
 * their bytes, /ship keeps the whole receipt path, and the receipt an
 * unattended run writes still passes `gstack-ship-queue ready` and
 * `train build`. Also the `gstack-skill-start --render unattended` contract.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { modulesMain } from '../scripts/modules-cli';
import { LOCK_FILE, renderLoadout, type LoadoutLock } from '../scripts/modules-render';
import { applySessionGuards } from '../scripts/resolvers/unattended';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { cleanup, runBin } from './helpers/restamp-fixture';
import { GREEN_GATE, dispatches, line, openPr, queue, readyReceipt, setPrBody, trainFixture, type TrainFixture } from './helpers/ship-queue-train-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-kind-'));
const arm = (name: string) => path.join(tmp, name);
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf-8');
const lock = (dir: string) => JSON.parse(read(dir, LOCK_FILE)) as LoadoutLock;
/** A file with its own out-dir written as <OUT>: section links name the render's final path. */
const portable = (dir: string, rel: string) => read(dir, rel).replaceAll(dir, '<OUT>');
const skillFiles = (dir: string) => fs.readdirSync(dir, { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).map(e => `${e.name}/SKILL.md`).concat('SKILL.md').sort();

/** Ceremony an unattended always-loaded body must not carry. /learn and /plan-tune exist to run learnings and question tuning. */
const CEREMONY = /gstack-question-log|gstack-question-preference --write|gstack-skill-end|gstack-learnings-log|gstack-learnings-search|^## (Question Tuning|Telemetry \(run last\)|Prior Learnings|Capture Learnings|Shared preamble \(load first\)|Search Before Building|Repo Ownership.*|Plan Mode Safe Operations|Skill Invocation During Plan Mode|Operational Self-Improvement|Voice|AskUserQuestion Format|Writing Style|Context Recovery|Step 3\.4: Workspace-aware queue status.*)$/m;
const CEREMONY_OWNERS = new Set(['learn/SKILL.md', 'plan-tune/SKILL.md']);

/** Step numbers a body names that no heading in it defines. */
function danglingSteps(body: string): Set<string> {
  const defined = new Set([...body.matchAll(/^#{2,4} Step (\d+(?:\.\d+)*)\b/gm)].map(m => m[1]));
  return new Set([...body.matchAll(/\bSteps? (\d+(?:\.\d+)*)\b/g)].map(m => m[1]).filter(n => !defined.has(n)));
}

beforeAll(async () => {
  await renderLoadout({ host: 'claude', selection: null, outDir: arm('default') });
  await renderLoadout({ host: 'claude', selection: null, outDir: arm('interactive'), sessionKind: 'interactive' });
  await renderLoadout({ host: 'claude', selection: null, outDir: arm('unattended'), sessionKind: 'unattended' });
}, 600_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('session-kind renders', () => {
  test('interactive is the default render byte for byte, and only unattended carries its own spec hash', () => {
    const [plain, interactive, unattended] = [lock(arm('default')), lock(arm('interactive')), lock(arm('unattended'))];
    expect(interactive.files.map(f => f.path)).toEqual(plain.files.map(f => f.path));
    for (const { path: rel } of plain.files.filter(f => f.path !== LOCK_FILE)) expect([rel, portable(arm('interactive'), rel) === portable(arm('default'), rel)]).toEqual([rel, true]);
    expect([plain.session_kind, plain.spec, plain.spec_sha256]).toEqual(['interactive', 'full', null]);
    expect(unattended.session_kind).toBe('unattended');
    expect(unattended.spec).toBe('full@unattended');
    expect(unattended.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(unattended.total_bytes).toBeLessThan(plain.total_bytes);
  });

  test('no unattended always-loaded body carries ceremony, every one is marked, and none names a step it lost', () => {
    const interactive = arm('interactive');
    const unattended = arm('unattended');
    const sizes: string[] = [];
    for (const rel of skillFiles(unattended)) {
      const body = read(unattended, rel);
      const before = read(interactive, rel);
      expect(body).toContain('<!-- session-kind: unattended -->\n');
      if (!CEREMONY_OWNERS.has(rel)) expect([rel, body.match(CEREMONY)?.[0] ?? null]).toEqual([rel, null]);
      if (before.includes('gstack-skill-start --skill')) {
        expect(body).toMatch(/gstack-skill-start --skill "[a-z0-9-]+" --model "[^"]+" --render unattended\n/);
        expect(body).toContain('## Unattended rules');
        expect(body).toContain('## Completion Status Protocol');
        expect(body.length).toBeLessThan(before.length);
      }
      const lost = [...danglingSteps(body)].filter(n => !danglingSteps(before).has(n));
      expect([rel, lost]).toEqual([rel, []]);
      sizes.push(`${rel} ${before.length} -> ${body.length}`);
    }
    console.log(sizes.join('\n'));
  });

  test('/review keeps its review-record contract, /investigate keeps Scope Lock, /ship keeps every receipt step', () => {
    const dir = arm('unattended');
    const review = read(dir, 'review/SKILL.md');
    for (const kept of ['## Step 5.8: Persist Eng Review result', '\`COMPLETED\`', '\`CONVERGED\`', 'gstack-review-log --start review', 'State INCOMPLETE if']) expect(review).toContain(kept);
    expect(review).not.toContain('gstack-next-version');
    const investigate = read(dir, 'investigate/SKILL.md');
    expect(investigate).toContain('## Scope Lock');
    expect(investigate).toContain('freeze-state.sh" acquire');
    expect(investigate).not.toContain('Refresh learnings');
    expect(investigate).toContain('## Web research runs in Aside\n\nUnattended runs do not drive the Aside browser');
    const ship = read(dir, 'ship/SKILL.md');
    for (const kept of ['## Step 11.5: Bind the reviews', '## Step 20: Persist ship metrics', '## Step 22: Terminal line (every run)', 'gstack-ship-receipt result --pr <pr-number>']) expect(ship).toContain(kept);
    expect(ship).not.toContain('## Step 21');
    expect(read(dir, 'ship/sections/pr-body.md')).toContain('gstack-ship-receipt write --pr <pr-number> --base <base>');
    expect(read(dir, 'ship/sections/handoff.md')).toContain('gstack-ship-receipt write --base <base>');
    expect(read(dir, 'ship/sections/review-army.md')).toContain('gstack-review-log --start review');
    for (const rel of ['ship/sections/review-army.md', 'ship/sections/pr-body.md', 'ship/sections/handoff.md', 'ship/sections/changelog.md']) expect([rel, portable(dir, rel) === portable(arm('interactive'), rel)]).toEqual([rel, true]);
    for (const rel of ['ship/sections/adversarial.md', 'ship/sections/plan-completion.md']) {
      const kept = portable(dir, rel).split('\n');
      const removed = portable(arm('interactive'), rel).split('\n');
      for (const l of kept) removed.splice(removed.indexOf(l), 1);
      expect([rel, kept.length > 0, removed.some(l => /gstack-review-log|gstack-ship-receipt|review_binding/.test(l))]).toEqual([rel, true, false]);
      expect([rel, removed.find(l => l.startsWith('## ') && !/^## (Prior|Capture) Learnings$/.test(l)) ?? null]).toEqual([rel, null]);
    }
  });

  test('the codex render takes the same kind', async () => {
    const out = arm('codex');
    await renderLoadout({ host: 'codex', selection: null, outDir: out, model: 'gpt-6-astra', sessionKind: 'unattended' });
    const review = read(out, '.agents/skills/gstack-review/SKILL.md');
    expect(review).toContain('<!-- session-kind: unattended -->');
    expect(review).toMatch(/gstack-skill-start" --skill "review" --model "gpt-6-astra" --render unattended/);
    expect(review.slice(0, review.indexOf('## Step 0:'))).not.toMatch(CEREMONY);
    expect(review).not.toMatch(/^## (Question Tuning|Telemetry \(run last\)|Prior Learnings|Capture Learnings|Shared preamble \(load first\))$/m);
  }, 300_000);

  test('the committed tree refuses an unattended render and an unknown kind is refused by name', async () => {
    const run = (args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), path.join(ROOT, 'scripts/gen-skill-docs.ts'), ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 }).stdout;
    const inTree = run(['--host', 'claude', '--session-kind', 'unattended']);
    expect(inTree.status).not.toBe(0);
    expect(inTree.stderr).toContain('--session-kind unattended needs an --out-dir outside the checkout root');
    expect(run(['--host', 'claude', '--session-kind', 'headless', '--out-dir', arm('bad')]).stderr).toContain('Unknown session kind: headless');
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 }).stdout).toBe(before);
    const cli = await modulesMain(['render', '--host', 'claude', '--loadout', 'full', '--session-kind', 'spawned', '--out-dir', arm('bad')]);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toStartWith('MODULE_SPEC_INVALID: --session-kind takes interactive or unattended;');
  }, 300_000);

  test('IF_SESSION guards keep their text only for their own kind and refuse an unknown kind', () => {
    const ctx = (sessionKind?: 'unattended') => ({ skillName: 'x', tmplPath: 'x/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude, ...(sessionKind ? { sessionKind } : {}) }) as TemplateContext;
    const text = 'a\n{{IF_SESSION:interactive}}b\n{{/IF_SESSION}}{{IF_SESSION:unattended}}c\n{{/IF_SESSION}}d';
    expect(applySessionGuards(text, ctx())).toBe('a\nb\nd');
    expect(applySessionGuards(text, ctx('unattended'))).toBe('a\nc\nd');
    expect(() => applySessionGuards('{{IF_SESSION:spawned}}x{{/IF_SESSION}}', ctx())).toThrow('{{IF_SESSION:spawned}} names no session kind');
  });
});

describe('gstack-skill-start --render unattended', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-kind-home-'));
  const state = path.join(home, '.gstack');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\n');
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
  const env0 = { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_LEASE_DIR: path.join(state, 'leases') };
  const start = (args: string[], env: Record<string, string> = {}) => spawnSync(path.join(ROOT, 'bin', 'gstack-skill-start'), ['--skill', 'review', ...args], { cwd: home, encoding: 'utf-8', timeout: 30_000, env: { ...env0, ...env } });

  test('an unset, interactive or spawned environment runs as unattended and says so before the session lines', () => {
    for (const env of [{}, { GSTACK_SESSION_KIND: 'interactive' }, { GSTACK_SESSION_KIND: 'spawned' }] as Array<Record<string, string>>) {
      const r = start(['--render', 'unattended'], env);
      expect(r.status).toBe(0);
      const kind = env.GSTACK_SESSION_KIND ?? 'interactive';
      expect(r.stdout).toContain(`RENDER_KIND: unattended\nRENDER_KIND_MISMATCH: env=${kind}; this render runs as unattended\n`);
      expect(r.stdout).toContain('SESSION_KIND: unattended');
      expect(r.stdout).toContain('UNATTENDED_SESSION: true');
      expect(r.stdout).toMatch(/GSTACK_INSTRUCTION_BEGIN: unattended-session /);
      expect(r.stdout.indexOf('RENDER_KIND: unattended')).toBeLessThan(r.stdout.indexOf('SESSION_KIND: unattended'));
    }
  });

  test('an unattended environment prints no mismatch; no flag keeps the old output; a bad value is refused', () => {
    const r = start(['--render', 'unattended'], { GSTACK_SESSION_KIND: 'unattended' });
    expect(r.stdout).toContain('RENDER_KIND: unattended\n');
    expect(r.stdout).not.toContain('RENDER_KIND_MISMATCH');
    const plain = execFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), ['--skill', 'review'], { cwd: home, encoding: 'utf-8', timeout: 30_000, env: env0 });
    expect(plain).not.toContain('RENDER_KIND');
    expect(plain).toContain('SESSION_KIND: interactive');
    const bad = start(['--render', 'interactive']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--render takes unattended (got 'interactive')");
  });
});

describe('an unattended /ship receipt round trip', () => {
  let fx: TrainFixture | undefined;
  afterAll(() => { if (fx) cleanup(fx.repo); });

  test('the receipt an unattended run writes passes ready and train build at its head', () => {
    const f = trainFixture();
    fx = f;
    const h2 = openPr(f, '2');
    const h1 = openPr(f, '1', { shipped: false });
    f.repo.git('checkout', '-q', 'pr-1');
    const body = path.join(f.repo.root, 'pr-1-body.md');
    fs.writeFileSync(body, '## What changed\n\n#1 change\n');
    const unattended = { ...f.env, GSTACK_SESSION_KIND: 'unattended' };
    const written = runBin(f.repo, 'gstack-ship-receipt', ['write', '--pr', '1', '--base', 'main', '--gate', '{"tests":{"pass":1,"fail":0,"skip":0}}', '--body', body], unattended);
    expect(written.status).toBe(EXIT.ok);
    expect(written.err).toContain(`SHIP_RECEIPT: pr=1 head=${h1.slice(0, 12)}`);
    const parsed = extractReceipt(fs.readFileSync(body, 'utf-8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.receipt).toMatchObject({ pr: 1, head: h1, session_kind: 'unattended' });
    setPrBody(f, '1', fs.readFileSync(body, 'utf-8'));
    const result = runBin(f.repo, 'gstack-ship-receipt', ['result', '--pr', '1'], unattended);
    expect(line(result.out, 'GSTACK_RESULT:')).toMatch(/^GSTACK_RESULT: skill=ship status=complete run=\S+$/);
    f.write(d => { d.ci[h1] = [{ status: 'completed', conclusion: 'success' }]; });
    const pregate = path.join(f.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(f.repo, 'gstack-wtree', []).out.trim(), head: h1, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const ready = queue(f, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(ready.status).toBe(EXIT.ok);
    expect(line(ready.out, 'SHIP_RECEIPT:')).toContain(`SHIP_RECEIPT: pr=1 head=${h1.slice(0, 12)}`);
    expect(line(ready.out, 'SHIP_RECEIPT:')).toContain('session_kind=unattended');
    readyReceipt(f, '2', h2);
    f.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const build = queue(f, ['train', 'build', '--prs', `2@${h2},1@${h1}`]);
    expect([build.status, build.err]).toEqual([EXIT.ok, '']);
    expect(dispatches(f).length).toBe(2);
  }, 300_000);
});
