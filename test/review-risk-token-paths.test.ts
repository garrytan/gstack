/**
 * GST-1350 (FOUN-32, FOUN-87): founderstar's scripts/ui/token.gd is a Godot UI design-token file, and the secret-path
 * rule matched its name alone, so a copy-only PR (founderstar#546) was gate class at full depth. A token-named file is a
 * secret path only when its changed lines hold a secret-shaped value; a secrets or credentials name, a key file or a
 * dotenv file stays a secret path by name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectCommit } from '../lib/review-collect';
import { createHash } from 'node:crypto';
import { depthOfCommitInput, isGatePath, planReview, ROLE_EFFORT, scanNumbers } from '../lib/review-depth';
import { matchRisk, secretPath } from '../lib/review-risk';
import { targetedClasses } from '../lib/review-targeted';

const GODOT_TOKENS = ['class_name UIToken', 'extends RefCounted', 'const COLOR_PRIMARY := Color("#ff6a00")', 'const SPACING_MD := 12', 'const LABEL_PLAY := "Play"'];
const BENIGN: Record<string, string[]> = {
  'scripts/ui/token.gd': GODOT_TOKENS,
  'design-tokens.json': ['{ "color": { "primary": "#ff6a00" }, "space": { "md": 12 } }'],
  'ui/tokens.css': [':root { --color-primary: #ff6a00; --space-md: 12px; }'],
};
/** Built at run time so the credential scan never reads a key-shaped literal in this file. */
const fakePat = () => ['ghp', '_', 'x7Qm2Lp9Vr4Tn8Kw3Hs6', 'Jd1Fz5Bc0YaUe4Gq'].join('');
const googleToken = () => JSON.stringify({ token: 'ya29.' + 'x'.repeat(60), refresh_token: '1//0' + 'y'.repeat(40) });
const NAMED: Record<string, string[]> = {
  'token.json': [googleToken()],
  'auth/token': ['z'.repeat(40)],
  'config/tokens.yaml': ['primary: ff6a00'],
  'cache/tokens.db': [],
  'theme/token.ts': ['export const token = { colorPrimary: "#ff6a00", spaceMd: 12 };'],
  'lib/token.ts': ['const API_TOKEN = "' + ['Zx9Qw8Er7Ty6Ui5Op4', 'As3Df2Gh1Jk0Lm'].join('') + '";'],
  '.env': ['LOG_LEVEL=debug'],
  'deploy/.env.production': ['LOG_LEVEL=info'],
  '.ssh/id_rsa': ['not shown'],
  'certs/server.pem': ['not shown'],
  'credentials.json': ['{ "type": "service_account" }'],
  'secrets/prod.yaml': ['region: us-east-1'],
};

const risk = (p: string, added: string[]) => matchRisk({ codePaths: [p], added: { [p]: added }, scopeAuth: false });
const depth = (p: string, added: string[]) => depthOfCommitInput({ paths: [p], added: { [p]: added }, removed: {}, gateTagged: 0, scope: {} });

describe('GST-1350: a token-named file is a secret path only on secret-shaped content', () => {
  // Value: protects=design-token files (token.gd, design-tokens.json, tokens.css) review at the depth their content earns;
  //   fails_when=the token name alone raises the secret class, the gate class or a kept gate path; seam=matchRisk + classifyDiff + isGatePath
  test.each(Object.entries(BENIGN))('%s with design tokens is not secret, not gate', (p, added) => {
    expect(risk(p, added).has('secret')).toBe(false);
    expect(isGatePath(p)).toBe(false);
    const d = depth(p, added);
    expect(d.class).not.toBe('gate');
    expect(d.risk).not.toContain('secret');
  });

  // Value: protects=a token file that carries a credential still gets the secret class and the gate class;
  //   fails_when=the content check misses a key-shaped value on an added or a removed line; seam=matchRisk + classifyDiff
  test.each(['scripts/ui/token.gd', 'ui/tokens.css'])('%s holding a secret-shaped value stays secret and gate', p => {
    const line = `const API_TOKEN := "${fakePat()}"`;
    expect(risk(p, [...BENIGN[p]!, line]).get('secret')).toBe('secret path: ' + p);
    expect(matchRisk({ codePaths: [p], added: {}, removed: { [p]: [line] }, scopeAuth: false }).has('secret')).toBe(true);
    const d = depth(p, [line]);
    expect(d.class).toBe('gate');
    expect(d.risk).toContain('secret');
  });

  // Value: protects=secret and credential names, private keys, dotenv files and token files that are not style or engine files
  //   (code such as token.ts, json, yaml, no extension, binary) stay secret by name, whatever they hold; fails_when=narrowing the token rule drops one of them, or a key file reads as anything below gate; seam=matchRisk + classifyDiff + isGatePath
  test.each(Object.entries(NAMED))('%s stays secret and gate by name alone', (p, added) => {
    expect(risk(p, added).get('secret')).toBe('secret path: ' + p);
    expect(isGatePath(p) || secretPath(p, added)).toBe(true);
    const d = depth(p, added);
    expect(d.class).toBe('gate');
    expect(d.risk).toContain('secret');
  });

  // Value: protects=a token-named style or engine file whose lines cannot be read (binary, no text) fails closed to a secret path;
  //   fails_when=an empty line set reads as benign; seam=matchRisk
  test('a token-named style or engine file with no readable lines stays secret', () => {
    expect(risk('scripts/ui/token.gd', []).has('secret')).toBe(true);
    expect(matchRisk({ codePaths: ['ui/tokens.css'], scopeAuth: false }).has('secret')).toBe(true);
  });

  // Value: protects=a dotenv template holds no secrets by convention; fails_when=.env.example raises the secret class on its name; seam=matchRisk
  test('.env.example is not a secret path by name', () => {
    expect(risk('.env.example', ['OPENAI_API_KEY=']).has('secret')).toBe(false);
  });
});

