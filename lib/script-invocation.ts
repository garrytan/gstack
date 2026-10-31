/**
 * script-invocation — the one way gstack's TypeScript runs its own shebang
 * bins and `bash -c` strings (#3197).
 *
 * Windows has no shebangs: Bun's spawnSync cannot execute an extensionless
 * `#!/usr/bin/env bash` script (`bin/gstack-wtree`, `gstack-slug`) or a
 * `#!/usr/bin/env bun` one (`gstack-redact`), and `shell: true` does not help
 * (cmd.exe has no idea what a shebang is). So:
 *   - bun-shebang bins run as `<bun> <script>` on every platform, `<bun>`
 *     being the running Bun (process.execPath) or, inside a compiled binary,
 *     the `bun` on PATH;
 *   - bash-shebang bins and `bash -c` strings exec directly on POSIX and go
 *     through the resolved Git Bash on Windows.
 *
 * Windows bash resolution, in order (one fixture table,
 * test/fixtures/windows-bash-resolution.json, pins it):
 *   1. GSTACK_GIT_BASH (canonical; the name setup.ps1 reads), GSTACK_BASH as
 *      a deprecated alias at the same precedence. GSTACK_GIT_BASH wins when
 *      both are set; a warning prints once when they differ. An override that
 *      does not exist is refused, never silently skipped.
 *   2. bash next to `git --exec-path` (resolves through scoop-style shims,
 *      per-user and portable Git).
 *   3. The known install paths.
 *   4. A PATH `bash` only when `uname -s` reports MSYS or MINGW. System32 and
 *      WindowsApps `bash.exe` are WSL launchers and are rejected unprobed.
 *   5. Otherwise a refusal listing each candidate with its rejection reason
 *      and naming GSTACK_GIT_BASH (BASH_UNAVAILABLE).
 * Paths are forward-slashed: Bun's spawnSync on Windows returns ENOENT for a
 * backslash exe path containing spaces, and bash reads backslashes as escapes.
 */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunIsolationArgs } from './bun-isolation';
import { resultLine } from './result-codes';

export const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

export interface BashProbe {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  /** `git --exec-path`; the default asks git only on a real Windows host. */
  gitExecPath?: () => string | null;
  which?: (cmd: string) => string | null;
  /** `uname -s` as the candidate bash reports it. */
  uname?: (bash: string) => string | null;
}

export interface BashCandidate { path: string; source: string; rejected: string | null }

export type BashResolution =
  | { ok: true; bash: string; source: string; tried: BashCandidate[]; warning?: string }
  | { ok: false; tried: BashCandidate[]; message: string; warning?: string };

const slash = (p: string) => p.replace(/\\/g, '/');
const WSL_LAUNCHER = /\/(?:windows\/(?:system32|sysnative)|microsoft\/windowsapps)\//i;
const GIT_ROOT_FROM_EXEC_PATH = /^(.*)\/(?:mingw64|mingw32|clangarm64|clang64|ucrt64|usr\/lib)\/(?:libexec\/)?git-core$/i;

function knownInstalls(env: NodeJS.ProcessEnv): string[] {
  return [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    ...(env.LOCALAPPDATA ? [`${slash(env.LOCALAPPDATA)}/Programs/Git/bin/bash.exe`] : []),
    ...(env.USERPROFILE ? [`${slash(env.USERPROFILE)}/scoop/apps/git/current/bin/bash.exe`] : []),
  ];
}

