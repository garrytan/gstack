/**
 * dx-error-capture — run one target CLI under containment and print a redacted
 * record of how it failed, for /devex-review Step 3 (bin/gstack-error-capture).
 *
 * Supervision is runQaDeadlineCommand (lib/qa-deadline.ts): detached process
 * group, stdin ignored, whole-group kill, signal forwarding, Windows job
 * containment and its own deadline timer. This module owns the scrubbed
 * environment, the private temp HOME/cwd, fail-closed redaction and the record.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactFindingSpans, scan } from './redact-engine';
import { resolveStateRoot } from './state-root';
import { runQaDeadlineCommand, startQaDeadline } from './qa-deadline';
import { RESULT_CODES } from './result-codes';

type Stream = 'stdout' | 'stderr';
type Recovery = 'retry' | 'fix_and_retry' | 'do_first' | 'ask_human';
const STREAMS: Stream[] = ['stdout', 'stderr'];
const SCAN_CAP = 1024 * 1024;
const DEFAULT_DEADLINE = '20';
const DEFAULT_MAX_BYTES = 64 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;
const PASS_MARK = '<REDACTED-passed_env.value>';
const MIN_MASKED_VALUE = 4;
const PROG = 'gstack-error-capture';
const USAGE = RESULT_CODES.DX_CAPTURE_USAGE.fix;

export interface DxCaptureCode { exit: 0 | 1 | 2 | 3; recovery: Recovery; summary: string; fix: string }

const row = (name: keyof typeof RESULT_CODES, exit: DxCaptureCode['exit'], recovery: Recovery): DxCaptureCode => ({ exit, recovery, summary: RESULT_CODES[name].summary, fix: RESULT_CODES[name].fix });

export const DX_CAPTURE_CODES = {
  DX_CAPTURE_USAGE: row('DX_CAPTURE_USAGE', 2, 'fix_and_retry'),
  DX_CAPTURE_BAD_DEADLINE: row('DX_CAPTURE_BAD_DEADLINE', 2, 'fix_and_retry'),
  DX_CAPTURE_BAD_MAX_BYTES: row('DX_CAPTURE_BAD_MAX_BYTES', 2, 'fix_and_retry'),
  DX_CAPTURE_BAD_PASS_ENV: row('DX_CAPTURE_BAD_PASS_ENV', 2, 'fix_and_retry'),
  DX_CAPTURE_BAD_CWD: row('DX_CAPTURE_BAD_CWD', 2, 'fix_and_retry'),
  DX_CAPTURE_APPROVAL_REQUIRED: row('DX_CAPTURE_APPROVAL_REQUIRED', 3, 'ask_human'),
  DX_CAPTURE_CONFIG_REFUSED: row('DX_CAPTURE_CONFIG_REFUSED', 3, 'fix_and_retry'),
  DX_CAPTURE_NOT_FOUND: row('DX_CAPTURE_NOT_FOUND', 1, 'do_first'),
  DX_CAPTURE_TEMP_DIR: row('DX_CAPTURE_TEMP_DIR', 1, 'do_first'),
  DX_CAPTURE_CONTAINMENT_UNAVAILABLE: row('DX_CAPTURE_CONTAINMENT_UNAVAILABLE', 1, 'ask_human'),
  DX_CAPTURE_SUPERVISOR_FAILED: row('DX_CAPTURE_SUPERVISOR_FAILED', 1, 'retry'),
  DX_CAPTURE_INTERRUPTED: row('DX_CAPTURE_INTERRUPTED', 1, 'retry'),
  DX_CAPTURE_REDACTION_FAILED: row('DX_CAPTURE_REDACTION_FAILED', 1, 'ask_human'),
  DX_CAPTURE_INTERNAL: row('DX_CAPTURE_INTERNAL', 1, 'ask_human'),
} satisfies Record<string, DxCaptureCode>;

type DxCaptureCodeName = keyof typeof DX_CAPTURE_CODES;

class CaptureError extends Error {
  constructor(readonly code: DxCaptureCodeName, readonly what: string, readonly fix: string = DX_CAPTURE_CODES[code].fix) { super(what); }
}

export const DX_CAPTURE_HELP = `${PROG}: run one CLI with no terminal and print a redacted JSON record of what it did.

Usage: ${USAGE}

Flags:
  --deadline <s>       Kill the whole process group after s seconds (default ${DEFAULT_DEADLINE}, max 3600).
  --max-bytes <n>      Publish at most n bytes per stream after redaction (default ${DEFAULT_MAX_BYTES}).
  --pass-env A,B       Copy these variables into the target env (needs --approved). Values of
                       ${MIN_MASKED_VALUE}+ characters are masked literally, plus URL-encoded and base64 forms.
  --copy-config <p>    Copy a regular file under $HOME into the temp HOME at the same relative path
                       (repeatable, needs --approved; symlinks and non-regular files are refused).
  --cwd <dir>          Run in this directory instead of a temp one (needs --approved).
  --approved           The user approved the --pass-env, --copy-config and --cwd values given.
  --launch-check       Run "<cmd> --version" in the same containment; launch says whether it started,
                       exit_code is the probe's own result.
  --help               Print this help.

Containment: stdin is /dev/null, no controlling terminal, own process group, temp cwd and temp
HOME/XDG_CONFIG_HOME in a 0700 directory under the gstack state root (removed on exit), env limited
to PATH, LANG, LC_*, TMPDIR, TERM=dumb and version-manager locations (NVM_DIR, NVM_BIN, VOLTA_HOME,
PYENV_ROOT, RBENV_ROOT, MISE_DATA_DIR, ASDF_DIR, ASDF_DATA_DIR); config, trust and env-loading
variables (MISE_*, ASDF_* and the rest) need --pass-env. Containment lasts while the helper runs:
a SIGKILLed helper, or a descendant that leaves the process group, outlives it, so capture only
read-only invocations.

Record (one JSON object on stdout): version, argv (redacted), exit_code (null when killed or signalled),
signal, timed_out (the helper's own timer only), deadline_s, terminal {verdict: blocking |
refused_with_alternative | refused_no_alternative | none | unknown, evidence}, launch (ok | failed |
not_found), stdout, stderr (redacted text, "withheld", or null when nothing ran), withheld_reason
{stdout, stderr}, secret_findings {count, classes} (HIGH tier and passed_env.value), other_masked
{count, classes} (MEDIUM and LOW), scan_complete, truncated {stdout, stderr}, passed_env (names),
copied_config (paths relative to HOME), containment {cwd, home, env}.

Exit codes: 0 record printed, 1 helper failure, 2 usage, 3 refused.
Error lines: "<what>; fix: <command or flag> (<CODE>)" on stderr. Codes:
${Object.entries(DX_CAPTURE_CODES).map(([code, row]) => `  ${code} (exit ${row.exit}, ${row.recovery}): ${row.summary}`).join('\n')}
`;

interface Options {
  help: boolean; deadline: string; maxBytes: number; passEnv: string[]; copyConfig: string[];
  cwd?: string; approved: boolean; launchCheck: boolean; command: string; args: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { help: false, deadline: DEFAULT_DEADLINE, maxBytes: DEFAULT_MAX_BYTES, passEnv: [], copyConfig: [], approved: false, launchCheck: false, command: '', args: [] };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { ...options, help: true };
  const bare = !!argv[0] && !argv[0].startsWith('-');
  const split = bare ? -1 : argv.indexOf('--');
  if (!bare && split === -1) throw new CaptureError('DX_CAPTURE_USAGE', 'missing `--` before the command to capture');
  const flags = bare ? [] : argv.slice(0, split);
  [options.command = '', ...options.args] = argv.slice(split + 1);
  if (!options.command) throw new CaptureError('DX_CAPTURE_USAGE', 'no command after `--`');
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--approved') { options.approved = true; continue; }
    if (flag === '--launch-check') { options.launchCheck = true; continue; }
    if (!['--deadline', '--max-bytes', '--pass-env', '--copy-config', '--cwd'].includes(flag)) {
      throw new CaptureError('DX_CAPTURE_USAGE', `unknown flag ${JSON.stringify(flag)}`);
    }
    const value = flags[++i];
    if (value === undefined) throw new CaptureError('DX_CAPTURE_USAGE', `${flag} needs a value`);
    if (flag === '--deadline') {
      const ms = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value) ? Number(value) * 1000 : NaN;
      if (!(ms >= 1 && ms <= 3_600_000)) throw new CaptureError('DX_CAPTURE_BAD_DEADLINE', `--deadline ${JSON.stringify(value)} is not 0.001-3600 seconds`);
      options.deadline = value;
    } else if (flag === '--max-bytes') {
      const bytes = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
      if (!(bytes <= SCAN_CAP)) throw new CaptureError('DX_CAPTURE_BAD_MAX_BYTES', `--max-bytes ${JSON.stringify(value)} is not an integer from 1 to ${SCAN_CAP}`);
      options.maxBytes = bytes;
    } else if (flag === '--pass-env') options.passEnv.push(...value.split(',').filter(Boolean));
    else if (flag === '--copy-config') options.copyConfig.push(value);
    else options.cwd = value;
  }
  if (options.launchCheck && options.args.length) {
    throw new CaptureError('DX_CAPTURE_USAGE', '--launch-check takes only the command; it supplies --version itself', `${PROG} --launch-check -- ${options.command}`);
  }
  return options;
}

const OWNED_ENV = new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TERM', 'USERPROFILE']);
const SHIM_NAMES = new Set(['PATH', 'LANG', 'TMPDIR', 'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'PYENV_ROOT', 'RBENV_ROOT', 'MISE_DATA_DIR', 'ASDF_DIR', 'ASDF_DATA_DIR']);
const SHIM_PREFIXES = ['LC_'];
const WINDOWS_NAMES = new Set(['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR']);
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSW|KEY|AUTH|CREDENTIAL|COOKIE|SESSION/i;

function checkPassEnv(names: string[]): void {
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || OWNED_ENV.has(name.toUpperCase())) {
      throw new CaptureError('DX_CAPTURE_BAD_PASS_ENV', `--pass-env name ${JSON.stringify(name)} is invalid or owned by the containment`);
    }
    if (process.env[name] === undefined) {
      throw new CaptureError('DX_CAPTURE_BAD_PASS_ENV', `--pass-env ${name} is not set in the calling environment`, `export ${name} first, or drop it from --pass-env`);
    }
  }
}

function childEnvironment(home: string, passEnv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const shim = SHIM_NAMES.has(upper) || (process.platform === 'win32' && WINDOWS_NAMES.has(upper))
      || (SHIM_PREFIXES.some(prefix => upper.startsWith(prefix)) && !CREDENTIAL_NAME.test(upper));
    if (shim) env[name] = value;
  }
  for (const name of passEnv) env[name] = process.env[name] as string;
  env.TERM = 'dumb';
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  if (process.platform === 'win32') env.USERPROFILE = home;
  return env;
}

function resolveBinary(command: string): string | null {
  const explicit = command.includes('/') || (process.platform === 'win32' && command.includes('\\'));
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = explicit ? [''] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.resolve(dir, command + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function prepareContainment(): { root: string; home: string; cwd: string } {
  try {
    const base = path.join(path.resolve(resolveStateRoot()), 'error-capture');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(base);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a directory');
    if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) throw new Error('not owned');
    fs.chmodSync(base, 0o700);
    const real = fs.realpathSync(base);
    for (const entry of fs.readdirSync(real)) {
      const match = /^run-(\d+)-/.exec(entry);
      if (!match) continue;
      const dir = path.join(real, entry);
      try {
        if (!alive(Number(match[1])) || Date.now() - fs.lstatSync(dir).mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    const root = fs.mkdtempSync(path.join(real, `run-${process.pid}-`));
    fs.chmodSync(root, 0o700);
    const home = path.join(root, 'home'), cwd = path.join(root, 'cwd');
    fs.mkdirSync(path.join(home, '.config'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(cwd, { mode: 0o700 });
    return { root, home, cwd };
  } catch {
    throw new CaptureError('DX_CAPTURE_TEMP_DIR', 'cannot create the private containment directory under the gstack state root');
  }
}

function copyConfig(files: string[], home: string): string[] {
  const homeRaw = path.resolve(os.homedir());
  const homeReal = fs.realpathSync(homeRaw);
  return files.map(file => {
    const refuse = (why: string) => new CaptureError('DX_CAPTURE_CONFIG_REFUSED', `--copy-config ${JSON.stringify(file)} ${why}`);
    const absolute = path.resolve(file);
    const relative = [homeRaw, homeReal].map(root => path.relative(root, absolute))
      .find(rel => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    if (!relative) throw refuse('is not under $HOME');
    let fd: number | undefined;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) throw refuse('is a symlink or not a regular file');
      if (fs.realpathSync(absolute) !== path.join(homeReal, relative)) throw refuse('has a symlinked parent directory');
      fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > SCAN_CAP) throw refuse('is not a regular file of at most 1 MiB');
      const bytes = fs.readFileSync(fd);
      const target = path.join(home, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(target, 0o600);
      return relative.split(path.sep).join('/');
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw refuse('cannot be read or was named twice');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-_]|\x9b[0-?]*[ -/]*[@-~]/g;

function sanitize(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function exactUtf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

interface Tally { secret: Map<string, number>; other: Map<string, number> }
const bump = (map: Map<string, number>, id: string, by = 1) => map.set(id, (map.get(id) ?? 0) + by);

/** Sanitize, mask pass-env values literally, then mask every finding span. Null means withhold. */
function clean(text: string, literals: string[], tally?: Tally, maxBytes = 4 * SCAN_CAP): string | null {
  const mask = (input: string) => literals.reduce((acc, literal) => {
    const parts = acc.split(literal);
    if (parts.length > 1 && tally) bump(tally.secret, 'passed_env.value', parts.length - 1);
    return parts.join(PASS_MARK);
  }, input);
  const value = mask(sanitize(mask(text)));
  const result = scan(value, { maxBytes });
  if (result.oversize) return null;
  if (tally) for (const finding of result.findings) bump(finding.tier === 'HIGH' ? tally.secret : tally.other, finding.id);
  return redactFindingSpans(value, { maxBytes });
}

