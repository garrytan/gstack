#!/usr/bin/env bun
/**
 * gstack-design-detect — find, and run, an impeccable engine the USER installed.
 *
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-detect.ts probe [--host <h>] [--verbose]
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-detect.ts scan [--format gstack|raw] [--changed <base>] [--host <h>] <paths...>
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-detect.ts rules
 *   bun --no-env-file run ~/.claude/skills/gstack/bin/gstack-design-detect.ts install [--version <v>] [--sha256 <hex>] [--base <url>]
 *
 * Rule zero: gstack never runs impeccable's installer, its launcher
 * (`scripts/impeccable`), or its npm shim, because all three fall through to a
 * GitHub download and the installer also writes hooks. The probe touches the
 * filesystem and the environment only: file existence, a first-bytes sniff,
 * JSON parsing. The one download gstack itself can make is `install`: the engine
 * binary for a version gstack has tested, fetched only after the user said yes
 * to the skill's one-time offer (DESIGN_DETECTOR_INSTALL_OFFER), verified
 * against the checksum pinned in lib/design-detect-contract.ts, placed under
 * ~/.impeccable/bin/<version>/ (never inside a project), and recorded in the
 * egress ledger before the fetch (fail-closed). No skill, no hook, no launcher.
 *
 * Probe order (first hit wins; every step is a read):
 *
 *   design_detector config ── off ──► IMPECCABLE_DISABLED
 *          │ auto
 *   $IMPECCABLE_BIN (absolute, realpath outside repo/cwd, executable, named impeccable[.exe]) ──► READY
 *          │
 *   PATH walk (absolute entries; file realpath outside repo/cwd, named impeccable[.exe]) ─┬─ binary ──► READY
 *          │                                                                     └─ #! shim ──► launcher-present
 *   $IMPECCABLE_HOME|~/.impeccable/bin/<newest semver>/impeccable[.exe] (realpath outside repo/cwd) ──► READY
 *          │
 *   ~/{.claude,.agents,.cursor,.gemini,.github,.opencode}/skills/impeccable/scripts/
 *          ├─ bin/<os>-<arch>/impeccable[.exe] (engine installed beside the launcher) ──► READY
 *          └─ impeccable (launcher only) ──► IMPECCABLE_NOT_CACHED: <launcher>
 *   <repo|cwd>/<same dirs>/impeccable ──► launcher-present only (IMPECCABLE_NOT_CACHED, no run hint)
 *          │
 *   nothing ──► IMPECCABLE_NOT_AVAILABLE
 *
 * Never executed: anything whose realpath lies inside the repository or cwd. A
 * checked-out branch can commit `.claude/skills/impeccable/scripts/bin/<os>-<arch>/
 * impeccable`, a `node_modules/.bin/impeccable`, or a PATH entry under the repo;
 * none of those is ever READY. Only HOME-rooted installs, the env override, the
 * cache, and PATH entries outside the repo qualify, all by realpath of the FILE,
 * and every engine is named impeccable[.exe]: an env override pointing at an
 * interpreter (/bin/sh, node) would otherwise run the repository's own `detect`
 * file from cwd. "Repository" and "cwd" count only when they are project
 * directories, strictly below HOME: from HOME itself (a URL-mode review can run
 * from anywhere) only the designs allow-list qualifies as a target and every
 * HOME-rooted install stays trusted.
 *
 * Sentinel contract: lib/design-detect-contract.ts (one owner, imported here and
 * by the gen-time resolvers). Scan output: stdout is one JSON document
 * (--format gstack) or the engine's own bytes (--format raw); everything else
 * goes to stderr, matching impeccable's own split. Exit code passes through
 * (1 over 2 over 0); exit 3 is a gstack bug (DESIGN_DETECT_INTERNAL_ERROR).
 *
 * Scan hardening: every target, explicit or derived from `--changed`, must be an
 * existing regular file or directory whose realpath lies under the repo root (or
 * cwd) or under ${GSTACK_HOME:-~/.gstack}/projects/<slug>/designs/ (where design-
 * review keeps rendered-DOM dumps: `designs/<audit>/dom/**` are page dumps and
 * scan with --no-inline-ignores, because an `impeccable-disable` comment there is
 * page-controlled; other designs/ files are gstack-authored artifacts and keep
 * them); symlinks are never followed out of those roots
 * and are skipped when git names them (a directory target is handed to the engine
 * as-is: its own walk decides what inside it is read); URLs are refused (the one engine path that
 * talks to the network); the engine runs with a minimal environment (PATH, HOME,
 * TMPDIR, LANG/LC_*, IMPECCABLE_*), stdin ignored (its ">50 files, continue?"
 * prompt is gated on a TTY), a wall-clock timeout with SIGKILL on the direct
 * child, a 50 MB stdout cap, and every string field sanitized, length-capped,
 * and stripped of anything that could forge a sentinel or close the untrusted
 * envelope. The engine's file scan is a single process; if a future engine forks
 * helpers they could outlive the kill (known limit).
 *
 * Env trust: Bun auto-loads a cwd `.env`, so every rendered invocation passes
 * `--no-env-file`, and independently IMPECCABLE_BIN / IMPECCABLE_HOME values
 * whose realpath lies inside the repo or cwd are ignored (IMPECCABLE_ENV_IGNORED).
 *
 * Observability: one content-free JSON line per probe/scan appended to
 * ${GSTACK_HOME:-~/.gstack}/analytics/design-detector.jsonl (local file, no egress).
 *
 * Non-sink: this spawns a third-party binary the user installed over local
 * paths; gstack does not audit that engine's network behavior (NOTICE.md).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  SENTINEL, TESTED_ENGINE_VERSIONS, ADVISORY_RULE_IDS, DETECT_LIMITS,
  UNTRUSTED_BEGIN, UNTRUSTED_END, neutralizeSentinels,
  type NormalizedFinding, type ScanResult, SCAN_UNTRUSTED_PATHS,
  ENGINE_RELEASE_BASE, ENGINE_ASSETS, ENGINE_PINS,
} from '../lib/design-detect-contract';
import { writeReceipt, writeOutcome } from '../lib/egress-receipt';
import { DESIGN_SLOP_CATALOG, entryForImpeccableId } from '../lib/design-catalog';
import { isFrontendPath } from '../lib/frontend-scope';

// ── Environment ──────────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const ENV = process.env;

/** Where config.yaml lives: the same precedence bin/gstack-config uses. */
function gstackStateDir(): string {
  return ENV.GSTACK_STATE_ROOT || ENV.GSTACK_HOME || ENV.GSTACK_STATE_DIR || path.join(HOME, '.gstack');
}

