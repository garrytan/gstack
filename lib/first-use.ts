/**
 * first-use — the cold first-use check for an app build (docs/first-use-check.md).
 * Before a build reaches its owner as "ready to try", an agent from another model
 * family plays that exact build on the same kind of device and account and does
 * the first five things the plan's day-one table says the owner will do. This
 * module keeps the record: an immutable start manifest (the frozen day-one rows
 * with their hash, the play spec, the build fingerprint, the builder's and the
 * checker's model families), one write-once file per action result with its
 * evidence copied in and hashed, dated link receipts, the checker's predicted
 * score and the owner's scores and words. decide() reads it back and refuses the
 * "try it" message unless every frozen action passed on this build, every link
 * was live within 15 minutes, the day-one rows are unchanged and a prediction
 * exists. The record lives in the owner's private user-level Capy Drive folder
 * on Capy (never the public repository), else under the gstack state root.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDayOne } from './autoplan-owner-text';
import { resolveStateRoot } from './state-root';
import { checkPlaySpec, type PlaySpec } from './first-use-message';

export const FIRST_USE_ACTIONS = 5;
export const LINK_FRESH_MS = 15 * 60 * 1000;
export const EVIDENCE_MAX_BYTES = 100 * 1024 * 1024;
export const EVIDENCE_KINDS: Record<string, 'screenshot' | 'video'> = {
  '.png': 'screenshot', '.jpg': 'screenshot', '.jpeg': 'screenshot', '.gif': 'screenshot', '.webp': 'screenshot', '.heic': 'screenshot',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video',
};
export type FirstUseCode = 'FIRST_USE_PLAN_UNREADY' | 'FIRST_USE_PLAY_SPEC_INCOMPLETE' | 'FIRST_USE_SAME_FAMILY' | 'FIRST_USE_NO_PRIVATE_DRIVE' | 'FIRST_USE_RECORD_INVALID' | 'FIRST_USE_REFUSED';
export interface FirstUseError { code: FirstUseCode; detail: string }
type Result<T> = T | { error: FirstUseError };
const fail = (code: FirstUseCode, detail: string) => ({ error: { code, detail } });

export interface FrozenAction { n: number; action: string; frequency: string; feature: string; route: string; first_build: string; check: string; source: string }
export interface BuildId { platform: 'ios' | 'android' | 'web'; commit: string; testflight?: string; deploy?: string }
export interface Manifest {
  schema_version: 1; kind: 'first-use-manifest'; app: string; created_at: string;
  source: { path: string; rows_sha256: string }; actions: FrozenAction[];
  build: BuildId & { fingerprint: string }; play: PlaySpec;
  builder: { model: string; family: string }; checker: { model: string; family: string };
}
export interface ActionResult {
  schema_version: 1; kind: 'first-use-result'; action: number; action_text: string; build_fingerprint: string; at: string;
  verdict: 'pass' | 'fail'; evidence: { file: string; sha256: string; bytes: number; kind: 'screenshot' | 'video' };
  device: string; account: string; by: { model: string; family: string }; note: string;
}
/** Who a check speaks for: the owner-equivalent account from the play spec and the build's device class. */
export interface Audience { account: string; device_class: BuildId['platform'] }
export const audienceOf = (m: Manifest): Audience => ({ account: m.play.account, device_class: m.build.platform });
const sameAudience = (a: Partial<Audience> | undefined, b: Audience) => a?.account === b.account && a?.device_class === b.device_class;
export interface LinkReceipt { schema_version: 1; kind: 'first-use-link'; url: string; build_fingerprint: string; audience: Audience; checked_at: string; status: number; login_gated: boolean; verdict: 'live' | 'down'; error?: string }
export interface Prediction { schema_version: 1; kind: 'first-use-prediction'; score: number; why: string; by: { model: string; family: string }; at: string; build_fingerprint: string }
export interface OwnerScore { schema_version: 1; kind: 'first-use-owner-score'; score: number; words: string; by: string; at: string; build_fingerprint: string }