function literalForms(names: string[]): string[] {
  const forms = new Set<string>();
  for (const name of names) {
    const value = process.env[name] ?? '';
    if (value.length < MIN_MASKED_VALUE) continue;
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), base64, base64.replace(/=+$/, ''), Buffer.from(value, 'utf8').toString('base64url')]) {
      forms.add(form);
      forms.add(sanitize(form));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  let head = bytes.subarray(0, end).toString('utf8');
  if (!/\s/.test(String.fromCharCode(bytes[end]))) head = head.replace(/\S+$/, '');
  return { text: head, truncated: true };
}

interface Chunk { stream: Stream; bytes: Buffer }
interface Released {
  text: Record<Stream, string>; withheld: Record<Stream, string | null>; truncated: Record<Stream, boolean>;
  tally: Tally; scanComplete: boolean;
}

/** Full-buffer redaction first, then every assembled view re-scanned, then truncation. */
function release(chunks: Chunk[], overflow: Record<Stream, boolean>, literals: string[], maxBytes: number): Released {
  const withheld: Record<Stream, string | null> = { stdout: null, stderr: null };
  const tally: Tally = { secret: new Map(), other: new Map() };
  let scanComplete = true;
  for (const stream of STREAMS) {
    const text = overflow[stream] ? null : exactUtf8(Buffer.concat(chunks.filter(chunk => chunk.stream === stream).map(chunk => chunk.bytes)));
    if (text === null) withheld[stream] = overflow[stream] ? 'scan_cap_exceeded' : 'invalid_utf8';
    else if (clean(text, literals, tally) === null) withheld[stream] = 'redaction_unlocatable';
    if (withheld[stream]) scanComplete = false;
  }
  const runs: Array<{ stream: Stream; parts: Buffer[] }> = [];
  for (const chunk of chunks.filter(item => withheld[item.stream] === null)) {
    const last = runs.at(-1);
    if (last?.stream === chunk.stream) last.parts.push(chunk.bytes);
    else runs.push({ stream: chunk.stream, parts: [chunk.bytes] });
  }
  const joined: Record<Stream, string> = { stdout: '', stderr: '' };
  let chronological = '';
  let failure: string | null = null;
  for (const run of runs) {
    const raw = exactUtf8(Buffer.concat(run.parts));
    const text = raw === null ? null : clean(raw, literals);
    if (text === null) { failure = raw === null ? 'interleave_split' : 'redaction_unlocatable'; break; }
    joined[run.stream] += text;
    chronological += text;
  }
  const views = [joined.stdout, joined.stderr, joined.stdout + joined.stderr, joined.stderr + joined.stdout, chronological];
  if (!failure && views.some(view => clean(view, literals, undefined, 8 * SCAN_CAP) !== view)) failure = 'cross_stream_finding';
  const text: Record<Stream, string> = { stdout: 'withheld', stderr: 'withheld' };
  const truncated: Record<Stream, boolean> = { stdout: false, stderr: false };
  for (const stream of STREAMS) {
    if (withheld[stream] === null && failure) withheld[stream] = failure;
    if (withheld[stream] !== null) continue;
    const cut = truncate(joined[stream], maxBytes);
    if (cut.truncated && clean(cut.text, literals) !== cut.text) { withheld[stream] = 'truncation_finding'; continue; }
    text[stream] = cut.text;
    truncated[stream] = cut.truncated;
  }
  return { text, withheld, truncated, tally, scanComplete };
}