/** Where projects/<slug>/designs/ lives: the `${GSTACK_HOME:-$HOME/.gstack}` rule the skill templates and gstack-slug render. */
function gstackHome(): string {
  return ENV.GSTACK_HOME || path.join(HOME, '.gstack');
}

function realpathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function gitTopLevel(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', timeout: DETECT_LIMITS.gitTimeoutMs });
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  return top ? realpathOrNull(top) : null;
}

/** One flat key from config.yaml, read the way bin/gstack-config resolves it (same STATE_DIR precedence); '' when unset. */
function configValue(key: string): string {
  const file = path.join(gstackStateDir(), 'config.yaml');
  try {
    const text = fs.readFileSync(file, 'utf-8');
    let value = '';
    const re = new RegExp(`^${key}:\\s*(.*?)\\s*$`);
    for (const line of text.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      // flat YAML: drop a trailing comment and surrounding quotes
      value = m[1].replace(/\s+#.*$/, '').trim().replace(/^["'](.*)["']$/, '$1');
    }
    return value;
  } catch {
    return '';
  }
}

/** design_detector: `Off` by hand must not silently re-enable a third-party binary. */
function configDesignDetector(): 'auto' | 'off' {
  return configValue('design_detector').toLowerCase() === 'off' ? 'off' : 'auto';
}

// ── Probe ────────────────────────────────────────────────────────────────────

const HOSTS_WITH_HOOKS: Record<string, string[]> = {
  claude: ['.claude/settings.local.json', '.claude/settings.json'],
  codex: ['.codex/hooks.json'],
  cursor: ['.cursor/hooks.json'],
  github: ['.github/hooks/impeccable.json'],
  grok: ['.grok/hooks/impeccable.json'],
};
const SKILL_ROOTS = ['.claude', '.agents', '.cursor', '.gemini', '.github', '.opencode'];

interface Probe {
  sentinel: string;            // first line
  engine?: string;             // resolved binary
  engineVersion?: string;      // semver, or sha256:<12>
  launcher?: string;
  skillPresent: boolean;
  hook: 'present' | 'absent' | 'unknown';
  hookOther: string[];
  ignoredRules: string[];
  ignoredFiles: string[];
  ignoredValues: string[];
  notes: string[];             // extra sentinel lines (CONFIG_UNREADABLE, ENV_IGNORED, ENGINE_UNTESTED, HINT)
  steps: string[];             // --verbose trail
  repoRoot: string;
  cwd: string;
}

function isScript(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    const n = fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    return false;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (WIN) return /\.exe$/i.test(file);
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * On the PATH walk only: an executable that is not a `#!` script. A node shim
 * named `impeccable` is launcher-present, never READY (running it downloads).
 * Explicit install locations (IMPECCABLE_BIN, the ~/.impeccable/bin cache, the
 * engine beside a skill install's launcher) accept any executable regular file
 * whose realpath is named impeccable[.exe].
 */
function isEngineBinary(file: string): boolean {
  return isExecutableFile(file) && !isScript(file);
}

/** The engine's real file is named impeccable[.exe]; an interpreter reached through a symlink or env override is not an engine. */
function isEngineName(realFile: string): boolean {
  const base = WIN ? path.basename(realFile).toLowerCase() : path.basename(realFile);
  return base === 'impeccable' || base === 'impeccable.exe';
}

/**
 * A project directory is one strictly below HOME. HOME itself and its ancestors
 * are never projects: a URL-mode review can run from HOME, where every
 * HOME-rooted install lives, and `git init ~` (a dotfiles repo) must not turn
 * the user's own installs into "repository-controlled" files.
 */
function isProjectDir(dir: string): boolean {
  return !isInside(HOME, dir);
}

/** Under the project the agent is reviewing: the repository, or cwd, when each is a project directory. */
function underProject(real: string, repoRoot: string, cwd: string): boolean {
  return (isProjectDir(repoRoot) && isInside(real, repoRoot)) || (isProjectDir(cwd) && isInside(real, cwd));
}

function semverKey(v: string): number[] | null {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newestSemverDir(dir: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const versions = entries.map(e => ({ e, k: semverKey(e) })).filter(x => x.k) as { e: string; k: number[] }[];
  versions.sort((a, b) => (b.k[0] - a.k[0]) || (b.k[1] - a.k[1]) || (b.k[2] - a.k[2]));
  return versions[0]?.e ?? null;
}

function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) {
    return { ok: false, missing: (e as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, missing: false }; }
}

function trustedEnvPath(name: string, repoRoot: string, cwd: string, notes: string[], step: (s: string) => void): string | null {
  const raw = ENV[name];
  if (!raw) return null;
  if (!path.isAbsolute(raw)) {
    notes.push(`${SENTINEL.ENV_IGNORED}: ${name} is not an absolute path`);
    return null;
  }
  const real = realpathOrNull(raw);
  if (!real) {
    step(`${name}=${raw} does not exist`);
    return null;
  }
  if (underProject(real, repoRoot, cwd)) {
    notes.push(`${SENTINEL.ENV_IGNORED}: ${name} resolves inside the repository`);
    return null;
  }
  return real;
}

function engineSiblings(launcherDir: string): string[] {
  const arch = process.arch;
  const tags = new Set([
    `${process.platform}-${arch}`,
    `${WIN ? 'windows' : process.platform}-${arch}`,
    `${process.platform}-x64`, `${process.platform}-arm64`,
  ]);
  const name = WIN ? 'impeccable.exe' : 'impeccable';
  return [...tags].map(t => path.join(launcherDir, 'bin', t, name));
}

function probe(host: string, verbose = false): Probe {
  const cwd = realpathOrNull(process.cwd()) ?? process.cwd();
  const repoRoot = gitTopLevel(cwd) ?? cwd;
  const p: Probe = {
    sentinel: SENTINEL.NOT_AVAILABLE, skillPresent: false, hook: 'absent', hookOther: [],
    ignoredRules: [], ignoredFiles: [], ignoredValues: [], notes: [], steps: [], repoRoot, cwd,
  };
  const step = (s: string) => { if (verbose) p.steps.push(s); };

  // config
  const cfg = configDesignDetector();
  step(`design_detector=${cfg}`);

  // Always computed: skill / launcher / hook / ignores (informational even when disabled).
  // A launcher inside the repo or cwd counts as "skill present" only: its sibling
  // engine is repository-controlled and is never a READY candidate, and the hint
  // never tells anyone to run it.
  const roots = [...new Set([repoRoot, cwd, HOME])];
  let siblingEngine: string | null = null;
  let siblingVersion: string | null = null;
  let repoLocalLauncher = false;
  for (const root of roots) {
    const rootIsRepo = underProject(root, repoRoot, cwd);
    for (const sub of SKILL_ROOTS) {
      const skillDir = path.join(root, sub, 'skills', 'impeccable');
      if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) p.skillPresent = true;
      const launcher = path.join(skillDir, 'scripts', 'impeccable');
      if (!fs.existsSync(launcher)) continue;
      if (rootIsRepo) { repoLocalLauncher = true; continue; }
      const realLauncher = realpathOrNull(launcher);
      if (!realLauncher || underProject(realLauncher, repoRoot, cwd)) { repoLocalLauncher = true; continue; }
      p.launcher ??= launcher;
      for (const cand of engineSiblings(path.dirname(launcher))) {
        const real = realpathOrNull(cand);
        if (siblingEngine || !real || !isExecutableFile(real) || !isEngineName(real) || underProject(real, repoRoot, cwd)) continue;
        siblingEngine = real;
        try {
          const v = fs.readFileSync(path.join(path.dirname(launcher), 'VERSION'), 'utf-8').trim();
          siblingVersion = semverKey(v) ? v.replace(/^v/, '') : null; // a non-semver VERSION is not trusted as text
        } catch { /* no VERSION file */ }
      }
    }
  }
  step(`skill=${p.skillPresent} launcher=${p.launcher ?? 'none'} repoLocalLauncher=${repoLocalLauncher} sibling=${siblingEngine ?? 'none'}`);

  // Hook manifests, host-aware.
  const mine = HOSTS_WITH_HOOKS[host] ?? [];
  let hookEnabled = true;
  for (const cfgName of ['config.json', 'config.local.json']) {
    const file = path.join(repoRoot, '.impeccable', cfgName);
    const r = readJsonFile(file);
    if (!r.ok) {
      if (!r.missing) p.notes.push(`${SENTINEL.CONFIG_UNREADABLE}: ${file}`);
      continue;
    }
    const v = r.value as { hook?: { enabled?: unknown }; detector?: { ignoreRules?: unknown; ignoreFiles?: unknown; ignoreValues?: unknown } };
    if (v && typeof v === 'object') {
      if (v.hook && typeof v.hook === 'object' && 'enabled' in v.hook) hookEnabled = v.hook.enabled !== false;
      const rules = Array.isArray(v.detector?.ignoreRules) ? v.detector!.ignoreRules : [];
      const files = Array.isArray(v.detector?.ignoreFiles) ? v.detector!.ignoreFiles : [];
      const values = Array.isArray(v.detector?.ignoreValues) ? v.detector!.ignoreValues : [];
      for (const x of rules) if (typeof x === 'string') p.ignoredRules.push(sanitizeId(x) ?? 'unmapped');
      for (const x of files) if (typeof x === 'string') p.ignoredFiles.push(clip(stripControl(x), DETECT_LIMITS.field.file));
      for (const x of values) if (typeof x === 'string') p.ignoredValues.push(clip(stripControl(x), DETECT_LIMITS.field.value));
    }
  }
  p.ignoredRules = [...new Set(p.ignoredRules)];
  p.ignoredFiles = [...new Set(p.ignoredFiles)];
  p.ignoredValues = [...new Set(p.ignoredValues)];
  let unknown = false;
  for (const [h, manifests] of Object.entries(HOSTS_WITH_HOOKS)) {
    for (const rel of manifests) {
      const file = path.join(repoRoot, rel);
      const r = readJsonFile(file);
      if (!r.ok) { if (!r.missing && mine.includes(rel)) unknown = true; continue; }
      const text = JSON.stringify(r.value);
      if (!/impeccable\s+hook/.test(text) && !/skills\/impeccable\/scripts\/impeccable/.test(text)) continue;
      if (mine.includes(rel)) p.hook = 'present'; else if (!p.hookOther.includes(h)) p.hookOther.push(h);
    }
  }
  if (p.hook !== 'present' && unknown) p.hook = 'unknown';
  if (!hookEnabled) { p.hook = 'absent'; step('hook.enabled=false in .impeccable config'); }

  if (cfg === 'off') {
    p.sentinel = SENTINEL.DISABLED;
    return p;
  }

  // IMPECCABLE_BIN
  const envBin = trustedEnvPath('IMPECCABLE_BIN', repoRoot, cwd, p.notes, step);
  if (envBin && isExecutableFile(envBin) && isEngineName(envBin)) {
    p.sentinel = `${SENTINEL.READY}: ${envBin}`;
    p.engine = envBin;
  } else if (envBin && isExecutableFile(envBin)) {
    // /bin/sh or node as the "engine" would execute the repository's own `detect` file from cwd.
    p.notes.push(`${SENTINEL.ENV_IGNORED}: IMPECCABLE_BIN is not named impeccable`);
  } else if (envBin) {
    step(`IMPECCABLE_BIN=${envBin} is not an executable file`);
  }

  // PATH walk
  let launcherOnPath: string | null = null;
  if (!p.engine) {
    const exts = WIN ? (ENV.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.toLowerCase()) : [''];
    for (const entry of (ENV.PATH || '').split(path.delimiter)) {
      if (!entry || !path.isAbsolute(entry)) continue;
      const real = realpathOrNull(entry);
      if (!real || underProject(real, repoRoot, cwd)) continue;
      for (const ext of exts) {
        const cand = path.join(real, `impeccable${ext}`);
        if (!fs.existsSync(cand)) continue;
        const realCand = realpathOrNull(cand);
        if (!realCand || underProject(realCand, repoRoot, cwd)) { step(`PATH ${cand} resolves to ${realCand ?? 'nothing'}: inside the project, never run`); continue; }
        if (isEngineName(realCand) && isEngineBinary(realCand)) { p.engine = realCand; p.sentinel = `${SENTINEL.READY}: ${realCand}`; break; }
        launcherOnPath ??= cand; // node shim, .cmd wrapper, or a differently named real file: launcher present, engine not proven
      }
      if (p.engine) break;
    }
    step(`PATH walk: engine=${p.engine ?? 'none'} shim=${launcherOnPath ?? 'none'}`);
  }

  // cache
  if (!p.engine) {
    const homeOverride = trustedEnvPath('IMPECCABLE_HOME', repoRoot, cwd, p.notes, step);
    const cacheRoot = homeOverride ?? path.join(HOME, '.impeccable');
    const binDir = path.join(cacheRoot, 'bin');
    const newest = newestSemverDir(binDir);
    if (newest) {
      const cand = path.join(binDir, newest, WIN ? 'impeccable.exe' : 'impeccable');
      const realCand = realpathOrNull(cand);
      if (realCand && isExecutableFile(realCand) && isEngineName(realCand) && !underProject(realCand, repoRoot, cwd)) {
        p.engine = realCand; p.engineVersion = newest.replace(/^v/, ''); p.sentinel = `${SENTINEL.READY}: ${realCand}`;
      }
    }
    step(`cache ${binDir}: newest=${newest ?? 'none'} engine=${p.engine ?? 'none'}`);
  }

  // engine beside a HOME-rooted launcher
  if (!p.engine && siblingEngine) {
    p.engine = siblingEngine;
    p.engineVersion = siblingVersion ?? undefined;
    p.sentinel = `${SENTINEL.READY}: ${siblingEngine}`;
  }

  if (p.engine) {
    if (!p.engineVersion) {
      // Version sources, in order: the ~/.impeccable/bin/<version>/ cache layout;
      // the skill-install layout (<skill>/scripts/bin/<os>-<arch>/impeccable next
      // to <skill>/scripts/VERSION); else a content hash. Never a filesystem path.
      const m = p.engine.match(/[\\/]bin[\\/](v?\d+\.\d+\.\d+)[\\/]/);
      if (m) p.engineVersion = m[1].replace(/^v/, '');
      else {
        try {
          const v = fs.readFileSync(path.join(path.dirname(p.engine), '..', '..', 'VERSION'), 'utf-8').trim();
          if (semverKey(v)) p.engineVersion = v.replace(/^v/, '');
        } catch { /* no VERSION beside the binary */ }
      }
      p.engineVersion ??= `sha256:${engineIdentity(p.engine)}`;
    }
    p.engineVersion = clip(stripControl(p.engineVersion), DETECT_LIMITS.field.engineVersion);
    if (!TESTED_ENGINE_VERSIONS.includes(p.engineVersion)) p.notes.push(`${SENTINEL.ENGINE_UNTESTED}: ${p.engineVersion}`);
    return p;
  }

  // launcher present but no engine
  const launcher = p.launcher ?? launcherOnPath ?? (repoLocalLauncher ? 'repository-local install' : null);
  if (launcher) {
    p.sentinel = `${SENTINEL.NOT_CACHED}: ${launcher}`;
    const how = p.launcher
      ? `run \`${p.launcher} detect --help\` once; it fetches the engine version pinned by your install`
      : repoLocalLauncher && !launcherOnPath
        ? 'the skill is installed inside this repository, and gstack never runs a repository-local launcher; install it under your home directory (`npx impeccable install --scope global` outside the repo) if you want the engine here'
        : 'run `npx impeccable install --scope global` yourself (the engine lands beside the skill under your home directory; `npx impeccable detect --help` alone caches it only for npx)';
    p.notes.push(`${SENTINEL.HINT}: impeccable is installed but its engine is not cached; ${how}, or accept the install offer. Silence this: \`gstack-config set design_detector off\`.`);
    return withInstallOffer(p);
  }

  p.sentinel = SENTINEL.NOT_AVAILABLE;
  return withInstallOffer(p);
}

/** `${platform}-${arch}` → release asset suffix, or null when impeccable ships no engine for this machine. */
function enginePlatform(): string | null {
  return ENGINE_ASSETS[`${process.platform}-${process.arch}`] ?? null;
}

function enginePin(version: string, platform: string): { sha256: string; bytes: number } | null {
  return ENGINE_PINS[version]?.[platform] ?? null;
}

/** ~/.impeccable (or a trusted IMPECCABLE_HOME): where `install` puts the engine and where the probe's cache step looks. */
function engineCacheRoot(repoRoot: string, cwd: string): string {
  return trustedEnvPath('IMPECCABLE_HOME', repoRoot, cwd, [], () => {}) ?? path.join(HOME, '.impeccable');
}

/**
 * A probe that found no engine ends with the one-time install offer: the skill
 * asks the user, and only a yes runs `install`. Once the user has answered
 * "never ask again" (design_detector_install_prompted=true) the probe prints
 * neither the offer nor the NOT_CACHED hint, or the hint would be the nag the
 * docs promise does not exist. Machines impeccable ships no pinned engine for get
 * no offer.
 */
function withInstallOffer(p: Probe): Probe {
  if (configValue('design_detector_install_prompted').toLowerCase() === 'true') {
    p.notes = p.notes.filter(n => !n.startsWith(`${SENTINEL.HINT}:`));
    return p;
  }
  const platform = enginePlatform();
  const version = TESTED_ENGINE_VERSIONS[TESTED_ENGINE_VERSIONS.length - 1];
  const pin = platform ? enginePin(version, platform) : null;
  if (!platform || !pin) return p;
  const dest = path.join(engineCacheRoot(p.repoRoot, p.cwd), 'bin', version, WIN ? 'impeccable.exe' : 'impeccable');
  p.notes.push(`${SENTINEL.INSTALL_OFFER}: version=${version} platform=${platform} bytes=${pin.bytes} dest=${dest}`);
  return p;
}

// ── Install (the one download gstack makes, after consent) ───────────────────

interface InstallArgs { version?: string; sha256?: string; base?: string; host: string }

function installRefused(reason: string): number {
  process.stdout.write(`${SENTINEL.INSTALL_REFUSED}: ${reason}\n`);
  analytics({ verb: 'install', sentinel: 'INSTALL_REFUSED', exit: 1 });
  return 1;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Download the pinned engine for this machine into the user's cache. Runs only
 * after the skill's AskUserQuestion got a yes (the prose never runs it otherwise).
 * Fail-closed on the egress receipt, the checksum, and the size cap: on any
 * refusal nothing is written. --sha256 accepts a checksum from the release's
 * .sha256 sidecar for a version gstack has not pinned; --base allows a mirror
 * (https, or http on loopback for tests).
 */
async function install(args: InstallArgs): Promise<number> {
  if (configDesignDetector() === 'off') return installRefused('design_detector is off; `gstack-config set design_detector auto` first');
  const platform = enginePlatform();
  if (!platform) return installRefused(`impeccable ships no engine for ${process.platform}-${process.arch}`);
  const version = (args.version ?? TESTED_ENGINE_VERSIONS[TESTED_ENGINE_VERSIONS.length - 1]).replace(/^v/, '');
  if (!semverKey(version)) return installRefused(`"${version}" is not a version`);
  const pin = enginePin(version, platform);
  const expected = (args.sha256 ?? pin?.sha256 ?? '').toLowerCase();
  if (!expected) return installRefused(`gstack pins no checksum for engine ${version} on ${platform}; pass --sha256 <hex> from the release's .sha256 sidecar to accept an unpinned download`);
  if (!/^[0-9a-f]{64}$/.test(expected)) return installRefused('--sha256 must be 64 hex characters');
  let baseUrl: URL;
  try { baseUrl = new URL(args.base ?? ENGINE_RELEASE_BASE); } catch { return installRefused(`--base is not a URL: ${args.base}`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname);
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback)) return installRefused('--base must be https (http only for a loopback mirror)');
  const cwd = realpathOrNull(process.cwd()) ?? process.cwd();
  const repoRoot = gitTopLevel(cwd) ?? cwd;
  const destDir = path.join(engineCacheRoot(repoRoot, cwd), 'bin', version);
  if (underProject(destDir, repoRoot, cwd)) return installRefused(`${destDir} lies inside the project; the engine lives under your home directory only`);
  const dest = path.join(destDir, WIN ? 'impeccable.exe' : 'impeccable');
  const asset = `impeccable-${platform}${platform.startsWith('windows') ? '.exe' : ''}`;
  const url = `${baseUrl.toString().replace(/\/$/, '')}/engine-v${version}/${asset}`;
  const cap = DETECT_LIMITS.engineDownloadBytes;

  let present = false;
  try { present = fs.existsSync(dest) && sha256File(dest) === expected; } catch { present = false; }
  if (present) {
    process.stdout.write(`${SENTINEL.INSTALLED}: ${dest} version=${version} sha256=${expected} (already present, checksum verified)\n`);
    const p = probe(args.host);
    process.stdout.write(probeLines(p).join('\n') + '\n');
    analytics({ verb: 'install', sentinel: 'INSTALLED', engine: version, exit: 0 });
    return 0;
  }

  // The receipt is written BEFORE the fetch and the install is fail-closed on it:
  // an executable arriving on the machine unrecorded is worse than no install.
  let receipt: string;
  try {
    receipt = writeReceipt({
      sink: 'design-detect-engine-download', host: baseUrl.host, payloadClass: 'engine-binary-fetch', bytes: 0, sha256: null,
      consent: `design_detector=auto design_detector_install_prompted=false; user accepted the install offer for impeccable engine ${version} (${platform}); checksum ${args.sha256 ? 'from --sha256' : 'pinned in gstack'}`,
    }).id;
  } catch (err) {
    return installRefused(`egress receipt could not be written, nothing downloaded (${clip(stripControl(String((err as Error)?.message ?? err)), 200)})`);
  }
  const outcome = (status: string | number) => { try { writeOutcome({ receipt, status }); } catch { /* bookkeeping only */ } };
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DETECT_LIMITS.engineDownloadTimeoutMs) });
  } catch (err) {
    outcome('network-error');
    return installRefused(`download failed: ${clip(stripControl(String((err as Error)?.message ?? err)), 200)}`);
  }
  if (!res.ok || !res.body) { outcome(res.status); return installRefused(`download failed: HTTP ${res.status} for ${url}`); }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) { outcome(`${res.status} oversize`); return installRefused(`asset declares ${declared} bytes, above the ${cap}-byte cap`); }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel(); outcome(`${res.status} oversize`); return installRefused(`asset exceeds the ${cap}-byte cap; nothing written`); }
    chunks.push(value);
  }
  outcome(`${res.status} ${total}B`);
  const buf = Buffer.concat(chunks);
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) return installRefused(`checksum mismatch: expected ${expected}, got ${actual}; nothing written`);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  process.stdout.write(`${SENTINEL.INSTALLED}: ${dest} version=${version} sha256=${actual} bytes=${total}\n`);
  analytics({ verb: 'install', sentinel: 'INSTALLED', engine: version, exit: 0 });
  const p = probe(args.host);
  process.stdout.write(probeLines(p).join('\n') + '\n');
  return 0;
}