describe('GST-1350: founderstar#546 shape, a copy-only edit to a Godot token file', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

  // Value: protects=the planner gives a copy-only token.gd change the light depth it earns (no 11-reader full panel);
  //   fails_when=collectCommit + targetedClasses + depthOfCommitInput read the token name as a secret or gate path; seam=gstack-diff-scope + collectCommit + targetedClasses + depthOfCommitInput
  test('the planner: no secret class, no gate class, light depth', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-path-')));
    dirs.push(root);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: root, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); return r.stdout.trim(); };
    const file = path.join(root, 'scripts/ui/token.gd');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, GODOT_TOKENS.join('\n') + '\n');
    sh('git init -q && git add -A && git commit -qm base');
    const base = sh('git rev-parse HEAD');
    fs.writeFileSync(file, GODOT_TOKENS.join('\n').replace('"Play"', '"Start game"') + '\n');
    sh('git commit -qam copy');
    const c = collectCommit(root, base, sh('git rev-parse HEAD'));
    expect(targetedClasses({ ...c, scope: {}, gateTagged: 0 }).classes).toEqual([]);
    const d = depthOfCommitInput({ ...c, scope: {}, gateTagged: 0 });
    expect({ class: d.class, depth: d.depth, risk: d.risk }).toEqual({ class: 'code', depth: 'light', risk: [] });
  }, 60_000);
});

/**
 * The GST-1350 no-loss check (crew rule 2026-10-30; replay 'GST-1350' in test/fixtures/review-pins/replays/GST-1350.json).
 * On the GST-967 history grid (288 histories per case), each case runs on its real path and on a stand-in (a path main and the
 * branch both classify the way main classified the real one). Main's planReview at b244e6d (v1.95.5.0) on the real paths, with
 * targetedClasses as the planner computes them, hashes to MAIN_1350_PLANS, and so does the branch's on the stand-ins. On the
 * real paths the branch lowers exactly the two benign token-named style and engine cases (gate/full to code/light, the fix) and only raises
 * or keeps every other case, keeping every reader main dispatched there at the same effort or higher, with GST-972's one
 * exception: light's batched reader, which carries the Red Team prompt at full effort, becomes full depth's batched reader at
 * the specialist effort on the three key files that rise to full, while the Red Team keeps full effort as its own dispatch.
 */