const FAMILY_WORDS: Array<[string, RegExp]> = [
  ['anthropic', /\b(claude|opus|sonnet|haiku|fable)\b/],
  ['openai', /\b(gpt|codex|chatgpt)\b/],
  ['google', /\bgemini\b/],
  ['xai', /\bgrok\b/],
  ['meta', /\b(llama|muse)\b/],
  ['deepseek', /\bdeepseek\b/],
  ['moonshotai', /\bkimi\b/],
  ['qwen', /\bqwen\b/],
];
/**
 * A model's family: a known provider before the slash (`openai/gpt-6.2-sol` is openai), a bare family name, or a known
 * model word, which also wins over a routing prefix (`openrouter/anthropic/claude-…` is anthropic); else the unknown
 * provider before the slash, or undefined.
 */
export function modelFamily(model: string): string | undefined {
  const s = model.trim().toLowerCase();
  if (!s) return undefined;
  const slash = s.indexOf('/');
  const prefix = slash > 0 ? s.slice(0, slash) : s;
  if (FAMILY_WORDS.some(([f]) => f === prefix)) return prefix;
  return FAMILY_WORDS.find(([, re]) => re.test(s))?.[0] ?? (slash > 0 ? prefix : undefined);
}

/** The first five rows of the plan's `### Day one` table (lib/autoplan-owner-text.ts parses it; the format is pinned by test/first-use.test.ts). */
export function freezeActions(planText: string): Result<{ actions: FrozenAction[]; rows_sha256: string }> {
  const day = parseDayOne(planText);
  if (day.status === 'none') return fail('FIRST_USE_PLAN_UNREADY', 'the plan has no ### Day one table');
  if (day.status === 'malformed') return fail('FIRST_USE_PLAN_UNREADY', day.reason ?? 'the day-one table is malformed');
  if (day.rows.length < FIRST_USE_ACTIONS) return fail('FIRST_USE_PLAN_UNREADY', `the day-one table has ${day.rows.length} row${day.rows.length === 1 ? '' : 's'}; the check needs ${FIRST_USE_ACTIONS}`);
  const rows = day.rows.slice(0, FIRST_USE_ACTIONS);
  const blank = rows.map((r, i) => [r.frequency, r.source, r.feature, r.route, r.first_build, r.check].some(c => !c.trim()) ? i + 1 : 0).filter(Boolean);
  if (blank.length) return fail('FIRST_USE_PLAN_UNREADY', `day-one row ${blank.join(', ')} has an empty cell; every column of the first ${FIRST_USE_ACTIONS} rows needs a value`);
  const assumed = rows.map((r, i) => r.assumed ? i + 1 : 0).filter(Boolean);
  if (assumed.length) return fail('FIRST_USE_PLAN_UNREADY', `day-one row ${assumed.join(', ')} is still marked assumed`);
  const actions = rows.map((r, i) => ({ n: i + 1, action: r.action, frequency: r.frequency, feature: r.feature, route: r.route, first_build: r.first_build, check: r.check, source: r.source }));
  return { actions, rows_sha256: sha256(JSON.stringify(actions)) };
}

/** Validates a build id; the fingerprint is the hash of platform, commit and the TestFlight build or deploy version. */
export function buildFingerprint(b: Partial<BuildId>): Result<BuildId & { fingerprint: string }> {
  if (b.platform !== 'ios' && b.platform !== 'android' && b.platform !== 'web') return fail('FIRST_USE_RECORD_INVALID', '--platform must be ios, android or web');
  if (!/^[0-9a-f]{40}$/.test(b.commit ?? '')) return fail('FIRST_USE_RECORD_INVALID', '--commit must be the full 40-character commit the build was made from');
  const tf = b.testflight?.trim(), dep = b.deploy?.trim();
  if (!!tf === !!dep) return fail('FIRST_USE_RECORD_INVALID', 'give exactly one of --testflight <build number> or --deploy <version>');
  const id: BuildId = { platform: b.platform, commit: b.commit!, ...(tf ? { testflight: tf } : { deploy: dep }) };
  return { ...id, fingerprint: sha256(JSON.stringify([id.platform, id.commit, id.testflight ?? '', id.deploy ?? ''])).slice(0, 16) };
}
export const buildLabel = (b: BuildId) => `${b.commit.slice(0, 12)}, ${b.testflight ? `TestFlight build ${b.testflight}` : `deploy ${b.deploy}`}`;