/** Identity label for an engine with no version source: size + the first few MB hashed (a whole-binary read per probe is wasted work). */
function engineIdentity(file: string): string {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, DETECT_LIMITS.engineHashBytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return createHash('sha256').update(String(st.size)).update(buf.subarray(0, n)).digest('hex').slice(0, 12);
  } catch { return 'unreadable'; }
}

/** The sentinel NAME (IMPECCABLE_READY, ...) for analytics, one vocabulary for probe and scan. */
function sentinelName(p: Probe): string {
  return p.sentinel.split(':')[0];
}

function probeLines(p: Probe): string[] {
  const lines = [p.sentinel, `${SENTINEL.SKILL}: ${p.skillPresent ? 'present' : 'absent'}`, `${SENTINEL.HOOK}: ${p.hook}`];
  if (p.hookOther.length) lines.push(`${SENTINEL.HOOK_OTHER}: ${p.hookOther.join(',')}`);
  lines.push(`${SENTINEL.IGNORED_RULES}: ${p.ignoredRules.join(',')}`);
  lines.push(`${SENTINEL.IGNORED_FILES}: ${p.ignoredFiles.join(',')}`);
  lines.push(`${SENTINEL.IGNORED_VALUES}: ${p.ignoredValues.join(',')}`);
  lines.push(...p.notes);
  if (p.steps.length) lines.push(...p.steps.map(s => `${SENTINEL.PROBE_STEP}: ${s}`));
  return lines;
}

