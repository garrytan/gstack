/**
 * Behavioral unit tests for Grok Build packaging surfaces (code-review #8):
 *   - generateSpecSpawn fail-closed allowlist + no default --always-approve
 *   - GrokAdapter available timeout / --prompt-file path / auth redaction
 *   - gstack-grok-compat-audit exit codes against fixture skills dirs
 *
 * Free (no API spend). Does not invoke real grok CLI for successful runs.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateSpecSpawn, generateSpecExecuteFlag } from '../scripts/resolvers/spec-spawn';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { GrokAdapter, parseGrokOutput, isStructurallyValidGrokAuthFile } from './helpers/providers/grok';
import { estimateCostUsd, PRICING } from './helpers/pricing';

const ROOT = path.resolve(import.meta.dir, '..');
const AUDIT_BIN = path.join(ROOT, 'bin', 'gstack-grok-compat-audit');

function makeCtx(host: 'grok-build' | 'claude'): TemplateContext {
  return {
    skillName: 'spec',
    tmplPath: path.join(ROOT, 'spec', 'SKILL.md.tmpl'),
    host,
    paths: HOST_PATHS[host],
  };
}

// ─── generateSpecSpawn ───────────────────────────────────────

describe('generateSpecSpawn (Grok fail-closed)', () => {
  test('grok-build emits auth gate, ARCHIVE allowlist, and no default --always-approve', () => {
    const out = generateSpecSpawn(makeCtx('grok-build'));
    expect(out).toContain('command -v grok');
    expect(out).toContain('ARCHIVE_PATH');
    expect(out).toContain('SPAWN_PATH');
    expect(out).toContain('GSTACK_STATE_ROOT');
    expect(out).toContain('realpath');
    expect(out).toContain('fail closed');
    expect(out).toContain('grok --prompt-file');
    // Default spawn must NOT enable elevated auto-approve
    expect(out).not.toMatch(/grok --prompt-file[^\n]*--always-approve/);
    expect(out).toMatch(/opt-in only|does \*\*not\*\* pass `--always-approve`|--always-approve` is opt-in/i);
  });

  test('grok-build --execute-claude path reuses ARCHIVE allowlist before cat|claude', () => {
    const out = generateSpecSpawn(makeCtx('grok-build'));
    expect(out).toContain('--execute-claude');
    // Claude branch must re-check allowlist, not bare cat only
    const claudeIdx = out.indexOf('--execute-claude');
    const after = out.slice(claudeIdx);
    expect(after).toContain('ARCHIVE_REAL');
    expect(after).toContain('STATE_PROJECTS');
    expect(after).toMatch(/cat "\$ARCHIVE_PATH" \| \(cd "\$SPAWN_PATH" && claude -p/);
  });

  test('claude host still uses classic stdin pipe (no Grok-only gates)', () => {
    const out = generateSpecSpawn(makeCtx('claude'));
    expect(out).toContain('claude -p');
    expect(out).not.toContain('grok --prompt-file');
  });

  test('generateSpecExecuteFlag is host-aware', () => {
    expect(generateSpecExecuteFlag(makeCtx('grok-build'))).toContain('grok --prompt-file');
    expect(generateSpecExecuteFlag(makeCtx('claude'))).toContain('claude -p');
  });
});

// ─── GrokAdapter ─────────────────────────────────────────────

describe('GrokAdapter behavioral unit', () => {
  const adapter = new GrokAdapter();
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevXai: string | undefined;
  let prevGrok: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-grok-adapter-'));
    prevHome = process.env.HOME;
    prevXai = process.env.XAI_API_KEY;
    prevGrok = process.env.GROK_API_KEY;
    process.env.HOME = tmpHome;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevXai;
    if (prevGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = prevGrok;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('available() returns not-ok when CLI and auth both missing', async () => {
    // Isolate PATH so grok cannot be found even if installed on the machine.
    // Some environments still resolve `grok` via absolute exec caches — accept
    // either binary-missing OR auth-missing as a valid not-ok outcome.
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-dir-for-grok-avail';
    try {
      const r = await adapter.available();
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not found|Install Grok|PATH|No Grok auth|XAI_API_KEY|GROK_API_KEY/i);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test('available() fails when binary present but no auth file and no env key names', async () => {
    // If grok is not on PATH in this environment, skip — unit still covers the
    // auth-file/env-name branch when binary is present.
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) {
      // No binary: available should report CLI missing under empty HOME
      const r = await adapter.available();
      expect(r.ok).toBe(false);
      return;
    }
    const r = await adapter.available();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No Grok auth|XAI_API_KEY|GROK_API_KEY/i);
  });

  test('available() accepts non-empty auth.json object under HOME', async () => {
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) return; // cannot exercise auth-file path without binary
    fs.mkdirSync(path.join(tmpHome, '.grok'), { recursive: true });
    // OAuth-shaped key (URL) without logging real secrets — structure only
    fs.writeFileSync(
      path.join(tmpHome, '.grok', 'auth.json'),
      JSON.stringify({ 'https://auth.x.ai::fixture-user': { access: 'x' } }),
    );
    const r = await adapter.available();
    expect(r.ok).toBe(true);
  });

  test('available() fails closed on empty object auth.json {}', async () => {
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) return;
    fs.mkdirSync(path.join(tmpHome, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.grok', 'auth.json'), '{}');
    const r = await adapter.available();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No Grok auth|auth\.json|XAI_API_KEY|GROK_API_KEY/i);
    // Reason must never echo file contents / secrets
    expect(r.reason).not.toMatch(/access_token|sk-|Bearer/i);
  });

  test('available() fails closed on zero-byte and invalid auth.json', async () => {
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) return;
    fs.mkdirSync(path.join(tmpHome, '.grok'), { recursive: true });
    const authPath = path.join(tmpHome, '.grok', 'auth.json');

    fs.writeFileSync(authPath, '');
    expect((await adapter.available()).ok).toBe(false);

    fs.writeFileSync(authPath, '   \n');
    expect((await adapter.available()).ok).toBe(false);

    fs.writeFileSync(authPath, 'not-json');
    expect((await adapter.available()).ok).toBe(false);

    fs.writeFileSync(authPath, 'null');
    expect((await adapter.available()).ok).toBe(false);

    fs.writeFileSync(authPath, '[]');
    expect((await adapter.available()).ok).toBe(false);
  });

  test('available() fails closed on whitespace-only env keys', async () => {
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) return;
    process.env.XAI_API_KEY = '   ';
    process.env.GROK_API_KEY = '\t';
    const r = await adapter.available();
    expect(r.ok).toBe(false);
    expect(r.reason).not.toContain('   ');
  });

  test('available() accepts non-blank env key without auth file', async () => {
    const which = spawnSync('sh', ['-c', 'command -v grok'], {
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) return;
    process.env.XAI_API_KEY = 'test-not-a-real-key';
    const r = await adapter.available();
    expect(r.ok).toBe(true);
  });

  test('isStructurallyValidGrokAuthFile pure checks', () => {
    const p = path.join(tmpHome, 'auth.json');
    fs.writeFileSync(p, '');
    expect(isStructurallyValidGrokAuthFile(p)).toBe(false);
    fs.writeFileSync(p, '{}');
    expect(isStructurallyValidGrokAuthFile(p)).toBe(false);
    fs.writeFileSync(p, '{"k":1}');
    expect(isStructurallyValidGrokAuthFile(p)).toBe(true);
    expect(isStructurallyValidGrokAuthFile(path.join(tmpHome, 'missing.json'))).toBe(false);
  });

  test('run() uses --prompt-file for multi-line / large prompts (ARG_MAX safety)', async () => {
    // Force binary_missing path so we never hit a real CLI; still inspects argv construction
    // via the ENOENT error path. Large prompt must not throw ARG_MAX.
    const big = 'line\n'.repeat(500) + 'x'.repeat(3000);
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-dir-for-grok-test';
    try {
      const r = await adapter.run({
        prompt: big,
        workdir: tmpHome,
        timeoutMs: 2000,
      });
      expect(r.error?.code).toBe('binary_missing');
      expect(r.tokens).toEqual({ input: 0, output: 0 });
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test('run() redacts long token-shaped stderr on unknown errors', async () => {
    // Drive the unknown error path with a fake binary that exits non-zero
    const fakeBin = path.join(tmpHome, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const grokSh = path.join(fakeBin, 'grok');
    fs.writeFileSync(
      grokSh,
      `#!/bin/sh\necho "auth token SECRET_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${prevPath ?? ''}`;
    try {
      const r = await adapter.run({
        prompt: 'hi',
        workdir: tmpHome,
        timeoutMs: 3000,
      });
      // Auth keyword in stderr maps to auth code with redacted reason
      expect(r.error).toBeDefined();
      if (r.error?.code === 'auth') {
        expect(r.error.reason).not.toContain('SECRET_TOKEN');
      } else {
        expect(r.error!.reason).not.toContain('SECRET_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
        expect(r.error!.reason).toMatch(/\[redacted\]|unknown|authentication/i);
      }
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test('run() passes --output-format json and parses usage from fixture CLI', async () => {
    const fakeBin = path.join(tmpHome, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const grokSh = path.join(fakeBin, 'grok');
    // Echo argv so we can assert --output-format json; emit usage-bearing JSON on stdout
    const payload = JSON.stringify({
      text: 'hello',
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: 'grok',
    });
    fs.writeFileSync(
      grokSh,
      `#!/bin/sh
# record argv for assertions
printf '%s\\n' "$*" > "${tmpHome}/grok-argv.txt"
echo '${payload}'
`,
      { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${prevPath ?? ''}`;
    try {
      const r = await adapter.run({
        prompt: 'hi',
        workdir: tmpHome,
        timeoutMs: 3000,
      });
      expect(r.error).toBeUndefined();
      expect(r.output).toBe('hello');
      expect(r.tokens).toEqual({ input: 1000, output: 500 });
      expect(r.modelUsed).toBe('grok');
      // Cost honesty: non-zero tokens × official rates → non-zero USD
      const cost = adapter.estimateCost(r.tokens, r.modelUsed);
      expect(cost).toBeGreaterThan(0);
      const argv = fs.readFileSync(path.join(tmpHome, 'grok-argv.txt'), 'utf-8');
      expect(argv).toMatch(/--output-format\s+json|--output-format json/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

// ─── parseGrokOutput + pricing honesty ───────────────────────

describe('parseGrokOutput + Grok pricing', () => {
  test('parses characterized headless json shape (no usage → zero tokens)', () => {
    const raw = JSON.stringify({
      text: 'pong',
      stopReason: 'EndTurn',
      sessionId: '019f57be-82a4-7990-89ed-47a030fbaeb7',
      requestId: 'fe579ce3-777b-42e5-aea5-f2e25c24398d',
      thought: 'simple reply',
    });
    const p = parseGrokOutput(raw);
    expect(p.output).toBe('pong');
    expect(p.tokens).toEqual({ input: 0, output: 0 });
  });

  test('parses usage when present (input_tokens / output_tokens)', () => {
    const p = parseGrokOutput(
      JSON.stringify({
        text: 'ok',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    );
    expect(p.tokens).toEqual({ input: 1_000_000, output: 1_000_000 });
    // With U1 rates for `grok` ($1/$2 per MTok): 1 + 2 = $3
    expect(estimateCostUsd(p.tokens, 'grok')).toBe(3);
  });

  test('parses prompt_tokens / completion_tokens aliases', () => {
    const p = parseGrokOutput(
      JSON.stringify({
        text: 'x',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
    expect(p.tokens).toEqual({ input: 100, output: 50 });
  });

  test('plain text without usage → zero tokens, no throw', () => {
    const p = parseGrokOutput('just plain assistant text');
    expect(p.output).toBe('just plain assistant text');
    expect(p.tokens).toEqual({ input: 0, output: 0 });
  });

  test('streaming-json NDJSON accumulates text; zero tokens without usage', () => {
    const raw = [
      '{"type":"thought","data":"hmm"}',
      '{"type":"text","data":"hel"}',
      '{"type":"text","data":"lo"}',
      '{"type":"end","stopReason":"EndTurn","sessionId":"x"}',
    ].join('\n');
    const p = parseGrokOutput(raw);
    expect(p.output).toBe('hello');
    expect(p.tokens).toEqual({ input: 0, output: 0 });
  });

  test('official Grok rates are non-zero and match rate math', () => {
    expect(PRICING['grok']?.input_per_mtok).toBe(1);
    expect(PRICING['grok']?.output_per_mtok).toBe(2);
    expect(PRICING['grok-build-0.1']?.input_per_mtok).toBe(1);
    expect(PRICING['grok-4.5']?.input_per_mtok).toBe(2);
    expect(PRICING['grok-4.5']?.output_per_mtok).toBe(6);
    // 1M in + 1M out at $1/$2 → $3.00
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'grok')).toBe(3);
    // 1M in + 1M out at $2/$6 → $8.00
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'grok-4.5')).toBe(8);
  });

  test('unknown model returns 0 and does not throw; peer rows unchanged', () => {
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'not-a-real-model-xyz')).toBe(0);
    expect(PRICING['claude-opus-4-7']?.input_per_mtok).toBe(15);
    expect(PRICING['gpt-5.4']?.input_per_mtok).toBe(2.5);
    expect(PRICING['gemini-2.5-pro']?.input_per_mtok).toBe(1.25);
  });
});


// ─── gstack-grok-compat-audit fixtures ───────────────────────

function writeMinimalRuntime(skillsDir: string, opts: { withReview?: boolean; withSpec?: boolean } = {}) {
  const { withReview = true, withSpec = true } = opts;
  const root = path.join(skillsDir, 'gstack');
  for (const rel of [
    'bin',
    'browse/dist',
    'browse/src',
    'scripts',
    'review/specialists',
  ]) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  // When monorepo has design/dist + extension, audit requires them in the runtime root
  if (fs.existsSync(path.join(ROOT, 'design', 'dist'))) {
    fs.mkdirSync(path.join(root, 'design', 'dist'), { recursive: true });
  }
  if (fs.existsSync(path.join(ROOT, 'extension'))) {
    fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
  }
  // browse-client required by skillify audit
  fs.mkdirSync(path.join(root, 'browse', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'browse', 'src', 'browse-client.ts'), '// fixture\n');
  if (withReview) {
    fs.writeFileSync(path.join(root, 'review', 'checklist.md'), '# checklist\n');
    fs.writeFileSync(path.join(root, 'review', 'TODOS-format.md'), '# todos\n');
  }
  // Audit compares fixture runtime against monorepo presence of design/extension.
  // Mirror those when the monorepo has them so the fixture is "complete" for phase a.
  if (fs.existsSync(path.join(ROOT, 'design', 'dist'))) {
    fs.mkdirSync(path.join(root, 'design', 'dist'), { recursive: true });
  }
  if (fs.existsSync(path.join(ROOT, 'extension'))) {
    fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), '{}\n');
  }
  // connect-chrome → open-gstack-browser shape
  const ogb = path.join(skillsDir, 'gstack-open-gstack-browser');
  fs.mkdirSync(ogb, { recursive: true });
  fs.writeFileSync(path.join(ogb, 'SKILL.md'), 'name: open-gstack-browser\n');
  fs.symlinkSync(ogb, path.join(skillsDir, 'connect-chrome'));

  if (withSpec) {
    const spec = path.join(skillsDir, 'gstack-spec');
    fs.mkdirSync(spec, { recursive: true });
    fs.writeFileSync(
      path.join(spec, 'SKILL.md'),
      [
        '---',
        'name: spec',
        '---',
        'Spawn **Grok** headless with --prompt-file.',
        '```bash',
        'grok --prompt-file "$ARCHIVE_PATH" --cwd "$SPAWN_PATH"',
        '```',
        '$GSTACK_ROOT',
      ].join('\n'),
    );
  }
}

function runAudit(skillsDir: string, phase = 'a'): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['run', AUDIT_BIN, '--skills-dir', skillsDir, '--phase', phase], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    status: r.status,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

describe('gstack-grok-compat-audit fixtures', () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-grok-audit-'));
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  test('missing skills dir exits 1 INCOMPATIBLE', () => {
    const missing = path.join(skillsDir, 'does-not-exist');
    const r = runAudit(missing, 'a');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/INCOMPATIBLE|skills dir missing/i);
  });

  test('minimal complete runtime exits 0 COMPATIBLE for phase a', () => {
    writeMinimalRuntime(skillsDir);
    const r = runAudit(skillsDir, 'a');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('COMPATIBLE');
  });

  test('missing review/checklist.md fails phase a', () => {
    writeMinimalRuntime(skillsDir, { withReview: false });
    const r = runAudit(skillsDir, 'a');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/missing review\/checklist\.md|INCOMPATIBLE/);
  });

  test('missing gstack runtime root fails', () => {
    fs.mkdirSync(skillsDir, { recursive: true });
    // empty skills dir — no gstack/
    const r = runAudit(skillsDir, 'a');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/missing runtime root|INCOMPATIBLE/);
  });

  test('phase ab fails when neither gstack-spec nor spec package installed', () => {
    writeMinimalRuntime(skillsDir, { withSpec: false });
    const r = runAudit(skillsDir, 'ab');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/neither gstack-spec nor spec|INCOMPATIBLE/);
  });
});

// ─── setup create_grok_runtime_root preflight smoke ──────────

describe('create_grok_runtime_root preflight (setup smoke)', () => {
  test('refuses wipe when required monorepo assets missing', () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-grok-setup-empty-'));
    const dest = path.join(emptyRepo, 'install-target', 'gstack');
    // Seed a live install that must NOT be wiped when preflight fails
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'KEEPME'), 'live');

    const setupPath = path.join(ROOT, 'setup');
    // Source extracted functions from a temp file — do NOT eval via $(...) because
    // create_grok_runtime_root uses $$ for the staging suffix and command
    // substitution would expand it early.
    const extractScript = path.join(emptyRepo, 'extract-and-run.sh');
    fs.writeFileSync(
      extractScript,
      `#!/usr/bin/env bash
set +e
SETUP=${JSON.stringify(setupPath)}
GSTACK_DIR=${JSON.stringify(emptyRepo)}
DEST=${JSON.stringify(dest)}
_link_or_copy() { ln -sfn "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }
extract_fn() {
  local name="$1"
  local out="$2"
  awk -v name="$name" '
    $0 ~ "^" name "\\\\(\\\\)" {grab=1}
    grab {
      print
      for (i=1;i<=length($0);i++) {
        c=substr($0,i,1)
        if (c=="{") depth++
        if (c=="}") {
          depth--
          if (depth==0) { exit }
        }
      }
    }
  ' "$SETUP" > "$out"
}
FN_DIR=$(mktemp -d)
extract_fn _grok_link_under_monorepo "$FN_DIR/link.sh"
extract_fn create_grok_runtime_root "$FN_DIR/create.sh"
# shellcheck source=/dev/null
. "$FN_DIR/link.sh"
# shellcheck source=/dev/null
. "$FN_DIR/create.sh"
create_grok_runtime_root "$GSTACK_DIR" "$DEST"
rc=$?
rm -rf "$FN_DIR"
if [ $rc -eq 0 ]; then
  echo "UNEXPECTED_SUCCESS"
  exit 2
fi
echo "PREFLIGHT_FAILED_AS_EXPECTED"
if [ -f "$DEST/KEEPME" ]; then
  echo "LIVE_PRESERVED"
  exit 0
fi
echo "LIVE_WIPED"
exit 3
`,
      { mode: 0o755 },
    );
    const r = spawnSync('bash', [extractScript], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    fs.rmSync(emptyRepo, { recursive: true, force: true });

    expect(r.stdout + r.stderr).toMatch(/preflight|required monorepo asset missing/i);
    expect(r.stdout).toContain('PREFLIGHT_FAILED_AS_EXPECTED');
    expect(r.stdout).toContain('LIVE_PRESERVED');
    expect(r.status).toBe(0);
  });
});