const MAIN_1350_PLANS = 'bafc2b5329237dbb994ab85d5ee0a696e7bd479615f81206c9b4ce7507af108e';
describe('GST-1350 no-loss check', () => {
  // Value: protects=the no-loss rule for review-depth changes: narrowing the token name drops readers only on benign token files;
  //   fails_when=a stand-in stops matching main's plans, a token file with a secret or a secrets, credentials or key file loses a
  //   reader or a class, or another case moves down; why_new=GST-1350; seam=targetedClasses + planReview; no_claim=what the readers find
  test('only benign token files move down; every other case keeps or raises main\'s plan', () => {
    const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    const none = scanNumbers({});
    const gd = ['class_name UIToken', 'const LABEL_PLAY := "Start game"'];
    const cases: Record<string, [string, string, string[]]> = {
      'token-gd': ['scripts/ui/token.gd', 'scripts/ui/credentials.gd', gd],
      'tokens-css': ['ui/tokens.css', 'ui/secrets.css', [':root { --space-md: 12px; }']],
      'token-ts': ['theme/token.ts', 'theme/credentials.ts', ['export const token = { spaceMd: 12 };']],
      'token-secret': ['scripts/ui/token.gd', 'scripts/ui/credentials.gd', [...gd, `const API_TOKEN := "${fakePat()}"`]],
      pem: ['certs/server.pem', 'certs/server.crt', ['not shown']],
      dotenv: ['.env', '.envrc', ['LOG_LEVEL=debug']],
      'id-rsa': ['.ssh/id_rsa', '.ssh/id_rsa.pub', ['not shown']],
      'secrets-dir': ['secrets/prod.yaml', 'secrets/prod.yaml', ['region: us-east-1']],
      'credentials-json': ['credentials.json', 'credentials.json', ['{ "type": "service_account" }']],
      'token-json': ['token.json', 'token.json', [googleToken()]],
      'tokens-db': ['cache/tokens.db', 'cache/tokens.db', []],
    };
    type Row = { name: string; fullPasses: number; last: string; bits: number; adversarialRan: boolean; targeted: string[]; class: string; depth: string; step: string; dispatches: { role: string; name: string; effort: string; checklists: string[] }[] };
    const grid = (pick: 0 | 1) => {
      const rows: Row[] = [];
      for (const [name, c] of Object.entries(cases)) {
        const paths = [c[pick]];
        const added = { [c[pick]]: c[2] };
        const t = targetedClasses({ paths, added, removed: {}, scope: {}, gateTagged: 0, consumed: [] }).classes;
        for (const fullPasses of [0, 1, 2]) for (const last of ['none', 'full', 'fix-check'] as const) for (let bits = 0; bits < 16; bits++) for (const adversarialRan of [false, true]) {
          const history = { fullPasses, last, fixedBlocking: !!(bits & 1), fixedBelow: !!(bits & 2), blockingOpen: !!(bits & 4), touchedGate: !!(bits & 8) };
          const p = planReview({ paths, added, removed: {}, scope: {}, gateTagged: 0, diffLines: 40, consumed: [], numbers: none, history, adversarialRan, targeted: { classes: t } });
          rows.push({ name, fullPasses, last, bits, adversarialRan, targeted: t, class: p.class, depth: p.depth, step: p.next.step, dispatches: p.dispatches.map(d => ({ role: d.role, name: d.name, effort: d.effort, checklists: d.checklists ?? [] })) });
        }
      }
      return rows;
    };
    const main = grid(1);
    expect(sha(main)).toBe(MAIN_1350_PLANS);
    const rank: Record<string, number> = { docs: 0, tests: 1, code: 2, gate: 3, light: 0, standard: 1, full: 2 };
    const effort: Record<string, number> = { medium: 1, full: 2, host: 2 };
    const lowered = new Set(['token-gd', 'tokens-css']);
    const moves: Record<string, number> = {};
    let split = 0;
    grid(0).forEach((b, i) => {
      const m = main[i]!;
      const move = `${m.name}: ${m.class}/${m.depth} -> ${b.class}/${b.depth}`;
      moves[move] = (moves[move] ?? 0) + 1;
      if (lowered.has(m.name)) return;
      expect([move, rank[b.class]! >= rank[m.class]!, rank[b.depth]! >= rank[m.depth]!, m.targeted.every(c => b.targeted.includes(c))]).toEqual([move, true, true, true]);
      const readers = (r: Row) => new Map(r.dispatches.flatMap(d => d.role === 'specialist' ? d.checklists.map(c => [c === 'red-team' ? 'red-team' : `checklist:${c}`, d.effort] as const) : [[d.role, d.effort] as const]));
      const mr = readers(m), br = readers(b);
      for (const [reader, e] of mr) {
        expect([move, reader, br.has(reader)]).toEqual([move, reader, true]);
        if (effort[br.get(reader)!]! >= effort[e]!) continue;
        expect([reader.startsWith('checklist:'), m.depth, e, br.get(reader), mr.get('red-team'), br.get('red-team')]).toEqual([true, 'light', 'full', ROLE_EFFORT.specialist, 'full', 'full']);
        split++;
      }
    });
    expect([main.length, split, moves]).toEqual([3168, 252, {
      'token-gd: gate/full -> code/light': 288, 'tokens-css: gate/full -> code/light': 288, 'token-ts: gate/full -> gate/full': 288, 'token-secret: gate/full -> gate/full': 288,
      'pem: code/light -> gate/full': 288, 'dotenv: code/light -> gate/full': 288, 'id-rsa: code/light -> gate/full': 288, 'secrets-dir: gate/full -> gate/full': 288, 'credentials-json: gate/full -> gate/full': 288,
      'token-json: gate/full -> gate/full': 288, 'tokens-db: gate/full -> gate/full': 288,
    }]);
  });
});