// ── Sanitization ─────────────────────────────────────────────────────────────

function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return neutralizeSentinels(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[\r\n\t]+/g, ' '));
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function sanitizeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return new RegExp(`^[a-z0-9-]{1,${DETECT_LIMITS.field.id}}$`).test(s) ? s : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ── Scan ─────────────────────────────────────────────────────────────────────

interface ScanArgs { format: 'gstack' | 'raw'; changed?: string; targets: string[]; host: string }

function refuse(target: string, why: string) {
  process.stderr.write(`${SENTINEL.DETECT_REFUSED}: ${clip(stripControl(target), DETECT_LIMITS.field.refusedTarget)} (${why})\n`);
}

function designsRoot(): string {
  return path.join(gstackHome(), 'projects');
}

type TargetClass = 'project' | 'artifact' | 'dom-dump';

/**
 * Where a target lives, or null when it is outside every allowed root:
 *   project   under the repository or cwd (project directories only, see isProjectDir)
 *   dom-dump  <gstack home>/projects/<slug>/designs/<audit>/dom/**  (a page's own bytes)
 *   artifact  any other file under <gstack home>/projects/<slug>/designs/ (gstack-authored: finalized.html, previews)
 */
function targetClass(real: string, p: Probe): TargetClass | null {
  if (underProject(real, p.repoRoot, p.cwd)) return 'project';
  const projects = realpathOrNull(designsRoot());
  if (!projects || !isInside(real, projects)) return null;
  const rel = path.relative(projects, real).split(path.sep);
  if (rel.length < 3 || rel[1] !== 'designs') return null;
  if (rel[3] === 'dom') return 'dom-dump';
  // A directory under designs/ (an audit dir, the designs root) may hold dom/ subtrees the engine will walk: treat it as dumps.
  try { if (fs.statSync(real).isDirectory()) return 'dom-dump'; } catch { /* vanished: the engine reports it */ }
  return 'artifact';
}