/**
 * Where records live: GSTACK_FIRST_USE_DIR; on Capy (GSTACK_CAPY=1) the one `~/.capy/drive/user-*` folder's
 * `first-use/` (none or several refuses, never the throwaway machine folder); elsewhere `<state root>/first-use`.
 */
export function recordRoot(env: NodeJS.ProcessEnv = process.env): Result<{ root: string }> {
  if (env.GSTACK_FIRST_USE_DIR) return { root: path.resolve(env.GSTACK_FIRST_USE_DIR) };
  if (env.GSTACK_CAPY !== '1') return { root: path.join(resolveStateRoot(env), 'first-use') };
  const drive = path.join(env.HOME || os.homedir(), '.capy', 'drive');
  let found: string[] = [];
  try { found = fs.readdirSync(drive).filter(d => d.startsWith('user-') && fs.statSync(path.join(drive, d)).isDirectory()); } catch { /* no drive mounted */ }
  if (found.length !== 1) return fail('FIRST_USE_NO_PRIVATE_DRIVE', found.length ? `${found.length} user-level drive folders (${found.join(', ')})` : `no user-level drive folder under ${drive}`);
  return { root: path.join(drive, found[0]!, 'first-use') };
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '');
const writeOnce = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
};
const readJson = <T>(file: string): T | undefined => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; } };

export interface StartInput { root: string; app: string; planPath: string; build: Partial<BuildId>; play: unknown; builder: string; checker: string; now?: Date }
/** Freezes the day-one rows and writes the run's manifest once; returns the run directory. */
export function startRun(o: StartInput): Result<{ dir: string; manifest: Manifest }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.app)) return fail('FIRST_USE_RECORD_INVALID', '--app must be a lowercase slug like ghome');
  let planText: string;
  try { planText = fs.readFileSync(o.planPath, 'utf8'); } catch { return fail('FIRST_USE_PLAN_UNREADY', `cannot read ${o.planPath}`); }
  const frozen = freezeActions(planText);
  if ('error' in frozen) return frozen;
  const play = checkPlaySpec(o.play);
  if ('error' in play) return play;
  const build = buildFingerprint(o.build);
  if ('error' in build) return build;
  const builder = modelFamily(o.builder), checker = modelFamily(o.checker);
  if (!builder || !checker) return fail('FIRST_USE_SAME_FAMILY', `unknown model family for ${!builder ? `--builder ${o.builder}` : `--checker ${o.checker}`}`);
  if (builder === checker) return fail('FIRST_USE_SAME_FAMILY', `builder and checker are both ${builder}`);
  const now = o.now ?? new Date();
  const manifest: Manifest = {
    schema_version: 1, kind: 'first-use-manifest', app: o.app, created_at: now.toISOString(),
    source: { path: path.resolve(o.planPath), rows_sha256: frozen.rows_sha256 }, actions: frozen.actions,
    build, play: play.spec, builder: { model: o.builder, family: builder }, checker: { model: o.checker, family: checker },
  };
  const dir = path.join(o.root, o.app, `${stamp(now)}-${build.fingerprint.slice(0, 8)}`);
  try { writeOnce(path.join(dir, 'manifest.json'), manifest); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${dir}/manifest.json: ${(e as Error).message}`); }
  return { dir, manifest };
}

export function readManifest(dir: string): Result<{ manifest: Manifest }> {
  const m = readJson<Manifest>(path.join(dir, 'manifest.json'));
  if (!m || m.schema_version !== 1 || m.kind !== 'first-use-manifest' || !Array.isArray(m.actions) || !m.build?.fingerprint) return fail('FIRST_USE_RECORD_INVALID', `no readable manifest.json in ${dir}`);
  return { manifest: m };
}

/** The checker's own model, from its own family: the builder never grades its own build. */
function checkerOf(m: Manifest, by: string): Result<{ by: { model: string; family: string } }> {
  const family = modelFamily(by);
  if (!family || family !== m.checker.family) return fail('FIRST_USE_SAME_FAMILY', `--by ${by} is ${family ?? 'an unknown family'}; this run's checker is ${m.checker.family} (${m.checker.model})`);
  return { by: { model: by, family } };
}

