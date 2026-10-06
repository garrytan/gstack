/**
 * INV-3 render-level conformance (C1, #1159).
 *
 * Codex and every `usesEnvVars` host run each fenced bash block in a fresh
 * shell, so a block that uses `$GSTACK_*`, `$B` or `$D` must resolve them
 * itself. Renders every host once into a temp dir and checks every fence of
 * every SKILL.md and section file: the prelude is present and within budget,
 * every fence passes `bash -n` (placeholders normalized), the prelude and its
 * B/D consumers run under `env -i` and `set -u` with stub binaries, and the
 * generated-bash lint passes on every host's render, Claude included.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runGeneration } from '../scripts/gen-skill-docs';
import { generateMakePdfSetup } from '../scripts/resolvers/make-pdf';
import { binaryAssignment, fencePrelude, insertRuntimePreludes, MAKE_PDF_OVERRIDE, PRELUDE_BYTE_BUDGET, runtimeRootPrelude } from '../scripts/resolvers/runtime-root';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { lintFence, normalizePlaceholders } from './helpers/generated-bash-lint';

const ROOT = path.resolve(import.meta.dir, '..');
const ENV_HOSTS = ALL_HOST_CONFIGS.filter(h => h.usesEnvVars);
const FORBIDDEN = /^(?:\/bin\/|\/browse|\/design|\/gstack-)/;
const PRELUDE_LINE = /^\[ -d "\$\{GSTACK_ROOT:-\/-\}\/bin" \]|^(?:GSTACK_(?:BIN|BROWSE|DESIGN|MAKE_PDF)=\$GSTACK_ROOT\/\S+ ?)+$|^[BDP]=\$GSTACK_ROOT\//;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-env-fences-'));
const renderDir = path.join(tmp, 'render');

interface Fence { file: string; line: number; body: string }

/** Top-level ```bash fences (CommonMark: a longer outer fence hides inner ones). */
function bashFences(text: string, file = ''): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,})(.*)$/);
    if (!open) continue;
    let end = i + 1;
    const close = new RegExp(`^\\s*\`{${open[2].length},}\\s*$`);
    while (end < lines.length && !close.test(lines[end])) end++;
    if (open[2].length === 3 && open[3].trim() === 'bash') {
      out.push({ file, line: i + 1, body: lines.slice(i + 1, end).map(l => l.startsWith(open[1]) ? l.slice(open[1].length) : l).join('\n') });
    }
    i = end;
  }
  return out;
}

function renderedDocs(root: string, hostSubdir: string | null): string[] {
  const base = hostSubdir ? path.join(root, hostSubdir, 'skills') : root;
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!hostSubdir && depth === 0 && (e.name.startsWith('.') || e.name === 'node_modules')) continue;
        walk(p, depth + 1);
      } else if (e.name === 'SKILL.md' || (e.name.endsWith('.md') && path.basename(dir) === 'sections')) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}

