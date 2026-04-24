/**
 * Secret-sink test harness (D21 #5, D1-eng contract).
 *
 * Runs a bin with a seeded secret, captures every channel the bin could
 * leak through, and asserts that the seed never appears. Used by Slice 6
 * tests and available for future skills that handle secrets.
 *
 * Channels covered:
 *   - stdout (Bun.spawn pipe)
 *   - stderr (Bun.spawn pipe)
 *   - files written under a per-run $HOME (walked post-mortem)
 *   - telemetry JSONL under $HOME/.gstack/analytics/ (same walk, but called
 *     out separately for clearer test failures)
 *
 * Match rules (any hit = leak):
 *   - exact substring
 *   - URL-decoded substring (catches percent-encoded leaks)
 *   - first-12-char prefix (catches "we logged just a portion")
 *   - base64 encoding of the seed (catches auth-header leakage)
 *
 * Intentionally NOT covered in v1:
 *   - subprocess environment dump (portable /proc reading is non-trivial;
 *     bins rarely leak env without also writing to stdout/stderr)
 *   - the user's real shell history (bins don't modify it; the user's
 *     shell does)
 * Those are documented as follow-ups in the D21 eng review commentary.
 *
 * Positive-control discipline: every test suite using this harness should
 * include one test that deliberately leaks a seed and asserts the harness
 * catches it. A harness that silently under-reports is worse than no
 * harness.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SecretSinkOptions {
  bin: string;
  args: string[];
  /** Seeds whose presence in any captured channel = failure. */
  seeds: string[];
  env?: Record<string, string>;
  stdin?: string;
  /** Override the tmp $HOME. Default: fresh mkdtemp under os.tmpdir(). */
  tmpHome?: string;
  /** Cap on subprocess runtime, ms. Default 10_000. */
  timeoutMs?: number;
}

export interface Leak {
  channel: 'stdout' | 'stderr' | 'file' | 'telemetry';
  matchType: 'exact' | 'url-decoded' | 'prefix-12' | 'base64';
  /** For channel=file|telemetry: the path relative to tmpHome. */
  where?: string;
  /** Short excerpt around the match (for debugging). */
  excerpt: string;
}

export interface SinkResult {
  stdout: string;
  stderr: string;
  status: number;
  /** All files written under tmpHome during the run, keyed by relative path. */
  filesWritten: Record<string, string>;
  /** Subset of filesWritten matching .gstack/analytics/*.jsonl. */
  telemetry: Record<string, string>;
  /** Leaks discovered. Empty = clean. */
  leaks: Leak[];
  /** Where HOME was pointed during the run (for post-mortem inspection). */
  tmpHome: string;
}

export async function runWithSecretSink(opts: SecretSinkOptions): Promise<SinkResult> {
  const tmpHome = opts.tmpHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sink-'));
  // Make sure .gstack exists so bins that append to analytics have somewhere to write.
  fs.mkdirSync(path.join(tmpHome, '.gstack', 'analytics'), { recursive: true });

  const env = {
    // Minimal PATH that still finds jq/git/curl/sed so our bins work.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
    HOME: tmpHome,
    GSTACK_HOME: path.join(tmpHome, '.gstack'),
    ...(opts.env || {}),
  };

  const proc = Bun.spawn([opts.bin, ...opts.args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin ? 'pipe' : 'ignore',
  });
  if (opts.stdin) {
    proc.stdin!.write(opts.stdin);
    proc.stdin!.end();
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timeoutHandle = setTimeout(() => {
    try { proc.kill(); } catch { /* already done */ }
  }, timeoutMs);

  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeoutHandle);

  // Walk tmpHome and read all files (skip binaries / very large files).
  const filesWritten: Record<string, string> = {};
  const telemetry: Record<string, string> = {};
  walk(tmpHome, tmpHome, filesWritten);
  for (const [rel, content] of Object.entries(filesWritten)) {
    if (rel.startsWith('.gstack/analytics/') && rel.endsWith('.jsonl')) {
      telemetry[rel] = content;
    }
  }

  // Scan every channel for every seed with every match rule.
  const leaks: Leak[] = [];
  for (const seed of opts.seeds) {
    if (!seed) continue;
    const rules = buildMatchRules(seed);
    for (const { rule, matchType } of rules) {
      const stdoutHit = findHit(stdout, rule);
      if (stdoutHit !== null) {
        leaks.push({ channel: 'stdout', matchType, excerpt: excerptAt(stdout, stdoutHit) });
      }
      const stderrHit = findHit(stderr, rule);
      if (stderrHit !== null) {
        leaks.push({ channel: 'stderr', matchType, excerpt: excerptAt(stderr, stderrHit) });
      }
      for (const [rel, content] of Object.entries(filesWritten)) {
        const hit = findHit(content, rule);
        if (hit !== null) {
          const channel = rel.startsWith('.gstack/analytics/') ? 'telemetry' : 'file';
          leaks.push({ channel, matchType, where: rel, excerpt: excerptAt(content, hit) });
        }
      }
    }
  }

  return { stdout, stderr, status, filesWritten, telemetry, leaks, tmpHome };
}

function walk(root: string, dir: string, out: Record<string, string>) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > 1024 * 1024) continue; // skip huge files, unlikely to be secrets
    const rel = path.relative(root, full);
    try {
      out[rel] = fs.readFileSync(full, 'utf-8');
    } catch {
      // binary or unreadable — skip
    }
  }
}

function buildMatchRules(seed: string): Array<{ rule: string; matchType: Leak['matchType'] }> {
  const rules: Array<{ rule: string; matchType: Leak['matchType'] }> = [];
  rules.push({ rule: seed, matchType: 'exact' });

  // URL-decoded form — catches cases where the seed got percent-encoded
  // (e.g., a password with a '@' embedded in a connection string).
  try {
    const decoded = decodeURIComponent(seed);
    if (decoded !== seed) rules.push({ rule: decoded, matchType: 'url-decoded' });
  } catch {
    // malformed %-encoding in the seed itself; ignore
  }

  // First-12-char prefix — catches partial leaks like "we logged the
  // first 10 chars for debugging." Only applied to seeds >= 16 chars,
  // since shorter seeds would false-positive against normal words.
  if (seed.length >= 16) {
    rules.push({ rule: seed.slice(0, 12), matchType: 'prefix-12' });
  }

  // Base64 encoding — catches leaks through auth headers or config files
  // that encode the seed. Only for seeds >= 12 chars to reduce false
  // positives from short strings that happen to be valid base64.
  if (seed.length >= 12) {
    rules.push({ rule: Buffer.from(seed).toString('base64'), matchType: 'base64' });
  }

  return rules;
}

function findHit(haystack: string, needle: string): number | null {
  if (!needle) return null;
  const idx = haystack.indexOf(needle);
  return idx === -1 ? null : idx;
}

function excerptAt(s: string, idx: number): string {
  const start = Math.max(0, idx - 20);
  const end = Math.min(s.length, idx + 40);
  return s.slice(start, end).replace(/\n/g, '\\n');
}