function allowedTarget(real: string, p: Probe): boolean {
  return targetClass(real, p) !== null;
}

function resolveTargets(args: ScanArgs, p: Probe): { targets: string[]; refusedBase: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(file|data|javascript):/i.test(raw)) { refuse(raw, 'URL targets are never scanned'); return; }
    const abs = path.isAbsolute(raw) ? raw : path.join(p.cwd, raw);
    const real = realpathOrNull(abs);
    if (!real) { refuse(raw, 'does not exist'); return; }
    if (!allowedTarget(real, p)) { refuse(raw, 'outside the repository and the design-report allow-list'); return; }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(real);
  };
  for (const t of args.targets) push(t);
  if (args.changed !== undefined) {
    const base = args.changed;
    if (!base || base.startsWith('-')) { refuse(base || '(empty)', 'not a ref name'); return { targets: out, refusedBase: true }; }
    const top = gitTopLevel(p.cwd);
    if (!top) { refuse(base, 'not a repository'); return { targets: out, refusedBase: true }; }
    const files = new Set<string>();
    const runZ = (argv: string[]): boolean => {
      const r = spawnSync('git', argv, { cwd: top, encoding: 'buffer', timeout: DETECT_LIMITS.gitTimeoutMs, maxBuffer: DETECT_LIMITS.gitMaxBuffer });
      if (r.status !== 0) return false;
      for (const rel of r.stdout.toString('utf-8').split('\0')) if (rel) files.add(rel);
      return true;
    };
    if (!runZ(['diff', '-z', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])) {
      // A base that does not resolve must not read as "no frontend changes".
      refuse(base, 'git diff against this base failed (unknown ref or unfetched base)');
      return { targets: out, refusedBase: true };
    }
    runZ(['diff', '-z', '--name-only', '--diff-filter=ACMR', 'HEAD']);
    runZ(['ls-files', '-z', '--others', '--exclude-standard']);
    for (const rel of [...files].sort()) {
      if (!isFrontendPath(rel)) continue;
      const abs = path.join(top, rel);
      try { if (fs.lstatSync(abs).isSymbolicLink()) { refuse(rel, 'symlink named by git is never scanned'); continue; } } catch { continue; }
      const real = realpathOrNull(abs);
      if (!real) continue; // deleted or unreadable
      try { if (!fs.statSync(real).isFile()) continue; } catch { continue; }
      if (!allowedTarget(real, p)) { refuse(rel, 'outside the repository and the design-report allow-list'); continue; }
      if (!seen.has(real)) { seen.add(real); out.push(real); }
    }
  }
  return { targets: out, refusedBase: false };
}