const TTY_FAILURES: Array<[string, RegExp]> = [
  ['ENXIO', /\bENXIO\b/], ['not a tty', /not a tty/i], ['not a terminal', /not a terminal/i],
  ['Inappropriate ioctl', /inappropriate ioctl/i], ['No such device or address', /no such device or address/i],
  ['Device not configured', /device not configured/i],
];
const ALTERNATIVES: Array<[string, RegExp]> = [
  ['--yes', /(?<![\w-])--yes\b/], ['--non-interactive', /--non-?interactive\b/i], ['--no-input', /--no-input\b/],
  ['--no-interaction', /--no-interaction\b/], ['--assume-yes', /--assume-yes\b/], ['--batch', /(?<![\w-])--batch\b/],
  ['-y', /(?<![\w-])-y\b/], ['CI=', /\bCI=/], ['*NONINTERACTIVE=', /\b[A-Z0-9_]*NON_?INTERACTIVE[A-Z0-9_]*=/],
  ['DEBIAN_FRONTEND=noninteractive', /\bDEBIAN_FRONTEND=noninteractive\b/],
];
const EOF_FAILURES: Array<[string, RegExp]> = [['EOF', /\bEOF\b/], ['end of file', /end of (?:file|input)/i], ['stdin closed', /stdin (?:is )?closed/i]];
const firstMatch = (patterns: Array<[string, RegExp]>, text: string) => patterns.find(([, pattern]) => pattern.test(text))?.[0];

