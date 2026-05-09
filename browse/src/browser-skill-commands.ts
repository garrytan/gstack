/**
 * $B skill subcommands — CLI surface for browser-skills.
 *
 * Subcommands:
 *   list                                       — list all skills, with resolved tier
 *   show <name>                                — print skill SKILL.md
 *   run <name> [--arg ...] [--timeout=Ns]      — spawn the skill script, return JSON
 *   test <name>                                — run script.test.ts via bun test
 *   rm <name> [--global]                       — tombstone a user-tier skill
 *
 * Load-bearing: spawnSkill mints a per-spawn scoped token (read+write scope)
 * and passes it via GSTACK_SKILL_TOKEN. The skill never sees the daemon root
 * token. Untrusted skills get a scrubbed env (no $HOME, $PATH minimal, no
 * secrets like $GITHUB_TOKEN/$OPENAI_API_KEY/etc.) and a locked cwd. Trusted
 * skills (frontmatter `trusted: true`) inherit the full process env.
 *
 * Output protocol: stdout = JSON, stderr = streaming logs, exit code 0/non-0.
 * stdout cap = 1MB (truncate + nonzero exit if exceeded). Default timeout 60s.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  listBrowserSkills,
  readBrowserSkill,
  tombstoneBrowserSkill,
  defaultTierPaths,
  type BrowserSkill,
  type TierPaths,
} from './browser-skills';
import { mintSkillToken, revokeSkillToken, generateSpawnId } from './skill-token';

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MB

// ─── Public command dispatcher ──────────────────────────────────

export interface SkillCommandContext {
  /** Daemon port the skill should connect back to. */
  port: number;
  /** Optional override of tier paths (tests pass synthetic dirs). */
  tiers?: TierPaths;
}

/**
 * Dispatch a `$B skill <subcommand>` invocation. Returns the response string
 * for the daemon to relay back to the CLI. Throws on invalid usage.
 */
export async function handleSkillCommand(args: string[], ctx: SkillCommandContext): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      return formatUsage();
    case 'list':
      return handleList(ctx);
    case 'show':
      return handleShow(rest, ctx);
    case 'run':
      return handleRun(rest, ctx);
    case 'test':
      return handleTest(rest, ctx);
    case 'rm':
      return handleRm(rest, ctx);
    default:
      throw new Error(`Unknown skill subcommand: "${sub}". Try: list, show, run, test, rm.`);
  }
}

function formatUsage(): string {
  return [
    'Usage: $B skill <subcommand>',
    '',
    '  list                                  List all skills with resolved tier',
    '  show <name>                           Print SKILL.md',
    '  run <name> [--arg k=v]... [--timeout=Ns]   Run the skill script',
    '  test <name>                           Run script.test.ts',
    '  rm <name> [--global]                  Tombstone a user-tier skill',
  ].join('\n');
}

// ─── list ───────────────────────────────────────────────────────

function handleList(ctx: SkillCommandContext): string {
  const tiers = ctx.tiers ?? defaultTierPaths();
  const skills = listBrowserSkills(tiers);
  if (skills.length === 0) {
    return 'No browser-skills found.\n\nTry: $B skill show <name>  (none right now)\n';
  }
  const lines: string[] = ['NAME                          TIER     HOST                        DESC'];
  for (const s of skills) {
    const desc = (s.frontmatter.description ?? '').slice(0, 40);
    lines.push(
      [
        s.name.padEnd(30),
        s.tier.padEnd(8),
        s.frontmatter.host.padEnd(28),
        desc,
      ].join(' '),
    );
  }
  return lines.join('\n') + '\n';
}

// ─── show ───────────────────────────────────────────────────────

function handleShow(args: string[], ctx: SkillCommandContext): string {
  const name = args[0];
  if (!name) throw new Error('Usage: $B skill show <name>');
  const tiers = ctx.tiers ?? defaultTierPaths();
  const skill = readBrowserSkill(name, tiers);
  if (!skill) throw new Error(`Skill "${name}" not found in any tier.`);
  return readFile(path.join(skill.dir, 'SKILL.md'));
}

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

// ─── run ────────────────────────────────────────────────────────

interface ParsedRunArgs {
  passthrough: string[];
  timeoutSeconds: number;
}