function defaultGitExecPath(): string | null {
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function defaultUname(bash: string): string | null {
  const r = spawnSync(bash, ['-c', 'uname -s'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** The refusal text shared by every consumer (scripts, gbrain sync, the doctor). */
export function noBashMessage(tried: readonly BashCandidate[]): string {
  const list = tried.map(c => `${c.source} ${c.path}: ${c.rejected}`).join('; ');
  return resultLine('gstack', 'BASH_UNAVAILABLE', `tried ${list}`);
}

export function resolveWindowsBash(o: BashProbe = {}): BashResolution {
  const env = o.env ?? process.env;
  const exists = o.exists ?? fs.existsSync;
  const live = process.platform === 'win32';
  const tried: BashCandidate[] = [];
  const canonical = env.GSTACK_GIT_BASH?.trim();
  const alias = env.GSTACK_BASH?.trim();
  const warning = canonical && alias && slash(canonical) !== slash(alias)
    ? `gstack: GSTACK_GIT_BASH (${canonical}) and the deprecated GSTACK_BASH (${alias}) differ; using GSTACK_GIT_BASH`
    : undefined;
  const found = (bash: string, source: string): BashResolution => {
    tried.push({ path: bash, source, rejected: null });
    return { ok: true, bash, source, tried, warning };
  };
  const refuse = (): BashResolution => ({ ok: false, tried, message: noBashMessage(tried), warning });

  const override = canonical || alias;
  if (override) {
    const source = canonical ? 'GSTACK_GIT_BASH' : 'GSTACK_BASH';
    if (exists(slash(override))) return found(slash(override), source);
    tried.push({ path: slash(override), source, rejected: 'does not exist' });
    return refuse();
  }
  tried.push({ path: '(unset)', source: 'GSTACK_GIT_BASH', rejected: 'not set' });

  const seen = new Set<string>();
  const execPath = (o.gitExecPath ?? (live ? defaultGitExecPath : () => null))();
  const root = execPath ? GIT_ROOT_FROM_EXEC_PATH.exec(slash(execPath).replace(/\/+$/, ''))?.[1] : undefined;
  if (!execPath) tried.push({ path: '(git)', source: 'git --exec-path', rejected: 'git not found or failed' });
  else if (!root) tried.push({ path: slash(execPath), source: 'git --exec-path', rejected: 'not a Git for Windows or MSYS2 layout' });
  else for (const bash of [`${root}/bin/bash.exe`, `${root}/usr/bin/bash.exe`]) {
    seen.add(bash.toLowerCase());
    if (exists(bash)) return found(bash, 'git --exec-path');
    tried.push({ path: bash, source: 'git --exec-path', rejected: 'not found' });
  }

  for (const bash of knownInstalls(env)) {
    if (seen.has(bash.toLowerCase())) continue;
    if (exists(bash)) return found(bash, 'install path');
    tried.push({ path: bash, source: 'install path', rejected: 'not found' });
  }

  const onPath = (o.which ?? (live ? (c: string) => Bun.which(c) : () => null))('bash');
  if (!onPath) { tried.push({ path: 'bash', source: 'PATH', rejected: 'not on PATH' }); return refuse(); }
  const bash = slash(onPath);
  if (WSL_LAUNCHER.test(bash)) { tried.push({ path: bash, source: 'PATH', rejected: 'WSL launcher, not Git Bash' }); return refuse(); }
  const kind = (o.uname ?? defaultUname)(bash);
  if (kind && /^(?:MSYS|MINGW)/i.test(kind)) return found(bash, 'PATH');
  tried.push({ path: bash, source: 'PATH', rejected: `uname -s reports ${kind ?? 'nothing'}, not MSYS/MINGW` });
  return refuse();
}

export interface CachedProbe extends BashProbe {
  stat?: (p: string) => { mtimeMs: number } | null;
}

/**
 * The hooks' resolver: spawn-free on the hot path. The override is never
 * cached; otherwise the last resolution is reused while `git` on PATH keeps
 * its path and mtime and the cached bash still exists. Written by temp file
 * plus rename; only successes are cached.
 */
export function resolveWindowsBashCached(cacheFile: string, o: CachedProbe = {}): BashResolution {
  const env = o.env ?? process.env;
  if (env.GSTACK_GIT_BASH?.trim() || env.GSTACK_BASH?.trim()) return resolveWindowsBash(o);
  const exists = o.exists ?? fs.existsSync;
  const stat = o.stat ?? ((p: string) => { try { return fs.statSync(p); } catch { return null; } });
  const git = (o.which ?? (process.platform === 'win32' ? (c: string) => Bun.which(c) : () => null))('git');
  const key = git ? `${slash(git)}|${stat(git)?.mtimeMs ?? 'missing'}` : 'no-git';
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached?.key === key && typeof cached.bash === 'string' && exists(cached.bash)) {
      return { ok: true, bash: cached.bash, source: `${cached.source} (cached)`, tried: [{ path: cached.bash, source: `${cached.source} (cached)`, rejected: null }] };
    }
  } catch { /* no usable cache: resolve below */ }
  const res = resolveWindowsBash(o);
  if (res.ok) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ key, bash: res.bash, source: res.source }) + '\n');
      fs.renameSync(tmp, cacheFile);
    } catch { /* an unwritable cache only costs the next resolution */ }
  }
  return res;
}

export interface InvocationOptions extends BashProbe {
  /** Supplies the Windows bash resolution (the hooks pass their cached resolver). */
  resolve?: () => BashResolution;
  /** The Bun that runs bun-shebang bins. */
  bunExe?: string;
}

export type Invocation = { ok: true; cmd: string; argv: string[] } | { ok: false; error: string; tried?: BashCandidate[] };

/** The running Bun, or the `bun` on PATH when this process is a compiled binary. */
export function bunExecutable(): string {
  const exe = process.execPath;
  return /^bun(?:-debug)?(?:\.exe)?$/i.test(path.basename(exe)) ? exe : (Bun.which('bun') ?? 'bun');
}