export type TerminalVerdict = 'blocking' | 'refused_with_alternative' | 'refused_no_alternative' | 'none' | 'unknown';
interface TerminalInput { exitCode: number | null; timedOut: boolean; launched: boolean; quietMs: number; outputBytes: number; deadlineS: number }

function classifyTerminal(stderr: string, run: TerminalInput): { verdict: TerminalVerdict; evidence: string } {
  if (!run.launched) return { verdict: 'unknown', evidence: 'command did not start' };
  if (run.timedOut) {
    if (run.outputBytes === 0) return { verdict: 'blocking', evidence: `killed at the ${run.deadlineS}s deadline with no output` };
    if (run.quietMs >= Math.min(5000, run.deadlineS * 500)) {
      return { verdict: 'blocking', evidence: `killed at the ${run.deadlineS}s deadline after ${(run.quietMs / 1000).toFixed(1)}s without output` };
    }
    return { verdict: 'unknown', evidence: `output was still progressing at the ${run.deadlineS}s deadline` };
  }
  const tty = firstMatch(TTY_FAILURES, stderr);
  if (tty && run.exitCode !== 0) {
    const alternative = firstMatch(ALTERNATIVES, stderr);
    return alternative
      ? { verdict: 'refused_with_alternative', evidence: `stderr matched "${tty}"; alternative "${alternative}"` }
      : { verdict: 'refused_no_alternative', evidence: `stderr matched "${tty}"; no non-interactive flag or env var named` };
  }
  if (tty) return { verdict: 'unknown', evidence: `exit 0 but stderr matched "${tty}"` };
  const eof = run.exitCode !== 0 ? firstMatch(EOF_FAILURES, stderr) : undefined;
  if (eof) return { verdict: 'unknown', evidence: `stderr matched "${eof}"; cannot attribute it to a terminal` };
  return { verdict: 'none', evidence: 'no terminal-failure pattern' };
}