export function parseSkillRunArgs(args: string[]): ParsedRunArgs {
  const passthrough: string[] = [];
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--timeout=')) {
      const n = parseInt(a.slice('--timeout='.length), 10);
      if (!isNaN(n) && n > 0) timeoutSeconds = n;
      continue;
    }
    passthrough.push(a);
  }
  return { passthrough, timeoutSeconds };
}

async function handleRun(args: string[], ctx: SkillCommandContext): Promise<string> {
  const name = args[0];
  if (!name) throw new Error('Usage: $B skill run <name> [--arg k=v]... [--timeout=Ns]');
  const tiers = ctx.tiers ?? defaultTierPaths();
  const skill = readBrowserSkill(name, tiers);
  if (!skill) throw new Error(`Skill "${name}" not found.`);

  const { passthrough, timeoutSeconds } = parseSkillRunArgs(args.slice(1));
  const result = await spawnSkill({
    skill,
    skillArgs: passthrough,
    trusted: skill.frontmatter.trusted,
    timeoutSeconds,
    port: ctx.port,
  });

  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    const summary = result.truncated
      ? `truncated stdout at ${MAX_STDOUT_BYTES} bytes`
      : result.timedOut
        ? `timed out after ${timeoutSeconds}s`
        : `exit ${result.exitCode}`;
    const err = new Error(`Skill "${name}" failed: ${summary}\n--- stderr ---\n${result.stderr.slice(0, 4096)}`);
    (err as any).exitCode = result.exitCode || 1;
    throw err;
  }
  return result.stdout;
}

// ─── test ───────────────────────────────────────────────────────

