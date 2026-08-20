/**
 * Static-grep tripwire for egress-receipt wiring. Free tier — no API.
 *
 * THREAT MODEL: the egress ledger is forensic observability — it records
 * ATTEMPTED egress so accidents are auditable; it is not an exfiltration
 * control. Receipts are written before send, outcomes are best-effort, and
 * fail-open classes can send unrecorded with a warning.
 *
 * Every enumerated off-machine sink must route its send through the receipt
 * ledger (lib/egress-receipt.ts), receipt BEFORE send. A future egress call
 * site added without a receipt fails CI here instead of becoming a
 * user-filed issue. The NEW-SINK SCANNER at the bottom sweeps the whole
 * tree for outbound network ops and requires every hit to be either wired
 * or in the REASONED exemption list — there is no KNOWN_UNWIRED bucket.
 *
 * Out of scope, documented here on purpose: the preamble-generated brain
 * sync block (scripts/resolvers/preamble/generate-brain-sync-block.ts)
 * renders a `git fetch` into skill PROSE that the agent executes — it is
 * agent-executed instructions, not a gstack binary, so it is covered by the
 * skill-prose exemption below rather than a receipt.
 *
 * Pattern mirrors test/hermetic-wiring.test.ts: read source files as text,
 * assert invariants on their contents. Brittle by design — renaming a
 * helper must force the author to look here.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.path, '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

// ── POLARITY TABLE (amendments T3/C8) ──────────────────────────────────────
// Pinned as data: which sinks refuse the send when the receipt cannot be
// written (fail-closed) vs warn and proceed (fail-open). Changing a sink's
// polarity is a security decision — update this table deliberately.
const POLARITY: Record<string, 'fail-closed' | 'fail-open'> = {
  // fail-closed: gstack state leaving the machine unrecorded is worse than
  // the operation failing.
  'brain-sync': 'fail-closed',
  'memory-ingest': 'fail-closed',
  'gbrain-sync': 'fail-closed',
  'telemetry-sync': 'fail-closed',
  'browse-tunnel (ngrok)': 'fail-closed',
  'gbrain-mcp-verify': 'fail-closed',
  'supabase-provision': 'fail-closed',
  // fail-open: user-facing operations that must not die over an audit-log
  // hiccup; they warn on stderr and proceed.
  'design-openai': 'fail-open',
  'update-check': 'fail-open',
  'security-dashboard': 'fail-open',
  'community-dashboard': 'fail-open',
  'git-class user ops (artifacts-init, brain-restore, session-update)': 'fail-open',
  'context-bill --exact': 'fail-open',
};

/** TS sinks: must import the canonical helper and call writeReceipt(). */
const MODULE_SINKS = [
  'bin/gstack-gbrain-sync.ts',
  'bin/gstack-memory-ingest.ts',
  'browse/src/server.ts',
  // Code-intelligence adapters (fork port wave 2): the gbrain adapter shells
  // repo content to the user's gbrain DB and the Sourcebot adapter POSTs
  // queries to a self-hosted HTTP endpoint — both sensitive-class
  // (repo-content) sinks, fail-closed. Registered so a refactor that drops
  // their writeReceipt calls fails CI, not just the tree-sweep scanner.
  'lib/code-intelligence/gbrain-adapter.ts',
  'lib/code-intelligence/sourcebot-adapter.ts',
  // Unconditional: context-bill ships in the same tree as this tripwire. A
  // missing file must fail loudly (a rename/move that drops its receipt wiring
  // is exactly what this pins), not silently soften the assertion.
  'lib/context-bill.ts',
  // supabase-provision engine (bin/gstack-gbrain-supabase-provision is a thin
  // bun-shebang entry over this module; the receipt lives at the api-call layer).
  'lib/gbrain-supabase-provision.ts',
];

/** Shell sinks: must source the shared lib; every network op receipted. */
const SHELL_SINKS = [
  'bin/gstack-telemetry-sync',
  'bin/gstack-update-check',
  'bin/gstack-brain-sync',
  'bin/gstack-gbrain-mcp-verify',
  'bin/gstack-security-dashboard',
  'bin/gstack-community-dashboard',
  'bin/gstack-artifacts-init',
  'bin/gstack-brain-restore',
  'bin/gstack-session-update',
];