interface Run {
  chunks: Chunk[]; overflow: Record<Stream, boolean>; exitCode: number; signal: NodeJS.Signals | null;
  completed: boolean; timedOut: boolean; quietMs: number; outputBytes: number;
}

async function supervise(deadlineFile: string, binary: string, args: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  const chunks: Chunk[] = [];
  const size: Record<Stream, number> = { stdout: 0, stderr: 0 };
  const overflow: Record<Stream, boolean> = { stdout: false, stderr: false };
  let lastOutputAt = Date.now(), timedOut = false, interrupted: string | undefined;
  let completion: { exitCode: number; signal: NodeJS.Signals | null; completed: boolean } | undefined;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(name => [name, () => { interrupted ??= name; }] as const);
  for (const [name, handler] of handlers) process.once(name, handler);
  try {
    await runQaDeadlineCommand(deadlineFile, binary, args, (_stream, receipt) => {
      if (receipt.event === 'finished') timedOut = receipt.timedOut === true;
    }, {
      write: (stream, chunk) => {
        lastOutputAt = Date.now();
        size[stream] += chunk.length;
        if (size[stream] > SCAN_CAP) overflow[stream] = true;
        else chunks.push({ stream, bytes: Buffer.from(chunk) });
      },
      complete: result => { completion = result; },
      spawn: { cwd, env },
    });
  } catch (error) {
    if (/containment/i.test((error as Error).message)) {
      throw new CaptureError('DX_CAPTURE_CONTAINMENT_UNAVAILABLE', `${process.platform} process containment is unavailable; nothing ran`);
    }
    throw new CaptureError('DX_CAPTURE_SUPERVISOR_FAILED', 'the deadline supervisor failed before reporting a result');
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
  if (interrupted) throw new CaptureError('DX_CAPTURE_INTERRUPTED', `capture interrupted by ${interrupted}; the target group was killed`);
  if (!completion) throw new CaptureError('DX_CAPTURE_SUPERVISOR_FAILED', 'the deadline supervisor reported no completion');
  return { chunks, overflow, ...(completion as NonNullable<typeof completion>), timedOut, quietMs: Date.now() - lastOutputAt, outputBytes: size.stdout + size.stderr };
}

const tallyOut = (map: Map<string, number>) => ({ count: [...map.values()].reduce((sum, n) => sum + n, 0), classes: [...map.keys()].sort() });

async function capture(options: Options): Promise<{ record: Record<string, unknown>; literals: string[] }> {
  const literals = literalForms(options.passEnv);
  const argvIn = options.launchCheck ? [options.command, '--version'] : [options.command, ...options.args];
  const base = { version: 1, argv: argvIn.map(arg => clean(arg, literals) ?? 'withheld') };
  const deadlineS = Number(options.deadline);
  const binary = resolveBinary(options.command);
  if (!binary) {
    return { literals, record: { ...base, exit_code: null, signal: null, timed_out: false, deadline_s: deadlineS, terminal: { verdict: 'unknown', evidence: 'command not found' },
      launch: 'not_found', stdout: null, stderr: null, withheld_reason: { stdout: null, stderr: null }, secret_findings: { count: 0, classes: [] },
      other_masked: { count: 0, classes: [] }, scan_complete: true, truncated: { stdout: false, stderr: false }, passed_env: options.passEnv, copied_config: [], containment: null } };
  }
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
    throw new CaptureError('DX_CAPTURE_CONTAINMENT_UNAVAILABLE', `${process.platform} process containment is unavailable; nothing ran`);
  }
  const box = prepareContainment();
  try {
    const copied = copyConfig(options.copyConfig, box.home).map(rel => clean(rel, literals) ?? 'withheld');
    const env = childEnvironment(box.home, options.passEnv);
    const deadlineFile = path.join(box.root, 'deadline.json');
    try { startQaDeadline(deadlineFile, options.deadline); } catch {
      throw new CaptureError('DX_CAPTURE_TEMP_DIR', 'cannot write the deadline receipt in the containment directory');
    }
    const run = await supervise(deadlineFile, binary, argvIn.slice(1), options.cwd ? path.resolve(options.cwd) : box.cwd, env);
    const launched = !(run.exitCode === 127 && !run.completed && !run.timedOut);
    const exitCode = run.timedOut || run.signal ? null : run.exitCode;
    const released = release(run.chunks, run.overflow, literals, options.maxBytes);
    const stderrText = sanitize(Buffer.concat(run.chunks.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.bytes)).toString('utf8'));
    const terminal = classifyTerminal(stderrText, { exitCode, timedOut: run.timedOut, launched, quietMs: run.quietMs, outputBytes: run.outputBytes, deadlineS });
    return { literals, record: { ...base, exit_code: exitCode, signal: run.signal, timed_out: run.timedOut, deadline_s: deadlineS, terminal,
      launch: launched ? 'ok' : 'failed',
      stdout: released.text.stdout, stderr: released.text.stderr, withheld_reason: released.withheld,
      secret_findings: tallyOut(released.tally.secret), other_masked: tallyOut(released.tally.other), scan_complete: released.scanComplete,
      truncated: released.truncated, passed_env: options.passEnv, copied_config: copied,
      containment: { cwd: options.cwd ? 'approved' : 'temp', home: 'temp', env: Object.keys(env).sort() } } };
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
}