interface EngineRun { exit: number; stdout: string; stderr: string; timedOut: boolean; tooLarge: boolean }

/** Environment the engine may see (Windows keys compared case-insensitively: process.env there enumerates `Path`, `SystemRoot`). */
const ENGINE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TERM', 'NO_COLOR',
  'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA',
]);

/**
 * The engine sees PATH/HOME/TMPDIR/locale and its own IMPECCABLE_* knobs, never the
 * agent's tokens. PATH loses entries inside the project (a direnv `.envrc` adding
 * `$PWD/node_modules/.bin` must not let the repository supply helpers by name).
 */
function engineEnv(p: Probe): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) continue;
    const key = WIN ? k.toUpperCase() : k;
    if (key === 'PATH') {
      out[k] = v.split(path.delimiter).filter(e => {
        if (!e || !path.isAbsolute(e)) return false;
        const real = realpathOrNull(e);
        return real !== null && !underProject(real, p.repoRoot, p.cwd);
      }).join(path.delimiter);
    } else if (ENGINE_ENV_KEYS.has(key) || key.startsWith('LC_') || key.startsWith('IMPECCABLE_')) out[k] = v;
  }
  return out;
}

function runEngine(p: Probe, engine: string, batch: string[], cwd: string, timeoutMs: number, extra: string[] = []): EngineRun {
  const r = Bun.spawnSync([engine, 'detect', '--json', ...extra, ...batch], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: engineEnv(p),
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: DETECT_LIMITS.stdoutBytes + 1024,
  });
  const out = r.stdout ?? new Uint8Array();
  const tooLarge = out.byteLength > DETECT_LIMITS.stdoutBytes;
  return {
    exit: r.exitCode ?? 1,
    stdout: tooLarge ? '' : Buffer.from(out).toString('utf-8'),
    stderr: Buffer.from(r.stderr ?? new Uint8Array()).toString('utf-8'),
    timedOut: Boolean((r as { exitedDueToTimeout?: boolean }).exitedDueToTimeout),
    tooLarge,
  };
}