export interface RecordInput { dir: string; action: number; verdict: string; evidence: string; device: string; account: string; by: string; note?: string; now?: Date }
/** One write-once result for one frozen action; the evidence file is copied into the run and hashed. */
export function recordResult(o: RecordInput): Result<{ file: string; result: ActionResult }> {
  const read = readManifest(o.dir);
  if ('error' in read) return read;
  const m = read.manifest;
  const action = m.actions.find(a => a.n === o.action);
  if (!action) return fail('FIRST_USE_RECORD_INVALID', `--action must be 1 to ${m.actions.length}`);
  if (o.verdict !== 'pass' && o.verdict !== 'fail') return fail('FIRST_USE_RECORD_INVALID', '--verdict must be pass or fail');
  if (!o.device.trim()) return fail('FIRST_USE_RECORD_INVALID', 'name the --device you played on');
  if (o.account.trim() !== m.play.account) return fail('FIRST_USE_RECORD_INVALID', `play on the owner-equivalent account and pass it exactly: --account "${m.play.account}"`);
  if (o.verdict === 'fail' && !o.note?.trim()) return fail('FIRST_USE_RECORD_INVALID', 'a fail needs --note saying what happened');
  const who = checkerOf(m, o.by);
  if ('error' in who) return who;
  const ev = copyEvidence(o.dir, o.action, o.evidence);
  if ('error' in ev) return ev;
  const now = o.now ?? new Date();
  const result: ActionResult = {
    schema_version: 1, kind: 'first-use-result', action: o.action, action_text: action.action, build_fingerprint: m.build.fingerprint, at: now.toISOString(),
    verdict: o.verdict, evidence: ev.evidence, device: o.device.trim(), account: o.account.trim(), by: who.by, note: o.note?.trim() ?? '',
  };
  const file = path.join(o.dir, 'results', `${o.action}-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}.json`);
  try { writeOnce(file, result); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${file}: ${(e as Error).message}`); }
  return { file, result };
}

function copyEvidence(dir: string, n: number, src: string): Result<{ evidence: ActionResult['evidence'] }> {
  const kind = EVIDENCE_KINDS[path.extname(src).toLowerCase()];
  if (!kind) return fail('FIRST_USE_RECORD_INVALID', `evidence must be a screenshot or short video (${Object.keys(EVIDENCE_KINDS).join(' ')})`);
  let st: fs.Stats;
  try { st = fs.lstatSync(src); } catch { return fail('FIRST_USE_RECORD_INVALID', `no evidence file at ${src}`); }
  if (!st.isFile()) return fail('FIRST_USE_RECORD_INVALID', 'the evidence must be a regular file, not a link or directory');
  if (st.size === 0 || st.size > EVIDENCE_MAX_BYTES) return fail('FIRST_USE_RECORD_INVALID', `the evidence is ${st.size} bytes (1 to ${EVIDENCE_MAX_BYTES})`);
  const bytes = fs.readFileSync(src);
  const digest = sha256(bytes);
  const file = path.join('evidence', `${n}-${digest.slice(0, 16)}${path.extname(src).toLowerCase()}`);
  try {
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    if (!fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), bytes, { flag: 'wx' });
  } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${path.join(dir, file)}: ${(e as Error).message}`); }
  return { evidence: { file, sha256: digest, bytes: bytes.length, kind } };
}

export type Fetcher = (url: string) => Promise<{ status: number }>;
export const liveFetcher: Fetcher = async url => {
  const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
};

