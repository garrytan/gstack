/**
 * runtime-pins — what a target project pins for Bun and Node, and whether the
 * running versions satisfy it. Feeds the doctor's `project pins` row
 * (bin/gstack-runtime-pins.ts; bin/gstack-doctor-check.sh reads the
 * PINS_VERDICT line) and nothing else reads project pins by hand.
 *
 * Sources, each kept with its file:line: package.json (`packageManager`,
 * `engines.bun`, `engines.node`), `.tool-versions`, `.nvmrc`, `.bun-version`
 * and `bun-version:` / `node-version:` lines in `.github/workflows/*.yml`. A
 * range (`>=1.4.2`) is told apart from an exact pin (`1.4.2`); a CI pin keeps
 * the platform lane of the job's `runs-on`, so a Windows job's pin never fails
 * a Linux run. A value this module cannot evaluate (`lts/*`, a matrix
 * expression) is reported as skipped, never silently dropped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Tool = 'bun' | 'node';
export type Lane = 'any' | 'linux' | 'macos' | 'windows';

export interface Pin {
  tool: Tool;
  /** The constraint as written (`>=1.4.2`, `1.4.2`, `24`, `lts/*`). */
  constraint: string;
  kind: 'exact' | 'range' | 'unevaluable';
  /** `package.json:81`, `.github/workflows/x.yml:84`. */
  source: string;
  /** Where the pin comes from: `engines.bun`, `packageManager`, `.nvmrc`, `CI`. */
  field: string;
  lane: Lane;
}

export interface Running { bun?: string; node?: string }

export interface PinReport {
  pins: Pin[];
  /** Distinct effective constraints with their first source and count, for a one-line row. */
  summary: string[];
  /** Human lines: one per failing tool. */
  failures: string[];
  /** Pins skipped as unevaluable, one line each. */
  skipped: string[];
  verdict: 'pass' | 'fail' | 'none';
}

const RANGE_OP = /^(>=|<=|>|<|=|\^|~)/;

type Ver = [number, number, number];

/** Parse `v1.2.3`, `1.2`, `24` into a triple; null when not a version. */
export function parseVersion(text: string): Ver | null {
  const m = text.trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  const n = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])];
}

const cmp = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Components written (`1.4` → 2, `24` → 1, `1.4.x` → 2) for prefix pins. */
function writtenParts(text: string): number {
  const parts = text.trim().replace(/^v/, '').split(/[-+]/)[0].split('.');
  return parts.filter(p => p !== 'x' && p !== '*').length;
}

function satisfiesOne(version: Ver, clause: string): boolean | null {
  const op = clause.match(RANGE_OP)?.[1] ?? '';
  const rest = clause.slice(op.length).trim();
  if (rest === '' || rest === '*' || rest === 'x') return true;
  const target = parseVersion(rest);
  if (!target) return null;
  const parts = writtenParts(rest);
  const upper: Ver = parts === 1 ? [target[0] + 1, 0, 0] : parts === 2 ? [target[0], target[1] + 1, 0] : [target[0], target[1], target[2] + 1];
  switch (op) {
    case '>=': return cmp(version, target) >= 0;
    case '>': return parts === 3 ? cmp(version, target) > 0 : cmp(version, upper) >= 0;
    case '<=': return parts === 3 ? cmp(version, target) <= 0 : cmp(version, upper) < 0;
    case '<': return cmp(version, target) < 0;
    case '^': {
      const top: Ver = target[0] > 0 ? [target[0] + 1, 0, 0] : target[1] > 0 ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1];
      return cmp(version, target) >= 0 && cmp(version, top) < 0;
    }
    case '~': return cmp(version, target) >= 0 && cmp(version, parts === 1 ? [target[0] + 1, 0, 0] : [target[0], target[1] + 1, 0]) < 0;
    default: return cmp(version, target) >= 0 && cmp(version, upper) < 0;
  }
}

/**
 * `satisfies('1.3.14', '>=1.4.2')` → false. Supports `||` alternatives,
 * space-joined conjunctions, `>= > <= < = ^ ~`, `x`/`*` wildcards and partial
 * versions (`24` means 24.x.x). Returns null when the constraint cannot be
 * evaluated (`lts/*`, `node`, a `${{ }}` expression).
 */