function normalize(raw: unknown): NormalizedFinding {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const idRaw = f.antipattern ?? f.rule ?? f.id ?? f.ruleId;
  const id = sanitizeId(idRaw);
  const entry = id ? entryForImpeccableId(id) : undefined;
  const lim = DETECT_LIMITS.field;
  const advisory = (id ? ADVISORY_RULE_IDS.includes(id) : false) || f.advisory === true || str(f.severity).toLowerCase() === 'advisory';
  const rawKind = str(f.category);
  const base: NormalizedFinding = {
    id: entry?.id ?? id ?? 'unmapped',
    impeccableId: id ?? 'unmapped', // an id that fails the shape check is never used as a key or printed
    file: clip(stripControl(str(f.file ?? f.path)), lim.file),
    line: Number.isFinite(Number(f.line)) ? Number(f.line) : 0,
    snippet: clip(stripControl(str(f.snippet)), lim.snippet),
    message: clip(stripControl(str(f.description ?? f.message)), lim.message),
    category: entry?.category ?? 'unknown',
    kind: entry?.kind ?? (rawKind === 'slop' || rawKind === 'quality' ? rawKind : 'unknown'),
    impact: entry?.impact ?? 'medium',
    tier: entry?.tier ?? 'ask',
    advisory,
  };
  if (entry?.handoff) base.handoff = entry.handoff;
  if (typeof f.value === 'string' && f.value) base.value = clip(stripControl(f.value), lim.value);
  if (!entry) base.unmapped = true;
  return base;
}