/**
 * Checks every play link once for the run's audience (the owner-equivalent account and device class) and writes a
 * dated receipt per link bound to that audience; a login-gated link passes on 401 or 403 only when the play spec marks it.
 */
export async function checkLinks(dir: string, as: Partial<Audience>, fetcher: Fetcher = liveFetcher, now: () => Date = () => new Date()): Promise<Result<{ receipts: LinkReceipt[] }>> {
  const read = readManifest(dir);
  if ('error' in read) return read;
  const m = read.manifest, audience = audienceOf(m);
  if (!sameAudience(as, audience)) return fail('FIRST_USE_RECORD_INVALID', `check links as the owner-equivalent audience: --account "${audience.account}" --device-class ${audience.device_class}`);
  const receipts: LinkReceipt[] = [];
  for (const [i, link] of m.play.links.entries()) {
    let status = 0, error: string | undefined;
    try { status = (await fetcher(link.url)).status; } catch (e) { error = (e as Error).message || String(e); }
    const gated = !!link.login_gated;
    const live = (status >= 200 && status < 400) || (gated && (status === 401 || status === 403));
    const at = now();
    const receipt: LinkReceipt = { schema_version: 1, kind: 'first-use-link', url: link.url, build_fingerprint: m.build.fingerprint, audience, checked_at: at.toISOString(), status, login_gated: gated, verdict: live ? 'live' : 'down', ...(error ? { error } : {}) };
    const file = path.join(dir, 'links', `${stamp(at)}-${i + 1}-${crypto.randomBytes(3).toString('hex')}.json`);
    try { writeOnce(file, receipt); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${file}: ${(e as Error).message}`); }
    receipts.push(receipt);
  }
  return { receipts };
}

const score = (s: string) => /^(10|[1-9])$/.test(s.trim()) ? Number(s.trim()) : undefined;

/** The checker's predicted owner score, written once per run. */
export function predict(o: { dir: string; score: string; why: string; by: string; now?: Date }): Result<{ prediction: Prediction }> {
  const read = readManifest(o.dir);
  if ('error' in read) return read;
  const n = score(o.score);
  if (n === undefined || !o.why.trim()) return fail('FIRST_USE_RECORD_INVALID', 'predict needs --score 1-10 and --why <one line>');
  const who = checkerOf(read.manifest, o.by);
  if ('error' in who) return who;
  const prediction: Prediction = { schema_version: 1, kind: 'first-use-prediction', score: n, why: o.why.trim(), by: who.by, at: (o.now ?? new Date()).toISOString(), build_fingerprint: read.manifest.build.fingerprint };
  try { writeOnce(path.join(o.dir, 'prediction.json'), prediction); } catch { return fail('FIRST_USE_RECORD_INVALID', 'this run already has a predicted score; start a new run to predict again'); }
  return { prediction };
}

/** The owner's own score and exact words, appended (the newest counts); kept beside the prediction in the private record. */
export function ownerScore(o: { dir: string; score: string; words: string; by: string; now?: Date }): Result<{ owner: OwnerScore }> {
  const read = readManifest(o.dir);
  if ('error' in read) return read;
  const n = score(o.score);
  if (n === undefined || !o.words.trim() || !o.by.trim()) return fail('FIRST_USE_RECORD_INVALID', 'score needs --score 1-10, --words "<the owner’s exact words>" and --by <who relayed them>');
  const now = o.now ?? new Date();
  const owner: OwnerScore = { schema_version: 1, kind: 'first-use-owner-score', score: n, words: o.words, by: o.by.trim(), at: now.toISOString(), build_fingerprint: read.manifest.build.fingerprint };
  const file = path.join(o.dir, 'owner', `${stamp(now)}-${crypto.randomBytes(3).toString('hex')}.json`);
  try { writeOnce(file, owner); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${file}: ${(e as Error).message}`); }
  return { owner };
}