/** design files that talk to api.openai.com — all must use receiptedFetch. */
const DESIGN_SINKS = [
  'design/src/generate.ts',
  'design/src/variants.ts',
  'design/src/iterate.ts',
  'design/src/evolve.ts',
  'design/src/check.ts',
  'design/src/diff.ts',
  'design/src/design-to-code.ts',
  'design/src/memory.ts',
];

// ── NEW-SINK SCANNER exemptions ────────────────────────────────────────────
// Every entry carries its reason. An unexplained network op anywhere in the
// swept tree fails the scanner — add real sinks to the wired lists above,
// not here.
const SCANNER_EXEMPT: Record<string, string> = {
  'bin/gstack-team-init':
    'every git clone is inside an echoed instruction string (install docs); the script executes no network ops',
  'bin/gstack-gbrain-install':
    'user-invoked installer: bodyless HEAD reachability probe to github.com + clone of the public gbrain repo (user-directed install; no gstack state leaves the machine)',
  'bin/gstack-next-version':
    'fetches the user\'s own repo\'s base branch for version-claim freshness — a user-repo dev-workflow op, not gstack-state egress',
  'bin/gstack-version-bump':
    'git fetch appears only in an error-message string',
  'bin/gstack-redact-prepush':
    'git push mentions are hook documentation strings (bypass instructions)',
  'browse/src/security-classifier.ts':
    'HF model download: bodyless GET of a public classifier model (variable URL)',
  'browse/src/write-commands.ts':
    'user-directed page fetch — the browser command surface fetches what the user asked for',
  'browse/src/cli.ts':
    'health probe of the user\'s own pair-agent tunnel URL (reachability probe)',
  'browse/src/commands.ts':
    'git pull appears only in an upgrade-hint message string',
  'browse/src/cookie-picker-ui.ts':
    'served-page JS talking to its own loopback server (same-origin relative fetch)',
  'design/src/compare.ts':
    'served-page JS talking to its own loopback server (relative ./api fetch)',
  // Skill prose templates: these render agent-executed instructions (the
  // agent runs git in the USER\'S repo at the user\'s direction), they are
  // not gstack binaries. Includes the preamble-generated brain-sync block —
  // see the header.
  'scripts/resolvers':
    'skill prose templates — agent-executed instructions rendered into SKILL.md, not gstack binaries',
};

function isExempt(rel: string): string | undefined {
  for (const [key, reason] of Object.entries(SCANNER_EXEMPT)) {
    if (rel === key || rel.startsWith(`${key}/`)) return reason;
  }
  return undefined;
}