function scan(args: ScanArgs): number {
  const p = probe(args.host);
  // Every probe line goes to stderr: stdout is the JSON document or nothing, so the
  // rendered `scan > "$_DJ"` never captures a sentinel as if it were a scan result.
  for (const line of probeLines(p)) process.stderr.write(line + '\n');
  if (!p.engine) {
    analytics({ verb: 'scan', sentinel: sentinelName(p), exit: 0 });
    return 0;
  }

  const { targets, refusedBase } = resolveTargets(args, p);
  if (!targets.length) {
    if (!refusedBase) process.stderr.write(`${SENTINEL.DETECT_NO_TARGETS}\n`);
    process.stderr.write(`${SENTINEL.DETECT_EXIT}: ${refusedBase ? 1 : 0}\n`);
    analytics({ verb: 'scan', sentinel: sentinelName(p), engine: p.engineVersion, targets: 0, exit: refusedBase ? 1 : 0 });
    return refusedBase ? 1 : 0;
  }

  const timeoutMs = Number(ENV.GSTACK_DESIGN_DETECT_TIMEOUT_MS) > 0 ? Number(ENV.GSTACK_DESIGN_DETECT_TIMEOUT_MS) : DETECT_LIMITS.timeoutMs;
  const rawFindings: unknown[] = [];
  const rawChunks: string[] = [];
  const diagnostics: string[] = [];
  let diagnosticsTotal = 0;
  let exit = 0;
  const started = Date.now();
  // Repository files and gstack-authored artifacts honor inline `impeccable-disable`
  // comments (the user's or the agent's). DOM dumps are the audited page's bytes:
  // an inline ignore there is page-controlled, so those batches disable them.
  const isDump = (t: string) => targetClass(t, p) === 'dom-dump';
  const batches: Array<{ files: string[]; extra: string[] }> = [];
  for (const [files, extra] of [[targets.filter(t => !isDump(t)), []], [targets.filter(isDump), ['--no-inline-ignores']]] as Array<[string[], string[]]>) {
    for (let i = 0; i < files.length; i += DETECT_LIMITS.batch) batches.push({ files: files.slice(i, i + DETECT_LIMITS.batch), extra });
  }
  const totalBudgetMs = timeoutMs * DETECT_LIMITS.totalTimeoutFactor;
  for (const [k, { files: batch, extra }] of batches.entries()) {
    if (Date.now() - started > totalBudgetMs) {
      process.stderr.write(`${SENTINEL.DETECT_TIMEOUT}: whole-scan budget ${totalBudgetMs}ms exceeded, ${batches.length - k} of ${batches.length} batches not run\n`);
      exit = 1;
      break;
    }
    const run = runEngine(p, p.engine, batch, p.repoRoot, timeoutMs, extra);
    for (const line of run.stderr.split('\n')) {
      if (!line.trim()) continue;
      diagnosticsTotal++;
      if (diagnostics.length < DETECT_LIMITS.diagnosticsKept) diagnostics.push(clip(stripControl(line), DETECT_LIMITS.field.diagnostic));
    }
    if (run.timedOut) { process.stderr.write(`${SENTINEL.DETECT_TIMEOUT}: ${timeoutMs}ms\n`); exit = 1; continue; }
    if (run.tooLarge) { process.stderr.write(`${SENTINEL.DETECT_OUTPUT_TOO_LARGE}: engine stdout exceeded ${DETECT_LIMITS.stdoutBytes} bytes\n`); exit = 1; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(run.stdout.trim() || 'null'); } catch { parsed = undefined; }
    if (!Array.isArray(parsed)) {
      process.stderr.write(`${SENTINEL.DETECT_PARSE_ERROR}: ${clip(stripControl(run.stdout), DETECT_LIMITS.field.parseErrorPreview)}\n`);
      exit = 1;
      continue;
    }
    if (args.format === 'raw') rawChunks.push(run.stdout);
    rawFindings.push(...parsed);
    if (run.exit === 1) exit = 1;
    else if (run.exit === 2 && exit !== 1) exit = 2;
    else if (run.exit !== 0 && run.exit !== 2 && exit !== 1) exit = 1;
  }

  if (refusedBase) exit = 1; // a refused base is a failed target even when explicit targets scanned
  if (args.format === 'raw') {
    process.stdout.write(rawChunks.length === 1 ? rawChunks[0] : JSON.stringify(rawFindings, null, 2) + '\n');
  } else {
    // Only the kept findings are sanitized; at the stdout ceiling the rest would be normalized and discarded.
    const truncated = rawFindings.length > DETECT_LIMITS.findings;
    const findings = (truncated ? rawFindings.slice(0, DETECT_LIMITS.findings) : rawFindings).map(normalize);
    const total = rawFindings.length;
    const byRule: Record<string, number> = Object.create(null); // engine ids are untrusted keys: no prototype members to collide with
    let advisory = 0, high = 0, medium = 0, polish = 0, slop = 0, quality = 0;
    for (const f of findings) {
      byRule[f.impeccableId] = (byRule[f.impeccableId] ?? 0) + 1;
      if (f.advisory) { advisory++; continue; }
      if (f.kind === 'slop') slop++; else if (f.kind === 'quality') quality++;
      if (f.impact === 'high') high++; else if (f.impact === 'medium') medium++; else polish++;
    }
    const result: ScanResult = {
      schemaVersion: 1, engine: p.engine, engineVersion: p.engineVersion ?? 'unknown', targets: targets.length,
      exit, total, counted: findings.length - advisory, advisory, ignoredRules: p.ignoredRules, byRule, findings, truncated,
      diagnostics: diagnosticsTotal > diagnostics.length ? [...diagnostics, `… ${diagnosticsTotal - diagnostics.length} more engine stderr lines not kept`] : diagnostics,
      untrusted: SCAN_UNTRUSTED_PATHS,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    writeTop(findings, total, truncated);
    process.stderr.write(`${SENTINEL.DETECT_SUMMARY}: total=${total} slop=${slop} quality=${quality} advisory=${advisory} ignored=${p.ignoredRules.length} high=${high} medium=${medium} polish=${polish}${truncated ? ' truncated=true' : ''}\n`);
  }
  for (const d of diagnostics.slice(0, DETECT_LIMITS.diagnosticsEchoed)) process.stderr.write(`${SENTINEL.ENGINE_STDERR}: ${d}\n`);
  process.stderr.write(`${SENTINEL.DETECT_EXIT}: ${exit}\n`);
  analytics({ verb: 'scan', sentinel: sentinelName(p), engine: p.engineVersion, targets: targets.length, total: rawFindings.length, ignored: p.ignoredRules.length, exit, ms: Date.now() - started });
  return exit;
}

const IMPACT_ORDER = { high: 0, medium: 1, polish: 2 } as const;

function writeTop(findings: NormalizedFinding[], total: number, truncated: boolean) {
  const groups = new Map<string, NormalizedFinding[]>();
  for (const f of findings) {
    if (f.advisory) continue;
    const g = groups.get(f.impeccableId) ?? [];
    g.push(f);
    groups.set(f.impeccableId, g);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    (IMPACT_ORDER[a[1][0].impact] - IMPACT_ORDER[b[1][0].impact]) || (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
  const lines = [UNTRUSTED_BEGIN, `${SENTINEL.DETECT_TOP} total=${total} rules=${groups.size}${truncated ? ' truncated=true' : ''}`];
  let shown = 0;
  for (const [id, group] of ordered) {
    const f0 = group[0];
    lines.push(`[${id}] impact=${f0.impact} tier=${f0.tier} count=${group.length}${f0.handoff ? ` handoff=/impeccable ${f0.handoff}` : ''}${f0.unmapped ? ' unmapped' : ''}`);
    for (const f of group) {
      if (shown >= DETECT_LIMITS.topLocations) break;
      lines.push(`  ${f.file}:${f.line}  ${f.snippet}`);
      shown++;
    }
  }
  if (shown >= DETECT_LIMITS.topLocations && total > shown) lines.push(`  … ${total - shown} more locations in the JSON`);
  lines.push(UNTRUSTED_END);
  process.stderr.write(lines.join('\n') + '\n');
}

// ── rules ────────────────────────────────────────────────────────────────────

function rules(): number {
  const mapped = DESIGN_SLOP_CATALOG.filter(e => e.impeccableId);
  process.stdout.write(`# ${mapped.length} detector rules mapped in lib/design-catalog.ts; tested engine versions: ${TESTED_ENGINE_VERSIONS.join(', ')}\n`);
  process.stdout.write('id\tkind\timpact\ttier\thandoff\tname\n');
  for (const e of mapped) process.stdout.write(`${e.impeccableId}\t${e.kind}\t${e.impact}\t${e.tier}\t${e.handoff ?? '-'}\t${e.name}\n`);
  return 0;
}

// ── Analytics (local, best-effort) ───────────────────────────────────────────

function analytics(rec: Record<string, unknown>) {
  try {
    const dir = path.join(gstackHome(), 'analytics');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'design-detector.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* never throws */ }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parse(argv: string[]): { verb: string; host: string; verbose: boolean; scan: ScanArgs; install: InstallArgs } {
  const verb = argv[0] ?? '';
  let host = 'claude';
  let verbose = false;
  let format: 'gstack' | 'raw' = 'gstack';
  let changed: string | undefined;
  const install: InstallArgs = { host };
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') host = argv[++i] ?? host;
    else if (a === '--verbose') verbose = true;
    else if (a === '--format') { const v = argv[++i]; format = v === 'raw' ? 'raw' : 'gstack'; }
    else if (a === '--changed') changed = argv[++i] ?? ''; // an empty base is refused in resolveTargets, never defaulted
    else if (a === '--version') install.version = argv[++i] ?? '';
    else if (a === '--sha256') install.sha256 = argv[++i] ?? '';
    else if (a === '--base') install.base = argv[++i] ?? '';
    else if (a === '--') { targets.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('--')) process.stderr.write(`ignoring unknown flag ${a}\n`);
    else targets.push(a);
  }
  install.host = host;
  return { verb, host, verbose, scan: { format, changed, targets, host }, install };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { verb, host, verbose, scan: scanArgs, install: installArgs } = parse(argv);
  switch (verb) {
    case 'probe': {
      const p = probe(host, verbose);
      process.stdout.write(probeLines(p).join('\n') + '\n');
      analytics({ verb: 'probe', sentinel: sentinelName(p), engine: p.engineVersion, hook: p.hook, ignored: p.ignoredRules.length, exit: 0 });
      return 0;
    }
    case 'scan':
      return scan(scanArgs);
    case 'rules':
      return rules();
    case 'install':
      return install(installArgs);
    default:
      process.stderr.write('usage: gstack-design-detect.ts probe [--host <h>] [--verbose] | scan [--format gstack|raw] [--changed <base>] [--host <h>] <paths...> | rules | install [--version <v>] [--sha256 <hex>] [--base <url>]\n');
      return 2;
  }
}

if (import.meta.main) {
  // exitCode, not process.exit(): a pipe write over 64 KB (a big scan) is still
  // in flight when process.exit() runs and would be truncated mid-JSON.
  main().then((code) => { process.exitCode = code; }, (err) => {
    const e = err as Error;
    process.stderr.write(`${SENTINEL.INTERNAL_ERROR}: ${e?.name ?? 'Error'}: ${clip(stripControl(String(e?.message ?? e)), DETECT_LIMITS.field.internalError)}\n`);
    analytics({ verb: process.argv[2] ?? '', sentinel: 'INTERNAL_ERROR', exit: 3 });
    process.exitCode = 3;
  });
}