async function handleTest(args: string[], ctx: SkillCommandContext): Promise<string> {
  const name = args[0];
  if (!name) throw new Error('Usage: $B skill test <name>');
  const tiers = ctx.tiers ?? defaultTierPaths();
  const skill = readBrowserSkill(name, tiers);
  if (!skill) throw new Error(`Skill "${name}" not found.`);

  const testFile = path.join(skill.dir, 'script.test.ts');
  if (!fs.existsSync(testFile)) {
    throw new Error(`Skill "${name}" has no script.test.ts at ${testFile}`);
  }

  const proc = Bun.spawn(['bun', 'test', testFile], {
    cwd: skill.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const exitCode = await proc.exited;
  const stdout = proc.stdout ? await new Response(proc.stdout).text() : '';
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : '';
  if (exitCode !== 0) {
    throw new Error(`Skill "${name}" tests failed (exit ${exitCode}).\n${stderr}`);
  }
  return stderr || stdout || `tests passed for "${name}"`;
}

// ─── rm ─────────────────────────────────────────────────────────

function handleRm(args: string[], ctx: SkillCommandContext): string {
  const name = args[0];
  if (!name) throw new Error('Usage: $B skill rm <name> [--global]');
  const isGlobal = args.includes('--global');
  const tier: 'project' | 'global' = isGlobal ? 'global' : 'project';

  const tiers = ctx.tiers ?? defaultTierPaths();
  // For UX: if no project tier exists at all, default to global.
  const effectiveTier: 'project' | 'global' = (tier === 'project' && !tiers.project) ? 'global' : tier;

  const dst = tombstoneBrowserSkill(name, effectiveTier, tiers);
  return `Tombstoned "${name}" (${effectiveTier} tier) → ${dst}\n`;
}

// ─── spawnSkill (load-bearing) ──────────────────────────────────

export interface SpawnSkillOptions {
  skill: BrowserSkill;
  skillArgs: string[];
  trusted: boolean;
  timeoutSeconds: number;
  port: number;
}

export interface SpawnSkillResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Spawn a skill script as a child process.
 *
 * 1. Mint a scoped token (read+write only; expires at timeout + 30s slack).
 * 2. Build the env: trusted=true → process.env; trusted=false → scrubbed.
 *    GSTACK_PORT and GSTACK_SKILL_TOKEN are always set.
 * 3. Spawn `bun run script.ts -- <args>` with cwd=skill.dir.
 * 4. Capture stdout (capped at 1MB) and stderr; enforce timeout.
 * 5. On exit/timeout, revoke the token. Always.
 */
export async function spawnSkill(opts: SpawnSkillOptions): Promise<SpawnSkillResult> {
  const spawnId = generateSpawnId();
  const tokenInfo = mintSkillToken({
    skillName: opts.skill.name,
    spawnId,
    spawnTimeoutSeconds: opts.timeoutSeconds,
  });

  try {
    const env = buildSpawnEnv({
      trusted: opts.trusted,
      port: opts.port,
      skillToken: tokenInfo.token,
    });
    const scriptPath = path.join(opts.skill.dir, 'script.ts');
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Skill "${opts.skill.name}" missing script.ts at ${scriptPath}`);
    }

    const proc = Bun.spawn(['bun', 'run', scriptPath, '--', ...opts.skillArgs], {
      cwd: opts.skill.dir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, opts.timeoutSeconds * 1000);

    const stdoutPromise = readCapped(proc.stdout, MAX_STDOUT_BYTES);
    const stderrPromise = readCapped(proc.stderr, MAX_STDOUT_BYTES);

    const exitCode = await proc.exited;
    clearTimeout(killer);

    const stdoutResult = await stdoutPromise;
    const stderrResult = await stderrPromise;

    return {
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
      truncated: stdoutResult.truncated,
    };
  } finally {
    revokeSkillToken(opts.skill.name, spawnId);
  }
}

interface CappedRead { text: string; truncated: boolean; }

async function readCapped(stream: ReadableStream<Uint8Array> | undefined, capBytes: number): Promise<CappedRead> {
  if (!stream) return { text: '', truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > capBytes) {
        truncated = true;
        // Take only what fits; drop the rest of the stream (release reader).
        const fits = value.length - (total - capBytes);
        if (fits > 0) chunks.push(value.subarray(0, fits));
        try { await reader.cancel(); } catch {}
        break;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  return { text: buf.toString('utf-8'), truncated };
}

// ─── env construction (security-critical) ───────────────────────

/**
 * Env keys ALWAYS scrubbed for untrusted skills. These represent secrets,
 * authority, or developer-environment context that an agent-authored script
 * should not see.
 */
const SECRET_KEY_PATTERNS = [
  /TOKEN/i, /KEY/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i,
  /^AWS_/, /^AZURE_/, /^GCP_/, /^GOOGLE_APPLICATION_/,
  /^ANTHROPIC_/, /^OPENAI_/, /^GITHUB_/, /^GH_/,
  /^SSH_/, /^GPG_/,
  /^NPM_TOKEN/, /^PYPI_/,
];

/**
 * Allowlist for untrusted spawns. Anything not in this list is dropped.
 * Includes: minimal PATH, locale, terminal type. Skills get GSTACK_PORT +
 * GSTACK_SKILL_TOKEN injected separately.
 */
const UNTRUSTED_ALLOWLIST = new Set([
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM',
  'TZ',
]);

interface BuildEnvOptions {
  trusted: boolean;
  port: number;
  skillToken: string;
}

export function buildSpawnEnv(opts: BuildEnvOptions): Record<string, string> {
  const out: Record<string, string> = {};

  if (opts.trusted) {
    // Trusted: pass through process.env, but always strip the daemon root token
    // if the parent had one in env (defense in depth).
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'GSTACK_TOKEN') continue; // never propagate root token
      out[k] = v;
    }
    // Set a minimal PATH if missing.
    if (!out.PATH) out.PATH = '/usr/local/bin:/usr/bin:/bin';
  } else {
    // Untrusted: minimal allowlist.
    for (const k of UNTRUSTED_ALLOWLIST) {
      const v = process.env[k];
      if (v !== undefined) out[k] = v;
    }
    // Provide a minimal PATH so `bun` is findable. Prefer the resolved bun dir
    // so scripts using a custom Bun install still work, but otherwise fall back
    // to /usr/local/bin:/usr/bin:/bin.
    out.PATH = resolveMinimalPath();
  }

  // Drop anything that pattern-matches a secret. (Trusted path can have secrets
  // intentionally — e.g. an internal-tool skill — but we still strip GSTACK_TOKEN
  // above.)
  if (!opts.trusted) {
    for (const k of Object.keys(out)) {
      if (SECRET_KEY_PATTERNS.some(p => p.test(k))) delete out[k];
    }
  }

  // Inject the daemon connection (always last so callers can't override).
  out.GSTACK_PORT = String(opts.port);
  out.GSTACK_SKILL_TOKEN = opts.skillToken;

  return out;
}

function resolveMinimalPath(): string {
  // Prefer the directory bun lives in; fall back to standard system dirs.
  const fallback = '/usr/local/bin:/usr/bin:/bin';
  const bunPath = process.execPath;
  if (bunPath && bunPath.includes('/bun')) {
    const dir = path.dirname(bunPath);
    return `${dir}:${fallback}`;
  }
  return fallback;
}