// Receipt markers that make a nearby network op "wired".
const RECEIPT_MARKER =
  /_receipted_(curl|git|version_fetch)\b|gstack-egress-receipt["']?\s+write\b|writeReceipt\(|receiptedFetch\(/;

/** Was a receipt marker present on this line or the 30 preceding lines? */
function guarded(lines: string[], i: number): boolean {
  for (let j = i; j >= Math.max(0, i - 30); j--) {
    if (RECEIPT_MARKER.test(lines[j])) return true;
  }
  return false;
}

// git as a COMMAND followed by a remote op. Local ops (rev-parse, remote
// get-url, add, commit, merge) never match; neither does prose like
// "curated-memory-git-push" (hyphenated) or "'git fetch'" (quoted).
const GIT_REMOTE_OP = /(^|[;|&`($!]|\s)git(\s+-C\s+\S+)?\s+(push|pull|fetch|clone|ls-remote)\b/;
// git spawn-array form in TS: spawn("git", ["push", ...]).
const GIT_SPAWN_OP = /["'`]git["'`]\s*,\s*\[\s*["'`](push|pull|fetch|clone|ls-remote)/;
// curl as a command token.
const CURL_OP = /(^|[|&;(`]|\s|\$\()curl\s/;
// fetch() with an absolute http(s) URL (loopback filtered separately).
const FETCH_ABS = /(^|[^A-Za-z])fetch(Fn|Impl)?\(\s*[`'"]https?:\/\//;

function isTextFile(full: string): boolean {
  try {
    const buf = fs.readFileSync(full);
    return !buf.subarray(0, 1024).includes(0);
  } catch {
    return false;
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Collect un-receipted outbound network ops in a file. Skips comments,
 * loopback lines, `command -v` probes, message-emitting lines, and shell
 * heredoc bodies (echoed instructions are not executed ops).
 */
function scanFile(rel: string): string[] {
  const src = read(rel);
  const isTs = /\.(ts|js|mjs|tsx)$/.test(rel);
  const lines = src.split('\n');
  const offenders: string[] = [];
  let heredocEnd: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    if (!isTs) {
      const heredoc = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
      if (heredoc) heredocEnd = heredoc[1];
    }
    const trimmed = line.trimStart();
    if (/^(#|\/\/|\*|\/\*)/.test(trimmed)) continue;
    if (line.includes('127.0.0.1') || line.includes('localhost')) continue;
    if (/command -v/.test(line)) continue;
    if (/^(echo|printf|emit|die|fail|log)\b/.test(trimmed)) continue;

    // TS: shell-style git ops only count on lines that actually execute
    // something (spawn/exec markers) — template-literal prose does not.
    const tsExecGit =
      GIT_SPAWN_OP.test(line) ||
      (GIT_REMOTE_OP.test(line) && /\b(spawn|spawnSync|exec|execSync|execFileSync|runCommand)\b/.test(line));
    const isNetOp = isTs
      ? FETCH_ABS.test(line) || tsExecGit
      : CURL_OP.test(line) || GIT_REMOTE_OP.test(line);
    if (!isNetOp) continue;
    if (guarded(lines, i)) continue;
    offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
  }
  return offenders;
}

describe('egress receipt wiring tripwire', () => {
  test('every TS sink imports lib/egress-receipt and calls writeReceipt()', () => {
    for (const rel of MODULE_SINKS) {
      const src = read(rel);
      expect(src.includes('egress-receipt'), `${rel}: must import lib/egress-receipt`).toBe(true);
      expect(src.includes('writeReceipt('), `${rel}: must call writeReceipt() before its send`).toBe(true);
    }
  });

  test('every shell sink sources gstack-egress-lib.sh', () => {
    for (const rel of SHELL_SINKS) {
      const src = read(rel);
      expect(
        src.includes('gstack-egress-lib.sh'),
        `${rel}: must source bin/gstack-egress-lib.sh for _receipted_* helpers`,
      ).toBe(true);
    }
  });

  test('every network op in a wired shell sink sits under a receipt', () => {
    const offenders = SHELL_SINKS.flatMap((rel) => scanFile(rel));
    expect(
      offenders,
      'un-receipted network call(s) — wrap in _receipted_curl/_receipted_git or write the receipt first:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  test('browse tunnel: every ngrok.forward() has a writeReceipt in the 30 preceding lines', () => {
    const lines = read('browse/src/server.ts').split('\n');
    const offenders: string[] = [];
    let sawForward = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('ngrok.forward(')) continue;
      if (/^\s*(\/\/|\*)/.test(lines[i])) continue;
      sawForward = true;
      const context = lines.slice(Math.max(0, i - 30), i).join('\n');
      if (!context.includes('writeReceipt(')) offenders.push(`browse/src/server.ts:${i + 1}`);
    }
    expect(sawForward, 'expected ngrok.forward call sites in server.ts').toBe(true);
    expect(offenders, 'tunnel session opened without a receipt: ' + offenders.join(', ')).toEqual([]);
  });

  test('design: every api.openai.com call routes through receiptedFetch', () => {
    for (const rel of DESIGN_SINKS) {
      const src = read(rel);
      expect(
        src.includes('receipted-fetch'),
        `${rel}: must import design/src/receipted-fetch`,
      ).toBe(true);
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('api.openai.com')) continue;
        if (/^\s*(\/\/|\*)/.test(lines[i])) continue;
        if (/\bfetch(Fn|Impl)?\(/.test(lines[i])) {
          throw new Error(
            `${rel}:${i + 1}: raw fetch to api.openai.com — route it through receiptedFetch()`,
          );
        }
      }
    }
  });

  test('deprecated dead-endpoint brain consumer/reader scripts stay deleted', () => {
    // lstat (not existsSync) so a dangling symlink also fails.
    for (const rel of ['bin/gstack-brain-consumer', 'bin/gstack-brain-reader']) {
      let present = true;
      try {
        fs.lstatSync(path.join(ROOT, rel));
      } catch {
        present = false;
      }
      expect(present, `${rel} was deleted (dead /ingest-repo egress sink) — do not resurrect`).toBe(false);
    }
  });

  test('polarity table names every wired sink exactly once per polarity', () => {
    const closed = Object.entries(POLARITY).filter(([, p]) => p === 'fail-closed').map(([s]) => s);
    const open = Object.entries(POLARITY).filter(([, p]) => p === 'fail-open').map(([s]) => s);
    expect(closed.sort()).toEqual([
      'brain-sync',
      'browse-tunnel (ngrok)',
      'gbrain-mcp-verify',
      'gbrain-sync',
      'memory-ingest',
      'supabase-provision',
      'telemetry-sync',
    ]);
    expect(open.sort()).toEqual([
      'community-dashboard',
      'context-bill --exact',
      'design-openai',
      'git-class user ops (artifacts-init, brain-restore, session-update)',
      'security-dashboard',
      'update-check',
    ]);
  });

  test('polarity spot-checks: closed sinks refuse, open sinks warn', () => {
    // telemetry-sync (closed): the wrapped POST uses the `closed` policy.
    expect(read('bin/gstack-telemetry-sync')).toMatch(/_receipted_curl closed telemetry-sync/);
    // brain-sync (closed): refusal exits before the commit consumes the queue.
    expect(read('bin/gstack-brain-sync')).toMatch(/gstack-egress-receipt["']? write/);
    // update-check (open).
    expect(read('bin/gstack-update-check')).toMatch(/_receipted_curl open update-check/);
    // dashboards (open).
    expect(read('bin/gstack-security-dashboard')).toMatch(/_receipted_curl open security-dashboard/);
    expect(read('bin/gstack-community-dashboard')).toMatch(/_receipted_curl open community-dashboard/);
    // mcp-verify (closed).
    expect(read('bin/gstack-gbrain-mcp-verify')).toMatch(/_receipted_curl closed gbrain-mcp-verify/);
    // supabase-provision (closed): TS module — the receipt is written before
    // the fetch, and a receipt failure refuses the send (fail-closed, exit 8).
    const provision = read('lib/gbrain-supabase-provision.ts');
    expect(provision).toMatch(/sink:\s*['"]supabase-provision['"]/);
    expect(provision).toContain('fail-closed');
    expect(provision.indexOf('writeReceipt(')).toBeGreaterThan(0);
    expect(provision.indexOf('writeReceipt(')).toBeLessThan(provision.indexOf('ctx.fetchImpl('));
    // design (open): the wrapper catches receipt errors and proceeds.
    const rf = read('design/src/receipted-fetch.ts');
    expect(rf).toContain('fail-open');
    expect(rf.indexOf('writeReceipt(')).toBeLessThan(rf.indexOf('fetchImpl(url, init)'));
  });

  test('NEW-SINK SCANNER: every outbound network op in the tree is wired or reasoned-exempt', () => {
    const SWEEP = ['bin', 'lib', 'scripts', 'design/src', 'browse/src'];
    const offenders: string[] = [];
    for (const dirRel of SWEEP) {
      const dir = path.join(ROOT, dirRel);
      if (!fs.existsSync(dir)) continue;
      for (const full of walk(dir)) {
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (!/\.(ts|js|mjs|sh|tsx)$/.test(rel) && !isTextFile(full)) continue;
        if (isExempt(rel)) continue;
        offenders.push(...scanFile(rel));
      }
    }
    expect(
      offenders,
      'unwired outbound network op(s). Wire each through the receipt helpers ' +
        '(_receipted_curl/_receipted_git in shell, writeReceipt/receiptedFetch in TS) ' +
        'or add a REASONED exemption with the honest why:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  test('shebang tripwire: no bin/gstack-* file carries a node shebang (amendment 2A)', () => {
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(path.join(ROOT, 'bin'))) {
      if (!entry.startsWith('gstack-')) continue;
      const full = path.join(ROOT, 'bin', entry);
      if (!fs.lstatSync(full).isFile()) continue;
      if (!isTextFile(full)) continue;
      const firstLine = fs.readFileSync(full, 'utf-8').split('\n', 1)[0];
      if (firstLine.startsWith('#!') && /\bnode\b/.test(firstLine)) {
        offenders.push(`bin/${entry}: ${firstLine}`);
      }
    }
    expect(offenders, 'node shebangs in bin/ (use #!/usr/bin/env bun): ' + offenders.join(', ')).toEqual([]);
  });
});