function readShebang(script: string): string {
  try {
    const fd = fs.openSync(script, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, 128, 0);
      return buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

const warned = new Set<string>();
function windowsBash(o: InvocationOptions): { ok: true; bash: string } | { ok: false; error: string; tried: BashCandidate[] } {
  const res = o.resolve ? o.resolve() : resolveWindowsBash(o);
  if (res.warning && !warned.has(res.warning)) { warned.add(res.warning); process.stderr.write(res.warning + '\n'); }
  return res.ok ? { ok: true, bash: res.bash } : { ok: false, error: res.message, tried: res.tried };
}

/** How to run a gstack shebang bin on this platform. */
export function scriptInvocation(script: string, args: readonly string[], o: InvocationOptions = {}): Invocation {
  if (/^#!.*\bbun\b/.test(readShebang(script))) return { ok: true, cmd: o.bunExe ?? bunExecutable(), argv: [...bunIsolationArgs((o.platform ?? process.platform) as NodeJS.Platform), script, ...args] };
  if ((o.platform ?? process.platform) !== 'win32') return { ok: true, cmd: script, argv: [...args] };
  const bash = windowsBash(o);
  return bash.ok ? { ok: true, cmd: bash.bash, argv: [slash(script), ...args] } : bash;
}

/** How to run `bash -c <command>` on this platform. */
export function bashCommandInvocation(command: string, o: InvocationOptions = {}): Invocation {
  if ((o.platform ?? process.platform) !== 'win32') return { ok: true, cmd: 'bash', argv: ['-c', command] };
  const bash = windowsBash(o);
  return bash.ok ? { ok: true, cmd: bash.bash, argv: ['-c', command] } : bash;
}

/** A spawnSync-shaped failure for an invocation that could not be built, so callers keep one error path. */
function unlaunched(error: string, encoding: unknown, tried?: BashCandidate[]): SpawnSyncReturns<string | Buffer> {
  const empty = encoding && encoding !== 'buffer' ? '' : Buffer.alloc(0);
  return { pid: 0, output: [null, empty, empty], stdout: empty, stderr: empty, status: null, signal: null, error: Object.assign(new Error(error), { code: 'BASH_UNAVAILABLE', tried }) };
}

export function runScriptSync(script: string, args: readonly string[], opts: SpawnSyncOptionsWithStringEncoding, o?: InvocationOptions): SpawnSyncReturns<string>;
export function runScriptSync(script: string, args: readonly string[], opts: SpawnSyncOptions, o?: InvocationOptions): SpawnSyncReturns<string | Buffer>;
export function runScriptSync(script: string, args: readonly string[], opts: SpawnSyncOptions, o: InvocationOptions = {}): SpawnSyncReturns<string | Buffer> {
  const inv = scriptInvocation(script, args, o);
  return inv.ok ? spawnSync(inv.cmd, inv.argv, opts) : unlaunched(inv.error, opts.encoding, inv.tried);
}

export function runBashSync(command: string, opts: SpawnSyncOptionsWithStringEncoding, o?: InvocationOptions): SpawnSyncReturns<string>;
export function runBashSync(command: string, opts: SpawnSyncOptions, o?: InvocationOptions): SpawnSyncReturns<string | Buffer>;
export function runBashSync(command: string, opts: SpawnSyncOptions, o: InvocationOptions = {}): SpawnSyncReturns<string | Buffer> {
  const inv = bashCommandInvocation(command, o);
  return inv.ok ? spawnSync(inv.cmd, inv.argv, opts) : unlaunched(inv.error, opts.encoding, inv.tried);
}

export type WtreeResult = { tree: string } | { error: string; kind: 'launch' | 'exit'; tried?: BashCandidate[] };

/**
 * The working-tree content fingerprint (bin/gstack-wtree): tracked and
 * untracked non-ignored files except an untracked root .bun/ folder, as a
 * 40- or 64-hex git tree id (SHA-1 or SHA-256 repositories). `launch` means gstack-wtree never ran (no bash, a
 * spawn error; `tried` lists each Windows bash candidate when none was
 * found); `exit` means it ran and failed (its stderr says why).
 */
export function wtreeFingerprint(o: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; invocation?: InvocationOptions }): WtreeResult {
  const r = runScriptSync(path.join(BIN_DIR, 'gstack-wtree'), [], {
    cwd: o.cwd, encoding: 'utf8', timeout: o.timeoutMs ?? 60_000, windowsHide: true,
    env: { ...(o.env ?? process.env), GIT_OPTIONAL_LOCKS: '0' },
  }, o.invocation);
  const out = (r.stdout ?? '').trim();
  if (r.status === 0 && /^[0-9a-f]{40,64}$/.test(out)) return { tree: out };
  if (r.error && r.status === null && r.signal === null) return { kind: 'launch', error: `gstack-wtree could not start: ${r.error.message}`, tried: (r.error as { tried?: BashCandidate[] }).tried };
  const why = (r.stderr ?? '').trim().split('\n').pop() || (r.signal ? `killed by ${r.signal}` : r.status === 0 ? `unexpected output ${JSON.stringify(out.slice(0, 80))}` : 'no stderr');
  return { kind: 'exit', error: `gstack-wtree exited ${r.status ?? r.signal}: ${why}` };
}