function readDir<T>(dir: string): { rows: T[]; unreadable: string[] } {
  const rows: T[] = [], unreadable: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* none yet */ }
  for (const f of names) { const r = readJson<T>(path.join(dir, f)); if (r) rows.push(r); else unreadable.push(f); }
  return { rows, unreadable };
}
const newest = <T extends { at?: string; checked_at?: string }>(rows: T[]) => [...rows].sort((a, b) => (a.at ?? a.checked_at ?? '').localeCompare(b.at ?? b.checked_at ?? '')).at(-1);

export interface Decision { ok: boolean; reasons: string[]; manifest?: Manifest; passed: number; links: LinkReceipt[]; prediction?: Prediction; owner?: OwnerScore }
/**
 * Whether this run clears the build about to be sent: the same build, unchanged day-one rows, a pass with intact
 * evidence for every frozen action, a live receipt under 15 minutes old for every play link, and a predicted score.
 */
export function decide(dir: string, build: Partial<BuildId>, now: Date = new Date()): Decision {
  const read = readManifest(dir);
  if ('error' in read) return { ok: false, reasons: [read.error.detail], passed: 0, links: [] };
  const m = read.manifest, reasons: string[] = [];
  const current = buildFingerprint(build);
  if ('error' in current) reasons.push(current.error.detail);
  else if (current.fingerprint !== m.build.fingerprint) reasons.push(`build_mismatch: this run checked ${buildLabel(m.build)}, not ${buildLabel(current)}`);
  let planText: string | undefined;
  try { planText = fs.readFileSync(m.source.path, 'utf8'); } catch { reasons.push(`source_missing: ${m.source.path}`); }
  if (planText !== undefined) {
    const again = freezeActions(planText);
    if ('error' in again) reasons.push(`source_changed: ${again.error.detail}`);
    else if (again.rows_sha256 !== m.source.rows_sha256) reasons.push('source_changed: the day-one rows changed since the check started; start a new run');
  }
  if (m.builder.family === m.checker.family) reasons.push('same_family');
  const results = readDir<ActionResult>(path.join(dir, 'results'));
  if (results.unreadable.length) reasons.push(`record_unreadable: results/${results.unreadable.join(', results/')}`);
  let passed = 0;
  for (const a of m.actions) {
    const r = newest(results.rows.filter(x => x.action === a.n && x.build_fingerprint === m.build.fingerprint && x.by?.family === m.checker.family && x.account === m.play.account));
    if (!r) { reasons.push(`action_${a.n}_not_played`); continue; }
    if (r.verdict !== 'pass') { reasons.push(`action_${a.n}_failed: ${r.note}`); continue; }
    let bytes: Buffer | undefined;
    try { bytes = fs.readFileSync(path.join(dir, r.evidence.file)); } catch { /* missing */ }
    if (!bytes || bytes.length !== r.evidence.bytes || sha256(bytes) !== r.evidence.sha256) { reasons.push(`action_${a.n}_evidence_stale`); continue; }
    passed++;
  }
  const receipts = readDir<LinkReceipt>(path.join(dir, 'links'));
  const links: LinkReceipt[] = [];
  for (const link of m.play.links) {
    const r = newest(receipts.rows.filter(x => x.url === link.url && x.build_fingerprint === m.build.fingerprint && sameAudience(x.audience, audienceOf(m))));
    if (!r) { reasons.push(`link_unchecked: ${link.url} (as ${m.play.account} on ${m.build.platform})`); continue; }
    links.push(r);
    if (r.verdict !== 'live') reasons.push(`link_down: ${link.url} (status ${r.status || r.error || 'none'})`);
    else if (now.getTime() - Date.parse(r.checked_at) > LINK_FRESH_MS) reasons.push(`link_stale: ${link.url} was checked at ${r.checked_at}, over 15 minutes ago`);
  }
  const prediction = readJson<Prediction>(path.join(dir, 'prediction.json'));
  if (!prediction) reasons.push('no_predicted_score');
  const owner = newest(readDir<OwnerScore>(path.join(dir, 'owner')).rows);
  return { ok: reasons.length === 0, reasons, manifest: m, passed, links, prediction, owner };
}