const writeTo = (stream: NodeJS.WriteStream, text: string) => new Promise<void>(resolve => { stream.write(text, () => resolve()); });
const stringFields = (value: unknown): string[] => typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(stringFields) : [];

/** Every diagnostic passes the record's redaction; a line that still matches prints without its details. */
function errorLine(what: string, fix: string, code: DxCaptureCodeName, literals: string[]): string {
  const safe = clean(`${PROG}: ${what}; fix: ${fix} (${code})`, literals);
  const leaked = safe === null || literals.some(literal => safe.includes(literal))
    || scan(safe, { maxBytes: 2 * Buffer.byteLength(safe, 'utf8') + 1 }).findings.length > 0;
  return `${leaked ? `${PROG}: details withheld by redaction; fix: ${DX_CAPTURE_CODES[code].fix} (${code})` : safe}\n`;
}

export async function dxErrorCaptureMain(argv: string[]): Promise<number> {
  const split = argv.indexOf('--');
  const flags = split === -1 ? argv : argv.slice(0, split);
  const literals = literalForms(flags.flatMap((arg, i) => flags[i - 1] === '--pass-env' ? arg.split(',') : []).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
  try {
    const options = parseArgs(argv);
    if (options.help) { await writeTo(process.stdout, DX_CAPTURE_HELP); return 0; }
    const gated = [options.passEnv.length && '--pass-env', options.copyConfig.length && '--copy-config', options.cwd && '--cwd'].filter(Boolean);
    if (gated.length && !options.approved) {
      throw new CaptureError('DX_CAPTURE_APPROVAL_REQUIRED', `${gated.join(', ')} hands the target credentials or real files and needs the user's approval`,
        `ask the user to approve ${gated.join(' and ')} as given, then rerun with --approved`);
    }
    checkPassEnv(options.passEnv);
    if (options.cwd && !fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new CaptureError('DX_CAPTURE_BAD_CWD', `--cwd ${JSON.stringify(options.cwd)} is not an existing directory`);
    }
    const { record } = await capture(options);
    const json = JSON.stringify(record);
    const untrusted = stringFields([record.argv, record.stdout, record.stderr, record.copied_config]);
    if (untrusted.some(field => literals.some(literal => field.includes(literal))) || stringFields(record).some(field =>
      scan(field, { maxBytes: 2 * Buffer.byteLength(field, 'utf8') + 1 }).findings.some(finding => finding.tier === 'HIGH'))) {
      throw new CaptureError('DX_CAPTURE_REDACTION_FAILED', 'the finished record still matched a secret check; nothing was printed');
    }
    await writeTo(process.stdout, json + '\n');
    if (record.launch !== 'not_found') return 0;
    await writeTo(process.stderr, errorLine(`${JSON.stringify(path.basename(options.command))} does not resolve to an executable file; nothing ran`,
      DX_CAPTURE_CODES.DX_CAPTURE_NOT_FOUND.fix, 'DX_CAPTURE_NOT_FOUND', literals));
    return 1;
  } catch (error) {
    if (error instanceof CaptureError) {
      await writeTo(process.stderr, errorLine(error.what, error.fix, error.code, literals));
      return DX_CAPTURE_CODES[error.code].exit;
    }
    const frame = ((error as Error)?.stack ?? '').split('\n').find(line => line.trim().startsWith('at '))?.trim() ?? 'no stack frame';
    await writeTo(process.stderr, errorLine(`unexpected ${(error as Error)?.name ?? 'error'} ${frame}`, DX_CAPTURE_CODES.DX_CAPTURE_INTERNAL.fix, 'DX_CAPTURE_INTERNAL', literals));
    return 1;
  }
}