export function satisfies(version: string, constraint: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  let sawNull = false;
  for (const alt of constraint.split('||')) {
    const clauses = alt.trim().replace(/\s*(>=|<=|>|<|=|\^|~)\s*/g, ' $1').trim().split(/\s+/).filter(Boolean);
    if (clauses.length === 0) continue;
    const results = clauses.map(c => satisfiesOne(v, c));
    if (results.some(r => r === null)) { sawNull = true; continue; }
    if (results.every(Boolean)) return true;
  }
  return sawNull ? null : false;
}

export function classify(constraint: string): Pin['kind'] {
  const trimmed = constraint.trim();
  if (satisfies('0.0.0', trimmed) === null) return 'unevaluable';
  if (RANGE_OP.test(trimmed) || /\|\||\s|[x*]/.test(trimmed)) return 'range';
  return writtenParts(trimmed) === 3 ? 'exact' : 'range';
}

function laneOf(runsOn: string): Lane {
  const value = runsOn.toLowerCase();
  if (value.includes('windows')) return 'windows';
  if (value.includes('macos')) return 'macos';
  if (value.includes('ubuntu') || value.includes('linux')) return 'linux';
  return 'any';
}

function lineOf(text: string, needle: RegExp): number {
  const lines = text.split('\n');
  const i = lines.findIndex(l => needle.test(l));
  return i < 0 ? 1 : i + 1;
}