/** A fence that uses runtime variables must resolve them itself, once, within budget. */
function fenceProblems(fence: Fence): string[] {
  const problems: string[] = [];
  const where = `${fence.file}:${fence.line}`;
  const assigned = (name: string) => new RegExp(`(?:^|[\\s;&|(])${name}=`, 'm').test(fence.body);
  if (/\$\{?GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)\b/.test(fence.body) && !assigned('GSTACK_ROOT')) problems.push(`${where} uses GSTACK_* without resolving GSTACK_ROOT`);
  if (/\$\{?B\b/.test(fence.body) && !assigned('B')) problems.push(`${where} uses $B without deriving it`);
  if (/\$\{?D\b/.test(fence.body) && !assigned('D')) problems.push(`${where} uses $D without deriving it`);
  if (/\$\{?P\b/.test(fence.body) && !/(?:^|[\s;&|(])P=/m.test(fence.body)) problems.push(`${where} uses $P without deriving it`);
  if (fence.body.includes('gstack: no install found')) {
    // MAKE_PDF_OVERRIDE is the one fixed segment outside the budget (E2).
    const bytes = Buffer.byteLength(fence.body.split('\n').filter(l => PRELUDE_LINE.test(l)).join('\n').replace(MAKE_PDF_OVERRIDE, '') + '\n');
    if (bytes > PRELUDE_BYTE_BUDGET) problems.push(`${where} prelude is ${bytes} bytes (budget ${PRELUDE_BYTE_BUDGET})`);
    if (fence.body.split('gstack: no install found').length !== 2) problems.push(`${where} carries the prelude more than once`);
  }
  return problems;
}

const ctx = (host: string, installRoot: string | null = null): TemplateContext => ({ host, skillName: 'review', tmplPath: '', paths: HOST_PATHS[host], installRoot });

function sh(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', ['-uc', script], { cwd, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
}
function mkroot(dir: string) {
  for (const sub of ['bin', 'lib', 'browse/dist', 'design/dist', 'make-pdf/dist']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

beforeAll(async () => {
  const result = await runGeneration({ host: 'all', outputRoot: renderDir });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('C1: every env-var host fence resolves its own runtime paths', () => {
  test('each fence that uses $GSTACK_*, $B, $D or $P assigns them in the same fence, within the byte budget', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const host of ENV_HOSTS) {
      for (const file of renderedDocs(renderDir, host.hostSubdir)) {
        for (const fence of bashFences(fs.readFileSync(file, 'utf8'), path.relative(renderDir, file))) {
          if (!/\$\{?(?:GSTACK_(?:ROOT|BIN|BROWSE|DESIGN|MAKE_PDF)|B|D|P)\b/.test(fence.body)) continue;
          checked++;
          problems.push(...fenceProblems(fence));
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(problems.slice(0, 40)).toEqual([]);
  });

  test('Claude output is untouched by the pass', () => {
    const claude = renderedDocs(renderDir, null);
    expect(claude.length).toBeGreaterThan(50);
    for (const file of claude) {
      const text = fs.readFileSync(file, 'utf8');
      expect(insertRuntimePreludes(text, ctx('claude'))).toBe(text);
      expect(text).not.toContain('gstack: no install found');
    }
    expect(runtimeRootPrelude(ctx('claude'))).toBe('');
  });

  test('a fence that already assigns GSTACK_ROOT gets no prelude; a $B-only fence derives B from the BROWSE SETUP helper', () => {
    expect(fencePrelude(ctx('codex'), 'GSTACK_ROOT=/x\n"$GSTACK_BIN/gstack-slug"')).toBe('');
    const b = fencePrelude(ctx('codex'), '$B goto https://example.com');
    expect(b.split('\n').at(-1)).toBe(binaryAssignment(ctx('codex'), 'browse'));
    expect(b).toContain('gstack: no install found');
    expect(fencePrelude(ctx('codex'), 'echo plain')).toBe('');
    expect(fencePrelude(ctx('codex'), 'B=x; $B goto y')).toBe('');
  });
});

describe('C1: the prelude resolves the right root in a fresh shell (env -i, set -u)', () => {
  const echo = '\necho "ROOT=$GSTACK_ROOT BIN=$GSTACK_BIN"';
  for (const host of ENV_HOSTS) {
    test(`${host.name}: exported, repo-local, global and missing roots`, () => {
      const w = fs.mkdtempSync(path.join(tmp, `${host.name}-`));
      const home = path.join(w, 'home');
      const prelude = runtimeRootPrelude(ctx(host.name));
      const global = mkroot(path.join(home, host.name === 'codex' ? '.codex/skills/gstack' : host.globalRoot));
      const repo = path.join(w, 'repo');
      fs.mkdirSync(repo);
      expect(spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 10_000 }).status).toBe(0);
      const outside = fs.mkdtempSync(path.join(w, 'outside-'));

      let r = sh(prelude + echo, outside, { HOME: home });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${global} BIN=${global}/bin`);

      const local = mkroot(path.join(repo, host.localSkillRoot));
      r = sh(prelude + echo, repo, { HOME: home });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${local} BIN=${local}/bin`);

      const exported = mkroot(path.join(w, 'exported'));
      r = sh(prelude + echo, repo, { HOME: home, GSTACK_ROOT: exported });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${exported} BIN=${exported}/bin`);

      const noLib = path.join(w, 'nolib');
      fs.mkdirSync(path.join(noLib, 'bin'), { recursive: true });
      r = sh(prelude + echo, repo, { HOME: home, GSTACK_ROOT: noLib });
      expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${local} BIN=${local}/bin`);

      if (host.name === 'codex') {
        const codexHome = mkroot(path.join(w, 'codex-home', 'skills', 'gstack'));
        r = sh(prelude + echo, outside, { HOME: home, CODEX_HOME: path.join(w, 'codex-home') });
        expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${codexHome} BIN=${codexHome}/bin`);
      }

      r = sh(prelude + echo, outside, { HOME: path.join(w, 'empty-home') });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain('ROOT=');
      expect(r.stderr).toContain('gstack: no install found (tried ');
      expect(r.stderr).toContain(`Fix: ./setup --host ${host.name} from your gstack checkout; ./setup --status shows it.`);
    });
  }

  test('a per-install render uses the literal root with no git call', () => {
    const w = fs.mkdtempSync(path.join(tmp, 'literal-'));
    const root = mkroot(path.join(w, 'install'));
    const stub = path.join(w, 'stub');
    fs.mkdirSync(stub);
    fs.writeFileSync(path.join(stub, 'git'), `#!/bin/sh\necho called >> "${path.join(w, 'git.log')}"\n`, { mode: 0o755 });
    const prelude = runtimeRootPrelude(ctx('codex', root));
    expect(prelude).not.toContain('git ');
    const r = sh(prelude + echo, w, { HOME: path.join(w, 'home'), PATH: `${stub}:/usr/bin:/bin` });
    expect(r.stdout.trim(), r.stderr).toBe(`ROOT=${root} BIN=${root}/bin`);
    expect(fs.existsSync(path.join(w, 'git.log'))).toBe(false);
    fs.rmSync(path.join(root, 'bin'), { recursive: true });
    const missing = sh(prelude + echo, w, { HOME: path.join(w, 'home'), PATH: `${stub}:/usr/bin:/bin` });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(`gstack: no install found (tried ${root})`);
  });
});

/** Every host's rendered fences, Claude included. */
function allFences(): Array<Fence & { host: string }> {
  const out: Array<Fence & { host: string }> = [];
  for (const host of ALL_HOST_CONFIGS) {
    for (const file of renderedDocs(renderDir, host.name === 'claude' ? null : host.hostSubdir)) {
      for (const fence of bashFences(fs.readFileSync(file, 'utf8'), path.relative(renderDir, file))) out.push({ ...fence, host: host.name });
    }
  }
  return out;
}

describe('INV-3: every rendered fence parses, runs its prelude and passes the lint', () => {
  test('bash -n passes on every fence of every host (angle-bracket placeholders normalized)', () => {
    const fences = allFences();
    expect(fences.length).toBeGreaterThan(5000);
    const unique = new Map<string, string>();
    for (const f of fences) {
      const body = normalizePlaceholders(f.body);
      if (!unique.has(body)) unique.set(body, `${f.file}:${f.line}`);
    }
    const dir = fs.mkdtempSync(path.join(tmp, 'syntax-'));
    const where: string[] = [];
    [...unique.keys()].forEach((body, n) => { fs.writeFileSync(path.join(dir, `${n}.sh`), body + '\n'); where[n] = unique.get(body)!; });
    const r = spawnSync('bash', ['-c', `ls | xargs -P 4 -n 200 bash -c 'for f; do bash -n "$f" 2>/dev/null || echo "$f"; done' _`],
      { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const failed = r.stdout.split('\n').filter(Boolean).map(f => {
      const err = spawnSync('bash', ['-n', path.join(dir, f)], { encoding: 'utf8', timeout: 10_000 }).stderr.trim().split('\n')[0];
      return `${where[Number(f.replace('.sh', ''))]}: ${err}`;
    });
    expect(failed).toEqual([]);
  }, 180_000);

  test('the prelude and its B/D consumers run under env -i and set -u with stub binaries', () => {
    const w = fs.mkdtempSync(path.join(tmp, 'exec-'));
    const home = path.join(w, 'home');
    const problems: string[] = [];
    let ran = 0;
    for (const host of ENV_HOSTS) {
      const root = mkroot(path.join(home, host.name === 'codex' ? '.codex/skills/gstack' : host.globalRoot));
      for (const tool of ['browse', 'design']) fs.writeFileSync(path.join(root, tool, 'dist', tool), `#!/bin/sh\necho "STUB_${tool}"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(root, 'make-pdf', 'dist', 'pdf'), '#!/bin/sh\necho "STUB_pdf"\n', { mode: 0o755 });
      const preludes = new Set<string>();
      for (const file of renderedDocs(renderDir, host.hostSubdir)) {
        for (const fence of bashFences(fs.readFileSync(file, 'utf8'))) {
          const lines = fence.body.split('\n').filter(l => PRELUDE_LINE.test(l));
          if (lines.length) preludes.add(lines.join('\n'));
        }
      }
      expect(preludes.size).toBeGreaterThan(0);
      for (const prelude of preludes) {
        ran++;
        const vars = [...new Set([...prelude.matchAll(/(?:^|\s)(GSTACK_[A-Z_]+|[BDP])=/gm)].map(m => m[1]))];
        const consumers = vars.filter(v => v === 'B' || v === 'D' || v === 'P').map(v => `"$${v}"`).join('\n');
        const script = `${prelude}\n${vars.map(v => `printf '%s=%s\\n' ${v} "$${v}"`).join('\n')}\n${consumers}`;
        const r = spawnSync('env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', 'bash', '-uc', script], { cwd: w, encoding: 'utf8', timeout: 10_000 });
        if (r.status !== 0) { problems.push(`${host.name}: exit ${r.status}: ${r.stderr.trim()}\n${prelude}`); continue; }
        for (const line of r.stdout.split('\n').filter(l => /^[A-Z_]+=/.test(l))) {
          const value = line.slice(line.indexOf('=') + 1);
          if (!value || FORBIDDEN.test(value)) problems.push(`${host.name}: ${line}`);
        }
        for (const v of vars.filter(x => x === 'B' || x === 'D' || x === 'P')) {
          if (!r.stdout.includes(`STUB_${{ B: 'browse', D: 'design', P: 'pdf' }[v]}`)) problems.push(`${host.name}: $${v} did not run the stub binary`);
        }
      }
    }
    expect(ran).toBeGreaterThan(ENV_HOSTS.length);
    expect(problems).toEqual([]);
  });

  test('the generated-bash lint passes on every host, Claude included', () => {
    const findings = allFences().flatMap(f => lintFence(f.body).map(x => `${f.file}:${f.line + x.line} ${x.rule}: ${x.detail}`));
    expect(findings).toEqual([]);
  });
});

describe('#3046: runtime reference docs that skills execute pass the lint', () => {
  test('every non-generated markdown file in a skill directory (review/greptile-triage.md and friends)', () => {
    const skillDirs = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'SKILL.md.tmpl')))
      .map(e => path.join(ROOT, e.name));
    const docs = skillDirs.flatMap(dir => fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== 'SKILL.md')
      .map(f => path.join(dir, f)));
    expect(docs.map(d => path.relative(ROOT, d))).toContain('review/greptile-triage.md');
    const findings = docs.flatMap(file => bashFences(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file))
      .flatMap(f => lintFence(f.body).map(x => `${f.file}:${f.line + x.line} ${x.rule}: ${x.detail}`)));
    expect(findings).toEqual([]);
  });
});

describe('INV-3: negative controls (planted bad fences fail each check)', () => {
  test('lint rules', () => {
    const rules = (body: string) => lintFence(body).map(f => f.rule);
    expect(rules('SLUG=$("~/.claude/skills/gstack/bin/gstack-slug" 2>/dev/null)')).toEqual(['tilde-in-quotes']);
    expect(rules('echo "see ~/.gstack for logs"; ls ~/.gstack "$HOME/x"')).toEqual([]);
    expect(rules('F=$(mktemp)')).toEqual(['mktemp-template']);
    expect(rules('D=$(mktemp -d /tmp/x.XXXXXX)')).toEqual(['mktemp-template']);
    expect(rules('F=$(mktemp "${TMPDIR:-/tmp}/x.XXXXXX"); G=$(mktemp "$TMP_ROOT/codex-err-XXXXXX"); H=$(mktemp -t x.XXXX)')).toEqual([]);
    expect(rules('cd "$INSTALL_DIR"\ngit reset --hard origin/main')).toEqual(['unguarded-var']);
    expect(rules('rm -rf "$LOCAL_GSTACK/.git"')).toEqual(['unguarded-var']);
    expect(rules('mv "$A" "$A.bak"')).toEqual(['unguarded-var', 'unguarded-var']);
    expect(rules('git -C "$REPO" stash')).toEqual(['unguarded-var']);
    expect(rules('cd -- "${INSTALL_DIR:?unset}"')).toEqual(['unguarded-var']);
    expect(rules('cd -- "${INSTALL_DIR:?unset}" || exit 1\nrm -rf "$INSTALL_DIR/x"')).toEqual([]);
    expect(rules('X=$(pwd)\ncd "$X" && rm -r "$X/y"; rm -f "$TMPFILE"')).toEqual([]);
    expect(rules('ls | while IFS= read -r d; do rm -rf "$d"; done')).toEqual([]);
    expect(rules('cat <<EOF\ncd "$NOT_CODE"\nEOF\necho ok')).toEqual([]);
    expect(rules("echo 'cd \"$QUOTED\"'")).toEqual([]);
    // #3046: reviewer, diff and error text inside a double-quoted body runs its backticks.
    expect(rules('gh api repos/o/r/issues/1/comments -f body="<reply text>"')).toEqual(['untrusted-in-quotes']);
    expect(rules('gh issue create --title "Failure: <test-name>" --body-file "$F"')).toEqual(['untrusted-in-quotes']);
    expect(rules('glab issue create -t "$T" -d "Error: <first 10 lines>"')).toEqual(['untrusted-in-quotes']);
    expect(rules("B=$(cat <<'GSTACK_REPLY'\n**Fixed** in `<sha>`.\nGSTACK_REPLY\n)\ngh api x -f body=\"$B\"")).toEqual([]);
    expect(rules("git commit -m \"$(cat <<'EOF'\nfix: <summary>\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\"")).toEqual([]);
    expect(rules('gh pr view <number> --json title')).toEqual([]);
  });

  test('placeholder normalization keeps real syntax errors', () => {
    const ok = spawnSync('bash', ['-n', '-c', normalizePlaceholders('git push -u origin <branch-name>\nkill <PID> 2>/dev/null\ndiff <(echo a) <(echo b)')], { timeout: 10_000 });
    expect(ok.status).toBe(0);
    const bad = spawnSync('bash', ['-n', '-c', normalizePlaceholders('if [ -f <file> ]; then echo')], { timeout: 10_000 });
    expect(bad.status).not.toBe(0);
  });

  test('a fence that uses runtime variables without the prelude is reported', () => {
    expect(fenceProblems({ file: 'x', line: 1, body: '"$GSTACK_BIN/gstack-slug"' })).toEqual(['x:1 uses GSTACK_* without resolving GSTACK_ROOT']);
    expect(fenceProblems({ file: 'x', line: 1, body: '$B goto https://example.com' })).toEqual(['x:1 uses $B without deriving it']);
    const twice = `${runtimeRootPrelude(ctx('codex'))}\n${runtimeRootPrelude(ctx('codex'))}\n"$GSTACK_BIN/x"`;
    expect(fenceProblems({ file: 'x', line: 1, body: twice })).toContain('x:1 carries the prelude more than once');
  });
});

// E2: make-pdf's $P comes from one resolver (binaryAssignment 'make-pdf') for
// the readiness check and every later block, honoring MAKE_PDF_BIN.
describe('E2: make-pdf $P on env-var hosts', () => {
  const pdfStub = (file: string, label: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho "${label} $*"\n`, { mode: 0o755 });
  };

  test('readiness and a later block resolve the same binary, MAKE_PDF_BIN wins, paths with spaces work', () => {
    const w = fs.mkdtempSync(path.join(tmp, 'pdf with spaces-'));
    const home = path.join(w, 'home dir');
    const root = mkroot(path.join(w, 'gstack root'));
    pdfStub(path.join(root, 'make-pdf', 'dist', 'pdf'), 'ROOT_PDF');
    const dev = path.join(w, 'dev build', 'pdf');
    pdfStub(dev, 'DEV_PDF');
    const c = { ...ctx('codex'), skillName: 'make-pdf' };
    const readiness = bashFences(insertRuntimePreludes(generateMakePdfSetup(c), c))[0].body;
    const later = fencePrelude(c, '"$P" generate letter.md') + '\n"$P" generate letter.md';
    const env = (extra: Record<string, string> = {}) =>
      ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', `GSTACK_ROOT=${root}`, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
    const run = (script: string, extra?: Record<string, string>) =>
      spawnSync('env', [...env(extra), 'bash', '-uc', script], { cwd: w, encoding: 'utf8', timeout: 10_000 });

    let r = run(readiness);
    expect(r.stdout, r.stderr).toContain(`MAKE_PDF_READY: ${root}/make-pdf/dist/pdf`);
    r = run(later);
    expect(r.stdout.trim(), r.stderr).toBe('ROOT_PDF generate letter.md');

    r = run(readiness, { MAKE_PDF_BIN: dev });
    expect(r.stdout, r.stderr).toContain(`MAKE_PDF_READY: ${dev}`);
    r = run(later, { MAKE_PDF_BIN: dev });
    expect(r.stdout.trim(), r.stderr).toBe('DEV_PDF generate letter.md');

    // A MAKE_PDF_BIN that is not executable falls back to the install, in both places.
    r = run(later, { MAKE_PDF_BIN: path.join(w, 'missing pdf') });
    expect(r.stdout.trim(), r.stderr).toBe('ROOT_PDF generate letter.md');
  });

  test('Claude keeps its repo-local-first probe with MAKE_PDF_BIN first; only the comment changed', () => {
    const block = bashFences(generateMakePdfSetup({ ...ctx('claude'), skillName: 'make-pdf' }))[0].body;
    expect(block).toContain(binaryAssignment(ctx('claude'), 'make-pdf'));
    expect(block.indexOf('MAKE_PDF_BIN')).toBeLessThan(block.indexOf('_ROOT/'));
    expect(block).not.toContain('available as $P in subsequent blocks');
  });
});