function readIf(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Every pin the project declares, in source order. */
export function collectPins(projectDir: string): Pin[] {
  const pins: Pin[] = [];
  const pkgText = readIf(path.join(projectDir, 'package.json'));
  if (pkgText) {
    let pkg: { packageManager?: unknown; engines?: Record<string, unknown> } = {};
    try { pkg = JSON.parse(pkgText); } catch { /* reported as no pins from package.json */ }
    if (typeof pkg.packageManager === 'string') {
      const m = pkg.packageManager.match(/^(bun|node)@([^+]+)/);
      if (m) pins.push({ tool: m[1] as Tool, constraint: m[2], kind: classify(m[2]), source: `package.json:${lineOf(pkgText, /"packageManager"/)}`, field: 'packageManager', lane: 'any' });
    }
    for (const tool of ['bun', 'node'] as const) {
      const value = pkg.engines?.[tool];
      if (typeof value !== 'string') continue;
      pins.push({ tool, constraint: value, kind: classify(value), source: `package.json:${lineOf(pkgText, new RegExp(`"${tool}"\\s*:`))}`, field: `engines.${tool}`, lane: 'any' });
    }
  }
  const toolVersions = readIf(path.join(projectDir, '.tool-versions'));
  if (toolVersions) {
    toolVersions.split('\n').forEach((line, i) => {
      const m = line.trim().match(/^(bun|nodejs|node)\s+(\S+)/);
      if (!m) return;
      const tool: Tool = m[1] === 'bun' ? 'bun' : 'node';
      pins.push({ tool, constraint: m[2], kind: classify(m[2]), source: `.tool-versions:${i + 1}`, field: '.tool-versions', lane: 'any' });
    });
  }
  for (const [file, tool] of [['.nvmrc', 'node'], ['.bun-version', 'bun']] as const) {
    const text = readIf(path.join(projectDir, file));
    const value = text?.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (value) pins.push({ tool, constraint: value, kind: classify(value), source: `${file}:1`, field: file, lane: 'any' });
  }
  const workflows = path.join(projectDir, '.github', 'workflows');
  let names: string[] = [];
  try { names = fs.readdirSync(workflows).filter(n => /\.ya?ml$/.test(n)).sort(); } catch { /* no workflows */ }
  for (const name of names) {
    const text = readIf(path.join(workflows, name));
    if (!text) continue;
    let lane: Lane = 'any';
    text.split('\n').forEach((line, i) => {
      const runsOn = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
      if (runsOn) { lane = laneOf(runsOn[1]); return; }
      const m = line.match(/^\s*(bun|node)-version:\s*["']?(\$\{\{.*?\}\}|[^"'#\s]+)["']?\s*(?:#.*)?$/);
      if (!m) return;
      const constraint = m[2];
      const kind = constraint.includes('${{') ? 'unevaluable' : classify(constraint);
      pins.push({ tool: m[1] as Tool, constraint, kind, source: `.github/workflows/${name}:${i + 1}`, field: 'CI', lane });
    });
  }
  return pins;
}

const PLATFORM_LANE: Record<string, Lane> = { linux: 'linux', darwin: 'macos', win32: 'windows' };

/** Distinct (tool, field, constraint, lane) groups with their first source and count. */
function groupPins(pins: Pin[]): Array<{ pin: Pin; count: number }> {
  const groups = new Map<string, { pin: Pin; count: number }>();
  for (const pin of pins) {
    const key = `${pin.tool}\t${pin.field === 'CI' ? 'CI' : pin.field}\t${pin.constraint}\t${pin.lane}`;
    const g = groups.get(key);
    if (g) g.count++; else groups.set(key, { pin, count: 1 });
  }
  return [...groups.values()];
}

const describe = (g: { pin: Pin; count: number }) =>
  `${g.pin.field === 'CI' ? `CI${g.pin.lane === 'any' ? '' : ` ${g.pin.lane} lane`}` : g.pin.field}, ${g.pin.source.replace(/^\.github\/workflows\//, '')}${g.count > 1 ? ` +${g.count - 1} more` : ''}`;

/** Evaluate the running versions against the pins that apply on this platform. */
export function evaluatePins(pins: Pin[], running: Running, platform: NodeJS.Platform = process.platform): PinReport {
  const here = PLATFORM_LANE[platform] ?? 'any';
  const failures: string[] = [];
  const skipped: string[] = [];
  const summary = groupPins(pins).map(g => `${g.pin.tool} ${g.pin.constraint} (${describe(g)})`);
  let evaluated = 0;
  for (const tool of ['bun', 'node'] as const) {
    const mine = pins.filter(p => p.tool === tool);
    if (mine.length === 0) continue;
    const version = running[tool];
    const applicable = mine.filter(p => p.lane === 'any' || p.lane === here);
    const unmet: Pin[] = [];
    for (const pin of applicable) {
      if (pin.kind === 'unevaluable') { skipped.push(`${tool} ${pin.constraint} (${pin.source}) not evaluated`); continue; }
      if (!version) { skipped.push(`${tool} ${pin.constraint} (${pin.source}): ${tool} not found on PATH`); continue; }
      evaluated++;
      if (satisfies(version, pin.constraint) === false) unmet.push(pin);
    }
    if (unmet.length === 0) continue;
    const [first, ...rest] = groupPins(unmet);
    const context = rest.map(g => `${describe(g)} pins ${g.pin.constraint}`);
    failures.push(`${tool} ${version} outside ${first.pin.field} ${first.pin.constraint} (${first.pin.source}${context.length ? '; ' + context.join('; ') : ''})`);
  }
  return { pins, summary, failures, skipped, verdict: failures.length ? 'fail' : evaluated ? 'pass' : 'none' };
}

/** The wire lines bin/gstack-doctor-check.sh reads (PINS_VERDICT last). */
export function renderPinLines(report: PinReport, platform: NodeJS.Platform = process.platform): string[] {
  const here = PLATFORM_LANE[platform] ?? 'any';
  const lines = report.pins.map(p => `PIN: ${p.tool} ${p.constraint} ${p.kind} ${p.source} lane=${p.lane}${p.lane !== 'any' && p.lane !== here ? ' (other platform)' : ''}`);
  for (const s of report.summary) lines.push(`PIN_SUMMARY: ${s}`);
  for (const s of report.skipped) lines.push(`PIN_SKIP: ${s}`);
  for (const f of report.failures) lines.push(`PIN_FAIL: ${f}`);
  lines.push(`PINS_VERDICT: ${report.verdict}`);
  return lines;
}
